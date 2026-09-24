# elizaOS Android installer

The Bash/PowerShell helpers retain legacy image planning and read-only
discovery. Confirmed writes from Bash delegate to the signed v2 installer. PowerShell
refuses confirmed writes, including through WSL; it supports planning and
read-only discovery only.
Current hardware and trust policy are unenrolled, so physical execution remains
blocked. A candidate build is not installation authorization.

Read the [shared contract and signing guide](../../../../scripts/android/README.md)
for the complete format, trust enrollment, lab workflow and execution commands.

## Planning and discovery

From the repository root:

```sh
android/installer/install-elizaos-android.sh --artifact-dir /absolute/product-output
```

This legacy dry-run discovers loose filenames and prints a hypothetical plan.
Planning requires no adb/fastboot installation. Conflicting `--dry-run` and
`--execute` flags are rejected in either order.
It does not establish that the images are coherent, bootable or authorized to
flash. `--image`, `--allow-stale-artifacts` and `--skip-preflight` cannot bypass
the signed execution path. `--execute` without `--confirm-flash` performs only
read-only discovery, and never reboots, writes or switches slots.

For an authorized v2 contract, dry-run validates signatures, policy, image
hashes and generated metadata before displaying the qualified transitions:

```sh
node scripts/android/install-release.mjs --manifest /absolute/release.android-release.json --artifact-dir /absolute/bundle/flash --dry-run
```

## Confirmed installation

The current v2 physical executor supports the grizzly adapter on Linux only.
It requires explicit device selection, exact qualified tools, recovery archive,
new private journal and a signed contract. Start in bootloader mode after
preserving incident evidence. The installer never automatically unlocks,
relocks, upgrades firmware, cancels snapshots or enables MTE.

```sh
android/installer/install-elizaos-android.sh \
  --manifest /absolute/release.android-release.json \
  --artifact-dir /absolute/bundle/flash \
  --device SERIAL \
  --tool-dir /absolute/platform-tools \
  --recovery-dir /absolute/recovery \
  --journal /absolute/private/install.jsonl \
  --health-token-file /absolute/private/local-agent-token --execute --confirm-flash --reboot-after-flash
```

A required wipe must be explicitly selected with `--wipe-data`; a wipe that
conflicts with the qualified transition is also rejected. The selected slot
comes from that transition. `--slot` may confirm it, never override it.

Failure stops dependent commands. Do not resume by copying the remaining
commands out of a journal. Re-inspect the device and use its qualified recovery
procedure. Installation without `--reboot-after-flash` remains pending boot
validation.

## Read-only post-boot validation

For v2, verify the same signed release, exact slot, APK digest, page size,
SELinux and runtime/role state:

```sh
node scripts/android/verify-installed-release.mjs \
  --manifest /absolute/release.android-release.json \
  --artifact-dir /absolute/bundle/flash --device SERIAL \
  --tool-dir /absolute/platform-tools --slot b --execute
```

Omitting `--execute` is dry-run. The older `validate-post-flash.sh` remains a
legacy diagnostic helper; its results cannot authorize v2 release promotion.

[Supported devices](docs/supported-devices.md) and
[recovery guidance](docs/recovery-rollback.md) describe remaining qualification.

## Tests

```sh
bash android/installer/tests/run-tests.sh
node --test scripts/__tests__/android-release-safety.test.mjs
```

These suites use mock transports and temporary signing keys. Passing them does
not prove a phone boots or that a recovery transition works.

Post-boot validation requires `--health-token-file` pointing to a private (0600)
file containing the installed application’s local agent bearer. It is passed
over adb stdin, never in command arguments or journals; health must return
`ready: true`. For a first install or wipe where that credential is not yet
available, omit `--reboot-after-flash`, complete the qualified boot/setup
procedure, then run the standalone validator with the new credential. Missing
credentials never count as successful validation. Do not commit this file.

PowerShell uses explicit parameters (`-ToolDir`, `-RecoveryDir`, `-Journal`,
`-HealthTokenFile`); arbitrary trailing Bash arguments are no longer accepted.
`-DryRun -Execute` is an error.
