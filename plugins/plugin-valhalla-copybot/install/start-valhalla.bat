@echo off
set VALHALLA_DATA_DIR=%LOCALAPPDATA%\Valhalla
set VALHALLA_PUBLIC_DIR=%~dp0public
set VALHALLA_BIND=127.0.0.1
set VALHALLA_LIVE_TRADING=false
set VALHALLA_OPEN_BROWSER=true
"%~dp0valhalla-desk.exe"
