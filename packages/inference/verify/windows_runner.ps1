<#
.SYNOPSIS
  Native Windows hardware verification runner for Eliza-1 local inference.

.DESCRIPTION
  Builds the requested Windows target, then runs model-backed llama-bench + llama-completion graph
  smoke with --cache-type-k for TurboQuant, QJL, and PolarQuant aliases. This
  script fails when hardware/toolchain/model prerequisites are missing. A pass
  is a runtime dispatch smoke, not a symbol check.

  Example:
    pwsh -File packages/inference/verify/windows_runner.ps1 `
      -Backend cuda `
      -Model C:\models\eliza-1-smoke.gguf

  Environment overrides:
    WINDOWS_BUILD_FORK=0 skips the build step for an existing native binary.
    WINDOWS_SKIP_GRAPH_SMOKE=1 exits non-zero after preflight; it is not
      recordable hardware evidence.
    ELIZA_DFLASH_SMOKE_CACHE_TYPES/TOKENS/NGL/PROMPT/EXTRA_ARGS tune the
      llama-bench graph smoke.
    ELIZA_STATE_DIR controls the default native binary lookup root.
#>

[CmdletBinding()]
param(
  [ValidateSet("cuda", "vulkan", "cpu")]
  [string] $Backend = "cuda",

  [string] $Target = "",

  [string] $Model = $env:ELIZA_DFLASH_SMOKE_MODEL,

  [string] $BinDir = "",

  [string] $ReportDir = "",

  [string] $Report = $env:ELIZA_DFLASH_HARDWARE_REPORT,

  [string[]] $CacheTypes = @()
)

$ErrorActionPreference = "Stop"

$script:StartedAt = (Get-Date).ToUniversalTime()
$script:Target = $Target
$script:FailureReason = $null
$script:GpuInfo = $null
$script:ToolchainInfo = $null
$script:GraphSmokeStatus = "required"
$script:ResolvedModel = $Model
$script:Runs = @()

