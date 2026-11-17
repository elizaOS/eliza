# Android bridge composition and authority

Each consumer describes its Android host in a consumer-owned host
descriptor and generates it with Eliza's
[Android host generator](../build/consumerHost.md). Explicit registration is
in each consumer's `MainActivity.java`. The build emits
settings, variants, source sets and Gradle wiring from the consumer
identity and modules. The generator resolves a module only under the
upstream, consumer or dependency root; a consumer that patches native
modules stages them inside its own checkout first and names the staged
copy under its consumer root, as the last story says.

| Shared boundary | Producer modules a consumer may register |
| --- | --- |
| System, camera, browser | the system plugin, `CameraPlugin`, the browser surface or tab host |
| Contacts, calendar, photos | the contacts, calendar and media plugins |
| Files, location, communications | the filesystem, location, Wi-Fi, messages and phone plugins, the action journal |
| Device and notification actions | the notifications, reminders and system plugins |
| Credentials and voice | the speech and voice plugins, the secure store, passwords |

The table describes the producer modules; which of them a consumer
compiles is its own declaration. Per-method data schemas and lifecycles
belong to individual bridge owners. Their interaction with web views,
private native stores, Android permission brokers and system roles is an
Effect port validated at its entry.

## Story: Invoke only a bridge available for this consumer and device

> As a consumer, I want a native bridge invoked only when this consumer
> built it in, registered it and the device permits the operation.

### Build inclusion, registration and per-operation permission are separate evidence

A staged module does not itself establish that an Activity registers a
bridge. Each consumer's descriptor declares whether it registers the
password and telephony bridges; an undeclared one is unavailable.
Telephony also needs the image capability check, which is repeated for
every telephony operation. These are
registration and operation criteria. An operation that separately needs a
device permission is refused until the Android broker supplies that
permission. A renderer string or an unchecked WebView route cannot attest
either.

```quint
type Feature = SystemBridge | CameraBridge | BrowserBridge | ContactsBridge | CalendarBridge | MediaBridge | VoiceBridge | PasswordBridge | TelephonyBridge
type ConsumerBridges = { declaresTelephony: bool, declaresPasswords: bool }
type Installation = { consumer: ConsumerBridges, feature: Feature, built: bool, activityRegistered: bool, imageVerified: bool }
type Admission = BridgeReady | BridgeUnavailable | PermissionRequired | OwnerRetired
pure def eligibleRegistration(binding: Installation): bool =
  if (binding.feature == TelephonyBridge) binding.consumer.declaresTelephony and binding.imageVerified
  else if (binding.feature == PasswordBridge) binding.consumer.declaresPasswords
  else true
pure def bridgeAdmission(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): Admission =
  if (not(ownerLive)) OwnerRetired
  else if (not(binding.built) or not(binding.activityRegistered) or not(eligibleRegistration(binding))) BridgeUnavailable
  else if (needsPermission and not(permissionGranted)) PermissionRequired
  else BridgeReady
pure val passwordConsumer: ConsumerBridges = { declaresTelephony: false, declaresPasswords: true }
pure val telephonyConsumer: ConsumerBridges = { declaresTelephony: true, declaresPasswords: false }
pure val systemBinding: Installation = { consumer: passwordConsumer, feature: SystemBridge, built: true, activityRegistered: true, imageVerified: false }
pure val bindingValues = Set(systemBinding, { ...systemBinding, feature: PasswordBridge }, { ...systemBinding, consumer: telephonyConsumer, feature: PasswordBridge },
  { ...systemBinding, feature: TelephonyBridge, imageVerified: true },
  { ...systemBinding, consumer: telephonyConsumer, feature: TelephonyBridge },
  { ...systemBinding, consumer: telephonyConsumer, feature: TelephonyBridge, imageVerified: true },
  { ...systemBinding, activityRegistered: false })
pure def lawTelephonyNeedsDeclarationAndVerifiedImage(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  binding.feature == TelephonyBridge and bridgeAdmission(binding, ownerLive, needsPermission, permissionGranted) == BridgeReady implies
    binding.consumer.declaresTelephony and binding.imageVerified
pure def lawPasswordsNeedDeclaration(binding: Installation, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  binding.feature == PasswordBridge and bridgeAdmission(binding, ownerLive, needsPermission, permissionGranted) == BridgeReady implies
    binding.consumer.declaresPasswords
```

## Story: Activate a staged resident tree only with its provenance

> As a consumer, I want the resident tree my Android host runs to be the
> one whose source identity was checked, so that a failed publication never
> leaves an unverified tree live. Host generation itself is
> [consumer host](../build/consumerHost.md).

### A staged resident tree is activated only with its provenance receipt

A consumer that stages the resident tree verifies the authenticated
runtime source pin before staging.
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

## Story: Keep the host renderer's WebView safe through the Activity's life

> As a consumer, I want my host Activity to inherit one WebView lifecycle,
> so a renderer that Android ends never takes the app down, a stopped
> screen never runs as visible, and a page below the host shows through.

### The host Activity never loads mixed content, recreates itself after its renderer dies, and pauses its page while stopped

A consumer's main Activity extends the shared host Activity and registers
its plugins before calling the base `onCreate`; a plugin registered later
is not part of that bridge, so it is never ready to invoke. The host WebView never loads mixed content.
When Android ends the host renderer, the Activity removes and destroys the
dead WebView instead of letting the whole process die, and recreates
itself when it is next started, at once if it is on screen. After that it
never uses the dead WebView: a subclass checks `isRendererGone()` before
it reaches the WebView through `getBridge().getWebView()`. Stopping the
Activity pauses the host page, so a screen turned off never leaves it
running as visible, and starting it resumes the page; a permission dialog
over a visible app does not. A surface below the host shows only when the
host WebView and every view up to the content are transparent, which the
consumer sets: one opaque view on the way hides it.

