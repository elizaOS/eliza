# ElizaOS installer release plan

> Status: first-pass planning artifact. This document defines release
> requirements and validation gates for installer artifacts. It does not claim
> that all artifacts exist yet.

This plan covers the install and boot surfaces that ship outside package
managers: cross-platform USB self-installers, VM bundles, Android flashing
images, validation evidence, and GitHub release assets. Platform implementation
details stay in their platform directories:

- Linux live USB / VM mechanics: `packages/os/linux/`
- Android system image and vendor layer: `packages/os/android/`
- Shared contracts used by OS surfaces: `packages/os/shared-system/`

## Release goals

- Give users a path to run ElizaOS without modifying their primary host OS.
- Make release artifacts deterministic enough to validate, checksum, and
  reproduce from CI.
- Keep installer UX explicit about destructive operations, especially USB
  writes and Android flashing.
- Publish enough metadata for users and downstream builders to select the
  correct artifact without guessing CPU architecture or target device.

## Cross-platform USB self-installer requirements

The USB self-installer writes a bootable ElizaOS live image to removable media.
It is not an internal-disk installer.

### Shared requirements

- Input artifact: signed or checksummed ElizaOS live image, plus detached
  metadata containing version, build commit, image size, and SHA-256.
- Output target: removable USB mass-storage device only.
- Host disk safety:
  - enumerate candidate devices and mark internal disks as ineligible;
  - require an explicit device confirmation step before writing;
  - show the target device path, model, capacity, and existing partition labels;
  - refuse ambiguous targets unless the user reruns with an explicit override.
- Write flow:
  - verify source image checksum before writing;
  - stream writes with progress;
  - flush/sync before completion;
  - re-read the target and verify boot partitions or image hash sample after
    write;
  - produce a local install log with version, host OS, target device, result,
    and validation summary.
- Boot modes:
  - UEFI boot required for first supported release;
  - BIOS/legacy boot may be best-effort only if the Linux image supports it;
  - Secure Boot status must be stated clearly until signed shim support lands.
- Persistence:
  - installer must distinguish between image write and encrypted persistence
    setup;
  - persistence setup must happen on the USB device, never on a host disk;
  - destructive resizing or repartitioning requires a second confirmation.

### macOS host requirements

- Package format: signed and notarized `.dmg` or `.pkg`, plus a CLI binary for
  advanced users.
- Device enumeration: use Disk Arbitration or `diskutil` to identify external
  removable media and mounted volumes.
- Write path:
  - unmount target volumes before raw writes;
  - write to `/dev/rdiskN` where available for performance;
  - call `sync` and eject or remount intentionally after verification.
- UX requirements:
  - explain the administrator permission prompt before requesting it;
  - handle Apple Silicon and Intel macOS hosts with a universal installer
    binary where practical.

### Windows host requirements

- Package format: signed `.exe` or `.msi`, plus a portable `.zip` containing a
  CLI for advanced users.
- Device enumeration: use Windows storage APIs, not drive letters alone.
- Write path:
  - require elevation before raw disk writes;
  - lock and dismount target volumes before writing;
  - tolerate common antivirus and SmartScreen delays without corrupting writes.
- UX requirements:
  - show physical drive number, model, bus type, size, and current volumes;
  - warn that Windows may prompt to format Linux partitions after completion
    and that users should decline.

### Linux host requirements

- Package format: AppImage or distro-neutral archive, plus a CLI.
- Device enumeration: use `lsblk --json` or equivalent structured block-device
  data; identify `TRAN=usb` where available.
- Write path:
  - require root or polkit only for the write step;
  - unmount mounted partitions on the selected USB device;
  - use direct writes with progress and `sync`;
  - verify the written device before reporting success.
- UX requirements:
  - support headless CLI use in CI/lab environments;
  - refuse to run if the selected target is the current root disk.

## VM bundle release matrix

VM bundles are for evaluation, development, and CI. They are not a substitute for
real USB boot validation.

| Artifact | CPU | Host targets | Firmware | Acceleration | Status |
|---|---|---|---|---|---|
| `elizaos-vm-linux-x86_64.qcow2` | x86_64 | Linux, Windows via QEMU/WSL or Hyper-V conversion | UEFI | KVM/WHPX | Required |
| `elizaos-vm-linux-arm64.qcow2` | arm64 | Linux arm64 hosts | UEFI | KVM | Required |
| `elizaos-vm-macos-silicon.utm.zip` | arm64 | Apple Silicon macOS | UEFI | Apple Virtualization / HVF | Required |
| `elizaos-vm-macos-intel.qcow2` | x86_64 | Intel macOS | UEFI | HVF | Optional after smoke coverage |
| `elizaos-vm-virtualbox-x86_64.ova` | x86_64 | Linux, Windows, Intel macOS | UEFI | VirtualBox | Optional compatibility bundle |

Each VM bundle must include:

- disk image or appliance bundle;
- machine-readable manifest with version, build commit, CPU architecture,
  firmware mode, default disk size, default RAM, and expected checksum;
