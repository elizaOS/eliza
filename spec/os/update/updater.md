# System updater

The system updater is the privileged app in the image that installs OS
updates through Android's A/B update engine, for one enrolled device and one
candidate at a time. This machine is its durable journal
(`packages/os/android/system-updater/src/ai/eliza/systemupdater/UpdateJournal.java`
on develop) and the decisions its single job makes around it
(`UpdateRunner.java`, `UpdateChannel.java`, `PackageVerifier.java`,
`EngineInstaller.java`). The shell writes each journal state atomically and
reads it back before it calls Android, so a process death never repeats an
apply or a restart. Whether the image includes the updater, and its
enrollment overlay (manifest URL, hosts, product, device, OTA certificate),
belong to `image/product.md`; boot checks of SELinux, the bootloader and
verified boot belong to `update/operator.md`, never to the device.

## Story: Install a verified update once

> As a device owner on an enrolled channel, I want my phone to install an OS
> update only after it verified it, exactly once, and only when the phone is
> idle, so that an interrupted or unexpected update never leaves it running
> something unverified or replays an install.

### A journal that is not idle binds two different builds and a digest, and an apply or restart phase binds a boot

Builds are fingerprints and a boot is the device's boot count; the shell
checks that a digest is 64 lowercase hex characters. A boot identity is
recorded when the apply intent is written and kept until the journal is
settled.

```quint
type JournalPhase = Idle | Downloading | Verified | ApplyIntent | Applying | RebootReady | RebootIntent | Complete | SourceRetained | Failed | Unknown
type RestartHold = NotHeld | HeldForConditions | HeldOfferUnavailable | HeldNoOffer | HeldOfferChanged | HeldForEngine
type SystemUpdate = { phase: JournalPhase, source: str, target: str, digest: str, intentBoot: str, applyCalls: int, restartHold: RestartHold }
pure val initial: SystemUpdate = { phase: Idle, source: "", target: "", digest: "", intentBoot: "", applyCalls: 0, restartHold: NotHeld }
pure def movedTo(p: JournalPhase, s: SystemUpdate): SystemUpdate = { ...s, phase: p, restartHold: NotHeld }
pure def bootBound(p: JournalPhase): bool = p == ApplyIntent or p == Applying or p == RebootReady or p == RebootIntent
pure def alwaysJournalBound(s: SystemUpdate): bool =
  if (s.phase == Idle) s.source == "" and s.target == "" and s.digest == "" and s.intentBoot == "" and s.applyCalls == 0
  else s.source != "" and s.target != "" and s.source != s.target and s.digest != ""
pure def alwaysIntentHasBoot(s: SystemUpdate): bool = bootBound(s.phase) implies s.intentBoot != ""
```

### A candidate is admitted only for the same product and device, with a newer build and no lower patch levels

Discovery reads a manifest the shell bounds and parses: at most 65,536
bytes, schema 1, fetched over HTTPS from an enrolled host on port 443 with no
user information and at most 3 redirects, naming a package of at most
12 GiB. It offers a candidate only for the enrolled product and device, with
a newer build date (`YYYYMMDD`) and a different fingerprint. The package's
signed metadata then admits it only if neither its security nor its vendor
patch level (`YYYYMMDD`) is lower than the installed one; a wipe, a
downgrade or a non-A/B package is refused by the shell. The operator applies
the same admission over a cable.

```quint
type Release = { fingerprint: str, product: str, device: str, buildDate: int, securityPatch: int, vendorPatch: int }
type ManifestFacts = { manifestBytes: int, https: bool, enrolledHost: bool, userInfo: bool, redirects: int, packageBytes: int }
pure val maxManifestBytes = 65536
pure val maxRedirects = 3
pure val maxPackageBytes = 12884901888
pure def manifestAdmitted(m: ManifestFacts): bool = m.manifestBytes > 0 and m.manifestBytes <= maxManifestBytes and m.https and m.enrolledHost and not(m.userInfo) and m.redirects >= 0 and m.redirects <= maxRedirects and m.packageBytes > 0 and m.packageBytes <= maxPackageBytes
pure def offered(installed: Release, candidate: Release): bool = candidate.fingerprint != "" and candidate.fingerprint != installed.fingerprint and candidate.product == installed.product and candidate.device == installed.device and candidate.buildDate > installed.buildDate
pure def candidateAdmitted(installed: Release, candidate: Release): bool = offered(installed, candidate) and candidate.securityPatch >= installed.securityPatch and candidate.vendorPatch >= installed.vendorPatch
```

