<#
Exercises the production plugin staging graph and junction publication under a
temporary Windows Users account. This harness is restricted to disposable
GitHub-hosted Windows runners and never enables Developer Mode. The child must
prove its token is not administrative and ordinary directory symlinks fail.
#>
param(
    [switch] $Child,
    [string] $ProofRoot,
    [string] $NodeExecutable,
    [string] $BunExecutable,
    [string] $RunnerEnvironment
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Child -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) {
    throw 'This account-creation proof is restricted to disposable GitHub-hosted Windows runners.'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path

if ($Child) {
    if ($RunnerEnvironment -ne 'github-hosted') { throw 'Missing explicit hosted-runner child context.' }
    $env:GITHUB_ACTIONS = 'true'
    $env:RUNNER_OS = 'Windows'
    $env:RUNNER_ENVIRONMENT = $RunnerEnvironment
    $env:CI = 'true'
    $gate = Join-Path $ProofRoot 'job-assigned'
    $gateDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path $gate)) {
        if ([DateTime]::UtcNow -gt $gateDeadline) { throw 'Child was not assigned to its owning process job.' }
        Start-Sleep -Milliseconds 50
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'The staging proof child must not have an administrator token.'
    }
    Write-Output 'Verified non-administrator child token.'
    $env:TEMP = Join-Path $ProofRoot 'temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    $env:PATH = "$(Split-Path $NodeExecutable);$(Split-Path $BunExecutable);$env:PATH"
    Set-Location $repo
    & $NodeExecutable packages/agent/scripts/assert-windows-symlink-denied.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Directory-symlink privilege prerequisite failed.' }
    $bunVersion = & $BunExecutable --version
    if ($LASTEXITCODE -ne 0 -or $bunVersion -ne '1.3.14') { throw 'Use the pinned Bun runtime.' }
    $baseConfig = ([Uri]::new((Join-Path $repo 'packages/agent/vitest.config.ts'))).AbsoluteUri | ConvertTo-Json -Compress
    $cacheDirectory = (Join-Path $ProofRoot 'vite-cache') | ConvertTo-Json -Compress
    $configPath = Join-Path $ProofRoot 'vitest.config.mjs'
    "import base from $baseConfig; export default { ...base, cacheDir: $cacheDirectory };" | Set-Content -Encoding UTF8 $configPath
    & $NodeExecutable node_modules/vitest/vitest.mjs run --maxWorkers=1 --configLoader runner --no-cache --config $configPath packages/agent/src/runtime/plugin-resolver-dependency-graph.test.ts packages/agent/src/runtime/plugin-staging-links.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Real Windows staging consumer contracts failed.' }
    exit 0
}

