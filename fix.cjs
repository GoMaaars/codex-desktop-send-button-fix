'use strict';
// Codex/ChatGPT 桌面端「发送键变灰（loading-local-config）」快速诊断 + 修复
// 不绑定版本校验；只用 Electron 公开 API、React fiber 遍历和 React Query 公开方法。
// 流程：定位主进程 -> 临时打开本机回环诊断口 -> 读取渲染层状态 ->
//       在主进程收到 / 主进程发回 / 渲染层收到 三个环节打点，让渲染层重发 codex-home 请求 ->
//       若仍 pending 且输入框为空、无回复进行中 -> 刷新一次主窗口 -> 复查 -> 关闭诊断口。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = new Set(process.argv.slice(2));
const DIAG_ONLY = args.has('--diagnose-only');
const NO_RETRY = args.has('--no-retry');
const AUTO = args.has('--auto'); // 自动模式：只重发，绝不刷新窗口
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `${stamp}-${process.pid}.json`);
const report = { time: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ t: new Date().toISOString(), name, ...(data ?? {}) }); };
const save = () => fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);

if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function' || typeof process._debugProcess !== 'function') {
  throw Error('需要 Node.js 22 或更新版本');
}

// ---------- PowerShell 辅助 ----------
const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function ps(code) {
  const out = execFileSync(psPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + code, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const text = out.replace(/^\uFEFF/, '').trim();
  return text ? JSON.parse(text) : null;
}
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
function findMain() {
  const d = ps("$p=@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine);$p|ConvertTo-Json -Depth 3 -Compress");
  const procs = arr(d).filter((x) => /\\WindowsApps\\OpenAI\.Codex_/i.test(x.ExecutablePath ?? '') && !/--type(?:=|\s)/.test(x.CommandLine ?? ''));
  if (procs.length !== 1) throw Error('无法唯一确定 ChatGPT 桌面主进程（找到 ' + procs.length + ' 个）。请先正常打开一个 ChatGPT 桌面窗口。');
  return { pid: procs[0].ProcessId, exe: procs[0].ExecutablePath };
}
function listeners9229() {
  return arr(ps("@(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess)|ConvertTo-Json -Compress"));
}

// ---------- CDP ----------
class Inspector {
  constructor(ws) { this.ws = ws; this.pending = new Map(); this.seq = 0;
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } } });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('诊断连接关闭')); } this.pending.clear(); });
  }
  static async connect(url) {
    if (!/^ws:\/\/127\.0\.0\.1:9229\//.test(url)) throw Error('只允许本机回环诊断');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { const t = setTimeout(() => { ws.close(); reject(Error('诊断连接超时')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(Error('诊断连接失败')); }, { once: true }); });
    return new Inspector(ws);
  }
  call(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(Error('诊断请求超时: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, timeout = 15000) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.ws.close(); }
}
async function endpoint() {
  const r = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(3000) });
  const list = await r.json();
  const hit = list.find((x) => /^ws:\/\/127\.0\.0\.1:9229\//.test(x.webSocketDebuggerUrl ?? ''));
  if (!hit) throw Error('诊断端点不符合预期');
  return hit.webSocketDebuggerUrl;
}

// ---------- 渲染层探针（在主窗口页面里执行） ----------
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
  const pendingVscode = all.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'vscode' && q.state.fetchStatus === 'fetching').map((q) => ({ key: q.queryKey.slice(0, 2).join('/'), status: q.state.status, dataUpdatedAt: q.state.dataUpdatedAt }));
  const nonemptyEditors = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter((e) => (e.value ?? e.textContent ?? '').length > 0).length;
  const result = { ok: true, timeOrigin: performance.timeOrigin, ageMs: Math.round(performance.now()), clients: clients.size, composers, workspaceStates: [...workspaces], busy, nonemptyEditors, pendingVscodeQueries: pendingVscode, before: snap() };
  if (mode === 'retry') {
    // 重发所有卡住的 vscode/* 本地请求（启动时整批丢失的不止 codex-home，还有 get-global-state、keymap 等）
    const stuckAll = [...new Map(all.filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'vscode' && q.state.fetchStatus === 'fetching' && q.state.status === 'pending').map((q) => [q.queryHash ?? JSON.stringify(q.queryKey), q])).values()];
    const stuck = stuckAll;
    result.retried = stuck.length;
    result.retriedKeys = stuck.map((q) => q.queryKey.slice(0, 2).join('/'));
    for (const q of stuck) { try { await q.cancel({ revert: true, silent: true }); } catch (e) { result.cancelError = String(e); } }
    for (const q of stuck) { try { q.fetch().catch(() => {}); } catch (e) { result.fetchError = String(e); } }
    const deadline = Date.now() + (opts?.waitMs ?? 8000);
    while (Date.now() < deadline && stuck.some((q) => q.state.status === 'pending')) await new Promise((r) => setTimeout(r, 250));
    result.after = snap();
  }
  result.responses = P.responses.splice(0);
  return result;
});

