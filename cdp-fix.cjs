'use strict';
// cdp-fix.cjs —— 通过 ChatGPT 桌面端自带的 Chromium 远程调试口（--remote-debugging-port=9222）修复
//   1) 启动后一直转圈（界面从未挂载）→ 刷新页面
//   2) 发送键灰（loading-local-config）→ 让界面重发所有没拿到回复的查询；无效且输入框为空时刷新页面
// 前提：ChatGPT 必须通过 launch-chatgpt.cmd 启动（带 --remote-debugging-port=9222）。
// 不依赖版本校验，不注入主进程，只对页面执行 JS。纯本地、不联网、不消耗额度。
const fs = require('node:fs');
const path = require('node:path');

const args = new Set(process.argv.slice(2));
const DIAG_ONLY = args.has('--diagnose-only');
const AUTO = args.has('--auto');
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `${stamp}-${process.pid}.json`);
const report = { time: new Date().toISOString(), mode: 'cdp', steps: [] };
const step = (name, data) => { report.steps.push({ t: new Date().toISOString(), name, ...(data ?? {}) }); };
const save = () => fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);
if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') throw Error('需要 Node.js 22 或更新版本');

// ---------- CDP ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.pending = new Map(); this.seq = 0;
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } } });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('调试连接关闭')); } this.pending.clear(); });
  }
  static async connect(url) {
    if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) throw Error('只允许本机回环调试');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { const t = setTimeout(() => { ws.close(); reject(Error('调试连接超时')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(Error('调试连接失败')); }, { once: true }); });
    return new Cdp(ws);
  }
  call(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(Error('调试请求超时: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, timeout = 15000) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}
async function findMainPage() {
  let list;
  try { list = await listTargets(); } catch (e) { throw Error(`连不上 127.0.0.1:${PORT} 调试口。ChatGPT 需要通过「启动 ChatGPT（可修复）」快捷方式启动；如果已经开着，请先完全退出再用该快捷方式打开。`); }
  const pages = list.filter((t) => t.type === 'page' && /^app:\/\/-\/index\.html(\?|$)/.test(t.url || '') && !/initialRoute=/.test(t.url || ''));
  if (pages.length !== 1) throw Error('主窗口页面不唯一: ' + pages.map((p) => p.url).join(', '));
  return pages[0];
}
const RENDERER_PROBE = String(async function (mode, opts) {
  const P = (globalThis.__cdxProbe ??= { responses: [], installed: false });
  if (!P.installed) {
    P.installed = true;
    window.addEventListener('message', (ev) => {
      try {
        const d = ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'fetch-response') P.responses.push({ t: Date.now(), hop: 'renderer-window-message', requestId: d.requestId, status: d.status, responseType: d.responseType });
        else if (d.marker === 'codex-host-chunked-message-v1') P.responses.push({ t: Date.now(), hop: 'renderer-window-chunk', transferId: d.transferId, kind: d.kind, sequence: d.sequence });
      } catch {}
    }, true);
  }
  const anchor = [...document.querySelectorAll('*')].find((x) => Object.keys(x).some((k) => k.startsWith('__reactFiber$')));
  if (!anchor) return { ok: false, error: '界面尚未完成渲染（没有 React 根）' };
  let root = anchor[Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'))];
  while (root.return) root = root.return;
  const stack = [root], seen = new Set(), clients = new Set(), composers = [], workspaces = new Set();
  let busy = false;
  const inspect = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (typeof o.getQueryCache === 'function') clients.add(o);
    for (const k of ['queryClient', 'current', 'value', 'memoizedState']) if (o[k] && o[k] !== o) inspect(o[k], depth + 1);
  };
  while (stack.length) {
    const f = stack.pop(); if (!f || seen.has(f)) continue; seen.add(f);
    const p = f.memoizedProps;
    if (p && typeof p === 'object') {
      if ('submitBlockReason' in p) composers.push({ submitBlockReason: p.submitBlockReason, hasMessageContent: p.hasMessageContent, hasGoal: p.hasGoal, isResponseInProgress: p.isResponseInProgress });
      if (typeof p.localWorkspaceMaterialization === 'string') workspaces.add(p.localWorkspaceMaterialization);
      for (const k of ['isResponseInProgress', 'isStopping', 'isResumePending', 'isThreadHandoffInProgress', 'isRecording', 'isDictating']) if (p[k] === true) busy = true;
      inspect(p);
    }
    let h = f.memoizedState; for (let i = 0; h && i < 400; i++, h = h.next) inspect(h.memoizedState);
    if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
  }
  const all = [...clients].flatMap((c) => c.getQueryCache().getAll());
  const homeQ = all.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'vscode' && q.queryKey[1] === 'codex-home');
  const uniq = [...new Map(homeQ.map((q) => [q.queryHash ?? JSON.stringify(q.queryKey), q])).values()];
  const snap = () => uniq.map((q) => ({ key: JSON.stringify(q.queryKey), status: q.state.status, fetchStatus: q.state.fetchStatus, dataUpdatedAt: q.state.dataUpdatedAt, errorUpdatedAt: q.state.errorUpdatedAt, error: q.state.error ? String(q.state.error?.message ?? q.state.error) : null, observers: typeof q.getObserversCount === 'function' ? q.getObserversCount() : null }));
  const keyLabel = (q) => { try { return JSON.stringify(q.queryKey).slice(0, 120); } catch { return String(q.queryKey); } };
  const isStuck = (q) => Array.isArray(q.queryKey) && q.state.status === 'pending' && q.state.fetchStatus === 'fetching' && !(q.state.dataUpdatedAt > 0);
  const pendingVscode = all.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'vscode' && q.state.fetchStatus === 'fetching').map((q) => ({ key: q.queryKey.slice(0, 2).join('/'), status: q.state.status, dataUpdatedAt: q.state.dataUpdatedAt }));
  const pendingAll = all.filter(isStuck).map((q) => ({ key: keyLabel(q), observers: typeof q.getObserversCount === 'function' ? q.getObserversCount() : null }));
  const nonemptyEditors = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter((e) => (e.value ?? e.textContent ?? '').length > 0).length;
  const result = { ok: true, timeOrigin: performance.timeOrigin, ageMs: Math.round(performance.now()), clients: clients.size, composers, workspaceStates: [...workspaces], busy, nonemptyEditors, pendingVscodeQueries: pendingVscode, pendingAllQueries: pendingAll, before: snap() };
  if (mode === 'retry') {
    // 重发所有从未拿到数据、仍在 fetching 的查询（不限 vscode/*：启动时丢失的还包括 app-server 的 config/read、权限档、
    // windowsSandbox/readiness 等，它们同样会让输入框停在 loading-local-config）
    const stuck = [...new Map(all.filter(isStuck).map((q) => [q.queryHash ?? JSON.stringify(q.queryKey), q])).values()];
    result.retried = stuck.length;
    result.retriedKeys = stuck.map(keyLabel);
    for (const q of stuck) { try { await q.cancel({ revert: true, silent: true }); } catch (e) { result.cancelError = String(e); } }
    for (const q of stuck) { try { q.fetch().catch(() => {}); } catch (e) { result.fetchError = String(e); } }
    const deadline = Date.now() + (opts?.waitMs ?? 8000);
    while (Date.now() < deadline && stuck.some((q) => q.state.status === 'pending')) await new Promise((r) => setTimeout(r, 250));
    result.after = snap();
    result.stillPending = stuck.filter((q) => q.state.status === 'pending').map(keyLabel);
  }
  result.responses = P.responses.splice(0);
  return result;
});


