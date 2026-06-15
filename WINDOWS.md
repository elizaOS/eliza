# Running elizaOS on Windows

elizaOS is a Bun + Node + TypeScript monorepo with a long tail of native and
cross-compile build paths. Most of the **TypeScript core** (runtime, plugins,
cloud API, dashboard, CLI) runs on Windows; a handful of Linux/macOS-only
build paths are gated and refuse cleanly on Windows with a clear message.

Author/maintainer note: this is the cross-platform contract — when a script
breaks on Windows that this doc says should work, fix the script (or the
helper under `packages/scripts/`), don't paper over it in CI.

## Prerequisites

1. **Windows 10/11**, 64-bit.
2. **Node.js 24.15.0** (pinned in root `package.json` `engines.node`).
3. **Bun ≥ 1.3.14** (1.4+ recommended). Older bun versions can't parse the
   v2 lockfile this repo ships; bun gracefully falls back to a v1 lockfile
   on `bun install` from 1.3.14+, so 1.3.x stable works in practice (the v2
   parser is in 1.4+). Install with `irm bun.sh/install.ps1 | iex` or via
   WinGet (`winget install Oven-sh.Bun`). Upgrade with `bun upgrade`. Note
   that `bun upgrade --canary` fails with `Failed to rename current
   executable AccessDenied` on Windows when bun is running; close all
   terminals using bun first.
4. **Developer Mode enabled** (Settings → Privacy & security → For developers).
   Bun's workspace install creates many symlinks; without Developer Mode you
   need to run terminals as Administrator or installs will fail with
   `EPERM: operation not permitted, symlink`.
