# APK admission

An APK reaches an image, a provisioned unit or an installed app only as a
reviewed build (`src/image/apk.vibe`, exported from `@elizaos/os`).
The sources are develop's `image-apk-admission.mjs`, `apk-release-record.mjs`
and `artifact-inspection/apk-distribution.mjs`.

The shell reads the facts (`aapt dump xmltree`, `apksigner verify
--print-certs`, the web bundle's `assets/public/build-flags.json`, the
consumer's `apk-manifest.json` row found by the APK's digest, and `adb`
readbacks). It parses a SHA-256 written as 64 lowercase hex characters
into `Sha256`; anything else, an empty value, `UNSET` or a malformed
digest, is `NotADigest`. The consumer's signer,
licence policy and speech QA provider are data it passes in. Admission is
staging evidence only, never a boot, a device acceptance or a distribution.

## Story: Put only a reviewed release APK into an image

> As a consumer, I want only my reviewed release APK staged into my image,
> so that a debug build, a test-mocks build or an unexpected signer never
> reaches a device.

### A placeholder digest matches nothing, not even another placeholder

```quint
type Digest = Sha256({ hex: str }) | NotADigest
pure def isDigest(digest: Digest): bool = match digest { | Sha256(d) => true | _ => false }
pure def hexOf(digest: Digest): str = match digest { | Sha256(d) => d.hex | _ => "" }
pure def digestsMatch(digest: Digest, otherDigest: Digest): bool = isDigest(digest) and isDigest(otherDigest) and hexOf(digest) == hexOf(otherDigest)
pure val digestValues = Set(Sha256({ hex: "a1" }), Sha256({ hex: "c1" }), NotADigest)
pure val otherDigestValues = digestValues
pure def lawPlaceholderMatchesNothing(digest: Digest): bool = not(digestsMatch(NotADigest, digest)) and not(digestsMatch(digest, NotADigest))
pure def lawMatchingDigestsAreEqual(digest: Digest, otherDigest: Digest): bool = digestsMatch(digest, otherDigest) implies digest == otherDigest
```

### A signer observation names exactly one certificate for the requested API

An explicit API level must be a positive integer in the supported
representation. An invalid explicit level refuses before opening the APK.
Callers that already have apksigner output use the same signer-observation
rule to select a digest.

The report has legacy rows (`Signer #n`) or rotated rows with an inclusive
API range, never both. A legacy report needs exactly one row numbered 1. A
rotated report needs an API of at least 1 and exactly one range holding it.

