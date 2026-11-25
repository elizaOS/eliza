# Listener staging

A product may ship the wake listener: a separately built, privileged
`system_ext` app, `<launcher package>.sense`, that listens for the
product's wake names on the device. This spec decides whether a listener
APK may be staged into an image and whether the image activates it. The
shell is `stageListener`, `verifyListenerQualification` and
`listenerPermissions` in `src/image/listener.vibe`, exported from
`@elizaos/os`. Sources: develop's `sense-listener.mjs` (staging
half), `verify-sense-apk.py` and `sense-systemui.mjs`, and the staged
policy and qualification check a downstream image used.

The shell reads the facts: the package name split at its last dot,
`aapt dump permissions` (full permission names, without the permissions
the listener declares under its own package), `apksigner verify
--print-certs`, the ZIP layout, the speech bundle against the pinned
voice inputs, the overlay `config.xml`, the reviewed listener descriptor,
the consumer's public release certificate and the qualification record.
It writes the APK unchanged, the privileged-permission allowlist, the
overlay, the SystemUI chip overlay, the SELinux policy and the build
files, each with an exclusive create. Staging is not boot evidence: the
booted grants and domain are [verification](./verification.md)'s, and
whether the listener hears anything or shows its indicator is device
acceptance. The listener app itself is `spec/os/voice/listener.md`; the
assist and power activation it enables is
[provisioning](./provisioning.md)'s.

## Story: Put the wake listener in an image only as reviewed

> As a product maker, I want the wake listener staged only as my reviewed,
> same-signer build with no network and no way to hide the microphone, so
> that an always-listening app never reaches my image unreviewed.

### The listener is the launcher's sense package, signed by exactly the launcher's signer

```quint
import apk.* from "./apk"
import sourceLock as V from "./sourceLock"
type PackageName = { parent: str, leaf: str }
pure val listenerLeaf = "sense"
pure def isListenerOf(packageName: PackageName, launcherPackage: str): bool = launcherPackage != "" and packageName.parent == launcherPackage and packageName.leaf == listenerLeaf
pure def sameSigner(apkSigner: SignerObservation, launcherSigner: Digest): bool = signedBy(apkSigner, launcherSigner)
```

### The listener requests both privileged grants, the microphone and its foreground service, and nothing outside the reviewed set

The image's privileged-permission allowlist for the listener is exactly the
two privileged grants, so every allowlisted permission is requested and
Android's boot-time allowlist check cannot fail on a stale entry. The
forbidden permissions are outside the reviewed set: network, capture of
other output, exemptions from the concurrent-capture and background-audio
restrictions, audio routing and phone state.

```quint
pure val listenerPrivilegedPermissions: List[str] = List("android.permission.CAPTURE_AUDIO_HOTWORD", "android.permission.START_ACTIVITIES_FROM_BACKGROUND")
pure val listenerUnprivilegedPermissions: List[str] = List("android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.HIDE_OVERLAY_WINDOWS", "android.permission.POST_NOTIFICATIONS", "android.permission.RECORD_AUDIO")
pure val listenerRequiredPermissions: List[str] = List("android.permission.RECORD_AUDIO", "android.permission.FOREGROUND_SERVICE_MICROPHONE")
pure val listenerForbiddenPermissions: List[str] = List("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.CAPTURE_AUDIO_OUTPUT", "android.permission.CAPTURE_MEDIA_OUTPUT", "android.permission.CAPTURE_VOICE_COMMUNICATION_OUTPUT",
  "android.permission.BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION", "android.permission.EXEMPT_FROM_AUDIO_RECORD_RESTRICTIONS",
  "android.permission.RECORD_BACKGROUND_AUDIO", "android.permission.MODIFY_AUDIO_ROUTING", "android.permission.READ_PHONE_STATE")
pure def permissionsReviewed(requested: List[str]): bool =
  requested.every(p => listenerPrivilegedPermissions.includes(p) or listenerUnprivilegedPermissions.includes(p))
    and listenerPrivilegedPermissions.every(p => requested.includes(p)) and listenerRequiredPermissions.every(p => requested.includes(p))
pure val requestedValues = {
  val reviewed = listenerPrivilegedPermissions.concat(listenerRequiredPermissions)
  Set(reviewed, reviewed.append("android.permission.INTERNET"), reviewed.append("android.permission.CAMERA"), listenerRequiredPermissions,
    listenerPrivilegedPermissions.append("android.permission.RECORD_AUDIO"), reviewed.append("android.permission.POST_NOTIFICATIONS"))
}
pure def lawForbiddenPermissionNeverReviewed(requested: List[str]): bool =
  permissionsReviewed(requested) implies not(requested.some(p => listenerForbiddenPermissions.includes(p)))
```

