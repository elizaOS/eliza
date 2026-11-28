# Operator update by cable

An operator moves one enrolled device, attached by cable, to a candidate
release of its channel, and gets it back when the update does not hold. The
device's recovery verifies the package and its bootloader enforces verified
boot and rollback protection; nothing here signs, builds, relocks or wipes.
Source: develop's `aosp-ota-update.mjs` and `install-lock.ts`. The shell,
`src/image/ota-operator.vibe` (`eliza-os ota check | apply | status |
fallback | stock-archive | verify-stock | retain-known-good`), reads the
records [release signing](../image/signing.md) wrote, runs `adb` and
`fastboot`, and keeps this machine in a private journal file it replaces
atomically. The admission of the [system updater](./updater.md) is reused.
Results are observations for a drill record; nothing here marks a drill passed.
`status` reads the journal and the selected device without changing either.
Its `slots` field is null outside the bootloader. In the bootloader it reports
slot and snapshot observations for the journal's device product. An unread or
different product leaves these observations unconfirmed.

## Story: Update a device by cable

> As a product's operator, I want to update a device only from a signed record
> of its channel, resuming from what the device shows, so that it never takes
> a foreign, older or unverifiable build and no update is assumed complete.

### A candidate is admitted only from a signed record of the channel, with the same OTA certificate and AVB key, its build date as post-timestamp and no lower rollback index

Both records are clean and name the channel, its product and device;
`U::candidateAdmitted` adds a new fingerprint, a newer build date and no
lower patch level. Each rollback index location of the installed release
keeps an index no lower, or the bootloader would refuse the candidate. A
channel that allows downgrades admits nothing.

```quint
import apk.* from "../image/apk"
import signing.* from "../image/signing"
import updater as U from "./updater"
import verification as Vf from "../image/verification"
type RollbackIndex = { location: int, index: int }
type OtaKind = FullOta | IncrementalOta({ preBuild: str, fromTargetFiles: Digest })
type OperatorRelease = { release: U::Release, channel: str, problems: int, otaCertificate: Digest, avbKey: Digest, rollbackIndexes: List[RollbackIndex],
  postTimestamp: int, ota: OtaKind, otaPackage: Digest, signedTargetFiles: Digest }
pure def recordAdmitted(channel: ReleaseChannel, r: OperatorRelease): bool =
  r.problems == 0 and channel.device != "" and r.release.product == channel.product and r.release.device == channel.device and r.channel == channel.name
    and r.release.fingerprint != "" and r.release.buildDate > 0 and r.release.securityPatch > 0 and isDigest(r.otaPackage) and isDigest(r.signedTargetFiles)
    and digestsMatch(r.otaCertificate, channel.otaCertificate) and digestsMatch(r.avbKey, channel.avbPublicKey) and r.rollbackIndexes.length() > 0
pure def rollbackNotLower(fromRelease: OperatorRelease, toRelease: OperatorRelease): bool =
  fromRelease.rollbackIndexes.every(i => toRelease.rollbackIndexes.some(c => c.location == i.location and c.index >= i.index))
pure def updateAdmitted(channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease): bool =
  not(channel.downgradeAllowed) and recordAdmitted(channel, fromRelease) and recordAdmitted(channel, toRelease) and U::candidateAdmitted(fromRelease.release, toRelease.release)
    and toRelease.postTimestamp == toRelease.release.buildDate and rollbackNotLower(fromRelease, toRelease) and startsFromInstalled(fromRelease, toRelease)
pure val installedRecord: OperatorRelease = { release: { fingerprint: "b1", product: "acme_stallion", device: "stallion", buildDate: 20260101, securityPatch: 20260101,
  vendorPatch: 20260101 }, channel: "stable", problems: 0, otaCertificate: Sha256({ hex: "o1" }), avbKey: Sha256({ hex: "k1" }),
  rollbackIndexes: List({ location: 0, index: 1 }), postTimestamp: 20260101, ota: FullOta, otaPackage: Sha256({ hex: "u1" }), signedTargetFiles: Sha256({ hex: "s1" }) }
pure val candidateRecord: OperatorRelease = { ...installedRecord, release: { ...installedRecord.release, fingerprint: "b2", buildDate: 20260201, securityPatch: 20260201 },
  postTimestamp: 20260201, rollbackIndexes: List({ location: 0, index: 2 }), otaPackage: Sha256({ hex: "u2" }), signedTargetFiles: Sha256({ hex: "s2" }) }
pure val channelValues = Set(acmeChannel, { ...acmeChannel, downgradeAllowed: true }, { ...acmeChannel, otaCertificate: Sha256({ hex: "o2" }) })
pure val fromReleaseValues = Set(installedRecord)
pure val toReleaseValues = Set(candidateRecord, { ...candidateRecord, rollbackIndexes: List({ location: 0, index: 0 }) }, { ...candidateRecord, postTimestamp: 20260101 },
  { ...candidateRecord, ota: IncrementalOta({ preBuild: "b1", fromTargetFiles: Sha256({ hex: "s1" }) }) },
  { ...candidateRecord, ota: IncrementalOta({ preBuild: "b0", fromTargetFiles: Sha256({ hex: "s1" }) }) }, { ...candidateRecord, rollbackIndexes: List({ location: 1, index: 9 }) })
pure def lawDowngradeChannelAdmitsNothing(channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease): bool =
  channel.downgradeAllowed implies not(updateAdmitted(channel, fromRelease, toRelease))
pure def lawLowerOrMissingRollbackIndexIsRefused(channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease): bool =
  fromRelease.rollbackIndexes.some(i => not(toRelease.rollbackIndexes.some(c => c.location == i.location and c.index >= i.index)))
    implies not(updateAdmitted(channel, fromRelease, toRelease))
```

