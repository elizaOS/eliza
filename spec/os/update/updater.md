# System updater

The system updater is an optional privileged app in the image that
installs OS updates through Android's A/B update engine, for one enrolled
device and one candidate at a time. Its journal records each intent before
its effect, so a process death never repeats an apply or a reboot. Offer
observations, cryptographic acceptance and the update engine's own result
are external facts. The [product descriptor](../image/product.md) decides
whether the image includes it, and the [OS update channel](./channel.md)
is the operator's path and owns the boot checks.

## Story: Include the system updater only when selected, and keep it inactive until enrolled

> As a consumer, I want the system updater in my image only when I ask for
> it, staged from reviewed sources with its policy, and active only after
> my device is enrolled in an update channel, so that an image never
> carries an updater that installs from nowhere.

### The updater is staged only when the descriptor selects it, its reviewed sources and policy match, and its destination is free

The product descriptor's `systemUpdater` flag selects it. Admission
checks every reviewed source digest, including the SELinux policy and the
permission allow-lists. Staging publishes the updater once into a
destination it owns: an existing file at its destination refuses staging
and is left as it was, so a refused staging writes nothing. An updater the
consumer did not select is never staged, so its absence installs nothing.

```quint
import product as P from "../image/product"
import channel as C from "./channel"
type UpdaterSources = { sourcesMatch: bool, policyPresent: bool, destinationExists: bool }
type UpdaterStaging = { staged: bool, writes: int, existingKept: bool }
pure def updaterAdmitted(descriptor: P::ProductDescriptor, sources: UpdaterSources): bool =
  descriptor.systemUpdater and sources.sourcesMatch and sources.policyPresent and not(sources.destinationExists)
pure def updaterStaging(descriptor: P::ProductDescriptor, sources: UpdaterSources): UpdaterStaging =
  if (updaterAdmitted(descriptor, sources)) { staged: true, writes: 1, existingKept: false }
  else { staged: false, writes: 0, existingKept: sources.destinationExists }
pure val reviewedSources: UpdaterSources = { sourcesMatch: true, policyPresent: true, destinationExists: false }
pure val descriptorValues = Set(P::exampleDescriptor, { ...P::exampleDescriptor, systemUpdater: true })
pure val sourcesValues = Set(reviewedSources, { ...reviewedSources, sourcesMatch: false }, { ...reviewedSources, policyPresent: false },
  { ...reviewedSources, destinationExists: true })
pure def lawUnselectedUpdaterIsNeverStaged(descriptor: P::ProductDescriptor, sources: UpdaterSources): bool =
  not(descriptor.systemUpdater) implies updaterStaging(descriptor, sources) == { staged: false, writes: 0, existingKept: sources.destinationExists }
pure def lawStagedUpdaterIsAdmittedAndWrittenOnce(descriptor: P::ProductDescriptor, sources: UpdaterSources): bool =
  updaterStaging(descriptor, sources).staged implies updaterAdmitted(descriptor, sources) and updaterStaging(descriptor, sources).writes == 1
pure def lawExistingDestinationIsLeftAsItWas(descriptor: P::ProductDescriptor, sources: UpdaterSources): bool =
  sources.destinationExists implies updaterStaging(descriptor, sources) == { staged: false, writes: 0, existingKept: true }
```

### A staged updater stays inactive until the device is enrolled

