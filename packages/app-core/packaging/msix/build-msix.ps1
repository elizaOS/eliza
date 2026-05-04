# build-msix.ps1 — Build an MSIX package from a signed Electrobun Windows build.
# Intended to run in CI after sign-windows.ps1.
#
# Usage:
#   pwsh -File build-msix.ps1 -BuildDir ./build -OutputDir ./artifacts -Version 2.0.0
#
# Prerequisites:
#   - Windows SDK installed (for makeappx.exe and signtool.exe)
#   - Executables already code-signed (sign-windows.ps1 or Azure Trusted Signing)
#   - Either WINDOWS_SIGN_CERT_BASE64 + WINDOWS_SIGN_CERT_PASSWORD, or AZURE_TENANT_ID,
#     or SKIP_MSIX_SIGN (build unsigned MSIX for SKIP_WINDOWS_SIGNING / Azure path)

param(
  [Parameter(Mandatory)][string]$BuildDir,
  [Parameter(Mandatory)][string]$OutputDir,
  [Parameter(Mandatory)][string]$Version
)

$ErrorActionPreference = "Stop"

$certBase64 = $env:WINDOWS_SIGN_CERT_BASE64
$certPassword = $env:WINDOWS_SIGN_CERT_PASSWORD
$timestampUrl = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) { $env:WINDOWS_SIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
$azureSigning = $env:AZURE_TENANT_ID -or $env:AZURE_CLIENT_ID -or $env:SKIP_MSIX_SIGN -or $env:SKIP_WINDOWS_SIGNING

if (-not $certBase64 -and -not $azureSigning) {
  Write-Host "::warning::WINDOWS_SIGN_CERT_BASE64 not set and no Azure Trusted Signing - skipping MSIX generation"
  exit 0
}

# Find SDK tools
$sdkBin = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1

if (-not $sdkBin) {
  Write-Error "Windows SDK not found"
  exit 1
}

$makeappx = Join-Path $sdkBin.FullName "x64\makeappx.exe"
$signtool = Join-Path $sdkBin.FullName "x64\signtool.exe"

if (-not (Test-Path $makeappx)) {
  Write-Error "makeappx.exe not found at: $makeappx"
  exit 1
}

Write-Host "Using makeappx: $makeappx"
Write-Host "Using signtool: $signtool"

# Prepare MSIX staging directory
$msixStaging = Join-Path $env:RUNNER_TEMP "msix-staging"
Remove-Item $msixStaging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $msixStaging | Out-Null

# Find the Electrobun build output (launcher.exe and its directory)
$launcher = Get-ChildItem -Path $BuildDir -Recurse -Filter "launcher.exe" -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $launcher) {
  Write-Error "launcher.exe not found under $BuildDir"
  exit 1
}

$launcherParent = Split-Path -Parent $launcher.FullName
# launcher.exe lives under bin/ in the Electrobun app bundle; the app root is one level up
$appDir = if ((Split-Path -Leaf $launcherParent) -eq "bin") {
  Split-Path -Parent $launcherParent
} else {
  $launcherParent
}
Write-Host "App directory: $appDir"

# Copy app contents to staging
Copy-Item -Path "$appDir\*" -Destination $msixStaging -Recurse -Force

# Copy MSIX assets
$msixDir = $PSScriptRoot
$assetsSource = Join-Path $msixDir "assets"
$assetsDest = Join-Path $msixStaging "assets"
New-Item -ItemType Directory -Force -Path $assetsDest | Out-Null
Copy-Item -Path "$assetsSource\*" -Destination $assetsDest -Recurse -Force

# Process AppxManifest — inject version
$manifestSource = Join-Path $msixDir "AppxManifest.xml"
$manifestDest = Join-Path $msixStaging "AppxManifest.xml"

# Convert semver (2.0.0-alpha.84) to Windows quad version (2.0.84.0)
$parts = $Version -split '[-.]'
$major = $parts[0]
$minor = $parts[1]
$patch = $parts[2]
$build = if ($parts.Count -ge 5) { $parts[4] } else { "0" }
$winVersion = "$major.$minor.$patch.$build"

$manifestContent = Get-Content $manifestSource -Raw
$manifestContent = $manifestContent -replace 'Version="0\.0\.0\.0"', "Version=`"$winVersion`""
Set-Content -Path $manifestDest -Value $manifestContent
Write-Host "Manifest version set to: $winVersion"

# Build MSIX package
$msixOutput = Join-Path $OutputDir "ElizaOSApp-$Version-x64.msix"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

& $makeappx pack /d $msixStaging /p $msixOutput /o
if ($LASTEXITCODE -ne 0) {
  Write-Error "makeappx pack failed"
  exit 1
}

Write-Host "MSIX package created: $msixOutput"

if ($env:SKIP_MSIX_SIGN -or ($azureSigning -and -not $certBase64)) {
  if ($env:SKIP_WINDOWS_SIGNING) {
    Write-Host "SKIP_WINDOWS_SIGNING - delivering unsigned MSIX"
  } else {
    Write-Host "Azure Trusted Signing path - skipping PFX signing. Azure will sign the MSIX next."
  }
  exit 0
}

# Sign the MSIX package (requires WINDOWS_SIGN_CERT_BASE64)
$pfxPath = Join-Path $env:RUNNER_TEMP "code-signing-cert.pfx"
[System.IO.File]::WriteAllBytes($pfxPath, [System.Convert]::FromBase64String($certBase64))

& $signtool sign /f $pfxPath /p $certPassword /fd sha256 /tr $timestampUrl /td sha256 /v $msixOutput
if ($LASTEXITCODE -ne 0) {
  Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
  Write-Error "Failed to sign MSIX package"
  exit 1
}

Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue

# Verify
& $signtool verify /pa /v $msixOutput
if ($LASTEXITCODE -ne 0) {
  Write-Error "MSIX signature verification failed"
  exit 1
}

Write-Host "MSIX package signed and verified: $msixOutput"