### The listener overlay clears every indicator-exempt role, keeps the microphone toggle and the power menu, and leaves the emergency and camera gestures alone

A holder of any of the six roles Android exempts from the microphone and
camera indicator would record unseen, so the overlay sets each to empty,
and the person keeps the system microphone toggle. The shell reads each
role's value once; a role the overlay does not set is not cleared. Where
the overlay makes press-and-hold power open the assistant
(`config_longPressOnPowerBehavior` `5`), power and volume up keeps opening
the power menu (`config_keyChordPowerVolumeUp` `2`). The overlay sets none
of `config_doublePressOnPowerBehavior`,
`config_cameraDoubleTapPowerGestureEnabled`, `config_defaultAssistant`,
`config_keyChordPowerVolumeDown` or an emergency setting, so the stock
emergency, camera and assistant choices stay in force.

```quint
type RoleValue = RoleCleared | RoleHeld | RoleNotOverlaid
type RoleRow = { role: str, value: RoleValue }
type ListenerOverlay = { roles: List[RoleRow], microphoneToggle: bool, powerAssistant: bool, powerMenuChord: bool, gesturesUntouched: bool }
pure val indicatorExemptRoles: List[str] = List("config_systemAmbientAudioIntelligence", "config_systemUiIntelligence", "config_systemAudioIntelligence",
  "config_systemNotificationIntelligence", "config_systemTextIntelligence", "config_systemVisualIntelligence")
pure def overlayAdmitted(overlay: ListenerOverlay): bool =
  overlay.microphoneToggle and overlay.gesturesUntouched and (overlay.powerAssistant implies overlay.powerMenuChord) and indicatorExemptRoles.every(r => overlay.roles.some(row => row.role == r) and overlay.roles.every(row => row.role == r implies row.value == RoleCleared))
```

### Wake names are one to eight distinct well-formed words

The shell reads each name and gives `MalformedWakeName` for one that is not
a lowercase letter followed by at most 31 lowercase letters or digits.

```quint
type WakeName = WakeWord({ word: str }) | MalformedWakeName
pure def wakeNamesAdmitted(names: List[WakeName]): bool =
  names.length() >= 1 and names.length() <= 8 and names.every(n => n != MalformedWakeName and names.select(m => m == n).length() == 1)
```

### A listener is staged only from a matched source that carries the chip and ops SystemUI patches

The `ops` bundle lists the listener in the microphone indicator's ops and
the `chip` bundle adds the Listening chip and its indicator lease; each is
a patch envelope named for its bundle, admitted by the source verdict.

```quint
pure val listenerSystemuiPatches: List[str] = List("chip", "ops")
pure def sourceAdmitsListener(source: V::SourceVerdict): bool =
  source.verdict == V::Match and listenerSystemuiPatches.every(name => source.patches.some(e => e.name == name))
```

### The listener runs in its own SELinux domain, selected only for the launcher's signer

Staging writes `mac_permissions.xml` naming the consumer's public release
certificate and the listener package, a `seapp_contexts` entry selecting
the `eliza_sense_app` domain for that label on a privileged install, and
the domain's policy, which creates no network socket. The certificate
must be the admitted signer.

