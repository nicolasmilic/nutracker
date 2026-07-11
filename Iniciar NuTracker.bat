@echo off
title NuTracker
cd /d "%~dp0"
start "" http://localhost:3210
node --use-system-ca server.js
pause
