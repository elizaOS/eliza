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
AOSP and SMS contributions. Lean chat drops desktop execution surfaces.
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
type CapabilityClass = BootstrapSql | SchedulingCore | BrowserCore | NativeFilesystemCore | DesktopExecution | ProfileView | WorkflowPlugin | FullAssistant | SelectiveReminder | CalendarOwner | GoalOwner | MobileProvider | GoogleWorkspace | UnbundledPlugin
pure def hostProfile(android: bool, ios: bool, leanRequested: bool): ConsumerProfile =
  if (android) NativeAndroid else if (ios) NativeIos else if (leanRequested) HostLean else HostFull
pure def nativeProfile(profile: ConsumerProfile): bool = profile == NativeAndroid or profile == NativeIos
pure def workflowSelected(profile: ConsumerProfile, candidate: bool, workflowOff: bool, mobileOptIn: bool, leanOptIn: bool): bool =
  candidate and not(workflowOff) and
  (if (profile == NativeAndroid) mobileOptIn else if (profile == NativeIos) false else if (profile == HostLean) leanOptIn else true)
pure def bundleAllows(profile: ConsumerProfile, capability: CapabilityClass): bool =
  if (nativeProfile(profile)) capability != DesktopExecution and capability != GoogleWorkspace and capability != UnbundledPlugin
  else if (profile == HostLean) capability != DesktopExecution and capability != BrowserCore and capability != FullAssistant
  else true
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
pure def lawMobileHasNoUnbundledPlugins(profile: ConsumerProfile): bool =
  nativeProfile(profile) implies not(bundleAllows(profile, UnbundledPlugin))
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
