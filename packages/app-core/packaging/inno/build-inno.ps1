# build-inno.ps1 — Build a standalone Inno Setup installer from a packaged Electrobun Windows app.
#
# Usage:
#   pwsh -File packaging/inno/build-inno.ps1 `
#     -BuildDir ./apps/app/electrobun/build `
#     -OutputDir ./apps/app/electrobun/artifacts `
#     -Version 2.0.0-beta.0 `
#     -Channel canary

param(
  [Parameter(Mandatory)][string]$BuildDir,
  [Parameter(Mandatory)][string]$OutputDir,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$Channel,
  [string]$CompilerPath = $env:ELIZAOS_APP_INNO_SETUP_COMPILER
)

$ErrorActionPreference = "Stop"

function Get-IsccPath {
  param([string]$PreferredPath)

  $candidates = @()
  if ($PreferredPath) {
    $candidates += $PreferredPath
  }
  $candidates += @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw "ISCC.exe not found. Install Inno Setup 6.7.1 first."
}

function Escape-InnoValue {
  param([string]$Value)
  return $Value.Replace('"', '""')
}

function Get-ChannelLabel {
  param([string]$NormalizedChannel)

  switch ($NormalizedChannel) {
    "stable" { return "elizaOS App" }
    "canary" { return "elizaOS App Canary" }
    default { return "elizaOS App $([char]::ToUpper($NormalizedChannel[0]))$($NormalizedChannel.Substring(1))" }
  }
}

function Get-ChannelInstallName {
  param([string]$NormalizedChannel)

  if ($NormalizedChannel -eq "stable") {
    return "ElizaOSApp"
  }

  return "ElizaOSApp-$NormalizedChannel"
}

function Get-InstallerSignSection {
  $certBase64 = $env:WINDOWS_SIGN_CERT_BASE64
  $certPassword = $env:WINDOWS_SIGN_CERT_PASSWORD
  $timestampUrl = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) {
    $env:WINDOWS_SIGN_TIMESTAMP_URL
  } else {
    "http://timestamp.digicert.com"
  }

  if (-not $certBase64) {
    Write-Host "::warning::WINDOWS_SIGN_CERT_BASE64 not set - building unsigned Inno Setup installer"
    return "; installer signing disabled"
  }

  if (-not $certPassword) {
    throw "WINDOWS_SIGN_CERT_BASE64 is set but WINDOWS_SIGN_CERT_PASSWORD is missing"
  }

  $signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "x64" } |
    Sort-Object { [version]($_.FullName -replace '.*\\(\d+\.\d+\.\d+\.\d+)\\.*', '$1') } -Descending |
    Select-Object -First 1 -ExpandProperty FullName

  if (-not $signtool) {
    throw "signtool.exe not found. Ensure Windows SDK is installed."
  }

  $pfxPath = Join-Path $env:RUNNER_TEMP "elizaos-app-inno-signing-cert.pfx"
  [System.IO.File]::WriteAllBytes($pfxPath, [System.Convert]::FromBase64String($certBase64))

  $escapedPfxPath = Escape-InnoValue $pfxPath
  $escapedPassword = Escape-InnoValue $certPassword
  $escapedTimestampUrl = Escape-InnoValue $timestampUrl

  return @(
    "SignTool=signtool sign /f `$q$escapedPfxPath`$q /p `$q$escapedPassword`$q /fd sha256 /tr `$q$escapedTimestampUrl`$q /td sha256 /v `$f",
    "SignedUninstaller=yes"
  ) -join "`r`n"
}

$normalizedChannel = $Channel.Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($normalizedChannel)) {
  throw "Channel must not be empty"
}

$isccPath = Get-IsccPath -PreferredPath $CompilerPath
$templatePath = Join-Path $PSScriptRoot "ElizaOSApp.iss"
$iconPath = Join-Path $PSScriptRoot "..\..\platforms\electrobun\assets\appIcon.ico"

if (-not (Test-Path $templatePath)) {
  throw "Inno Setup template not found: $templatePath"
}

if (-not (Test-Path $iconPath)) {
  throw "Windows icon not found: $iconPath"
}

$launcher = Get-ChildItem -Path $BuildDir -Recurse -File -Filter "launcher.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $launcher) {
  throw "launcher.exe not found under $BuildDir"
}

