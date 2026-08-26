param(
  [string]$ArtifactsDir = $(
    if ($env:ELIZA_TEST_WINDOWS_ARTIFACTS_DIR) { $env:ELIZA_TEST_WINDOWS_ARTIFACTS_DIR }
    elseif ($env:ELIZA_TEST_WINDOWS_ARTIFACTS_DIR) { $env:ELIZA_TEST_WINDOWS_ARTIFACTS_DIR }
    else { Join-Path $PSScriptRoot "..\\artifacts" }
  ),
  [string]$BuildDir = $(
    if ($env:ELIZA_TEST_WINDOWS_BUILD_DIR) { $env:ELIZA_TEST_WINDOWS_BUILD_DIR }
    elseif ($env:ELIZA_TEST_WINDOWS_BUILD_DIR) { $env:ELIZA_TEST_WINDOWS_BUILD_DIR }
    else { Join-Path $PSScriptRoot "..\\build" }
  ),
  [string]$ProofInstallDir = "C:\\mi-proof",
  [string]$OutputDir = (Join-Path $PSScriptRoot "..\\artifacts\\windows-installer-proof"),
  [int]$BackendPort = 2138,
  [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"

function Stop-ElizaProcesses() {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessName -in @("launcher", "bun") -or
      $_.ProcessName -like "Eliza*" -or
      $_.ProcessName -like "*-Setup*"
    } |
    Stop-Process -Force
}

function Resolve-ShortcutTarget([string]$ShortcutPath) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    return $shortcut.TargetPath
  } catch {
    return $null
  }
}

function Get-CurrentUserDefaultRegistryValue([string]$RegistryKey) {
  $subKey = $RegistryKey -replace '^HKCU\\', ''
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $false)
  if ($null -eq $key) { return $null }
  try {
    return $key.GetValue(
      $null,
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
  } finally {
    $key.Dispose()
  }
}

$resolvedArtifactsDir = (Resolve-Path $ArtifactsDir).Path
$resolvedBuildDir = $null
try {
  $resolvedBuildDir = (Resolve-Path $BuildDir).Path
} catch {
  $resolvedBuildDir = $null
}

$startupLog = Join-Path $env:APPDATA "Eliza\\eliza-startup.log"
$proofTimestamp = (Get-Date).ToString("o")
$summaryPath = Join-Path $OutputDir "proof-summary.json"
$summary = [ordered]@{
  timestamp = $proofTimestamp
  status = "failed"
  artifactsDir = $resolvedArtifactsDir
  buildDir = $resolvedBuildDir
  installDir = $ProofInstallDir
  installer = $null
  installerSizeBytes = 0
  launcherPath = $null
  browserNativeHostPath = $null
  browserRegistrationManifests = @()
  startMenuShortcut = $null
  shortcutTarget = $null
  uninstallerPath = $null
  checks = [ordered]@{
    installerExecuted = $false
    installRootExists = $false
    launcherExists = $false
    browserHelpersExist = $false
    browserRegistrationsInstalled = $false
    shortcutExists = $false
    backendReachable = $false
    uninstallExecuted = $false
    uninstallCleanup = $false
    browserRegistrationsRemoved = $false
  }
  notes = @()
}

Remove-Item $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

