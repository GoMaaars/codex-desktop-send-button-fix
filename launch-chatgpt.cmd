@echo off
chcp 65001 >nul
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch-chatgpt.ps1"
if errorlevel 2 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-chatgpt.ps1"
  pause
)
