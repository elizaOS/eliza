<#
.SYNOPSIS
  Native Windows hardware verification runner for Eliza-1 local inference.

.DESCRIPTION
  Builds the requested Windows target, then runs model-backed llama-cli graph
  smoke with --cache-type-k for TurboQuant, QJL, and PolarQuant aliases. This
  script fails when hardware/toolchain/model prerequisites are missing. A pass
  is a runtime dispatch smoke, not a symbol check.

  Example:
    pwsh -File packages/inference/verify/windows_runner.ps1 `
      -Backend cuda `
      -Model C:\models\eliza-1-smoke.gguf
#>

[CmdletBinding()]
param(
  [ValidateSet("cuda", "vulkan", "cpu")]
  [string] $Backend = "cuda",

  [string] $Target = "",

  [string] $Model = $env:ELIZA_DFLASH_SMOKE_MODEL,

  [string] $BinDir = "",

  [string] $ReportDir = "",

  [string[]] $CacheTypes = @()
)

$ErrorActionPreference = "Stop"

function Fail([string] $Message) {
  Write-Error "[windows_runner] $Message"
  exit 1
}

function Require-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "$Name not found on PATH"
  }
}

function Resolve-RepoRoot {
  $root = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($root)) {
    Fail "could not resolve git repository root"
  }
  return $root.Trim()
}

function Resolve-CacheType([string] $Help, [string] $Family, [string[]] $Aliases) {
  foreach ($alias in $Aliases) {
    $pattern = "(^|[^A-Za-z0-9_+-])$([regex]::Escape($alias))([^A-Za-z0-9_+-]|$)"
    if ($Help -match $pattern) {
      return [pscustomobject]@{ Family = $Family; Cache = $alias }
    }
  }
  Fail "llama-cli help does not advertise a cache-type alias for $Family"
}

if (-not $IsWindows) {
  Fail "native Windows verification requires a Windows host"
}

$repoRoot = Resolve-RepoRoot

if ([string]::IsNullOrWhiteSpace($Target)) {
  $arch = (Get-CimInstance Win32_OperatingSystem).OSArchitecture
  if ($arch -match "ARM") {
    if ($Backend -eq "cuda") {
      Fail "windows-arm64-cuda is not a supported target; use -Backend vulkan or cpu on Snapdragon/ARM64 Windows"
    }
    $Target = "windows-arm64-$Backend"
  } else {
    $Target = "windows-x64-$Backend"
  }
}

switch ($Backend) {
  "cuda" {
    Require-Command "nvidia-smi"
    Require-Command "nvcc"
    & nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader
    if ($LASTEXITCODE -ne 0) { Fail "nvidia-smi did not report an NVIDIA GPU" }
    & nvcc --version
  }
  "vulkan" {
    if (-not (Get-Command "vulkaninfo" -ErrorAction SilentlyContinue)) {
      Fail "vulkaninfo not found; install Vulkan SDK/runtime before Windows Vulkan verification"
    }
    & vulkaninfo --summary
    if ($LASTEXITCODE -ne 0) { Fail "vulkaninfo failed to enumerate a Vulkan device" }
  }
  "cpu" {
    Write-Host "[windows_runner] CPU backend selected; this verifies native Windows execution but no GPU dispatch."
  }
}

$buildScript = Join-Path $repoRoot "packages/app-core/scripts/build-llama-cpp-dflash.mjs"
if ($env:WINDOWS_BUILD_FORK -ne "0") {
  & node $buildScript --target $Target
  if ($LASTEXITCODE -ne 0) { Fail "build target failed: $Target" }
}

if ([string]::IsNullOrWhiteSpace($BinDir)) {
  $stateDir = $env:ELIZA_STATE_DIR
  if ([string]::IsNullOrWhiteSpace($stateDir)) {
    $stateDir = Join-Path $HOME ".eliza"
  }
  $BinDir = Join-Path $stateDir "local-inference/bin/dflash/$Target"
}

$cli = Join-Path $BinDir "llama-cli.exe"
if (-not (Test-Path $cli)) {
  Fail "missing llama-cli.exe in $BinDir"
}
$env:PATH = "$BinDir;$env:PATH"