$launcherParent = Split-Path -Parent $launcher.FullName
# launcher.exe lives under bin/ in the Electrobun app bundle; the app root is one level up
$sourceDir = if ((Split-Path -Leaf $launcherParent) -eq "bin") {
  Split-Path -Parent $launcherParent
} else {
  $launcherParent
}
$elizaosDistEntry = Join-Path $sourceDir "Resources\app\eliza-dist\entry.js"
if (-not (Test-Path $elizaosDistEntry)) {
  throw "Packaged app directory does not contain Resources\app\eliza-dist\entry.js: $sourceDir"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$channelInstallName = Get-ChannelInstallName -NormalizedChannel $normalizedChannel
$appName = Get-ChannelLabel -NormalizedChannel $normalizedChannel
$appId = if ($normalizedChannel -eq "stable") {
  "ai.elizaos.app"
} else {
  "ai.elizaos.app.$normalizedChannel"
}
# Keep install root short to avoid MAX_PATH (Error 206) when extracting deep
# runtime dependency trees on systems where long paths are not fully enabled.
$defaultDirName = "{localappdata}\ElizaOSApp\$normalizedChannel"
$outputBaseFilename = "ElizaOSApp-Setup-$normalizedChannel"

$signSection = Get-InstallerSignSection
$template = Get-Content $templatePath -Raw
$generated = $template
$generated = $generated.Replace("__APP_ID__", (Escape-InnoValue $appId))
$generated = $generated.Replace("__APP_NAME__", (Escape-InnoValue $appName))
$generated = $generated.Replace("__APP_VERSION__", (Escape-InnoValue $Version))
$generated = $generated.Replace("__DEFAULT_DIR_NAME__", (Escape-InnoValue $defaultDirName))
$generated = $generated.Replace("__DEFAULT_GROUP_NAME__", (Escape-InnoValue $appName))
$generated = $generated.Replace("__OUTPUT_DIR__", (Escape-InnoValue (Resolve-Path $OutputDir).Path))
$generated = $generated.Replace("__OUTPUT_BASE_FILENAME__", (Escape-InnoValue $outputBaseFilename))
$generated = $generated.Replace("__SOURCE_DIR__", (Escape-InnoValue (Resolve-Path $sourceDir).Path))
$generated = $generated.Replace("__ICON_FILE__", (Escape-InnoValue (Resolve-Path $iconPath).Path))
$generated = $generated.Replace("__SIGN_SETUP_LINES__", $signSection)

$generatedIssPath = Join-Path $env:RUNNER_TEMP "elizaos-app-$normalizedChannel-installer.iss"
Set-Content -Path $generatedIssPath -Value $generated -Encoding utf8

try {
  $isccTimeout = [TimeSpan]::FromMinutes(25)
  $isccHeartbeatInterval = [TimeSpan]::FromSeconds(30)
  $isccArguments = @("/Qp", $generatedIssPath)
  $isccArgumentDisplay = $isccArguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
  $isccStartedAt = Get-Date

  Write-Host "Starting ISCC.exe: $isccPath $($isccArgumentDisplay -join ' ')"

  $isccProcess = Start-Process -FilePath $isccPath -ArgumentList $isccArguments -PassThru -NoNewWindow

  while (-not $isccProcess.HasExited) {
    Start-Sleep -Milliseconds ([int]$isccHeartbeatInterval.TotalMilliseconds)
    $isccProcess.Refresh()
    if ($isccProcess.HasExited) {
      break
    }

    $elapsed = (Get-Date) - $isccStartedAt
    Write-Host "ISCC.exe still running after $([math]::Round($elapsed.TotalMinutes, 1)) minutes..."

    if ($elapsed -ge $isccTimeout) {
      try {
        Stop-Process -Id $isccProcess.Id -Force -ErrorAction Stop
      } catch {
        Write-Warning "Failed to terminate hung ISCC.exe process $($isccProcess.Id): $($_.Exception.Message)"
      }

      throw "ISCC.exe timed out after $([int]$isccTimeout.TotalMinutes) minutes while building the Windows installer."
    }
  }

  if ($isccProcess.ExitCode -ne 0) {
    throw "ISCC.exe failed with exit code $($isccProcess.ExitCode)"
  }

  $installerPath = Join-Path (Resolve-Path $OutputDir).Path "$outputBaseFilename.exe"
  if (-not (Test-Path $installerPath)) {
    throw "Expected Inno Setup output not found: $installerPath"
  }

  $installer = Get-Item $installerPath
  $minimumBytes = 50MB
  if ($installer.Length -lt $minimumBytes) {
    throw "Windows installer looks incomplete ($($installer.Length) bytes < $minimumBytes bytes). Refusing to publish a likely bootstrap stub."
  }

  Write-Host "Inno Setup installer created: $installerPath"
  Write-Host "Installer size: $([math]::Round($installer.Length / 1MB, 1)) MB"
} finally {
  Remove-Item $generatedIssPath -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:RUNNER_TEMP "elizaos-app-inno-signing-cert.pfx") -Force -ErrorAction SilentlyContinue
}
