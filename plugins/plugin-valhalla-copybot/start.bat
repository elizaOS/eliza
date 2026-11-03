@echo off
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env
  echo Created .env. Add your Google AI Studio key, then run this again.
  pause
  exit /b 1
)
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
)
where bun >nul 2>nul
if %errorlevel%==0 (
  bun src/standalone.ts
  pause
  exit /b %errorlevel%
)
echo Install Bun from https://bun.sh or Node.js 24, then run this again.
pause
exit /b 1