### An incremental package starts from exactly the installed build and its signed target files

```quint
pure def startsFromInstalled(fromRelease: OperatorRelease, toRelease: OperatorRelease): bool = {
  val ota = toRelease.ota
  match ota {
    | IncrementalOta(o) => o.preBuild == fromRelease.release.fingerprint and digestsMatch(o.fromTargetFiles, fromRelease.signedTargetFiles)
    | _ => true
  }
}
pure def lawIncrementalFromAnotherBuildIsRefused(channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease): bool = {
  val ota = toRelease.ota
  match ota {
    | IncrementalOta(o) => (o.preBuild != fromRelease.release.fingerprint or not(digestsMatch(o.fromTargetFiles, fromRelease.signedTargetFiles)))
        implies not(updateAdmitted(channel, fromRelease, toRelease))
    | _ => true
  }
}
```

### One device has one operator: every journal change and device write happens under the device's install lock

The lock is a private file per serial, created exclusively for the run and
marked before the first device write. A run that ends without writes, or
settles the journal, removes it; any other end, a process death included,
leaves it for the operator to remove by hand, since the device state is unknown.
The lock is the device lease of [the test harness](../image/harness.md),
held for the whole run in a real directory the operator owns, created
owner-only with each new directory and the lock itself synced to disk. A
new journal file is created exclusively, and every journal change is
written with the time, the phase, the lock and what the shell observed or
why a transfer failed, so the journal keeps the whole history of the run.