function Get-FileSha256([string] $Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
    return $null
  }
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Write-EvidenceReport([int] $ExitCode) {
  if ([string]::IsNullOrWhiteSpace($Report)) {
    return
  }
  $status = if ($ExitCode -eq 0) { "pass" } else { "fail" }
  $passRecordable = ($ExitCode -eq 0 -and $script:GraphSmokeStatus -eq "required")
  $parent = Split-Path -Parent $Report
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $payload = [ordered]@{
    schemaVersion = 1
    runner = "windows_runner.ps1"
    status = $status
    passRecordable = $passRecordable
    exitCode = $ExitCode
    failureReason = $script:FailureReason
    startedAt = $script:StartedAt.ToString("s") + "Z"
    finishedAt = (Get-Date).ToUniversalTime().ToString("s") + "Z"
    host = [ordered]@{
      os = if ($IsWindows) { "Windows" } else { [System.Runtime.InteropServices.RuntimeInformation]::OSDescription }
      arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    target = $script:Target
    backend = $Backend
    requirements = [ordered]@{
      os = "Native Windows"
      toolchain = switch ($Backend) {
        "cuda" { @("nvidia-smi", "nvcc") }
        "vulkan" { @("vulkaninfo") }
        default { @() }
      }
      hardware = switch ($Backend) {
        "cuda" { "NVIDIA GPU reported by nvidia-smi" }
        "vulkan" { "Vulkan device reported by vulkaninfo" }
        default { "Native Windows CPU execution" }
      }
      graphSmoke = $script:GraphSmokeStatus
    }
    evidence = [ordered]@{
      gpuInfo = $script:GpuInfo
      toolchainInfo = $script:ToolchainInfo
      model = $script:ResolvedModel
      modelSha256 = Get-FileSha256 $script:ResolvedModel
      cacheRuns = $script:Runs
    }
  }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -Path $Report -Encoding UTF8
}

function Fail([string] $Message) {
  $script:FailureReason = $Message
  Write-EvidenceReport 1
  [Console]::Error.WriteLine("[windows_runner] $Message")
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
  Fail "llama-bench help does not advertise a cache-type alias for $Family"
}

trap {
  if ([string]::IsNullOrWhiteSpace($script:FailureReason)) {
    $script:FailureReason = "unhandled error: $($_.Exception.Message)"
  }
  try {
    Write-EvidenceReport 1
  } catch {
    [Console]::Error.WriteLine("[windows_runner] failed to write evidence report: $($_.Exception.Message)")
  }
  [Console]::Error.WriteLine("[windows_runner] $($script:FailureReason)")
  exit 1
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
$script:Target = $Target

switch ($Backend) {
  "cuda" {
    Require-Command "nvidia-smi"
    Require-Command "nvcc"
    $script:GpuInfo = (& nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader 2>&1 | Out-String).Trim()
    Write-Host $script:GpuInfo
    if ($LASTEXITCODE -ne 0) { Fail "nvidia-smi did not report an NVIDIA GPU" }
    $script:ToolchainInfo = (& nvcc --version 2>&1 | Out-String).Trim()
    Write-Host $script:ToolchainInfo
  }
  "vulkan" {
    if (-not (Get-Command "vulkaninfo" -ErrorAction SilentlyContinue)) {
      Fail "vulkaninfo not found; install Vulkan SDK/runtime before Windows Vulkan verification"
    }
    $script:GpuInfo = (& vulkaninfo --summary 2>&1 | Out-String).Trim()
    Write-Host $script:GpuInfo
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

# Driver: llama-bench, not llama-cli. The fork's llama-cli is conversation-only
# and busy-loops on stdin EOF; llama-bench runs the same prompt-eval + token-gen
# graph passes (incl. the Turbo/QJL/Polar KV-cache ops) non-interactively and
# exits cleanly. llama-completion handles the real GGUF generation step.
$bench = Join-Path $BinDir "llama-bench.exe"
if (-not (Test-Path $bench)) {
  Fail "missing llama-bench.exe in $BinDir (rebuild target $Target; the build script ships llama-bench + llama-completion alongside llama-server)"
}
$completion = Join-Path $BinDir "llama-completion.exe"
$env:PATH = "$BinDir;$env:PATH"

if ($env:WINDOWS_SKIP_GRAPH_SMOKE -eq "1") {
  $script:GraphSmokeStatus = "skipped"
  Fail "WINDOWS_SKIP_GRAPH_SMOKE=1 - build/hardware preflight only; graph dispatch NOT verified, so no hardware pass can be recorded."
}

if ([string]::IsNullOrWhiteSpace($Model) -or -not (Test-Path $Model)) {
  Fail "ELIZA_DFLASH_SMOKE_MODEL / -Model must point at a GGUF model for graph dispatch verification"
}
$script:ResolvedModel = $Model

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = Join-Path $PSScriptRoot "hardware-results"
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$helpLog = Join-Path $ReportDir "$Target-llama-bench-help.log"
$helpText = (& $bench --help 2>&1 | Tee-Object -FilePath $helpLog | Out-String)
if ($helpText -notmatch "--cache-type-k") {
  Fail "llama-bench help does not expose --cache-type-k; see $helpLog"
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
  Write-Host "[windows_runner] target=$Target family=$($run.Family) cache=$($run.Cache) (llama-bench)"
  & $bench -m $Model -ngl $ngl --cache-type-k $run.Cache -p 16 -n $tokens -fa 1 -r 1 @extraArgs *> $log
  if ($LASTEXITCODE -ne 0) {
    Fail "llama-bench graph smoke failed for cache=$($run.Cache); see $log"
  }
  $logText = Get-Content -Raw -Path $log
  if ($logText -notmatch $backendPattern) {
    Fail "backend pattern '$backendPattern' not observed for cache=$($run.Cache); see $log"
  }
  $script:Runs += [ordered]@{
    family = $run.Family
    cache = $run.Cache
    log = $log
    backendPattern = $backendPattern
    status = "pass"
  }
  Add-Content -Path $summary -Value "PASS $($run.Family) cache=$($run.Cache) log=$log"
}

# Real GGUF next-token generation via llama-completion (the conversation-free
# generation driver). Skipped only if the build didn't ship it.
if (Test-Path $completion) {
  $genLog = Join-Path $ReportDir "$Target-gen-check.log"
  Write-Host "[windows_runner] target=$Target GGUF generation (llama-completion)"
  & $completion -m $Model -p $prompt -n $tokens -ngl $ngl --no-warmup @extraArgs *> $genLog
  if ($LASTEXITCODE -ne 0) {
    Fail "llama-completion GGUF generation failed; see $genLog"
  }
  $genText = Get-Content -Raw -Path $genLog
  if ($genText -notmatch $backendPattern) {
    Fail "backend pattern '$backendPattern' not observed during GGUF generation; see $genLog"
  }
  $script:Runs += [ordered]@{
    family = "gen-check"
    cache = "n/a"
    log = $genLog
    backendPattern = $backendPattern
    status = "pass"
  }
  Add-Content -Path $summary -Value "PASS gen-check log=$genLog"
} else {
  Add-Content -Path $summary -Value "SKIP gen-check (llama-completion.exe not installed)"
}

Add-Content -Path $summary -Value "finished_at=$((Get-Date).ToUniversalTime().ToString("s"))Z"
Write-EvidenceReport 0
Write-Host "[windows_runner] PASS target=$Target report=$summary"
