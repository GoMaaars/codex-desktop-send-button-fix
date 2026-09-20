'use strict';
// 后台守护：发现 ChatGPT 桌面端新启动后，等它加载完，再自动运行 fix.cjs --auto（只重发请求，不刷新窗口）。
// 默认只在启动后 45 秒和 3 分钟各运行一次；每次运行会短暂（约 5 秒）打开本机回环 inspector 端口 9229，用完即关。
// 纯本地脚本，不联网、不调用任何模型，不消耗额度。
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fix.cjs');
const LOG = path.join(__dirname, 'logs', 'watch.log');
const STATE = path.join(__dirname, 'logs', 'watch-state.json');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const POLL_MS = 10000;          // 每 10 秒看一眼进程列表
const FIRST_DELAY_MS = 45000;   // 新进程出现后等 45 秒再修（等界面加载完）
const SECOND_DELAY_MS = 180000; // 3 分钟后再检查一次（界面加载特别慢时兜底）
const PERIODIC = process.argv.includes('--periodic'); // 默认关闭：只在启动后修两次，不定期开诊断口
const PERIODIC_MS = 15 * 60000; // 若显式加 --periodic，每 15 分钟检查一次
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function log(s) { const line = `${new Date().toISOString()} ${s}\n`; try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.old'); fs.appendFileSync(LOG, line); } catch {} }

const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function mainPids() {
  try {
    const out = execFileSync(psPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from("$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine)|ConvertTo-Json -Compress", 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const t = out.replace(/^\uFEFF/, '').trim(); const d = t ? JSON.parse(t) : [];
    return (Array.isArray(d) ? d : d ? [d] : []).filter((x) => /\\WindowsApps\\OpenAI\.Codex_/i.test(x.ExecutablePath ?? '') && !/--type(?:=|\s)/.test(x.CommandLine ?? '')).map((x) => x.ProcessId);
  } catch (e) { log('进程查询失败: ' + e.message); return null; }
}
function runFix(reason) {
  log(`运行修复（${reason}）`);
  const r = spawnSync(process.execPath, [FIX, '--auto'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
  log(`修复结束 exit=${r.status} | ` + out.slice(-3).join(' | '));
  // 只保留最近 40 份详细日志
  try { const dir = path.join(__dirname, 'logs'); const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'watch-state.json').sort(); for (const f of files.slice(0, Math.max(0, files.length - 40))) fs.unlinkSync(path.join(dir, f)); } catch {}
  return r.status;
}

(async () => {
  log(`守护启动 pid=${process.pid}`);
  const known = new Map(); // pid -> {seenAt, fixedFirst, fixedSecond, lastPeriodic}
  for (;;) {
    const pids = mainPids();
    if (pids) {
      const now = Date.now();
      for (const k of [...known.keys()]) if (!pids.includes(k)) { known.delete(k); log(`ChatGPT 已退出 pid=${k}`); }
      for (const p of pids) if (!known.has(p)) { known.set(p, { seenAt: now, fixedFirst: false, fixedSecond: false, lastPeriodic: now }); log(`发现 ChatGPT 主进程 pid=${p}`); }
      if (pids.length === 1) {
        const st = known.get(pids[0]);
        if (!st.fixedFirst && now - st.seenAt >= FIRST_DELAY_MS) { st.fixedFirst = true; st.lastPeriodic = now; runFix('启动后首次'); }
        else if (st.fixedFirst && !st.fixedSecond && now - st.seenAt >= SECOND_DELAY_MS) { st.fixedSecond = true; st.lastPeriodic = now; runFix('启动后复查'); }
        else if (PERIODIC && st.fixedSecond && now - st.lastPeriodic >= PERIODIC_MS) { st.lastPeriodic = now; runFix('定期检查'); }
      }
      try { fs.writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), pids, watcherPid: process.pid })); } catch {}
    }
    await wait(POLL_MS);
  }
})();
