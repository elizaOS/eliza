# Android consumer build, verification, and archive custody

A consumer builds its Android host through the os package's consumer build
API. Its input includes distribution variants, preparation and
verification commands, project and output roots, Gradle flags, signing
environment names, and optional archive and build record metadata. The
[consumer host](./consumerHost.md) owns the generated project and its
descriptor, and [Android host composition](../android/bridge.md) owns the
bridge modules it includes. [Source integrity](./sourceIntegrity.md) and
[the emitted dependency inventory](./bundleInventory.md)
supply the provenance checked before build and archive publication.
[Merged manifest admission](./manifestAdmission.md) supplies the Android
distribution and callback rules. Orchestration uses the workspace's Node,
pnpm and VibeLang toolchain.

## Story: Publish only the Android distribution built and checked in this invocation

> As a consumer, I want my Android build to publish only the APKs and
> archive this invocation built and checked, so that a stale, partial or
> unchecked output never replaces the one I already had.

### Input checks and complete output preflight precede replacement

Variants must be nonempty, unique, and valid Gradle names. Paths are
consumer-relative. Preparation steps run synchronously. Command shape,
booleans, process options, key names, reserved output names and serializable
metadata are admitted before artifact replacement. Available signing
credentials require a signed release for each variant. Every selected
debug and release APK and requested copied test APK must be a regular
file before any artifact is replaced. Release naming removes the old
alternate signed or unsigned name. Stale verification is withdrawn before
Gradle, and a prior build record is withdrawn before replacing files.
A new record can exist after all copying even if verification subsequently
fails. Only an exact manifest produced by this verification qualifies
the current build for an archive. Missing mapping files are optional.
A diagnostic build can retain copied files after failure.

```quint
type BuildPhase = BuildPrior | BuildPreparing | BuildCopies | BuildVerifying | BuildVerified | BuildFailed
type AndroidBuild = { phase: BuildPhase, priorFilesIntact: bool, oldManifest: bool, oldRecord: bool, copied: bool, currentRecord: bool, verifiedManifest: bool }
pure val initial: AndroidBuild = { phase: BuildPrior, priorFilesIntact: true, oldManifest: true, oldRecord: true, copied: false, currentRecord: false, verifiedManifest: false }
pure def canPrepareBuild(b: AndroidBuild, validInput: bool): bool = b.phase == BuildPrior and validInput
pure def prepareBuild(b: AndroidBuild, validInput: bool): AndroidBuild = { ...b, phase: BuildPreparing }
pure def canWithdrawManifest(b: AndroidBuild, prepSucceeded: bool): bool = b.phase == BuildPreparing and b.oldManifest and prepSucceeded
pure def withdrawManifest(b: AndroidBuild, prepSucceeded: bool): AndroidBuild = { ...b, oldManifest: false }
pure def canReplaceArtifacts(b: AndroidBuild, allOutputs: bool, signingRequested: bool, signed: bool): bool =
  b.phase == BuildPreparing and not(b.oldManifest) and allOutputs and (not(signingRequested) or signed)
pure def replaceArtifacts(b: AndroidBuild, allOutputs: bool, signingRequested: bool, signed: bool): AndroidBuild =
  { ...b, phase: BuildCopies, oldRecord: false, priorFilesIntact: false }
pure def canCopyArtifacts(b: AndroidBuild): bool = b.phase == BuildCopies
pure def copyArtifacts(b: AndroidBuild, recordRequested: bool): AndroidBuild = { ...b, phase: BuildVerifying, copied: true, currentRecord: recordRequested }
pure def canObserveVerifier(b: AndroidBuild): bool = b.phase == BuildVerifying
pure def observeVerifier(b: AndroidBuild, commandSucceeded: bool, freshManifest: bool): AndroidBuild =
  if (commandSucceeded and freshManifest) { ...b, phase: BuildVerified, verifiedManifest: true }
  else { ...b, phase: BuildFailed }
pure def canFailBuild(b: AndroidBuild): bool = b.phase == BuildPreparing or b.phase == BuildCopies
pure def failBuild(b: AndroidBuild): AndroidBuild = { ...b, phase: BuildFailed }
pure def alwaysNoStaleReleaseEvidence(b: AndroidBuild): bool =
  (b.verifiedManifest implies b.copied and not(b.oldManifest) and not(b.oldRecord)) and
  ((b.phase == BuildCopies or b.phase == BuildVerifying or b.phase == BuildVerified or not(b.priorFilesIntact)) implies not(b.oldManifest) and not(b.oldRecord))
pure def alwaysCurrentRecordNamesCopiedFiles(b: AndroidBuild): bool = b.currentRecord implies b.copied
pure def alwaysBuildVerificationMatchesPhase(b: AndroidBuild): bool = b.verifiedManifest == (b.phase == BuildVerified) and (b.phase == BuildVerifying implies b.copied and not(b.oldManifest) and not(b.oldRecord))
pure def stepPrepFailureRetainsOldFiles(before: AndroidBuild, via: str, after: AndroidBuild): bool =
  (via == "failBuild" and before.phase == BuildPreparing) implies after.priorFilesIntact
pure def sometimesVerifiedCurrentBuild(b: AndroidBuild): bool = b.phase == BuildVerified and b.currentRecord
pure def sometimesBuildFilesWithoutVerification(b: AndroidBuild): bool = b.phase == BuildFailed and b.currentRecord and not(b.verifiedManifest)
```

