# Android build and APK publication

A consumer builds its generated [Android host](./androidHost.md) with
`buildAndroid` (`src/build/android-build.vibe`, exported from
`@elizaos/os/build`). The call runs the consumer's prepare steps, one Gradle
run for the selected variants, and the consumer's verify command, then
publishes the APK set, and on request an archive of it, by
[atomic publication](../../core/atomicPublication.md). The source is
develop's `packages/app/scripts/mobile/android/build-consumer.mjs`.

The shell parses the call: variant names against `[a-z][A-Za-z0-9]*`, paths
as explicit relative segments, Gradle arguments (`-Pname=value` and
`--offline` only), commands as argv with no shell, synchronous prepare
steps, a record name that is a plain `.json` name and none of the names the
build writes itself, and serializable metadata. It passes the result as
`wellFormed`. It reads the pinned commit and the staged payload inventory
before Gradle and again after it ([source integrity](./sourceIntegrity.md),
[runtime payload](./runtimePayload.md)), and it computes the release
signing and the APK manifest rules from the host profile. This spec decides
what may replace what a consumer already has.

## Story: Replace published APKs only with this run's verified set

> As a consumer, I want my build to replace the APKs I already have only
> with the complete set this run built and verified, so that a stale,
> partial, unsigned or unchecked output never takes their place.

### A request is admitted only when well formed, built from the pinned source and an identified payload

A debug-only build (`release: false`) assembles no release APK and cannot be
archived. A release needs every signing variable or none
(`H::signingNameCount`); some of them set refuses it before Gradle runs. A
host without the agent service stages no agent payload; one with it names
its inventory digest.

```quint
import apk as A from "../image/apk"
import androidHost as H from "./androidHost"
import atomicPublication as P from "../../core/atomicPublication"
type StagedPayload = NoAgentPayload | AgentPayload({ inventory: A::Digest })
type BuildRequest = { variants: List[str], wellFormed: bool, release: bool, signing: H::NamedSet, signingVariablesSet: int, wantsArchive: bool, pin: str, sourceAtPin: bool, payload: StagedPayload }
type RequestRefusal = NoVariants | DuplicateVariant | MalformedRequest | DebugOnlyArchive | SigningPartial | SourceNotAtPin | PayloadUnidentified
type RequestFinding = RequestAdmitted | RequestRefused({ refusal: RequestRefusal })
pure def carriesAgent(payload: StagedPayload): bool = match payload { | AgentPayload(p) => true | _ => false }
pure def inventoryOf(payload: StagedPayload): A::Digest = match payload { | AgentPayload(p) => p.inventory | _ => A::NotADigest }
pure def samePayload(payload: StagedPayload, observed: StagedPayload): bool =
  carriesAgent(payload) == carriesAgent(observed) and (carriesAgent(payload) implies A::digestsMatch(inventoryOf(payload), inventoryOf(observed)))
pure def partialSigning(r: BuildRequest): bool = r.signingVariablesSet > 0 and r.signingVariablesSet < H::signingNameCount
pure def publishedSet(r: BuildRequest): H::PublishedSet =
  if (not(r.release)) H::DebugSet else if (r.signingVariablesSet == 0) H::UnsignedReleaseSet else H::SignedReleaseSet
pure def requestFinding(r: BuildRequest): RequestFinding =
  if (r.variants.length() == 0) RequestRefused({ refusal: NoVariants })
  else if (not(r.variants.every(v => r.variants.select(w => w == v).length() == 1))) RequestRefused({ refusal: DuplicateVariant })
  else if (not(r.wellFormed)) RequestRefused({ refusal: MalformedRequest })
  else if (r.wantsArchive and not(r.release)) RequestRefused({ refusal: DebugOnlyArchive })
  else if (r.release and partialSigning(r)) RequestRefused({ refusal: SigningPartial })
  else if (r.pin == "" or not(r.sourceAtPin)) RequestRefused({ refusal: SourceNotAtPin })
  else if (carriesAgent(r.payload) and not(A::isDigest(inventoryOf(r.payload)))) RequestRefused({ refusal: PayloadUnidentified })
  else RequestAdmitted
pure val requestValues = {
  val base = { variants: List("launcher"), wellFormed: true, release: true, signing: H::AllNamed, signingVariablesSet: 4, wantsArchive: true, pin: "c1", sourceAtPin: true, payload: AgentPayload({ inventory: A::Sha256({ hex: "a1" }) }) }
  List(base, { ...base, wantsArchive: false }, { ...base, release: false, wantsArchive: false }, { ...base, payload: NoAgentPayload, signing: H::NoneNamed, signingVariablesSet: 0 },
    { ...base, release: false }, { ...base, variants: List() }, { ...base, variants: List("launcher", "launcher") }, { ...base, wellFormed: false },
    { ...base, signingVariablesSet: 3 }, { ...base, sourceAtPin: false }, { ...base, pin: "" }, { ...base, payload: AgentPayload({ inventory: A::NotADigest }) })
    .foldl(Set(), (acc, r) => acc.union(Set(r)))
}
pure def lawAdmittedRequestIsBuildableFromThePin(request: BuildRequest): bool = requestFinding(request) == RequestAdmitted implies (request.variants.length() > 0 and request.wellFormed
  and request.pin != "" and request.sourceAtPin and (request.wantsArchive implies request.release) and (request.release implies not(partialSigning(request))))
```