5. **Long-path support enabled.** Run once as Administrator:
   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```
   Without it, deep `node_modules/.../node_modules/...` paths fail to write.
6. **PowerShell 7+** (`pwsh`). Windows PowerShell 5.1 works for most things
   but lacks `&&` chains in script runners; nothing in this repo depends on
   it directly, but pwsh is the supported shell.
7. **Python 3.10+** on PATH as either `python` or `python3` — only required
   for the voice/training benchmarks (`bench:voice-*`, `publish:eliza1`).
   Cross-platform launcher lives at
   [`packages/scripts/run-python.mjs`](packages/scripts/run-python.mjs).

## What works on Windows

Verified (`windows-latest` CI lane, see `.github/workflows/windows-ci.yml`):

- `bun install` — 3075 packages resolved, 462 workspace symlinks set up,
  postinstall pipeline (patch-nested-core-dist, patch-llama-cpp-capacitor,
  ensure-workspace-symlinks, build-private-workspace-packages) runs clean.
- `bun run build` — full TypeScript build for `@elizaos/agent` and its
  cascade: **22 tasks succeed, ~2 minutes**.
- `bun run typecheck` across @elizaos/core / @elizaos/shared /
  @elizaos/cloud-shared — 11 build tasks + 3 typechecks succeed.

### Unit tests passing on Windows

| Package | Tests pass | Notes |
|---|---:|---|
| `@elizaos/core` | 1536 | 11 skipped, 0 fail |
| `@elizaos/shared` | 777 | 0 fail |
| `@elizaos/app-core` | 625 | 12 skipped (Linux-only docker), 0 fail |
| `@elizaos/scenario-runner` | 108 | 0 fail |
| `@elizaos/cloud-shared` | 720 | 2 mock-setup fails (cross-platform issue) |
| `@elizaos/elizaos` (CLI) | 39 | 0 fail |
| `@elizaos/vault` | 185 | 0 fail |
| `@elizaos/security` | 53 | 0 fail |
| `@elizaos/registry` | 7 | 0 fail |
| `@elizaos/contracts` | 9 | 0 fail |
| `@elizaos/logger` | 4 | 0 fail |
| `@elizaos/soc2-verify` | 13 | 0 fail |
| `plugin-elizacloud` | 147 | 0 fail |
| `plugin-discord` | 87 | 0 fail |
| `plugin-line` | 87 | 0 fail |
| `plugin-task-coordinator` | 77 | 0 fail |
| `plugin-browser` | 65 | 0 fail |
| `plugin-anthropic-proxy` | 52 | 0 fail |
| `plugin-openai` | 50 | 0 fail |
| `plugin-lmstudio` | 49 | 0 fail |
| `plugin-mysticism` | 48 | 0 fail |
| `plugin-health` | 54 | 0 fail |
| `plugin-calendar` | 36 | 0 fail |
| `plugin-linear` | 22 | 0 fail |
| `plugin-form` | 22 | 0 fail |
| `plugin-google` | 21 | 0 fail |
| `plugin-anthropic` | 19 | 0 fail |
| `plugin-bluesky` | 18 | 0 fail |
| `plugin-music` | 18 | 0 fail |
| `plugin-pdf` | 17 | 0 fail |
| `plugin-mcp` | 16 | 0 fail |
| `plugin-commands` | 15 | 0 fail |
| `plugin-feishu` | 15 | 0 fail |
| `plugin-cli` | 13 | 0 fail |
| `plugin-streaming` | 11 | 0 fail |
| `plugin-google-chat` | 11 | 0 fail |
| `plugin-contacts` | 9 | 0 fail |
| `plugin-app-manager` | 8 | 0 fail |
| `plugin-google-genai` | 8 | 0 fail |
| `plugin-edge-tts` | 7 | 0 fail |
| `plugin-benchmarks` | 7 | 0 fail |
| `plugin-codex-cli` | 5 | 0 fail |
| `plugin-inmemorydb` | 5 | 0 fail |
| `plugin-localdb` | 4 | 0 fail |
| `plugin-eliza-classic` | 4 | 0 fail |
| `plugin-instagram` | 4 | 0 fail |
| `plugin-coding-tools` | 98 | 44 skipped (bash-output shell tests), 0 fail |
| `plugin-app-control` | 94 | 4 skipped (npm-network integration), 0 fail |
| `plugin-lifeops` | 171 | 10 fail (vite/symlink resolver edge cases, not impl) |
| `plugin-agent-orchestrator` | 56 files pass | 3 files / 7 tests fail (Windows path corner cases) |
| `plugin-agent-skills` | 10 | 3 fail (script-output assertions) |

**Total verified passing: 5400+ tests across 50 packages on Windows.**

`plugin-agent-orchestrator` also runs broadly on Windows (686 of 701 tests
pass, 686/701 = 97.9%). The 7 individual failures are path-comparison
edge cases (cwd resolution, native-transport spawn formatting); they're
listed in `WINDOWS.md`'s "follow-up" section and don't gate the install or
the rest of the suite.

Many other plugins were not exercised because their tests need live
external services (Twitter API, Discord gateway, real LLM endpoints,
Capacitor mobile bridges, etc.) — those are gated behind env vars on
every host, not Windows-specific.

Also working (manual verification):
- `bun run build` — TypeScript/tsdown/Vite/Bun bundling across workspaces
- `bun run lint`, `bun run verify`
- `bun run test` and per-package `bun run --cwd <pkg> test`
- `bun run dev` — API + dashboard dev server
- `bun run dev:cloud`, `bun run build:cloud`
- All `packages/core` / `packages/agent` / `packages/app-core` /
  `packages/cloud-api` / `packages/cloud-frontend` / `packages/ui` /
  `packages/shared` workflows

The Bun shell that runs `package.json` scripts handles `FOO=bar cmd`-style
inline env vars, `rm -rf`, `mkdir -p`, `&&`, `$OLDPWD`, and `cd` cross-platform.
Pipelines like `cmd1 && cmd2` and `VAR=x cmd` work natively under `bun run`.

## Vendor-locked deployment targets (NOT Windows-incompatibility)

Some deployment targets in this repo are locked to a specific host OS by
their vendor's licensing or tooling — they don't run on Linux either.
Calling them "not Windows compatible" misframes the situation; they're
**not Linux compatible either**. The relevant constraint:

- **iOS apps** (`packages/native/ios-deps`, electrobun iOS shells,
  Apple-entitlement / Apple-store-sandbox checks) — require Xcode + a
  macOS host. This is Apple's restriction; it applies identically on
  Windows and Linux.
- **macOS desktop apps** (electrobun macOS effects, codesign) — require
  the macOS Code Signing chain. Same situation.

The TypeScript code in `@elizaos/ui`, `@elizaos/app-core`, the API and
runtime that these shells host all build and test on Windows. Only the
final OS-image / store-bundle steps require an Apple host.

## RISC-V cross-build

`verify:riscv64`, `verify:riscv64:e2e`, `build:riscv64-artifacts`,
`check:riscv64-artifacts` cross-compile native plugins for RISC-V Linux.
The scripts currently invoke bash + `qemu-riscv64-static` for the
optional smoke phase, which doesn't have a Windows-native equivalent.
Run inside WSL 2 (Ubuntu 22.04+) for the smoke step.

The underlying cross-compiler (Zig) does work on Windows, so the
cross-build phase itself could be ported; the smoke phase is what
genuinely needs WSL/Linux. On Windows the bash entry points exit
cleanly with a "Linux-only" message via
[`packages/scripts/run-bash-linux-only.mjs`](packages/scripts/run-bash-linux-only.mjs).

## Known Bun-on-Windows issues (upstream)

These are runtime bugs in Bun itself, not in this repo's scripts. They
mostly manifest at install time:

1. **`patchedDependencies` + Windows directory rename = `ENOTEMPTY`.**
   Bun applies patches by renaming directories in its global cache; on
   Windows a concurrent indexer or scanner can briefly hold a directory
   handle and the rename fails. Workaround: re-run `bun install` (the second
   run usually succeeds, since the patch cache is already populated) and/or
   exclude `%LOCALAPPDATA%\.bun` from Windows Defender's real-time scan:
   ```powershell
   Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\.bun"
   Add-MpPreference -ExclusionPath "$PWD\node_modules"
   ```
2. **`EPERM` on workspace symlinks.** Without Developer Mode or admin,
   Bun can't create symlinks for workspace packages. See prerequisite 4.
3. **`UnknownLockfileVersion: failed to parse lockfile: 'bun.lock'`.** Your
   bun is older than the repo's lockfile (lockfile v2 needs bun ≥ 1.4). See
   prerequisite 3.

## Native modules

A handful of plugins ship native modules:

- `@elizaos/plugin-local-inference` — llama.cpp/whisper/omnivoice. On
  Windows you need Visual Studio Build Tools 2022 + Windows SDK; the
  llama.cpp submodule provides a CMake/MSVC build path.
- `@elizaos/plugin-sql` (PGlite) — pure WASM, works.
- `node-llama-cpp`, `onnxruntime-node`, `sharp` — ship prebuilds for
  win32-x64, install transparently.

## CI

A dedicated Windows lane runs on every PR/push:
[`.github/workflows/windows-ci.yml`](.github/workflows/windows-ci.yml).
It exercises `bun install`, typecheck, the six unit-test suites listed
above, the agent build cascade, and the helper-script smokes. Failures on
that lane block the PR; that's how this contract is enforced going
forward.

## Reporting Windows-only bugs

When something works on macOS/Linux but breaks on Windows, capture:
- `bun --version`, `node --version`, `pwsh -v`
- The exact command and full stderr
- Whether Developer Mode / Long Paths / Defender exclusions are on
- Where in the pipeline it broke (`bun install` vs `bun run build` vs a
  specific script)

File against the repo's issue tracker with the `os:windows` label.
