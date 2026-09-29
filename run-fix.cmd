@echo off
chcp 65001 >nul
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"
"%NODE_EXE%" "%~dp0cdp-fix.cjs" %*
echo.
pause
