# OS update channel

An operator moves an enrolled device from its installed release to a
candidate on one update channel, from the release records
[release signing](../image/signing.md) wrote. The operator's journal is
one update: the device is enrolled, the update is planned, the package is
transferred by sideload, and the booted device is classified and verified.
The [system updater](./updater.md) is the on-device path.

## Story: Publish an OS update to an enrolled channel

> As a consumer's operator, I want to move an enrolled device to a new
> release only from a signed record of the same product and device, so
> that a device never takes a foreign, unsigned or older build and an
> interrupted update is resumed rather than repeated.

### A release is applied only from a signed record of the channel's product, device and channel

The channel names its product, device and channel, the update package
certificate and the verified-boot public key, and it refuses downgrades.
A record qualifies when it lists no problems, names the channel's product,
device and channel, was signed with the channel's certificate and
verified-boot key, and records a build date and a security patch level.
A device is enrolled on a channel only with an installed record that
qualifies, and every candidate must qualify too.

```quint
import signing.* from "../image/signing"
import product.* from "../image/product"
type ReleaseRecord = { product: str, device: str, channel: str, problemsRecorded: bool, signing: SigningRecord, buildDate: int, securityPatch: int, rollbackIndex: int }
type UpdateChannel = { channelProduct: str, channelDevice: str, channelName: str, channelCertificate: str, channelBootKey: str, downgradeAllowed: bool }
pure def recordQualifies(r: ReleaseRecord, c: UpdateChannel): bool =
  not(r.problemsRecorded) and r.product == c.channelProduct and r.device == c.channelDevice and r.channel == c.channelName and
  not(placeholder(c.channelCertificate)) and r.signing.releaseCertificate == c.channelCertificate and
  not(placeholder(c.channelBootKey)) and r.signing.verifiedBootKey == c.channelBootKey and
  r.buildDate > 0 and r.securityPatch > 0
pure val stableChannel: UpdateChannel = { channelProduct: "product", channelDevice: "device", channelName: "stable", channelCertificate: "cert", channelBootKey: "avb", downgradeAllowed: false }
pure val channelValues = Set(stableChannel, { ...stableChannel, downgradeAllowed: true }, { ...stableChannel, channelCertificate: "" })
pure val releaseSigning: SigningRecord = { ...signedRecord, releaseCertificate: "cert", verifiedBootKey: "avb" }
pure val installedRelease: ReleaseRecord = { product: "product", device: "device", channel: "stable", problemsRecorded: false, signing: releaseSigning, buildDate: 10, securityPatch: 5, rollbackIndex: 1 }
pure val installedValues = Set(installedRelease, { ...installedRelease, device: "other" })
pure val candidateValues = Set(
  { ...installedRelease, buildDate: 20 },
  { ...installedRelease, buildDate: 20, securityPatch: 6, rollbackIndex: 2 },
  { ...installedRelease, buildDate: 30, securityPatch: 7, rollbackIndex: 2 },
  { ...installedRelease, buildDate: 20, device: "other" },
  { ...installedRelease, buildDate: 20, signing: { ...releaseSigning, releaseCertificate: "debug" } },
  { ...installedRelease, buildDate: 20, problemsRecorded: true },
  { ...installedRelease, buildDate: 5 },
  { ...installedRelease, buildDate: 20, securityPatch: 4 },
  { ...installedRelease, buildDate: 20, rollbackIndex: 0 })
```

### A channel never accepts a downgrade

A candidate's build date is strictly newer than the installed one's, its
security patch level is no lower, and its verified-boot rollback index is
no lower, since the device would refuse to boot a lower one.

```quint
pure def forward(prior: ReleaseRecord, proposed: ReleaseRecord): bool =
  proposed.buildDate > prior.buildDate and proposed.securityPatch >= prior.securityPatch and proposed.rollbackIndex >= prior.rollbackIndex
pure def updateAllowed(c: UpdateChannel, prior: ReleaseRecord, proposed: ReleaseRecord): bool =
  not(c.downgradeAllowed) and recordQualifies(prior, c) and recordQualifies(proposed, c) and forward(prior, proposed)
```

### The journal plans one update for its enrolled channel and records each step once