if ($env:WINDOWS_SKIP_GRAPH_SMOKE -eq "1") {
  Write-Host "[windows_runner] WINDOWS_SKIP_GRAPH_SMOKE=1 - build/hardware preflight only; graph dispatch NOT verified."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Model) -or -not (Test-Path $Model)) {
  Fail "ELIZA_DFLASH_SMOKE_MODEL / -Model must point at a GGUF model for graph dispatch verification"
}

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = Join-Path $PSScriptRoot "hardware-results"
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$helpLog = Join-Path $ReportDir "$Target-llama-cli-help.log"
$helpText = (& $cli --help 2>&1 | Tee-Object -FilePath $helpLog | Out-String)
if ($helpText -notmatch "--cache-type-k") {
  Fail "llama-cli help does not expose --cache-type-k; see $helpLog"
}

$runs = @()
if ($CacheTypes.Count -gt 0) {
  foreach ($cache in $CacheTypes) {
    $runs += [pscustomobject]@{ Family = $cache; Cache = $cache }
  }
} elseif (-not [string]::IsNullOrWhiteSpace($env:ELIZA_DFLASH_SMOKE_CACHE_TYPES)) {
  foreach ($cache in ($env:ELIZA_DFLASH_SMOKE_CACHE_TYPES -split "[,\s]+" | Where-Object { $_ })) {
    $runs += [pscustomobject]@{ Family = $cache; Cache = $cache }
  }
} else {
  $runs += Resolve-CacheType $helpText "turbo3" @("tbq3_0", "turbo3")
  $runs += Resolve-CacheType $helpText "turbo4" @("tbq4_0", "turbo4")
  $runs += Resolve-CacheType $helpText "turbo3_tcq" @("tbq3_tcq", "turbo3_tcq", "turbo3-tcq")
  $runs += Resolve-CacheType $helpText "qjl" @("qjl1_256", "qjl_full", "qjl")
  $runs += Resolve-CacheType $helpText "polar" @("q4_polar", "polarquant", "polar")
}

$backendPattern = switch ($Backend) {
  "cuda" { "CUDA|cuda|cuBLAS|ggml_cuda|NVIDIA" }
  "vulkan" { "Vulkan|vulkan|ggml_vulkan" }
  default { "AVX|AVX2|CPU|ggml_backend_cpu|llama" }
}

$prompt = if ($env:ELIZA_DFLASH_SMOKE_PROMPT) { $env:ELIZA_DFLASH_SMOKE_PROMPT } else { "Eliza Windows backend graph dispatch smoke." }
$tokens = if ($env:ELIZA_DFLASH_SMOKE_TOKENS) { $env:ELIZA_DFLASH_SMOKE_TOKENS } else { "4" }
$ngl = if ($env:ELIZA_DFLASH_SMOKE_NGL) { $env:ELIZA_DFLASH_SMOKE_NGL } else { "99" }
$extraArgs = @()
if ($env:ELIZA_DFLASH_SMOKE_EXTRA_ARGS) {
  $extraArgs = $env:ELIZA_DFLASH_SMOKE_EXTRA_ARGS -split "\s+"
}

$summary = Join-Path $ReportDir "$Target-graph-smoke.summary"
@(
  "target=$Target",
  "backend=$Backend",
  "bin_dir=$BinDir",
  "model=$Model",
  "tokens=$tokens",
  "ngl=$ngl",
  "started_at=$((Get-Date).ToUniversalTime().ToString("s"))Z"
) | Set-Content -Path $summary -Encoding UTF8

foreach ($run in $runs) {
  $log = Join-Path $ReportDir "$Target-$($run.Family)-$($run.Cache).log"
  Write-Host "[windows_runner] target=$Target family=$($run.Family) cache=$($run.Cache)"
  & $cli -m $Model -p $prompt -n $tokens -ngl $ngl --cache-type-k $run.Cache @extraArgs *> $log
  if ($LASTEXITCODE -ne 0) {
    Fail "llama-cli graph smoke failed for cache=$($run.Cache); see $log"
  }
  $logText = Get-Content -Raw -Path $log
  if ($logText -notmatch $backendPattern) {
    Fail "backend pattern '$backendPattern' not observed for cache=$($run.Cache); see $log"
  }
  Add-Content -Path $summary -Value "PASS $($run.Family) cache=$($run.Cache) log=$log"
}

Add-Content -Path $summary -Value "finished_at=$((Get-Date).ToUniversalTime().ToString("s"))Z"
Write-Host "[windows_runner] PASS target=$Target report=$summary"
