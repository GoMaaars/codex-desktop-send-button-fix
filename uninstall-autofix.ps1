$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'CodexDesktopAutoFix.vbs'
$state = Join-Path $dir 'logs\watch-state.json'
$watch = Join-Path $dir 'watch.cjs'
# 只结束命令行里带有本工具 watch.cjs 完整路径的 node 进程；记录的 PID 也要先核对命令行，避免误杀
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($watch.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ("已停止守护进程 PID " + $_.ProcessId) }
if (Test-Path $state) { Remove-Item $state -Force }
Remove-Item $vbs -Force
Write-Host "已卸载：启动项已删除，后台守护已停止。工具文件夹本身未删除。"
