# Operator update by cable

An operator moves one enrolled device, attached by cable, from its installed
release to a candidate on one update channel, and gets it back when the
update does not hold. The device's own recovery verifies the package against
its OTA certificate (`adb reboot recovery`, the operator's "Apply update from
ADB", `adb sideload`) and its bootloader enforces verified boot and rollback
protection; nothing here signs, builds, relocks or wipes. Source:
`packages/os/scripts/android/aosp-ota-update.mjs` and `install-lock.ts` on
develop. The shell is `src/image/ota-operator.vibe` (`eliza-os ota check |
apply | status | fallback | stock-archive | verify-stock |
retain-known-good`); it reads the channel and the release records
[release signing](../image/signing.md) wrote, runs `adb` and `fastboot`, and
keeps this machine in a private journal file it replaces atomically. The
[system updater](./updater.md) is the on-device path; its admission is
reused here. Results are observations for the release owner's drill record:
nothing here marks a drill passed.

## Story: Update a device by cable

> As a product's operator, I want to move a device to a new release only from
> a signed record of its own channel, and to resume an interrupted update
> from what the device shows, so that a device never takes a foreign, older
> or unverifiable build and an update is never assumed complete.

### A candidate is admitted only from a signed record of the channel, with the same OTA certificate and AVB key, its build date as post-timestamp and no lower rollback index

Both records list no problem and name the channel's product, device and
channel; the updater's admission (`U::candidateAdmitted`) adds a different
fingerprint, a newer build date and no lower security or vendor patch level.
Every rollback index location of the installed release has an index in the
candidate that is not lower, since the bootloader would refuse to boot it.
A channel that allows downgrades admits nothing.

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
pure def rollbackNotLower(installed: OperatorRelease, candidate: OperatorRelease): bool =
  installed.rollbackIndexes.every(i => candidate.rollbackIndexes.some(c => c.location == i.location and c.index >= i.index))
pure def updateAdmitted(channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease): bool =
  not(channel.downgradeAllowed) and recordAdmitted(channel, installed) and recordAdmitted(channel, candidate) and U::candidateAdmitted(installed.release, candidate.release)
    and candidate.postTimestamp == candidate.release.buildDate and rollbackNotLower(installed, candidate) and startsFromInstalled(installed, candidate)
pure val installedRecord: OperatorRelease = { release: { fingerprint: "b1", product: "acme_stallion", device: "stallion", buildDate: 20260101, securityPatch: 20260101, vendorPatch: 20260101 },
  channel: "stable", problems: 0, otaCertificate: Sha256({ hex: "o1" }), avbKey: Sha256({ hex: "k1" }), rollbackIndexes: List({ location: 0, index: 1 }),
  postTimestamp: 20260101, ota: FullOta, otaPackage: Sha256({ hex: "u1" }), signedTargetFiles: Sha256({ hex: "s1" }) }
pure val candidateRecord: OperatorRelease = { ...installedRecord, release: { ...installedRecord.release, fingerprint: "b2", buildDate: 20260201, securityPatch: 20260201 },
  postTimestamp: 20260201, rollbackIndexes: List({ location: 0, index: 2 }), otaPackage: Sha256({ hex: "u2" }), signedTargetFiles: Sha256({ hex: "s2" }) }
pure val channelValues = Set(acmeChannel, { ...acmeChannel, downgradeAllowed: true }, { ...acmeChannel, otaCertificate: Sha256({ hex: "o2" }) })
pure val installedValues = Set(installedRecord)
pure val candidateValues = Set(candidateRecord, { ...candidateRecord, rollbackIndexes: List({ location: 0, index: 0 }) }, { ...candidateRecord, postTimestamp: 20260101 },
  { ...candidateRecord, ota: IncrementalOta({ preBuild: "b1", fromTargetFiles: Sha256({ hex: "s1" }) }) },
  { ...candidateRecord, ota: IncrementalOta({ preBuild: "b0", fromTargetFiles: Sha256({ hex: "s1" }) }) }, { ...candidateRecord, rollbackIndexes: List({ location: 1, index: 9 }) })
pure def lawDowngradeChannelAdmitsNothing(channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease): bool =
  channel.downgradeAllowed implies not(updateAdmitted(channel, installed, candidate))
pure def lawLowerOrMissingRollbackIndexIsRefused(channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease): bool =
  installed.rollbackIndexes.some(i => not(candidate.rollbackIndexes.some(c => c.location == i.location and c.index >= i.index))) implies not(updateAdmitted(channel, installed, candidate))
```

### An incremental package starts from exactly the installed build and its signed target files

```quint
pure def startsFromInstalled(installed: OperatorRelease, candidate: OperatorRelease): bool = match candidate.ota {
  | IncrementalOta(o) => o.preBuild == installed.release.fingerprint and digestsMatch(o.fromTargetFiles, installed.signedTargetFiles)
  | _ => true
}
pure def lawIncrementalFromAnotherBuildIsRefused(channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease): bool =
  candidate.ota == IncrementalOta({ preBuild: "b0", fromTargetFiles: Sha256({ hex: "s1" }) }) implies not(updateAdmitted(channel, installed, candidate))
```

### One device has one operator: every journal change and device write happens under the device's install lock

The lock is a private file per serial, created exclusively for the whole
run. A run marks the lock before its first device write. A run that ends
without writes, or that settles the journal, removes its own lock; any other
end, a process death included, leaves the lock for the operator to inspect
and remove by hand, because process identifiers are reused and the device
state is unknown.

```quint
type InstallLock = Unlocked | Locked({ writing: bool }) | LeftLocked
type OperatorPhase = Unstarted | AwaitingSideload | Sideloading | Transferred | VerificationFailed | Verified | FallingBack | FallbackFailed | RolledBack
type Slot = NoSlot | SlotA | SlotB
type StartFacts = { device: str, installedBuild: str, candidateBuild: str, candidatePatch: int, originalSlot: Slot, originalBoot: Vf::BootState, wasLocked: bool, virtualAb: bool }
type OperatorJournal = { phase: OperatorPhase, lock: InstallLock, start: StartFacts }
pure val noStart: StartFacts = { device: "", installedBuild: "", candidateBuild: "", candidatePatch: 0, originalSlot: NoSlot, originalBoot: Vf::Red, wasLocked: false, virtualAb: true }
pure val initial: OperatorJournal = { phase: Unstarted, lock: Unlocked, start: noStart }
pure def lockHeld(lock: InstallLock): bool = lock != Unlocked and lock != LeftLocked
pure def settled(p: OperatorPhase): bool = p == Verified or p == RolledBack
pure def resumable(p: OperatorPhase): bool = p == AwaitingSideload or p == Sideloading or p == Transferred or p == VerificationFailed
pure def fallbackPhase(p: OperatorPhase): bool = p == Transferred or p == VerificationFailed or p == Verified
pure def canAcquireLock(s: OperatorJournal): bool = s.lock == Unlocked
pure def acquireLock(s: OperatorJournal): OperatorJournal = { ...s, lock: Locked({ writing: false }) }
pure def canBeginWrites(s: OperatorJournal): bool = s.lock == Locked({ writing: false }) and (resumable(s.phase) or fallbackPhase(s.phase))
pure def beginWrites(s: OperatorJournal): OperatorJournal = { ...s, lock: Locked({ writing: true }) }
pure def canReleaseLock(s: OperatorJournal): bool = lockHeld(s.lock)
pure def releaseLock(s: OperatorJournal): OperatorJournal = { ...s, lock: if (s.lock == Locked({ writing: false }) or settled(s.phase)) Unlocked else LeftLocked }
pure def canRemoveLeftLock(s: OperatorJournal): bool = s.lock == LeftLocked
pure def removeLeftLock(s: OperatorJournal): OperatorJournal = { ...s, lock: Unlocked }
pure def alwaysWritesOnlyOnAJournal(s: OperatorJournal): bool = s.lock == Locked({ writing: true }) implies s.phase != Unstarted
pure def stepJournalChangesOnlyUnderLock(before: OperatorJournal, after: OperatorJournal): bool = before.phase != after.phase implies lockHeld(before.lock)
pure def stepDeviceWritesOnlyAfterTheLockIsMarked(before: OperatorJournal, after: OperatorJournal): bool =
  (before.phase != after.phase and (after.phase == Sideloading or after.phase == FallingBack)) implies before.lock == Locked({ writing: true })
pure def stepLockFreedOnlyWhenSafe(before: OperatorJournal, via: str, after: OperatorJournal): bool =
  (before.lock != Unlocked and after.lock == Unlocked) implies (via == "removeLeftLock" or before.lock == Locked({ writing: false }) or settled(after.phase))
pure def sometimesLockLeftAfterFailedWrites(s: OperatorJournal): bool = s.lock == LeftLocked and s.phase == AwaitingSideload
```

### An update starts only from booted Android running the installed build on a known slot, enforcing, with a known verified boot state

The journal records what the update is checked against later: the device,
both builds, the candidate's patch level, the original slot, its verified
boot state, whether the bootloader was locked, and whether the device is
Virtual A/B.

```quint
type AndroidReading = { device: str, fingerprint: str, slot: Slot, selinux: Vf::SelinuxReading, verifiedBoot: Vf::BootReading, flashLocked: bool, securityPatch: int, virtualAb: bool }
type DeviceObservation = InSideload | InRecovery | InBootloader | Unreachable | StillBooting | OnAndroid(AndroidReading)
pure def bootStateOf(reading: Vf::BootReading): Vf::BootState = match reading { | Vf::BootRead(r) => r.booted | _ => Vf::Red }
pure def startsFrom(observed: DeviceObservation, channel: ReleaseChannel, installed: OperatorRelease): bool = match observed {
  | OnAndroid(b) => b.device == channel.device and b.fingerprint == installed.release.fingerprint and b.slot != NoSlot and b.selinux == Vf::Enforcing and b.verifiedBoot != Vf::BootUnread
  | _ => false
}
pure def canBegin(s: OperatorJournal, channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease, observed: DeviceObservation): bool =
  s.phase == Unstarted and lockHeld(s.lock) and updateAdmitted(channel, installed, candidate) and startsFrom(observed, channel, installed)
pure def begin(s: OperatorJournal, channel: ReleaseChannel, installed: OperatorRelease, candidate: OperatorRelease, observed: DeviceObservation): OperatorJournal = match observed {
  | OnAndroid(b) => { ...s, phase: AwaitingSideload, start: { device: b.device, installedBuild: b.fingerprint, candidateBuild: candidate.release.fingerprint,
      candidatePatch: candidate.release.securityPatch, originalSlot: b.slot, originalBoot: bootStateOf(b.verifiedBoot), wasLocked: b.flashLocked, virtualAb: b.virtualAb } }
  | _ => s
}
pure val onInstalled: AndroidReading = { device: "stallion", fingerprint: "b1", slot: SlotA, selinux: Vf::Enforcing, verifiedBoot: Vf::BootRead({ booted: Vf::Yellow }),
  flashLocked: true, securityPatch: 20260101, virtualAb: true }
pure val onCandidate: AndroidReading = { ...onInstalled, fingerprint: "b2", slot: SlotB, securityPatch: 20260201 }
pure val observedValues = Set(InSideload, InBootloader, Unreachable, OnAndroid(onInstalled), OnAndroid(onCandidate), OnAndroid({ ...onCandidate, verifiedBoot: Vf::BootRead({ booted: Vf::Orange }) }),
  OnAndroid({ ...onCandidate, selinux: Vf::Permissive }), OnAndroid({ ...onInstalled, slot: SlotB }), OnAndroid({ ...onInstalled, fingerprint: "b9" }))
pure def alwaysJournalBound(s: OperatorJournal): bool =
  if (s.phase == Unstarted) s.start == noStart
  else s.start.device != "" and s.start.installedBuild != "" and s.start.candidateBuild != "" and s.start.installedBuild != s.start.candidateBuild and s.start.originalSlot != NoSlot
```

### Each run resumes from what the device shows, and refuses a foreign build or the installed build on the other slot

Recovery or sideload means send the package (`Sideload`); the candidate
booted means `Verify`; the installed build on its original slot means the
update did not take effect or the bootloader fell back (`Retry`, which sends
again); the bootloader means inspect the slots (`Bootloader`); no device, or
Android still booting, means the outcome cannot be seen (`Absent`). Anything
else is `Refuse`. Only `Sideload`, `Retry` and `Verify` move the journal.

```quint
type NextStep = Verify | Sideload | Retry | Bootloader | Absent | Refuse
pure def nextStep(start: StartFacts, observed: DeviceObservation): NextStep = match observed {
  | InSideload => Sideload
  | InRecovery => Sideload
  | InBootloader => Bootloader
  | OnAndroid(b) => if (b.device != start.device) Refuse else if (b.fingerprint == start.candidateBuild) Verify
      else if (b.fingerprint == start.installedBuild and b.slot == start.originalSlot) Retry else Refuse
  | _ => Absent
}
pure val started: StartFacts = { device: "stallion", installedBuild: "b1", candidateBuild: "b2", candidatePatch: 20260201, originalSlot: SlotA, originalBoot: Vf::Yellow, wasLocked: true, virtualAb: true }
pure val startValues = Set(started, { ...started, virtualAb: false, wasLocked: false })
pure def lawForeignBuildIsRefused(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.fingerprint != start.installedBuild and b.fingerprint != start.candidateBuild) implies nextStep(start, observed) == Refuse
  | _ => true
}
pure def lawInstalledBuildOnTheOtherSlotIsRefused(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.device == start.device and b.fingerprint == start.installedBuild and b.slot != start.originalSlot) implies nextStep(start, observed) == Refuse
  | _ => true
}
```

### The package is sent only after the lock is marked, and a failed or unseen transfer is resumed by sending again

A user build's adbd cannot enter sideload itself, so the shell reboots to
recovery and the operator chooses "Apply update from ADB"; a device that
does not reach sideload changes nothing. A failed transfer returns the
journal to `AwaitingSideload`.

```quint
pure def canEnterSideload(s: OperatorJournal, observed: DeviceObservation): bool =
  s.lock == Locked({ writing: true }) and resumable(s.phase) and (nextStep(s.start, observed) == Sideload or nextStep(s.start, observed) == Retry)
