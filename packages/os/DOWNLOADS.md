# elizaOS Distribution Channels

## Linux Desktop

### Live USB (recommended for new users)
- **ISO download**: Build via CI, flash to 8 GB+ USB with the USB installer app
- **Debian package**: For installing elizaOS on an existing Debian/Ubuntu system

### Virtual Machine
- **OVA image**: Import into VirtualBox, VMware Fusion, or UTM (Mac)
- **QCOW2 image**: For QEMU/KVM on Linux hosts

## Android

### elizaOS AOSP (full OS replacement)
- **AOSP Flasher app**: GUI tool for Mac/Linux/Windows to flash your Pixel device
- Supported devices: Pixel 9 Pro (caiman), others via community builds
- Requires: USB debugging enabled, bootloader unlocked

### elizaOS Android App (no AOSP required)
- **APK sideload**: Install on any Android device without AOSP flashing

## Install Tools

### USB Installer
Cross-platform app for creating elizaOS USB boot drives:
- macOS: uses diskutil + dd with native authorization
- Linux: uses lsblk + dd via pkexec
- Windows: uses PowerShell disk management

### AOSP Flasher
Cross-platform GUI for flashing elizaOS AOSP onto Pixel devices:
- Detects connected devices via ADB
- Downloads elizaOS AOSP build artifacts
- Guides through bootloader unlock + flashing

## Release Channels

| Channel | Cadence | Stability |
|---------|---------|-----------|
| `stable` | Major releases | Production-ready |
| `beta` | Pre-release | Feature complete, may have bugs |
| `nightly` | Daily automated builds | Latest, may break |

## Generating homepage artifact data

The OS artifact list shown on the homepage is generated from the release manifest at
`packages/os/release/<date>/manifest.json`. To regenerate the data for a new manifest:

```sh
node packages/os/scripts/generate-os-homepage-data.mjs \
  --manifest packages/os/release/beta-2026-05-16/manifest.json \
  --output packages/os-homepage/src/generated/os-artifacts.ts
```

The `write-homepage-release-data.mjs` script also reads the manifest directly at build
time and merges manifest artifacts with the static artifact list before writing
`packages/homepage/src/generated/release-data.ts`.
