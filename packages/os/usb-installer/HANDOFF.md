# elizaOS USB Installer Handoff

Last updated: 2026-05-20

## Current Branch

- Repository: `elizaOS/eliza`
- Worktree used for the latest proof: `/home/nubs/Git/iqlabs/elizaos-usb-prod-e2e`
- Branch: `nubs/messylinux-cloud-e2e-hardening`
- Previous PR #7803: https://github.com/elizaOS/eliza/pull/7803 (merged)
- Follow-up PR #7825: https://github.com/elizaOS/eliza/pull/7825
- Verified local base: `origin/develop@27d4aee89417a4fc921c2c39ae7bd6fa3bdb9c82`
- Latest PR head locally validated: `7497cf6c6b5e787df1ddc71ef49844cf7283c4a0`
- Latest local CI-fix validation: 2026-05-20 05:13 UTC

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
- PR #7803 is pushed and current with `origin/develop` as of the verified head.
- GitHub checks must still be treated as source of truth for mergeability; the
  last local pass below validates the USB installer and the root build path that
  previously failed in CI.
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
- Additional Linux virtual block-device proof added on 2026-05-19:
  - `src/__tests__/linux-virtual-block-device-e2e.test.ts` is opt-in through
    `bun run --cwd packages/os/usb-installer test:linux-virtual-usb`;
  - requires Linux, passwordless `sudo -n`, and kernel `scsi_debug`;
  - creates a disposable 64 MiB removable block device with model
    `ELIZAUSBTEST` and refuses to run if `scsi_debug` is already loaded;
  - exercises real `lsblk`, the local HTTP handler, server-owned `planId`,
    execute-time revalidation, checksum validation, Linux backend write flow,
    `sudo -n dd`, `sync`, SSE completion events, and readback SHA-256
    verification from the virtual block device;
  - unloads `scsi_debug` in cleanup.
- Final local validation on PR head `d3eb80c11e` after the fake-media,
  browser, virtual block-device, and latest-`develop` merge proofs:
  - `bun install --frozen-lockfile` passed with no package/lockfile changes;
  - `bun run --cwd plugins/plugin-local-inference build` passed through the
    current `bun run build.ts` path;
  - `bun run build:core` passed: 38 tasks successful, including
    `@elizaos/plugin-local-inference`;
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 76 tests,
    with the opt-in virtual block-device test skipped by default;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer lint` passed across `src`,
    `tests`, `server.ts`, and config files;
  - `bun run --cwd packages/os/usb-installer test:e2e` passed: 6 Playwright
    tests covering desktop/mobile render and guarded wizard success flow;
  - `bun run --cwd packages/os/usb-installer test:linux-virtual-usb` passed
    against `scsi_debug`: wrote with `sudo -n dd`, read back, SHA-256 matched,
    and module cleanup was verified;
  - `git diff --check` passed.
- Follow-up local validation on 2026-05-19 after isolating package-wide cloud
  test mocks that failed CI:
  - `bun run verify:cloud` passed;
  - `bun run test:cloud` passed: 266 tests across 28 files;
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 76 tests,
    with the opt-in virtual block-device test skipped by default;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer lint` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer test:e2e` passed: 6 Playwright
    tests covering desktop/mobile render and guarded wizard success flow;
  - `bun run --cwd packages/os/usb-installer test:linux-virtual-usb` passed
    against `scsi_debug`, and cleanup left `scsi_debug` unloaded;
  - `git diff --check` passed.
- Additional USB hardening added after the read-only audit:
  - Linux drive enumeration now asks `lsblk` for `MOUNTPOINTS` and blocks
    removable media mounted as `/`, `/boot`, `/boot/efi`,
    `/run/live/medium`, `/run/live/persistence`, or `/live/medium`, preventing
    a live-boot USB from overwriting itself;
  - stored live-write `planId`s expire after five minutes by default
    (`ELIZAOS_USB_PLAN_TTL_MS`);
  - browser origins are now exact-match app/dev origins instead of any
    localhost port, with `ELIZAOS_USB_ALLOWED_ORIGINS` for explicit additions;
  - UI copy no longer claims Linux/Windows eject or readback behavior that the
    current backends do not perform;
  - OS release CI and the Linux release-packaging path now run Playwright E2E
    and run the opt-in `scsi_debug` virtual block-device proof when the runner
    kernel provides that module.
- Additional cloud mock-stack E2E hardening added on 2026-05-20:
  - fixed the cloud E2E repo-root resolution so the PGlite TCP bridge script
    resolves from the repository root, not `packages/`;
  - replaced the stale in-process control-plane mock with the real
    `container-control-plane` sidecar and a guarded in-memory sandbox provider
    that only activates under `NODE_ENV=test` or `CLOUD_E2E=1`;
  - added a Node-hosted cloud-api Worker fetch adapter for the E2E harness so
    CI exercises the generated router, real API routes, DB queue, and sidecar
    forwarder without depending on Wrangler local runtime;
  - fixed Node fetch forwarding for request bodies by setting `duplex: "half"`;
  - added process-level DB pool cleanup before the fixture stops PGlite;
  - moved best-effort per-agent API-key revocation out of the sandbox delete
    transaction and made revocation a single delete-returning operation;
  - updated provision/deprovision/stuck-cleanup specs to create real agents,
    drive the real provisioning queue, and assert externally visible states.
- Post-merge validation on 2026-05-20 after merging
  `origin/develop@c73f1768b6`:
  - `bun run verify:cloud` passed;
  - `bun run test:cloud` passed: 266 tests across 28 files;
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 80 tests,
    with the opt-in virtual block-device test skipped by default;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer lint` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer test:e2e` passed: 6 Playwright
    tests;
  - `bun run --cwd packages/os/usb-installer test:linux-virtual-usb` passed
    with `scsi_debug` cleanup verified;
  - `git diff --check` passed.
- Final local validation on 2026-05-20 after the mock-stack E2E harness fix:
  - `bun run --cwd packages/cloud-shared typecheck` passed;
  - `bun run --cwd packages/cloud-api typecheck` passed;
  - `bun run --cwd packages/cloud-api lint` passed;
  - `bun test packages/cloud-api/webhooks/bluebubbles/route.test.ts` passed:
    10 tests;
  - `bun run --cwd packages/cloud-services/container-control-plane typecheck`
    passed;
  - `bun run --cwd packages/test/cloud-e2e typecheck` passed;
  - `bun run --cwd packages/cloud-shared lint` passed;
  - `bun run cloud:e2e` passed: 4 Playwright tests covering onboarding,
    provision, deprovision, and stuck cleanup against PGlite, cloud-api,
    cloud-frontend, the real control-plane sidecar, and the guarded memory
    sandbox provider;
  - `bun run --cwd packages/cloud-api test -- --runInBand` passed: 44 tests;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 80 tests,
    with the opt-in virtual block-device test skipped by default;
  - `bun run --cwd packages/os/usb-installer lint` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer test:e2e` passed: 6 Playwright
    tests;
  - `bun run --cwd packages/os/usb-installer test:linux-virtual-usb` passed
    against `scsi_debug`;
  - `git diff --check` passed.