function summarizeState(s) {
  if (!s || !s.ok) return '界面状态不可读: ' + (s && s.error);
  const q = (s.before || []).map((x) => `${x.key.includes('hostId') ? 'codex-home(local)' : 'codex-home'}: ${x.status}/${x.fetchStatus}`).join('; ');
  const c = (s.composers || []).map((x) => `submitBlockReason=${x.submitBlockReason} hasMessageContent=${x.hasMessageContent} responseInProgress=${x.isResponseInProgress}`).join(' | ');
  return `工作区=${JSON.stringify(s.workspaceStates)}  查询[${q}]  输入框[${c || '未找到'}]  未回复查询=${(s.pendingAllQueries || []).length} 非空编辑器=${s.nonemptyEditors} busy=${s.busy}`;
}
// 没有 React 根，或者 React 起来了但页面上没有任何输入框/工作区（转圈的加载页），都视为「界面没挂载」
// 只有「页面里根本没有 React 根」才算没挂载（真正的转圈页）。界面起来了但当前视图没有输入框（设置页等）不算，绝不能刷新。
const notMounted = (s) => !s || (s.ok === false && /React/.test(String(s.error)));
const isBlocked = (s) => !!s && s.ok && ((s.before || []).some((x) => x.status === 'pending' && x.fetchStatus === 'fetching') || (s.workspaceStates || []).includes('loading') || (s.composers || []).some((x) => x.submitBlockReason === 'loading-local-config'));
const isReady = (s) => !!s && s.ok && !isBlocked(s);
const safeToReload = (s) => notMounted(s) || (!!s && s.ok && s.nonemptyEditors === 0 && !s.busy && (s.composers || []).every((x) => x.hasMessageContent === false && x.isResponseInProgress !== true));