pure def enterSideload(s: OperatorJournal, observed: DeviceObservation): OperatorJournal = { ...s, phase: Sideloading }
pure def canTransferEnded(s: OperatorJournal, sent: bool): bool = s.phase == Sideloading and s.lock == Locked({ writing: true })
pure def transferEnded(s: OperatorJournal, sent: bool): OperatorJournal = { ...s, phase: if (sent) Transferred else AwaitingSideload }
```

### An update is verified only when the candidate booted on the other slot, enforcing, still locked if it was, with verified boot no weaker and the candidate's patch level

Verified boot is compared with the state the original slot booted in,
through [booted-image verification](../image/verification.md), so an
unread state never verifies. A failed verification may be checked again;
a verified journal changes only by a fallback.

```quint
pure def bootVerified(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => b.device == start.device and b.fingerprint == start.candidateBuild and b.slot != NoSlot and b.slot != start.originalSlot and b.selinux == Vf::Enforcing
      and (not(start.wasLocked) or b.flashLocked) and Vf::bootOutcome(Vf::BootAtLeast({ minimum: start.originalBoot }), b.verifiedBoot) == Vf::Pass and b.securityPatch == start.candidatePatch
  | _ => false
}
pure def canVerifyBoot(s: OperatorJournal, observed: DeviceObservation): bool = lockHeld(s.lock) and resumable(s.phase) and nextStep(s.start, observed) == Verify
pure def verifyBoot(s: OperatorJournal, observed: DeviceObservation): OperatorJournal = { ...s, phase: if (bootVerified(s.start, observed)) Verified else VerificationFailed }
pure def lawUnreadOrWeakerBootNeverVerifies(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => (b.verifiedBoot == Vf::BootUnread or b.verifiedBoot == Vf::BootRead({ booted: Vf::Orange }) or b.selinux != Vf::Enforcing) implies not(bootVerified(start, observed))
  | _ => not(bootVerified(start, observed))
}
pure def stepVerifiedChangesOnlyByFallback(before: OperatorJournal, after: OperatorJournal): bool = before.phase == Verified implies (after.phase == Verified or after.phase == FallingBack)
pure def sometimesUpdateVerified(s: OperatorJournal): bool = s.phase == Verified and s.lock == Unlocked
pure def sometimesVerificationFailed(s: OperatorJournal): bool = s.phase == VerificationFailed
```

## Story: Get back if the update fails

> As a product's operator, I want to return a device to the build it ran, or
> to a release I know is good, or to the stock image, only when that is safe
> and from bytes I verified, so that a failed update never strands the
> device on something I cannot trust.

### A fallback to the original slot needs a transferred update, the updated slot current and unconfirmed, the original slot bootable and no merge, and on Virtual A/B a snapshotted update

The bootloader values come from `fastboot getvar`; a value it does not
report reads as the refusing one. Once the updated slot is marked
successful its rollback indexes may be stored, so the original build may no
longer boot; on Virtual A/B the original slot survives only in an unmerged
snapshot. Otherwise recover with a compatible release or the stock image.

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

A rolled-back journal records the operator's decision against this update:
updating again starts a new journal.

```quint
pure def bootRestored(start: StartFacts, observed: DeviceObservation): bool = match observed {
  | OnAndroid(b) => b.fingerprint == start.installedBuild and b.slot == start.originalSlot and b.selinux == Vf::Enforcing
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

### A release is retained as known-good only from an admitted release-keys record with no placeholder, whose target files and image are the bytes it names

Retention copies the record, the signed target files and the signed image
into a new read-only directory; every recovery plan re-hashes them first.
The plan reflashes with `fastboot`, which unlocks the bootloader and erases
user data, so the shell prints it and never runs it. What it retains is the
channel's known-good release of [release signing](../image/signing.md).

```quint
type BuildKeys = ReleaseKeys | TestKeys | DevKeys
type Retention = { record: OperatorRelease, placeholders: int, keys: BuildKeys, targetFiles: Digest, recordVbmeta: Digest, imageVbmeta: Digest }
pure def retentionAdmitted(channel: ReleaseChannel, retention: Retention): bool =
  recordAdmitted(channel, retention.record) and retention.placeholders == 0 and retention.keys == ReleaseKeys
    and digestsMatch(retention.targetFiles, retention.record.signedTargetFiles) and digestsMatch(retention.imageVbmeta, retention.recordVbmeta)
pure def retainedKnownGood(channel: ReleaseChannel, retention: Retention): KnownGood =
  if (retentionAdmitted(channel, retention)) KnownGoodRelease({ buildFingerprint: retention.record.release.fingerprint, updatePackage: retention.record.otaPackage }) else NoKnownGood
pure val retainedRelease: Retention = { record: installedRecord, placeholders: 0, keys: ReleaseKeys, targetFiles: Sha256({ hex: "s1" }), recordVbmeta: Sha256({ hex: "v1" }), imageVbmeta: Sha256({ hex: "v1" }) }
pure val retentionValues = Set(retainedRelease, { ...retainedRelease, keys: TestKeys }, { ...retainedRelease, keys: DevKeys }, { ...retainedRelease, placeholders: 1 },
  { ...retainedRelease, imageVbmeta: Sha256({ hex: "v2" }) }, { ...retainedRelease, targetFiles: NotADigest })
pure def lawTestOrDevKeysAreNeverKnownGood(channel: ReleaseChannel, retention: Retention): bool =
  (retention.keys != ReleaseKeys or retention.placeholders > 0) implies not(knownGoodRetained(retainedKnownGood(channel, retention)))
pure def lawRetainedReleaseIsTheChannels(channel: ReleaseChannel, retention: Retention): bool =
  knownGoodRetained(retainedKnownGood(channel, retention)) implies (retention.record.release.device == channel.device and digestsMatch(retention.record.avbKey, channel.avbPublicKey))
```

### Stock recovery prints its plan only for the channel's locked factory archive and never flashes

The archive's SHA-256 must be the channel's stock factory image and the
source lock's factory archive, with the locked size, one top directory and
exactly one bootloader, radio and system image of the locked build. The
plan unlocks the bootloader, erases the custom AVB key and wipes data; the
operator runs it with physical confirmation, and relocks only after
`verify-stock` reads a stock release-keys user build, enforcing.

```quint
type StockArchive = { sha256: Digest, lockedFactory: Digest, sizeMatches: bool, topDirectories: int, bootloaderImages: int, radioImages: int, systemImages: int, buildMatches: bool }
pure def stockPlanAdmitted(channel: ReleaseChannel, archive: StockArchive): bool =
  digestsMatch(archive.sha256, channel.stockFactoryImage) and digestsMatch(channel.stockFactoryImage, archive.lockedFactory) and archive.sizeMatches
    and archive.topDirectories == 1 and archive.bootloaderImages == 1 and archive.radioImages == 1 and archive.systemImages == 1 and archive.buildMatches
pure val lockedArchive: StockArchive = { sha256: Sha256({ hex: "f1" }), lockedFactory: Sha256({ hex: "f1" }), sizeMatches: true, topDirectories: 1, bootloaderImages: 1, radioImages: 1, systemImages: 1, buildMatches: true }
pure val archiveValues = Set(lockedArchive, { ...lockedArchive, sha256: Sha256({ hex: "f2" }) }, { ...lockedArchive, lockedFactory: Sha256({ hex: "f2" }) },
  { ...lockedArchive, radioImages: 2 }, { ...lockedArchive, buildMatches: false })
pure def lawPlanOnlyForTheLockedFactoryImage(channel: ReleaseChannel, archive: StockArchive): bool =
  stockPlanAdmitted(channel, archive) implies (archive.sha256 == channel.stockFactoryImage and archive.lockedFactory == channel.stockFactoryImage)
```
