@echo off
echo ========================================
echo Starting MCP Development VM with Vagrant
echo ========================================
echo.

cd /d "%~dp0"

REM Check if Vagrant is installed
where vagrant >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Vagrant is not installed or not in PATH.
    echo Please run setup-vagrant.ps1 first.
    pause
    exit /b 1
)

REM Check if VirtualBox is installed
if not exist "C:\Program Files\Oracle\VirtualBox\VirtualBox.exe" (
    echo ERROR: VirtualBox is not installed.
    echo Please run setup-vagrant.ps1 first.
    pause
    exit /b 1
)

echo Checking VM status...
vagrant status

echo.
echo Starting VM (this will take ~20 minutes on first run)...
vagrant up

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo VM is running!
    echo ========================================
    echo.
    echo MCP Server: http://localhost:8080/mcp
    echo Health Check: http://localhost:8080/health
    echo Chrome Debug: http://localhost:9222
    echo.
    echo To SSH into the VM: vagrant ssh
    echo To rebuild MCP: cargo build --release
    echo.
    echo MCP will auto-restart when binary changes!
    echo ========================================
) else (
    echo.
    echo ERROR: Failed to start VM
    echo Check the error messages above
)

pause