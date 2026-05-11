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
  [int]$BackendPort = 2138,
  [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"

$resolvedArtifactsDir = (Resolve-Path $ArtifactsDir).Path
$resolvedBuildDir = $null
try {
  $resolvedBuildDir = (Resolve-Path $BuildDir).Path
} catch {
  $resolvedBuildDir = $null
}
$tempRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$testAppDataRoot = if ($env:ELIZA_TEST_WINDOWS_APPDATA_PATH) {
  $env:ELIZA_TEST_WINDOWS_APPDATA_PATH
} else {
  Join-Path $tempRoot ("eliza-windows-appdata-" + [Guid]::NewGuid().ToString("N"))
}
$testLocalAppDataRoot = if ($env:ELIZA_TEST_WINDOWS_LOCALAPPDATA_PATH) {
  $env:ELIZA_TEST_WINDOWS_LOCALAPPDATA_PATH
} else {
  Join-Path $tempRoot ("eliza-windows-localappdata-" + [Guid]::NewGuid().ToString("N"))
}
$env:APPDATA = $testAppDataRoot
$env:LOCALAPPDATA = $testLocalAppDataRoot
$env:ELIZA_DESKTOP_TEST_PARTITION = "persist:bootstrap-isolated"
New-Item -ItemType Directory -Force -Path $env:APPDATA | Out-Null
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null
# Pre-create PGlite data directory with a short path to avoid MAX_PATH issues
# during WASM init. PGlite creates deeply nested WAL files; a short root path
# keeps the full path under the 260-char limit on Windows runners. The 8-char
# suffix keeps parallel jobs on a shared runner from colliding without eating
# the MAX_PATH headroom a full GUID would.
$pgliteDataDir = Join-Path $tempRoot ("pglite-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $pgliteDataDir | Out-Null
$env:PGLITE_DATA_DIR = $pgliteDataDir
if ($env:GITHUB_ENV) {
  Add-Content -Path $env:GITHUB_ENV -Value "MILADY_TEST_WINDOWS_APPDATA_PATH=$($env:APPDATA)"
  Add-Content -Path $env:GITHUB_ENV -Value "MILADY_TEST_WINDOWS_LOCALAPPDATA_PATH=$($env:LOCALAPPDATA)"
  Add-Content -Path $env:GITHUB_ENV -Value "ELIZA_TEST_WINDOWS_APPDATA_PATH=$($env:APPDATA)"
  Add-Content -Path $env:GITHUB_ENV -Value "ELIZA_TEST_WINDOWS_LOCALAPPDATA_PATH=$($env:LOCALAPPDATA)"
  Add-Content -Path $env:GITHUB_ENV -Value "PGLITE_DATA_DIR=$pgliteDataDir"
}
# Packaged builds can still use the default elizaOS brand config before Milady
# overrides are loaded, so include all known startup log locations.
$legacyStartupLog = Join-Path $env:APPDATA "Eliza\\eliza-startup.log"
$defaultStartupLog = Join-Path $env:APPDATA "elizaOS\\eliza-startup.log"
$miladyStartupLog = Join-Path $env:APPDATA "Milady\\eliza-startup.log"
$startupLog = Join-Path $env:APPDATA "Milady\\milady-startup.log"
$startupLogs = @($startupLog, $miladyStartupLog, $defaultStartupLog, $legacyStartupLog) | Select-Object -Unique
$defaultAvatarAssetSlugs = @("eliza-1", "milady-1")
$selfExtractionRoot = Join-Path $env:LOCALAPPDATA "com.elizaai.eliza"
$tempExtractDir = Join-Path $tempRoot ("eliza-windows-smoke-" + [Guid]::NewGuid().ToString("N"))
$persistLauncherDir = $env:ELIZA_TEST_WINDOWS_LAUNCHER_DIR
$persistLauncherPathFile = $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE
if ([string]::IsNullOrWhiteSpace($persistLauncherPathFile)) {
  $persistLauncherPathFile = $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE
}
$startupSessionId = "eliza-windows-smoke-" + [Guid]::NewGuid().ToString("N")
$startupStateFile = Join-Path $tempRoot ($startupSessionId + ".state.json")
$startupEventsFile = Join-Path $tempRoot ($startupSessionId + ".events.jsonl")
$startupBootstrapFile = $null
$stopProtectedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$stopProtectedProcessIds.Add([int]$PID)
try {
  $currentPid = $PID
  while ($currentPid -gt 0) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid"
    if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -eq $currentPid) { break }
    [void]$stopProtectedProcessIds.Add([int]$proc.ParentProcessId)
    $currentPid = $proc.ParentProcessId
  }
} catch {
  # Best effort only; on failure we still protect the current PowerShell host.
}