Staging never enables the updater. The device is enrolled on the same
condition the [operator's channel](./channel.md) uses: a channel that
refuses downgrades and an installed record that qualifies for it. Until
then the updater starts no job, so it downloads, applies and reboots
nothing.

```quint
pure def canEnroll(s: SystemUpdate, channel: C::UpdateChannel, installed: C::ReleaseRecord): bool =
  not(s.enrolled) and C::enrollmentQualifies(channel, installed)
pure def enroll(s: SystemUpdate, channel: C::UpdateChannel, installed: C::ReleaseRecord): SystemUpdate = { ...s, enrolled: true }
pure val channelValues = C::channelValues
pure val installedValues = C::installedValues
pure def alwaysInactiveUntilEnrolled(s: SystemUpdate): bool =
  not(s.enrolled) implies (s.phase == HostIdle and not(s.active) and s.applyCalls == 0 and s.reboots == 0)
```

## Story: Download, verify and apply an OS update on the device

> As a device owner on an enrolled channel, I want my phone to install
> an OS update only after it verified it, exactly once, and only when the
> phone is ready, so that an interrupted or unexpected update never leaves
> it running something unverified or replays an install.

### An update is applied only after this job verified it

A job verifies the downloaded payload before it applies it, and the
apply call needs both a verified payload and a check made in the current
job. A candidate the updater holds as verified has passed verification.
A rejected payload that was never applied may be replaced by a new
download.

```quint
type HostPhase = HostIdle | Downloading | VerifiedUpdate | Applying | ReadyToReboot | RebootIntent | TargetBooted | UpdateComplete | RevertedToSource | SourceRetained | UpdateFailed | OutcomeUnknown
type ScratchFile = NoScratch | OwnedScratch | ForeignScratch
type OfferHold = NotHeld | NoOffer | DifferentOffer | OfferUnavailable
type ProgressStage = NoStage | Installing | VerifyingStage | Finishing
type SystemUpdate = {
  enrolled: bool, phase: HostPhase, active: bool, eligible: bool, stopped: bool, verified: bool, checked: bool,
  storageReady: bool, scratch: ScratchFile, writing: bool, applyCalls: int, reboots: int, offerHold: OfferHold,
  viewOpen: bool, viewGeneration: int, viewStage: ProgressStage, viewPercent: int
}
pure val initial: SystemUpdate = {
  enrolled: false, phase: HostIdle, active: false, eligible: true, stopped: false, verified: false, checked: false,
  storageReady: true, scratch: NoScratch, writing: false, applyCalls: 0, reboots: 0, offerHold: NotHeld,
  viewOpen: false, viewGeneration: 0, viewStage: NoStage, viewPercent: -1
}
pure def canStart(s: SystemUpdate): bool =
  s.enrolled and not(s.active) and (s.phase == HostIdle or s.phase == Downloading or s.phase == VerifiedUpdate or s.phase == ReadyToReboot)
pure def start(s: SystemUpdate): SystemUpdate = { ...s, active: true, stopped: false, checked: false, offerHold: NotHeld }
pure def canDownload(s: SystemUpdate): bool = s.active and s.phase == HostIdle and s.eligible
pure def download(s: SystemUpdate): SystemUpdate = { ...s, phase: Downloading }
pure def checkingUnapplied(s: SystemUpdate): bool =
  s.active and not(s.stopped) and not(s.checked) and (s.phase == Downloading or s.phase == VerifiedUpdate)
pure def canVerifyPayload(s: SystemUpdate): bool = checkingUnapplied(s) and s.storageReady and (s.scratch == NoScratch or s.writing)
pure def verifyPayload(s: SystemUpdate): SystemUpdate =
  { ...s, phase: VerifiedUpdate, verified: true, checked: true, scratch: NoScratch, writing: false }
pure def canRejectPayload(s: SystemUpdate): bool = checkingUnapplied(s)
pure def rejectPayload(s: SystemUpdate): SystemUpdate =
  { ...s, phase: UpdateFailed, active: false, scratch: if (s.writing) NoScratch else s.scratch, writing: false }
pure def canReplaceRejected(s: SystemUpdate): bool = not(s.active) and s.phase == UpdateFailed and s.applyCalls == 0
pure def replaceRejected(s: SystemUpdate): SystemUpdate = { ...s, phase: HostIdle, verified: false }
pure def canApplyUpdate(s: SystemUpdate): bool = s.active and not(s.stopped) and s.eligible and s.phase == VerifiedUpdate and s.checked
pure def applyUpdate(s: SystemUpdate): SystemUpdate = { ...s, phase: Applying, applyCalls: s.applyCalls + 1 }
pure def alwaysNoUnverifiedApply(s: SystemUpdate): bool = (s.applyCalls == 0 or s.verified) and (s.phase != Applying or s.checked)
pure def alwaysVerifiedCandidatePassedVerification(s: SystemUpdate): bool = s.phase == VerifiedUpdate implies s.verified
pure def sometimesCheckedCandidate(s: SystemUpdate): bool = s.phase == VerifiedUpdate and s.checked and s.active
```

### An update is applied at most once and rebooted into at most once

The apply intent is journaled before the update engine is called and is
never submitted again: once applied, the job never returns to
downloading or verifying. The reboot intent is likewise journaled once.

```quint
pure def appliedPhase(p: HostPhase): bool =
  p == Applying or p == ReadyToReboot or p == RebootIntent or p == TargetBooted or p == UpdateComplete or p == RevertedToSource or
    p == SourceRetained or p == OutcomeUnknown
pure def canApplySettled(s: SystemUpdate, succeeded: bool): bool = s.phase == Applying
pure def applySettled(s: SystemUpdate, succeeded: bool): SystemUpdate =
  { ...s, phase: if (succeeded) ReadyToReboot else UpdateFailed, active: false }
pure def alwaysAppliesAndRebootsOnce(s: SystemUpdate): bool =
  s.applyCalls >= 0 and s.applyCalls <= 1 and s.reboots >= 0 and s.reboots <= 1 and
  (appliedPhase(s.phase) implies s.applyCalls == 1) and
  (s.applyCalls == 1 implies (appliedPhase(s.phase) or s.phase == UpdateFailed)) and
  (s.reboots == 1 implies (s.phase == RebootIntent or s.phase == TargetBooted or s.phase == UpdateComplete or
    s.phase == RevertedToSource or s.phase == SourceRetained))
pure def sometimesApplyFailed(s: SystemUpdate): bool = s.phase == UpdateFailed and s.applyCalls == 1
pure val weight_start = 4
pure val weight_download = 4
pure val weight_verifyPayload = 4
pure val weight_applyUpdate = 4
pure val weight_applySettled = 4
pure val weight_checkHeld = 4
pure val weight_rebootToTarget = 4
pure val weight_holdOffer = 3
```

### An apply that outlives its process becomes unknown, never active

A process death while applying leaves the outcome unknown, and a death
after the reboot intent leaves the source slot retained; neither is
evidence of a rollback. A callback for another payload also makes the
outcome unknown. An unknown outcome is never resumed as active work and
never applied again; only booting into the target resolves it, and the
boot checks below decide whether that boot is kept.

```quint
pure def canStopJob(s: SystemUpdate): bool = s.active
pure def stopJob(s: SystemUpdate): SystemUpdate =
  { ...s, stopped: true, active: s.phase == Applying, checked: s.phase == Applying and s.checked,
    scratch: if (s.writing) NoScratch else s.scratch, writing: false }
pure def canCrash(s: SystemUpdate): bool = s.active
pure def crash(s: SystemUpdate): SystemUpdate =
  { ...s, active: false, checked: false, writing: false,
    phase: if (s.phase == Applying) OutcomeUnknown else if (s.phase == RebootIntent) SourceRetained else s.phase }
pure def canForeignApplyCallback(s: SystemUpdate): bool = s.phase == Applying
pure def foreignApplyCallback(s: SystemUpdate): SystemUpdate = { ...s, phase: OutcomeUnknown, active: false }
pure def canObserveTarget(s: SystemUpdate): bool = s.phase == RebootIntent or s.phase == SourceRetained or s.phase == OutcomeUnknown
pure def observeTarget(s: SystemUpdate): SystemUpdate = { ...s, phase: TargetBooted, active: false }
pure def alwaysUnknownNeverActive(s: SystemUpdate): bool = s.phase == OutcomeUnknown implies not(s.active)
pure def sometimesApplyOutcomeUnknown(s: SystemUpdate): bool = s.phase == OutcomeUnknown
pure def sometimesSourceRetained(s: SystemUpdate): bool = s.phase == SourceRetained
```

### Apply and reboot wait for eligible conditions, and a held offer keeps the applied candidate

The job applies and reboots only while the device's conditions (battery,
idle display, no call) are eligible. A ready candidate is checked again in
each new job before the reboot. If the engine no longer offers it, offers
a different one, or cannot say, the job stops and keeps the applied
candidate as it is, not checked and not rebooted; the engine can also
hold the reboot itself.

