# Launcher staging

One call stages the consumer's launcher into a new overlay directory of an
image checkout: the presigned APK and its same-signer companions, the
first-boot grants, the privileged allow-list and the agent socket policy
when the launcher is privileged, and the APK's native libraries for the
image ABI. The writer is `src/image/stage-launcher.vibe` (`stageLauncher`,
`finalizeNative`), exported from `@elizaos/os`, which runs one
machine per call. The sources are develop's `stage-launcher-overlay.ts`,
`android-native-admission.mjs`, `stage-android-native.py` (`stage`,
`finalize_soong`) and the `LauncherNativeInstall` Quint model.

The shell parses the descriptor (schema 1), copies each APK into a private
directory and hashes the copy, and reads the copy with `aapt` and
`apksigner` into `ApkObservation` ([APK admission](./apk.md) gives the
digest, build type and signer types). `brandValid` and `moduleNameValid`
are its syntax checks: the brand, the launcher's and companions' module and
package names, permission names, and module names that cannot collide with
the generated ones. It reads each `lib/<abi>/` ZIP entry into a
`NativeLibrary`. Publication is the [atomic publication](../../core/atomicPublication.md)
of the private directory onto the output by rename. Staging is evidence of
staging only: never of a boot, a signature or a device qualification.

## Story: Stage my launcher into an image exactly once

> As a consumer, I want my reviewed launcher staged into a new overlay
> exactly as I reviewed it, so that a different APK, signer or permission
> set never reaches the image and a failed call leaves nothing behind.

### A descriptor names a valid launcher, at most 32 unique first-boot grants, only reviewed privileged permissions, and distinct companions

A privileged permission is never also a first-boot grant. An absent list
is empty; the shell refuses an explicit empty list.

```quint
import apk.* from "./apk"
import runtimePayload as R from "../build/runtimePayload"
import atomicPublication as P from "../../core/atomicPublication"
type Partition = ProductPartition | SystemPartition
type CompanionDescriptor = { moduleName: str, packageName: str, apkSha256: Digest }
type LauncherDescriptor = { schemaVersion: int, brandValid: bool, moduleNameValid: bool, moduleName: str, packageName: str, apkSha256: Digest, certificate: Digest,
  defaultPermissions: List[str], privilegedPermissions: List[str], partition: Partition, companions: List[CompanionDescriptor] }
pure val reviewedPrivilegedPermissions = Set("android.permission.READ_PRIVILEGED_PHONE_STATE")
pure def distinctNames(names: List[str]): bool = names.every(x => names.select(y => y == x).length() == 1)
pure def companionsDistinct(d: LauncherDescriptor): bool = {
  val modules = d.companions.listMap(x => x.moduleName)
  val packages = d.companions.listMap(x => x.packageName)
  distinctNames(modules) and distinctNames(packages) and not(modules.includes(d.moduleName)) and not(packages.includes(d.packageName))
}
pure def descriptorValid(d: LauncherDescriptor): bool =
  d.schemaVersion == 1 and d.brandValid and d.moduleNameValid and isDigest(d.apkSha256) and isDigest(d.certificate)
  and d.defaultPermissions.length() <= 32 and distinctNames(d.defaultPermissions) and distinctNames(d.privilegedPermissions)
  and d.privilegedPermissions.every(x => reviewedPrivilegedPermissions.contains(x)) and d.privilegedPermissions.every(x => not(d.defaultPermissions.includes(x)))
  and d.companions.every(x => isDigest(x.apkSha256)) and companionsDistinct(d)
```

### The launcher is the descriptor's APK, home launcher and only signer, and declares every permission the descriptor names

Every APK is a release build unless the call is a development staging. A
descriptor self-selected from the APK's own signer is taken only in
development. Each companion is supplied exactly once, matches its digest
and package, is not a home launcher and has the launcher's signer.

