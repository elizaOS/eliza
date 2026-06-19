[CmdletBinding()]
param(
  [string]$ArtifactDir,
  [string]$Device,
  [string]$Slot,
  [string[]]$Image = @(),
  [switch]$SkipPreflight,
  [switch]$AssumeBootloader,
  [switch]$WipeData,
  [switch]$RebootAfterFlash,
  [switch]$Execute,
  [switch]$ConfirmFlash,
  [switch]$DryRun = $true,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

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
if ($ConfirmFlash) { $argsList += "--confirm-flash" }
if ($ExtraArgs) { $argsList += $ExtraArgs }

$bash = Find-Bash
& $bash $bashInstaller @argsList
exit $LASTEXITCODE