```quint
pure def canObserveConditions(s: SystemUpdate, eligible: bool): bool = s.eligible != eligible
pure def observeConditions(s: SystemUpdate, eligible: bool): SystemUpdate = { ...s, eligible: eligible }
pure def canCheckHeld(s: SystemUpdate, valid: bool): bool = s.active and not(s.stopped) and not(s.checked) and s.phase == ReadyToReboot
pure def checkHeld(s: SystemUpdate, valid: bool): SystemUpdate =
  { ...s, active: valid and s.storageReady, checked: valid and s.storageReady }
pure def canHoldOffer(s: SystemUpdate, reason: OfferHold): bool =
  s.active and not(s.stopped) and s.phase == ReadyToReboot and (not(s.checked) or s.eligible) and reason != NotHeld
pure def holdOffer(s: SystemUpdate, reason: OfferHold): SystemUpdate = { ...s, active: false, checked: false, offerHold: reason }
pure def canHoldEngine(s: SystemUpdate): bool = s.active and not(s.stopped) and s.eligible and s.checked and s.phase == ReadyToReboot
pure def holdEngine(s: SystemUpdate): SystemUpdate = { ...s, active: false, checked: false }
pure def canRebootToTarget(s: SystemUpdate): bool = s.active and not(s.stopped) and s.eligible and s.checked and s.phase == ReadyToReboot
pure def rebootToTarget(s: SystemUpdate): SystemUpdate = { ...s, phase: RebootIntent, reboots: s.reboots + 1 }
pure def alwaysOfferHoldKeepsApplied(s: SystemUpdate): bool =
  s.offerHold == NotHeld or (s.phase == ReadyToReboot and not(s.active) and not(s.checked) and s.applyCalls == 1 and s.reboots == 0)
pure def sometimesDifferentOfferHeld(s: SystemUpdate): bool = s.offerHold == DifferentOffer
```