```quint
type InstallLock = Unlocked | Locked({ writing: bool }) | LeftLocked
type OperatorPhase = Unstarted | AwaitingSideload | Sideloading | Transferred | VerificationFailed | Verified | FallingBack | FallbackFailed | RolledBack
type Slot = NoSlot | SlotA | SlotB
type StartFacts = { device: str, installedBuild: str, candidateBuild: str, candidatePatch: int, originalSlot: Slot, originalBoot: Vf::BootState, wasLocked: bool, virtualAb: bool }
type OperatorJournal = { phase: OperatorPhase, lock: InstallLock, start: StartFacts }
pure val noStart: StartFacts = { device: "", installedBuild: "", candidateBuild: "", candidatePatch: 0, originalSlot: NoSlot, originalBoot: Vf::Red, wasLocked: false, virtualAb: true }
pure val initial: OperatorJournal = { phase: Unstarted, lock: Unlocked, start: noStart }
pure def lockHeld(lock: InstallLock): bool = lock != Unlocked and lock != LeftLocked
pure def journalSettled(p: OperatorPhase): bool = p == Verified or p == RolledBack
pure def resumable(p: OperatorPhase): bool = p == AwaitingSideload or p == Sideloading or p == Transferred or p == VerificationFailed
pure def fallbackPhase(p: OperatorPhase): bool = p == Transferred or p == VerificationFailed or p == Verified
pure def canAcquireLock(s: OperatorJournal): bool = s.lock == Unlocked
pure def acquireLock(s: OperatorJournal): OperatorJournal = { ...s, lock: Locked({ writing: false }) }
pure def canBeginWrites(s: OperatorJournal): bool = s.lock == Locked({ writing: false }) and (resumable(s.phase) or fallbackPhase(s.phase))
pure def beginWrites(s: OperatorJournal): OperatorJournal = { ...s, lock: Locked({ writing: true }) }
pure def canReleaseLock(s: OperatorJournal): bool = lockHeld(s.lock)
pure def releaseLock(s: OperatorJournal): OperatorJournal = { ...s, lock: if (s.lock == Locked({ writing: false }) or journalSettled(s.phase)) Unlocked else LeftLocked }
pure def canRemoveLeftLock(s: OperatorJournal): bool = s.lock == LeftLocked
pure def removeLeftLock(s: OperatorJournal): OperatorJournal = { ...s, lock: Unlocked }
pure def alwaysWritesOnlyOnAJournal(s: OperatorJournal): bool = s.lock == Locked({ writing: true }) implies s.phase != Unstarted
pure def stepJournalChangesOnlyUnderLock(before: OperatorJournal, after: OperatorJournal): bool = before.phase != after.phase implies lockHeld(before.lock)
pure def stepDeviceWritesOnlyAfterTheLockIsMarked(before: OperatorJournal, after: OperatorJournal): bool =
  (before.phase != after.phase and (after.phase == Sideloading or after.phase == FallingBack)) implies before.lock == Locked({ writing: true })
pure def stepLockFreedOnlyWhenSafe(before: OperatorJournal, via: str, after: OperatorJournal): bool =
  (before.lock != Unlocked and after.lock == Unlocked) implies (via == "removeLeftLock" or before.lock == Locked({ writing: false }) or journalSettled(after.phase))
pure def sometimesLockLeftAfterFailedWrites(s: OperatorJournal): bool = s.lock == LeftLocked and s.phase == AwaitingSideload
```

### An update starts only from booted Android running the installed build on a known slot, enforcing, with a known verified boot state

The journal records what the update is checked against later: the device,
both builds, the candidate's patch level, the original slot and its verified
boot state, the bootloader lock, and whether the device is Virtual A/B.