function Find-Launcher([string]$Root) {
  if (-not (Test-Path $Root)) {
    return $null
  }

  return Get-ChildItem -Path $Root -Recurse -File -Filter "launcher.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
}

function Expand-PackagedTarball([string]$ArchivePath, [string]$DestinationPath) {
  $tarCommand = if (Test-Path "C:\\Windows\\System32\\tar.exe") {
    "C:\\Windows\\System32\\tar.exe"
  } else {
    "tar"
  }

  New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
  & $tarCommand -xf $ArchivePath -C $DestinationPath
}

function Write-ReusableLauncherPath([System.IO.FileInfo]$Launcher, [string]$TemporaryRoot) {
  if (-not $Launcher -or [string]::IsNullOrWhiteSpace($persistLauncherPathFile)) {
    return $Launcher
  }

  $launcherPath = $Launcher.FullName
  if (
    -not [string]::IsNullOrWhiteSpace($TemporaryRoot) -and
    $launcherPath.StartsWith($TemporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    $stageDir = if ([string]::IsNullOrWhiteSpace($persistLauncherDir)) {
      Join-Path $tempRoot "eliza-windows-ui-launcher"
    } else {
      $persistLauncherDir
    }

    $appRoot = Split-Path -Parent (Split-Path -Parent $launcherPath)
    Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Copy-Item -Path (Join-Path $appRoot "*") -Destination $stageDir -Recurse -Force
    $launcherPath = Join-Path $stageDir "bin\\launcher.exe"
  }

  $pathFileParent = Split-Path -Parent $persistLauncherPathFile
  if ($pathFileParent) {
    New-Item -ItemType Directory -Force -Path $pathFileParent | Out-Null
  }
  Set-Content -Path $persistLauncherPathFile -Value $launcherPath -Encoding utf8
  return Get-Item $launcherPath
}

function Stop-ElizaProcesses() {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      -not $stopProtectedProcessIds.Contains([int]$_.Id) -and
      (
        $_.ProcessName -in @("launcher", "bun") -or
        $_.ProcessName -like "Eliza*" -or
        $_.ProcessName -like "ElizaOSApp-Setup*"
      )
    } |
    Stop-Process -Force
}

function Get-TarCommand() {
  if (Test-Path "C:\\Windows\\System32\\tar.exe") {
    return "C:\\Windows\\System32\\tar.exe"
  }
  return "tar"
}

function Test-LoopbackPortAvailable([int]$Port) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) {
      try {
        $listener.Stop()
      } catch {}
    }
  }
}

