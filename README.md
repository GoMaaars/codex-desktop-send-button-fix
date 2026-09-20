# Codex / ChatGPT Desktop (Windows) — fix for the greyed-out Send button

[中文说明](README.zh-CN.md)

**Symptom.** After launching the ChatGPT desktop app (the Windows Store package `OpenAI.Codex`, which hosts Codex), the Send button stays grey. Nothing you type can be sent. Restarting the app, rebooting, reinstalling, changing VPN/proxy settings — none of it helps reliably. Sometimes a new thread accepts one message and then greys out again.

**What is actually wrong.** The renderer (the UI) sends a batch of ~11 local requests to the Electron main process right after startup (`codex-home`, `get-global-state`, `codex-command-keymap-state`, …). The main process receives them and answers within a millisecond, but during those first seconds the answers are lost on the way back to the UI. The UI keeps waiting forever: the workspace stays in `loading`, and the composer reports `submitBlockReason = loading-local-config`, which disables Send. Nothing ever retries. Verified by instrumenting all three hops (main received → main replied → UI received) on build 26.915.4065.0 / app 26.915.31945: once the app is up, re-issuing the same requests completes in ~3 ms and the button comes back immediately, without reloading the window.

So this is a startup timing bug inside the app, not a network, account, config or data problem. Reinstalling cannot fix it.

## What this tool does

`fix.cjs` attaches to the running ChatGPT main process over the local Node inspector (127.0.0.1:9229, loopback only), asks the UI to re-issue every stuck local request, waits up to 8 s, and closes the inspector again. That is the whole fix. It does **not** reload the window, touch what you typed, modify any file, or talk to the network. Only if re-issuing somehow does not help (never observed so far) the manual mode will reload the main window once — and only when the composer is empty and no reply is streaming.

`watch.cjs` is an optional background watcher: after each ChatGPT start it runs the fix at +45 s and +3 min, then leaves the app alone (pass `--periodic` if you also want a check every 15 minutes). It is a plain local script; it costs no tokens.

The approach is version-independent: no build hashes, no code offsets, no minified export names. It relies on public Electron APIs, a React fiber walk and public React Query methods, plus two undocumented-but-stable hooks that are named explicitly below.

## Requirements

* Windows 10/11, ChatGPT desktop installed from the Microsoft Store (`OpenAI.Codex_…`).
* [Node.js](https://nodejs.org) 22 or newer (tested with 24). The scripts look for `C:\Program Files\nodejs\node.exe`, then `node.exe` on PATH.
* Port 9229 must be free (it is used only for the few seconds the fix runs).

## Usage

Manual: with ChatGPT open, double-click **`run-fix.cmd`**. (Console messages are currently in Chinese; the ✅ / ❌ line at the end is what matters.) Translated, a successful run looks like

```
Before: workspace=["loading"] queries[codex-home: pending/fetching; …] composer[submitBlockReason=loading-local-config …]
Re-issued 11 stuck local requests: vscode/codex-home, vscode/get-global-state, …
After:  workspace=["available"] … composer[submitBlockReason=empty-message …]
✅ Recovered by re-issuing the requests; window was not reloaded.
```

Automatic: double-click **`install-autofix.cmd`** once. It puts a hidden launcher (`CodexDesktopAutoFix.vbs`) in your Startup folder and starts the watcher right away. **`uninstall-autofix.cmd`** removes the launcher and stops the watcher. Logs go to `logs/` next to the scripts (`watch.log` for the watcher, one JSON per fix run).

Flags for `fix.cjs`: `--diagnose-only` (read state, change nothing), `--auto` (re-issue only, never reload), `--no-retry` (skip straight to the reload path).

## Safety notes

* The inspector is opened with `process._debugProcess(pid)` (an undocumented Node API) on the ChatGPT main process. It listens on 127.0.0.1:9229 **without authentication** for the few seconds the fix runs, then the script closes it and verifies the port is gone. Any local process could in principle connect during that window; if that matters to you, use the manual mode only. If port 9229 is already owned by another process the script stops instead of taking it over.
* Hooks that instrument the three hops (`webContents.send`, and the `codex_desktop:message-from-view` handler read from Electron's private `ipcMain._invokeHandlers` map) are installed for the duration of one re-issue and removed in a `finally` block.
* The UI probe runs inside the ChatGPT window via `webContents.executeJavaScript`; it reads React props / React Query state and calls `query.cancel()` + `query.fetch()` on the stuck entries. It never clears drafts or attachments.
* Nothing is downloaded or uploaded. The scripts write only to their own `logs/` folder, except `install-autofix` which creates one launcher file, `CodexDesktopAutoFix.vbs`, in your Startup folder (removed by `uninstall-autofix`).
* The JSON logs contain local paths (e.g. the app install directory), request IDs and error stacks, but no message contents. Review them before sharing.

## Reporting to OpenAI

If you want to report this, the useful facts are: build/app version, `submitBlockReason=loading-local-config`, the two `["vscode","codex-home"]` queries stuck at `pending/fetching` with `dataUpdatedAt=0`, the main-process log line `[electron-fetch-handler] codex-home request` with no matching delivery, and the fact that a plain refetch after startup succeeds in milliseconds. The JSON written by `fix.cjs` contains all of that (it does not include message contents).

## License

MIT.
