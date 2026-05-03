#Requires -Version 5.1
<#
.SYNOPSIS
    Eliza desktop installer for Windows PowerShell.

.DESCRIPTION
    Downloads the latest Eliza Windows installer (.exe) from GitHub Releases
    and runs it.

    Run with:
      irm https://elizaos.github.io/install.ps1 | iex

    Or save and run:
      Invoke-WebRequest -Uri https://elizaos.github.io/install.ps1 -OutFile install.ps1
      .\install.ps1

.PARAMETER Version
    Install a specific tag (default: latest, e.g. v2.0.0-alpha.87).

.PARAMETER NonInteractive
    Skip all prompts (assume yes).

.PARAMETER Silent
    Pass /S to the installer for an unattended install.

.EXAMPLE
    irm https://elizaos.github.io/install.ps1 | iex
#>

[CmdletBinding()]
param(
    [string]$Version = "latest",
    [switch]$NonInteractive,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"

# ----- Helpers ----------------------------------------------------------------

function Write-Info  { param([string]$Msg) Write-Host "  i  $Msg" -ForegroundColor Blue }
function Write-Ok    { param([string]$Msg) Write-Host "  +  $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "  !  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "  x  $Msg" -ForegroundColor Red }
function Write-Step  { param([string]$Msg) Write-Host "`n  > $Msg" -ForegroundColor Cyan }

# ----- Banner -----------------------------------------------------------------

Write-Host ""
Write-Host "  +--------------------------------------+" -ForegroundColor Cyan
Write-Host "  |       Eliza desktop installer        |" -ForegroundColor Cyan
Write-Host "  +--------------------------------------+" -ForegroundColor Cyan
Write-Host ""

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
Write-Info "System: Windows ($arch)"

if ($arch -ne "x64") {
    Write-Err "Eliza only ships an x64 Windows installer."
    Write-Err "Detected architecture: $arch"
    exit 1
}

# ----- Resolve release URL ----------------------------------------------------

$AssetName = "Eliza-win-x64.exe"
$ReleaseBase = if ($Version -eq "latest") {
    "https://github.com/elizaOS/eliza/releases/latest/download"
} else {
    "https://github.com/elizaOS/eliza/releases/download/$Version"
}
$Url = "$ReleaseBase/$AssetName"

# ----- Download ---------------------------------------------------------------

Write-Step "Downloading $AssetName"
$Tmp = Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
$ExePath = Join-Path $Tmp $AssetName

try {
    Invoke-WebRequest -Uri $Url -OutFile $ExePath -UseBasicParsing
} catch {
    Write-Err "Failed to download $Url"
    Write-Err $_.Exception.Message
    exit 1
}

Write-Ok "Downloaded to $ExePath"

# ----- Run installer ----------------------------------------------------------

Write-Step "Running installer"

$ProcArgs = @{
    FilePath = $ExePath
    Wait     = $true
    PassThru = $true
}

if ($Silent) {
    # /S is the standard NSIS silent-install flag; harmless if the installer
    # uses a different toolkit but is the convention for Electrobun/electron.
    $ProcArgs["ArgumentList"] = "/S"
}

$proc = Start-Process @ProcArgs

if ($proc.ExitCode -ne 0) {
    Write-Err "Installer exited with code $($proc.ExitCode)"
    Remove-Item $Tmp -Recurse -ErrorAction SilentlyContinue
    exit $proc.ExitCode
}

Remove-Item $Tmp -Recurse -ErrorAction SilentlyContinue

# ----- Done -------------------------------------------------------------------

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch Eliza from the Start menu."
Write-Host ""
Write-Host "  Docs: https://elizaos.github.io" -ForegroundColor Blue
Write-Host ""
