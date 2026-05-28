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
safely. Manifests in `release/` enumerate supported devices, channels
(`alpha` / `beta` / `stable`), and signing keys.

## Building locally

Building a live image requires Docker, root-equivalent container privileges,
and ~20 GB free disk. See `linux/README.md` for prerequisites and the
step-by-step build flow.

## Flashing

The USB flasher under `usb-installer/` handles target selection, format, write, and verify in one pass. It's destructive — requires explicit confirmation of the target block device.

## User-facing docs

The elizaOS track in the docs site covers install, channels, recovery, and per-platform flashing:

- [`/tracks/elizaos/overview`](../docs/tracks/elizaos/overview.mdx)
- [`/tracks/elizaos/linux`](../docs/tracks/elizaos/linux.mdx)
- [`/tracks/elizaos/aosp`](../docs/tracks/elizaos/aosp.mdx)
- [`/tracks/elizaos/install`](../docs/tracks/elizaos/install.mdx)
