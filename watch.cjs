'use strict';
// watch.cjs：后台守护。每 10 秒看一眼 ChatGPT 自己的启动日志目录（纯文件读取，不轮询进程表），
// 发现新的启动会话后 60 秒运行 cdp-fix.cjs --auto（让界面重发启动时丢失的请求，解除 loading-local-config）。
// 需要 ChatGPT 通过 launch-chatgpt.cmd 启动（带 --remote-debugging-port=9222）；没有调试口就只记一条日志，不做任何事。
// 没修好每 60 秒再试，最多 3 次；同一次启动处理完就不再碰。纯本地，不联网，不消耗额度。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const PORT = 9222;
const CDP_FIX = path.join(__dirname, 'cdp-fix.cjs');
const LOG = path.join(__dirname, 'logs', 'watch.log');
const STATE = path.join(__dirname, 'logs', 'watch-state.json');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const POLL_MS = 10000, FIRST_DELAY_MS = 60000, RETRY_GAP_MS = 60000, MAX_ATTEMPTS = 3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function log(s) { const line = `${new Date().toISOString()} ${s}\n`; try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.old'); fs.appendFileSync(LOG, line); } catch {} }
const logsRoot = () => path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'Codex', 'Logs');
// 最新的主进程启动日志（文件名 codex-desktop-<session>-<pid>-t0-i1-*.log）。最近 10 分钟内没写过就当作应用已退出/空闲。
function latestSession() {
  try {
    const root = logsRoot();
    const days = []; for (const y of fs.readdirSync(root)) for (const m of fs.readdirSync(path.join(root, y))) for (const d of fs.readdirSync(path.join(root, y, m))) days.push(path.join(root, y, m, d));
    days.sort(); let best = null;
    for (const dir of days.slice(-2)) for (const f of fs.readdirSync(dir)) if (/-t0-i1-.*\.log$/.test(f)) { const p = path.join(dir, f); const st = fs.statSync(p); if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs }; }
    if (!best || Date.now() - best.mtimeMs > 600000) return null;
    return best;
  } catch { return null; }
}
async function cdpUp() { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
function run(script, reason) {
  log(`运行修复（${reason}，${path.basename(script)}）`);
  const r = spawnSync(process.execPath, [script, '--auto'], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
  log(`修复结束 exit=${r.status} | ` + out.slice(-3).join(' | '));
  try { const dir = path.join(__dirname, 'logs'); const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'watch-state.json').sort(); for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.unlinkSync(path.join(dir, f)); } catch {}
  return r.status;
}
(async () => {
  log(`守护启动 pid=${process.pid}（send-button-fix）`);
  let cur = null; // {file, seenAt, attempts, done, lastRun}
  const handled = new Set(); // 已处理过的启动日志文件：同一次启动绝不重复处理（日志静默再活跃不算新启动）
  for (;;) {
    const s = latestSession();
    const now = Date.now();
    if (!s) { if (cur) { log('ChatGPT 日志静默'); cur = null; } }
    else if (handled.has(s.file)) { /* 这次启动已经处理过，什么都不做 */ }
    else {
      if (!cur || cur.file !== s.file) { cur = { file: s.file, seenAt: now, attempts: 0, done: false, lastRun: 0 }; log('发现 ChatGPT 启动：' + path.basename(s.file)); }
      if (!cur.done) {
        const due = cur.attempts === 0 ? now - cur.seenAt >= FIRST_DELAY_MS : now - cur.lastRun >= RETRY_GAP_MS;
        if (due) {
          cur.attempts += 1; cur.lastRun = now;
          if (!(await cdpUp())) { cur.done = true; handled.add(cur.file); log('这次 ChatGPT 不是用「启动 ChatGPT（可修复）」打开的（没有 9222 调试口），跳过'); continue; }
          const code = run(CDP_FIX, cur.attempts === 1 ? '启动后首次' : `第 ${cur.attempts} 次重试`);
          if (code === 0) { cur.done = true; handled.add(cur.file); log('已就绪，停止重试'); }
          else if (cur.attempts >= MAX_ATTEMPTS) { cur.done = true; handled.add(cur.file); log(`重试 ${MAX_ATTEMPTS} 次仍未恢复，放弃；请手动双击桌面的「修复 ChatGPT 发送键」`); }
        }
      }
    }
    try { fs.writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), session: cur ? path.basename(cur.file) : null, watcherPid: process.pid })); } catch {}
    await wait(POLL_MS);
  }
})();