$userName = 'stage' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$password = ConvertTo-SecureString ('S7!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$ProofRoot = Join-Path $env:RUNNER_TEMP $userName
$artifactRoot = Join-Path $repo 'device-e2e-artifacts/windows-staging'
$accountCreated = $false
$accountSid = $null
$childProcess = $null
$job = $null
$proofFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$cleanupNode = (Get-Command node.exe).Source
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsStagingProofJob.cs')
    $job = [ElizaStagingProof.Job]::new()
    New-Item -ItemType Directory -Path $ProofRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
    New-LocalUser -Name $userName -Password $password -AccountNeverExpires | Out-Null
    $accountCreated = $true
    $user = Get-LocalUser -Name $userName
    $accountSid = $user.SID.Value
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    Add-LocalGroupMember -Group $users -Member $user
    & icacls.exe $ProofRoot /grant "*$($user.SID.Value):(OI)(CI)M" /Q
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the proof account its fixture directory.' }
    # Tool installers may put Bun under the administrative runner's profile.
    # Copy the exact binaries into the owned fixture rather than widening that
    # profile's ACL or relying on administrative access in the child.
    $binaryRoot = Join-Path $ProofRoot 'bin'
    New-Item -ItemType Directory -Path $binaryRoot | Out-Null
    $NodeExecutable = Join-Path $binaryRoot 'node.exe'
    $BunExecutable = Join-Path $binaryRoot 'bun.exe'
    foreach ($pair in @(@($cleanupNode, $NodeExecutable), @((Get-Command bun.exe).Source, $BunExecutable))) {
        Copy-Item $pair[0] $pair[1]
        if ((Get-FileHash $pair[0]).Hash -ne (Get-FileHash $pair[1]).Hash) {
            throw 'Pinned runtime binary copy did not retain its hash.'
        }
    }
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
    $arguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"", '-Child',
        '-ProofRoot', "`"$ProofRoot`"",
        '-NodeExecutable', "`"$NodeExecutable`"",
        '-BunExecutable', "`"$BunExecutable`"",
        '-RunnerEnvironment', 'github-hosted'
    )
    $stdout = Join-Path $ProofRoot 'stdout.log'
    $stderr = Join-Path $ProofRoot 'stderr.log'
    $childProcess = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -ArgumentList $arguments -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $job.Assign($childProcess.Handle)
    New-Item -ItemType File -Path (Join-Path $ProofRoot 'job-assigned') | Out-Null
    if (-not $childProcess.WaitForExit(180000)) {
        throw 'Normal-user staging proof exceeded its three-minute process bound.'
    }
    $childProcess.Refresh()
    if ($childProcess.ExitCode -ne 0) { throw "Normal-user staging proof failed with exit $($childProcess.ExitCode)." }
} catch {
    # error-policy:J1 The process boundary preserves the actual proof failure after cleanup.
    $proofFailure = $_
} finally {
    try {
        if ($null -ne $job) { $job.Dispose() }
        if ($null -ne $childProcess) {
            # Assignment can fail before the gate opens; that child has no
            # descendants, but still needs to stop before removing its profile.
            if (-not $childProcess.HasExited) { Stop-Process -Id $childProcess.Id -Force }
            if (-not $childProcess.WaitForExit(10000)) { throw 'Proof child did not stop during cleanup.' }
        }
        foreach ($name in @('stdout.log', 'stderr.log')) {
            $log = Join-Path $ProofRoot $name
            if (Test-Path $log) {
                Copy-Item $log (Join-Path $artifactRoot $name) -Force
                Get-Content $log
            }
        }
    } catch {
        # error-policy:J6 Retain teardown diagnostics without replacing the proof failure.
        $cleanupFailures.Add($_.Exception.Message)
    } finally {
        try {
            if ($accountCreated) { Remove-LocalUser -Name $userName }
        } catch {
            # error-policy:J6 Continue exact-owned fixture cleanup after account-removal failure.
            $cleanupFailures.Add($_.Exception.Message)
        } finally {
            try {
                if ($null -ne $accountSid) {
                    Get-CimInstance Win32_UserProfile -Filter "SID='$accountSid'" | Remove-CimInstance
                }
            } catch {
                # error-policy:J6 Continue fixture cleanup after profile-removal failure.
                $cleanupFailures.Add($_.Exception.Message)
            } finally {
                try {
                    $password.Dispose()
                    # Node removes junction entries without traversing their targets.
                    & $cleanupNode --input-type=module -e "import { rm } from 'node:fs/promises'; await rm(process.argv[1], { recursive: true, force: true });" $ProofRoot
                    if ($LASTEXITCODE -ne 0) { $cleanupFailures.Add('Could not clean the owned proof fixture.') }
                } catch {
                    # error-policy:J6 Preserve the proof failure if fixture removal also fails.
                    $cleanupFailures.Add($_.Exception.Message)
                }
            }
        }
    }
}
foreach ($failure in $cleanupFailures) { Write-Warning "Staging proof cleanup: $failure" }
if ($null -ne $proofFailure) { throw $proofFailure }
if ($cleanupFailures.Count -gt 0) { throw 'Normal-user staging proof cleanup failed.' }
