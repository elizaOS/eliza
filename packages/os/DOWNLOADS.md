# elizaOS Distribution Channels

This page describes planned OS distribution channels and the current
release metadata flow. It should not be read as proof that every artifact
is already published or production-ready.

## Linux Live USB

The primary Linux artifact is **elizaOS Live**: a USB-bootable distro built
on Tails live-OS plumbing and presented to users as elizaOS Live. The main
download should be a signed live image with checksums, release notes, known
gaps, and a hardware-support matrix.

Current hardening status:

- Demo builds may still be ISO/raw-image candidates until QEMU and real-USB
  validation are attached.
- v1 is USB-only; internal-disk install is deferred.
- A guarded developer writer exists in the live-USB variant. Production
  still needs a signed GUI/CLI flasher for macOS, Windows, and Linux.
- App/runtime/model updates should not require a new full image once the
  signed update channels are implemented. OS/base changes can use signed
  deltas where safe and a full-image fallback where necessary.

## Virtual Machines

VM bundles are for evaluation, development, and CI smoke tests. They do not
replace real USB boot validation.

Planned formats:

- QEMU/KVM `qcow2` for Linux and conversion workflows
- UTM or Apple Virtualization bundles for Apple Silicon macOS
- Optional OVA compatibility bundle after smoke coverage exists

## Android

Android artifacts live under `packages/os/android/` and are separate from
elizaOS Live USB:

- elizaOS AOSP system images for manifest-listed devices
- Cuttlefish images for validation
- Flash tools that verify device identity before destructive operations
- APK sideload path where a full AOSP replacement is not required

## Install Tools

### USB Flasher

Production flasher requirements:

- show only eligible removable drives
- display device path, model, serial, capacity, partitions, and mounts
- verify image checksum/signature before writing
- require destructive confirmation with the exact target device
- refuse internal/root disks
- write, sync, verify, and save a non-secret local install log

Host packaging targets are a signed/notarized macOS package, a signed
Windows installer, and a Linux AppImage or distro-neutral archive plus CLI.

### AOSP Flasher

The Android flasher must:

- detect connected devices with ADB/fastboot
- verify the connected product against the release manifest
- guide bootloader unlock and flashing with destructive warnings
- collect post-flash validation evidence

## Release Channels

| Channel | Purpose | Promotion bar |
|---|---|---|
| `alpha` / nightly | Internal and developer testing | Test-signed or unsigned, not for secrets |
| `beta` | Public candidate with known gaps | Signed artifacts, checksums, validation evidence |
| `stable` | Production release | Signed release, SBOM, license bundle, update/rollback path, hardware evidence |
| Enterprise | Managed fleet release | Rings, policy pins, revocation, internal mirrors, audit evidence |

## Generating Homepage Artifact Data

The OS artifact list shown on the homepage is generated from the release
manifest at `packages/os/release/<date>/manifest.json`. To regenerate the
data for a new manifest:

```sh
node packages/os/scripts/generate-os-homepage-data.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json \
  --output packages/os-homepage/src/generated/os-artifacts.ts
```

The `write-homepage-release-data.mjs` script also reads the manifest
directly at build time and merges manifest artifacts with the static
artifact list before writing `packages/homepage/src/generated/release-data.ts`.