### Every selected APK must come out of Gradle, and a release signed as configured, before anything is written

Gradle builds every selected variant's debug APK, its release APK in a
release build, and the test APKs the consumer asked for. A missing file, or
a release whose signing is not what the signing variables configure
(`H::releasePublication`: unsigned with every variable set, or signed with
none), fails the build. Only then does the shell copy
the set, the consumer's build record and the R8 mappings that exist into a
private directory (`P::create`, `P::write`); the published set is not
touched.

```quint
type GradleRun = { succeeded: bool, apksPresent: bool, releaseSigned: bool, copied: bool }
type BuildFailure = InputRefused | GradleFailed | OutputsIncomplete | ReleaseUnsigned | CopyFailed | SourceMoved | PayloadChanged | VerificationFailed | SetNotPublished | ArchiveFilesChanged | ArchiveNotPublished
type BuildPhase = Pending | Building | Staged | Verified | Published | Archived | Failed({ failure: BuildFailure })
type AndroidBuild = { phase: BuildPhase, request: BuildRequest, manifest: List[H::PublishedApk], apks: P::Publication, archive: P::Publication }
pure val noRequest: BuildRequest = { variants: List(), wellFormed: false, release: false, signing: H::NoneNamed, signingVariablesSet: 0, wantsArchive: false, pin: "", sourceAtPin: false, payload: NoAgentPayload }
pure val initial: AndroidBuild = { phase: Pending, request: noRequest, manifest: List(), apks: P::initial, archive: P::initial }
pure def canAdmit(b: AndroidBuild): bool = b.phase == Pending
pure def admit(b: AndroidBuild, request: BuildRequest): AndroidBuild =
  { ...b, request: request, phase: if (requestFinding(request) == RequestAdmitted) Building else Failed({ failure: InputRefused }) }
pure val gradleValues = Set({ succeeded: true, apksPresent: true, releaseSigned: true, copied: true }, { succeeded: true, apksPresent: true, releaseSigned: false, copied: true },
  { succeeded: false, apksPresent: true, releaseSigned: true, copied: true }, { succeeded: true, apksPresent: false, releaseSigned: true, copied: true }, { succeeded: true, apksPresent: true, releaseSigned: true, copied: false })
pure def canAssemble(b: AndroidBuild): bool = b.phase == Building
pure def assemble(b: AndroidBuild, gradle: GradleRun): AndroidBuild =
  if (not(gradle.succeeded)) { ...b, phase: Failed({ failure: GradleFailed }) }
  else if (not(gradle.apksPresent)) { ...b, phase: Failed({ failure: OutputsIncomplete }) }
  else if (b.request.release and H::releasePublication(b.request.signing, b.request.signingVariablesSet, gradle.releaseSigned) == H::ReleaseBuildFails) { ...b, phase: Failed({ failure: ReleaseUnsigned }) }
  else { ...b, apks: P::write(P::create(b.apks, true), gradle.copied), phase: if (gradle.copied) Staged else Failed({ failure: CopyFailed }) }
pure def failedBeforeCopy(phase: BuildPhase): bool =
  phase == Failed({ failure: InputRefused }) or phase == Failed({ failure: GradleFailed }) or phase == Failed({ failure: OutputsIncomplete }) or phase == Failed({ failure: ReleaseUnsigned })
pure def alwaysNothingWrittenBeforeACompleteGradleRun(b: AndroidBuild): bool =
  (b.phase == Pending or b.phase == Building or failedBeforeCopy(b.phase)) implies (b.apks == P::initial and b.archive == P::initial)
pure def alwaysWorkingBuildWasAdmitted(b: AndroidBuild): bool = (b.phase != Pending and b.phase != Failed({ failure: InputRefused })) implies requestFinding(b.request) == RequestAdmitted
pure def stepRequestIsFixedOnceAdmitted(before: AndroidBuild, after: AndroidBuild): bool = before.phase != Pending implies after.request == before.request
pure def sometimesInputRefused(b: AndroidBuild): bool = b.phase == Failed({ failure: InputRefused })
pure def sometimesUnsignedReleaseFails(b: AndroidBuild): bool = b.phase == Failed({ failure: ReleaseUnsigned })
pure def sometimesMissingApkFails(b: AndroidBuild): bool = b.phase == Failed({ failure: OutputsIncomplete })
pure def sometimesFailedCopyIsCleanedUp(b: AndroidBuild): bool = b.phase == Failed({ failure: CopyFailed }) and b.apks.receipt == P::FailureReceipt
```

