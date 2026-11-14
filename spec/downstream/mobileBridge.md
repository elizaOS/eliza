# Android bridge composition and authority

Grace's `apps/app/native/android/host.json` and Alpha's
`android/consumer-host.json` both consume Eliza's Android host generator
at `packages/app/scripts/mobile/android/consumer-host.mjs`. Explicit
registration is in each consumer's `MainActivity.java`. The build emits
settings, variants, source sets and Gradle wiring from the consumer
identity and modules. Alpha independently selects `upstream`,
`patchedNative`, `consumer` and `dependencies` roots and rejects
unadmitted native patch staging before Gradle assembles its modules.

| Shared boundary | Grace consumer | Alpha consumer |
| --- | --- | --- |
| System, camera, browser | SystemPlugin, CameraPlugin, ElizaSurfaceManagerPlugin used by owned Chromium guidance | AlphaSystemPlugin, Eliza CameraPlugin, AlphaBrowserPlugin |
| Contacts, calendar, photos | DeviceContactsPlugin, DeviceCalendarPlugin, DevicePhotosPlugin | AlphaContactsPlugin, AlphaCalendarPlugin, AlphaPhotosPlugin and AlphaPhotoLibraryPlugin |
| Files, location, communications | DeviceWifiPlugin, DeviceAppsPlugin, NewMailPlugin, CallStatePlugin | Eliza LocationPlugin, AlphaFilesPlugin, native messages/phone, networks, action journal |
| Device and notification actions | DevicePreferencesPlugin, DeviceSetupPlugin, SoftwareUpdatesPlugin | AlphaNotificationsPlugin, AlphaDevicePlugin, alarm/reminders, action journal |
| Credentials and voice | DeviceSpeechPlugin, local runtime credential broker, password feature flag | AlphaVoiceCloudPlugin, streaming, local speech, secure store, passwords and optional PasswordTransferPlugin |

The table describes consumers and compiled modules. Per-method data
schemas and lifecycles belong to individual bridge owners. Their
interaction with web views, private native stores, Android permission
brokers and system roles is an Effect port validated at its entry.

## Story: Invoke only a bridge available for this consumer and device

### Build inclusion, registration and per-operation permission are separate evidence

A staged module does not itself establish that an Activity registers a
bridge. Grace password registration depends on its build switch. Alpha
telephony registration depends on the image capability check.
Alpha's optional password-transfer registration depends on the class
being present and the development test-mock build gate. Alpha checks
its native image capability again for every telephony operation. These
are registration and operation criteria. An operation that separately needs a device
permission is refused until the Android broker supplies that permission.
A renderer string or an unchecked WebView route cannot attest either.

