param(
    [int]$IntervalSeconds = 2,
    [switch]$Typecheck,
    [switch]$Format,
    [switch]$FormatAll,
    [switch]$Build,
    [switch]$Once
)

$ErrorActionPreference = "Stop"

function Get-RepoSnapshot {
    $status = git status --porcelain=v1 --untracked-files=all 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read git status. Run this script from inside the repo."
    }
    return ($status -join "`n")
}

function Invoke-Check([string]$Name, [string]$Command) {
    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Name" -ForegroundColor Cyan
    & bun run $Command | Out-Host
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] FAIL: $Name" -ForegroundColor Red
        return ([bool]$false)
    }
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] PASS: $Name" -ForegroundColor Green
    return ([bool]$true)
}

Write-Host "dev-guard started. Watching for file changes..." -ForegroundColor Yellow
Write-Host "Checks: verify:lint$(if ($Format) { ', verify:format:changed' })$(if ($FormatAll) { ', verify:format' })$(if ($Typecheck) { ', verify:typecheck' })$(if ($Build) { ', build' })"
Write-Host "Press Ctrl+C to stop."

$lastSnapshot = ""
$firstRun = $true

while ($true) {
    $currentSnapshot = Get-RepoSnapshot
    $hasChange = $firstRun -or ($currentSnapshot -ne $lastSnapshot)

    if ($hasChange) {
        if (-not $firstRun) {
            Write-Host ""
            Write-Host "Change detected. Running checks..." -ForegroundColor Yellow
        }

        $ok = $true
        $ok = $ok -and (Invoke-Check "Lint" "verify:lint")

        if ($Format) {
            $ok = $ok -and (Invoke-Check "Format (changed)" "verify:format:changed")
        }

        if ($FormatAll) {
            $ok = $ok -and (Invoke-Check "Format (full)" "verify:format")
        }

        if ($Typecheck) {
            $ok = $ok -and (Invoke-Check "Typecheck" "verify:typecheck")
        }

        if ($Build) {
            $ok = $ok -and (Invoke-Check "Build" "build")
        }

        if ($ok) {
            Write-Host ""
            Write-Host "All enabled checks passed." -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "One or more checks failed. Fix and save; dev-guard will rerun automatically." -ForegroundColor Red
        }

        $lastSnapshot = $currentSnapshot
        $firstRun = $false

        if ($Once) {
            break
        }
    }

    Start-Sleep -Seconds $IntervalSeconds
}
