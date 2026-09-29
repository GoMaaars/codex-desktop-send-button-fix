# Codex / ChatGPT Desktop (Windows) — fix for the greyed-out Send button

[中文说明](README.zh-CN.md)

**Scope.** This project handles one symptom only: the app loads, but the Send button stays grey and the composer reports `submitBlockReason = loading-local-config`. If your app never gets past the startup spinner, that is a different bug with a different fix: see [codex-desktop-startup-spinner-fix](https://github.com/GoMaaars/codex-desktop-startup-spinner-fix).

**Symptom.** After launching the ChatGPT desktop app (Windows Store package `OpenAI.Codex`, which hosts Codex), the Send button is grey. Existing threads cannot send; sometimes a new thread accepts one message and then greys out too. Restarting, rebooting, reinstalling and changing VPN/proxy do not help reliably. Observed on 26.903–26.917.

**What is actually wrong.** Right after startup the renderer sends a batch of requests to the Electron main process (`codex-home`, `get-global-state`, the app-server `config/read`, permission profile, Windows-sandbox readiness, …). The main process answers within milliseconds, but during the first seconds the replies are dropped on the way back to the UI and nothing retries them. The composer's "local config" state depends on those replies, so it stays blocked forever. Verified by tracing the same requestId through all three hops (main received → main replied → UI received): the replies vanish only in the startup window; re-issuing the same requests later completes in ~3 ms and Send is enabled immediately, without reloading the window.

## What this tool does

`cdp-fix.cjs` connects to the app's page over the Chrome DevTools Protocol on loopback (port 9222) and asks React Query to cancel + refetch every entry that never received its first reply. That is the whole fix. It does not touch what you typed, modify files, or use the network. Only if the block persists — and only when the composer is empty and no reply is streaming — it reloads the page once. (If it finds no UI at all it will also reload once; that is a courtesy, not the purpose of this project.)

It needs the app to be started with `--remote-debugging-port=9222`. `launch-chatgpt.cmd` does that correctly for a Store app (`Invoke-CommandInDesktopPackage`, so the process keeps its package identity).

`watch.cjs` is an optional background watcher: it reads the app's own log folder every 10 s (no process polling), runs the fix 60 s after each launch, retries at most 3 times a minute apart, and never touches that launch again. It never reloads while the composer has text.

Everything is version-independent: no build hashes, no code offsets, no minified export names — public Electron/Chromium interfaces, a React fiber walk and public React Query methods only.

## Install (Windows 10/11, Node.js 22+)

1. Unzip anywhere and double-click **`install-autofix.cmd`** once. It adds a hidden launcher (`CodexDesktopAutoFix.vbs`) to your Startup folder, starts the watcher, and creates two desktop shortcuts.
2. Always open ChatGPT with the desktop shortcut **“启动 ChatGPT（可修复）”** (`launch-chatgpt.cmd`). If ChatGPT is already running without the debug port, it tells you to quit it fully (tray icon → Quit) and try again.
3. If Send is still grey a minute later, double-click **“修复 ChatGPT 发送键”** (`run-fix.cmd`).

`uninstall-autofix.cmd` stops the watcher and removes the launcher and shortcuts. Logs live in `logs/` (local paths, request IDs, no message contents).

Flags for `cdp-fix.cjs`: `--diagnose-only`, `--auto` (what the watcher uses), `--port=N`.

## Safety notes

* `--remote-debugging-port` is Chromium's standard switch. The port is bound to 127.0.0.1, unauthenticated, and open for the app's lifetime; any local process could connect. Do not use this on a machine you share with people you do not trust.
* Earlier versions attached a Node inspector to the main process with `process._debugProcess`. The app disabled that path on 26.924, and it coincided with two crashes here, so it has been removed entirely.
* Nothing is downloaded or uploaded; the scripts write only their own `logs/`, one `.vbs` in Startup and two desktop shortcuts.

## Related reports

openai/codex issues #44342, #45906, #45797 describe this symptom. The startup-spinner bug on 26.924 (#48487, community thread 1400979) is handled by the sibling project linked above.

## License

MIT.
