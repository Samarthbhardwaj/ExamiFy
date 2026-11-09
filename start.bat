@echo off
set "PATH=C:\Users\samar\AppData\Local\Programs\nodejs;%PATH%"
echo ========================================================
echo   Paper Simulator — Multi-User & Network Ready
echo   ✨ Powered by Google Gemini AI Exam Generator
echo   Local:       http://localhost:3000
echo   LAN / Wi-Fi: http://192.168.1.109:3000
echo ========================================================
start "" "http://localhost:3000"
node server.js
pause