```quint
type Consumer = Grace | Alpha
type Feature = SystemBridge | CameraBridge | BrowserBridge | ContactsBridge | CalendarBridge | MediaBridge | VoiceBridge | PasswordBridge | TransferBridge | TelephonyBridge
type Installation = { product: Consumer, feature: Feature, built: bool, activityRegistered: bool, passwordsEnabled: bool, transferClassPresent: bool, developmentMocks: bool, imageVerified: bool }
type Admission = BridgeReady | BridgeUnavailable | PermissionRequired | OwnerRetired
pure def eligibleRegistration(binding: Installation): bool =
  if (binding.feature == TelephonyBridge) binding.product == Alpha and binding.imageVerified
  else if (binding.feature == TransferBridge) binding.product == Alpha and binding.developmentMocks and binding.transferClassPresent
  else if (binding.feature == PasswordBridge and binding.product == Grace) binding.passwordsEnabled
  else true
pure def bridgeAdmission(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): Admission =
  if (not(ownerLive)) OwnerRetired
  else if (not(binding.built) or not(binding.activityRegistered) or not(eligibleRegistration(binding))) BridgeUnavailable
  else if (needsPermission and not(permissionGranted)) PermissionRequired
  else BridgeReady
pure val bindingValues = Set(
  { product: Grace, feature: SystemBridge, built: true, activityRegistered: true, passwordsEnabled: false, transferClassPresent: false, developmentMocks: false, imageVerified: false },
  { product: Grace, feature: PasswordBridge, built: true, activityRegistered: true, passwordsEnabled: false, transferClassPresent: false, developmentMocks: false, imageVerified: false },
  { product: Alpha, feature: TelephonyBridge, built: true, activityRegistered: true, passwordsEnabled: true, transferClassPresent: false, developmentMocks: false, imageVerified: false },
  { product: Alpha, feature: TelephonyBridge, built: true, activityRegistered: true, passwordsEnabled: true, transferClassPresent: false, developmentMocks: false, imageVerified: true },
  { product: Alpha, feature: TransferBridge, built: true, activityRegistered: true, passwordsEnabled: true, transferClassPresent: true, developmentMocks: true, imageVerified: true }
)
pure def lawReadyNeedsEvidence(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  bridgeAdmission(binding, ownerLive, needsPermission, permissionGranted) == BridgeReady implies
    binding.built and binding.activityRegistered and eligibleRegistration(binding) and ownerLive and
    (not(needsPermission) or permissionGranted)
pure def lawAlphaTelephonyNeedsVerifiedImage(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  binding.feature == TelephonyBridge and bridgeAdmission(binding, ownerLive, needsPermission, permissionGranted) == BridgeReady implies
    binding.product == Alpha and binding.imageVerified
pure def lawGracePasswordsNeedReleaseSwitch(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  binding.product == Grace and binding.feature == PasswordBridge and bridgeAdmission(binding, ownerLive, needsPermission, permissionGranted) == BridgeReady implies binding.passwordsEnabled
```

## Story: Produce the Android host from authenticated source inputs

### Generation writes only under an admitted consumer output root

The upstream generator requires a consumer-owned output directory
outside the upstream source. It checks real paths for declared source
containment, refuses symlink output ancestors and preserves authored
inputs in an in-place output. The consumer supplies application identity,
SDK ordering, native modules, source references, flavors and signing
configuration. The generator checks the identity and version shape,
requires explicit release minification, and rejects duplicate module or
output names. The model starts after these configuration types have
been decoded. The filesystem port must perform the canonical-path and
output-ownership checks before it writes.

```quint
type BuildInput = {
  schema: int, minimumSdk: int, targetSdk: int, compileSdk: int,
  versionCode: int, identityValid: bool, releasePolicyExplicit: bool,
  insideConsumer: bool, distinctOutput: bool, outsideUpstream: bool,
  noSymlinkAncestors: bool, resolvedInputsOwned: bool, uniqueModuleAndFileNames: bool,
  overwriteOwned: bool
}
pure def admitsAndroidHost(input: BuildInput): bool =
  input.schema == 1 and input.minimumSdk > 0 and input.minimumSdk <= input.targetSdk and
  input.targetSdk <= input.compileSdk and input.versionCode > 0 and input.versionCode <= 2100000000 and
  input.identityValid and input.releasePolicyExplicit and input.insideConsumer and input.distinctOutput and
  input.outsideUpstream and input.noSymlinkAncestors and input.resolvedInputsOwned and
  input.uniqueModuleAndFileNames and input.overwriteOwned
pure val inputValues = Set(
  {schema: 1, minimumSdk: 29, targetSdk: 36, compileSdk: 36, versionCode: 1, identityValid: true, releasePolicyExplicit: true,
    insideConsumer: true, distinctOutput: true, outsideUpstream: true, noSymlinkAncestors: true, resolvedInputsOwned: true, uniqueModuleAndFileNames: true, overwriteOwned: true},
  {schema: 1, minimumSdk: 36, targetSdk: 29, compileSdk: 36, versionCode: 1, identityValid: true, releasePolicyExplicit: true,
    insideConsumer: true, distinctOutput: true, outsideUpstream: true, noSymlinkAncestors: true, resolvedInputsOwned: false, uniqueModuleAndFileNames: true, overwriteOwned: true}
)
pure def lawHostOutputStaysOwned(input: BuildInput): bool =
  admitsAndroidHost(input) implies input.insideConsumer and input.outsideUpstream and input.distinctOutput and
  input.noSymlinkAncestors and input.resolvedInputsOwned and input.overwriteOwned
pure def lawHostKeepsSdkOrder(input: BuildInput): bool =
  admitsAndroidHost(input) implies input.minimumSdk > 0 and input.minimumSdk <= input.targetSdk and input.targetSdk <= input.compileSdk
```

