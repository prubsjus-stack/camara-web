@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [error] No se encontro Python. Instalalo desde https://www.python.org/downloads/
    echo         y marca "Add Python to PATH" durante la instalacion.
    pause
    exit /b 1
)

if not exist "vendor\cloudflared.exe" (
    echo [aviso] Falta cloudflared, se necesita para el link publico HTTPS.
    echo         powershell -ExecutionPolicy Bypass -File install-cloudflared.ps1
    echo.
)

python server.py %*
if errorlevel 1 pause