### A download needs the download conditions and an install or restart also needs an idle phone

Downloading needs the system user, unlocked and not a managed profile,
charging or at least 50 % battery, a validated unmetered network and no
device update policy. Installing and restarting also need the screen off,
the phone-state permission and no call.

```quint
type DeviceConditions = { systemUser: bool, unlocked: bool, managedProfile: bool, charging: bool, batteryPercent: int, unmeteredNetwork: bool, updatePolicySet: bool, screenOn: bool, phoneStateGranted: bool, inCall: bool }
pure def downloadAllowed(c: DeviceConditions): bool = c.systemUser and c.unlocked and not(c.managedProfile) and (c.charging or c.batteryPercent >= 50) and c.unmeteredNetwork and not(c.updatePolicySet)
pure def installAllowed(c: DeviceConditions): bool = downloadAllowed(c) and not(c.screenOn) and c.phoneStateGranted and not(c.inCall)
pure val idlePhone: DeviceConditions = { systemUser: true, unlocked: true, managedProfile: false, charging: false, batteryPercent: 50, unmeteredNetwork: true, updatePolicySet: false, screenOn: false, phoneStateGranted: true, inCall: false }
pure val conditionsValues = Set(idlePhone, { ...idlePhone, screenOn: true }, { ...idlePhone, batteryPercent: 20 })
```

### A download starts only from a settled journal and never replays the previous target

A new candidate is journaled only from `Idle`, `Complete` or
`SourceRetained`; the previous target is never downloaded again, and the
apply count starts afresh for the new candidate.

```quint
pure val installedRelease: Release = { fingerprint: "b1", product: "product", device: "device", buildDate: 20260101, securityPatch: 20260101, vendorPatch: 20260101 }
pure val installedValues = Set(installedRelease)
pure val candidateValues = Set({ ...installedRelease, fingerprint: "b2", buildDate: 20260201, securityPatch: 20260201 }, { ...installedRelease, fingerprint: "b3", buildDate: 20260301, vendorPatch: 20251201 }, { ...installedRelease, fingerprint: "b4", device: "other", buildDate: 20260301 })
pure val digestValues = Set("d1", "d2")
pure val goodManifest: ManifestFacts = { manifestBytes: 2048, https: true, enrolledHost: true, userInfo: false, redirects: 1, packageBytes: 1000000 }
pure val manifestValues = Set(goodManifest, { ...goodManifest, enrolledHost: false }, { ...goodManifest, redirects: 4 })
pure def canDownload(s: SystemUpdate, installed: Release, candidate: Release, digest: str, manifest: ManifestFacts, conditions: DeviceConditions): bool =
  (s.phase == Idle or s.phase == Complete or s.phase == SourceRetained) and candidate.fingerprint != s.target and installed.fingerprint != "" and digest != "" and offered(installed, candidate) and manifestAdmitted(manifest) and downloadAllowed(conditions)
pure def download(s: SystemUpdate, installed: Release, candidate: Release, digest: str, manifest: ManifestFacts, conditions: DeviceConditions): SystemUpdate =
  { phase: Downloading, source: installed.fingerprint, target: candidate.fingerprint, digest: digest, intentBoot: "", applyCalls: 0, restartHold: NotHeld }
pure def stepNeverReplaysPreviousTarget(before: SystemUpdate, via: str, after: SystemUpdate): bool = via == "download" implies (after.target != before.target and after.target != after.source)
```

### A download publishes only bytes that hash to the candidate, and resets a wrong file

The partial file is named by the candidate's digest (`<sha256>.partial`) and
locked; a peer holding the lock leaves it alone. Retained bytes are hashed
before they are resumed with one ranged request; a server that ignores the
range restarts the file. A pause (cancellation, or the 8-minute window)
keeps what was written. An oversized file, or a complete one whose digest
differs, is reset and fails. The verified file becomes `<sha256>.zip` only by
the atomic rename of [atomic publication](../../core/atomicPublication.md),
whose receipt the attempt returns.

