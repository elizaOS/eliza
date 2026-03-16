#Configure Variables
$InstallPath = "C:\Program Files\OpenSSH"
$DisablePasswordAuthentication = $false
$DisablePubkeyAuthentication = $True
$AutoStartSSHD = $true
$AutoStartSSHAGENT = $true

$OpenSSHLocation = $null
$GitUrl = 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/v8.1.0.0p1-Beta/OpenSSH-Win64.zip'
$GitZipName = "OpenSSH-Win64.zip"
$ErrorActionPreference = "Stop" # Do not change this one!
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'

# Detect Elevation:
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$UserPrincipal = New-Object System.Security.Principal.WindowsPrincipal($CurrentUser)
$AdminRole = [System.Security.Principal.WindowsBuiltInRole]::Administrator
$IsAdmin = $UserPrincipal.IsInRole($AdminRole)
if ($IsAdmin) {
    Write-Host "Script is running elevated." -ForegroundColor Green
}
else {
    throw "Script is not running elevated, which is required. Restart the script from an elevated prompt."
}

#Remove BuiltIn OpenSSH
$ErrorActionPreference = "SilentlyContinue"
Write-Host "Checking for Windows OpenSSH Server" -ForegroundColor Green
if ($(Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0).State -eq "Installed") {
    Write-Host "Removing Windows OpenSSH Server" -ForegroundColor Green
    Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue
}
Write-Host "Checking for Windows OpenSSH Client" -ForegroundColor Green
if ($(Get-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0).State -eq "Installed") {
    Write-Host "Removing Windows OpenSSH Client" -ForegroundColor Green
    Remove-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 -ErrorAction SilentlyContinue
}
$ErrorActionPreference = "Stop"

#Stop and remove existing services (Perhaps an exisitng OpenSSH install)
if (Get-Service sshd -ErrorAction SilentlyContinue) {
    Stop-Service sshd -ErrorAction SilentlyContinue
    sc.exe delete sshd 1>$null
}
if (Get-Service ssh-agent -ErrorAction SilentlyContinue) {
    Stop-Service ssh-agent -ErrorAction SilentlyContinue
    sc.exe delete ssh-agent 1>$null
}

# Ensure all sshd and ssh-agent processes are stopped
Get-Process sshd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process ssh-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if ($OpenSSHLocation.Length -eq 0) {
    # Download and extract archive
    Write-Host "Downloading Archive" -ForegroundColor Green
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $GitUrl -OutFile $GitZipName -ErrorAction Stop -TimeoutSec 5 -Headers @{"Pragma" = "no-cache"; "Cache-Control" = "no-cache"; } -UserAgent $UserAgent
    Write-Host "Download Complete, now expanding and copying to destination" -ForegroundColor Green -ErrorAction Stop
}
else {
    $PathInfo = [System.Uri]([string]::":FileSystem::" + $OpenSSHLocation)
    if ($PathInfo.IsUnc) {
        Copy-Item -Path $PathInfo.LocalPath -Destination $env:TEMP
        Set-Location $env:TEMP
    }
}

Remove-Item -Path $InstallPath -Force -Recurse -ErrorAction SilentlyContinue
If (!(Test-Path $InstallPath)) {
    New-Item -Path $InstallPath -ItemType "directory" -ErrorAction Stop | Out-Null
}

$OldEnv = [Environment]::CurrentDirectory
[Environment]::CurrentDirectory = $(Get-Location)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($GitZipName)
$archive.Entries | ForEach-Object {
    # Entries with an empty Name property are directories
    if ($_.Name -ne '') {
        $NewFIleName = Join-Path $InstallPath $_.Name
        Remove-Item -Path $NewFIleName -Force -ErrorAction SilentlyContinue
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($_, $NewFIleName, $true)
    }
}
$archive.Dispose()
Set-Location $OldEnv

#Cleanup zip file if we downloaded it
if ($GitUrl.Length -gt 0) { Remove-Item -Path $GitZipName -Force -ErrorAction SilentlyContinue }

#Run Install Script
Write-Host "Running Install Commands" -ForegroundColor Green
Set-Location $InstallPath -ErrorAction Stop
powershell.exe -ExecutionPolicy Bypass -File install-sshd.ps1
Set-Service -Name sshd -StartupType 'Automatic' -ErrorAction Stop

#Make sure your ProgramData\ssh directory exists
If (!(Test-Path $env:ProgramData\ssh)) {
    Write-Host "Creating ProgramData\ssh directory" -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path $env:ProgramData\ssh -ErrorAction Stop | Out-Null
}

#Setup sshd_config
Write-Host "Configure server config file" -ForegroundColor Green
Copy-Item -Path $InstallPath\sshd_config_default -Destination $env:ProgramData\ssh\sshd_config -Force -ErrorAction Stop
Add-Content -Path $env:ProgramData\ssh\sshd_config -Value "`r`nGSSAPIAuthentication yes" -ErrorAction Stop
if ($DisablePasswordAuthentication) { Add-Content -Path $env:ProgramData\ssh\sshd_config -Value "PasswordAuthentication no" -ErrorAction Stop }
if ($DisablePubkeyAuthentication) { Add-Content -Path $env:ProgramData\ssh\sshd_config -Value "PubkeyAuthentication no" -ErrorAction Stop }

#Make sure your user .ssh directory exists
If (!(Test-Path "~\.ssh")) {
    Write-Host "Creating User .ssh directory" -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path "~\.ssh" -ErrorAction Stop | Out-Null
}

#Set ssh_config
Write-Host "Configure client config file" -ForegroundColor Green
Add-Content -Path ~\.ssh\config -Value "`r`nGSSAPIAuthentication yes" -ErrorAction Stop

#Setting autostarts
if ($AutoStartSSHD) {
    Write-Host "Setting sshd service to Automatic start" -ForegroundColor Green;
    Set-Service -Name sshd -StartupType Automatic;
}
if ($AutoStartSSHAGENT) {
    Write-Host "Setting ssh-agent service to Automatic start" -ForegroundColor Green;
    Set-Service -Name ssh-agent -StartupType Automatic;
}

#Start the service
Write-Host "Starting sshd Service" -ForegroundColor Green
Start-Service sshd -ErrorAction Stop

#Add to path if it isnt already there
$existingPath = (Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\System\CurrentControlSet\Control\Session Manager\Environment' -Name PATH).path
if ($existingPath -notmatch $InstallPath.Replace("\", "\\")) {
    Write-Host "Adding OpenSSH Directory to path" -ForegroundColor Green
    $newpath = "$existingPath;$InstallPath"
    Set-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\System\CurrentControlSet\Control\Session Manager\Environment' -Name PATH -Value $newPath -ErrorAction Stop
}

#Make sure user keys are configured correctly
Write-Host "Ensuring HostKey file permissions are correct" -ForegroundColor Green
powershell.exe -ExecutionPolicy Bypass -Command '. .\FixHostFilePermissions.ps1 -Confirm:$false'

#Make sure host keys are configured correctly
Write-Host "Ensuring UserKey file permissions are correct" -ForegroundColor Green
powershell.exe -ExecutionPolicy Bypass -Command '. .\FixUserFilePermissions.ps1 -Confirm:$false'

#Add firewall rule
Write-Host "Creating firewall rule" -ForegroundColor Green
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue

#Set Shell to powershell
Write-Host "Setting default shell to powershell" -ForegroundColor Green
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force -ErrorAction Stop | Out-Null
Write-Host "Installation completed successfully" -ForegroundColor Green 