```quint
type LegacySignerRow = { number: int, certificate: Digest }
type RangedSignerRow = { minApi: int, maxApi: int, certificate: Digest }
type SignerReport = { legacy: List[LegacySignerRow], ranged: List[RangedSignerRow] }
type SignerObservation = OneSigner({ certificate: Digest }) | NoSigner | SignerRefused
pure def rangeHolds(signerRange: RangedSignerRow, api: int): bool = signerRange.minApi <= api and api <= signerRange.maxApi
pure def signerForApi(report: SignerReport, api: int): SignerObservation = {
  val applicable = report.ranged.select(r => rangeHolds(r, api))
  val first = report.legacy.nthOr(0, { number: 0, certificate: NotADigest })
  if (report.legacy.length() > 0 and report.ranged.length() > 0) SignerRefused
  else if (report.legacy.length() == 1 and first.number == 1) OneSigner({ certificate: first.certificate })
  else if (report.legacy.length() > 0) SignerRefused
  else if (report.ranged.length() == 0) NoSigner
  else if (api < 1 or applicable.length() != 1) SignerRefused
  else OneSigner({ certificate: applicable.nthOr(0, { minApi: 0, maxApi: 0, certificate: NotADigest }).certificate })
}
pure def signerCertificate(signer: SignerObservation): Digest = match signer { | OneSigner(s) => s.certificate | _ => NotADigest }
pure def signedBy(signer: SignerObservation, reviewedSigner: Digest): bool = digestsMatch(signerCertificate(signer), reviewedSigner)
pure val reportValues = {
  val one = { number: 1, certificate: Sha256({ hex: "c1" }) }
  val low = { minApi: 1, maxApi: 32, certificate: Sha256({ hex: "c1" }) }
  val high = { minApi: 33, maxApi: 40, certificate: Sha256({ hex: "c2" }) }
  List({ legacy: List(one), ranged: List() }, { legacy: List({ ...one, number: 2 }), ranged: List() }, { legacy: List(one, { ...one, number: 2 }), ranged: List() }, { legacy: List(), ranged: List() },
    { legacy: List(), ranged: List(low, high) }, { legacy: List(), ranged: List({ ...low, maxApi: 40 }, high) }, { legacy: List(one), ranged: List(low) }).foldl(Set(), (acc, r) => acc.union(Set(r)))
}
pure val apiValues = Set(0, 30, 34, 50)
pure def lawMixedSignerReportsAreRefused(report: SignerReport, api: int): bool =
  (report.legacy.length() > 0 and report.ranged.length() > 0) implies signerForApi(report, api) == SignerRefused
pure def lawRotatedSignerNeedsAnApi(report: SignerReport, api: int): bool =
  (report.legacy.length() == 0 and api < 1) implies not(isDigest(signerCertificate(signerForApi(report, api))))
pure def lawObservedSignerWasReportedForTheApi(report: SignerReport, api: int): bool = {
  val certificate = signerCertificate(signerForApi(report, api))
  isDigest(certificate) implies (report.legacy.some(r => r.number == 1 and r.certificate == certificate) or report.ranged.some(r => rangeHolds(r, api) and r.certificate == certificate))
}
```

### A release APK is a non-debuggable build outside the test-mocks output, with mocks off, signed by exactly the reviewed signer

```quint
type ApkLocation = StagingInput | TestMocksOutput
type BundleFlags = MocksOff | MocksOn | FlagsMissing
type ApkBuildType = ReleaseBuild | DebuggableBuild | BuildTypeUnread
type ApkFacts = { sha256: Digest, location: ApkLocation, bundle: BundleFlags, buildType: ApkBuildType, signer: SignerObservation }
pure def mockFree(apk: ApkFacts): bool = apk.location == StagingInput and apk.bundle == MocksOff
pure def releaseApk(apk: ApkFacts, reviewedSigner: Digest): bool = mockFree(apk) and apk.buildType == ReleaseBuild and signedBy(apk.signer, reviewedSigner)
pure val apkValues = {
  val base = { sha256: Sha256({ hex: "a1" }), location: StagingInput, bundle: MocksOff, buildType: ReleaseBuild, signer: OneSigner({ certificate: Sha256({ hex: "c1" }) }) }
  List(base, { ...base, location: TestMocksOutput }, { ...base, bundle: MocksOn }, { ...base, bundle: FlagsMissing }, { ...base, buildType: DebuggableBuild }, { ...base, buildType: BuildTypeUnread },
    { ...base, signer: OneSigner({ certificate: Sha256({ hex: "c2" }) }) }, { ...base, signer: SignerRefused }, { ...base, sha256: NotADigest }).foldl(Set(), (acc, a) => acc.union(Set(a)))
}
pure val reviewedSignerValues = digestValues
pure def lawReleaseApkHasExactlyTheReviewedSigner(apk: ApkFacts, reviewedSigner: Digest): bool = releaseApk(apk, reviewedSigner) implies (isDigest(reviewedSigner) and apk.signer == OneSigner({ certificate: reviewedSigner }))
```

### A recorded release row is distributable only when it has no blockers

A row the consumer's verification did not record as distributable is
blocked even with nothing else named. The on-device profile needs its
voice packaged, matching its record and device-qualified; the cloud-speech
profile packages no on-device voice. The consumer's licence policy decides
which recorded licence items block; an unrecorded check always blocks.

