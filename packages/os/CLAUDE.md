# @elizaos/distro-os

OS distribution assets for elizaOS: the elizaOS Live Linux USB distro (`linux/`) and the elizaOS AOSP Android fork (`android/`). This is a private, non-publishable package — it ships no JS runtime or exports consumed by other packages in the monorepo.

## Purpose

Provides the full OS-level distribution layer for elizaOS:

- **elizaOS Live** — a Tails-derived Debian live-build USB distro (amd64/arm64/riscv64) with GNOME desktop, the bundled elizaOS Electrobun app, amnesia/persistence boot modes, and optional Tor Privacy Mode.
- **elizaOS AOSP** — an Android vendor overlay tree targeting Pixel devices and Cuttlefish emulator, with custom launcher, boot animation, sepolicy, and privileged-app permissions.
- **Installer tooling** — cross-platform USB flasher (`usb-installer/`) and AOSP ADB/fastboot flasher (`setup/`), each as standalone Electrobun microapps.
- **Release pipeline** — manifest schema, validation scripts, checksum generation, and TEE/confidential-compute scaffolding (`scripts/`, `release/`).

No other `@elizaos/*` package imports from here at runtime. The installer subpackages (`@elizaos/os-usb-installer`, `@elizaos/setup`) are standalone apps distributed separately.

## Layout

```
packages/os/
  package.json                 @elizaos/distro-os (private, no scripts)
  README.md                    human-facing overview
  CLAUDE.md / AGENTS.md        this file

  linux/                       elizaOS Live — canonical Debian fork
    Justfile                   build recipes (just build, just boot, just usb-write …)
    Dockerfile / build.sh      containerised ISO build entry point
    build-iso.sh               inner ISO assembly script
    tails/                     upstream Tails live-build tree (plumbing, AppArmor, persistence)
    elizaos/                   elizaOS overlay on top of Tails live-build
      config/
        hooks/normal/          chroot hooks (agent install, branding, graphical session)
        package-lists/         per-arch .list.chroot package lists
        includes.chroot/       files dropped into the live image chroot
    crates/elizad/             Rust-based elizad system daemon (gen/ only so far)
    scripts/                   build helpers (prepare-elizaos-app-overlay.mjs, usb-write.sh …)
    schemas/                   JSON schemas: model-catalog, update-manifest
    docs/                      engineering docs (status, release planning, security, runtime packaging …)
    vm/                        VM artifact scripts (output/, scripts/)
    confidential/              TEE/confidential-compute profile (Yocto scaffold, BLOCKED)

  android/                     elizaOS AOSP fork
    Makefile                   build entry (make build ARCH=x86_64|arm64|riscv64)
    vendor/eliza/               elizaOS brand vendor tree
      AndroidProducts.mk
      apps/Eliza/              privileged launcher Android.bp
      bootanimation/           desc.txt + generation scripts
      init/init.eliza.rc
      overlays/                resource overlays
      permissions/             privapp-permissions + default-permissions XMLs
      products/                per-arch lunch target .mk files
      sepolicy/                file_contexts + eliza_agent.te SELinux policy
    installer/
      install-elizaos-android.sh  ADB/fastboot flash script
      install-elizaos-android.ps1 Windows equivalent
      manifests/               device flash manifests
      docs/
      scripts/
    system-ui/                 AOSP SystemUI fork (TypeScript, private package)
    scripts/                   boot animation generators (generate-eliza-bootanimation.mjs)

  setup/                       @elizaos/setup — Electrobun AOSP flasher UI
    src/
      index.ts                 exports: FlasherApp, AdbFlasherBackend, MOCK_BUILDS, types
      backend/                 ADB/fastboot backend (types.ts, adb-backend.ts)
      components/FlasherApp    React flasher UI
      runtime/ / dependencies/ / main/

  usb-installer/               @elizaos/os-usb-installer — Electrobun USB flasher UI
    src/
      index.ts                 exports: InstallerApp, platform backends, types, DEFAULT_ELIZAOS_IMAGES
      backend/                 platform backends (linux-, macos-, windows-backend.ts, write-safety.ts)
      components/InstallerApp  React installer UI
    server.ts                  local HTTP backend (127.0.0.1 only)

  shared-system/               @elizaos/os-shared-system — shared TS interfaces
    src/index.ts               WifiState, AudioState, BatteryState, CellState, SystemTime,
                               SystemControls, SystemProvider

  scripts/                     Release pipeline scripts (node/ESM, no package.json)
    os-release-lib.mjs         shared helpers: validateManifest, readJson, parseArgs, repoRoot
    generate-os-homepage-data.mjs  reads a release manifest → homepage TS artifact list
    validate-release-manifest.mjs  validates a manifest against release schema
    generate-release-checksums.mjs
    update-release-manifest.mjs
    update-manifest-checksums.mjs
    verify-release-checksums.mjs
    verify-image-reproducibility.mjs
    verify-release.sh           end-to-end release verification entry point
    generate-tee-measurements.mjs
    validate-tee-measurements.mjs
    generate-confidential-artifacts.mjs
    check-confidential-*.mjs    TEE policy/layer/manifest/profile checkers
    confidential-enforcement-map.mjs  TEE enforcement map helpers
    tee-evidence-bridge.mjs     TEE evidence bridge
    tee-state-volume-mount.mjs  TEE state volume mount helpers
    collect-release-evidence.mjs
    check-dstack-pins.mjs
    json-schema-lite.mjs        lightweight JSON schema validator used by release scripts
    __tests__/                  test files for release scripts

  release/
    schema/                    JSON schemas: confidential-image-manifest, confidential-policy, dstack-pins
    VERIFY.md                  release verification docs
    beta-2026-05-16/manifest.json   configured default manifest path in os-release-lib.mjs (not yet created; create when cutting a release)

  docs/                        Engineering notes (TEE plan, CI/CD production plan, release plan, apt repo)
```

