# Consumer plugin profile and host composition

AlphaPhone's `scripts/start-local-remote.ts` selects lean chat with
workflow opt-in. The Android resident stages the native agent profile
and enables mobile workflows only after [worker admission](./workflowWorker.md).
Grace's native host selects its explicit runtime policies and separately
compiles task helpers. The pinned producers are
`packages/agent/src/runtime/core-plugins.ts`, `plugin-collector.ts`,
and `assistant-plugins.ts`. The [core plugin registry](../core/plugins.md)
owns initialization and shutdown after the host has selected its inputs.

## Story: Boot with the consumer's admitted capabilities

### A candidate survives profile, dependency and composition rules

Android and iOS select a mobile profile even if the lean flag is set.
Lean chat only applies outside mobile. Ordinary mobile seeds SQL, native
files, browser, vision, scheduling, assistant/reminders, and goals, with
separately selected view plugins. Provider admission also depends on
routing, credentials and local or Cloud authority. The producer reapplies
provider precedence after all additive registrations. A provisioned
credential alone cannot establish Cloud inference ownership. The active
inference topology and a usable credential or managed container are
required before displacing direct providers. The dev authority route adds
its own affirmative policy. [Resident inference](./residentCloud.md) and
[product chat configuration](./chatHost.md) own live inference selection.

Workflow's explicit off switch survives both profiles. Android needs the
mobile opt-in, while lean chat uses the lean opt-in. The launcher
supplies mobile opt-in only for an admitted installation. Mobile retains
only statically available named classes plus gated mobile workflow, views,
AOSP and SMS contributions. The Wi-Fi, Contacts and remote-target runtime
plugins require the AOSP runtime gate, Android with `ELIZA_LOCAL_LLAMA=1`.
The Phone plugin can also enter through the Android SMS draft flag, which
the launcher sets only for a verified image. The collector excludes AOSP
terminal contributions when `ELIZA_BUILD_VARIANT=store`. The launcher's
`ELIZA_DISTRIBUTION_PROFILE` controls a separate policy.

Lean chat drops desktop execution surfaces. The collected
`@elizaos/plugin-local-inference` package is dropped by default. Its final
gate re-adds it after configured disables only when local embeddings are
opted in and Cloud embeddings have no explicit true setting. Mobile does
not collect that package through its static model-provider list. The
separate local inference handler and actual embedding readiness are
owned by the runtime model-provider path.

This model projects named capability classes from the pinned lists.
The effect shell resolves actual package names, availability and denial
aliases before startup.

If the full personal assistant survives selection, it owns Calendar,
Goals and the selective reminder surface. A separate registry instance
cannot compete for those handlers. Calendar adds the scheduler after
the first explicit-disable sweep. Selective reminders also add scheduler,
reminders and goals when enabled. Standalone Google Workspace requires a
distinct Google signal and remains outside the mobile projection. Grace
disables the full package and keeps its separately staged helpers. The
required chat message service cannot be denied. An attempted denial is
a typed startup failure.