```quint
type NativeEntryCheck = EntryValid | EntryCompressed | EntryNotFlat | EntryNotElfForAbi | EntryCrcMismatch
type NativeLibrary = { abi: R::Abi, name: str, check: NativeEntryCheck }
type ApkObservation = { sha256: Digest, packageName: str, home: bool, buildType: ApkBuildType, signer: SignerObservation, declaredPermissions: List[str], natives: List[NativeLibrary] }
type SuppliedCompanion = { moduleName: str, apk: ApkObservation }
type DescriptorSource = ReviewedDescriptor | SelfSelected
pure val noApk: ApkObservation = { sha256: NotADigest, packageName: "", home: false, buildType: BuildTypeUnread, signer: NoSigner, declaredPermissions: List(), natives: List() }
pure def buildAllowed(buildType: ApkBuildType, stagingMode: StagingMode): bool = buildType == ReleaseBuild or (buildType == DebuggableBuild and stagingMode == StageDevelopment)
pure def companionAdmitted(d: LauncherDescriptor, supplied: List[SuppliedCompanion], stagingMode: StagingMode, x: CompanionDescriptor): bool = {
  val matching = supplied.select(y => y.moduleName == x.moduleName)
  val found = matching.nthOr(0, { moduleName: "", apk: noApk }).apk
  matching.length() == 1 and digestsMatch(found.sha256, x.apkSha256) and found.packageName == x.packageName and not(found.home)
    and buildAllowed(found.buildType, stagingMode) and signedBy(found.signer, d.certificate)
}
pure def companionsAdmitted(d: LauncherDescriptor, supplied: List[SuppliedCompanion], stagingMode: StagingMode): bool =
  d.companions.every(x => companionAdmitted(d, supplied, stagingMode, x)) and supplied.every(y => d.companions.some(x => x.moduleName == y.moduleName))
```

### An APK that carries the Node runtime is staged only with its natives for the image ABI, under the install rules the target supports

A call that stages natives names the ABI and the install rules: `make`, or
the `soong-app-native` rules that a Soong-only target needs and that need
the reviewed `soong-app-native` patch admitted in the checkout
([source lock](./sourceLock.md)). `SoongDeferred` publishes `make` rules
and converts them after product composition. Every native entry for the
ABI is stored, a flat `lib*.so` name, a little-endian ELF64 for the ABI and
CRC-checked; the APK carries `libeliza_node.so` for that ABI whenever it
carries it at all.

```quint
type NativeInstall = MakeRules | SoongRules | SoongDeferred
type NativeRequest = NoNatives | NativeFor({ abi: R::Abi, install: NativeInstall })
type ImageTarget = { soongOnly: bool, soongPatchAdmitted: bool }
type StagingRefusal = DescriptorInvalid | SelfSelectedOutsideDevelopment | LauncherDigestMismatch | NotTheLauncherPackage | BuildNotAllowed | SignerNotTheDescriptors
  | PermissionUndeclared | CompanionRefused | RuntimeNativesNotStaged | NoNativesForAbi | RuntimeMissingForAbi | NativeEntryInvalid | MakeRulesOnSoongOnlyTarget
  | SoongPatchNotAdmitted
type StagingAdmission = StagingAdmitted | StagingRefused({ reason: StagingRefusal })
pure def carriesRuntime(a: ApkObservation): bool = a.natives.some(n => n.name == R::nodeLibraryName)
pure def nativesFor(a: ApkObservation, abi: R::Abi): List[NativeLibrary] = a.natives.select(n => n.abi == abi)
pure def nativeAdmission(abi: R::Abi, install: NativeInstall, a: ApkObservation, target: ImageTarget): StagingAdmission =
  if (nativesFor(a, abi).length() == 0) StagingRefused({ reason: NoNativesForAbi })
  else if (carriesRuntime(a) and not(nativesFor(a, abi).some(n => n.name == R::nodeLibraryName))) StagingRefused({ reason: RuntimeMissingForAbi })
  else if (nativesFor(a, abi).some(n => n.check != EntryValid)) StagingRefused({ reason: NativeEntryInvalid })
  else if (target.soongOnly and install == MakeRules) StagingRefused({ reason: MakeRulesOnSoongOnlyTarget })
  else if (install != MakeRules and not(target.soongPatchAdmitted)) StagingRefused({ reason: SoongPatchNotAdmitted })
  else StagingAdmitted
pure def requestAdmission(nativeRequest: NativeRequest, a: ApkObservation, target: ImageTarget): StagingAdmission = match nativeRequest {
  | NativeFor(n) => nativeAdmission(n.abi, n.install, a, target)
  | NoNatives => if (carriesRuntime(a)) StagingRefused({ reason: RuntimeNativesNotStaged }) else StagingAdmitted
}
```

### A call is admitted only when every check above holds, and a refusal names the first that failed

