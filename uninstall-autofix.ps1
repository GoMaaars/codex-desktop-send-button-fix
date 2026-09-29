$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'CodexDesktopAutoFix.vbs'
$watch = Join-Path $dir 'watch.cjs'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($watch.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ("已停止守护进程 PID " + $_.ProcessId) }
Remove-Item (Join-Path $dir 'logs\watch-state.json') -Force
Remove-Item $vbs -Force
$desktop = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktop '修复 ChatGPT 发送键.lnk') -Force
Remove-Item (Join-Path $desktop '启动 ChatGPT（可修复）.lnk') -Force
Write-Host '已卸载：启动项、桌面快捷方式已删除，后台守护已停止。工具文件夹本身未删除。'
