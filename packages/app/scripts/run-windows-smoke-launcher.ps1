param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ScriptPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs
)

$pwshCandidates = @(
  "pwsh.exe",
  (Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"),
  (Join-Path $env:ProgramFiles "PowerShell\6\pwsh.exe")
)

$pwsh = $null
foreach ($candidate in $pwshCandidates) {
  if ($candidate -eq "pwsh.exe") {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      $pwsh = $command.Source
      break
    }
  } elseif (Test-Path $candidate) {
    $pwsh = $candidate
    break
  }
}

if (-not $pwsh) {
  Write-Error "PowerShell 7 (pwsh) is required to run $ScriptPath because the Windows smoke script uses PowerShell 7 syntax."
  exit 1
}

& $pwsh -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
exit $LASTEXITCODE