// ---------- 主进程侧代码 ----------
const CH_IN = 'codex_desktop:message-from-view';
function mainExpr(kind, extra) {
  return `(async()=>{
    const e=process.mainModule.require('electron');
    const all=e.webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType(),url:w.getURL(),loading:w.isLoading(),destroyed:w.isDestroyed()}));
    const mains=e.webContents.getAllWebContents().filter(w=>w.getType()==='window'&&w.getURL()==='app://-/index.html');
    if(mains.length!==1) return JSON.stringify({ok:false,error:'主窗口不唯一: '+mains.length,all});
    const wc=mains[0]; const bw=e.BrowserWindow.fromWebContents(wc);
    const probe=${JSON.stringify(RENDERER_PROBE)};
    const run=(mode,opts)=>wc.executeJavaScript('('+probe+')('+JSON.stringify(mode)+','+JSON.stringify(opts||{})+')',true);
    const base={pid:process.pid,version:e.app.getVersion(),asar:e.app.getAppPath(),all,main:{id:wc.id,loading:wc.isLoading(),visible:bw?bw.isVisible():null,focused:bw?bw.isFocused():null}};
    const kind=${JSON.stringify(kind)};
    if(kind==='state'){ const s=await run('state'); return JSON.stringify({ok:true,...base,state:s}); }
    if(kind==='reload'){ wc.reload(); return JSON.stringify({ok:true,...base,reloaded:true}); }
    if(kind==='close'){ setTimeout(()=>{try{process.mainModule.require('node:inspector').close()}catch{}},200); return JSON.stringify({ok:true}); }
    // kind==='retry'：安装临时打点，再让渲染层重发
    const log=[]; const hooks={send:false,recv:false,recvOwner:null};
    const origSend=wc.send;
    wc.send=function(ch,payload){ try{ if(payload&&typeof payload==='object'){ if(payload.type==='fetch-response') log.push({t:Date.now(),hop:'main-send',channel:ch,requestId:payload.requestId,status:payload.status,responseType:payload.responseType}); else if(payload.marker==='codex-host-chunked-message-v1') log.push({t:Date.now(),hop:'main-send-chunk',channel:ch,transferId:payload.transferId,kind:payload.kind,sequence:payload.sequence}); } }catch{} return origSend.apply(this,arguments); };
    hooks.send=true;
    const CH=${JSON.stringify(CH_IN)};
    let map=null, origH=null;
    for(const [owner,cand] of [['webContents.ipc',wc.ipc&&wc.ipc._invokeHandlers],['ipcMain',e.ipcMain&&e.ipcMain._invokeHandlers]]){
      if(cand instanceof Map && typeof cand.get(CH)==='function'){ map=cand; origH=cand.get(CH); hooks.recvOwner=owner; break; }
    }
    if(map){ map.set(CH,function(ev,msg){ try{ if(ev&&ev.sender&&ev.sender.id===wc.id&&msg&&typeof msg==='object'&&(msg.type==='fetch'||msg.type==='cancel-fetch')) log.push({t:Date.now(),hop:'main-recv',type:msg.type,requestId:msg.requestId,url:msg.url}); }catch{} return origH.apply(this,arguments); }); hooks.recv=true; }
    let retry=null, err=null;
    try{ retry=await run('retry',{waitMs:${Number(extra?.waitMs ?? 8000)}}); }catch(x){ err=String(x&&x.stack||x); }
    finally{ try{ delete wc.send; }catch{} if(map&&origH) map.set(CH,origH); }
    return JSON.stringify({ok:true,...base,retry,err,log,hooks,mainAfter:{loading:wc.isLoading()}});
  })()`;
}

