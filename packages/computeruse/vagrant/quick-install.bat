@echo off
echo ========================================
echo QUICK VAGRANT SETUP - RUN AS ADMIN
echo ========================================
echo.

REM Download and install Vagrant directly
echo Installing Vagrant...
powershell -Command "Invoke-WebRequest -Uri 'https://releases.hashicorp.com/vagrant/2.4.0/vagrant_2.4.0_windows_amd64.msi' -OutFile '%TEMP%\vagrant.msi'"
msiexec /i "%TEMP%\vagrant.msi" /quiet /norestart
echo Vagrant installed.

REM Download and install VirtualBox directly
echo Installing VirtualBox...
powershell -Command "Invoke-WebRequest -Uri 'https://download.virtualbox.org/virtualbox/7.0.14/VirtualBox-7.0.14-161095-Win.exe' -OutFile '%TEMP%\virtualbox.exe'"
"%TEMP%\virtualbox.exe" --silent
echo VirtualBox installed.

REM Add to PATH
setx PATH "%PATH%;C:\HashiCorp\Vagrant\bin;C:\Program Files\Oracle\VirtualBox" /M

echo.
echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo Now run: start-dev-vm.cmd to start the VM
echo.
pause