### Preparing a build leaves the previously published APKs in place

Discovered by the proof: without it, a state still preparing could hold
replaced files, and a failure during preparation could not be shown to
keep the APKs the consumer already had. Copying starts only after both
stale receipts are withdrawn.

```quint
pure def alwaysPrepLeavesPriorFiles(b: AndroidBuild): bool = (b.phase == BuildPrior or b.phase == BuildPreparing) implies b.priorFilesIntact
```

### An archive preserves the old bytes until the new archive is ready

The archive directory contains current APKs, the current verifier
manifest, optional build record, service-mode metadata, build checks,
and verified extras. Extras require distinct safe names, no reserved
name collisions, and exact SHA-256 bytes before archive staging. A
successful swap publishes the complete replacement. If publishing
fails after moving the old directory, the builder restores its name.
A failed restoration leaves the old bytes at the recovery path.
The model treats archive directory moves and verifier results as checked
Effect-port outcomes and serializes one build for a destination.

```quint
type ArchiveDecision = ArchiveRefused | ArchivePublished | ArchivePriorPreserved | ArchivePriorRecoverable | ArchiveUnavailable
pure def archiveOutcome(verified: bool, validExtras: bool, staged: bool, oldExists: bool, movedOld: bool, movedNext: bool, restoredOld: bool): ArchiveDecision =
  if (not(verified and validExtras and staged)) ArchiveRefused
  else if (oldExists and not(movedOld)) ArchivePriorPreserved
  else if (movedNext) ArchivePublished
  else if (not(oldExists)) ArchiveUnavailable
  else if (restoredOld) ArchivePriorPreserved else ArchivePriorRecoverable
pure def lawArchiveNeedsCurrentVerification(validExtras: bool, staged: bool, oldExists: bool, movedOld: bool, movedNext: bool, restoredOld: bool): bool =
  archiveOutcome(false, validExtras, staged, oldExists, movedOld, movedNext, restoredOld) == ArchiveRefused
pure def lawFailedRestoreRetainsOldBytes(movedNext: bool, restoredOld: bool): bool =
  (not(movedNext) and not(restoredOld)) implies archiveOutcome(true, true, true, true, true, movedNext, restoredOld) == ArchivePriorRecoverable
```

## Story: Stage a reviewed native source tree for the consumer

> As a consumer, I want the native sources staged into my host to come
> from an exact reviewed revision with complete inputs, so that the
> payload I ship is identified by its pin and nothing else.

### The producer pin and complete staged inputs identify the resulting payload

Runtime staging requires an exact 40-hex reviewed revision,
an exclusive output, approved ABI and binary target, a gateway stager,
normalized bare-package stubs, and unchanged tracked diff and lock hash
across the build. Reviewed local archive input is subject to the same
binary integrity evidence as download input. It stages the consumer's
skills when the upstream output provides none. A selective Java and Kotlin
projection takes a new empty nonlinked directory outside the producer
source. It checks identity, exact rewrite anchors, distinct known classes
including the service, complete helper dependencies, and records original
and generated hashes. The admitted package and receipt identify the
staged producer. Registry verification and signed update activation rely
on separate evidence.

```quint
type NativeAbi = NativeArm64 | NativeX86 | UnsupportedAbi
type RuntimeTarget = HistoricalAndroid | HistoricalMusl | UnsupportedTarget
pure def runtimeStaging(abi: NativeAbi, target: RuntimeTarget, exactPin: bool, unchangedInputs: bool, exclusiveOutput: bool, validGateway: bool, binaryVerified: bool): bool =
  abi != UnsupportedAbi and (target == HistoricalMusl or (target == HistoricalAndroid and abi == NativeArm64)) and
  exactPin and unchangedInputs and exclusiveOutput and validGateway and binaryVerified
pure def projectionStaging(outsideProducer: bool, emptyIndependentOutput: bool, validIdentity: bool, serviceIncluded: bool, helpersComplete: bool, exactAnchors: bool): bool =
  outsideProducer and emptyIndependentOutput and validIdentity and serviceIncluded and helpersComplete and exactAnchors
pure def lawNativeAndroidBinaryRequiresArm64(abi: NativeAbi): bool =
  runtimeStaging(abi, HistoricalAndroid, true, true, true, true, true) implies abi == NativeArm64
pure def lawProjectionStagingRequiresService(outsideProducer: bool, emptyIndependentOutput: bool, validIdentity: bool, helpersComplete: bool, exactAnchors: bool): bool =
  not(projectionStaging(outsideProducer, emptyIndependentOutput, validIdentity, false, helpersComplete, exactAnchors))
```