```quint
pure val listenerSelinuxDomain = "eliza_sense_app"
pure def policyBoundToSigner(policyCertificate: Digest, launcherSigner: Digest): bool = digestsMatch(policyCertificate, launcherSigner)
```

### A production or activated listener is a release build that matches its reviewed descriptor and packages its pinned speech bundle

The reviewed descriptor pins the listener's package, APK bytes and signer;
it is checked whenever one is given. A listener without the pinned speech
bundle could never recognise a wake name: an inert development listener
may be staged without it, and staging records that speech is not
included. The ZIP layout check (entries safe and unique, native
libraries and DEX stored and aligned) applies to every staging.

```quint
type ZipLayout = ZipAligned | ZipRefused
type ListenerSpeech = SpeechPinned | SpeechNotPinned
type ListenerApk = { packageName: PackageName, sha256: Digest, signer: SignerObservation, buildType: ApkBuildType, requested: List[str], layout: ZipLayout, speech: ListenerSpeech }
type ListenerDescriptor = NoListenerDescriptor | ListenerReviewed({ bytes: Digest, packageName: PackageName, apk: Digest, certificate: Digest })
pure def descriptorMatches(descriptor: ListenerDescriptor, listener: ListenerApk): bool = match descriptor {
  | ListenerReviewed(d) => d.packageName == listener.packageName and isDigest(d.bytes) and digestsMatch(d.apk, listener.sha256) and digestsMatch(d.certificate, signerCertificate(listener.signer))
  | _ => false
}
```

### Staging names the first problem it finds, and activates the listener only with a qualification record

```quint
type ListenerProblem = SourceNotAdmitted | NotTheLaunchersListener | SignerNotTheLaunchers | PermissionsUnreviewed | OverlayNotAdmitted | WakeNamesInvalid
  | ZipLayoutRefused | PolicyCertificateDiffers | DescriptorMismatch | NotAReleaseBuild | SpeechBundleMissing | QualificationMissing | QualificationMismatch | QualificationNotPassed
type ListenerReach = ListenerInert | ListenerActivated
type ListenerStaging = ListenerStaged({ reach: ListenerReach, speechIncluded: bool }) | ListenerRefused({ problem: ListenerProblem })
type ListenerRequest = { launcherPackage: str, launcherSigner: Digest, launcherApk: Digest, launcherDescriptor: Digest, listener: ListenerApk, descriptor: ListenerDescriptor,
  wakeNames: List[WakeName], overlay: ListenerOverlay, policyCertificate: Digest, sepolicy: Digest, sdkCommit: str, enrolledQualification: Digest, qualification: Qualification }
pure def refuse(problem: ListenerProblem): ListenerStaging = ListenerRefused({ problem: problem })
pure def listenerStaging(request: ListenerRequest, source: V::SourceVerdict, mode: StagingMode): ListenerStaging = {
  val listener = request.listener
  val production = mode == StageProduction
  val activating = request.qualification != NoQualification
  val strict = production or activating
  if (not(sourceAdmitsListener(source))) refuse(SourceNotAdmitted)
  else if (not(isListenerOf(listener.packageName, request.launcherPackage))) refuse(NotTheLaunchersListener)
  else if (not(sameSigner(listener.signer, request.launcherSigner))) refuse(SignerNotTheLaunchers)
  else if (not(permissionsReviewed(listener.requested))) refuse(PermissionsUnreviewed)
  else if (not(overlayAdmitted(request.overlay))) refuse(OverlayNotAdmitted)
  else if (not(wakeNamesAdmitted(request.wakeNames))) refuse(WakeNamesInvalid)
  else if (listener.layout != ZipAligned) refuse(ZipLayoutRefused)
  else if (not(policyBoundToSigner(request.policyCertificate, request.launcherSigner))) refuse(PolicyCertificateDiffers)
  else if ((strict or request.descriptor != NoListenerDescriptor) and not(descriptorMatches(request.descriptor, listener))) refuse(DescriptorMismatch)
  else if (strict and listener.buildType != ReleaseBuild) refuse(NotAReleaseBuild)
  else if (strict and listener.speech != SpeechPinned) refuse(SpeechBundleMissing)
  else if (production and not(activating)) refuse(QualificationMissing)
  else if (activating and not(qualificationMatches(request, source))) refuse(QualificationMismatch)
  else if (activating and not(qualificationPassed(request.qualification, production))) refuse(QualificationNotPassed)
  else ListenerStaged({ reach: if (activating) ListenerActivated else ListenerInert, speechIncluded: listener.speech == SpeechPinned })
}
pure def isStaged(staging: ListenerStaging): bool = match staging { | ListenerStaged(s) => true | _ => false }
pure def isActivated(staging: ListenerStaging): bool = match staging { | ListenerStaged(s) => s.reach == ListenerActivated | _ => false }
pure def lawStagedListenerIsTheLaunchersAndReviewed(request: ListenerRequest, source: V::SourceVerdict, mode: StagingMode): bool =
  isStaged(listenerStaging(request, source, mode)) implies (sourceAdmitsListener(source) and isListenerOf(request.listener.packageName, request.launcherPackage)
    and isDigest(request.launcherSigner) and request.listener.signer == OneSigner({ certificate: request.launcherSigner }) and permissionsReviewed(request.listener.requested)
    and overlayAdmitted(request.overlay) and wakeNamesAdmitted(request.wakeNames) and policyBoundToSigner(request.policyCertificate, request.launcherSigner))
pure def lawActivatedListenerIsAReviewedRelease(request: ListenerRequest, source: V::SourceVerdict, mode: StagingMode): bool = {
  val staging = listenerStaging(request, source, mode)
  (isActivated(staging) or (mode == StageProduction and isStaged(staging))) implies (staging == ListenerStaged({ reach: ListenerActivated, speechIncluded: true })
    and request.listener.buildType == ReleaseBuild and descriptorMatches(request.descriptor, request.listener))
}
pure def lawGivenDescriptorAlwaysMatches(request: ListenerRequest, source: V::SourceVerdict, mode: StagingMode): bool =
  (isStaged(listenerStaging(request, source, mode)) and request.descriptor != NoListenerDescriptor) implies descriptorMatches(request.descriptor, request.listener)
```