## Key exports / surface

This package itself has no JS exports — `"private": true`, no `scripts` in the root `package.json`.

Sub-packages that do export:

| Sub-package | npm name | Entry | Key exports |
|---|---|---|---|
| `usb-installer/` | `@elizaos/os-usb-installer` | `src/index.ts` | `InstallerApp`, `createPlatformBackend`, `LinuxUsbInstallerBackend`, `MacOsUsbInstallerBackend`, `WindowsUsbInstallerBackend`, `DryRunUsbInstallerBackend`, `DEFAULT_ELIZAOS_IMAGES`, types |
| `setup/` | `@elizaos/setup` | `src/index.ts` | `FlasherApp`, `AdbFlasherBackend`, `MOCK_BUILDS`, types |
| `shared-system/` | `@elizaos/os-shared-system` | `src/index.ts` | `SystemProvider`, `WifiState`, `AudioState`, `BatteryState`, `CellState`, `SystemTime`, `SystemControls` |

## Commands

Commands are defined per sub-package; run from repo root:

```bash
# USB Installer
bun run --cwd packages/os/usb-installer dev
bun run --cwd packages/os/usb-installer build
bun run --cwd packages/os/usb-installer clean
bun run --cwd packages/os/usb-installer test
bun run --cwd packages/os/usb-installer test:linux-virtual-usb
bun run --cwd packages/os/usb-installer test:e2e
bun run --cwd packages/os/usb-installer lint
bun run --cwd packages/os/usb-installer lint:check
bun run --cwd packages/os/usb-installer format:check
bun run --cwd packages/os/usb-installer server           # local backend on 127.0.0.1
bun run --cwd packages/os/usb-installer package:darwin
bun run --cwd packages/os/usb-installer package:linux
bun run --cwd packages/os/usb-installer package:win32

# AOSP Flasher (setup)
bun run --cwd packages/os/setup build
bun run --cwd packages/os/setup clean
bun run --cwd packages/os/setup test
bun run --cwd packages/os/setup lint:check
bun run --cwd packages/os/setup format:check
bun run --cwd packages/os/setup package:mac
bun run --cwd packages/os/setup package:linux
bun run --cwd packages/os/setup package:windows

# Linux ISO (requires Docker, from packages/os/linux/)
just build                     # full clean ISO → out/
just build-cool                # low-CPU build, skips offline docs
just build-demo                # fastest demo build
just boot                      # boot latest ISO in QEMU
just usb-write /dev/sdX        # guarded write to removable block device
just static-smoke              # config/syntax checks, no Docker

# AOSP (from packages/os/android/)
make build ARCH=x86_64         # build + launch + boot-validate Cuttlefish
make build ARCH=arm64
make build ARCH=riscv64
make sim   ARCH=riscv64        # validate already-built image
make bootanimation             # render + pack elizaOS boot splash

# Release pipeline scripts (node, from repo root)
node packages/os/scripts/validate-release-manifest.mjs --manifest packages/os/release/beta-2026-05-16/manifest.json
node packages/os/scripts/generate-os-homepage-data.mjs --manifest ... --output ...
node packages/os/scripts/generate-release-checksums.mjs
bash packages/os/scripts/verify-release.sh path/to/downloads
node packages/os/scripts/generate-confidential-artifacts.mjs
```

## Config / env vars

### Linux ISO build (Justfile / build.sh)

