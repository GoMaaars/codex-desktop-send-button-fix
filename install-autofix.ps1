$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
$watch = Join-Path $dir 'watch.cjs'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'CodexDesktopAutoFix.vbs'
$content = 'CreateObject("WScript.Shell").Run """' + $node + '"" """' + $watch + '""", 0, False'
# 先停掉旧的守护
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($watch.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Set-Content -Path $vbs -Value $content -Encoding Unicode
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
Start-Sleep -Seconds 3
Write-Host "已安装：登录后自动在后台运行，守护脚本现已启动。"
Write-Host "启动项文件：$vbs"
Write-Host "运行日志：$dir\logs\watch.log"
