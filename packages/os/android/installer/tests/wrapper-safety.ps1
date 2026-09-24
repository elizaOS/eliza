$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "../install-elizaos-android.ps1"
function Assert-Refused($Options, $Expected) {
  try {
    & $installer @Options
  } catch {
    if ($_.Exception.Message -notmatch $Expected) { throw }
    Write-Output "ok - $Expected"
    return
  }
  throw "Installer unexpectedly accepted unsafe options"
}
# All refusals must precede Bash lookup and any device access.
Assert-Refused @{Execute=$true; DryRun=$true} "conflicts"
Assert-Refused @{ConfirmFlash=$true; Execute=$true} "planning and read-only discovery only"
Assert-Refused @{ConfirmFlash=$true} "planning and read-only discovery only"
Assert-Refused @{ExtraArgs=@("--execute", "--confirm-flash")} "parameter.*ExtraArgs"