- quick-start README for the target hypervisor;
- default credentials policy, if any;
- validation transcript from the matching smoke test job.

Minimum boot validation per VM artifact:

- reaches graphical shell or first-run chat surface;
- local agent process starts and reports healthy;
- network interface is present;
- persistence state is either explicitly disabled or isolated to the VM disk;
- shutdown path works without filesystem corruption on next boot.

## Android ADB / fastboot flashing workflow

The Android release path targets supported devices and Cuttlefish-compatible
images produced from `packages/os/android/`.

### Inputs

- Device-specific image bundle, named with brand, target codename, Android
  branch, build variant, build commit, and date.
- `android-info.txt` or equivalent target metadata declaring supported
  bootloader/device identifiers.
- SHA-256 checksums for every image and archive.
- Flash script for macOS/Linux shells and a Windows PowerShell script, both
  wrapping standard `adb` and `fastboot` commands.

### User-visible preflight

- Verify `adb` and `fastboot` are installed and in `PATH`.
- Verify exactly one device is connected.
- Verify USB debugging is authorized before rebooting to bootloader.
- Display target device serial, product, bootloader state, and current slot.
- Refuse to flash if the connected product is not in the release manifest.
- Warn clearly when bootloader unlock or flashing will wipe user data.

### Flash workflow

```text
adb devices
adb reboot bootloader
fastboot devices
fastboot getvar product
fastboot getvar current-slot
fastboot flashing unlock        # only when needed; destructive, manual confirm
fastboot flash boot boot.img
fastboot flash vendor_boot vendor_boot.img
fastboot flash dtbo dtbo.img    # when supplied for target
fastboot flash vbmeta vbmeta.img
fastboot flash super super.img  # or target-specific dynamic partition images
fastboot --set-active=a         # only when release manifest requires it
fastboot reboot
adb wait-for-device
adb shell getprop ro.product.device
adb shell dumpsys role | grep -i assistant
```

The exact partition list must come from the image manifest, not from a hardcoded
global script. Pixel and Cuttlefish targets may diverge.

### Post-flash validation

- Device boots to setup or Eliza first-run surface.
- `ai.elizaos.app` is installed under the expected system or product path.
- Assistant role holder resolves to the Eliza package.
- Privileged permissions declared in the product image are granted.
- Direct-boot receivers and foreground services declared in the AOSP contract
  are present.
- ADB validation output is captured and attached to the release run.

## Validation checklist

Before a release is promoted from candidate to public:

- Build provenance:
  - release tag points at the expected commit;
  - CI build logs are retained;
  - artifact manifests include version, commit, build time, and builder ID.
- Checksums and signatures:
  - SHA-256 generated for every binary artifact;
  - checksums are verified after upload;
  - signing/notarization status is recorded per host installer.
- USB installer:
  - macOS host write smoke passes;
  - Windows host write smoke passes;
  - Linux host write smoke passes;
  - written USB boots on at least one x86_64 UEFI machine;
  - host internal disks remain unmodified during validation.
- VM bundles:
  - each required matrix entry boots with the documented hypervisor;
  - smoke test transcript is attached;
  - default RAM and disk size match README and manifest.
- Android:
  - Cuttlefish boot validation passes;
  - at least one physical supported device boots after flashing, when a
    physical-device artifact is published;
  - assistant/full-control contract is validated with ADB output.
- Documentation:
  - release notes include known limitations;
  - Secure Boot support state is explicit;
  - destructive operations are documented before download links;
  - rollback/reflash guidance is present for Android.

## GitHub release artifact checklist

Publish these files for each public release candidate:

- `elizaos-release-manifest.json`
- `SHA256SUMS`
- `SHA256SUMS.sig` or equivalent detached signature
- USB image:
  - `elizaos-live-<version>-x86_64.img.zst`
  - optional `elizaos-live-<version>-arm64.img.zst`
- Host USB installers:
  - `elizaos-usb-installer-<version>-macos-universal.dmg`
  - `elizaos-usb-installer-<version>-windows-x86_64.exe`
  - `elizaos-usb-installer-<version>-linux-x86_64.AppImage`
  - optional Linux arm64 installer when arm64 USB images are published
- VM bundles from the release matrix marked required.
- Android bundles:
  - `elizaos-android-<device>-<version>.zip`
  - `elizaos-android-<device>-<version>-flash-tools.zip`
  - target manifest and flashing README per device.
- Validation evidence:
  - USB write logs for macOS, Windows, and Linux;
  - VM smoke transcripts;
  - Android ADB/fastboot validation transcript;
  - CI build provenance link or exported job summary.
- Human-facing docs:
  - release notes;
  - installation guide;
  - known issues;
  - recovery / rollback guide.

## Open planning questions

- Whether the first public USB image is x86_64-only or ships arm64 at the same
  time.
- Whether host USB installers should be one shared codebase or thin wrappers
  around a common CLI.
- Which physical Android devices are first-tier release targets beyond
  Cuttlefish.
- Whether Apple Silicon VM distribution should standardize on UTM, raw VZ
  bundles, or both.
- Which signing authority owns installer signing keys and release attestations.