### A fully reviewed listener stages activated in both modes, and without a record only development stages it, inert

This is the request every refusal above is a variation of.

```quint
pure val chipEnvelope: V::PatchEnvelope = { name: "chip", project: "frameworks/base", revision: "r1", baseline: "lockA", files: List(), manifestSha256: "p1" }
pure val reviewedSource: V::SourceVerdict = { ...V::initial, verified: 1, verdict: V::Match, lock: { ...V::noLock, digest: "lockA" },
  patches: List(chipEnvelope, { ...chipEnvelope, name: "ops", manifestSha256: "p2" }) }
pure val reviewedInputs: QualifiedInputs = { packageName: { parent: "com.example", leaf: "sense" }, launcher: Sha256({ hex: "a1" }), listener: Sha256({ hex: "l1" }),
  launcherDescriptor: Sha256({ hex: "d1" }), listenerDescriptor: Sha256({ hex: "d2" }), certificate: Sha256({ hex: "c1" }), sourceLock: "lockA", sdkCommit: "e1",
  sepolicy: Sha256({ hex: "s1" }), patches: List({ name: "ops", manifestSha256: "p2" }, { name: "chip", manifestSha256: "p1" }) }
pure val reviewedGates: List[GateRow] = listenerGates.listMap(g => { gate: g, result: GatePassed({ evidence: Sha256({ hex: "v1" }) }) })
pure val reviewedSigner: Digest = Sha256({ hex: "c1" })
pure val reviewedListener: ListenerApk = { packageName: { parent: "com.example", leaf: "sense" }, sha256: Sha256({ hex: "l1" }), signer: OneSigner({ certificate: reviewedSigner }),
  buildType: ReleaseBuild, requested: listenerPrivilegedPermissions.concat(listenerRequiredPermissions), layout: ZipAligned, speech: SpeechPinned }
pure val reviewedRequest: ListenerRequest = { launcherPackage: "com.example", launcherSigner: reviewedSigner, launcherApk: Sha256({ hex: "a1" }), launcherDescriptor: Sha256({ hex: "d1" }),
  listener: reviewedListener, descriptor: ListenerReviewed({ bytes: Sha256({ hex: "d2" }), packageName: reviewedListener.packageName, apk: Sha256({ hex: "l1" }), certificate: reviewedSigner }),
  wakeNames: List(WakeWord({ word: "hey" })), overlay: { roles: indicatorExemptRoles.listMap(r => { role: r, value: RoleCleared }), microphoneToggle: true, powerAssistant: true,
    powerMenuChord: true, gesturesUntouched: true },
  policyCertificate: reviewedSigner, sepolicy: Sha256({ hex: "s1" }), sdkCommit: "e1", enrolledQualification: Sha256({ hex: "q1" }),
  qualification: QualificationRecord({ bytes: Sha256({ hex: "q1" }), inputs: reviewedInputs, qualified: true, gates: reviewedGates }) }
pure val sourceValues = Set(reviewedSource, { ...reviewedSource, patches: reviewedSource.patches.select(e => e.name == "chip") }, { ...reviewedSource, verdict: V::Mismatch })
pure val requestValues = {
  val r = reviewedRequest
  val unqualified = QualificationRecord({ bytes: Sha256({ hex: "q1" }), inputs: reviewedInputs, qualified: false, gates: List() })
  val otherLock = QualificationRecord({ bytes: Sha256({ hex: "q1" }), inputs: { ...reviewedInputs, sourceLock: "lockB" }, qualified: true, gates: reviewedGates })
  List(r, { ...r, qualification: NoQualification }, { ...r, qualification: NoQualification, descriptor: NoListenerDescriptor }, { ...r, qualification: unqualified }, { ...r, qualification: otherLock },
    { ...r, enrolledQualification: Sha256({ hex: "q2" }) }, { ...r, launcherSigner: Sha256({ hex: "c2" }) }, { ...r, launcherPackage: "com.other" },
    { ...r, listener: { ...r.listener, buildType: DebuggableBuild }, qualification: unqualified }, { ...r, listener: { ...r.listener, speech: SpeechNotPinned } },
    { ...r, listener: { ...r.listener, speech: SpeechNotPinned, buildType: DebuggableBuild }, qualification: NoQualification },
    { ...r, listener: { ...r.listener, requested: r.listener.requested.append("android.permission.INTERNET") } }, { ...r, overlay: { ...r.overlay, roles: List() } },
    { ...r, overlay: { ...r.overlay, powerMenuChord: false } }, { ...r, overlay: { ...r.overlay, gesturesUntouched: false } },
    { ...r, wakeNames: List() }, { ...r, policyCertificate: Sha256({ hex: "c2" }) }, { ...r, listener: { ...r.listener, layout: ZipRefused } }).foldl(Set(), (acc, x) => acc.union(Set(x)))
}
pure def lawAReviewedListenerStagesActivated(mode: StagingMode): bool = isActivated(listenerStaging(reviewedRequest, reviewedSource, mode))
pure def lawWithoutARecordOnlyDevelopmentStagesInert(mode: StagingMode): bool =
  listenerStaging({ ...reviewedRequest, qualification: NoQualification }, reviewedSource, mode)
    == (if (mode == StageDevelopment) ListenerStaged({ reach: ListenerInert, speechIncluded: true }) else refuse(QualificationMissing))
```

