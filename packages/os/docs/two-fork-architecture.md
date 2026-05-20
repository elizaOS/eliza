# elizaOS two-fork architecture

elizaOS ships as **two parallel OS forks** that share most of their
elizaOS payload but differ in their host operating system, packaging
format, and boot chain.

| | AOSP-based fork | Debian-based fork |
| --- | --- | --- |
| Host OS | Android (AOSP trunk_staging) | Debian (Trixie) |
| C library | bionic | glibc |
| Packaging | APK + system image | Live ISO / raw image |
| Boot chain | fastboot → ramdisk → init.rc → zygote → app | u-boot → grub-efi → kernel → systemd → app |
| Sandboxing | SELinux `untrusted_app` + seccomp | systemd unit + namespaces |
| Distribution | OTA / sideload | USB installer / OTA |
| Supported arches | arm64-v8a, x86_64, riscv64 | x86_64 (Tails variant), riscv64 (Debian variant) |
| Real-device targets | Pixel (oriole/panther/shiba/caiman/tegu), e1 SoC | any UEFI x86_64 / riscv64 SBC |
| Virtual targets | Cuttlefish (`vsoc_x86_64_only`, `vsoc_riscv64_only`) | QEMU virt + UEFI |

## What is shared

Both forks consume the same code for everything above the OS layer:

- **Native plugins** — `packages/native/plugins/{qjl-cpu, polarquant-cpu,
  turboquant-cpu, silero-vad-cpp, wakeword-cpp, voice-classifier-cpp,
  doctr-cpp, face-cpp, yolo-cpp, llama}`. One CMakeLists per plugin
  with arch-conditional source-set selection (Wave 1 scalar + Wave 3
  RVV intrinsics). Cross-toolchain files at `cmake/toolchain-*` cover
  both bionic (`toolchain-android-riscv64.cmake`) and glibc/musl
  (`toolchain-riscv64-linux-{gnu,musl}.cmake`).
- **Agent runtime** — `packages/agent`, `packages/elizaos`,
  `packages/core`. Pure JS / TS, arch-agnostic at the source level.
  Native dependencies are documented in
  `/tmp/riscv-port/ws2-agent-js-deps.md`.
- **Bun source-build pipeline** —
  `packages/app-core/scripts/bun-riscv64/` produces
  `bun-linux-riscv64-musl.zip` from oven-sh/bun + WebKit fork + the
  in-tree patches. Both forks consume the same zip layout
  (`bun-linux-riscv64-musl/bun` inside).
- **Release-manifest schema** —
  `packages/os/release/schema/elizaos-os-release-manifest.schema.json`.
  `target.architecture` enum accepts `x86_64`, `arm64`, `aarch64`,
  `riscv64`, `universal`. `target.platform` enum accepts `linux`,
  `macos`, `windows`, `android`, `cuttlefish` — so a single manifest
  can list artifacts from both forks.
- **USB-installer** — `packages/os/usb-installer/`. Detects image
  architecture from the asset filename
  (`*riscv64*` → architecture `"riscv64"`).
  `DEFAULT_ELIZAOS_IMAGES` is the catalog and validates against the
  same schema.
- **Firmware sources** — `packages/chip/sw/{bootrom, opensbi,
  buildroot, platform}` for the e1 SoC, shared between both forks
  when the target hardware is e1.

## What is fork-specific

Code that lives in exactly one fork and should not be unified:

| Path | Fork |
| --- | --- |
| `packages/app/android/` | AOSP |
| `packages/app-core/platforms/android/` | AOSP |
| `packages/app-core/scripts/aosp/` | AOSP |
| `packages/chip/sw/aosp-device/` | AOSP |
| `packages/os/android/` (system-ui, vendor, installer) | AOSP |
| `packages/os/setup/` (Pixel/fastboot flasher UI) | AOSP |
| `packages/os/linux/variants/milady-tails/` | Debian (x86_64) |
| `packages/os/linux/variants/elizaos-debian-riscv64/` | Debian (riscv64) |
| `packages/chip/sw/linux/{configs,dts,drivers}` | Debian (e1) |

## Cross-fork contracts that MUST stay aligned

Changes to any of these need both forks to be re-validated together:

1. **`packages/os/release/schema/elizaos-os-release-manifest.schema.json`** —
   architecture and platform enums. Both forks emit conforming artifacts.
2. **`packages/os/usb-installer/src/backend/types.ts` `ElizaOsImage`
   architecture union** — both linux and android images live in the
   same catalog.
3. **`packages/app-core/scripts/bun-riscv64/bun-version.json`** — Bun
   version pin. Drift between this and `stage-android-agent.mjs`'s
   `BUN_VERSION` constant is silent and dangerous.
4. **Native-plugin CMake variable names** —
   `QJL_HAVE_RVV` / `POLARQUANT_HAVE_RVV` /
   `TBQ_HAVE_RVV` (preprocessor) and
   `QJL_RVV_COMPILE_OPTIONS` /
   `POLARQUANT_RVV_COMPILE_OPTIONS` /
   `TURBOQUANT_RVV_FLAGS` (cmake-side escape hatches).
   `bun run verify:riscv64` exercises these for both
   linux-musl-riscv64 today; the android-riscv64 build path uses the
   same macros via `toolchain-android-riscv64.cmake`.

## What is correctly divergent (do NOT unify)

- **seccomp shim**:
  `packages/app-core/scripts/aosp/seccomp-shim/sigsys-handler-*.c` is
  Android-only. Linux's seccomp filter for desktop apps does not match
  Android's `untrusted_app` policy, so the shim is meaningless on
  Debian.
- **launch.sh + double-fork daemonisation**: only the AOSP fork's
  `ElizaAgentService.java` spawns the agent like that. Debian uses a
  plain systemd unit.
- **Bionic vs glibc API surface**: any glibc-only API (e.g. `pthread_setname_np`
  with a longer name limit) is fine on Debian; bionic equivalents must
  be checked at compile-time, not papered over with a polyfill.

## Verifying the integration

```bash
bun run verify:riscv64          # cross-build native plugins (musl)
bun run verify:riscv64:e2e      # full end-to-end matrix
```

The `verify:riscv64:e2e` matrix covers shared code (native plugins,
schema, USB installer, Bun pipeline, cloud Dockerfiles), AOSP-fork
specifics (AOSP scripts, seccomp shim, Bun-riscv64 source-build,
Cuttlefish smoke), and Debian-fork specifics (variant scaffold,
manifest template). Output: `reports/riscv64-end-to-end.md`.
