[CmdletBinding()]
param(
  [string]$ArtifactDir,
  [string]$Manifest,
  [string]$Device,
  [string]$Slot,
  [string[]]$Image = @(),
  [switch]$SkipPreflight,
  [switch]$AssumeBootloader,
  [switch]$WipeData,
  [switch]$RebootAfterFlash,
  [switch]$Execute,
  [switch]$ConfirmFlash,
  [switch]$DryRun,
  [string]$ToolDir,
  [string]$RecoveryDir,
  [string]$Journal,
  [string]$HealthTokenFile
)

$ErrorActionPreference = "Stop"

if ($DryRun -and $Execute) { throw "-DryRun conflicts with -Execute" }
if ($ConfirmFlash) {
  throw "PowerShell supports planning and read-only discovery only. Confirmed installation requires the qualified Linux host and signed v2 installer."
}

function Find-Bash {
  $candidates = @("bash.exe", "bash")
  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }
  throw "bash was not found. Install Git for Windows, WSL, or another Bash runtime."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bashInstaller = Join-Path $scriptDir "install-elizaos-android.sh"
if (-not (Test-Path $bashInstaller)) {
  throw "missing Bash installer: $bashInstaller"
}

$argsList = @()
if ($ArtifactDir) { $argsList += @("--artifact-dir", $ArtifactDir) }
if ($Manifest) { $argsList += @("--manifest", $Manifest) }
foreach ($spec in $Image) { $argsList += @("--image", $spec) }
if ($Device) { $argsList += @("--device", $Device) }
if ($Slot) { $argsList += @("--slot", $Slot) }
if ($SkipPreflight) { $argsList += "--skip-preflight" }
if ($AssumeBootloader) { $argsList += "--assume-bootloader" }
if ($WipeData) { $argsList += "--wipe-data" }
if ($RebootAfterFlash) { $argsList += "--reboot-after-flash" }
if ($Execute) {
  $argsList += "--execute"
} else {
  $argsList += "--dry-run"
}
if ($ToolDir) { $argsList += @("--tool-dir", $ToolDir) }
if ($RecoveryDir) { $argsList += @("--recovery-dir", $RecoveryDir) }
if ($Journal) { $argsList += @("--journal", $Journal) }
if ($HealthTokenFile) { $argsList += @("--health-token-file", $HealthTokenFile) }

$bash = Find-Bash
& $bash $bashInstaller @argsList
exit $LASTEXITCODE
