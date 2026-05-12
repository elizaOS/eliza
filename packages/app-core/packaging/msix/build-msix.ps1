# build-msix.ps1 — Build an MSIX package from a signed Electrobun Windows build.
# Intended to run in CI after sign-windows.ps1.
#
# Usage:
#   pwsh -File build-msix.ps1 -BuildDir ./build -OutputDir ./artifacts -Version 2.0.0
#
# Variant selection (env var ELIZA_BUILD_VARIANT):
#   - "store"  — Microsoft Store flavor. Uses AppxManifest.store.xml (AppContainer-
#                sandboxed, no runFullTrust). Local-agent execution is gated off at
#                runtime; cloud hosting only. Sign with the Microsoft Store certificate
#                (env var ELIZA_MSIX_STORE_CERT_PATH) — see TODO below.
#   - "direct" — Default. Uses AppxManifest.xml (full-trust desktop). Distributed via
#                NSIS/MSI; supports local agents.
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

# Build variant — "store" (AppContainer / Microsoft Store) or "direct" (full-trust NSIS/MSI flavor).
$buildVariant = if ($env:ELIZA_BUILD_VARIANT) { $env:ELIZA_BUILD_VARIANT.ToLower() } else { "direct" }
if ($buildVariant -ne "store" -and $buildVariant -ne "direct") {
  Write-Error "Invalid ELIZA_BUILD_VARIANT='$buildVariant' (expected 'store' or 'direct')"
  exit 1
}
Write-Host "Build variant: $buildVariant"

