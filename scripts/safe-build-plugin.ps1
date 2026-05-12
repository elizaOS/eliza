#requires -Version 5.1
<#
.SYNOPSIS
    Workaround wrapper for the Bun 1.3.x Windows bin-remap bug.

.DESCRIPTION
    On Windows, packages whose `build` script is `bun run build.ts`
    (or any chain that re-execs through `node_modules/.bin/bun.exe`)
    fail with:

        error: could not create process

        Bun failed to remap this bin to its proper location within node_modules.

    The shim at `node_modules/.bin/bun.exe` (15872-byte renamed copy of
    `bun_shim_impl.exe`) reads its `bun.bunx` metadata, which points at
    `node_modules/bun/bin/bun.exe`. That target is a 450-byte placeholder
    stub that the npm `bun` package ships expecting a postinstall download
    that never runs when the host package manager is already Bun.
    `CreateProcessW` then fails on the stub and the shim emits the
    misleading "failed to remap" message.

    This wrapper sidesteps the broken shim by:
      1. Calling the real system `bun.exe` (resolved from PATH or BUN_INSTALL),
         not the workspace shim.
      2. Invoking the package's `build.ts` script file directly instead of
         `bun run build`, so Bun never re-execs through the local shim.
      3. Prepending the workspace `node_modules/.bin` to PATH so any
         inner `$\`tsc\`` / `$\`tsup\`` shell calls inside `build.ts` resolve.

    Use this script for any plugin or package whose build script is of the
    form `bun run <script>.ts`. For packages whose build is a direct tool
    invocation (`tsup ...`, `tsc ...`), `bun run build` works fine and
    this wrapper is unnecessary.

.PARAMETER Path
    Absolute or repo-relative path to the plugin/package directory.
    Must contain a `build.ts` file at its root.

.EXAMPLE
    pwsh scripts/safe-build-plugin.ps1 packages/core
    pwsh scripts/safe-build-plugin.ps1 plugins/plugin-anthropic

.NOTES
    Read-only against node_modules. Never runs `bun install`.
    Tracking issue: https://github.com/oven-sh/bun/issues/17482
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$pkgDir = if ([System.IO.Path]::IsPathRooted($Path)) {
    Resolve-Path $Path
} else {
    Resolve-Path (Join-Path $repoRoot $Path)
}

$buildScript = Join-Path $pkgDir 'build.ts'
if (-not (Test-Path $buildScript)) {
    Write-Error "No build.ts found at $buildScript. This wrapper is only for packages with a build.ts script."
    exit 2
}

# Resolve the real system bun.exe, NOT the workspace shim.
# Prefer $env:BUN_INSTALL (canonical), then well-known install path, then PATH.
$bunExe = $null
$candidates = @()
if ($env:BUN_INSTALL) {
    $candidates += (Join-Path $env:BUN_INSTALL 'bin\bun.exe')
}
$candidates += (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')

foreach ($c in $candidates) {
    if ((Test-Path $c) -and ((Get-Item $c).Length -gt 1MB)) {
        $bunExe = $c
        break
    }
}

if (-not $bunExe) {
    # Fall back to PATH lookup, but skip any node_modules\.bin entry (those are shims).
    $found = Get-Command bun.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notmatch 'node_modules\\.bin' -and (Get-Item $_.Source).Length -gt 1MB } |
        Select-Object -First 1
    if ($found) { $bunExe = $found.Source }
}

if (-not $bunExe) {
    Write-Error 'Could not locate the real bun.exe. Install Bun system-wide or set $env:BUN_INSTALL.'
    exit 3
}

# Prepend workspace node_modules/.bin so inner `$\`tsc\`` / `$\`tsup\`` calls resolve.
$workspaceBin = Join-Path $repoRoot 'node_modules\.bin'
$pkgBin = Join-Path $pkgDir 'node_modules\.bin'
$prefix = @($pkgBin, $workspaceBin) -join ';'
$env:PATH = "$prefix;$env:PATH"

Push-Location $pkgDir
try {
    & $bunExe ./build.ts
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
