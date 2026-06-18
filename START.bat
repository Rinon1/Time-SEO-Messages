@echo off
title Auto Messenger
echo.
echo  Auto Messenger - Starting up...
echo.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js is not installed!
  echo  Download it from https://nodejs.org and install, then run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  First run: installing packages (this takes ~2 minutes)...
  echo.
  npm install
  echo.
)

echo  Opening http://localhost:3000 in your browser...
echo  Keep this window open while using the app.
echo.
start http://localhost:3000
node server.js

pause