### A booted target is marked successful only after the channel's boot checks pass

After the reboot the updater reads the booted device with the same checks
the operator's channel uses: the slot switched, SELinux enforces, a locked
bootloader stayed locked, verified boot is no weaker and the security
patch matches. Only then is the boot marked successful; otherwise the
device falls back to the source slot. Neither outcome is applied again.

```quint
pure def canVerifyTargetBoot(s: SystemUpdate, check: C::BootCheck): bool = s.phase == TargetBooted
pure def verifyTargetBoot(s: SystemUpdate, check: C::BootCheck): SystemUpdate =
  { ...s, phase: if (C::bootVerified(check)) UpdateComplete else RevertedToSource }
pure val checkValues = Set(C::passingCheck, { ...C::passingCheck, slotSwitched: false }, { ...C::passingCheck, verifiedBootNotWeaker: false })
pure def stepCompletionNeedsVerifiedBoot(before: SystemUpdate, via: str, after: SystemUpdate): bool =
  (after.phase == UpdateComplete and before.phase != UpdateComplete) implies via == "verifyTargetBoot" and before.phase == TargetBooted
pure def sometimesUpdateComplete(s: SystemUpdate): bool = s.phase == UpdateComplete and s.reboots == 1
pure def sometimesTargetRevertedToSource(s: SystemUpdate): bool = s.phase == RevertedToSource
```

### Low storage defers a download without losing it, and scratch bytes are never applied

Verification writes its scratch file only while storage is ready, into
the updater's one owned slot. Low storage defers the job and keeps the
download or the verified candidate for a later job. A scratch file left
by a process death is reclaimed before a new one is written; a scratch
file the updater did not write is refused and held. A scratch file never
survives into an applied phase, and a checked candidate has none.

