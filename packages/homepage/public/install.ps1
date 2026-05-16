#Requires -Version 5.1
<#
.SYNOPSIS
    Eliza desktop installer for Windows PowerShell.

.DESCRIPTION
    Downloads the latest Eliza Windows installer (.exe) from GitHub Releases
    and runs it.

    Run with:
      irm https://eliza.ai/install.ps1 | iex

    Or save and run:
      Invoke-WebRequest -Uri https://eliza.ai/install.ps1 -OutFile install.ps1
      .\install.ps1

.PARAMETER Version
    Install a specific tag (default: latest, e.g. v2.0.0-alpha.87).

.PARAMETER NonInteractive
    Skip all prompts (assume yes).

.PARAMETER Silent
    Pass /S to the installer for an unattended install.

.EXAMPLE
    irm https://eliza.ai/install.ps1 | iex
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

# ----- Resolve release asset --------------------------------------------------

function Get-ElizaRelease {
    $releaseApi = if ($Version -eq "latest") {
        "https://api.github.com/repos/elizaOS/eliza/releases/latest"
    } else {
        "https://api.github.com/repos/elizaOS/eliza/releases/tags/$Version"
    }

    try {
        return Invoke-RestMethod -Uri $releaseApi -Headers @{
            "Accept" = "application/vnd.github+json"
            "User-Agent" = "eliza-installer"
        } -UseBasicParsing
    } catch {
        Write-Err "Could not read Eliza release metadata from GitHub."
        Write-Err "Open https://github.com/elizaOS/eliza/releases and download the Windows installer manually."
        Write-Err $_.Exception.Message
        exit 1
    }
}

function Find-ElizaWindowsAsset {
    param([object]$Release)

    $patterns = @(
        "ElizaOSApp-Setup.*\.exe$",
        "Setup.*\.exe$",
        "win.*\.exe$",
        "windows.*\.exe$",
        "win.*\.msix$",
        "windows.*\.msix$"
    )

    foreach ($pattern in $patterns) {
        foreach ($asset in @($Release.assets)) {
            if ($asset.name -match $pattern -and $asset.browser_download_url) {
                return $asset
            }
        }
    }

    return $null
}

$Release = Get-ElizaRelease
$Asset = Find-ElizaWindowsAsset -Release $Release

if (-not $Asset) {
    Write-Err "No Windows x64 installer is attached to the selected Eliza release yet."
    Write-Err "Open https://github.com/elizaOS/eliza/releases for the currently published assets."
    exit 1
}

$AssetName = $Asset.name
$Url = $Asset.browser_download_url

if ($AssetName -match "\.msix$") {
    Write-Warn "The selected release exposes an MSIX package instead of an EXE installer."
}

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

if ($AssetName -match "\.msix$") {
    Add-AppxPackage -Path $ExePath
} else {
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
Write-Host "  Docs: https://eliza.how" -ForegroundColor Blue
Write-Host ""