```quint
type RowMode = Unrecorded | RecordedDebug | RecordedRelease
type RuntimeRecord = RuntimeUnpackaged | RuntimeWithoutNotices | RuntimeWithNotices
type SpeechProfile = OnDeviceSpeech | CloudSpeech | UnknownSpeech
type VoiceRecord = VoiceUnrecorded | VoiceNotPackaged({ assetsVerified: bool }) | VoicePackaged({ assetsVerified: bool, qualified: bool })
type ApkRow = { recorded: RowMode, sha256: Digest, testMocks: bool, bundleAudited: bool, signer: SignerObservation, runtime: RuntimeRecord,
  profile: SpeechProfile, voice: VoiceRecord, qa: QaReceipt, licenceRecorded: bool, licenceBlocking: bool, distributable: bool }
type ImageCertificate = NotForImage | ForImage({ platformCertificate: Digest })
type ReleasePolicy = { reviewedSigner: Digest, qaProvider: str, image: ImageCertificate }
type ReleaseBlocker = ImageCertificateUnreviewed | TestMocksBuild | BundleNotAudited | Unsigned | SignerNotReviewed | RuntimeNotPackaged | RuntimeNoticesMissing | ProfileUnknown
  | VoiceNotRecorded | OnDeviceVoiceMissing | VoiceAssetsUnverified | VoiceUnqualified | CloudPackagesVoice | QaReceiptNotPassed | LicenceUnrecorded | LicenceBlocks | NotRecordedDistributable
pure def blockIf(blocked: bool, blocker: ReleaseBlocker): Set[ReleaseBlocker] = if (blocked) Set(blocker) else Set()
pure def imageBlockers(image: ImageCertificate): Set[ReleaseBlocker] = match image { | ForImage(i) => blockIf(not(isDigest(i.platformCertificate)), ImageCertificateUnreviewed) | _ => Set() }
pure def signerBlockers(signer: SignerObservation, reviewedSigner: Digest): Set[ReleaseBlocker] = if (signer == NoSigner) Set(Unsigned) else blockIf(not(signedBy(signer, reviewedSigner)), SignerNotReviewed)
pure def onDeviceVoiceBlockers(voice: VoiceRecord): Set[ReleaseBlocker] = match voice {
  | VoicePackaged(v) => blockIf(not(v.assetsVerified), VoiceAssetsUnverified).union(blockIf(not(v.qualified), VoiceUnqualified))
  | VoiceNotPackaged(v) => Set(OnDeviceVoiceMissing)
  | _ => Set(VoiceNotRecorded)
}
pure def cloudVoiceBlockers(voice: VoiceRecord): Set[ReleaseBlocker] = match voice {
  | VoiceNotPackaged(v) => blockIf(not(v.assetsVerified), VoiceAssetsUnverified)
  | VoicePackaged(v) => Set(CloudPackagesVoice).union(blockIf(not(v.assetsVerified), VoiceAssetsUnverified))
  | _ => Set(CloudPackagesVoice, VoiceAssetsUnverified)
}
pure def profileBlockers(row: ApkRow, qaProvider: str): Set[ReleaseBlocker] =
  if (row.profile == OnDeviceSpeech) onDeviceVoiceBlockers(row.voice)
  else if (row.profile == CloudSpeech) cloudVoiceBlockers(row.voice).union(blockIf(not(qaPassedFor(row.qa, row.sha256, qaProvider)), QaReceiptNotPassed))
  else Set(ProfileUnknown)
pure def releaseBlockers(row: ApkRow, policy: ReleasePolicy): Set[ReleaseBlocker] = {
  val named = imageBlockers(policy.image).union(blockIf(row.testMocks, TestMocksBuild)).union(blockIf(not(row.bundleAudited), BundleNotAudited))
    .union(signerBlockers(row.signer, policy.reviewedSigner)).union(blockIf(row.runtime == RuntimeUnpackaged, RuntimeNotPackaged))
    .union(blockIf(row.runtime == RuntimeWithoutNotices, RuntimeNoticesMissing)).union(profileBlockers(row, policy.qaProvider))
    .union(blockIf(not(row.licenceRecorded), LicenceUnrecorded)).union(blockIf(row.licenceBlocking, LicenceBlocks))
  if (named.size() == 0 and not(row.distributable)) Set(NotRecordedDistributable) else named
}
pure def releaseClean(row: ApkRow, policy: ReleasePolicy): bool = releaseBlockers(row, policy).size() == 0
pure val rowValues = {
  val clean = { recorded: RecordedRelease, sha256: Sha256({ hex: "a1" }), testMocks: false, bundleAudited: true, signer: OneSigner({ certificate: Sha256({ hex: "c1" }) }),
    runtime: RuntimeWithNotices, profile: OnDeviceSpeech, voice: VoicePackaged({ assetsVerified: true, qualified: true }), qa: QaAbsent,
    licenceRecorded: true, licenceBlocking: false, distributable: true }
  val passed = { evidence: Sha256({ hex: "e1" }), apk: Sha256({ hex: "a1" }), provider: "speech1", outcome: QaPassed, passedChecks: cloudSpeechChecks }
  val cloud = { ...clean, profile: CloudSpeech, voice: VoiceNotPackaged({ assetsVerified: true }), qa: QaRecorded(passed) }
  List(clean, cloud, { ...cloud, qa: QaRecorded({ ...passed, apk: Sha256({ hex: "a2" }) }) }, { ...cloud, qa: QaRecorded({ ...passed, outcome: QaNotPassed }) },
    { ...cloud, qa: QaRecorded({ ...passed, passedChecks: List("consent", "session") }) }, { ...cloud, qa: QaRecorded({ ...passed, evidence: NotADigest }) },
    { ...cloud, qa: QaAbsent }, { ...cloud, voice: VoicePackaged({ assetsVerified: true, qualified: true }) }, { ...clean, testMocks: true },
    { ...clean, distributable: false }, { ...clean, voice: VoicePackaged({ assetsVerified: true, qualified: false }) }, { ...clean, signer: NoSigner },
    { ...clean, runtime: RuntimeUnpackaged }, { ...clean, licenceBlocking: true }, { ...clean, recorded: RecordedDebug }, { ...clean, recorded: Unrecorded }).foldl(Set(), (acc, r) => acc.union(Set(r)))
}
pure val policyValues = {
  val base = { reviewedSigner: Sha256({ hex: "c1" }), qaProvider: "speech1", image: NotForImage }
  List(base, { ...base, image: ForImage({ platformCertificate: Sha256({ hex: "p1" }) }) }, { ...base, image: ForImage({ platformCertificate: NotADigest }) },
    { ...base, reviewedSigner: NotADigest }, { ...base, qaProvider: "" }, { ...base, qaProvider: "speech2" }).foldl(Set(), (acc, p) => acc.union(Set(p)))
}
pure def lawCleanReleaseWasRecordedDistributable(row: ApkRow, policy: ReleasePolicy): bool = releaseClean(row, policy) implies row.distributable
pure def lawPlaceholderSignerNeverReleases(row: ApkRow, policy: ReleasePolicy): bool = not(isDigest(policy.reviewedSigner)) implies not(releaseClean(row, policy))
```

