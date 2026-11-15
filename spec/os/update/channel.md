# OS update channel

An operator moves an enrolled device from its installed release to a
candidate on one update channel. The channel names its product, device and
channel, the update package certificate and the verified-boot public key,
and it refuses downgrades. Each release is described by the release record
[release signing](../image/signing.md) wrote. The operator's journal is
one update: it is planned, the package is transferred by sideload, and the
booted device is classified and verified. The steps the operator performs
on the device itself, entering sideload and rebooting after it, are
instructions the journal hands over, not effects it performs. The
[system updater](./updater.md) is the on-device path for enrolled devices.

## Story: Publish an OS update to an enrolled channel

> As a consumer's operator, I want to move an enrolled device to a new
> release only from a signed record of the same product and device, so
> that a device never takes a foreign, unsigned or older build and an
> interrupted update is resumed rather than repeated.

### A release is applied only from a signed record of the channel's product, device and channel

The record must list no problems, name the channel's product, device and
channel, carry the channel's update package certificate and verified-boot
key, and record a build date and a security patch level. Both the
installed and the candidate record must qualify.

```quint
type ReleaseRecord = { product: str, device: str, channel: str, problemsRecorded: bool, certificate: str, bootKey: str, buildDate: int, securityPatch: int, rollbackIndex: int }
type UpdateChannel = { channelProduct: str, channelDevice: str, channelName: str, channelCertificate: str, channelBootKey: str, downgradeAllowed: bool }
pure val enrolledChannel: UpdateChannel = { channelProduct: "product", channelDevice: "device", channelName: "stable", channelCertificate: "cert", channelBootKey: "avb", downgradeAllowed: false }
pure def recordQualifies(r: ReleaseRecord, c: UpdateChannel): bool =
  not(r.problemsRecorded) and r.product == c.channelProduct and r.device == c.channelDevice and r.channel == c.channelName and
  c.channelCertificate != "" and r.certificate == c.channelCertificate and c.channelBootKey != "" and r.bootKey == c.channelBootKey and
  r.buildDate > 0 and r.securityPatch > 0
pure val installedRelease: ReleaseRecord = { product: "product", device: "device", channel: "stable", problemsRecorded: false, certificate: "cert", bootKey: "avb", buildDate: 10, securityPatch: 5, rollbackIndex: 1 }
pure val candidateValues = Set(
  { ...installedRelease, buildDate: 20 },
  { ...installedRelease, buildDate: 20, securityPatch: 6, rollbackIndex: 2 },
  { ...installedRelease, buildDate: 30, securityPatch: 7, rollbackIndex: 2 },
  { ...installedRelease, buildDate: 20, device: "other" },
  { ...installedRelease, buildDate: 20, certificate: "debug" },
  { ...installedRelease, buildDate: 20, problemsRecorded: true },
  { ...installedRelease, buildDate: 5 },
  { ...installedRelease, buildDate: 20, securityPatch: 4 },
  { ...installedRelease, buildDate: 20, rollbackIndex: 0 })
pure val rValues = candidateValues
pure def lawQualifyingRecordCarriesTheChannelKeys(r: ReleaseRecord): bool =
  recordQualifies(r, enrolledChannel) implies
    not(r.problemsRecorded) and r.device == enrolledChannel.channelDevice and r.certificate == enrolledChannel.channelCertificate and
    r.bootKey == enrolledChannel.channelBootKey
```

### A channel never accepts a downgrade

The channel must refuse downgrades. A candidate's build date is strictly
newer than the installed one's, its security patch level is no lower, and
its verified-boot rollback index is no lower, since the device would
refuse to boot a lower one.

```quint
pure def forward(prior: ReleaseRecord, proposed: ReleaseRecord): bool =
  proposed.buildDate > prior.buildDate and proposed.securityPatch >= prior.securityPatch and proposed.rollbackIndex >= prior.rollbackIndex
pure def updateAllowed(c: UpdateChannel, prior: ReleaseRecord, proposed: ReleaseRecord): bool =
  not(c.downgradeAllowed) and recordQualifies(prior, c) and recordQualifies(proposed, c) and forward(prior, proposed)
pure def lawNoUpdateLowersTheRelease(prior: ReleaseRecord, proposed: ReleaseRecord): bool =
  updateAllowed(enrolledChannel, prior, proposed) implies
    proposed.buildDate > prior.buildDate and proposed.securityPatch >= prior.securityPatch and proposed.rollbackIndex >= prior.rollbackIndex
pure val priorValues = Set(installedRelease, { ...installedRelease, buildDate: 20, securityPatch: 6, rollbackIndex: 2 })
pure val proposedValues = candidateValues
```

### The journal plans one update and records each step once

The journal is planned once, for one admitted candidate. A transfer is
journaled before the device boots; a boot of the candidate moves to
verification, while the installed build still running on its original
slot means the update did not take effect and the transfer may be
retried. A build that is neither, or the installed build on the other
slot, refuses the journal. A finished journal is never reopened.