function summarizeState(s) {
  if (!s || !s.ok) return '渲染层状态不可读: ' + (s && s.error);
  const q = (s.before || []).map((x) => `${x.key.includes('hostId') ? 'codex-home(local)' : 'codex-home'}: ${x.status}/${x.fetchStatus}`).join('; ');
  const c = (s.composers || []).map((x) => `submitBlockReason=${x.submitBlockReason} hasMessageContent=${x.hasMessageContent} responseInProgress=${x.isResponseInProgress}`).join(' | ');
  return `工作区=${JSON.stringify(s.workspaceStates)}  查询[${q}]  输入框[${c || '未找到'}]  非空编辑器=${s.nonemptyEditors} busy=${s.busy}`;
}
const isBlocked = (s) => !!s && s.ok && ((s.before || []).some((x) => x.status === 'pending' && x.fetchStatus === 'fetching') || (s.workspaceStates || []).includes('loading') || (s.composers || []).some((x) => x.submitBlockReason === 'loading-local-config'));
const safeToReload = (s) => !!s && s.ok && s.nonemptyEditors === 0 && !s.busy && (s.composers || []).every((x) => x.hasMessageContent === false && x.isResponseInProgress !== true);

(async () => {
  let insp = null; let target = null; let opened = false;
  try {
    target = findMain();
    step('target', target);
    say(`主进程 PID=${target.pid}`);
    const l = listeners9229();
    if (l.length) {
      if (!l.every((x) => x.OwningProcess === target.pid)) throw Error('9229 端口已被其他进程占用，停止（不接管他人调试器）。占用 PID: ' + l.map((x) => x.OwningProcess).join(','));
      say('诊断口已由目标进程打开，直接复用');
    } else {
      process._debugProcess(target.pid);
      opened = true;
      for (let i = 0; i < 40; i++) { await wait(250); if (listeners9229().some((x) => x.OwningProcess === target.pid)) break; }
    }
    const url = await endpoint();
    insp = await Inspector.connect(url);
    const pid = await insp.eval('process.pid');
    if (pid !== target.pid) throw Error('诊断目标身份不符');

    // 1. 现场
    const s0 = JSON.parse(await insp.eval(mainExpr('state'), 30000));
    step('state-before', s0); save();
    if (!s0.ok) throw Error(s0.error);
    say(`应用版本 ${s0.version}，主窗口 id=${s0.main.id} visible=${s0.main.visible} loading=${s0.main.loading}`);
    say('修复前：' + summarizeState(s0.state));
    if (!isBlocked(s0.state)) { say('当前没有检测到 loading-local-config 阻塞，不做任何操作。'); step('result', { action: 'none' }); return; }
    if (DIAG_ONLY) { say('仅诊断模式，结束。'); step('result', { action: 'diagnose-only' }); return; }

    // 2. 重发实验（三跳打点）
    let s1 = null;
    if (!NO_RETRY) {
      say('让渲染层重发 codex-home 请求，并在三个环节打点（最多等 8 秒）…');
      s1 = JSON.parse(await insp.eval(mainExpr('retry', { waitMs: 8000 }), 60000));
      step('retry', s1); save();
      const recv = s1.log.filter((x) => x.hop === 'main-recv' && x.type === 'fetch' && /codex-home/.test(x.url || ''));
      const sent = s1.log.filter((x) => x.hop === 'main-send');
      const got = (s1.retry && s1.retry.responses || []).filter((x) => x.hop === 'renderer-window-message');
      const matched = recv.filter((r) => sent.some((x) => x.requestId === r.requestId)).length;
      const arrived = recv.filter((r) => got.some((x) => x.requestId === r.requestId)).length;
      say(`  重发了 ${s1.retry ? s1.retry.retried : '?'} 条卡住的本地请求：${s1.retry && s1.retry.retriedKeys ? s1.retry.retriedKeys.join(', ') : ''}`);
      say(`  主进程收到 codex-home 请求 ${recv.length} 条（打点位置: ${s1.hooks.recvOwner || '未能挂钩'}）；主进程发回对应回应 ${matched} 条；渲染层窗口收到对应回应 ${arrived} 条。`);
      say('  重发后：' + (s1.retry && s1.retry.after ? s1.retry.after.map((x) => `${x.status}/${x.fetchStatus}`).join(', ') : '无结果 ' + (s1.err || '')));
      if (s1.retry && s1.retry.after && s1.retry.after.every((x) => x.status === 'success')) {
        await wait(1500);
        const s2 = JSON.parse(await insp.eval(mainExpr('state'), 30000));
        step('state-after-retry', s2); save();
        say('重发后状态：' + summarizeState(s2.state));
        if (!isBlocked(s2.state)) { say('✅ 仅重发请求即恢复，没有刷新窗口。请在桌面端连续发两条消息验收。'); step('result', { action: 'retry-recovered' }); return; }
      }
    }

    // 3. 刷新主窗口
    if (AUTO) { say('自动模式：重发未恢复，不刷新窗口。'); step('result', { action: 'auto-retry-not-recovered' }); process.exitCode = 3; return; }
    const latest = s1 && s1.retry ? { ...s0.state, before: s1.retry.after || s0.state.before } : s0.state;
    if (!safeToReload(latest)) {
      say('⚠ 输入框有内容、或有回复正在进行，为避免丢失内容不自动刷新。请保存/清空后再运行。');
      step('result', { action: 'skip-reload-unsafe' }); return;
    }
    say('重发未能恢复，刷新一次主窗口（保留后台进程）…');
    JSON.parse(await insp.eval(mainExpr('reload'), 15000));
    step('reload', { at: new Date().toISOString() });
    let s3 = null;
    for (let i = 0; i < 12; i++) {
      await wait(4000);
      try { s3 = JSON.parse(await insp.eval(mainExpr('state'), 30000)); } catch (e) { s3 = { ok: false, error: String(e) }; }
      if (s3.ok && s3.state && s3.state.ok && !isBlocked(s3.state)) break;
    }
    step('state-after-reload', s3); save();
    say('刷新后：' + (s3 && s3.ok ? summarizeState(s3.state) : String(s3 && s3.error)));
    if (s3 && s3.ok && s3.state && s3.state.ok && !isBlocked(s3.state)) { say('✅ 已恢复（临时恢复，根因仍是应用自身丢回应）。请在桌面端连续发两条消息验收。'); step('result', { action: 'reload-recovered' }); }
    else { say('❌ 刷新后仍阻塞，请把 logs 目录里的这份 json 发回给我。'); step('result', { action: 'reload-failed' }); }
  } catch (e) {
    step('error', { message: String(e && e.stack || e) });
    say('出错：' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    try {
      if (insp) {
        try { await insp.eval(mainExpr('close'), 5000); } catch {}
        insp.close();
        for (let i = 0; i < 16; i++) { await wait(250); if (!listeners9229().some((x) => x.OwningProcess === target?.pid)) break; }
        step('inspector-closed', { stillListening: listeners9229() });
      }
    } catch (e) { step('cleanup-error', { message: String(e) }); }
    save();
    say('日志：' + LOG_FILE);
  }
})();