```quint
type CallMode = StageOverlay | AdmissionOnly
type StagingCall = { descriptor: LauncherDescriptor, source: DescriptorSource, stagingMode: StagingMode, apk: ApkObservation, companions: List[SuppliedCompanion],
  nativeRequest: NativeRequest, target: ImageTarget, mode: CallMode, outputExists: bool }
pure def stagingAdmission(call: StagingCall): StagingAdmission = {
  val d = call.descriptor
  val a = call.apk
  if (not(descriptorValid(d))) StagingRefused({ reason: DescriptorInvalid })
  else if (call.source == SelfSelected and call.stagingMode != StageDevelopment) StagingRefused({ reason: SelfSelectedOutsideDevelopment })
  else if (not(digestsMatch(a.sha256, d.apkSha256))) StagingRefused({ reason: LauncherDigestMismatch })
  else if (a.packageName != d.packageName or not(a.home)) StagingRefused({ reason: NotTheLauncherPackage })
  else if (not(buildAllowed(a.buildType, call.stagingMode))) StagingRefused({ reason: BuildNotAllowed })
  else if (not(signedBy(a.signer, d.certificate))) StagingRefused({ reason: SignerNotTheDescriptors })
  else if (not(d.defaultPermissions.concat(d.privilegedPermissions).every(x => a.declaredPermissions.includes(x)))) StagingRefused({ reason: PermissionUndeclared })
  else if (not(companionsAdmitted(d, call.companions, call.stagingMode))) StagingRefused({ reason: CompanionRefused })
  else requestAdmission(call.nativeRequest, a, call.target)
}
pure def stagesRuntime(nativeRequest: NativeRequest, a: ApkObservation): bool = match nativeRequest {
  | NativeFor(n) => nativesFor(a, n.abi).some(x => x.name == R::nodeLibraryName) and nativesFor(a, n.abi).every(x => x.check == EntryValid)
  | NoNatives => false
}
pure def usesMakeRules(nativeRequest: NativeRequest): bool = match nativeRequest { | NativeFor(n) => n.install == MakeRules | NoNatives => false }
pure val callValues = {
  val descriptor = { schemaVersion: 1, brandValid: true, moduleNameValid: true, moduleName: "Home", packageName: "pkg.home", apkSha256: Sha256({ hex: "a1" }), certificate: Sha256({ hex: "c1" }),
    defaultPermissions: List("android.permission.CAMERA"), privilegedPermissions: List(), partition: ProductPartition, companions: List() }
  val launcher = { ...noApk, sha256: Sha256({ hex: "a1" }), packageName: "pkg.home", home: true, buildType: ReleaseBuild, signer: OneSigner({ certificate: Sha256({ hex: "c1" }) }),
    declaredPermissions: List("android.permission.CAMERA", "android.permission.READ_PRIVILEGED_PHONE_STATE") }
  val companion = { ...launcher, sha256: Sha256({ hex: "b1" }), packageName: "pkg.updater", home: false }
  val plain = { descriptor: descriptor, source: ReviewedDescriptor, stagingMode: StageProduction, apk: launcher, companions: List(), nativeRequest: NoNatives,
    target: { soongOnly: false, soongPatchAdmitted: false }, mode: StageOverlay, outputExists: false }
  val withCompanion = { ...plain, descriptor: { ...descriptor, companions: List({ moduleName: "Updater", packageName: "pkg.updater", apkSha256: Sha256({ hex: "b1" }) }) },
    companions: List({ moduleName: "Updater", apk: companion }) }
  val runtimeLibraries = List({ abi: R::X86_64, name: R::nodeLibraryName, check: EntryValid }, { abi: R::X86_64, name: "libagent.so", check: EntryValid })
  val privileged = { ...plain, descriptor: { ...descriptor, privilegedPermissions: List("android.permission.READ_PRIVILEGED_PHONE_STATE") }, apk: { ...launcher, natives: runtimeLibraries },
    nativeRequest: NativeFor({ abi: R::X86_64, install: SoongDeferred }), target: { soongOnly: true, soongPatchAdmitted: true } }
  List(plain, withCompanion, privileged, { ...plain, mode: AdmissionOnly }, { ...plain, outputExists: true }, { ...plain, source: SelfSelected },
    { ...plain, source: SelfSelected, stagingMode: StageDevelopment, apk: { ...launcher, buildType: DebuggableBuild } }, { ...plain, apk: { ...launcher, signer: OneSigner({ certificate: Sha256({ hex: "c2" }) }) } },
    { ...plain, descriptor: { ...descriptor, privilegedPermissions: List("android.permission.CAMERA") } }, { ...withCompanion, companions: List({ moduleName: "Updater", apk: { ...companion, home: true } }) },
    { ...privileged, nativeRequest: NoNatives }, { ...privileged, nativeRequest: NativeFor({ abi: R::X86_64, install: MakeRules }) }, { ...privileged, nativeRequest: NativeFor({ abi: R::Arm64, install: SoongRules }) },
    { ...privileged, nativeRequest: NativeFor({ abi: R::X86_64, install: SoongRules }) }, { ...privileged, target: { soongOnly: true, soongPatchAdmitted: false } }).foldl(Set(), (acc, x) => acc.union(Set(x)))
}
pure def lawAdmittedLauncherIsTheDescriptors(call: StagingCall): bool = stagingAdmission(call) == StagingAdmitted implies
  (digestsMatch(call.apk.sha256, call.descriptor.apkSha256) and isDigest(call.descriptor.certificate) and call.apk.signer == OneSigner({ certificate: call.descriptor.certificate }))
pure def lawProductionTakesOnlyReviewedReleaseBuilds(call: StagingCall): bool = (stagingAdmission(call) == StagingAdmitted and call.stagingMode == StageProduction) implies
  (call.source == ReviewedDescriptor and call.apk.buildType == ReleaseBuild and call.companions.every(x => x.apk.buildType == ReleaseBuild))
pure def lawRuntimeApkStagesItsNatives(call: StagingCall): bool = (stagingAdmission(call) == StagingAdmitted and carriesRuntime(call.apk)) implies stagesRuntime(call.nativeRequest, call.apk)
pure def lawSoongOnlyTargetNeverUsesMakeRules(call: StagingCall): bool = (stagingAdmission(call) == StagingAdmitted and call.target.soongOnly) implies not(usesMakeRules(call.nativeRequest))
```