```quint
type AndroidReading = { device: str, fingerprint: str, slot: Slot, selinux: Vf::SelinuxReading, verifiedBoot: Vf::BootReading, flashLocked: bool, securityPatch: int, virtualAb: bool }
type DeviceObservation = InSideload | InRecovery | InBootloader | Unreachable | StillBooting | OnAndroid(AndroidReading)
pure def bootAtLeast(reading: Vf::BootReading, minimum: Vf::BootState): bool = Vf::bootOutcome(Vf::BootAtLeast({ minimum: minimum }), reading) == Vf::Pass
pure def bootStateOf(reading: Vf::BootReading): Vf::BootState =
  if (bootAtLeast(reading, Vf::Green)) Vf::Green else if (bootAtLeast(reading, Vf::Yellow)) Vf::Yellow else if (bootAtLeast(reading, Vf::Orange)) Vf::Orange else Vf::Red
pure def startsFrom(observed: DeviceObservation, channel: ReleaseChannel, fromRelease: OperatorRelease): bool = match observed {
  | OnAndroid(b) => b.device == channel.device and b.fingerprint == fromRelease.release.fingerprint and b.slot != NoSlot and b.selinux == Vf::Enforcing
      and b.verifiedBoot != Vf::BootUnread
  | _ => false
}
pure def canBegin(s: OperatorJournal, channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease, observed: DeviceObservation): bool =
  s.phase == Unstarted and lockHeld(s.lock) and updateAdmitted(channel, fromRelease, toRelease) and startsFrom(observed, channel, fromRelease)
pure def begin(s: OperatorJournal, channel: ReleaseChannel, fromRelease: OperatorRelease, toRelease: OperatorRelease, observed: DeviceObservation): OperatorJournal = match observed {
  | OnAndroid(b) => { ...s, phase: AwaitingSideload, start: { device: b.device, installedBuild: b.fingerprint, candidateBuild: toRelease.release.fingerprint,
      candidatePatch: toRelease.release.securityPatch, originalSlot: b.slot, originalBoot: bootStateOf(b.verifiedBoot), wasLocked: b.flashLocked, virtualAb: b.virtualAb } }
  | _ => s
}
pure val onInstalled: AndroidReading = { device: "stallion", fingerprint: "b1", slot: SlotA, selinux: Vf::Enforcing, verifiedBoot: Vf::BootRead({ booted: Vf::Yellow }),
  flashLocked: true, securityPatch: 20260101, virtualAb: true }
pure val onCandidate: AndroidReading = { ...onInstalled, fingerprint: "b2", slot: SlotB, securityPatch: 20260201 }
pure val observedValues = Set(InSideload, InBootloader, Unreachable, OnAndroid(onInstalled), OnAndroid(onCandidate),
  OnAndroid({ ...onCandidate, verifiedBoot: Vf::BootRead({ booted: Vf::Orange }) }), OnAndroid({ ...onCandidate, selinux: Vf::Permissive }),
  OnAndroid({ ...onInstalled, slot: SlotB }), OnAndroid({ ...onInstalled, fingerprint: "b9" }))
pure def alwaysJournalBound(s: OperatorJournal): bool =
  if (s.phase == Unstarted) s.start == noStart
  else s.start.device != "" and s.start.installedBuild != "" and s.start.candidateBuild != "" and s.start.installedBuild != s.start.candidateBuild and s.start.originalSlot != NoSlot
```

### Each run resumes from what the device shows, sends the package only under a marked lock, and refuses a foreign build or the installed build on the other slot

Recovery or sideload: send the package. The candidate booted: verify. The
installed build on its original slot: the update did not take effect, so
send again. The bootloader: inspect the slots. No device, or Android still
booting: nothing can be seen. Anything else is refused. A user build cannot
enter sideload itself: the shell reboots to recovery and the operator
chooses "Apply update from ADB". A failed transfer is sent again. After a
complete transfer the shell asks the device to reboot and tells the
operator to choose the reboot where recovery stays open. Each wait, for
sideload and for the updated boot, gives the operator twenty minutes. A run
that ends without a verified update, and a check whose next step would
refuse, exit with status 1 naming the journal's phase and the next step.

```quint
type NextStep = Verify | Sideload | Retry | Bootloader | Absent | Refuse
pure def nextStep(start: StartFacts, observed: DeviceObservation): NextStep = match observed {
  | InSideload => Sideload | InRecovery => Sideload | InBootloader => Bootloader
  | OnAndroid(b) => if (b.device != start.device) Refuse else if (b.fingerprint == start.candidateBuild) Verify
      else if (b.fingerprint == start.installedBuild and b.slot == start.originalSlot) Retry else Refuse
  | _ => Absent
}
pure val started: StartFacts = { device: "stallion", installedBuild: "b1", candidateBuild: "b2", candidatePatch: 20260201, originalSlot: SlotA,
  originalBoot: Vf::Yellow, wasLocked: true, virtualAb: true }
pure val startValues = Set(started, { ...started, virtualAb: false, wasLocked: false, originalBoot: Vf::Orange })
pure def lawForeignBuildIsRefused(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.fingerprint != start.installedBuild and b.fingerprint != start.candidateBuild) implies nextStep(start, observed) == Refuse
  | _ => true
}
pure def lawInstalledBuildOnTheOtherSlotIsRefused(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.device == start.device and b.fingerprint == start.installedBuild and b.fingerprint != start.candidateBuild and b.slot != start.originalSlot)
      implies nextStep(start, observed) == Refuse
  | _ => true
}
pure def canEnterSideload(s: OperatorJournal, observed: DeviceObservation): bool =
  s.lock == Locked({ writing: true }) and resumable(s.phase) and (nextStep(s.start, observed) == Sideload or nextStep(s.start, observed) == Retry)
pure def enterSideload(s: OperatorJournal, observed: DeviceObservation): OperatorJournal = { ...s, phase: Sideloading }
pure def canTransferEnded(s: OperatorJournal, sent: bool): bool = s.phase == Sideloading and s.lock == Locked({ writing: true })
pure def transferEnded(s: OperatorJournal, sent: bool): OperatorJournal = { ...s, phase: if (sent) Transferred else AwaitingSideload }
```

