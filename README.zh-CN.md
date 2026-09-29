# Codex / ChatGPT 桌面端（Windows）发送键变灰修复

[English](README.md)

**范围。** 本项目只处理一种症状：界面进去了，但发送键一直是灰的，输入框 `submitBlockReason = loading-local-config`。如果你的应用启动后一直转圈进不去，那是另一个 bug、另一套修法，请看 [codex-desktop-startup-spinner-fix](https://github.com/GoMaaars/codex-desktop-startup-spinner-fix)。

**症状。** 打开 ChatGPT 桌面端（微软商店包 `OpenAI.Codex`，内置 Codex）后发送键是灰的，旧会话发不出去；有时新会话能发一条然后也灰。重启、重启电脑、重装、改 VPN/代理都不能稳定解决。26.903–26.917 上出现。

**真正的原因。** 界面进程启动后立刻向 Electron 主进程发一批请求（`codex-home`、`get-global-state`、app-server 的 `config/read`、权限档、Windows 沙箱就绪状态……）。主进程毫秒级就回了，但启动最初几秒内这些回复在送回界面的路上被丢掉，而且没有任何重试。输入框的"本地配置"状态依赖这批回复，于是永远被锁。用同一个 requestId 给"主进程收到 → 主进程发回 → 界面收到"三个环节打点验证过：回复只在启动窗口期丢失；之后重发同样的请求 3 毫秒完成，发送键立刻恢复，连窗口都不用刷新。

## 这个工具做什么

`cdp-fix.cjs` 通过 Chrome DevTools Protocol 在本机回环（9222 端口）连到应用页面，让 React Query 对所有从未拿到第一次回复的查询做 cancel + refetch。修复就这一步：不动你打的字、不改文件、不联网。只有阻塞仍在、且输入框为空、没有回复在生成时，才刷新一次页面。（如果页面里根本没有界面，它也会顺手刷新一次——那是附带，不是本项目的主题。）

它要求应用以 `--remote-debugging-port=9222` 启动。`launch-chatgpt.cmd` 用商店应用的正规方式（`Invoke-CommandInDesktopPackage`，保留包身份）带这个参数启动。

`watch.cjs` 是可选的后台守护：每 10 秒读一次应用自己的日志目录（不轮询进程），启动 60 秒后修一次，最多再试 3 次、间隔一分钟，之后不再碰这次启动。编辑器里有字时绝不刷新。

全部实现不依赖版本：没有哈希校验、代码偏移量、压缩导出名，只用 Electron/Chromium 公开接口、React fiber 遍历和 React Query 公开方法。

## 安装（Windows 10/11，Node.js 22+）

1. 解压到任意位置，双击一次 **`install-autofix.cmd`**。它在「启动」文件夹放一个隐藏启动器（`CodexDesktopAutoFix.vbs`）、启动守护、在桌面放两个快捷方式。
2. 以后一律用桌面的 **「启动 ChatGPT（可修复）」**（`launch-chatgpt.cmd`）打开 ChatGPT。若 ChatGPT 已经在没有调试口的状态下运行，它会提示你先完全退出（托盘图标 → 退出）再试。
3. 一分钟后发送键还灰，双击 **「修复 ChatGPT 发送键」**（`run-fix.cmd`）。

`uninstall-autofix.cmd` 停止守护、删除启动器和快捷方式。日志在 `logs/`（含本机路径和请求 ID，不含任何消息正文）。

`cdp-fix.cjs` 参数：`--diagnose-only`、`--auto`（守护用）、`--port=N`。

## 安全说明

* `--remote-debugging-port` 是 Chromium 的标准开关。端口绑定 127.0.0.1、无认证、应用运行期间一直开着，本机任何进程都能连。和不信任的人共用的电脑上请不要用。
* 早期版本用 `process._debugProcess` 往主进程挂 Node inspector。26.924 已把这条路关掉，且本机出现过两次与之时间吻合的闪退，已彻底移除。
* 不下载、不上传；脚本只写自己的 `logs/`、启动文件夹里一个 `.vbs` 和桌面两个快捷方式。

## 相关报告

openai/codex issue #44342、#45906、#45797 描述的是这个症状。26.924 的启动转圈（#48487、社区帖 1400979）由上面链接的姊妹项目处理。

## 许可证

MIT。