try {
  Stop-ElizaProcesses
  Remove-Item $ProofInstallDir -Recurse -Force -ErrorAction SilentlyContinue

  $installer = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "*-Setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $installer) {
    throw "No canonical installer found in $resolvedArtifactsDir (*-Setup-*.exe)."
  }

  $summary.installer = $installer.FullName
  $summary.installerSizeBytes = [int64]$installer.Length

  $env:ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER = "1"
  $env:ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER = "1"
  $env:ELIZA_TEST_WINDOWS_INSTALL_DIR = $ProofInstallDir
  $env:ELIZA_TEST_WINDOWS_LAUNCHER_DIR = Join-Path $env:RUNNER_TEMP "eliza-windows-proof-launcher"
  $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE = Join-Path $env:RUNNER_TEMP "eliza-windows-proof-launcher.txt"
  $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE = Join-Path $env:RUNNER_TEMP "eliza-windows-proof-launcher.txt"

  Remove-Item $env:ELIZA_TEST_WINDOWS_LAUNCHER_DIR -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE -Force -ErrorAction SilentlyContinue
  Remove-Item $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE -Force -ErrorAction SilentlyContinue

  pwsh -File (Join-Path $PSScriptRoot "smoke-test-windows.ps1") `
    -ArtifactsDir $resolvedArtifactsDir `
    -BuildDir $BuildDir `
    -BackendPort $BackendPort `
    -TimeoutSeconds $TimeoutSeconds

  $summary.checks.installerExecuted = $true
  $summary.checks.backendReachable = $true

  if (-not (Test-Path $ProofInstallDir)) {
    throw "Install root was not created: $ProofInstallDir"
  }
  $summary.checks.installRootExists = $true

  $launcher = Get-ChildItem -Path $ProofInstallDir -Recurse -File -Filter "launcher.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
  if (-not $launcher) {
    throw "Installed launcher.exe not found under $ProofInstallDir"
  }
  $summary.launcherPath = $launcher.FullName
  $summary.checks.launcherExists = $true

  $nativeHost = Get-ChildItem -Path $ProofInstallDir -Recurse -File -Filter "browser-bridge-native-host.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
  $secretHelper = Get-ChildItem -Path $ProofInstallDir -Recurse -File -Filter "browser-bridge-secret.ps1" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
  $unregisterHelper = Get-ChildItem -Path $ProofInstallDir -Recurse -File -Filter "browser-bridge-unregister.ps1" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
  if (-not $nativeHost -or -not $secretHelper -or -not $unregisterHelper) {
    throw "Installed browser bridge host or Windows lifecycle helper is missing"
  }
  $summary.browserNativeHostPath = $nativeHost.FullName
  $summary.checks.browserHelpersExist = $true

  $browserRegistrations = @(
    @{
      RegistryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\ai.elizaos.browserbridge"
      ManifestPath = Join-Path $env:LOCALAPPDATA "elizaOS\BrowserBridge\chrome\ai.elizaos.browserbridge.json"
    },
    @{
      RegistryKey = "HKCU\Software\Mozilla\NativeMessagingHosts\ai.elizaos.browserbridge"
      ManifestPath = Join-Path $env:LOCALAPPDATA "elizaOS\BrowserBridge\firefox\ai.elizaos.browserbridge.json"
    }
  )
  foreach ($registration in $browserRegistrations) {
    $registeredManifestPath = Get-CurrentUserDefaultRegistryValue $registration.RegistryKey
    if (
      $null -eq $registeredManifestPath -or
      -not [System.String]::Equals(
        [System.IO.Path]::GetFullPath([string]$registeredManifestPath),
        [System.IO.Path]::GetFullPath($registration.ManifestPath),
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      -not (Test-Path -LiteralPath $registration.ManifestPath)
    ) {
      throw "Browser native-host registration was not installed: $($registration.RegistryKey)"
    }
    $manifest = Get-Content -LiteralPath $registration.ManifestPath -Raw | ConvertFrom-Json
    if (-not [System.String]::Equals(
      [System.IO.Path]::GetFullPath([string]$manifest.path),
      [System.IO.Path]::GetFullPath($nativeHost.FullName),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Browser native-host manifest points at the wrong executable: $($registration.ManifestPath)"
    }
    $summary.browserRegistrationManifests += $registration.ManifestPath
  }
  $summary.checks.browserRegistrationsInstalled = $true

  $startMenuRoots = @(
    (Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"),
    (Join-Path $env:ProgramData "Microsoft\\Windows\\Start Menu\\Programs")
  )
  $shortcut = $null
  foreach ($root in $startMenuRoots) {
    if (-not (Test-Path $root)) {
      continue
    }

    $candidate = Get-ChildItem -Path $root -Recurse -File -Filter "*.lnk" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "Eliza|Eliza" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($candidate) {
      $shortcut = $candidate
      break
    }
  }

  if (-not $shortcut) {
    throw "Start Menu shortcut containing 'Eliza' or 'Eliza' was not found."
  }

  $summary.startMenuShortcut = $shortcut.FullName
  $summary.checks.shortcutExists = $true

  $shortcutTarget = Resolve-ShortcutTarget -ShortcutPath $shortcut.FullName
  if ($shortcutTarget) {
    $summary.shortcutTarget = $shortcutTarget
  }

  $uninstaller = Get-ChildItem -Path $ProofInstallDir -Recurse -File -Filter "unins*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $uninstaller) {
    throw "Uninstaller executable was not found under $ProofInstallDir"
  }
  $summary.uninstallerPath = $uninstaller.FullName

  Stop-ElizaProcesses

  $uninstallArgs = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART"
  )
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList $uninstallArgs -WorkingDirectory (Split-Path -Parent $uninstaller.FullName) -PassThru -Wait
  if ($uninstallProcess.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstallProcess.ExitCode)"
  }

  $summary.checks.uninstallExecuted = $true

  $launcherStillExists = $summary.launcherPath -and (Test-Path $summary.launcherPath)
  if ($launcherStillExists) {
    throw "Uninstall cleanup failed: launcher still exists at $($summary.launcherPath)"
  }

  $summary.checks.uninstallCleanup = $true

  foreach ($registration in $browserRegistrations) {
    & reg.exe query $registration.RegistryKey /ve 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $registration.ManifestPath)) {
      throw "Uninstall left a browser native-host registration behind: $($registration.RegistryKey)"
    }
  }
  $summary.checks.browserRegistrationsRemoved = $true
  $summary.status = "passed"
  $summary.notes += "Windows clean installer proof completed successfully."
} catch {
  $summary.notes += "Proof failed: $($_.Exception.Message)"
  throw
} finally {
  if (Test-Path $startupLog) {
    Copy-Item $startupLog -Destination (Join-Path $OutputDir "eliza-startup.log") -Force -ErrorAction SilentlyContinue
  }

  $summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding utf8
  Stop-ElizaProcesses
}