### A staged resident tree is activated only with its provenance receipt

Alpha verifies the authenticated runtime source pin before staging.
The producer accepts distinct reviewed classes including
`ElizaAgentService`, and checks the dependency closure of optional
helpers. It writes classes and records input and rewritten output
digests. The consumer publishes the staged files and manifest
together by replacing the directory under its serialized Gradle
producer. A failed new publication restores the prior tree if
possible. Failed restoration leaves the prior tree in quarantine at
the transaction path, with no success receipt. The state below
projects one attempt over an optional previous tree.

```quint
type StagePhase = NoStage | StageVerified | NewTreePublished | PriorTreeRestored | PriorTreeRetained | StageFailed
type StageEvidence = { checkoutPinMatches: bool, classInventoryAllowed: bool, helperClosureComplete: bool, anchorCountsMatch: bool, receiptMatchesBytes: bool }
type StagePublication = StagePublicationSucceeded | StagePublicationFailed | StageRestoreFailed
type StageTransaction = { phase: StagePhase, priorTree: bool, newTreeLive: bool, priorPreserved: bool }
pure val initial: StageTransaction = { phase: NoStage, priorTree: false, newTreeLive: false, priorPreserved: false }
pure def canPrepareStage(s: StageTransaction, sourceProof: StageEvidence): bool =
  s.phase == NoStage and sourceProof.checkoutPinMatches and sourceProof.classInventoryAllowed and
  sourceProof.helperClosureComplete and sourceProof.anchorCountsMatch and sourceProof.receiptMatchesBytes
pure def prepareStage(s: StageTransaction, sourceProof: StageEvidence, priorTree: bool): StageTransaction =
  { ...s, phase: StageVerified, priorTree: priorTree }
pure def canPublishStage(s: StageTransaction): bool = s.phase == StageVerified
pure def publishStage(s: StageTransaction, publication: StagePublication): StageTransaction =
  if (publication == StagePublicationSucceeded) { ...s, phase: NewTreePublished, newTreeLive: true }
  else if (not(s.priorTree)) { ...s, phase: StageFailed }
  else { ...s, phase: if (publication == StageRestoreFailed) PriorTreeRetained else PriorTreeRestored, priorPreserved: true }
pure val sourceProofValues = Set(
  {checkoutPinMatches: true, classInventoryAllowed: true, helperClosureComplete: true, anchorCountsMatch: true, receiptMatchesBytes: true},
  {checkoutPinMatches: false, classInventoryAllowed: true, helperClosureComplete: true, anchorCountsMatch: true, receiptMatchesBytes: true},
  {checkoutPinMatches: true, classInventoryAllowed: true, helperClosureComplete: false, anchorCountsMatch: true, receiptMatchesBytes: true}
)
pure def alwaysStagePublicationCustody(s: StageTransaction): bool =
  s.newTreeLive == (s.phase == NewTreePublished) and
  s.priorPreserved == (s.phase == PriorTreeRestored or s.phase == PriorTreeRetained) and
  (s.priorPreserved implies s.priorTree)
pure def stepNewTreeRequiresVerifiedStage(before: StageTransaction, after: StageTransaction): bool =
  after.newTreeLive and not(before.newTreeLive) implies before.phase == StageVerified
pure def sometimesStagedTreePublished(s: StageTransaction): bool = s.phase == NewTreePublished
pure def sometimesRestoreFailurePreservesPrior(s: StageTransaction): bool = s.phase == PriorTreeRetained
```