$certBase64 = $env:WINDOWS_SIGN_CERT_BASE64
$certPassword = $env:WINDOWS_SIGN_CERT_PASSWORD
$timestampUrl = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) { $env:WINDOWS_SIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
$azureSigning = $env:AZURE_TENANT_ID -or $env:AZURE_CLIENT_ID -or $env:SKIP_MSIX_SIGN -or $env:SKIP_WINDOWS_SIGNING

if ($buildVariant -eq "store") {
  # TODO(store-cert): When Microsoft Partner Center registration is finalized, set
  #   ELIZA_MSIX_STORE_CERT_PATH (path to the .pfx issued for the registered Identity Name)
  #   and ELIZA_MSIX_STORE_CERT_PASSWORD. Until then, store builds run unsigned and the
  #   Partner Center upload pipeline re-signs server-side. The Identity Publisher in
  #   AppxManifest.store.xml MUST match the publisher ID issued by Partner Center.
  $storeCertPath = $env:ELIZA_MSIX_STORE_CERT_PATH
  $storeCertPassword = $env:ELIZA_MSIX_STORE_CERT_PASSWORD
  if ($storeCertPath -and (Test-Path $storeCertPath)) {
    Write-Host "Store cert: $storeCertPath"
  } else {
    Write-Host "ELIZA_MSIX_STORE_CERT_PATH not set or missing — store MSIX will be built unsigned for Partner Center re-sign."
  }
}

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

# Process AppxManifest — inject version. Pick variant-specific manifest.
$manifestFileName = if ($buildVariant -eq "store") { "AppxManifest.store.xml" } else { "AppxManifest.xml" }
$manifestSource = Join-Path $msixDir $manifestFileName
$manifestDest = Join-Path $msixStaging "AppxManifest.xml"
Write-Host "Manifest source: $manifestSource"

if (-not (Test-Path $manifestSource)) {
  Write-Error "Manifest not found: $manifestSource"
  exit 1
}

# Convert semver (2.0.0-beta.0) to Windows quad version (2.0.0.0)
$parts = $Version -split '[-.]'
$major = $parts[0]
$minor = $parts[1]
$patch = $parts[2]
$build = if ($parts.Count -ge 5) { $parts[4] } else { "0" }
$winVersion = "$major.$minor.$patch.$build"

$manifestContent = Get-Content $manifestSource -Raw
$manifestContent = $manifestContent -replace 'Version="0\.0\.0\.0"', "Version=`"$winVersion`""

# Identity parameterization for Partner Center submissions.
#
# When uploading to the Microsoft Store, the Identity.Name and Identity.Publisher
# attributes MUST match the values issued by Partner Center for the registered app.
# Until those IDs are provisioned the manifest ships with placeholders, which would
# be rejected on upload. Allow env-var override so CI can substitute real values
# without forking the manifest.
if ($buildVariant -eq "store") {
  $identityName = $env:ELIZA_MSIX_IDENTITY_NAME
  $publisherId = $env:ELIZA_MSIX_PUBLISHER_ID
  $publisherDisplayName = $env:ELIZA_MSIX_PUBLISHER_DISPLAY_NAME
  if ($identityName) {
    $manifestContent = $manifestContent -replace 'Name="ElizaOS\.App"', "Name=`"$identityName`""
    Write-Host "Identity.Name set to: $identityName"
  } else {
    Write-Host "::warning::ELIZA_MSIX_IDENTITY_NAME not set — store MSIX will use placeholder 'ElizaOS.App' (Partner Center upload will reject)."
  }
  if ($publisherId) {
    $manifestContent = $manifestContent -replace 'Publisher="CN=elizaOS"', "Publisher=`"$publisherId`""
    Write-Host "Identity.Publisher set to: $publisherId"
  } else {
    Write-Host "::warning::ELIZA_MSIX_PUBLISHER_ID not set — store MSIX will use placeholder 'CN=elizaOS' (Partner Center upload will reject)."
  }
  if ($publisherDisplayName) {
    $manifestContent = $manifestContent -replace '<PublisherDisplayName>elizaOS</PublisherDisplayName>', "<PublisherDisplayName>$publisherDisplayName</PublisherDisplayName>"
    Write-Host "PublisherDisplayName set to: $publisherDisplayName"
  }
}

Set-Content -Path $manifestDest -Value $manifestContent
Write-Host "Manifest version set to: $winVersion"

# Build MSIX package
$variantSuffix = if ($buildVariant -eq "store") { "-store" } else { "" }
$msixOutput = Join-Path $OutputDir "ElizaOSApp-$Version-x64$variantSuffix.msix"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

& $makeappx pack /d $msixStaging /p $msixOutput /o
if ($LASTEXITCODE -ne 0) {
  Write-Error "makeappx pack failed"
  exit 1
}

Write-Host "MSIX package created: $msixOutput"

# Pick signing identity. Store builds prefer ELIZA_MSIX_STORE_CERT_PATH; if absent, fall
# through to the standard signing path (Azure Trusted Signing or WINDOWS_SIGN_CERT_BASE64).
# If neither is configured, the MSIX is delivered unsigned for Partner Center server-side re-sign.
$useStoreCert = $false
$storeCertPath = $env:ELIZA_MSIX_STORE_CERT_PATH
$storeCertPassword = $env:ELIZA_MSIX_STORE_CERT_PASSWORD
if ($buildVariant -eq "store" -and $storeCertPath -and (Test-Path $storeCertPath)) {
  $useStoreCert = $true
}

if ($env:SKIP_MSIX_SIGN -or ($azureSigning -and -not $certBase64 -and -not $useStoreCert)) {
  if ($env:SKIP_WINDOWS_SIGNING) {
    Write-Host "SKIP_WINDOWS_SIGNING - delivering unsigned MSIX"
  } else {
    Write-Host "Azure Trusted Signing path - skipping PFX signing. Azure will sign the MSIX next."
  }
  exit 0
}

if ($useStoreCert) {
  Write-Host "Signing store MSIX with ELIZA_MSIX_STORE_CERT_PATH"
  & $signtool sign /f $storeCertPath /p $storeCertPassword /fd sha256 /tr $timestampUrl /td sha256 /v $msixOutput
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to sign MSIX package with store cert"
    exit 1
  }
} else {
  if (-not $certBase64) {
    Write-Host "No signing cert available — delivering unsigned MSIX"
    exit 0
  }
  # Sign the MSIX package with the dev/CI cert (WINDOWS_SIGN_CERT_BASE64)
  $pfxPath = Join-Path $env:RUNNER_TEMP "code-signing-cert.pfx"
  [System.IO.File]::WriteAllBytes($pfxPath, [System.Convert]::FromBase64String($certBase64))

  & $signtool sign /f $pfxPath /p $certPassword /fd sha256 /tr $timestampUrl /td sha256 /v $msixOutput
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
    Write-Error "Failed to sign MSIX package"
    exit 1
  }

  Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
}

# Verify
& $signtool verify /pa /v $msixOutput
if ($LASTEXITCODE -ne 0) {
  Write-Error "MSIX signature verification failed"
  exit 1
}

Write-Host "MSIX package signed and verified: $msixOutput"
