$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
$watch = Join-Path $dir 'watch.cjs'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'CodexDesktopAutoFix.vbs'
$content = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + $watch + '""", 0, False'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($watch.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Set-Content -Path $vbs -Value $content -Encoding Unicode
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
Start-Sleep -Seconds 2
$desktop = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut((Join-Path $desktop '启动 ChatGPT（可修复）.lnk'))
$sc.TargetPath = Join-Path $dir 'launch-chatgpt.cmd'; $sc.WorkingDirectory = $dir; $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"; $sc.Description = '以可修复模式启动 ChatGPT 桌面端'; $sc.Save()
$sc = $sh.CreateShortcut((Join-Path $desktop '修复 ChatGPT 发送键.lnk'))
$sc.TargetPath = Join-Path $dir 'run-fix.cmd'; $sc.WorkingDirectory = $dir; $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,238"; $sc.Description = '转圈或发送键变灰时双击修复'; $sc.Save()
Write-Host '已安装。以后请用桌面的「启动 ChatGPT（可修复）」打开 ChatGPT；守护会在启动后自动修复，也可以手动双击「修复 ChatGPT 发送键」。'
Write-Host "运行日志：$dir\logs\watch.log"