```quint
type JournalPhase = JournalIdle | JournalPlanned | JournalTransferred | JournalRetry | JournalBooted | JournalVerified | JournalVerifyFailed | JournalRefused
type BootObservation = BootedCandidate | BootedInstalledSameSlot | BootedInstalledOtherSlot | BootedForeign | NotBooted
type OperatorJournal = { phase: JournalPhase, installed: ReleaseRecord, candidate: ReleaseRecord, transfers: int }
pure val initial: OperatorJournal = { phase: JournalIdle, installed: installedRelease, candidate: installedRelease, transfers: 0 }
pure def canPlanUpdate(j: OperatorJournal, candidate: ReleaseRecord): bool =
  j.phase == JournalIdle and updateAllowed(enrolledChannel, j.installed, candidate)
pure def planUpdate(j: OperatorJournal, candidate: ReleaseRecord): OperatorJournal = { ...j, phase: JournalPlanned, candidate: candidate }
pure def canTransfer(j: OperatorJournal): bool = j.phase == JournalPlanned or j.phase == JournalRetry
pure def transfer(j: OperatorJournal): OperatorJournal = { ...j, phase: JournalTransferred, transfers: j.transfers + 1 }
pure def canObserveBoot(j: OperatorJournal, observed: BootObservation): bool = j.phase == JournalTransferred and observed != NotBooted
pure def observeBoot(j: OperatorJournal, observed: BootObservation): OperatorJournal =
  { ...j, phase: if (observed == BootedCandidate) JournalBooted else if (observed == BootedInstalledSameSlot) JournalRetry else JournalRefused }
pure def finished(p: JournalPhase): bool = p == JournalVerified or p == JournalVerifyFailed or p == JournalRefused
pure def alwaysPlannedCandidateMovesForward(j: OperatorJournal): bool =
  j.phase != JournalIdle and j.phase != JournalVerified implies updateAllowed(enrolledChannel, j.installed, j.candidate)
pure def alwaysTransferPrecedesBoot(j: OperatorJournal): bool =
  (j.phase == JournalTransferred or j.phase == JournalRetry or j.phase == JournalBooted or j.phase == JournalVerified or j.phase == JournalVerifyFailed) implies j.transfers > 0
pure def stepFinishedJournalIsFinal(before: OperatorJournal, after: OperatorJournal): bool = finished(before.phase) implies after == before
pure def sometimesTransferRetried(j: OperatorJournal): bool = j.phase == JournalTransferred and j.transfers == 2
pure def sometimesForeignBuildRefused(j: OperatorJournal): bool = j.phase == JournalRefused
```

### A booted candidate is verified only when the slot switched, SELinux enforces, the bootloader stays locked and verified boot is not weaker

Verification reads the booted device: the candidate's build on the other
slot, SELinux enforcing, a bootloader that was locked still locked,
verified boot no weaker than the installed state, and the candidate's
security patch level. Only then does the candidate become the installed
release; any failure leaves the installed record as it was.

```quint
type BootCheck = { slotSwitched: bool, selinuxEnforcing: bool, lockRetained: bool, verifiedBootNotWeaker: bool, patchMatches: bool }
pure def bootVerified(b: BootCheck): bool = b.slotSwitched and b.selinuxEnforcing and b.lockRetained and b.verifiedBootNotWeaker and b.patchMatches
pure def canVerifyBoot(j: OperatorJournal, check: BootCheck): bool = j.phase == JournalBooted
pure def verifyBoot(j: OperatorJournal, check: BootCheck): OperatorJournal =
  if (bootVerified(check)) { ...j, phase: JournalVerified, installed: j.candidate } else { ...j, phase: JournalVerifyFailed }
pure val passingCheck: BootCheck = { slotSwitched: true, selinuxEnforcing: true, lockRetained: true, verifiedBootNotWeaker: true, patchMatches: true }
pure val checkValues = Set(passingCheck, { ...passingCheck, slotSwitched: false }, { ...passingCheck, selinuxEnforcing: false },
  { ...passingCheck, lockRetained: false }, { ...passingCheck, verifiedBootNotWeaker: false })
pure def stepInstalledReleaseOnlyMovesForward(before: OperatorJournal, after: OperatorJournal): bool =
  before.installed == after.installed or (after.phase == JournalVerified and forward(before.installed, after.installed))
pure def lawVerificationNeedsEveryBootCheck(check: BootCheck): bool =
  bootVerified(check) implies check.slotSwitched and check.selinuxEnforcing and check.lockRetained and check.verifiedBootNotWeaker
pure def sometimesUpdateVerified(j: OperatorJournal): bool = j.phase == JournalVerified and j.installed.securityPatch == 7
pure def sometimesVerificationFailed(j: OperatorJournal): bool = j.phase == JournalVerifyFailed
```