```quint
type ConsumerProfile = NativeAndroid | NativeIos | HostLean | HostFull
type CapabilityClass = BootstrapSql | SchedulingCore | BrowserCore | NativeFilesystemCore | DesktopExecution | ProfileView | WorkflowPlugin | FullAssistant | SelectiveReminder | CalendarOwner | GoalOwner | MobileProvider | GoogleWorkspace | LocalInferencePlugin | AndroidPhonePlugin | AospSurface | AospTerminal | UnbundledPlugin
pure def hostProfile(android: bool, ios: bool, leanRequested: bool): ConsumerProfile =
  if (android) NativeAndroid else if (ios) NativeIos else if (leanRequested) HostLean else HostFull
pure def nativeProfile(profile: ConsumerProfile): bool = profile == NativeAndroid or profile == NativeIos
pure def workflowSelected(profile: ConsumerProfile, candidate: bool, workflowOff: bool, mobileOptIn: bool, leanOptIn: bool): bool =
  candidate and not(workflowOff) and
  (if (profile == NativeAndroid) mobileOptIn else if (profile == NativeIos) false else if (profile == HostLean) leanOptIn else true)
type ProfileGates = { aosp: bool, smsDraft: bool, store: bool, leanLocalEmbeddings: bool, cloudEmbeddingsPinned: bool }
pure def mobileBundleAllows(profile: ConsumerProfile, capability: CapabilityClass, gates: ProfileGates): bool =
  if (capability == AndroidPhonePlugin) profile == NativeAndroid and (gates.aosp or gates.smsDraft)
  else if (capability == AospSurface or capability == AospTerminal) profile == NativeAndroid and gates.aosp
  else capability != DesktopExecution and capability != GoogleWorkspace and capability != LocalInferencePlugin and capability != UnbundledPlugin
pure def collectedCandidate(profile: ConsumerProfile, capability: CapabilityClass, gates: ProfileGates, selected: bool): bool =
  if (profile == HostLean and capability == LocalInferencePlugin) gates.leanLocalEmbeddings and not(gates.cloudEmbeddingsPinned)
  else if (capability == AospTerminal and gates.store) false
  else selected and
    (if (nativeProfile(profile)) mobileBundleAllows(profile, capability, gates)
     else if (profile == HostLean) capability != DesktopExecution and capability != AospTerminal and capability != BrowserCore and capability != FullAssistant
     else true)
pure val defaultGates: ProfileGates = { aosp: false, smsDraft: false, store: false, leanLocalEmbeddings: false, cloudEmbeddingsPinned: false }
pure val gatesValues = Set(defaultGates, { ...defaultGates, aosp: true }, { ...defaultGates, smsDraft: true },
  { ...defaultGates, aosp: true, store: true }, { ...defaultGates, leanLocalEmbeddings: true },
  { ...defaultGates, leanLocalEmbeddings: true, cloudEmbeddingsPinned: true })
pure def survivesComposition(capability: CapabilityClass, fullPresent: bool): bool =
  not(fullPresent and (capability == SelectiveReminder or capability == CalendarOwner or capability == GoalOwner))
pure def addScheduler(candidate: bool, calendarPresent: bool, reminderPresent: bool, schedulerExplicitOff: bool): bool =
  candidate or calendarPresent or (reminderPresent and not(schedulerExplicitOff))
pure def cloudInferenceOwnsProvider(topologyUsesCloud: bool, usableKey: bool, managedContainer: bool): bool =
  topologyUsesCloud and (usableKey or managedContainer)
pure def chatCompositionAdmitted(hasAssistant: bool, assistantDenied: bool, configDecoded: bool): bool =
  hasAssistant and not(assistantDenied) and configDecoded
pure def lawNativeProfileWins(android: bool, ios: bool, leanRequested: bool): bool =
  (android or ios) implies nativeProfile(hostProfile(android, ios, leanRequested))
pure def lawMobileHasNoUnbundledPlugins(profile: ConsumerProfile, gates: ProfileGates, selected: bool): bool =
  nativeProfile(profile) implies not(collectedCandidate(profile, UnbundledPlugin, gates, selected))
pure def lawOrdinaryMobileCannotCollectAospSurfaces(profile: ConsumerProfile, gates: ProfileGates, selected: bool): bool =
  (nativeProfile(profile) and not(profile == NativeAndroid and gates.aosp)) implies
    not(collectedCandidate(profile, AospSurface, gates, selected) or collectedCandidate(profile, AospTerminal, gates, selected))
pure def lawMobilePhoneNeedsAospOrSms(profile: ConsumerProfile, gates: ProfileGates, selected: bool): bool =
  (nativeProfile(profile) and collectedCandidate(profile, AndroidPhonePlugin, gates, selected)) implies
    profile == NativeAndroid and (gates.aosp or gates.smsDraft)
pure def lawStoreRejectsAospTerminal(profile: ConsumerProfile, gates: ProfileGates, selected: bool): bool =
  gates.store implies not(collectedCandidate(profile, AospTerminal, gates, selected))
pure def lawLeanLocalEmbeddingGateWins(gates: ProfileGates, selected: bool): bool =
  collectedCandidate(HostLean, LocalInferencePlugin, gates, selected) ==
    (gates.leanLocalEmbeddings and not(gates.cloudEmbeddingsPinned))
pure def lawWorkflowOffWins(profile: ConsumerProfile, candidate: bool, mobileOptIn: bool, leanOptIn: bool): bool =
  not(workflowSelected(profile, candidate, true, mobileOptIn, leanOptIn))
pure def lawCalendarRequiresScheduler(candidate: bool, reminderPresent: bool, schedulerExplicitOff: bool): bool =
  addScheduler(candidate, true, reminderPresent, schedulerExplicitOff)
pure def lawAssistantOwnsSelectiveReminder(fullPresent: bool): bool =
  fullPresent implies not(survivesComposition(SelectiveReminder, fullPresent))
pure def lawCloudCannotDisplaceProviderWithoutRouting(usableKey: bool, managedContainer: bool): bool =
  not(cloudInferenceOwnsProvider(false, usableKey, managedContainer))
pure def lawRequiredAssistantDeniedIsRefusal(hasAssistant: bool, configDecoded: bool): bool =
  not(chatCompositionAdmitted(hasAssistant, true, configDecoded))
```
