$ErrorActionPreference = 'Stop'
$port = 9222
# 已在运行？（Get-Process 比 WMI 快得多）
if (@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue).Count -gt 0) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing | Out-Null
    Write-Host 'ChatGPT 已经在可修复模式下运行，无需重复启动。'
    exit 0
  } catch {
    Write-Host 'ChatGPT 正在运行，但不是用本快捷方式启动的（没有调试口）。'
    Write-Host '请先完全退出 ChatGPT（关窗口不算，要在托盘图标右键选退出），然后再双击本快捷方式。'
    exit 3
  }
}
$pkg = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (-not $pkg) { Write-Host '未找到从微软商店安装的 ChatGPT 桌面端（OpenAI.Codex）。'; exit 2 }
# 商店应用不能直接双击 exe（会报「该进程没有程序包标识符」），必须带着包身份启动。
# 先按已知布局直接启动；找不到再读清单。
$appId = 'App'; $exeFull = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path $exeFull)) {
  $app = (Get-AppxPackageManifest $pkg).Package.Applications.Application | Select-Object -First 1
  $appId = $app.Id; $exeFull = Join-Path $pkg.InstallLocation ($app.Executable -replace '/', '\')
  if (-not (Test-Path $exeFull)) { Write-Host "找不到 $exeFull"; exit 2 }
}
Invoke-CommandInDesktopPackage -PackageFamilyName $pkg.PackageFamilyName -AppId $appId -Command $exeFull -Args "--remote-debugging-port=$port"