### The private set is verified against the pin, the payload and a fresh APK manifest before it can be published

The consumer's verify command runs on the private copy and writes the APK
manifest there, so no earlier run's manifest can pass. The shell then reads
the pinned commit and the payload inventory again: a build that moved the
source off its pin or changed the staged payload fails, whatever the
manifest says. A failed set is never renamed (`P::rename` refused), so the
APKs a consumer already has stay in place.

```quint
type VerifyReport = { verifierSucceeded: bool, rows: List[H::PublishedApk], sourceAtPin: bool, payload: StagedPayload }
pure val reportValues = {
  val row = { flavor: "launcher", fileFlavor: "launcher", build: H::ReleaseApk, apk: A::Sha256({ hex: "a1" }), signer: A::Sha256({ hex: "c1" }), fresh: true }
  val good = { verifierSucceeded: true, rows: List(row), sourceAtPin: true, payload: AgentPayload({ inventory: A::Sha256({ hex: "a1" }) }) }
  List(good, { ...good, payload: NoAgentPayload }, { ...good, verifierSucceeded: false }, { ...good, rows: List({ ...row, fresh: false }) }, { ...good, rows: List() },
    { ...good, rows: List({ ...row, build: H::DebugApk }) }, { ...good, rows: List({ ...row, signer: A::NotADigest }) },
    { ...good, payload: NoAgentPayload, rows: List({ ...row, signer: A::NotADigest }) }, { ...good, rows: List({ ...row, fileFlavor: "sideload" }) },
    { ...good, sourceAtPin: false }, { ...good, payload: AgentPayload({ inventory: A::Sha256({ hex: "c1" }) }) }).foldl(Set(), (acc, r) => acc.union(Set(r)))
}
pure def verifyOutcome(b: AndroidBuild, report: VerifyReport): BuildPhase =
  if (not(report.sourceAtPin)) Failed({ failure: SourceMoved })
  else if (not(samePayload(b.request.payload, report.payload))) Failed({ failure: PayloadChanged })
  else if (not(report.verifierSucceeded and H::publishedManifestAdmitted(b.request.variants, publishedSet(b.request), report.rows))) Failed({ failure: VerificationFailed })
  else Verified
pure def canVerify(b: AndroidBuild): bool = b.phase == Staged and P::canRename(b.apks)
pure def verify(b: AndroidBuild, report: VerifyReport): AndroidBuild = {
  val verdict = verifyOutcome(b, report)
  if (verdict == Verified) { ...b, phase: Verified, manifest: report.rows } else { ...b, phase: verdict, apks: P::rename(b.apks, false) }
}
pure def alwaysStagedSetIsACompletePrivateCopy(b: AndroidBuild): bool =
  (b.phase == Staged or b.phase == Verified) implies (b.apks.phase == P::Renaming and b.apks.temporary == P::CompleteTemporary)
pure def setWasVerified(phase: BuildPhase): bool = phase == Verified or phase == Published or phase == Archived
  or phase == Failed({ failure: SetNotPublished }) or phase == Failed({ failure: ArchiveFilesChanged }) or phase == Failed({ failure: ArchiveNotPublished })
pure def alwaysVerifiedSetHasThisRunsManifest(b: AndroidBuild): bool =
  if (setWasVerified(b.phase)) H::publishedManifestAdmitted(b.request.variants, publishedSet(b.request), b.manifest) else b.manifest == List()
pure def sometimesMovedSourceFails(b: AndroidBuild): bool = b.phase == Failed({ failure: SourceMoved })
pure def sometimesChangedPayloadFails(b: AndroidBuild): bool = b.phase == Failed({ failure: PayloadChanged })
pure def sometimesUnverifiedSetDiscarded(b: AndroidBuild): bool = b.phase == Failed({ failure: VerificationFailed }) and b.apks.receipt == P::FailureReceipt
```

### Only a verified set replaces the published APKs, in one rename, with an honest receipt

The set replaces the previous one whole: a debug-only build leaves no
earlier release APK beside its debug APKs. The caller's answer is the
publication receipt, after the private copy is cleaned up.

