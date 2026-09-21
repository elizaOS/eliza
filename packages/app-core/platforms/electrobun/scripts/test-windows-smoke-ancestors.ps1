<#
Exercises the real smoke ancestor walk with deterministic Windows process-query
fixtures. It prevents PID reuse from hanging pre-launch discovery and verifies
that discovery failures stop before any process teardown can run.
#>
$ErrorActionPreference = "Stop"
$sourcePath = Join-Path $PSScriptRoot "smoke-test-windows.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq "Get-ProtectedAncestorProcessIds"
}, $true)
if (-not $function) { throw "Smoke ancestor function was not found" }
. ([scriptblock]::Create($function.Extent.Text))

function Get-CimInstance {
  param($ClassName, $Filter, $OperationTimeoutSec, $ErrorAction)
  if ($script:queryFailure) { throw "Process discovery unavailable" }
  $requested = [int]($Filter -replace '^ProcessId = ', '')
  if (-not $script:queried.Add($requested)) { throw "Repeated process query: ancestor walk did not terminate" }
  if ($script:parents.ContainsKey($requested)) {
    [pscustomobject]@{ ProcessId = $requested; ParentProcessId = $script:parents[$requested] }
  }
}

$cases = @(
  @{ Name = "complete chain"; Parents = @{42=41;41=40;40=0}; Expected = @(42,41,40) },
  @{ Name = "exited parent"; Parents = @{42=41}; Expected = @(42,41) },
  @{ Name = "self parent"; Parents = @{42=42}; Expected = @(42) },
  @{ Name = "reused ancestor cycle"; Parents = @{42=41;41=40;40=41}; Expected = @(42,41,40) },
  @{ Name = "cycle back to invoker"; Parents = @{42=41;41=42}; Expected = @(42,41) }
)
foreach ($case in $cases) {
  $script:parents = $case.Parents
  $script:queried = [System.Collections.Generic.HashSet[int]]::new()
  $script:queryFailure = $false
  $actual = Get-ProtectedAncestorProcessIds -ProcessId 42
  if (-not $actual.SetEquals([int[]]$case.Expected)) { throw "Incorrect protected ancestry: $($case.Name)" }
  if ($actual.Contains(99)) { throw "Unrelated process was protected" }
  Write-Host "PASS: $($case.Name)"
}
$script:queryFailure = $true
$failed = $false
try { Get-ProtectedAncestorProcessIds -ProcessId 42 | Out-Null }
catch {
  # error-policy:J3 Verify that unavailable process discovery is not converted into a usable partial set.
  if ($_.Exception.Message -ne "Process discovery unavailable") { throw }
  $failed = $true
}
if (-not $failed) { throw "Discovery failure returned an unsafe partial ancestor set" }
Write-Host "PASS: discovery failure stops before teardown"