```quint
import atomicPublication as P from "../../core/atomicPublication"
type PartialFile = NoBytes | GoodPrefix | WrongPrefix | GoodComplete | WrongComplete | Oversized
type FetchOutcome = RangeHonoured | RangeIgnored | FetchPaused | FetchRefused
type DownloadAttempt = { kept: PartialFile, receipt: P::PublicationReceipt, ranged: bool }
pure def downloadAttempt(partial: PartialFile, peerLocked: bool, fetch: FetchOutcome): DownloadAttempt =
  if (peerLocked) { kept: partial, receipt: P::PendingReceipt, ranged: false }
  else if (partial == Oversized or partial == WrongComplete) { kept: NoBytes, receipt: P::FailureReceipt, ranged: false }
  else if (partial == GoodComplete) { kept: NoBytes, receipt: P::SuccessReceipt, ranged: false }
  else if (fetch == FetchPaused) { kept: if (partial == NoBytes) GoodPrefix else partial, receipt: P::PendingReceipt, ranged: partial != NoBytes }
  else if (fetch == FetchRefused) { kept: partial, receipt: P::FailureReceipt, ranged: partial != NoBytes }
  else if (fetch == RangeHonoured and partial == WrongPrefix) { kept: NoBytes, receipt: P::FailureReceipt, ranged: true }
  else { kept: NoBytes, receipt: P::SuccessReceipt, ranged: fetch == RangeHonoured and partial != NoBytes }
pure def lawPublishesOnlyMatchingBytes(partial: PartialFile, peerLocked: bool, fetch: FetchOutcome): bool = {
  val a = downloadAttempt(partial, peerLocked, fetch)
  a.receipt == P::SuccessReceipt implies (not(peerLocked) and a.kept == NoBytes and partial != Oversized and partial != WrongComplete and (partial == WrongPrefix implies fetch == RangeIgnored))
}
pure def lawWrongFileIsReset(partial: PartialFile, peerLocked: bool, fetch: FetchOutcome): bool = {
  val a = downloadAttempt(partial, peerLocked, fetch)
  (not(peerLocked) and (partial == Oversized or partial == WrongComplete)) implies (a.kept == NoBytes and a.receipt == P::FailureReceipt and not(a.ranged))
}
pure def lawLockedOrPausedKeepsBytes(partial: PartialFile, peerLocked: bool, fetch: FetchOutcome): bool = {
  val a = downloadAttempt(partial, peerLocked, fetch)
  a.receipt == P::PendingReceipt implies (a.kept == partial or (partial == NoBytes and a.kept == GoodPrefix))
}
pure def lawResumeOnlyFromRetainedBytes(partial: PartialFile, peerLocked: bool, fetch: FetchOutcome): bool = downloadAttempt(partial, peerLocked, fetch).ranged implies (partial == GoodPrefix or partial == WrongPrefix)
```

### A candidate is verified only for the installed build, candidate and digest its download recorded

Verification checks the whole package digest and length, the platform
signature against the enrolled OTA certificate and the signed metadata;
those checks are the shell's, and their verdict reaches the journal as
`verify` or `reject`. A package refused before any apply fails without a
boot identity.

```quint
pure def canVerify(s: SystemUpdate, installed: Release, candidate: Release, digest: str): bool =
  s.phase == Downloading and installed.fingerprint == s.source and candidate.fingerprint == s.target and digest == s.digest and candidateAdmitted(installed, candidate)
pure def verify(s: SystemUpdate, installed: Release, candidate: Release, digest: str): SystemUpdate = movedTo(Verified, s)
pure def canReject(s: SystemUpdate): bool = s.phase == Downloading or s.phase == Verified
pure def reject(s: SystemUpdate): SystemUpdate = movedTo(Failed, s)
pure def sometimesRejectedBeforeApply(s: SystemUpdate): bool = s.phase == Failed and s.applyCalls == 0
```

### An apply intent is persisted before the one apply call, and only for a verified candidate the offer still matches

The intent needs an idle engine, a boot identity, an idle phone and an offer
that still names the candidate. If the phone or the boot changes before the
engine is called, the intent is withdrawn back to `Verified`. The engine is
called once, after the intent is durable; `applyAccepted` records that call.

