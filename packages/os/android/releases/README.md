# Pixel 10a release, update and recovery

Pixel 10a (`stallion`) on Android 17 is one shared hardware target. Each launcher
brand composes the same product from `android/products/pixel10a-<brand>.json`
(`stage-pixel10a-product.ts`): a nonprivileged launcher on `/product`, the separately
admitted Sense listener as the only privileged package (exactly
`CAPTURE_AUDIO_HOTWORD` and `START_ACTIVITIES_FROM_BACKGROUND`), the reviewed
stallion `BoardConfig.mk`, enforcing SELinux with the reviewed device policy, the hash-pinned
generated vendor tree and VINTF manifests, role provisioning for HOME, assistant and
Autofill, and the system Clock (`DeskClock`). Stock recovery stays reachable.
Brand assets are configurable but pinned: a composition may record
`brandAssets.bootAnimation.sha256`, and staging then requires exactly that stored
`bootanimation.zip` (`--boot-animation`) and installs it on the product partition;
without a pin the stock animation remains. Assets never change privileges.

Release inputs are brand-owned public identities. A brand keeps three records:

| Record | Eliza | Contents |
| --- | --- | --- |
| Release descriptor | [`pixel10a-eliza.json`](pixel10a-eliza.json) | product, lunch targets, pinned source lock, application/platform/release certificate digests, AVB algorithm, chained partitions and public key digest, update channel |
| Update channel | [`pixel10a-eliza-ota-channel.json`](pixel10a-eliza-ota-channel.json) | update authority and release owner, OTA certificate and AVB key digests, `downgradeAllowed: false`, the locked stock factory archive, the retained known-good release and the drill record |
| Qualification gates | (downstream products keep theirs) | source admission, APK variants, Cuttlefish boot, physical device, signed update/recovery and user acceptance, each with its own evidence |

[`scripts/android/pixel10a-release.mjs`](../../scripts/android/pixel10a-release.mjs)
validates all three for any brand. A downstream product (for example Alpha Phone)
keeps its records in its own repository and passes its root, its product name, the
vendored path of `android/sources/pixel10a-stallion.json` and, optionally, its
application signer file. A descriptor that names another brand's product is refused.
Every Eliza value that depends on a key ceremony is `UNSET`, so production staging
and signing refuse until a reviewed change records the digests. `releaseQualified`
and `deviceAcceptanceVerified` are evidence and stay `false` in every descriptor.

## Signing and the compatibility record

On the image host, after the production image build:

```sh
node packages/os/scripts/android/sign-pixel10a-release.mjs \
  --target-files /abs/unsigned-target_files.zip --target-files-sha256 <build record> \
  --keys-dir /dev/shm/keys --releasetools /abs/otatools/bin --out /abs/new-release \
  [--map-key SOURCE=NAME ...] [--incremental-from /abs/previous-signed-target_files.zip] \
  [--pkcs11-config FILE --avb-signing-helper FILE --payload-signer FILE \
   [--payload-signer-arg ARG ...] --payload-signer-signature-size BYTES] [--dry-run]
```

Downstream brands call `signingMain(args, { root, productName, descriptorFile,
sourceLockPath, applicationSignerFile })` from
[`aosp-release-signing.mjs`](../../scripts/android/aosp-release-signing.mjs). The job
uses the [signing key layout](../signing/README.md), refuses unmapped APK, APEX and
chained AVB keys, unreviewed certificate digests, keys inside a Git working tree and
loose key permissions, verifies every re-signed APK and APEX before building the OTA,
and supports managed PKCS#11/AVB-helper/payload-signer signing. It then writes
`release-record.json` ([`aosp-release-record.mjs`](../../scripts/android/aosp-release-record.mjs)):
build fingerprint, date, security patch levels, vbmeta and chained image hashes with
their AVB rollback indexes and locations, OTA payload and metadata, release
certificate digests and the application signer digests. A signed output is not an
image boot, an applied update or a drill.

## Updating, interruption and rollback

[`aosp-ota-update.mjs`](../../scripts/android/aosp-ota-update.mjs) is the operator
update client for one serial-bound device:

- `check --channel C --from INSTALLED --to CANDIDATE` compares two compatibility
  records: the same product, channel, OTA certificate and AVB key; a newer build date;
  no lower security patch level; no lower AVB rollback index at any location; and,
  for an incremental package, exactly the installed build and signed target-files.
  Downgrades are refused.
- `apply ... --ota OTA.zip --journal FILE [--execute --confirm-update]` verifies the
  package bytes against the candidate record and the device against the installed
  record, then reboots into recovery (`adb reboot recovery`). A user build's adbd
  cannot enter sideload itself (`adb reboot sideload` needs `adb root`), so the tool
  asks the operator to choose "Apply update from ADB" and waits for sideload. It sends
  the package (recovery verifies it against the image's otacerts on a locked user
  build), asks the operator to choose "Reboot system now" if recovery stays in its
  menu, and verifies the candidate build on the other slot with SELinux enforcing and
  verified boot no weaker than before (a key enrolled with `avb_custom_key` boots
  yellow). Every step is journaled. It holds the same device lock as the installer.
- An interrupted run leaves the lock and journal for inspection. `status` classifies
  the observed device: the candidate booted (verify), recovery or sideload (send
  again), the installed build still on its slot (the update did not take effect or
  the bootloader fell back; retry), the bootloader, or absent. Re-running `apply`
  with the same journal resumes from that observation and never assumes success.
- `fallback --journal FILE [--execute --confirm-fallback]` switches back to the
  original slot from the bootloader only while the updated slot is not marked
  successful, the original slot is bootable and no snapshot merge is in progress. On
  a Virtual A/B device (Pixel 10a) the bootloader must also report a `snapshotted`
  update: when recovery cannot create snapshots it overwrites the original slot's
  dynamic partitions, and then only a compatible release or stock recovery restores
  the device. Afterwards a compatible rollback is a newer release that passes `check`.
- `stock-archive` verifies the channel's stock factory archive against the source
  lock and prints the exact fastboot plan; `verify-stock` checks the restored stock
  build. Stock recovery unlocks the bootloader and wipes data, so the operator runs it
  with physical confirmation. `fastboot flashing unlock` is refused unless OEM
  unlocking was enabled from the running image's developer options, which a device
  that no longer boots cannot do; whether released devices keep it enabled is a
  release decision the stock-recovery drill must exercise.

[`verify-launcher-image.mjs --target pixel10a`](../../scripts/android/verify-launcher-image.mjs)
checks a booted image read-only: exact fingerprint, nonprivileged system launcher
bytes as HOME, a remaining recovery HOME, Clock handlers, WebView and, with
`--listener`, the Sense listener's privileges.

None of these tools records a drill. The release owner records signed-update,
interrupted-update, compatible-rollback and stock-recovery results and the retained
known-good release in the channel from executed drills; a channel with any drill not
`passed` is not distributable.
