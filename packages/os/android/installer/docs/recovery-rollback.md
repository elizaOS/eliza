# Recovery and Rollback

This installer does not automate rollback. Rollback is a release-owner
procedure because it depends on bootloader state, anti-rollback policy, slot
layout, and which partitions were flashed.

## Before Flashing

Prepare these items before any `--execute --confirm-flash` run:

- Stock or previous known-good images for the exact device codename.
- The release manifest used for the current flash attempt.
- The current active slot:

```bash
adb shell getprop ro.boot.slot_suffix
fastboot getvar current-slot
```

- ADB and fastboot serials for the device.
- Confirmation that user data is backed up when a wipe may be needed.

## Non-Destructive Recovery Checks

If a device fails to boot, start with read-only checks:

```bash
fastboot devices
fastboot getvar product
fastboot getvar current-slot
fastboot getvar unlocked
fastboot getvar all
```

Capture the output before changing slots or flashing replacement images.

## Slot Rollback

For A/B devices, the least invasive rollback is often switching to the previous
slot when that slot still contains a known-good system:

```bash
fastboot --set-active=a
fastboot reboot
```

or:

```bash
fastboot --set-active=b
fastboot reboot
```

Only switch to a slot when you know it contains a bootable build for the same
device. Slot switching can still fail if shared partitions were changed.

## Reflash Previous Images

If slot rollback is not enough, reflash the previous known-good artifact set
with the same dry-run-first installer flow:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --device SERIAL \
  --artifact-dir path/to/previous-known-good \
  --assume-bootloader
```

Inspect the plan. Execute only when the mapping is correct:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --device SERIAL \
  --artifact-dir path/to/previous-known-good \
  --assume-bootloader \
  --execute \
  --confirm-flash \
  --reboot-after-flash
```

Add `--wipe-data` only when the release owner confirms it is required.

## Stock Recovery

When custom rollback images are not available, use the OEM factory image or
rescue process for the exact model and codename. Do not cross-flash images from
a different codename, carrier variant, or bootloader generation.

## Validation After Recovery

After recovery boots, run:

```bash
packages/os/android/installer/scripts/validate-post-flash.sh \
  --device SERIAL \
  --execute
```

Record:

- `ro.product.device`
- `ro.build.fingerprint`
- `ro.boot.slot_suffix`
- `sys.boot_completed`
- Any release-manifest property expectations that failed