### Status can read earlier journal formats without adopting an update

An earlier updater recorded Android's flash-lock property as `"0"` for
unlocked or `"1"` for locked. Status reads those values and the Boolean
format. The earlier updater recorded `interrupted` when Android finished
booting the installed build on its original slot. Status shows that record
as awaiting sideload and uses the current device observation to choose
the next step. These compatibility formats are for status only. Status
does not write the journal or the device.

```quint
type LegacyJournalUse = LegacyStatus | LegacyAdoption
type LegacyJournalShape = { propertyLock: bool, interrupted: bool }
pure val shapeValues = Set({ propertyLock: false, interrupted: false }, { propertyLock: true, interrupted: false },
  { propertyLock: false, interrupted: true }, { propertyLock: true, interrupted: true })
pure def readsLegacyJournal(use: LegacyJournalUse, shape: LegacyJournalShape): bool =
  use == LegacyStatus or (not(shape.propertyLock) and not(shape.interrupted))
pure def lawLegacyAdoptionRequiresTheExistingFormat(shape: LegacyJournalShape): bool =
  readsLegacyJournal(LegacyAdoption, shape) implies (not(shape.propertyLock) and not(shape.interrupted))
```

### An update is verified only when the candidate booted on the other slot, enforcing, still locked if it was, with verified boot no weaker and the candidate's patch level

Verified boot is compared, by [booted-image verification](../image/verification.md),
with the original slot's state, so an unread state never verifies. A failed
verification may be checked again; a verified journal changes only by a fallback.

```quint
pure def bootVerified(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => b.device == start.device and b.fingerprint == start.candidateBuild and b.slot != NoSlot and b.slot != start.originalSlot and b.selinux == Vf::Enforcing
      and (not(start.wasLocked) or b.flashLocked) and bootAtLeast(b.verifiedBoot, start.originalBoot) and b.securityPatch == start.candidatePatch
  | _ => false
}
pure def canVerifyBoot(s: OperatorJournal, observed: DeviceObservation): bool = lockHeld(s.lock) and resumable(s.phase) and nextStep(s.start, observed) == Verify
pure def verifyBoot(s: OperatorJournal, observed: DeviceObservation): OperatorJournal = { ...s, phase: if (bootVerified(s.start, observed)) Verified else VerificationFailed }
pure def lawUnreadOrWeakerBootNeverVerifies(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.verifiedBoot == Vf::BootUnread or b.selinux != Vf::Enforcing or ((start.originalBoot == Vf::Green or start.originalBoot == Vf::Yellow)
      and b.verifiedBoot == Vf::BootRead({ booted: Vf::Orange }))) implies not(bootVerified(start, observed))
  | _ => not(bootVerified(start, observed))
}
pure def stepVerifiedChangesOnlyByFallback(before: OperatorJournal, after: OperatorJournal): bool = before.phase == Verified implies (after.phase == Verified or after.phase == FallingBack)
pure def sometimesUpdateVerified(s: OperatorJournal): bool = s.phase == Verified and s.lock == Unlocked
pure def sometimesVerificationFailed(s: OperatorJournal): bool = s.phase == VerificationFailed
```

## Story: Get back if the update fails

> As a product's operator, I want to return a device to the build it ran, a
> known-good release or the stock image, only when safe and from bytes I
> verified, so that a failed update never strands it on something untrusted.