```quint
type Offer = NoOffer | OfferUnavailable | Offered({ fingerprint: str, digest: str })
type EngineStatus = EngineIdle | EngineBusy | EngineNeedsReboot | EngineUnavailable
pure val bootValues = Set("", "boot1", "boot2")
pure val engineValues = Set(EngineIdle, EngineBusy, EngineNeedsReboot)
pure val offerValues = Set(NoOffer, OfferUnavailable, Offered({ fingerprint: "b2", digest: "d1" }), Offered({ fingerprint: "b2", digest: "d2" }))
pure def offerMatches(offer: Offer, s: SystemUpdate): bool = match offer { | Offered(o) => o.fingerprint == s.target and o.digest == s.digest | _ => false }
pure def canApplyIntent(s: SystemUpdate, boot: str, engine: EngineStatus, conditions: DeviceConditions, offer: Offer): bool =
  s.phase == Verified and boot != "" and engine == EngineIdle and installAllowed(conditions) and offerMatches(offer, s)
pure def applyIntent(s: SystemUpdate, boot: str, engine: EngineStatus, conditions: DeviceConditions, offer: Offer): SystemUpdate = { ...movedTo(ApplyIntent, s), intentBoot: boot }
pure def canWithdrawApplyIntent(s: SystemUpdate, boot: str, conditions: DeviceConditions): bool = s.phase == ApplyIntent and (boot != s.intentBoot or not(installAllowed(conditions)))
pure def withdrawApplyIntent(s: SystemUpdate, boot: str, conditions: DeviceConditions): SystemUpdate = { ...movedTo(Verified, s), intentBoot: "" }
pure def canApplyAccepted(s: SystemUpdate, boot: str): bool = s.phase == ApplyIntent and boot == s.intentBoot and s.applyCalls == 0
pure def applyAccepted(s: SystemUpdate, boot: str): SystemUpdate = { ...movedTo(Applying, s), applyCalls: 1 }
pure def alwaysAppliedAtMostOnce(s: SystemUpdate): bool =
  (s.applyCalls == 0 or s.applyCalls == 1) and
  ((s.phase == Downloading or s.phase == Verified) implies (s.applyCalls == 0 and s.intentBoot == "")) and
  (s.phase == ApplyIntent implies s.applyCalls == 0) and
  ((s.phase == Applying or s.phase == RebootReady or s.phase == RebootIntent) implies s.applyCalls == 1) and
  (s.phase == Failed implies (s.applyCalls == 1 iff s.intentBoot != ""))
pure def stepApplyCalledOnlyFromItsIntent(before: SystemUpdate, via: str, after: SystemUpdate): bool =
  (after.phase == ApplyIntent and before.phase != ApplyIntent) implies before.phase == Verified
```

### Only the attempt's own result ends an apply, and a stopped job never cancels it

The engine owns an accepted apply: a job stop leaves it running. The
attempt's callback in the boot that called it decides `RebootReady` (error
code 0) or `Failed`; a callback seen in another boot makes the outcome
`Unknown`. Detaching after 30 minutes, or any failure after the call, is a
`reconcile` with the source build, which also makes it `Unknown`.

```quint
pure val errorCodeValues = Set(0, 1)
pure def canCompletedApply(s: SystemUpdate, boot: str, errorCode: int): bool = s.phase == Applying
pure def completedApply(s: SystemUpdate, boot: str, errorCode: int): SystemUpdate = movedTo(if (boot != s.intentBoot) Unknown else if (errorCode == 0) RebootReady else Failed, s)
pure def stepApplyEndsOnlyByResultOrReconcile(before: SystemUpdate, via: str, after: SystemUpdate): bool =
  ((before.phase == ApplyIntent or before.phase == Applying) and after.phase != before.phase) implies (via == "completedApply" or via == "reconcile" or (before.phase == ApplyIntent and (via == "applyAccepted" or via == "withdrawApplyIntent")))
pure def sometimesApplyFailed(s: SystemUpdate): bool = s.phase == Failed and s.applyCalls == 1
```

### A restart is requested only while the phone, the offer and the engine all allow it

The job checks, in this order, an idle phone, that the offer can be read,
that it is still offered, that it is the same candidate, and that the engine
reports `UPDATED_NEED_REBOOT`; the first that fails holds the restart and
keeps the applied candidate. The restart intent is written before the
reboot call and withdrawn if the phone stops being idle before it.