```quint
pure def canObserveStorage(s: SystemUpdate, ready: bool): bool = s.storageReady != ready
pure def observeStorage(s: SystemUpdate, ready: bool): SystemUpdate = { ...s, storageReady: ready }
pure def canWriteScratch(s: SystemUpdate): bool = checkingUnapplied(s) and s.storageReady and s.scratch == NoScratch
pure def writeScratch(s: SystemUpdate): SystemUpdate = { ...s, scratch: OwnedScratch, writing: true }
pure def canReclaimScratch(s: SystemUpdate): bool = checkingUnapplied(s) and s.scratch == OwnedScratch and not(s.writing)
pure def reclaimScratch(s: SystemUpdate): SystemUpdate = { ...s, scratch: NoScratch }
pure def canRefuseScratch(s: SystemUpdate): bool = checkingUnapplied(s) and s.scratch == ForeignScratch
pure def refuseScratch(s: SystemUpdate): SystemUpdate = { ...s, active: false }
pure def canDeferStorage(s: SystemUpdate): bool = checkingUnapplied(s) and not(s.storageReady) and (s.scratch == NoScratch or s.writing)
pure def deferStorage(s: SystemUpdate): SystemUpdate = { ...s, active: false, scratch: NoScratch, writing: false }
pure def canFindForeignScratch(s: SystemUpdate): bool =
  not(s.active) and not(s.checked) and s.scratch == NoScratch and (s.phase == HostIdle or s.phase == Downloading or s.phase == VerifiedUpdate)
pure def findForeignScratch(s: SystemUpdate): SystemUpdate = { ...s, scratch: ForeignScratch }
pure def alwaysScratchNeverApplied(s: SystemUpdate): bool =
  (s.scratch == NoScratch or s.phase == HostIdle or s.phase == Downloading or s.phase == VerifiedUpdate or s.phase == UpdateFailed) and
  (not(s.writing) or (checkingUnapplied(s) and s.scratch == OwnedScratch)) and
  (s.checked implies s.scratch == NoScratch)
pure def sometimesStorageDeferred(s: SystemUpdate): bool = s.phase == Downloading and not(s.active) and not(s.storageReady) and s.applyCalls == 0
pure def sometimesForeignScratchHeld(s: SystemUpdate): bool = s.scratch == ForeignScratch and s.phase == Downloading and not(s.active)
```

### A progress view shows only valid progress of its own generation

Opening the view starts a new generation; closing it clears what it
showed. An observation of another generation, or one outside the
installing, verifying and finishing stages or outside 0 to 100 percent,
changes nothing. Progress is read-only: it never applies or reboots.

```quint
pure def canOpenView(s: SystemUpdate): bool = not(s.viewOpen)
pure def openView(s: SystemUpdate): SystemUpdate = { ...s, viewOpen: true, viewGeneration: s.viewGeneration + 1 }
pure def canCloseView(s: SystemUpdate): bool = s.viewOpen
pure def closeView(s: SystemUpdate): SystemUpdate = { ...s, viewOpen: false, viewStage: NoStage, viewPercent: -1 }
pure def canObserveView(s: SystemUpdate, generation: int, stage: ProgressStage, percent: int): bool =
  s.viewOpen and generation == s.viewGeneration and stage != NoStage and percent >= 0 and percent <= 100
pure def observeView(s: SystemUpdate, generation: int, stage: ProgressStage, percent: int): SystemUpdate =
  { ...s, viewStage: stage, viewPercent: percent }
pure val generationValues = Set(0, 1, 2)
pure val percentValues = Set(-1, 0, 50, 100, 101)
pure def alwaysValidProgress(s: SystemUpdate): bool =
  (s.viewPercent == -1 and s.viewStage == NoStage) or
  (s.viewOpen and s.viewPercent >= 0 and s.viewPercent <= 100 and s.viewStage != NoStage)
pure def stepProgressIsReadOnly(before: SystemUpdate, via: str, after: SystemUpdate): bool =
  (via == "openView" or via == "closeView" or via == "observeView") implies
    after.applyCalls == before.applyCalls and after.reboots == before.reboots and after.phase == before.phase
pure def sometimesProgressShown(s: SystemUpdate): bool = s.viewOpen and s.viewPercent == 50
```