### A fallback to the original slot needs a transferred update, the updated slot current and unconfirmed, the original slot bootable and no merge, and on Virtual A/B a snapshotted update

The values come from `fastboot getvar`; one it does not report reads as the
refusing one. A slot marked successful may have stored its rollback indexes,
and on Virtual A/B the original slot survives only in an unmerged snapshot.
Otherwise recover with a compatible release or the stock image.

```quint
type SnapshotStatus = NoSnapshot | Snapshotted | Merging | SnapshotUnread
type SlotReading = { currentSlot: Slot, updatedUnconfirmed: bool, originalBootable: bool, snapshot: SnapshotStatus }
pure def updatedSlot(original: Slot): Slot = if (original == SlotA) SlotB else if (original == SlotB) SlotA else NoSlot
pure def fallbackAdmitted(start: StartFacts, slots: SlotReading): bool =
  updatedSlot(start.originalSlot) != NoSlot and slots.currentSlot == updatedSlot(start.originalSlot) and slots.updatedUnconfirmed and slots.originalBootable
    and slots.snapshot != Merging and (start.virtualAb implies slots.snapshot == Snapshotted)
pure val updatedSlotsReading: SlotReading = { currentSlot: SlotB, updatedUnconfirmed: true, originalBootable: true, snapshot: Snapshotted }
pure val slotsValues = Set(updatedSlotsReading, { ...updatedSlotsReading, snapshot: Merging }, { ...updatedSlotsReading, updatedUnconfirmed: false },
  { ...updatedSlotsReading, currentSlot: SlotA }, { ...updatedSlotsReading, snapshot: NoSnapshot })
pure def canFallback(s: OperatorJournal, slots: SlotReading): bool = s.lock == Locked({ writing: true }) and fallbackPhase(s.phase) and fallbackAdmitted(s.start, slots)
pure def fallback(s: OperatorJournal, slots: SlotReading): OperatorJournal = { ...s, phase: FallingBack }
pure def lawConfirmedOrMergingSlotNeverFallsBack(start: StartFacts, slots: SlotReading): bool =
  (not(slots.updatedUnconfirmed) or slots.snapshot == Merging or (start.virtualAb and slots.snapshot != Snapshotted)) implies not(fallbackAdmitted(start, slots))
```

### A fallback rolls back only when the installed build boots enforcing on the original slot, and a journal that started a fallback is never updated again

After switching the active slot the shell reads the current slot again; a
bootloader that did not switch ends the fallback as failed before any
reboot. A reboot command's own exit status is not taken as the outcome: the
boot that follows is. A fallback that is not admitted, or a run that does
not end rolled back, exits with status 1.

```quint
pure def bootRestored(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => b.device == start.device and b.fingerprint == start.installedBuild and b.slot == start.originalSlot and b.selinux == Vf::Enforcing
  | _ => false
}
pure def canFallbackEnded(s: OperatorJournal, observed: DeviceObservation): bool = s.phase == FallingBack and s.lock == Locked({ writing: true })
pure def fallbackEnded(s: OperatorJournal, observed: DeviceObservation): OperatorJournal = { ...s, phase: if (bootRestored(s.start, observed)) RolledBack else FallbackFailed }
pure def fallingBackOrAfter(p: OperatorPhase): bool = p == FallingBack or p == RolledBack or p == FallbackFailed
pure def stepFallbackIsFinal(before: OperatorJournal, after: OperatorJournal): bool =
  (fallingBackOrAfter(before.phase) implies fallingBackOrAfter(after.phase)) and ((before.phase == RolledBack or before.phase == FallbackFailed) implies after.phase == before.phase)
pure def sometimesRolledBack(s: OperatorJournal): bool = s.phase == RolledBack and s.lock == Unlocked
pure def sometimesFallbackFailed(s: OperatorJournal): bool = s.phase == FallbackFailed and s.lock == LeftLocked
pure val weight_beginWrites = 5
pure val weight_enterSideload = 5
pure val weight_transferEnded = 5
pure val weight_verifyBoot = 5
pure val weight_fallback = 8
pure val weight_fallbackEnded = 8
```

