<#
Exercises the Windows CI command retry state machine without launching native
fixtures. Injected statuses make success, retry, exhaustion, and ordinary
failure deterministic on every PowerShell host.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$modulePath = Join-Path $PSScriptRoot "../windows-ci-command-runner.psm1"
Import-Module $modulePath -Force

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        $Actual,

        [Parameter(Mandatory = $true)]
        $Expected,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message Expected $Expected, got $Actual."
    }
}

function Assert-LogContains {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Logs,

        [Parameter(Mandatory = $true)]
        [string]$Pattern,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not ($Logs -match $Pattern)) {
        throw "$Message Missing log pattern: $Pattern"
    }
}

function Invoke-TestCase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [int[]]$Statuses,

        [Parameter(Mandatory = $true)]
        [int]$ExpectedStatus,

        [Parameter(Mandatory = $true)]
        [int]$ExpectedAttempts,

        [Parameter(Mandatory = $true)]
        [int]$ExpectedDelays
    )

    $state = @{
        Index = 0
        Delays = 0
        Logs = [System.Collections.Generic.List[string]]::new()
        Statuses = $Statuses
    }

    $invoker = {
        param([string]$CommandText)
        $status = $state.Statuses[$state.Index]
        $state.Index += 1
        return [int]$status
    }.GetNewClosure()

    $delay = {
        param([int]$Milliseconds)
        Assert-Equal -Actual $Milliseconds -Expected 1000 -Message "$Name delay"
        $state.Delays += 1
    }.GetNewClosure()

    $logger = {
        param([string]$Level, [string]$Message)
        [void]$state.Logs.Add("$Level|$Message")
    }.GetNewClosure()

    $status = Invoke-WindowsCiCommand `
        -Command "fixture-$Name" `
        -CommandInvoker $invoker `
        -Delay $delay `
        -Log $logger

    Assert-Equal -Actual $status -Expected $ExpectedStatus -Message "$Name status"
    Assert-Equal -Actual $state.Index -Expected $ExpectedAttempts -Message "$Name attempts"
    Assert-Equal -Actual $state.Delays -Expected $ExpectedDelays -Message "$Name delays"
    Assert-LogContains -Logs $state.Logs -Pattern "attempt 1/2 starting" -Message "$Name start log"
    Assert-LogContains -Logs $state.Logs -Pattern "attempt 1/2 exited with status $($Statuses[0])" -Message "$Name status log"

    Write-Host "PASS: $Name"
    return $state
}

$success = Invoke-TestCase `
    -Name "success" `
    -Statuses @(0) `
    -ExpectedStatus 0 `
    -ExpectedAttempts 1 `
    -ExpectedDelays 0
Assert-Equal -Actual ($success.Logs -match "STATUS_DLL_INIT_FAILED").Count -Expected 0 -Message "success retry logs"

$retrySuccess = Invoke-TestCase `
    -Name "init-crash-then-success" `
    -Statuses @(-1073741502, 0) `
    -ExpectedStatus 0 `
    -ExpectedAttempts 2 `
    -ExpectedDelays 1
Assert-LogContains -Logs $retrySuccess.Logs -Pattern "Waiting 1000ms before the single retry" -Message "retry announcement"
Assert-LogContains -Logs $retrySuccess.Logs -Pattern "attempt 2/2 exited with status 0" -Message "retry success status"

$persistentCrash = Invoke-TestCase `
    -Name "persistent-init-crash" `
    -Statuses @(-1073741502, -1073741502) `
    -ExpectedStatus -1073741502 `
    -ExpectedAttempts 2 `
    -ExpectedDelays 1
Assert-LogContains -Logs $persistentCrash.Logs -Pattern "persisted on attempt 2/2" -Message "persistent crash log"
Assert-LogContains -Logs $persistentCrash.Logs -Pattern "propagating status -1073741502" -Message "persistent crash status"

$ordinaryFailure = Invoke-TestCase `
    -Name "ordinary-failure" `
    -Statuses @(23, 0) `
    -ExpectedStatus 23 `
    -ExpectedAttempts 1 `
    -ExpectedDelays 0
Assert-Equal -Actual ($ordinaryFailure.Logs -match "STATUS_DLL_INIT_FAILED").Count -Expected 0 -Message "ordinary failure retry logs"

Write-Host "Windows CI command runner contract passed."