### A cloud-speech release needs a passed QA receipt for this exact APK, from the configured provider, covering every named check

The receipt is external and content-free; the shell keeps the one row the
receipt holds for this APK's digest, or none. The provider is the
consumer's; an empty provider is not configured.

```quint
type QaOutcome = QaPassed | QaNotPassed
type QaReceipt = QaAbsent | QaRecorded({ evidence: Digest, apk: Digest, provider: str, outcome: QaOutcome, passedChecks: List[str] })
pure val cloudSpeechChecks: List[str] = List("consent", "session", "acousticInput", "blueBar", "transcript", "audibleSpeakerReply", "mute", "unmute", "stopReleased")
pure def everyCheckPassed(passedChecks: List[str]): bool = cloudSpeechChecks.every(c => passedChecks.includes(c))
pure def qaPassedFor(qa: QaReceipt, apkDigest: Digest, provider: str): bool = match qa {
  | QaRecorded(r) => provider != "" and isDigest(r.evidence) and digestsMatch(r.apk, apkDigest) and r.provider == provider and r.outcome == QaPassed and everyCheckPassed(r.passedChecks)
  | _ => false
}
pure def lawCleanCloudSpeechReleaseIsQualifiedForThisApk(row: ApkRow, policy: ReleasePolicy): bool =
  (row.profile == CloudSpeech and releaseClean(row, policy)) implies (qaPassedFor(row.qa, row.sha256, policy.qaProvider) and row.voice == VoiceNotPackaged({ assetsVerified: true }))
```