### The overlay grants only declared permissions, and places the launcher in priv-app with its allow-list and the agent socket policy only when it names privileged permissions

The launcher and its companions go to the descriptor's partition. First-boot
grants are written `fixed="false"`, so the owner can revoke them; companions
get no grant and no allow-list. A privileged launcher gets
`eliza_agent_socket.te` (`allow priv_app_all privapp_data_file:sock_file
{ create unlink getattr setattr write rename };`), because the agent service
always talks over a filesystem socket. Native libraries keep their APK bytes
and take their file mode from the [runtime payload](../build/runtimePayload.md):
only the Node runtime is executable.

```quint
type AppDirectory = PrivApp | App
type StagedNative = { name: str, mode: R::FileMode, directory: AppDirectory }
type RenderedOverlay = { partition: Partition, directory: AppDirectory, revocableGrants: List[str], privappAllowList: List[str], agentSocketPolicy: bool,
  natives: List[StagedNative], companionModules: List[str] }
pure def appDirectory(d: LauncherDescriptor): AppDirectory = if (d.privilegedPermissions.length() > 0) PrivApp else App
pure def stagedNatives(nativeRequest: NativeRequest, d: LauncherDescriptor, a: ApkObservation): List[StagedNative] = match nativeRequest {
  | NativeFor(n) => nativesFor(a, n.abi).listMap(x => { name: x.name, mode: R::nativeMode(x.name), directory: appDirectory(d) })
  | NoNatives => List()
}
pure def renderOverlay(call: StagingCall): RenderedOverlay = { partition: call.descriptor.partition, directory: appDirectory(call.descriptor), revocableGrants: call.descriptor.defaultPermissions,
  privappAllowList: call.descriptor.privilegedPermissions, agentSocketPolicy: appDirectory(call.descriptor) == PrivApp,
  natives: stagedNatives(call.nativeRequest, call.descriptor, call.apk), companionModules: call.companions.listMap(x => x.moduleName) }
pure def lawAdmittedOverlayAllowsOnlyReviewedPrivilege(call: StagingCall): bool = {
  val overlay = renderOverlay(call)
  stagingAdmission(call) == StagingAdmitted implies (overlay.privappAllowList.every(x => reviewedPrivilegedPermissions.contains(x) and not(overlay.revocableGrants.includes(x)))
    and overlay.revocableGrants.length() <= 32 and overlay.revocableGrants.concat(overlay.privappAllowList).every(x => call.apk.declaredPermissions.includes(x))
    and ((overlay.directory == PrivApp) iff overlay.agentSocketPolicy) and ((overlay.directory == PrivApp) iff overlay.privappAllowList.length() > 0)
    and overlay.natives.every(x => x.directory == overlay.directory and (x.mode == R::Executable implies x.name == R::nodeLibraryName)))
}
```