## Story: Resume a download by a checked range

> As a device owner, I want an interrupted update download to resume from
> what was already verified, so that a bad or oversized file is thrown
> away and only verified bytes are ever published for installation.

### A download publishes only verified bytes, resuming only from a checked prefix

One call settles one attempt for the one known-unapplied candidate in the
updater's private cache, under the cache's file lock. A complete valid
file publishes without the network. A valid prefix resumes with one
ranged request; an empty cache fetches the whole file. Publication moves
the bytes out of the partial file.

```quint
type PartialFile = PartialEmpty | PartialPrefix | PartialBadPrefix | PartialCorrupt | PartialOversized | PartialValid
type DownloadOutcome = DownloadBusy | DownloadRejected | DownloadPaused | DownloadPublished
type DownloadResult = { kept: PartialFile, outcome: DownloadOutcome, fetched: bool, ranged: bool }
pure def retained(p: PartialFile): bool = p == PartialPrefix or p == PartialBadPrefix or p == PartialCorrupt or p == PartialValid
pure def attemptDownload(partial: PartialFile, peerLock: bool, cancelled: bool, interrupted: bool): DownloadResult = {
  val resumes = partial == PartialPrefix or partial == PartialBadPrefix
  if (peerLock) { kept: partial, outcome: DownloadBusy, fetched: false, ranged: false }
  else if (cancelled and retained(partial)) { kept: partial, outcome: DownloadPaused, fetched: false, ranged: false }
  else if (partial == PartialCorrupt or partial == PartialOversized) { kept: PartialEmpty, outcome: DownloadRejected, fetched: false, ranged: false }
  else if (partial == PartialValid) { kept: PartialEmpty, outcome: DownloadPublished, fetched: false, ranged: false }
  else if (interrupted) { kept: if (partial == PartialBadPrefix) PartialBadPrefix else PartialPrefix, outcome: DownloadPaused, fetched: true, ranged: resumes }
  else if (partial == PartialBadPrefix) { kept: PartialEmpty, outcome: DownloadRejected, fetched: true, ranged: true }
  else { kept: PartialEmpty, outcome: DownloadPublished, fetched: true, ranged: resumes }
}
pure def lawPublishedBytesWereVerified(partial: PartialFile, peerLock: bool, cancelled: bool, interrupted: bool): bool = {
  val r = attemptDownload(partial, peerLock, cancelled, interrupted)
  r.outcome == DownloadPublished implies
    r.kept == PartialEmpty and (partial == PartialEmpty or partial == PartialPrefix or partial == PartialValid) and
    r.fetched == (partial != PartialValid) and r.ranged == (partial == PartialPrefix)
}
```

### A rejected file is reset and never published

A corrupt or oversized complete file is reset before any network request
and the call fails; the next call fetches again. A prefix that fails its
digest after the ranged fetch is reset too.

```quint
pure def lawRejectedBytesAreResetUnread(partial: PartialFile, peerLock: bool, cancelled: bool, interrupted: bool): bool = {
  val r = attemptDownload(partial, peerLock, cancelled, interrupted)
  (r.outcome == DownloadRejected implies r.kept == PartialEmpty) and
  ((r.outcome == DownloadRejected and (partial == PartialCorrupt or partial == PartialOversized)) implies not(r.fetched))
}
```

### A call that finds the cache locked by a peer, or is cancelled while reading, keeps the bytes it found

A peer holding the cache's lock makes the call busy without touching the
file or the network. Cancellation or a deadline while hashing retained
bytes keeps them for the next call.

```quint
pure def lawBusyOrCancelledKeepsTheFile(partial: PartialFile, peerLock: bool, cancelled: bool, interrupted: bool): bool = {
  val r = attemptDownload(partial, peerLock, cancelled, interrupted)
  (peerLock or (cancelled and retained(partial))) implies r.kept == partial and not(r.fetched)
}
```