```quint
type ActivityHook = HookCreate | HookStart | HookStop | HookRendererGone
type HostWebView = { rendererGone: bool, started: bool }
type HookAction = { blocksMixedContent: bool, recreate: bool, resumePage: bool, pausePage: bool, destroyDeadView: bool, usesView: bool }
pure val noAction: HookAction = { blocksMixedContent: false, recreate: false, resumePage: false, pausePage: false, destroyDeadView: false, usesView: false }
pure def onHook(view: HostWebView, hook: ActivityHook): HookAction =
  if (hook == HookRendererGone) { ...noAction, destroyDeadView: true, recreate: view.started }
  else if (view.rendererGone) { ...noAction, recreate: hook == HookStart }
  else if (hook == HookCreate) { ...noAction, blocksMixedContent: true, usesView: true }
  else if (hook == HookStart) { ...noAction, resumePage: true, usesView: true }
  else { ...noAction, pausePage: true, usesView: true }
pure def pluginInBridge(registeredBeforeBaseCreate: bool): bool = registeredBeforeBaseCreate
pure def belowHostShows(hostTransparent: bool, ancestors: List[bool]): bool = hostTransparent and ancestors.every(t => t)
pure def lawDeadViewIsNeverUsed(view: HostWebView, hook: ActivityHook): bool =
  view.rendererGone or hook == HookRendererGone implies not(onHook(view, hook).usesView)
pure def lawRendererDeathRecreatesTheActivity(view: HostWebView): bool =
  onHook(view, HookRendererGone).destroyDeadView and onHook(view, HookRendererGone).recreate == view.started and
  (view.rendererGone implies onHook(view, HookStart).recreate)
pure def lawStoppedPageIsPaused(view: HostWebView): bool =
  not(view.rendererGone) implies onHook(view, HookStop).pausePage and onHook(view, HookStart).resumePage and onHook(view, HookCreate).blocksMixedContent
pure def lawLateRegistrationIsNeverReady(binding: Installation, registeredBeforeBaseCreate: bool, ownerLive: bool, needsPermission: bool, permissionGranted: bool): bool =
  bridgeAdmission({ ...binding, activityRegistered: pluginInBridge(registeredBeforeBaseCreate) }, ownerLive, needsPermission, permissionGranted) == BridgeReady implies
    registeredBeforeBaseCreate
pure def lawOneOpaqueViewHidesTheSurfaceBelow(hostTransparent: bool, ancestors: List[bool]): bool =
  not(belowHostShows(hostTransparent, ancestors.append(false))) and not(belowHostShows(false, ancestors)) and
  belowHostShows(hostTransparent, ancestors.append(true)) == belowHostShows(hostTransparent, ancestors)
pure val ancestorsValues = Set(List(), List(true), List(true, false), List(false, true))
pure val viewValues = Set({ rendererGone: false, started: true }, { rendererGone: false, started: false }, { rendererGone: true, started: true }, { rendererGone: true, started: false })
```

## Story: Hand the generator only patched native sources staged from the pinned commit

> As a consumer that carries native patches, I want them built only from
> the reviewed bytes of the commit I pinned, so an unreviewed patch never
> reaches my Android host.

### A patched native module reaches the generator only as a staged copy under the consumer root

The host descriptor may mark a module as patched native. The consumer
stages those modules before generation: only inside its own checkout,
only for a manifest whose schema it knows and whose base commit is the
pinned one, only for admitted native modules, and only when every staged
byte and file mode matches the reviewed manifest with no symbolic link or
other non-regular file. It then names the staged copy under its consumer
root. A staging that fails any of these is refused, and a descriptor that
still names a patched native root is refused by the generator, so nothing
unstaged is ever built.

```quint
type PatchStaging = { insideCheckout: bool, schemaKnown: bool, pinMatches: bool, modulesAdmitted: bool, bytesMatchManifest: bool, modesMatch: bool, regularFilesOnly: bool }
type DescriptorRoot = UpstreamSource | ConsumerSource | DependencySource | PatchedNativeSource
pure def patchStaged(stage: PatchStaging): bool =
  stage.insideCheckout and stage.schemaKnown and stage.pinMatches and stage.modulesAdmitted and stage.bytesMatchManifest and stage.modesMatch and stage.regularFilesOnly
pure def generatorAccepts(root: DescriptorRoot): bool = root != PatchedNativeSource
pure def patchedReference(stage: PatchStaging): DescriptorRoot = if (patchStaged(stage)) ConsumerSource else PatchedNativeSource
pure def lawPatchedRootNeverReachesTheGenerator(stage: PatchStaging): bool =
  generatorAccepts(patchedReference(stage)) implies patchStaged(stage)
pure def lawStagingNeedsThePinnedReviewedBytes(stage: PatchStaging): bool =
  patchStaged(stage) implies stage.insideCheckout and stage.pinMatches and stage.bytesMatchManifest and stage.modesMatch
pure val stagedPatch: PatchStaging = { insideCheckout: true, schemaKnown: true, pinMatches: true, modulesAdmitted: true, bytesMatchManifest: true, modesMatch: true, regularFilesOnly: true }
pure val stageValues = Set(stagedPatch, { ...stagedPatch, insideCheckout: false }, { ...stagedPatch, pinMatches: false }, { ...stagedPatch, modulesAdmitted: false },
  { ...stagedPatch, bytesMatchManifest: false }, { ...stagedPatch, regularFilesOnly: false })
```