### Production stages only a clean release APK and development stages only a debug build or a clean release

Each refusal names its reason, in this order. A row counts only when it
was recorded for this APK's digest. A recorded release row with blockers
refuses in development too, so a release is never staged by relabelling.

```quint
type StagingMode = StageProduction | StageDevelopment
type ImageRefusal = InTestMocksOutput | BundleFlagsUnread | BundleBuiltWithMocks | RowRecordsMocks | RowNotDistributable | NeedsReleaseRow | NotAReleaseApk | BuildTypeUnknown | NotADebugBuild
type ImageAdmission = ApkAdmitted | ApkRefused({ refusal: ImageRefusal })
pure def rowFor(row: ApkRow, apk: ApkFacts): bool = row.recorded != Unrecorded and digestsMatch(row.sha256, apk.sha256)
pure def imageApkAdmission(apk: ApkFacts, row: ApkRow, policy: ReleasePolicy, mode: StagingMode): ImageAdmission = {
  val releaseRow = rowFor(row, apk) and row.recorded == RecordedRelease
  if (apk.location == TestMocksOutput) ApkRefused({ refusal: InTestMocksOutput })
  else if (apk.bundle == FlagsMissing) ApkRefused({ refusal: BundleFlagsUnread })
  else if (apk.bundle == MocksOn) ApkRefused({ refusal: BundleBuiltWithMocks })
  else if (rowFor(row, apk) and row.testMocks) ApkRefused({ refusal: RowRecordsMocks })
  else if (releaseRow and not(releaseClean(row, policy))) ApkRefused({ refusal: RowNotDistributable })
  else if (mode == StageProduction and not(releaseRow)) ApkRefused({ refusal: NeedsReleaseRow })
  else if (mode == StageProduction and not(releaseApk(apk, policy.reviewedSigner))) ApkRefused({ refusal: NotAReleaseApk })
  else if (mode == StageDevelopment and not(releaseRow) and apk.buildType == BuildTypeUnread) ApkRefused({ refusal: BuildTypeUnknown })
  else if (mode == StageDevelopment and not(releaseRow) and apk.buildType == ReleaseBuild) ApkRefused({ refusal: NotADebugBuild })
  else ApkAdmitted
}
pure def lawProductionStagesOnlyACleanReleaseApk(apk: ApkFacts, row: ApkRow, policy: ReleasePolicy): bool = imageApkAdmission(apk, row, policy, StageProduction) == ApkAdmitted implies
  (releaseApk(apk, policy.reviewedSigner) and rowFor(row, apk) and row.recorded == RecordedRelease and releaseClean(row, policy))
pure def lawDevelopmentStagesOnlyDebugOrCleanRelease(apk: ApkFacts, row: ApkRow, policy: ReleasePolicy): bool = imageApkAdmission(apk, row, policy, StageDevelopment) == ApkAdmitted implies
  (apk.buildType == DebuggableBuild or (rowFor(row, apk) and row.recorded == RecordedRelease and releaseClean(row, policy)))
pure def lawMocksAreNeverStaged(apk: ApkFacts, row: ApkRow, policy: ReleasePolicy, mode: StagingMode): bool =
  (not(mockFree(apk)) or (rowFor(row, apk) and row.testMocks)) implies imageApkAdmission(apk, row, policy, mode) != ApkAdmitted
```