```quint
pure def restartBlocker(conditions: DeviceConditions, offer: Offer, engine: EngineStatus, s: SystemUpdate): RestartHold =
  if (not(installAllowed(conditions))) HeldForConditions
  else if (offer == OfferUnavailable) HeldOfferUnavailable
  else if (offer == NoOffer) HeldNoOffer
  else if (not(offerMatches(offer, s))) HeldOfferChanged
  else if (engine != EngineNeedsReboot) HeldForEngine
  else NotHeld
pure def canHoldRestart(s: SystemUpdate, conditions: DeviceConditions, offer: Offer, engine: EngineStatus): bool = s.phase == RebootReady and restartBlocker(conditions, offer, engine, s) != NotHeld
pure def holdRestart(s: SystemUpdate, conditions: DeviceConditions, offer: Offer, engine: EngineStatus): SystemUpdate = { ...s, restartHold: restartBlocker(conditions, offer, engine, s) }
pure def canRebootIntent(s: SystemUpdate, conditions: DeviceConditions, offer: Offer, engine: EngineStatus): bool = s.phase == RebootReady and restartBlocker(conditions, offer, engine, s) == NotHeld
pure def rebootIntent(s: SystemUpdate, conditions: DeviceConditions, offer: Offer, engine: EngineStatus): SystemUpdate = movedTo(RebootIntent, s)
pure def canWithdrawRebootIntent(s: SystemUpdate, conditions: DeviceConditions): bool = s.phase == RebootIntent and not(installAllowed(conditions))
pure def withdrawRebootIntent(s: SystemUpdate, conditions: DeviceConditions): SystemUpdate = movedTo(RebootReady, s)
pure def alwaysHoldKeepsAppliedCandidate(s: SystemUpdate): bool = s.restartHold != NotHeld implies s.phase == RebootReady
pure def sometimesRestartHeldForChangedOffer(s: SystemUpdate): bool = s.restartHold == HeldOfferChanged
pure def sometimesRestartRequested(s: SystemUpdate): bool = s.phase == RebootIntent
```

### After a restart the journal follows the booted build, and an unknown outcome is never replayed

At every job start the journal is reconciled with the installed fingerprint
and the boot: the target installed is `Complete`; a build that is neither
source nor target, an unreadable build or boot, or `Complete` with the
source installed is `Unknown`; an apply intent or an apply seen again is
`Unknown`; a restart intent seen in another boot with the source installed is
`SourceRetained`, which is not evidence of a rollback. `Unknown` and a failed
apply wait for review: only booting the target settles them.

```quint
pure val bootedValues = Set("", "b1", "b2", "b3")
pure def reconciledPhase(s: SystemUpdate, booted: str, boot: str): JournalPhase =
  if (s.phase == Idle) Idle
  else if (booted == "" or boot == "") Unknown
  else if (booted == s.target) Complete
  else if (booted != s.source or s.phase == Complete) Unknown
  else if (s.phase == ApplyIntent or s.phase == Applying) Unknown
  else if (s.phase == RebootIntent and s.intentBoot != boot) SourceRetained
  else s.phase
pure def canReconcile(s: SystemUpdate, booted: str, boot: str): bool = s.phase != Idle
pure def reconcile(s: SystemUpdate, booted: str, boot: str): SystemUpdate = movedTo(reconciledPhase(s, booted, boot), s)
pure def stepUnknownIsNeverReplayed(before: SystemUpdate, via: str, after: SystemUpdate): bool =
  before.phase == Unknown implies ((after.phase == Unknown or after.phase == Complete) and after.applyCalls == before.applyCalls)
pure def sometimesUpdateComplete(s: SystemUpdate): bool = s.phase == Complete and s.applyCalls == 1
pure def sometimesSourceRetained(s: SystemUpdate): bool = s.phase == SourceRetained and s.applyCalls == 1
pure def sometimesOutcomeUnknown(s: SystemUpdate): bool = s.phase == Unknown and s.applyCalls == 1
```

### Only an unapplied candidate, or one refused before its apply, can be withdrawn

The shell withdraws a candidate the offer no longer names. It can do so
only while the candidate is downloading or verified, or after it failed
without an apply intent; the journal returns to `Idle`. An
applied or uncertain update is never discarded.

```quint
pure def canWithdraw(s: SystemUpdate): bool = s.phase == Downloading or s.phase == Verified or (s.phase == Failed and s.intentBoot == "")
pure def withdraw(s: SystemUpdate): SystemUpdate = initial
pure def stepAppliedUpdateIsNeverDiscarded(before: SystemUpdate, via: str, after: SystemUpdate): bool = (after.phase == Idle and before.phase != Idle) implies before.applyCalls == 0
pure val weight_download = 6
pure val weight_verify = 10
pure val weight_applyIntent = 20
pure val weight_applyAccepted = 10
pure val weight_completedApply = 8
pure val weight_holdRestart = 6
pure val weight_rebootIntent = 20
pure val weight_reconcile = 3
```