- Follow-up local validation on 2026-05-20 after rebasing PR #7825 onto
  `origin/develop@27d4aee894`:
  - `bun run --cwd packages/cloud-shared typecheck` passed;
  - `bun run --cwd packages/cloud-shared lint` passed;
  - `bun run --cwd packages/cloud-api typecheck` passed;
  - `bun run --cwd packages/test/cloud-e2e typecheck` passed;
  - `bun run cloud:e2e` passed: 4 Playwright tests covering onboarding,
    provision, deprovision, and stuck cleanup against PGlite, cloud-api,
    cloud-frontend, the real control-plane sidecar, and the guarded memory
    sandbox provider;
  - `bun run test:cloud` passed: 279 tests across 30 files;
  - `bun run --cwd packages/os/usb-installer typecheck` passed;
  - `bun run --cwd packages/os/usb-installer test` passed: 9 files, 80 tests,
    with the opt-in virtual block-device test skipped by default;
  - `bun run --cwd packages/os/usb-installer lint` passed;
  - `bun run --cwd packages/os/usb-installer build` passed;
  - `bun run --cwd packages/os/usb-installer test:e2e` passed: 6 Playwright
    tests;
  - `bun run --cwd packages/os/usb-installer test:linux-virtual-usb` passed
    against `scsi_debug`;
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
- The Linux virtual block-device E2E proves the same path against a real kernel
  block device, but it is still not a replacement for physical USB flash/boot
  validation with a final ISO.
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
- Keep visual branding white/blue and use official shared elizaOS logo assets.
  Avoid orange/black-heavy shell styling.

## Useful Commands

From repo root:

```bash
bun run --cwd packages/os/usb-installer test
bun run --cwd packages/os/usb-installer typecheck
bun run --cwd packages/os/usb-installer build
bun run --cwd packages/os/usb-installer lint
bun run --cwd packages/os/usb-installer test:e2e
bun run --cwd packages/os/usb-installer test:linux-virtual-usb
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