(async () => {
  let cdp = null;
  try {
    const page = await findMainPage();
    step('target', { url: page.url, id: page.id });
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const run = (mode, opts) => cdp.eval('(' + RENDERER_PROBE + ')(' + JSON.stringify(mode) + ',' + JSON.stringify(opts || {}) + ')', 60000);
    const pageAge = () => cdp.eval('Math.round(performance.now())', 5000).catch(() => -1);

    let s0 = await run('state');
    step('state-before', { state: s0, ageMs: await pageAge() }); save();
    say('修复前：' + summarizeState(s0));

    // 情况 1：界面从未挂载（一直转圈）
    if (notMounted(s0)) {
      const age = await pageAge();
      if (age >= 0 && age < (AUTO ? 60000 : 30000) && !args.has('--force')) { say(`页面刚打开 ${Math.round(age / 1000)} 秒，先等它自己加载；30 秒后仍转圈再运行。`); step('result', { action: 'too-early' }); process.exitCode = 3; return; }
      if (DIAG_ONLY) { step('result', { action: 'diagnose-only' }); return; }
      say('界面一直没有挂载（转圈），刷新页面…');
      await cdp.call('Page.reload', { ignoreCache: false });
      step('reload', { reason: 'not-mounted' });
      cdp.close();
      let s3 = null;
      for (let i = 0; i < 22; i++) {
        await wait(4000);
        try { const p = await findMainPage(); cdp = await Cdp.connect(p.webSocketDebuggerUrl); s3 = await run('state'); } catch (e) { s3 = { ok: false, error: String(e) }; }
        if (isReady(s3)) break;
        if (cdp) { cdp.close(); cdp = null; }
      }
      step('state-after-reload', { state: s3 }); save();
      say('刷新后：' + summarizeState(s3));
      if (isReady(s3)) { say('✅ 已恢复。'); step('result', { action: 'reload-recovered' }); return; }
      if (s3 && s3.ok && isBlocked(s3)) { s0 = s3; /* 继续走情况 2 */ }
      else { say('❌ 刷新后仍未挂载。'); step('result', { action: 'reload-not-mounted' }); process.exitCode = 3; return; }
    }

    if (!isBlocked(s0)) { say('当前没有检测到阻塞，不做任何操作。'); step('result', { action: 'none' }); return; }
    if (DIAG_ONLY) { step('result', { action: 'diagnose-only' }); return; }

    // 情况 2：发送键灰 → 重发所有没拿到回复的查询
    say('让界面重发所有还没拿到回复的查询（最多等 8 秒）…');
    const s1 = await run('retry', { waitMs: 8000 });
    step('retry', { retry: s1 }); save();
    say(`  重发了 ${s1.retried} 条：${(s1.retriedKeys || []).join(', ')}`);
    if (s1.stillPending && s1.stillPending.length) say(`  仍未返回：${s1.stillPending.join(', ')}`);
    await wait(1500);
    const s2 = await run('state');
    step('state-after-retry', { state: s2 }); save();
    say('重发后：' + summarizeState(s2));
    if (!isBlocked(s2)) { say('✅ 仅重发请求即恢复，没有刷新页面。'); step('result', { action: 'retry-recovered' }); return; }

    if (!safeToReload(s2) || (AUTO && s2.nonemptyEditors > 0)) { say('⚠ 输入框有内容、或有回复正在进行，不自动刷新。'); step('result', { action: 'skip-reload-unsafe' }); process.exitCode = 3; return; }
    say('重发未能恢复，刷新一次页面…');
    await cdp.call('Page.reload', {});
    step('reload', { reason: 'blocked' });
    cdp.close(); cdp = null;
    let s3 = null;
    for (let i = 0; i < 22; i++) {
      await wait(4000);
      try { const p = await findMainPage(); cdp = await Cdp.connect(p.webSocketDebuggerUrl); s3 = await run('state'); } catch (e) { s3 = { ok: false, error: String(e) }; }
      if (isReady(s3)) break;
      if (cdp) { cdp.close(); cdp = null; }
    }
    step('state-after-reload', { state: s3 }); save();
    say('刷新后：' + summarizeState(s3));
    if (isReady(s3)) { say('✅ 已恢复。'); step('result', { action: 'reload-recovered' }); }
    else { say('❌ 刷新后仍阻塞。'); step('result', { action: 'reload-failed' }); process.exitCode = 3; }
  } catch (e) {
    step('error', { message: String(e && e.stack || e) });
    say('出错：' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    save();
    say('日志：' + LOG_FILE);
  }
})();
