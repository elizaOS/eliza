# sign-windows.ps1 — Sign Windows executables with a code signing certificate.
# Gracefully skips if WINDOWS_SIGN_CERT_BASE64 is not set.
#
# Usage (CI):
#   pwsh -File sign-windows.ps1 -ArtifactsDir ./artifacts -BuildDir ./build
#
# Required environment variables:
#   WINDOWS_SIGN_CERT_BASE64    - Base64-encoded PFX certificate
#   WINDOWS_SIGN_CERT_PASSWORD  - Certificate password
# Optional:
#   WINDOWS_SIGN_TIMESTAMP_URL  - RFC 3161 timestamp server (default: DigiCert)

param(
  [string]$ArtifactsDir = (Join-Path $PSScriptRoot "..\artifacts"),
  [string]$BuildDir = (Join-Path $PSScriptRoot "..\build")
)

$ErrorActionPreference = "Stop"

$certBase64 = $env:WINDOWS_SIGN_CERT_BASE64
$certPassword = $env:WINDOWS_SIGN_CERT_PASSWORD
$timestampUrl = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) { $env:WINDOWS_SIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
$azureClientId = $env:AZURE_CLIENT_ID

if ($azureClientId) {
  Write-Host "AZURE_CLIENT_ID detected. Skipping PFX-based signing as Azure Trusted Signing will handle it."
  exit 0
}

if (-not $certBase64) {
  Write-Host "::warning::WINDOWS_SIGN_CERT_BASE64 not set - building unsigned (no code signing)"
  exit 0
}

if (-not $certPassword) {
  Write-Error "WINDOWS_SIGN_CERT_BASE64 is set but WINDOWS_SIGN_CERT_PASSWORD is missing"
  exit 1
}

# Import certificate to temporary file
$pfxPath = Join-Path $env:RUNNER_TEMP "code-signing-cert.pfx"
try {
  [System.IO.File]::WriteAllBytes($pfxPath, [System.Convert]::FromBase64String($certBase64))
  Write-Host "Certificate imported to temporary file"
} catch {
  Write-Error "Failed to decode certificate: $($_.Exception.Message)"
  exit 1
}

# Find signtool.exe from Windows SDK
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "x64" } |
  Sort-Object { [version]($_.FullName -replace '.*\(\d+\.\d+\.\d+\.\d+)\.*', '$1') } -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $signtool) {
  Write-Error "signtool.exe not found. Ensure Windows SDK is installed."
  exit 1
}

Write-Host "Using signtool: $signtool"
Write-Host "Timestamp server: $timestampUrl"

function Sign-Binary([string]$FilePath) {
  if (-not (Test-Path $FilePath)) {
    Write-Warning "File not found, skipping: $FilePath"
    return
  }

  Write-Host "Signing: $FilePath"
  & $signtool sign `
    /f $pfxPath `
    /p $certPassword `
    /fd sha256 `
    /tr $timestampUrl `
    /td sha256 `
    /v `
    $FilePath

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to sign: $FilePath"
    exit 1
  }

  # Verify signature
  & $signtool verify /pa /v $FilePath
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Signature verification failed: $FilePath"
    exit 1
  }

  Write-Host "Signed and verified: $FilePath"
}

$signed = 0

# Sign Setup executables in artifacts directory
$setupExes = Get-ChildItem -Path $ArtifactsDir -Recurse -Filter "*Setup*.exe" -ErrorAction SilentlyContinue
foreach ($exe in $setupExes) {
  Sign-Binary $exe.FullName
  $signed++
}

# Sign launcher.exe in the build directory
$launchers = Get-ChildItem -Path $BuildDir -Recurse -Filter "launcher.exe" -ErrorAction SilentlyContinue
foreach ($launcher in $launchers) {
  Sign-Binary $launcher.FullName
  $signed++
}

# Sign any other .exe files in build output
$otherExes = Get-ChildItem -Path $BuildDir -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne "launcher.exe" -and $_.Name -notlike "*Setup*" }
foreach ($exe in $otherExes) {
  Sign-Binary $exe.FullName
  $signed++
}

# Clean up certificate
Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
Write-Host "Code signing complete: $signed executables signed"
