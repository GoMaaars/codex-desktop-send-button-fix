# Codex / ChatGPT 桌面端（Windows）发送键变灰修复

[English](README.md)

**症状。** 打开 ChatGPT 桌面端（微软商店包 `OpenAI.Codex`，内置 Codex）后，发送按钮一直是灰的，打的字发不出去。重启应用、重启电脑、卸载重装、改 VPN/代理都不能稳定解决；有时新会话能发一条，之后又灰。

**真正的原因。** 界面（渲染层）在启动后会向 Electron 主进程发一批约 11 条本地请求（`codex-home`、`get-global-state`、`codex-command-keymap-state` 等）。主进程 1 毫秒内就收到并回复了，但在启动最初那几秒里，这批回复在送回界面的路上被丢掉了，而且没有任何重试。界面于是永远等着：工作区停在 `loading`，输入框的 `submitBlockReason = loading-local-config`，发送键被禁用。在 26.915.4065.0 / 26.915.31945 版本上，我们给"主进程收到 → 主进程发回 → 界面收到"三个环节打点验证过：应用起来之后把同样的请求再发一次，3 毫秒内完成，按钮立刻恢复，连窗口都不用刷新。

所以这是应用自身的启动时序 bug，与网络、账号、配置、数据无关，重装不可能修好。

## 这个工具做什么

`fix.cjs` 通过本机 Node inspector（仅 127.0.0.1:9229 回环）接入正在运行的 ChatGPT 主进程，让界面把所有卡住的本地请求重发一次，最多等 8 秒，然后关闭诊断口。修复就这么一步。它**不会**刷新窗口、不动你打的字、不改任何文件、不联网。只有在重发也救不回来（至今没遇到过）的情况下，手动模式才会刷新一次主窗口，而且仅当输入框为空、没有回复正在生成时才会做。

`watch.cjs` 是可选的后台守护：每次 ChatGPT 启动后 45 秒和 3 分钟各修一次，之后不再打扰应用（想每 15 分钟再检查一次可加 `--periodic` 参数）。它是纯本地脚本，不消耗任何 token/额度。

实现不依赖版本：没有哈希校验、没有代码偏移量、没有压缩导出名。用的是 Electron 公开 API、React fiber 遍历和 React Query 公开方法，外加两个未公开但长期稳定的接口，下面「安全说明」里点名列出。

## 环境要求

* Windows 10/11，从微软商店安装的 ChatGPT 桌面端（`OpenAI.Codex_…`）。
* [Node.js](https://nodejs.org) 22 或更新（24 已测试）。脚本先找 `C:\Program Files\nodejs\node.exe`，再找 PATH 里的 `node.exe`。
* 9229 端口空闲（只在修复的那几秒使用）。

## 用法

手动：ChatGPT 开着的时候双击 **`run-fix.cmd`**，会看到类似：

```
修复前：工作区=["loading"]  查询[codex-home: pending/fetching; …]  输入框[submitBlockReason=loading-local-config …]
  重发了 11 条卡住的本地请求：vscode/codex-home, vscode/get-global-state, …
重发后状态：工作区=["available"] …  输入框[submitBlockReason=empty-message …]
✅ 仅重发请求即恢复，没有刷新窗口。
```

自动：双击一次 **`install-autofix.cmd`**。它会在你的"启动"文件夹放一个隐藏运行的启动项（`CodexDesktopAutoFix.vbs`）并立即启动守护。**`uninstall-autofix.cmd`** 删除启动项并停止守护。日志在脚本旁边的 `logs/`（`watch.log` 是守护日志，每次修复一份 JSON）。

`fix.cjs` 参数：`--diagnose-only`（只读状态，不做任何改动）、`--auto`（只重发，绝不刷新）、`--no-retry`（跳过重发直接走刷新路径）。

## 安全说明

* 诊断口用 `process._debugProcess(pid)`（Node 未公开 API）在 ChatGPT 主进程上打开，监听 127.0.0.1:9229，**没有认证**，只存在修复运行的那几秒，脚本结束时关闭并核实端口已消失。理论上这几秒内本机其他进程也能连上；介意的话只用手动模式。若 9229 已被别的进程占用，脚本直接停止，不接管。
* 三环节打点的钩子（`webContents.send`，以及从 Electron 私有的 `ipcMain._invokeHandlers` 表里取出的 `codex_desktop:message-from-view` 处理器）只在一次重发期间存在，`finally` 里一定还原。
* 界面探针通过 `webContents.executeJavaScript` 在 ChatGPT 窗口里运行，只读 React props / React Query 状态，对卡住的查询调用 `query.cancel()` + `query.fetch()`。从不清草稿、不清附件。
* 不下载、不上传。脚本只写自己的 `logs/` 目录；例外是 `install-autofix` 会在你的「启动」文件夹放一个启动器文件 `CodexDesktopAutoFix.vbs`（`uninstall-autofix` 会删掉）。
* JSON 日志里有本机路径（如应用安装目录）、请求 ID 和错误栈，但没有任何消息正文。对外分享前请自行检查。

## 向 OpenAI 反馈

有用的信息：版本号、`submitBlockReason=loading-local-config`、两条 `["vscode","codex-home"]` 查询停在 `pending/fetching` 且 `dataUpdatedAt=0`、主进程日志里有 `[electron-fetch-handler] codex-home request` 却没有对应投递、以及启动完成后简单重发就能毫秒级成功。`fix.cjs` 写出的 JSON 里包含这些（不包含任何消息正文）。

## 许可证

MIT。