## Story: Activate the listener only on a qualified image

> As a product maker, I want the listener activated only from the
> qualification record my product enrolled for exactly these inputs, so
> that a record made for other bytes, another signer or another source can
> never switch on an always-listening app.

Activation writes the listener image feature and the component override
([provisioning](./provisioning.md)). The record is the consumer's; its
gates are the device checks of the consumer's qualification plan, each
passed with the digest of its evidence.

### A qualification record counts only when its bytes are the enrolled ones and it names every input of this image

The inputs are the listener package, the launcher and listener APKs, both
descriptors, the signer, the source lock, the Eliza commit the consumer
vendors (40 lowercase hex characters; the shell gives an empty string for
anything else), the staged SELinux policy and the manifest of every patch
the source verdict admitted, by name, in any order.

```quint
type PatchManifest = { name: str, manifestSha256: str }
type QualifiedInputs = { packageName: PackageName, launcher: Digest, listener: Digest, launcherDescriptor: Digest, listenerDescriptor: Digest,
  certificate: Digest, sourceLock: str, sdkCommit: str, sepolicy: Digest, patches: List[PatchManifest] }
type GateResult = GatePassed({ evidence: Digest }) | GateNotPassed
type GateRow = { gate: str, result: GateResult }
type Qualification = NoQualification | QualificationRecord({ bytes: Digest, inputs: QualifiedInputs, qualified: bool, gates: List[GateRow] })
pure def descriptorBytes(descriptor: ListenerDescriptor): Digest = match descriptor { | ListenerReviewed(d) => d.bytes | _ => NotADigest }
pure def sourcePatches(source: V::SourceVerdict): List[PatchManifest] = source.patches.listMap(e => { name: e.name, manifestSha256: e.manifestSha256 })
pure def inputsMatch(inputs: QualifiedInputs, request: ListenerRequest, source: V::SourceVerdict): bool = {
  val patches = sourcePatches(source)
  inputs.packageName == request.listener.packageName and digestsMatch(inputs.launcher, request.launcherApk) and digestsMatch(inputs.listener, request.listener.sha256)
    and digestsMatch(inputs.launcherDescriptor, request.launcherDescriptor) and digestsMatch(inputs.listenerDescriptor, descriptorBytes(request.descriptor))
    and digestsMatch(inputs.certificate, request.launcherSigner) and inputs.sourceLock != "" and inputs.sourceLock == source.lock.digest
    and request.sdkCommit != "" and inputs.sdkCommit == request.sdkCommit and digestsMatch(inputs.sepolicy, request.sepolicy)
    and inputs.patches.length() == patches.length() and patches.every(p => inputs.patches.includes(p))
}
pure def qualificationMatches(request: ListenerRequest, source: V::SourceVerdict): bool = {
  val qualification = request.qualification
  match qualification { | QualificationRecord(r) => digestsMatch(r.bytes, request.enrolledQualification) and inputsMatch(r.inputs, request, source) | _ => false }
}
pure def lawActivatedOnlyFromTheEnrolledRecordForTheseInputs(request: ListenerRequest, source: V::SourceVerdict, mode: StagingMode): bool =
  isActivated(listenerStaging(request, source, mode)) implies (qualificationMatches(request, source) and isDigest(request.enrolledQualification))
```

### A record that claims qualification, and every production activation, needs every gate passed with an evidence digest

```quint
pure val listenerGates: List[str] = List("G1", "G2", "G3", "G4", "G5", "G6", "G7")
pure def evidenced(result: GateResult): bool = match result { | GatePassed(g) => isDigest(g.evidence) | _ => false }
pure def gatePassed(gates: List[GateRow], gate: str): bool = gates.some(row => row.gate == gate and evidenced(row.result))
pure def qualificationPassed(qualification: Qualification, production: bool): bool = match qualification {
  | QualificationRecord(r) => (production implies r.qualified) and (r.qualified implies listenerGates.every(g => gatePassed(r.gates, g)))
  | _ => false
}
pure def lawProductionActivationPassedEveryGate(request: ListenerRequest, source: V::SourceVerdict): bool = {
  val staged = isStaged(listenerStaging(request, source, StageProduction))
  val qualification = request.qualification
  match qualification { | QualificationRecord(r) => staged implies (r.qualified and listenerGates.every(g => gatePassed(r.gates, g))) | _ => not(staged) }
}
```