### Known-good retention requires a clean release-keys record and matching signed target-files and vbmeta digests

Retention checks the target-files archive and the recovery image's root
`vbmeta.img` against the recorded digests. It copies the record, target
files and recovery image into a new read-only directory, re-hashed
before every recovery plan. The plan unlocks the
bootloader and erases user data, so the shell prints it and never runs it.

```quint
type BuildKeys = ReleaseKeys | TestKeys | DevKeys
type Retention = { record: OperatorRelease, placeholders: int, keys: BuildKeys, targetFiles: Digest, recordVbmeta: Digest, imageVbmeta: Digest }
pure def retentionAdmitted(channel: ReleaseChannel, retention: Retention): bool =
  recordAdmitted(channel, retention.record) and retention.placeholders == 0 and retention.keys == ReleaseKeys
    and digestsMatch(retention.targetFiles, retention.record.signedTargetFiles) and digestsMatch(retention.imageVbmeta, retention.recordVbmeta)
pure def retainedKnownGood(channel: ReleaseChannel, retention: Retention): KnownGood =
  if (retentionAdmitted(channel, retention)) KnownGoodRelease({ buildFingerprint: retention.record.release.fingerprint, updatePackage: retention.record.otaPackage })
  else NoKnownGood
pure val retainedRelease: Retention = { record: installedRecord, placeholders: 0, keys: ReleaseKeys, targetFiles: Sha256({ hex: "s1" }), recordVbmeta: Sha256({ hex: "v1" }),
  imageVbmeta: Sha256({ hex: "v1" }) }
pure val retentionValues = Set(retainedRelease, { ...retainedRelease, keys: TestKeys }, { ...retainedRelease, keys: DevKeys }, { ...retainedRelease, placeholders: 1 },
  { ...retainedRelease, imageVbmeta: Sha256({ hex: "v2" }) }, { ...retainedRelease, targetFiles: NotADigest })
pure def lawTestOrDevKeysAreNeverKnownGood(channel: ReleaseChannel, retention: Retention): bool =
  (retention.keys != ReleaseKeys or retention.placeholders > 0) implies not(knownGoodRetained(retainedKnownGood(channel, retention)))
pure def lawRetainedReleaseIsTheChannels(channel: ReleaseChannel, retention: Retention): bool =
  knownGoodRetained(retainedKnownGood(channel, retention)) implies (retention.record.release.device == channel.device and digestsMatch(retention.record.avbKey, channel.avbPublicKey))
```

### Stock recovery prints its plan only for the channel's locked factory archive and never flashes

The archive has the channel's and the source lock's digest and the locked
size; the shell also checks it holds one top directory and exactly one
bootloader, radio and system image of the locked build (`layoutMatches`).
The operator runs the plan with physical confirmation and relocks only after
`verify-stock` reads a stock release-keys user build, enforcing.

```quint
type StockArchive = { sha256: Digest, lockedFactory: Digest, sizeMatches: bool, layoutMatches: bool }
pure def stockPlanAdmitted(channel: ReleaseChannel, archive: StockArchive): bool =
  digestsMatch(archive.sha256, channel.stockFactoryImage) and digestsMatch(channel.stockFactoryImage, archive.lockedFactory) and archive.sizeMatches and archive.layoutMatches
pure val lockedArchive: StockArchive = { sha256: Sha256({ hex: "f1" }), lockedFactory: Sha256({ hex: "f1" }), sizeMatches: true, layoutMatches: true }
pure val archiveValues = Set(lockedArchive, { ...lockedArchive, sha256: Sha256({ hex: "f2" }) }, { ...lockedArchive, lockedFactory: Sha256({ hex: "f2" }) },
  { ...lockedArchive, layoutMatches: false })
pure def lawPlanOnlyForTheLockedFactoryImage(channel: ReleaseChannel, archive: StockArchive): bool =
  stockPlanAdmitted(channel, archive) implies (archive.sha256 == channel.stockFactoryImage and archive.lockedFactory == channel.stockFactoryImage)
```
