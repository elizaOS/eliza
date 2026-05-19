# elizaOS USB Installer Handoff

Last updated: 2026-05-19

## Current Branch

- Repository: `elizaOS/eliza`
- Worktree: `/home/nubs/Git/iqlabs/elizaos-final-ship-build`
- Branch: `nubs/elizaos-live-prod-hardening-20260519`
- PR: https://github.com/elizaOS/eliza/pull/7803

## What This Package Is

`packages/os/usb-installer` is the desktop installer used to prepare a bootable
elizaOS USB drive from the normal desktop app stack. It is an Electrobun/Vite
microapp with a browser renderer and a local backend server. The renderer must
never open raw disks directly; all drive enumeration and destructive writes stay
behind the backend contract and future signed/elevated helpers.

## Current Verified State

- The package exists under `packages/os/usb-installer`.
- CI has wiring for lint/typecheck/test/build/package in:
  - `.github/workflows/elizaos-os-release.yml`
  - `.github/workflows/release-usb-installer.yml`
- PR #7803 is pushed and mergeable as of the last check.
- The broader PR has many passing checks, including OS release surface
  validation, LifeOps bench lanes, client/server tests, e2e/playwright, mobile
  builds, Electrobun desktop contract, package validation, and CodeQL.
- Remaining PR checks at the last check were slow GitHub runners only:
  `Plugin Tests`, `Build production Docker image (+ smoke boot)`,
  `Windows smoke`, `desktop preload preflight (windows)`, and one Python
  `unit-tests` lane.
- USB installer work in this pass added:
  - `src/backend/write-safety.ts` shared live-write guard;
  - `WritePlan.planId` and `WriteRequest.expectedDrive`;
  - localhost-only server origin handling;
  - `127.0.0.1` backend binding;
  - `ELIZAOS_USB_ENABLE_RAW_WRITE=1` live-write feature gate;
  - server-side plan ID storage and execute-time plan reconstruction;
  - UI target device-path confirmation;
  - README rewrite to match reality.
- Additional fake-media proof added on 2026-05-19:
  - `src/__tests__/linux-fake-media-e2e.test.ts` creates a tiny fake ISO and a
    fake USB target file under `/tmp`;
  - calls the local HTTP handler `/plan` and `/execute` with the Linux backend;
  - exercises the raw-write gate, server-owned `planId`, execute-time
    revalidation, checksum validation, Linux backend write flow, real `dd`,
    `sync`, SSE completion events, and final byte-for-byte/hash verification;
  - never touches a real block device.
- Local validation after that E2E test:
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 76 tests;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer lint` passed;
  - `git diff --check` passed.
- Disk cleanup on 2026-05-19:
  - removed ignored/generated stale ISO artifacts and root `dist/`;
  - removed inactive `/tmp/eliza-pr7803` temp checkout after confirming no
    process referenced it;
  - did not remove chroots, apt caches, worktrees, node modules inside the repo,
    or anything needed for future builds.

## Important Corrections From The Session

The old mental model "USB installer is dry-run only" is stale. The package has
platform backend files for Linux, macOS, and Windows:

- `src/backend/linux-backend.ts`
- `src/backend/macos-backend.ts`
- `src/backend/windows-backend.ts`

However, the README and tests still mostly describe/test the dry-run backend,
so the package needs hardening before we call it production-ready.

## USB Installer Goals

- One app that a normal user can use to flash elizaOS to a USB stick.
- Keep destructive writes out of the renderer.
- Re-detect the target drive server-side immediately before writing.
- Require explicit data-loss acknowledgement and block internal/system disks.
- Verify release metadata and SHA-256 before writing.
- Refuse live writes when the image checksum is missing or a placeholder.
- Use standard platform mechanisms:
  - Linux: `lsblk`, unmount mounted partitions, `pkexec`/`sudo`/`doas` + `dd`.
  - macOS: `diskutil`, `/dev/rdiskN`, `osascript` administrator prompt.
  - Windows: PowerShell/Get-Disk, UAC elevation, raw `\\.\PhysicalDriveN`
    write path.
- Bind any local backend only to localhost and reject untrusted browser origins.
- Treat physical USB flashing and platform-specific write helpers as destructive
  operations that require explicit manual/VM/hardware proof.

## Known Gaps To Close

- Physical USB proof is still separate. Do not call this hardware-proven until
  a final ISO has been written to removable media and booted.
- The Linux fake-media E2E proves the guarded server/backend write path safely,
  but it is not a replacement for a physical USB flash/boot test.
- `HttpUsbInstallerBackend.executeWritePlan` now handles fragmented SSE chunks,
  but cancel/abort support is still missing.
- macOS and Windows live-write helpers are still prototype-grade compared with
  a signed helper architecture.
- GitHub release scraping still synthesizes placeholder checksums. Live writes
  now reject those placeholders; production needs an official signed manifest.
- Tests still need broader UI component coverage and platform write-sequence
  coverage for macOS/Windows mocked subprocesses.
- UI copy is still too macOS-specific in places and should adapt to the
  selected drive platform.
- Visual branding should be white/blue, clean, and use official shared elizaOS
  logo assets. Avoid orange/black-heavy shell styling.

## Useful Commands

From repo root:

```bash
bun run --cwd packages/os/usb-installer test
bun run --cwd packages/os/usb-installer typecheck
bun run --cwd packages/os/usb-installer build
bun run --cwd packages/os/usb-installer lint
bun run --cwd packages/os/usb-installer test:e2e
```

Run the dev app locally:

```bash
bun run --cwd packages/os/usb-installer start
```

## Safety Rule

Do not claim physical USB readiness from code review alone. "Code-ready" means
tests/build/docs pass and the safety model is sound. "USB-proven" means a final
ISO was written to a real removable drive and boot-tested, or each platform was
tested in the appropriate VM/hardware environment.