## Story: Update my installed app without losing its data

> As an operator, I want an in-place update refused unless it keeps the
> signer and raises the version, and its record to say whether my app's
> data was seen to survive, so that an update never silently loses my data.

The shell binds each readback to the package, Android user and update
window, with the app quiescent. The walk leaves out `cache/` and
`code_cache/`; the integrity export keys paths and bytes with one nonce for
both reads, so rows of different reads never compare equal.

### An in-place update keeps the installed signer and raises the version code

```quint
type PackageVersion = { versionCode: int, signer: Digest }
type UpdateProblem = VersionNotRaised | SignerChanged
pure def apkUpdateProblems(installed: PackageVersion, candidate: PackageVersion): Set[UpdateProblem] =
  (if (candidate.versionCode > installed.versionCode) Set() else Set(VersionNotRaised)).union(if (digestsMatch(installed.signer, candidate.signer)) Set() else Set(SignerChanged))
pure val installedValues = Set({ versionCode: 2, signer: Sha256({ hex: "c1" }) }, { versionCode: 2, signer: NotADigest })
pure val candidateValues = Set({ versionCode: 3, signer: Sha256({ hex: "c1" }) }, { versionCode: 2, signer: Sha256({ hex: "c1" }) }, { versionCode: 3, signer: Sha256({ hex: "c2" }) })
pure def lawAdmittedUpdateKeepsAKnownSigner(installed: PackageVersion, candidate: PackageVersion): bool = apkUpdateProblems(installed, candidate).size() == 0 implies (isDigest(installed.signer) and candidate.signer == installed.signer and candidate.versionCode > installed.versionCode)
```

### A missing readback stays distinct from a failed one, and only a missing walk falls back to the integrity export

A walk without its zero exit marker, a refused or failed export, and an
export whose end row does not count its rows are failures. A refused
`run-as` and an absent export provider are missing.

```quint
type FileDigest = { domain: str, file: str, digest: str }
type Inventory = InventoryUnavailable | InventoryFailed | InventoryRead({ files: List[FileDigest] })
pure def readbackOf(privateWalk: Inventory, integrityExport: Inventory): Inventory = if (privateWalk == InventoryUnavailable) integrityExport else privateWalk
pure val inventoryValues = {
  val settings = { domain: "shared_prefs", file: "shared_prefs/a.xml", digest: "d1" }
  val database = { domain: "databases", file: "databases/b.db", digest: "d2" }
  Set(InventoryUnavailable, InventoryFailed, InventoryRead({ files: List() }), InventoryRead({ files: List(settings, database) }),
    InventoryRead({ files: List(database, settings) }), InventoryRead({ files: List(settings) }), InventoryRead({ files: List(settings, { ...database, digest: "d3" }) }))
}
pure val privateWalkValues = inventoryValues
pure val integrityExportValues = inventoryValues
pure def lawMissingOnlyWhenBothReadsAreMissing(privateWalk: Inventory, integrityExport: Inventory): bool = readbackOf(privateWalk, integrityExport) == InventoryUnavailable implies (privateWalk == InventoryUnavailable and integrityExport == InventoryUnavailable)
pure def lawFailedWalkNeverFallsBack(integrityExport: Inventory): bool = readbackOf(InventoryFailed, integrityExport) == InventoryFailed
```

### Preserved data needs a non-empty before inventory and the same file digests after, in any order

