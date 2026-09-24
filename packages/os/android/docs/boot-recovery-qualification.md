# Pixel boot and recovery qualification review

**Decision: read-only intake is appropriate; custom installation is not yet qualified.**
Reviewed against OS `06b35b47700bba9e9d8dea31a454af6dd53515bc` (PR #126).
This is an evidence checklist, not a qualification receipt or permission to flash.
The candidate is Pixel 11 Pro `grizzly`, not every Pixel 11 model.

## What is established

The signed executor validates exact artifacts, generated partition metadata,
firmware/slot starting state, SKU/storage, snapshot state, tool hashes, recovery
archive and independent authorization. It stops on command failures, records a
journal and retains an interrupted-install interlock. The reviewed CI passed,
including Windows refusal tests and USB restore VM tests. Those USB disk tests
are not Android phone recovery tests. Existing Cuttlefish runtime checks likewise
do not prove ARM64 Pixel boot, encryption, radio or stock restoration.

Current read-only host checks found only Cuttlefish ADB transports and no
fastboot device. The dedicated grizzly checkout is absent; available product
output is `vsoc_x86_64_only`. The build preflight again rejected this host at
24 physical cores / 30 GiB RAM against the lane's 32 / 128 requirement. GitHub
reported no registered self-hosted runners. A separately managed builder could
exist, but this review has no build receipt from one.

`hardware-targets.json` still disables both grizzly production and lab installs.
`release-trust.json` has no enrolled keys or revocation bulletin. The source lock
uses A9 factory inputs and a public AOSP userdebug AVB key. None of these values
should be changed simply to make an installer proceed.

## Evidence required before the first custom-image experiment

| Gate | Required retained evidence | Current result |
| --- | --- | --- |
| Incident reconstruction | Original command sequence, exact image/tool hashes, journal, lock/relock actions, last observed boot mode, and logs from each failed phone separately | Missing; cause of the two failures remains unknown |
| Device identity | Explicit serial, actual product, SKU/storage, firmware, unlock state, current slot, both slots' health/retry values and snapshot state | No phone available; unknown |
| Recovery baseline | Device-correct OEM package and digest, applicable instructions, reachable recovery transport, successful stock restore and subsequent boot on the relevant firmware/rollback state | Not demonstrated |
| Firmware/rollback compatibility | Evidence for both slots and rollback constraints, including how each value was measured or authoritatively established | Not demonstrated; A9 archive retention is insufficient |
| Actual candidate | Exact source build, AVB/VINTF/init/SELinux gates, kernel/module/vendor pairing, final LP metadata and second-build comparison | No grizzly build receipt available |
| Bounded lab authorization | Independent scoped signatures covering that exact artifact, phone combination, wipe decision and recovery procedure | Not enrolled; remains blocked |

When a firmware value or rollback counter cannot be read, record that limitation.
Do not invent zero values or assume the inactive slot has the active slot's
firmware. An OEM-documented recovery route must be evaluated for the observed
state; the ability to download an archive is not a recovery drill.

Google describes full OTA sideload as a way to restore corresponding stock
firmware without requiring unlock or a wipe. This is a candidate recovery route,
not a promise that every custom/failed state will accept it. Inspect package,
product, version and transport requirements first. Its factory-image advisories
also document inactive-slot anti-rollback failures for specified older Pixel
families. They demonstrate the failure mechanism, but do not establish a
Pixel 11-specific remedy. Do not copy those firmware-write instructions into
our OS installer. [Google full OTA guidance](https://developers.google.com/android/ota),
[factory-image advisories](https://developers.google.com/android/images).

## Evidence required after an authorized lab installation

1. **Persistent boot success:** retain exact fingerprint, APK digest and slot on
   first boot, subsequent normal reboot and cold boot. Establish that Android
   marked the intended slot successful and that retries/fallback behave as
   qualified. A launcher or `sys.boot_completed=1` alone is insufficient.
2. **Recovery round trip:** demonstrate entry to the intended recovery and
   return to the same qualified OS; record firmware, slot and snapshot state
   before and after. Distinguish bootloader fastboot, fastbootd, recovery shell,
   and sideload-only transports. Do not treat a recovery logo as a restore test.
3. **Encrypted data and keystore:** use disposable test data and credentials;
   verify credential-protected access after recovery and reboot, expected key
   behavior, and actual restored content if backup is offered. Recovery is not
   required to decrypt private user files. Erasing encrypted data is not recovery
   of that data, and disabling encryption cannot satisfy this gate.
4. **Updates and fallback:** qualify full/incremental OTA and snapshot merging
   separately from clean installation. Record both slots before/after the update
   and after restarting recovery. Test stale-slot rejection and compatible
   fallback. Shared logical partitions mean a previous slot is not necessarily
   an intact backup. The current installer does not implement OTA or sideload.
5. **Failure and stock restoration:** retain controlled OS-update interruption
   results on designated lab hardware with a demonstrated recovery route, then
   prove restoration and subsequent stock boot. Host mock failures are not USB
   or power-loss evidence. Do not interrupt firmware flashing or try speculative
   downgrades to manufacture a failure case.

AOSP assigns boot-success marking to Android and describes how exhausted retry
counts cause fallback. Our post-boot helper checks the current runtime, but does
not itself prove persistent slot-success marking, repeated cold boots or recovery.
Those are explicit physical evidence obligations, not automated passes.
[AOSP boot control](https://source.android.com/docs/core/architecture/bootloader/updating).

Snapshot merging has its own state machine; generic slot switching or cancellation
is not a recovery shortcut. Our executor refuses non-`none` snapshot state.
[AOSP Virtual A/B](https://source.android.com/docs/core/ota/virtual_ab/implement).
Credential-encrypted data availability depends on authenticated unlock;
that distinction must survive our recovery tests.
[AOSP file-based encryption](https://source.android.com/docs/security/features/encryption/file-based).

## What the qualification validator can and cannot prove

The production contract requires recovery, stock restoration, rejected downgrade,
slot fallback, snapshot merge, interrupted update, encryption/keystore and OTA
checks for every declared SKU/storage/starting-state combination. The limited lab
contract instead requires stock baseline, recovery, firmware rollback policy,
Cuttlefish boot and artifact validation before the first experiment. This avoids
pretending the candidate already booted in order to authorize a bounded test.

The validator checks signed declarations and evidence digests. It does not replay
hardware experiments, retrieve all evidence objects or judge an OEM instruction
page's applicability. Independent qualification reviewers must retrieve the
retained evidence, verify hashes, inspect transcripts and confirm the exact
combination before signing. A `pass` string without that review is not proof.
Do not weaken the checks or use fixture signing keys to fill missing evidence.

## Next safe action

Connect one phone for inventory and incident preservation only. Use the existing
[recovery intake guide](../installer/docs/recovery-rollback.md); do not change its
boot mode merely to obtain a missing probe. Collect the original failed-install
logs and identify the dedicated builder in parallel. No wipe, unlock, relock,
slot switch, snapshot cancellation or flash is part of this review.