### Only an admitted, rendered overlay is published, once, and never over an existing output

The call writes its private directory (`P::create`, `P::write`) only after
admission, and publishes it by `P::rename`; while rendered and waiting to
publish, its private copy is complete and its publication receipt is still
pending. An existing output makes the
rename fail and stays untouched. A failed write (`WriteFailed`) or rename
(`OutputNotPublished`) ends the call like a refusal. Cleanup removes the private directory
whatever happened, and the caller's answer is the publication receipt.
`AdmissionOnly` stops at `Admitted` and writes nothing.

```quint
type StagePhase = Pending | Admitted | Rendered | Published | Refused({ reason: StagingRefusal }) | WriteFailed | OutputNotPublished
type SoongConversion = NoConversion | ConversionPending | Converted | ConversionRefused
type LauncherStaging = { phase: StagePhase, call: StagingCall, publication: P::Publication, conversion: SoongConversion }
pure val noCall: StagingCall = { descriptor: { schemaVersion: 0, brandValid: false, moduleNameValid: false, moduleName: "", packageName: "", apkSha256: NotADigest, certificate: NotADigest,
  defaultPermissions: List(), privilegedPermissions: List(), partition: ProductPartition, companions: List() }, source: ReviewedDescriptor, stagingMode: StageProduction, apk: noApk,
  companions: List(), nativeRequest: NoNatives, target: { soongOnly: false, soongPatchAdmitted: false }, mode: AdmissionOnly, outputExists: false }
pure val initial: LauncherStaging = { phase: Pending, call: noCall, publication: P::initial, conversion: NoConversion }
pure def deferredSoong(nativeRequest: NativeRequest): bool = match nativeRequest { | NativeFor(n) => n.install == SoongDeferred | NoNatives => false }
pure def refusedAtAdmission(phase: StagePhase): bool = match phase { | Refused(r) => true | _ => false }
pure def canAdmit(s: LauncherStaging): bool = s.phase == Pending
pure def admit(s: LauncherStaging, call: StagingCall): LauncherStaging = {
  val verdict = stagingAdmission(call)
  match verdict { | StagingRefused(r) => { ...s, call: call, phase: Refused({ reason: r.reason }) } | StagingAdmitted => { ...s, call: call, phase: Admitted } }
}
pure def canRender(s: LauncherStaging): bool = s.phase == Admitted and s.call.mode == StageOverlay
pure def render(s: LauncherStaging, ok: bool): LauncherStaging = { ...s, phase: if (ok) Rendered else WriteFailed, publication: P::write(P::create(s.publication, true), ok) }
pure def canPublish(s: LauncherStaging): bool = s.phase == Rendered
pure def publish(s: LauncherStaging, ok: bool): LauncherStaging = {
  val renamed = P::rename(s.publication, ok and not(s.call.outputExists))
  { ...s, publication: renamed, phase: if (renamed.published) Published else OutputNotPublished,
    conversion: if (renamed.published and deferredSoong(s.call.nativeRequest)) ConversionPending else NoConversion }
}
pure def canCleanStaging(s: LauncherStaging): bool = P::canCleanup(s.publication)
pure def cleanStaging(s: LauncherStaging, removed: bool): LauncherStaging = { ...s, publication: P::cleanup(s.publication, removed) }
pure def alwaysPublishedOnlyAnAdmittedOverlayIntoAFreeOutput(s: LauncherStaging): bool =
  (s.publication.published iff s.phase == Published) and ((s.phase == Admitted or s.phase == Rendered or s.phase == Published) implies stagingAdmission(s.call) == StagingAdmitted)
  and ((s.phase == Rendered or s.phase == Published) implies s.call.mode == StageOverlay) and (s.phase == Published implies not(s.call.outputExists))
pure def alwaysNothingWrittenBeforeRendering(s: LauncherStaging): bool =
  (s.phase == Pending or s.phase == Admitted or refusedAtAdmission(s.phase) or s.call.mode == AdmissionOnly) implies s.publication == P::initial
pure def alwaysRenderedHoldsACompletePrivateCopy(s: LauncherStaging): bool = s.phase == Rendered implies (s.publication.phase == P::Renaming and s.publication.temporary == P::CompleteTemporary and s.publication.receipt == P::PendingReceipt)
pure def alwaysReceiptIsHonest(s: LauncherStaging): bool = P::alwaysSuccessMeansPublished(s.publication) and P::alwaysPublicationMatchesWrite(s.publication)
pure def stepPublishedOverlayIsNeverReplaced(before: LauncherStaging, after: LauncherStaging): bool = before.phase == Published implies (after.phase == Published and after.call == before.call)
pure def sometimesPublishedWithSuccessReceipt(s: LauncherStaging): bool = s.phase == Published and s.publication.receipt == P::SuccessReceipt
pure def sometimesPrivilegedRuntimeLauncherPublished(s: LauncherStaging): bool = s.phase == Published and appDirectory(s.call.descriptor) == PrivApp and carriesRuntime(s.call.apk)
pure def sometimesExistingOutputRefusedAndCleaned(s: LauncherStaging): bool = s.phase == OutputNotPublished and s.call.outputExists and s.publication.phase == P::Settled
pure def sometimesWriteFailureCleaned(s: LauncherStaging): bool = s.phase == WriteFailed and s.publication.receipt == P::FailureReceipt
pure def sometimesCompanionPublished(s: LauncherStaging): bool = s.phase == Published and s.call.companions.length() > 0
pure def sometimesAdmissionOnlyChecked(s: LauncherStaging): bool = s.phase == Admitted and s.call.mode == AdmissionOnly
pure def sometimesRefusedAtAdmission(s: LauncherStaging): bool = refusedAtAdmission(s.phase)
```