```quint
type DataEvidence = DataUnobserved | DataNotPreserved | DataPreserved
pure def filesOf(inventory: Inventory): List[FileDigest] = match inventory { | InventoryRead(i) => i.files | _ => List() }
pure def wasRead(inventory: Inventory): bool = match inventory { | InventoryRead(i) => true | _ => false }
pure def sameFiles(beforeFiles: List[FileDigest], afterFiles: List[FileDigest]): bool = beforeFiles.every(f => afterFiles.includes(f)) and afterFiles.every(f => beforeFiles.includes(f))
pure def dataEvidence(beforeData: Inventory, afterData: Inventory): DataEvidence =
  if (beforeData == InventoryUnavailable) DataUnobserved
  else if (wasRead(beforeData) and wasRead(afterData) and filesOf(beforeData).length() > 0 and sameFiles(filesOf(beforeData), filesOf(afterData))) DataPreserved
  else DataNotPreserved
pure val beforeDataValues = inventoryValues
pure val afterDataValues = inventoryValues
pure def lawPreservedDataWasReadOnBothSides(beforeData: Inventory, afterData: Inventory): bool = dataEvidence(beforeData, afterData) == DataPreserved implies (filesOf(beforeData).length() > 0 and wasRead(afterData) and filesOf(afterData).every(f => filesOf(beforeData).includes(f)))
pure def lawLostOrChangedFileIsNotPreserved(beforeData: Inventory, afterData: Inventory): bool = (wasRead(beforeData) and not(sameFiles(filesOf(beforeData), filesOf(afterData)))) implies dataEvidence(beforeData, afterData) == DataNotPreserved
```

### The update receipt names the installed candidate and says whether data preservation was observed

The installed bytes and version must be the candidate's, and the app's UID
and first-install time must be unchanged. With no before readback the
receipt passes on package identity alone and says the data was not
observed; a readback that failed or lost data never passes.

```quint
type PackageIdentity = { uid: str, firstInstall: str }
type PackageReadback = { candidate: Digest, candidateVersion: int, installed: Digest, installedVersion: int, before: PackageIdentity, after: PackageIdentity }
type UpdateReceipt = { packageMatches: bool, data: DataEvidence, passed: bool }
pure def updateReceipt(update: PackageReadback, beforeData: Inventory, afterData: Inventory): UpdateReceipt = {
  val packageMatches = digestsMatch(update.candidate, update.installed) and update.candidateVersion == update.installedVersion and update.before == update.after
  val data = dataEvidence(beforeData, afterData)
  { packageMatches: packageMatches, data: data, passed: packageMatches and data != DataNotPreserved }
}
pure val updateValues = {
  val same = { candidate: Sha256({ hex: "a1" }), candidateVersion: 3, installed: Sha256({ hex: "a1" }), installedVersion: 3, before: { uid: "u1", firstInstall: "t1" }, after: { uid: "u1", firstInstall: "t1" } }
  List(same, { ...same, installed: Sha256({ hex: "a2" }) }, { ...same, installedVersion: 2 }, { ...same, after: { uid: "u2", firstInstall: "t1" } },
    { ...same, after: { uid: "u1", firstInstall: "t2" } }, { ...same, candidate: NotADigest, installed: NotADigest }).foldl(Set(), (acc, u) => acc.union(Set(u)))
}
pure def lawPassedReceiptInstalledTheCandidateInPlace(update: PackageReadback, beforeData: Inventory, afterData: Inventory): bool = updateReceipt(update, beforeData, afterData).passed implies (isDigest(update.installed) and update.installed == update.candidate and update.after == update.before)
pure def lawFailedOrEmptyBeforeReadbackNeverPasses(update: PackageReadback, afterData: Inventory): bool = not(updateReceipt(update, InventoryFailed, afterData).passed) and not(updateReceipt(update, InventoryRead({ files: List() }), afterData).passed)
pure def lawUnobservedDataOnlyWithoutABeforeReadback(update: PackageReadback, beforeData: Inventory, afterData: Inventory): bool = (updateReceipt(update, beforeData, afterData).passed and beforeData != InventoryUnavailable) implies updateReceipt(update, beforeData, afterData).data == DataPreserved
```
