# `packages/os`

The elizaOS distribution. Linux live USB plus AOSP variants for Android.

## Layout

```
linux/             Tails-derived live USB build scripts and variants
android/           AOSP system images, installer, fastboot/ADB tools
setup/             Install harness (cross-platform)
usb-installer/     USB flasher utility
release/           Release manifests, versioning, signed artifacts
scripts/           Build orchestration
shared-system/     Cross-target shared components
docs/              Internal engineering notes
```

## Variants

The active Linux build ships under `linux/elizaos/`: one multi-arch live-build (amd64/arm64/riscv64) selected via `ELIZAOS_ARCH`, with an optional `ELIZAOS_PROFILE=secure` hardening overlay (RAM-only home, MAC randomization, Tor, AppArmor) built from standard Debian packages, plus the elizaOS desktop app pinned as the home surface.

The Android side targets a curated list of devices where AOSP can be flashed safely. Manifests in `release/` enumerate supported devices, channels (alpha / beta / stable), and signing keys.

## Building locally

Building a live image requires a Debian-based host, root, and ~20 GB free disk. See the variant README under `linux/variants/<name>/` for full prerequisite list and step-by-step build instructions.

## Flashing

The USB flasher under `usb-installer/` handles target selection, format, write, and verify in one pass. It's destructive — requires explicit confirmation of the target block device.

## User-facing docs

The elizaOS track in the docs site covers install, channels, recovery, and per-platform flashing:

- [`/tracks/elizaos/overview`](../docs/tracks/elizaos/overview.mdx)
- [`/tracks/elizaos/linux`](../docs/tracks/elizaos/linux.mdx)
- [`/tracks/elizaos/aosp`](../docs/tracks/elizaos/aosp.mdx)
- [`/tracks/elizaos/install`](../docs/tracks/elizaos/install.mdx)
