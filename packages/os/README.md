# `packages/os`

The elizaOS distribution. The canonical Linux build is the Tails-derived
elizaOS Debian fork under `linux/`; Android lives under `android/` as the
separate AOSP fork.

## Layout

```
linux/             canonical Tails-derived elizaOS Debian fork
android/           AOSP system images, installer, fastboot/ADB tools
setup/             Install harness (cross-platform)
usb-installer/     USB flasher utility
release/           Release manifests, versioning, signed artifacts
scripts/           Build orchestration
shared-system/     Cross-target shared components
docs/              Internal engineering notes
```

## Linux

The active Linux build ships directly under `linux/`: one multi-arch
live-build selected via `ELIZAOS_ARCH`. It is the canonical elizaOS Debian
fork. There are no distro variants in this repo; amd64/arm64/riscv64 are
architecture targets of the same build.

The upstream-derived source remains in `linux/tails/` because inherited
Tails live-OS plumbing, AppArmor policy, Greeter code, Persistent Storage,
and update hooks key off those names. Product identity is elizaOS; Tails
references are retained only for provenance, licenses, and internal plumbing.

The Android side targets a curated list of devices where AOSP can be flashed
safely. Flash manifests under `android/installer/manifests/` enumerate the
supported devices; OS release manifests carry a channel
(`alpha` / `beta` / `stable` / `nightly`, validated in `scripts/os-release-lib.mjs`).

## Building locally

Building a live image requires Docker run with `--privileged` (live-build needs
binfmt_misc and loop devices). See `linux/README.md` for prerequisites and the
step-by-step build flow.

## Flashing

The USB flasher under `usb-installer/` handles target selection, format, write, and verify in one pass. It's destructive — requires explicit confirmation of the target block device.

## User-facing docs

Engineering notes for this package live in `docs/` (TEE plan, CI/CD production plan, release plan, apt repo). Per-subsystem README files: `linux/README.md`, `android/README.md`, `usb-installer/README.md`.