| Variable | Default | Purpose |
|---|---|---|
| `ELIZAOS_ARCH` | `amd64` | Target architecture: `amd64`, `arm64`, `riscv64` |
| `ELIZAOS_PROFILE` | `default` | live-build profile: `default`, `gui`, `secure`, `secure-gui` |
| `ELIZAOS_BUILD_CPUS` | (unlimited) | Cap Docker CPU count |
| `ELIZAOS_MKSQUASHFS_PROCESSORS` | (unlimited) | Cap squashfs compression parallelism |
| `ELIZAOS_BUILD_MEMORY` | (unlimited) | Docker memory limit, e.g. `8g` |
| `ELIZAOS_SKIP_WEBSITE` | `1` in cool builds | Skip offline docs bundle |
| `ELIZAOS_BUILD_APP` | unset | Set to `1` to allow rebuilding the Electrobun app artifact |
| `ELIZAOS_APP_ARTIFACT` | `packages/app-core/platforms/electrobun/build/dev-linux-x64/elizaOS-dev` | Path to pre-built app |

### USB Installer server

| Variable | Purpose |
|---|---|
| `ELIZAOS_USB_ENABLE_RAW_WRITE` | Set to `1` to enable live disk writes (off by default) |
| `ELIZAOS_USB_ALLOWED_ORIGINS` | Extra allowed browser origins for the local backend |
| `ELIZAOS_USB_TEST_SCSI_DEBUG` | Set to `1` for virtual block device e2e test |

### AOSP build

| Variable | Default | Purpose |
|---|---|---|
| `AOSP_ROOT` | `$HOME/aosp` | Path to synced AOSP source checkout |
| `ARCH` | `x86_64` | Target arch passed to `make` |

## How to extend

### Add a live-build chroot hook (Linux)

1. Create a numbered shell script in `linux/elizaos/config/hooks/normal/`, e.g. `0040-my-feature.hook.chroot`.
2. The hook runs inside the chroot during build — use `apt-get`, `install`, `systemctl enable`, etc.
3. Test with `just nspawn` (boots the chroot, no full ISO rebuild).

### Add a package to the Linux ISO

Edit the relevant `linux/elizaos/config/package-lists/*.list.chroot` file. Use arch-conditional guards (`#if ARCHITECTURES amd64 … #endif`) for arch-specific packages.

### Add a new release manifest artifact kind

1. Update `release/schema/` JSON schema files.
2. Update `scripts/os-release-lib.mjs` (`artifactKinds` Set, `validateManifest` logic).
3. Update `scripts/generate-os-homepage-data.mjs` (`manifestKindToArtifactKind` mapping).

### Add a USB backend platform

1. Create `usb-installer/src/backend/<platform>-backend.ts` implementing `UsbInstallerBackend`.
2. Export it from `usb-installer/src/backend/index.ts`.
3. Wire into `createPlatformBackend` in `usb-installer/src/backend/index.ts`.

### Add an Android vendor overlay file

Place it under `android/vendor/eliza/` following AOSP vendor tree conventions. Brand configs at `packages/scripts/distro-android/brand.eliza*.json` point the orchestrator at this tree.

## Conventions / gotchas

- **This is not a JS library.** The root `package.json` has no `scripts`, `exports`, or `main`. Do not add any; the sub-packages under `usb-installer/`, `setup/`, and `shared-system/` are the actual packages.
- **Linux build requires Docker.** There is no host-native build path. The container is the build environment on all platforms.
- **Tails paths are not product identity.** `linux/tails/` contains upstream Tails live-build plumbing. These paths are preserved because AppArmor policy, persistence, update hooks, and live-build internals key off them. Do not rename them for cosmetic reasons.
- **USB writes are destructive by default.** The USB installer server starts with raw writes disabled (`ELIZAOS_USB_ENABLE_RAW_WRITE` must be explicitly set to `1`). The `just usb-write` Justfile recipe has removable-disk guards and requires the exact device path.
- **Release manifest schema lives in `release/schema/`.** `os-release-lib.mjs` is the single source of truth for validation logic — change it there, not in individual scripts.
- **The confidential profile (`linux/confidential/`) is a scaffold, not built.** The reproducible Yocto image build is blocked on a dedicated build host. Do not treat any file there as a produced artifact.
- **AOSP build needs a Linux x86_64 host with KVM** for x86_64/arm64 Cuttlefish; riscv64 runs under QEMU TCG but needs the same AOSP checkout at `AOSP_ROOT`.
- **Default release manifest path** used by scripts is `packages/os/release/beta-2026-05-16/manifest.json` (set in `os-release-lib.mjs:defaultManifestPath`). This path does not yet exist in the repo — create the directory and manifest file when cutting a release, then update this constant accordingly.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — OS / device image:**
- The image/flow exercised on real hardware or an emulator: boot/setup/install logs and a recording, with the running build confirmed as yours.
- The native × view matrix actually run on-device (Kotlin/Swift run, not only mocked-bridge Chromium — see #9967).
- Recovery/failure paths (interrupted install, no network, wrong layout).
<!-- END: evidence-and-e2e-mandate -->
