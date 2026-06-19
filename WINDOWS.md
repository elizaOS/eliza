# Windows Support
elizaOS is developed against Bun, Node 24, and ESM-only packages. Windows is a
supported contributor platform when the same toolchain is available, but most CI
coverage runs on Linux first. Prefer WSL2 for day-to-day development because it
matches the production and GitHub Actions environment most closely.

## Recommended Setup

1. Install WSL2 with Ubuntu 24.04 or newer.
2. Install Bun from inside WSL2 and use the pinned `packageManager` version from
   `package.json`.
3. Install Node 24 in the same WSL2 environment.
4. Clone the repository inside the WSL filesystem, not under `/mnt/c`, so
   workspace installs and Turbo cache operations do not pay the Windows file
   bridge cost.
5. Run `bun install`, then `bun run verify` before opening a pull request.

## Native Windows

Native PowerShell is useful for quick CLI checks and install-script testing, but
the monorepo has packages that depend on POSIX shell behavior, symlinks, native
toolchains, and browser automation. When a command behaves differently on native
Windows, reproduce it under WSL2 before treating it as a repo bug.

## Script Policy

The public Windows installer lives at `packages/homepage/public/install.ps1`.
Keep it in sync with the Unix installer where the install flow is equivalent,
and call out intentional platform differences in comments near the branch that
handles them. Installer security issues are in scope for `SECURITY.md` because
these scripts bootstrap user machines.

## Why

This repo ships the runtime, dashboard, cloud surfaces, native bridges, and
first-party plugins from one workspace. WSL2 keeps contributors on Windows close
to the same filesystem, process, and shell model that CI and deployment use,
which makes failures easier to reproduce and avoids Windows-only drift.
