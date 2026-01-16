# Setup script to install Vagrant and VirtualBox for local development

Write-Host "Setting up Vagrant development environment..." -ForegroundColor Green

# Check if running as Administrator
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "This script requires Administrator privileges. Please run as Administrator." -ForegroundColor Red
    exit 1
}

# Install Scoop if not already installed
if (!(Get-Command scoop -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Scoop package manager..." -ForegroundColor Yellow
    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Invoke-Expression (New-Object System.Net.WebClient).DownloadString('https://get.scoop.sh')

    # Refresh environment
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "Scoop is already installed" -ForegroundColor Green
}

# Install VirtualBox if not installed
if (!(Test-Path "C:\Program Files\Oracle\VirtualBox\VirtualBox.exe")) {
    Write-Host "Installing VirtualBox..." -ForegroundColor Yellow

    # Download VirtualBox installer
    $vboxUrl = "https://download.virtualbox.org/virtualbox/7.0.14/VirtualBox-7.0.14-161095-Win.exe"
    $vboxInstaller = "$env:TEMP\VirtualBox-installer.exe"

    Write-Host "Downloading VirtualBox..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $vboxUrl -OutFile $vboxInstaller -UseBasicParsing

    Write-Host "Installing VirtualBox (this may take a few minutes)..." -ForegroundColor Yellow
    Start-Process -FilePath $vboxInstaller -ArgumentList "--silent" -Wait

    Write-Host "VirtualBox installed successfully" -ForegroundColor Green
} else {
    Write-Host "VirtualBox is already installed" -ForegroundColor Green
}

# Install Vagrant using Scoop
Write-Host "Installing Vagrant..." -ForegroundColor Yellow
scoop install vagrant

# Verify installations
Write-Host "`nVerifying installations..." -ForegroundColor Cyan

# Check VirtualBox
if (Test-Path "C:\Program Files\Oracle\VirtualBox\VirtualBox.exe") {
    $vboxVersion = & "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" --version
    Write-Host "✓ VirtualBox installed: $vboxVersion" -ForegroundColor Green
} else {
    Write-Host "✗ VirtualBox installation failed" -ForegroundColor Red
}

# Check Vagrant
if (Get-Command vagrant -ErrorAction SilentlyContinue) {
    $vagrantVersion = vagrant --version
    Write-Host "✓ Vagrant installed: $vagrantVersion" -ForegroundColor Green
} else {
    Write-Host "✗ Vagrant installation failed" -ForegroundColor Red
}

Write-Host "`nSetup complete!" -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Navigate to the vagrant directory: cd vagrant" -ForegroundColor White
Write-Host "2. Start the VM: vagrant up" -ForegroundColor White
Write-Host "3. SSH into the VM: vagrant ssh" -ForegroundColor White