function Resolve-BackendPort([int]$PreferredPort) {
  if (Test-LoopbackPortAvailable $PreferredPort) {
    return $PreferredPort
  }

  Write-Warning "Preferred backend port $PreferredPort is unavailable. Falling back to an ephemeral loopback port."
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Assert-PackagedAssetVariants(
  [string]$Description,
  [int]$MinSizeBytes,
  [string[]]$Candidates
) {
  foreach ($candidate in $Candidates) {
    if (-not (Test-Path $candidate)) {
      continue
    }
    $length = (Get-Item $candidate).Length
    if ($length -ge $MinSizeBytes) {
      return
    }
  }

  throw "Missing packaged $Description. Checked: $($Candidates -join ', ')"
}

function Assert-PackagedArchiveAssetVariants(
  [string]$ArchivePath,
  [string]$Description,
  [int]$MinSizeBytes,
  [string[]]$Suffixes
) {
  $tarCommand = Get-TarCommand
  $archiveList = & $tarCommand -tf $ArchivePath 2>$null

  foreach ($suffix in $Suffixes) {
    $normalizedSuffix = $suffix.Replace("\", "/")
    $member = $archiveList |
      Where-Object { ($_ -replace "\\", "/") -like "*$normalizedSuffix" } |
      Select-Object -First 1

    if (-not $member) {
      continue
    }

    $extractDir = Join-Path $tempRoot ("eliza-archive-asset-check-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    try {
      & $tarCommand -xf $ArchivePath -C $extractDir $member 2>$null | Out-Null
      $memberPath = Join-Path $extractDir ($member -replace "/", "\")
      if (-not (Test-Path $memberPath)) {
        continue
      }
      $length = (Get-Item $memberPath).Length
      if ($length -ge $MinSizeBytes) {
        return
      }
    } finally {
      Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  throw "Missing packaged $Description in runtime archive. Checked suffixes: $($Suffixes -join ', ')"
}

function Verify-PackagedRendererAssets([string]$LauncherPath) {
  $launcherDir = Split-Path -Parent $LauncherPath
  $appRoot = Split-Path -Parent $launcherDir
  $rendererDir = Join-Path $appRoot "resources\\app\\renderer"
  $defaultAvatarVrmCandidates = @()
  $defaultAvatarPreviewCandidates = @()
  $defaultAvatarBackgroundCandidates = @()
  foreach ($slug in $defaultAvatarAssetSlugs) {
    $defaultAvatarVrmCandidates += @(
      (Join-Path $rendererDir "vrms\\$slug.vrm.gz"),
      (Join-Path $rendererDir "vrms\\$slug.vrm")
    )
    $defaultAvatarPreviewCandidates += (Join-Path $rendererDir "vrms\\previews\\$slug.png")
    $defaultAvatarBackgroundCandidates += (Join-Path $rendererDir "vrms\\backgrounds\\$slug.png")
  }

  if (Test-Path $rendererDir) {
    Assert-PackagedAssetVariants -Description "renderer entrypoint" -MinSizeBytes 256 -Candidates @(
      (Join-Path $rendererDir "index.html")
    )
    Assert-PackagedAssetVariants -Description "default avatar VRM" -MinSizeBytes 1024 -Candidates $defaultAvatarVrmCandidates
    Assert-PackagedAssetVariants -Description "default avatar preview" -MinSizeBytes 1024 -Candidates $defaultAvatarPreviewCandidates
    Assert-PackagedAssetVariants -Description "default avatar background" -MinSizeBytes 1024 -Candidates $defaultAvatarBackgroundCandidates
    Write-Host "Packaged renderer asset check PASSED (direct app bundle)."
    return
  }

  $resourcesDir = Join-Path $appRoot "resources"
  $runtimeArchive = Get-ChildItem -Path $resourcesDir -File -Filter "*.tar.zst" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $runtimeArchive) {
    throw "Packaged renderer directory missing and no runtime archive found under $resourcesDir"
  }

  Assert-PackagedArchiveAssetVariants -ArchivePath $runtimeArchive.FullName -Description "renderer entrypoint" -MinSizeBytes 256 -Suffixes @(
    "renderer/index.html"
  )
  $archiveAvatarVrmSuffixes = @()
  $archiveAvatarPreviewSuffixes = @()
  $archiveAvatarBackgroundSuffixes = @()
  foreach ($slug in $defaultAvatarAssetSlugs) {
    $archiveAvatarVrmSuffixes += @(
      "renderer/vrms/$slug.vrm.gz",
      "renderer/vrms/$slug.vrm"
    )
    $archiveAvatarPreviewSuffixes += "renderer/vrms/previews/$slug.png"
    $archiveAvatarBackgroundSuffixes += "renderer/vrms/backgrounds/$slug.png"
  }
  Assert-PackagedArchiveAssetVariants -ArchivePath $runtimeArchive.FullName -Description "default avatar VRM" -MinSizeBytes 1024 -Suffixes $archiveAvatarVrmSuffixes
  Assert-PackagedArchiveAssetVariants -ArchivePath $runtimeArchive.FullName -Description "default avatar preview" -MinSizeBytes 1024 -Suffixes $archiveAvatarPreviewSuffixes
  Assert-PackagedArchiveAssetVariants -ArchivePath $runtimeArchive.FullName -Description "default avatar background" -MinSizeBytes 1024 -Suffixes $archiveAvatarBackgroundSuffixes
  Write-Host "Packaged renderer asset check PASSED (runtime archive)."
}

function Get-ObservedBackendPorts([int]$DefaultPort) {
  $ports = [System.Collections.Generic.List[int]]::new()
  $ports.Add($DefaultPort)

  if (-not (Test-Path $startupStateFile)) {
    return $ports.ToArray()
  }

  try {
    $state = Get-Content $startupStateFile -Raw -ErrorAction Stop | ConvertFrom-Json
    # ConvertFrom-Json can hydrate numeric fields as Int64 on Windows runners.
    $observedPort = 0
    if (
      [int]::TryParse([string]$state.port, [ref]$observedPort) -and
      $observedPort -gt 0 -and
      $observedPort -le 65535 -and
      -not $ports.Contains($observedPort)
    ) {
      $ports.Add($observedPort)
    }
  } catch {
    return $ports.ToArray()
  }

  return $ports.ToArray()
}

function Get-StartupState() {
  if (-not (Test-Path $startupStateFile)) {
    return $null
  }

  try {
    $state = Get-Content $startupStateFile -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($state.session_id -ne $startupSessionId) {
      return $null
    }
    return $state
  } catch {
    return $null
  }
}

function Write-StartupBootstrap() {
  if ([string]::IsNullOrWhiteSpace($startupBootstrapFile)) {
    throw "Startup bootstrap file path was not initialized."
  }
  $bootstrapDir = Split-Path -Parent $startupBootstrapFile
  if ($bootstrapDir) {
    New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
  }

  $bootstrap = @{
    session_id = $startupSessionId
    state_file = $startupStateFile
    events_file = $startupEventsFile
    expires_at = (Get-Date).ToUniversalTime().AddMinutes(15).ToString("o")
  } | ConvertTo-Json

  $tempBootstrapFile = $startupBootstrapFile + ".tmp"
  Set-Content -Path $tempBootstrapFile -Value ($bootstrap + "`n") -Encoding utf8
  Move-Item -Path $tempBootstrapFile -Destination $startupBootstrapFile -Force
}

Write-Host "Artifacts dir: $resolvedArtifactsDir"
if ($resolvedBuildDir) {
  Write-Host "Build dir: $resolvedBuildDir"
}
Write-Host "Smoke APPDATA: $($env:APPDATA)"
Write-Host "Smoke LOCALAPPDATA: $($env:LOCALAPPDATA)"

Stop-ElizaProcesses
$env:ELECTROBUN_CONSOLE = "1"
$env:ELIZA_FORCE_AUTOSTART_AGENT = "1"
$env:ELIZA_STARTUP_SESSION_ID = $startupSessionId
$env:MILADY_STARTUP_SESSION_ID = $startupSessionId
$env:ELIZA_STARTUP_STATE_FILE = $startupStateFile
$env:ELIZA_STARTUP_EVENTS_FILE = $startupEventsFile
$env:MILADY_STARTUP_STATE_FILE = $startupStateFile
$env:MILADY_STARTUP_EVENTS_FILE = $startupEventsFile
$BackendPort = Resolve-BackendPort $BackendPort
$env:ELIZA_API_PORT = "$BackendPort"
$env:ELIZA_API_PORT = "$BackendPort"
$env:ELIZA_PORT = "$BackendPort"
Write-Host "Smoke backend port: $BackendPort"
if ($env:GITHUB_ENV) {
  Add-Content -Path $env:GITHUB_ENV -Value "ELIZA_TEST_WINDOWS_BACKEND_PORT=$BackendPort"
}

# Reset stale startup logs before launch so fatal classification only applies
# to this run.
foreach ($candidateLog in $startupLogs) {
  if (Test-Path $candidateLog) {
    Remove-Item $candidateLog -Force -ErrorAction SilentlyContinue
    Write-Host "Cleared stale startup log: $candidateLog"
  }
}

if (Test-Path $selfExtractionRoot) {
  Remove-Item $selfExtractionRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$launcher = Find-Launcher $resolvedArtifactsDir
$launcherSource = $null
$packagedTarball = $null
$installer = $null
$installerProcess = $null
$launcherProcess = $null
$launcherStarted = $false
$requireInstaller = $env:ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER -eq "1"
if (-not $requireInstaller) {
  $requireInstaller = $env:ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER -eq "1"
}
$installerRoot = if ($env:MILADY_TEST_WINDOWS_INSTALL_DIR) {
  $env:MILADY_TEST_WINDOWS_INSTALL_DIR
} elseif ($env:ELIZA_TEST_WINDOWS_INSTALL_DIR) {
  # The release workflow exports ELIZA_TEST_WINDOWS_INSTALL_DIR for legacy
  # contract compatibility; accept either prefix so a short, MAX_PATH-safe
  # install dir actually flows through to the Inno /DIR override on CI.
  $env:ELIZA_TEST_WINDOWS_INSTALL_DIR
} else {
  Join-Path $tempRoot ("milady-installed-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
}
if ($requireInstaller) {
  $launcher = $null
  $launcherSource = $null
}

if (-not $requireInstaller -and $resolvedBuildDir) {
  $launcher = Find-Launcher $resolvedBuildDir
  if ($launcher) {
    $launcherSource = "build"
  }
}

if (-not $requireInstaller -and -not $launcher) {
  $launcher = Find-Launcher $resolvedArtifactsDir
  if ($launcher) {
    $launcherSource = "artifacts"
  }
}

if (-not $requireInstaller -and -not $launcher) {
  $packagedTarball = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "*.tar.zst" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($packagedTarball) {
    Write-Host "Using packaged tarball: $($packagedTarball.FullName)"
    try {
      Expand-PackagedTarball -ArchivePath $packagedTarball.FullName -DestinationPath $tempExtractDir
      $launcher = Find-Launcher $tempExtractDir
      if (-not $launcher) {
        Write-Warning "Packaged tarball extracted but no launcher.exe was found. Falling back to installer path."
      } else {
        $launcherSource = "packaged tarball"
      }
    } catch {
      Write-Warning "Failed to extract packaged tarball: $($_.Exception.Message)"
      Write-Warning "Falling back to installer path."
    }
  }
}

# Installer-required runs skip build/tarball reuse and validate the installed package directly.
if (-not $launcher) {
  $installer = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "ElizaOSApp-Setup-*.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if (-not $installer) {
    $installer = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "*Setup*.exe" -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }

  if (-not $installer) {
    $installerZip = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "ElizaOSApp-Setup-*.exe.zip" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $installerZip) {
      $installerZip = Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "*Setup*.zip" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    }
    if (-not $installerZip) {
      throw "No launcher.exe, packaged .tar.zst, installer .exe, or installer .zip found under $resolvedArtifactsDir"
    }

    New-Item -ItemType Directory -Force -Path $tempExtractDir | Out-Null
    Expand-Archive -Path $installerZip.FullName -DestinationPath $tempExtractDir -Force
    $installer = Get-ChildItem -Path $tempExtractDir -Recurse -File -Filter "*Setup*.exe" -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }

  if (-not $installer) {
    throw "No installer executable found for Windows smoke test."
  }

  Write-Host "Installing via Inno Setup: $($installer.FullName)"
  Write-Host "Installer size: $([math]::Round($installer.Length / 1MB, 1)) MB"
  Write-Host "Install target: $installerRoot"
  # Log disk space before install — the installer extracts ~1.5GB of files.
  Get-Volume | Where-Object { $_.DriveLetter } | Format-Table DriveLetter, @{N='FreeGB';E={[math]::Round($_.SizeRemaining/1GB,1)}}, @{N='TotalGB';E={[math]::Round($_.Size/1GB,1)}}
  Remove-Item $installerRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $installerRoot | Out-Null

  $installerLogPath = Join-Path $tempRoot "eliza-inno-setup.log"
  $installerArgs = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/SP-",
    "/DIR=$installerRoot",
    "/LOG=$installerLogPath"
  )

  # Attempt 1: direct Start-Process invocation
  $installerProcess = Start-Process -FilePath $installer.FullName -ArgumentList $installerArgs -WorkingDirectory (Split-Path -Parent $installer.FullName) -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) {
    Write-Host "Inno Setup installer attempt 1 exited with code $($installerProcess.ExitCode)."
    if (Test-Path $installerLogPath) {
      Write-Host "--- Inno Setup log (attempt 1) ---"
      Get-Content $installerLogPath | ForEach-Object { Write-Host $_ }
      Write-Host "--- end Inno Setup log ---"
    }

    # On Windows Server 2025 headless runners, Inno Setup can return bogus
    # exit codes (5, -1) even when the install actually succeeded. Check if
    # launcher.exe exists before wiping and retrying.
    $attempt1Launcher = Find-Launcher $installerRoot
    if ($attempt1Launcher) {
      Write-Host "Installer reported failure but launcher.exe exists at $attempt1Launcher — treating as success (headless runner quirk)."
    } else {
      # Attempt 2: retry via cmd /c — workaround for Windows Server 2025 headless
      # runners where Start-Process cannot allocate a console subsystem for the
      # Inno Setup decompressor.
      Write-Host "Retrying installer via cmd /c (headless fallback)..."
      Remove-Item $installerRoot -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $installerRoot | Out-Null
      Remove-Item $installerLogPath -Force -ErrorAction SilentlyContinue

      $cmdArgs = @($installerArgs | ForEach-Object { "`"$_`"" }) -join " "
      $cmdLine = "`"$($installer.FullName)`" $cmdArgs"
      $cmdProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -WorkingDirectory (Split-Path -Parent $installer.FullName) -PassThru -Wait

      $attempt2Launcher = Find-Launcher $installerRoot
      if ($attempt2Launcher) {
        Write-Host "cmd /c attempt reported exit code $($cmdProcess.ExitCode) but launcher.exe exists — treating as success."
      } elseif ($cmdProcess.ExitCode -ne 0) {
        Write-Host "Inno Setup installer attempt 2 (cmd /c) failed with exit code $($cmdProcess.ExitCode)."
        if (Test-Path $installerLogPath) {
          Write-Host "--- Inno Setup log (attempt 2) ---"
          Get-Content $installerLogPath | ForEach-Object { Write-Host $_ }
          Write-Host "--- end Inno Setup log ---"
        } else {
          Write-Host "Inno Setup log not found at $installerLogPath"
        }
        throw "Windows installer exited with code $($cmdProcess.ExitCode) (both direct and cmd /c attempts failed)"
      }
    }
  }

  $launcher = Find-Launcher $installerRoot
  if (-not $launcher) {
    throw "Installed launcher.exe not found under $installerRoot"
  }

  $launcherSource = "installed Inno package"
}

$launcher = Write-ReusableLauncherPath -Launcher $launcher -TemporaryRoot $tempExtractDir
Write-Host "Using $launcherSource launcher: $($launcher.FullName)"
Verify-PackagedRendererAssets -LauncherPath $launcher.FullName
$launcherDir = Split-Path -Parent $launcher.FullName
$startupBundleRoot = Split-Path -Parent $launcherDir
$startupBootstrapFile = Join-Path $startupBundleRoot "startup-session.json"
Remove-Item $startupStateFile -Force -ErrorAction SilentlyContinue
Remove-Item $startupEventsFile -Force -ErrorAction SilentlyContinue
Remove-Item $startupBootstrapFile -Force -ErrorAction SilentlyContinue
Write-StartupBootstrap
# Propagate PGlite data dir and disable local embeddings in the launcher env.
# The launcher spawns agent.ts which spawns the runtime child process; these
# env vars must be set in the outermost process for correct propagation.
$env:ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1"
$launcherProcess = Start-Process -FilePath $launcher.FullName -WorkingDirectory $launcherDir -PassThru
$launcherStarted = $true

# Bypass proxy for loopback — WinHTTP (used by Invoke-WebRequest) respects
# system proxy settings on GitHub Actions runners, causing 127.0.0.1 requests
# to route through a non-existent proxy and timeout.
$env:NO_PROXY = "127.0.0.1,localhost"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false
$healthCheckMethod = $null
$lastNetstatDump = [DateTime]::MinValue

function Dump-PortDiagnostics([int]$Port) {
  Write-Host "--- netstat for port $Port ---"
  try {
    netstat -ano | Select-String ":$Port " | ForEach-Object { Write-Host $_ }
  } catch {
    Write-Host "(netstat failed: $($_.Exception.Message))"
  }
  Write-Host "--- end netstat ---"
}

function Test-BackendProbeStatus([int]$StatusCode) {
  # A 401 still proves the packaged backend is running and enforcing auth.
  return $StatusCode -eq 200 -or $StatusCode -eq 401
}

function Dump-ProcessDiagnostics() {
  Write-Host "--- Bun/launcher processes ---"
  try {
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessName -in @("launcher", "bun") -or
        $_.ProcessName -like "Eliza*"
      } |
      Format-Table -Property Id, ProcessName, StartTime, Responding -AutoSize |
      Out-String |
      Write-Host
  } catch {
    Write-Host "(process list failed: $($_.Exception.Message))"
  }
  Write-Host "--- end processes ---"
}

function Dump-FailureDiagnostics([int]$Port) {
  $startupState = Get-StartupState
  Write-Host ""
  Write-Host "========== FAILURE DIAGNOSTICS =========="

  # 1. Port binding state
  Write-Host ""
  Write-Host "[1/6] Port $Port binding state:"
  Dump-PortDiagnostics $Port

  # 2. All listening TCP ports (find if server bound elsewhere)
  Write-Host ""
  Write-Host "[2/6] All LISTENING TCP ports:"
  try {
    netstat -ano -p TCP | Select-String "LISTENING" | ForEach-Object { Write-Host $_ }
  } catch {
    Write-Host "(netstat LISTENING failed)"
  }

  # 3. Process tree
  Write-Host ""
  Write-Host "[3/6] Process tree:"
  Dump-ProcessDiagnostics

  # 4. Session-scoped startup trace
  Write-Host ""
  Write-Host "[4/6] Startup trace state:"
  Write-Host "  Session id: $startupSessionId"
  Write-Host "  State file: $startupStateFile"
  Write-Host "  Events file: $startupEventsFile"
  Write-Host "  Bootstrap file: $startupBootstrapFile"
  if ($startupState) {
    $startupState | ConvertTo-Json -Depth 6 | Write-Host
  } else {
    Write-Host "(startup state file not found)"
  }
  Write-Host ""
  Write-Host "[4a/6] Startup trace bootstrap:"
  if (Test-Path $startupBootstrapFile) {
    Get-Content $startupBootstrapFile -Raw -ErrorAction SilentlyContinue | Write-Host
  } else {
    Write-Host "(startup bootstrap file not found)"
  }
  Write-Host ""
  Write-Host "[4b/6] Startup trace events:"
  if (Test-Path $startupEventsFile) {
    Get-Content $startupEventsFile -Tail 200 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "(startup events file not found)"
  }

  Write-Host ""
  Write-Host "[4c/6] Startup logs:"
  foreach ($candidateLog in $startupLogs) {
    Write-Host "--- $candidateLog ---"
    if (Test-Path $candidateLog) {
      Get-Content $candidateLog -Tail 400 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    } else {
      Write-Host "(startup log not found)"
    }
    Write-Host "--- end $candidateLog ---"
  }

  # 5. Firewall state for port
  Write-Host ""
  Write-Host "[5/6] Firewall rules mentioning port $Port or Bun/Eliza:"
  try {
    netsh advfirewall firewall show rule name=all dir=in |
      Select-String -Pattern "($Port|bun|eliza|launcher)" -Context 2 |
      ForEach-Object { Write-Host $_ }
  } catch {
    Write-Host "(firewall query failed: $($_.Exception.Message))"
  }

  # 6. Relevant environment variables
  Write-Host ""
  Write-Host "[6/7] Relevant environment variables:"
  foreach ($varName in @(
    "ELIZA_PORT", "ELIZA_API_BIND", "ELIZA_API_PORT",
    "ELIZA_DISABLE_LOCAL_EMBEDDINGS", "ANTHROPIC_API_KEY",
    "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY",
    "ELECTROBUN_CONSOLE", "APPDATA", "LOCALAPPDATA",
    "ELIZA_TEST_WINDOWS_APPDATA_PATH", "ELIZA_TEST_WINDOWS_LOCALAPPDATA_PATH",
    "ELIZA_DESKTOP_TEST_PARTITION", "ELIZA_API_PORT", "ELIZA_PORT"
  )) {
    $val = [System.Environment]::GetEnvironmentVariable($varName)
    if ($varName -eq "ANTHROPIC_API_KEY" -and $val) {
      $val = "$($val.Substring(0, [Math]::Min(8, $val.Length)))..."
    }
    Write-Host "  ${varName}=$($val ?? '<unset>')"
  }

  Write-Host ""
  Write-Host "[7/7] Windows CEF profile state:"
  $cefRoot = Join-Path $env:APPDATA "Eliza\\CEF"
  $cefMarker = Join-Path $cefRoot ".eliza-version"
  Write-Host "  CEF root: $cefRoot"
  Write-Host "  Marker: $cefMarker"
  Write-Host "  Root exists: $(Test-Path $cefRoot)"
  if (Test-Path $cefMarker) {
    Write-Host "  Marker contents: $(Get-Content $cefMarker -Raw -ErrorAction SilentlyContinue)"
  } else {
    Write-Host "  Marker contents: <missing>"
  }

  Write-Host "========== END DIAGNOSTICS =========="
  Write-Host ""
}

try {
  while ((Get-Date) -lt $deadline) {
    $startupState = Get-StartupState

    if (-not $launcher) {
      $launcher = Find-Launcher $selfExtractionRoot
      if ($launcher) {
        $launcher = Write-ReusableLauncherPath -Launcher $launcher -TemporaryRoot $null
        Write-Host "Found extracted launcher: $($launcher.FullName)"
      }
    }

    if (
      $launcher -and
      -not (Get-Process -Name "launcher" -ErrorAction SilentlyContinue) -and
      (
        -not $launcherStarted -or
        ($launcherProcess -and $launcherProcess.HasExited)
      )
    ) {
      $launcherDir = Split-Path -Parent $launcher.FullName
      $launcherProcess = Start-Process -FilePath $launcher.FullName -WorkingDirectory $launcherDir -PassThru
      $launcherStarted = $true
      Write-Host "Started extracted launcher: $($launcher.FullName)"
    }

    if ($startupState -and $startupState.phase -eq "fatal") {
      Write-Host "Startup trace entered fatal phase:"
      $startupState | ConvertTo-Json -Depth 6 | Write-Host
      Dump-FailureDiagnostics $BackendPort
      throw "Windows packaged app reported a fatal startup phase."
    }

    # Periodic diagnostics: dump netstat + process list every 60s during the wait
    $now = Get-Date
    if (($now - $lastNetstatDump).TotalSeconds -ge 60) {
      $elapsed = [int](($now) - $deadline.AddSeconds(-$TimeoutSeconds)).TotalSeconds
      Write-Host "--- periodic diagnostics at ${elapsed}s ---"
      Dump-PortDiagnostics $BackendPort
      Dump-ProcessDiagnostics
      $lastNetstatDump = $now
    }

    foreach ($port in Get-ObservedBackendPorts $BackendPort) {
      $uri = "http://127.0.0.1:${port}/api/health"

      # Method 1: .NET HttpClient with proxy explicitly disabled.
      # Invoke-WebRequest uses WinHTTP which honours system proxy settings;
      # on GitHub Actions runners this can route 127.0.0.1 through a
      # non-existent proxy, causing a TCP timeout.
      try {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.UseProxy = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(3)
        $task = $client.GetAsync($uri)
        $task.Wait()
        $statusCode = [int]$task.Result.StatusCode
        if (Test-BackendProbeStatus $statusCode) {
          $healthy = $true
          $healthCheckMethod = "HttpClient(no-proxy)"
          Write-Host "Backend health check passed on port $port (via HttpClient, proxy bypassed, HTTP $statusCode)."
          break
        }
      } catch {
        $elapsed = [int]((Get-Date) - $deadline.AddSeconds(-$TimeoutSeconds)).TotalSeconds
        if ($elapsed % 30 -lt 3) {
          Write-Host "Health check on port ${port} failed ($elapsed s): $($_.Exception.InnerException.Message ?? $_.Exception.Message)"
        }
      } finally {
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
      }

      # Method 2: curl.exe (ships with Windows 10+, uses its own network stack).
      if (-not $healthy) {
        try {
          $curlResult = & "$env:SystemRoot\System32\curl.exe" -s -o NUL -w "%{http_code}" $uri --connect-timeout 3 --max-time 5 --noproxy "127.0.0.1" 2>$null
          if ($curlResult -eq "200" -or $curlResult -eq "401") {
            $healthy = $true
            $healthCheckMethod = "curl.exe"
            Write-Host "Backend health check passed on port $port (via curl.exe, HTTP $curlResult)."
            break
          }
        } catch {}
      }

      # Method 3: Invoke-WebRequest with -NoProxy (PowerShell 7+).
      if (-not $healthy) {
        try {
          $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 3 -NoProxy -SkipHttpErrorCheck
          if (Test-BackendProbeStatus ([int]$response.StatusCode)) {
            $healthy = $true
            $healthCheckMethod = "Invoke-WebRequest(-NoProxy)"
            Write-Host "Backend health check passed on port $port (via Invoke-WebRequest -NoProxy, HTTP $($response.StatusCode))."
            break
          }
        } catch {}
      }
    }

    if (
      $startupState -and
      ($startupState.phase -eq "runtime_ready" -or $startupState.phase -eq "metadata_ready") -and
      -not $startupState.port
    ) {
      throw "Windows packaged app reached $($startupState.phase) without recording a backend port."
    }

    if (
      $startupState -and
      ($startupState.phase -eq "runtime_ready" -or $startupState.phase -eq "metadata_ready") -and
      -not $healthy
    ) {
      Write-Host "Startup trace reached $($startupState.phase) but /api/health has not responded yet."
    }

    if ($healthy) {
      break
    }

    Start-Sleep -Seconds 2
  }

  if (-not $healthy) {
    $startupState = Get-StartupState
    if ($installerProcess) {
      Write-Host "Installer exited: $($installerProcess.HasExited)"
      if ($installerProcess.HasExited) {
        Write-Host "Installer exit code: $($installerProcess.ExitCode)"
      }
    }
    if ($launcherProcess) {
      Write-Host "Launcher exited: $($launcherProcess.HasExited)"
      if ($launcherProcess.HasExited) {
        Write-Host "Launcher exit code: $($launcherProcess.ExitCode)"
      }
    }
    if ($startupState) {
      Write-Host "Latest startup trace state:"
      $startupState | ConvertTo-Json -Depth 6 | Write-Host
    }
    if (Test-Path $startupEventsFile) {
      Write-Host "Recent startup trace events:"
      Get-Content $startupEventsFile -Tail 200
    }
    if (Test-Path $selfExtractionRoot) {
      Write-Host "Self-extraction contents:"
      Get-ChildItem -Path $selfExtractionRoot -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    }

    Dump-FailureDiagnostics $BackendPort

    throw "Windows packaged app did not become healthy within $TimeoutSeconds seconds."
  }
} finally {
  Stop-ElizaProcesses
  if (-not [string]::IsNullOrWhiteSpace($startupBootstrapFile)) {
    Remove-Item $startupBootstrapFile -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $tempExtractDir) {
    Remove-Item $tempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