### A deferred Soong conversion runs once, only on a published overlay, and only over its unchanged admitted bytes

`finalizeNative(output)` replaces the published `make` rules with the
`soong-app-native` rules after product composition, when the launcher APK
and every staged library still hash to the admitted digests (`intact`);
otherwise it refuses and the output must not be built.

```quint
pure def canFinalizeNative(s: LauncherStaging): bool = s.phase == Published and s.conversion == ConversionPending
pure def finalizeNative(s: LauncherStaging, intact: bool): LauncherStaging = { ...s, conversion: if (intact) Converted else ConversionRefused }
pure def alwaysConversionOnlyForADeferredPublishedOverlay(s: LauncherStaging): bool = s.conversion != NoConversion implies (s.phase == Published and deferredSoong(s.call.nativeRequest))
pure def stepConversionSettlesOnce(before: LauncherStaging, after: LauncherStaging): bool =
  (before.conversion == Converted or before.conversion == ConversionRefused) implies after.conversion == before.conversion
pure def sometimesDeferredSoongConverted(s: LauncherStaging): bool = s.conversion == Converted
pure def sometimesTamperedOverlayNotConverted(s: LauncherStaging): bool = s.conversion == ConversionRefused
```

### The staging evidence names the staged APK and mode and nothing beyond staging

The caller records it beside the overlay (`launcher.json`). It has no boot,
signing or qualification variant: those are other specs' evidence.

```quint
type StagingEvidence = OverlayStaged({ apkSha256: Digest, stagingMode: StagingMode, conversion: SoongConversion }) | AdmissionChecked | NothingStaged
pure def evidenceOf(s: LauncherStaging): StagingEvidence =
  if (s.phase == Published) OverlayStaged({ apkSha256: s.call.apk.sha256, stagingMode: s.call.stagingMode, conversion: s.conversion })
  else if (s.phase == Admitted and s.call.mode == AdmissionOnly) AdmissionChecked
  else NothingStaged
```

### A call settles as published, refused or admission-checked, with its private copy cleaned up

Admission, rendering, publication and cleanup are the call's own steps.

```quint
pure val fair_admit = "weak"
pure val fair_render = "weak"
pure val fair_publish = "weak"
pure val fair_cleanStaging = "weak"
pure def callSettled(s: LauncherStaging): bool = (s.phase == Admitted and s.call.mode == AdmissionOnly)
  or ((s.phase == Published or refusedAtAdmission(s.phase) or s.phase == WriteFailed or s.phase == OutputNotPublished)
    and (s.publication.phase == P::Queued or s.publication.phase == P::Settled))
pure def leadsToCallSettled(s: LauncherStaging, later: LauncherStaging): bool = callSettled(later)
```
