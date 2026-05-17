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
      $_.ProcessName -like "ElizaOSApp-Setup*"
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
  startMenuShortcut = $null
  shortcutTarget = $null
  uninstallerPath = $null
  checks = [ordered]@{
    installerExecuted = $false
    installRootExists = $false
    launcherExists = $false
    shortcutExists = $false
    backendReachable = $false
    uninstallExecuted = $false
    uninstallCleanup = $false
  }
  notes = @()
}

Remove-Item $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

try {
  Stop-ElizaProcesses
  Remove-Item $ProofInstallDir -Recurse -Force -ErrorAction SilentlyContinue

  $installer = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "ElizaOSApp-Setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $installer) {
    $installer = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "Eliza-Setup-*.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }
  if (-not $installer) {
    throw "No canonical installer found in $resolvedArtifactsDir (ElizaOSApp-Setup-*.exe / Eliza-Setup-*.exe)."
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
