# ElizaOS Android installer helpers

This folder contains host-side helpers for planning and, when explicitly
confirmed, flashing ElizaOS Android build artifacts to a device through
`adb` and `fastboot`.

The helper is intentionally conservative:

- It defaults to `--dry-run` and only prints the command plan.
- Flashing requires both `--execute` and `--confirm-flash`.
- Bootloader unlocking is never automated. Unlock devices manually and only
  after confirming the data-loss and warranty implications for that device.
- Data wipe is never implied. Add `--wipe-data` only when you intend to run
  `fastboot -w`.

## Requirements

- Android platform tools available in `PATH`:
  - `adb`
  - `fastboot`
- USB debugging enabled on the device when starting from Android.
- An unlocked bootloader before any image is flashed.
- Image artifacts from an Android build, usually from
  `out/target/product/<device>/`.

## Dry-run plan

Use dry-run first. This validates image paths, detects platform tools, and
prints the exact command plan without touching the device:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --artifact-dir out/target/product/caiman
```

If multiple Android devices are connected, pass the serial shown by
`adb devices -l`:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --device ABC123 \
  --artifact-dir out/target/product/caiman
```

## Image inputs

`--artifact-dir` discovers common image filenames:

- `boot.img`
- `vendor_boot.img`
- `dtbo.img`
- `vbmeta.img`
- `vbmeta_system.img`
- `init_boot.img`
- `super.img`
- `product.img`
- `system.img`
- `system_ext.img`
- `vendor.img`
- `vendor_dlkm.img`
- `odm.img`
- `odm_dlkm.img`

Use `--image PARTITION=PATH` for custom artifacts or to override a discovered
image:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --image boot=out/target/product/caiman/boot.img \
  --image vendor_boot=out/target/product/caiman/vendor_boot.img \
  --image super=out/target/product/caiman/super.img
```

For A/B devices that need an explicit slot, add `--slot a`, `--slot b`, or the
slot value required by the device and artifact set.

## Preflight checks

When execution is requested, the helper checks:

1. `adb` and `fastboot` are present in `PATH`.
2. Exactly one authorized ADB device is connected, unless `--device` is set.
3. ADB reports the device in `device` state.
4. USB debugging is enabled according to `settings get global adb_enabled`.
5. After rebooting to bootloader, `fastboot getvar unlocked` reports an
   unlocked bootloader.

If the device is already in bootloader mode, use `--assume-bootloader` so the
helper skips ADB discovery and starts with fastboot preflight:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --assume-bootloader \
  --device ABC123 \
  --artifact-dir out/target/product/caiman
```

`--skip-preflight` exists for lab automation that already performs equivalent
checks. Do not use it for manual flashing.

## Flashing

Run the dry-run command first and inspect the plan. To flash, repeat the same
inputs and add both execution flags:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --device ABC123 \
  --artifact-dir out/target/product/caiman \
  --execute \
  --confirm-flash
```

Add post-flash boot validation when you expect the flashed image to boot into
Android:

```bash
packages/os/android/installer/install-elizaos-android.sh \
  --device ABC123 \
  --artifact-dir out/target/product/caiman \
  --execute \
  --confirm-flash \
  --reboot-after-flash
```

The validation plan waits for ADB and prints:

- `ro.product.device`
- `ro.build.fingerprint`
- `sys.boot_completed`

You can run the same checks separately with the post-flash validator. It is
dry-run by default:

```bash
packages/os/android/installer/scripts/validate-post-flash.sh \
  --device ABC123 \
  --manifest packages/os/android/installer/manifests/android-release-manifest.example.json
```

Add `--execute` only when a booted Android device is attached and you want to
query it through ADB.

## Release readiness docs

- [ADB setup](docs/adb-setup.md)
- [Supported devices](docs/supported-devices.md)
- [Recovery and rollback](docs/recovery-rollback.md)
- [Release manifest schema](manifests/android-release-manifest.schema.json)
- [Release manifest example](manifests/android-release-manifest.example.json)

Validate a release manifest without device access:

```bash
node packages/os/android/installer/scripts/validate-release-manifest.mjs \
  packages/os/android/installer/manifests/android-release-manifest.example.json
```

If artifacts are available locally, pass `--artifact-dir` to verify declared
file sizes and SHA-256 values:

```bash
node packages/os/android/installer/scripts/validate-release-manifest.mjs \
  path/to/release-manifest.json \
  --artifact-dir out/target/product/caiman
```

On Windows, the PowerShell wrapper keeps the same dry-run default and forwards
arguments to the Bash installer when Git Bash, WSL, or another Bash runtime is
available:

```powershell
packages\os\android\installer\install-elizaos-android.ps1 `
  -ArtifactDir out\target\product\caiman
```

Device-free checks for this folder live in `tests/run-tests.sh`.

## Command plan shape

The generated plan is intentionally simple and auditable:

```text
adb -s <serial> reboot bootloader
fastboot -s <serial> devices
fastboot -s <serial> getvar product
fastboot -s <serial> getvar unlocked
fastboot -s <serial> flashing get_unlock_ability
fastboot -s <serial> flash <partition> <image>
fastboot -s <serial> reboot
adb -s <serial> wait-for-device
adb -s <serial> shell getprop ro.product.device
adb -s <serial> shell getprop ro.build.fingerprint
adb -s <serial> shell getprop sys.boot_completed
```

Review the partition-to-image mapping before adding `--execute
--confirm-flash`.