```quint
pure def canPublishSet(b: AndroidBuild): bool = b.phase == Verified and P::canRename(b.apks)
pure def publishSet(b: AndroidBuild, ok: bool): AndroidBuild = {
  val renamed = P::rename(b.apks, ok)
  { ...b, apks: renamed, phase: if (renamed.published) Published else Failed({ failure: SetNotPublished }) }
}
pure def canCleanSet(b: AndroidBuild): bool = P::canCleanup(b.apks)
pure def cleanSet(b: AndroidBuild, removed: bool): AndroidBuild = { ...b, apks: P::cleanup(b.apks, removed) }
pure def setStands(phase: BuildPhase): bool = phase == Published or phase == Archived or phase == Failed({ failure: ArchiveFilesChanged }) or phase == Failed({ failure: ArchiveNotPublished })
pure def alwaysPublishedSetIsTheVerifiedOne(b: AndroidBuild): bool = b.apks.published iff setStands(b.phase)
pure def alwaysReceiptsAreHonest(b: AndroidBuild): bool = P::alwaysSuccessMeansPublished(b.apks) and P::alwaysPublicationMatchesWrite(b.apks)
  and P::alwaysPreRenameOwnsPendingPublication(b.apks) and P::alwaysSuccessMeansPublished(b.archive) and P::alwaysPublicationMatchesWrite(b.archive)
pure def stepSetIsPublishedOnlyFromVerified(before: AndroidBuild, via: str, after: AndroidBuild): bool =
  (after.apks.published and not(before.apks.published)) implies (via == "publishSet" and before.phase == Verified)
pure def isFailed(phase: BuildPhase): bool = phase != Pending and phase != Building and phase != Staged and phase != Verified and phase != Published and phase != Archived
pure def stepFinishedBuildStays(before: AndroidBuild, after: AndroidBuild): bool =
  (before.phase == Archived or isFailed(before.phase)) implies (after.phase == before.phase and after.manifest == before.manifest)
pure def sometimesVerifiedSetPublished(b: AndroidBuild): bool = b.phase == Published and b.apks.receipt == P::SuccessReceipt and carriesAgent(b.request.payload)
pure def sometimesDebugOnlySetPublished(b: AndroidBuild): bool = b.phase == Published and not(b.request.release)
pure def sometimesUnsignedReleaseSetPublished(b: AndroidBuild): bool = b.phase == Published and publishedSet(b.request) == H::UnsignedReleaseSet
pure def sometimesFailedRenameKeepsPreviousSet(b: AndroidBuild): bool = b.phase == Failed({ failure: SetNotPublished }) and b.apks.receipt == P::FailureReceipt
```

### An archive copies the published set with the consumer's verified files, or the previous archive stays

The archive holds the APKs, the APK manifest, the build record, the
consumer's service metadata, the checks the build ran (lint, test APKs) and
the consumer's extra files. Each extra file has a safe name no other entry
uses, and its bytes must hash to the SHA-256 the verifier recorded for it
(`filesMatch`) before anything is written. The archive is staged privately
and swapped in by `P::rename`; a failed swap leaves the previous archive
under its name.

```quint
pure def canArchiveSet(b: AndroidBuild): bool = b.phase == Published and b.request.wantsArchive and b.archive == P::initial
pure def archiveSet(b: AndroidBuild, filesMatch: bool, ok: bool): AndroidBuild = {
  val renamed = P::rename(P::write(P::create(b.archive, true), true), ok)
  if (not(filesMatch)) { ...b, phase: Failed({ failure: ArchiveFilesChanged }) }
  else { ...b, archive: renamed, phase: if (renamed.published) Archived else Failed({ failure: ArchiveNotPublished }) }
}
pure def canCleanArchive(b: AndroidBuild): bool = P::canCleanup(b.archive)
pure def cleanArchive(b: AndroidBuild, removed: bool): AndroidBuild = { ...b, archive: P::cleanup(b.archive, removed) }
pure def alwaysArchiveOnlyOfAPublishedReleaseSet(b: AndroidBuild): bool =
  (b.archive != P::initial implies (b.apks.published and b.request.wantsArchive and b.request.release)) and (b.archive.published iff b.phase == Archived)
pure def sometimesArchived(b: AndroidBuild): bool = b.phase == Archived and b.archive.receipt == P::SuccessReceipt
pure def sometimesChangedExtraKeepsSetWithoutArchive(b: AndroidBuild): bool = b.phase == Failed({ failure: ArchiveFilesChanged }) and b.apks.published and b.archive == P::initial
pure def sometimesFailedArchiveSwapKeepsPrevious(b: AndroidBuild): bool = b.phase == Failed({ failure: ArchiveNotPublished }) and b.apks.published
```