The journal starts unenrolled and is enrolled once, on a channel that
refuses downgrades, with a qualifying installed record. It is planned
once, for one admitted candidate. A transfer is journaled before the
device boots; a boot of the candidate moves to verification, while the
installed build still running on its original slot means the update did
not take effect and the transfer may be retried. A build that is neither,
or the installed build on the other slot, refuses the journal. A finished
journal is never reopened.

```quint
type JournalPhase = JournalUnenrolled | JournalIdle | JournalPlanned | JournalTransferred | JournalRetry | JournalBooted | JournalVerified | JournalVerifyFailed | JournalRefused
type BootObservation = BootedCandidate | BootedInstalledSameSlot | BootedInstalledOtherSlot | BootedForeign | NotBooted
type OperatorJournal = { phase: JournalPhase, channel: UpdateChannel, installed: ReleaseRecord, candidate: ReleaseRecord, transfers: int }
pure val noSigning: SigningRecord = { targetFiles: "", signedTargetFiles: "", updatePackage: "", releaseCertificate: "", verifiedBootKey: "" }
pure val noRelease: ReleaseRecord = { product: "", device: "", channel: "", problemsRecorded: true, signing: noSigning, buildDate: 0, securityPatch: 0, rollbackIndex: 0 }
pure val noChannel: UpdateChannel = { channelProduct: "", channelDevice: "", channelName: "", channelCertificate: "", channelBootKey: "", downgradeAllowed: false }
pure val initial: OperatorJournal = { phase: JournalUnenrolled, channel: noChannel, installed: noRelease, candidate: noRelease, transfers: 0 }
pure def enrollmentQualifies(channel: UpdateChannel, installed: ReleaseRecord): bool =
  not(channel.downgradeAllowed) and recordQualifies(installed, channel)
pure def canEnroll(j: OperatorJournal, channel: UpdateChannel, installed: ReleaseRecord): bool =
  j.phase == JournalUnenrolled and enrollmentQualifies(channel, installed)
pure def enroll(j: OperatorJournal, channel: UpdateChannel, installed: ReleaseRecord): OperatorJournal =
  { ...j, phase: JournalIdle, channel: channel, installed: installed, candidate: installed }
pure def canPlanUpdate(j: OperatorJournal, candidate: ReleaseRecord): bool =
  j.phase == JournalIdle and updateAllowed(j.channel, j.installed, candidate)
pure def planUpdate(j: OperatorJournal, candidate: ReleaseRecord): OperatorJournal = { ...j, phase: JournalPlanned, candidate: candidate }
pure def canTransfer(j: OperatorJournal): bool = j.phase == JournalPlanned or j.phase == JournalRetry
pure def transfer(j: OperatorJournal): OperatorJournal = { ...j, phase: JournalTransferred, transfers: j.transfers + 1 }
pure def canObserveBoot(j: OperatorJournal, observed: BootObservation): bool = j.phase == JournalTransferred and observed != NotBooted
pure def observeBoot(j: OperatorJournal, observed: BootObservation): OperatorJournal =
  { ...j, phase: if (observed == BootedCandidate) JournalBooted else if (observed == BootedInstalledSameSlot) JournalRetry else JournalRefused }
pure def finished(p: JournalPhase): bool = p == JournalVerified or p == JournalVerifyFailed or p == JournalRefused
pure def alwaysEnrolledInstallQualifies(j: OperatorJournal): bool =
  j.phase != JournalUnenrolled implies enrollmentQualifies(j.channel, j.installed)
pure def alwaysPlannedCandidateMovesForward(j: OperatorJournal): bool =
  (j.phase != JournalUnenrolled and j.phase != JournalIdle and j.phase != JournalVerified) implies updateAllowed(j.channel, j.installed, j.candidate)
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
release; any failure leaves the installed record as it was. Enrollment
records the first installed release, and after it the installed release
only moves forward.

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
  before.phase == JournalUnenrolled or before.installed == after.installed or
    (after.phase == JournalVerified and forward(before.installed, after.installed))
pure def sometimesUpdateVerified(j: OperatorJournal): bool = j.phase == JournalVerified and j.installed.securityPatch == 7
pure def sometimesVerificationFailed(j: OperatorJournal): bool = j.phase == JournalVerifyFailed
```
