# Recovery and rollback

Recovery depends on the current device, firmware, rollback indices, snapshot
merge status and partitions already changed. A retained old ZIP or a formerly
bootable inactive slot does not prove a downgrade is safe.

## Preserve evidence first

Record the original flashing log, artifact hashes, exact model/SKU, firmware
build and whether the bootloader was relocked. Query inventory before choosing
a serial:

```sh
adb devices -l
fastboot devices
```

If normal bootloader fastboot is available, these are read-only checks:

```sh
fastboot -s SERIAL getvar product
fastboot -s SERIAL getvar unlocked
fastboot -s SERIAL getvar current-slot
fastboot -s SERIAL getvar version-bootloader
fastboot -s SERIAL getvar version-baseband
fastboot -s SERIAL getvar snapshot-update-status
```

For an identified grizzly, collect private evidence with:

```sh
node scripts/distro-android/grizzly-evidence.mjs --device SERIAL --out /absolute/private/evidence
```

The collector verifies product identity before grizzly-specific diagnostics.
Unsupported probes retain failures; no reset, flash or MTE toggle is performed.
A reset can destroy useful logs. Missing ADB does not establish a hard brick.

## Choose recovery from observed state

- Running Android with an app/kiosk problem: investigate provisioning and app
  logs first. OS reinstallation is not the default diagnostic.
- Unlocked bootloader: compare the captured state with the qualified recovery
  contract and OEM instructions for that model and firmware.
- Working recovery: evaluate the correct signed OEM full OTA where applicable.
- Locked bootloader rejecting an image: establish OEM unlock/recovery state and
  the signing-key mismatch before attempting changes.
- No normal USB/display response: document power/cable/host checks and use the
  manufacturer's repair procedure if normal recovery remains unavailable.

Do not guess a slot, cancel snapshots, erase persist/calibration, downgrade
bootloaders, or relock to fix a failed boot. Anti-rollback may prohibit the old
slot even if it used to work. Shared partitions can also invalidate fallback.
There is deliberately no generic slot-switch or old-image execution recipe.

[Google's factory/rollback advisories](https://developers.google.com/android/images)
and [full OTA guidance](https://developers.google.com/android/ota) describe OEM
procedures; determine applicability to the captured state before using them.
Firmware recovery is not performed by the elizaOS OS-install adapter.

## Qualified elizaOS reinstallation

Legacy manifests are planning-only. A retained signed v2 release is usable only
if its current signatures/revocation policy and exact firmware/SKU/storage/
rollback/recovery qualification still match. See
[the signed installer contract](../../../../../scripts/android/README.md).
Execution requires a new journal and revalidates state; failed operations are
not replayed automatically. Never edit eligibility or evidence to bypass a
recovery refusal.
