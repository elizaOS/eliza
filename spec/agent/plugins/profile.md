# Plugin profile

A host boots with a profile: the plugin capability classes a deployment
admits, and the plugins it denies by name. A consumer build may also ship a
plugin policy that names the only plugins to load, and an on-device agent
selects a runtime profile that binds its inference to the owner's cloud
account. The
[kernel's plugin registry](../../core/plugins.md) owns initialization and
shutdown once the host has chosen its inputs; provider admission is in
[model providers](./modelProviders.md). Action name ownership and the role
check are [action planning](../../core/actionPlanning.md)'s, and the host
allowlist is the [chat gateway](../conversation/chatGateway.md)'s.

## Story: Boot with the admitted plugin profile

> As the owner of a branded deployment, my agent boots with exactly the
> plugins my profile admits, on the phone, on the device image and on a
> lean server.

### A mobile platform selects its mobile profile even when a lean host was asked for

```quint
type HostProfile = MobileAndroid | MobileIos | LeanHost | FullHost
type CapabilityClass = MessageCore | BootstrapSql | SchedulingCore | BrowserCore | FilesystemCore | ProfileView | WorkflowPlugin | FullAssistant | SelectiveReminder | CalendarOwner | GoalOwner | MobileProvider | UnbundledPlugin
pure def hostProfile(android: bool, ios: bool, leanRequested: bool): HostProfile =
  if (android) MobileAndroid else if (ios) MobileIos else if (leanRequested) LeanHost else FullHost
pure def mobileProfile(profile: HostProfile): bool = profile == MobileAndroid or profile == MobileIos
pure def lawMobileProfileWins(android: bool, ios: bool, leanRequested: bool): bool =
  (android or ios) implies mobileProfile(hostProfile(android, ios, leanRequested))
```

### A mobile profile admits only the plugins bundled with it, and a lean host drops the browser and the full assistant

```quint
pure def bundleAllows(profile: HostProfile, capability: CapabilityClass): bool =
  if (mobileProfile(profile)) capability != UnbundledPlugin
  else if (profile == LeanHost) capability != BrowserCore and capability != FullAssistant
  else true
pure def lawMobileHasNoUnbundledPlugins(profile: HostProfile): bool =
  mobileProfile(profile) implies not(bundleAllows(profile, UnbundledPlugin))
```

### The workflow plugin's off switch wins on every profile

Android needs the mobile opt-in, which the launcher supplies only for an
admitted installation; a lean host needs the lean opt-in; iOS never runs
workflows.

```quint
pure def workflowSelected(profile: HostProfile, candidate: bool, workflowOff: bool, mobileOptIn: bool, leanOptIn: bool): bool =
  candidate and not(workflowOff) and
  (if (profile == MobileAndroid) mobileOptIn else if (profile == MobileIos) false else if (profile == LeanHost) leanOptIn else true)
pure def lawWorkflowOffWins(profile: HostProfile, candidate: bool, mobileOptIn: bool, leanOptIn: bool): bool =
  not(workflowSelected(profile, candidate, true, mobileOptIn, leanOptIn))
```

### The full assistant owns calendar, goals and selective reminders, and calendar brings the scheduler

A separate plugin cannot compete for those handlers while the full
assistant is present. Selective reminders bring the scheduler unless it was
explicitly switched off.

```quint
pure def survivesComposition(capability: CapabilityClass, assistantPresent: bool): bool =
  not(assistantPresent and (capability == SelectiveReminder or capability == CalendarOwner or capability == GoalOwner))
pure def addScheduler(candidate: bool, calendarPresent: bool, reminderPresent: bool, schedulerExplicitOff: bool): bool =
  candidate or calendarPresent or (reminderPresent and not(schedulerExplicitOff))
pure def lawAssistantOwnsSelectiveReminder(assistantPresent: bool): bool =
  assistantPresent implies not(survivesComposition(SelectiveReminder, assistantPresent))
pure def lawCalendarRequiresScheduler(candidate: bool, reminderPresent: bool, schedulerExplicitOff: bool): bool =
  addScheduler(candidate, true, reminderPresent, schedulerExplicitOff)
```

### Only a plugin the profile admits and nobody denied is registered

Nothing registers before the boot profile is chosen.

```quint
type PluginPhase = Absent | Migrating | Registering | Ready | Unloading
type Registration = { chosen: bool, profile: HostProfile, plugin: CapabilityClass, denied: bool, bootFailed: bool, phase: PluginPhase, inGeneration: bool, roles: bool, schema: bool, published: bool, closed: bool }
pure val initial: Registration = { chosen: false, profile: FullHost, plugin: MessageCore, denied: false, bootFailed: false, phase: Absent, inGeneration: true, roles: false, schema: false, published: false, closed: false }
pure def admitted(profile: HostProfile, plugin: CapabilityClass, denied: bool): bool = bundleAllows(profile, plugin) and not(denied)
pure val pluginValues = Set(MessageCore, BrowserCore, FullAssistant, WorkflowPlugin, UnbundledPlugin)
pure def canChooseBoot(r: Registration, profile: HostProfile, plugin: CapabilityClass, denied: bool): bool = not(r.chosen)
pure def chooseBoot(r: Registration, profile: HostProfile, plugin: CapabilityClass, denied: bool): Registration = { ...r, chosen: true, profile: profile, plugin: plugin, denied: denied }
pure def alwaysPublishedPluginIsAdmitted(r: Registration): bool = r.phase != Absent implies admitted(r.profile, r.plugin, r.denied)
pure def alwaysNothingRegistersBeforeBootIsChosen(r: Registration): bool = not(r.chosen) implies r.phase == Absent
pure def sometimesUnbundledPluginStaysAbsent(r: Registration): bool = r.chosen and mobileProfile(r.profile) and r.plugin == UnbundledPlugin and r.phase == Absent
```

### Denying the required message service fails boot

```quint
pure def canRefuseBoot(r: Registration): bool = r.chosen and r.denied and r.plugin == MessageCore and not(r.bootFailed)
pure def refuseBoot(r: Registration): Registration = { ...r, bootFailed: true }
pure def alwaysFailedBootPublishesNothing(r: Registration): bool = r.bootFailed implies not(r.published) and r.phase == Absent
pure def sometimesBootRefused(r: Registration): bool = r.bootFailed
```

## Story: Register a plugin once, fenced by its generation

> As the owner, a plugin that is unloaded or replaced while it is still
> registering never shows up half-installed.

### A plugin publishes only after its roles and schema migration, in the generation that began it

A registration in progress keeps the roles it began with, and once
migrated keeps its schema, until it is rolled back or unloaded.

```quint
pure def canBeginRegister(r: Registration): bool = r.chosen and r.phase == Absent and not(r.closed) and not(r.bootFailed) and admitted(r.profile, r.plugin, r.denied)
pure def beginRegister(r: Registration): Registration = { ...r, phase: Migrating, inGeneration: true, roles: true }
pure def canFinishMigration(r: Registration): bool = r.phase == Migrating and r.inGeneration
pure def finishMigration(r: Registration): Registration = { ...r, phase: Registering, schema: true }
pure def canPublish(r: Registration): bool = r.phase == Registering and r.inGeneration and not(r.closed)
pure def publish(r: Registration): Registration = { ...r, phase: Ready, published: true }
pure def alwaysPublishedIsComplete(r: Registration): bool =
  r.published implies r.phase == Ready and r.inGeneration and r.roles and r.schema and not(r.closed)
pure def alwaysRegistrationKeepsItsSteps(r: Registration): bool =
  ((r.phase == Migrating or r.phase == Registering or r.phase == Ready) implies r.roles) and
    ((r.phase == Registering or r.phase == Ready) implies r.schema)
pure def sometimesPluginReady(r: Registration): bool = r.published
```

### Unloading during registration rolls it back without publishing

A plugin that is unloading is never published, and invalidating, rolling
back or closing the registry never publishes one.

```quint
pure def canInvalidate(r: Registration): bool = r.phase != Absent and r.phase != Unloading
pure def invalidate(r: Registration): Registration = { ...r, inGeneration: false, published: false, phase: Unloading }
pure def canRollBack(r: Registration): bool = r.phase == Migrating or r.phase == Registering or r.phase == Unloading
pure def rollBack(r: Registration): Registration = { ...r, phase: Absent, published: false, schema: false, roles: false }
pure def canCloseRegistry(r: Registration): bool = not(r.closed)
pure def closeRegistry(r: Registration): Registration = { ...r, closed: true, published: false, inGeneration: false, phase: if (r.phase == Absent) Absent else Unloading }
pure def alwaysUnloadingIsUnpublished(r: Registration): bool = r.phase == Unloading implies not(r.published)
pure def stepUnloadNeverPublishes(before: Registration, via: str, after: Registration): bool =
  (via == "invalidate" or via == "rollBack" or via == "closeRegistry") implies not(after.published)
pure def sometimesInvalidatedMidMigration(r: Registration): bool = r.phase == Absent and not(r.inGeneration) and not(r.closed)
```

## Story: Bind an on-device agent's inference to the owner's cloud account

> As the owner of a consumer build, my on-device agent thinks only through
> my cloud account; either it keeps embeddings on the device, or it carries
> no local model at all, and it never quietly sends to the cloud what was
> meant to stay on the device.

### An absent runtime profile selection is the device profile, and an unknown one fails boot

```quint
type RuntimeProfileChoice = NoProfileChosen | DeviceProfileChosen | CloudOnlyProfileChosen | UnknownProfileChosen
type RuntimeProfile = DeviceProfile | CloudOnlyProfile | ProfileRefused
pure def runtimeProfile(choice: RuntimeProfileChoice): RuntimeProfile =
  if (choice == NoProfileChosen or choice == DeviceProfileChosen) DeviceProfile
  else if (choice == CloudOnlyProfileChosen) CloudOnlyProfile
  else ProfileRefused
pure def lawUnknownRuntimeProfileFailsBoot(choice: RuntimeProfileChoice): bool =
  (runtimeProfile(choice) == ProfileRefused) iff (choice == UnknownProfileChosen)
```

### Text inference goes only to the owner's cloud account, and a cloud-only profile carries no local model

Both profiles route every text model slot to the owner's cloud account. The
device profile embeds on the device and packages its local model inputs; the
cloud-only profile packages none and embeds through the cloud account.

```quint
type ModelRoute = OwnerCloudAccount | OnDevice | RouteUnavailable
pure def textRoute(profile: RuntimeProfile): ModelRoute = if (profile == ProfileRefused) RouteUnavailable else OwnerCloudAccount
pure def carriesLocalModels(profile: RuntimeProfile): bool = profile == DeviceProfile
pure def lawTextInferenceUsesOnlyTheCloudAccount(profile: RuntimeProfile): bool =
  textRoute(profile) != OnDevice and (profile != ProfileRefused implies textRoute(profile) == OwnerCloudAccount)
pure def lawCloudOnlyProfileCarriesNoLocalModel(profile: RuntimeProfile): bool =
  profile == CloudOnlyProfile implies not(carriesLocalModels(profile))
```

### A device profile whose local embedding inputs are missing reports embeddings unavailable and never falls back to the cloud

```quint
pure def embeddingRoute(profile: RuntimeProfile, localInputsPresent: bool): ModelRoute =
  if (profile == CloudOnlyProfile) OwnerCloudAccount
  else if (profile == DeviceProfile and localInputsPresent) OnDevice
  else RouteUnavailable
pure def lawMissingLocalEmbeddingsNeverReachTheCloud(localInputsPresent: bool): bool =
  embeddingRoute(DeviceProfile, localInputsPresent) != OwnerCloudAccount and
    (not(localInputsPresent) implies embeddingRoute(DeviceProfile, localInputsPresent) == RouteUnavailable)
```

### The agent's own speech never leaves the device, so a cloud-only profile has none

Speech that a host sends to a cloud speech service is the host's own,
disclosed upload, never the agent's routing.

```quint
pure def agentSpeechRoute(profile: RuntimeProfile): ModelRoute = if (carriesLocalModels(profile)) OnDevice else RouteUnavailable
pure def lawAgentSpeechStaysOnTheDevice(profile: RuntimeProfile): bool =
  agentSpeechRoute(profile) != OwnerCloudAccount and (profile == CloudOnlyProfile implies agentSpeechRoute(profile) == RouteUnavailable)
```

## Story: Load only the plugins a consumer's policy names

> As the maker of a consumer build, I list the plugins my agent loads and
> the ones it refuses, and no other plugin, and no action of a plugin I
> refused, ever reaches my users.

### A load list admits only the plugins it names, and a refused plugin never loads

A policy without a load list leaves the profile's admission as it is. A
plugin named both to load and to refuse is refused. The policy narrows the
profile and never widens it.

```quint
type PluginPolicy = { hasLoadList: bool, load: Set[str], refuse: Set[str] }
pure def policyAdmits(policy: PluginPolicy, pluginName: str): bool =
  (not(policy.hasLoadList) or policy.load.contains(pluginName)) and not(policy.refuse.contains(pluginName))
pure def loadsUnder(policy: PluginPolicy, profile: HostProfile, capability: CapabilityClass, pluginName: str, denied: bool): bool =
  admitted(profile, capability, denied) and policyAdmits(policy, pluginName)
pure val policyValues = Set(
  { hasLoadList: false, load: Set(), refuse: Set() },
  { hasLoadList: true, load: Set("assistant", "cloud"), refuse: Set("browser") },
  { hasLoadList: true, load: Set("assistant", "browser"), refuse: Set("browser") }
)
pure val pluginNameValues = Set("assistant", "cloud", "browser", "wallet")
pure def lawLoadListAdmitsOnlyWhatItNames(policy: PluginPolicy, pluginName: str): bool =
  (policy.hasLoadList and policyAdmits(policy, pluginName)) implies policy.load.contains(pluginName)
pure def lawRefusedPluginNeverLoads(policy: PluginPolicy, profile: HostProfile, capability: CapabilityClass, pluginName: str, denied: bool): bool =
  policy.refuse.contains(pluginName) implies not(loadsUnder(policy, profile, capability, pluginName, denied))
pure def lawPolicyNeverWidensTheProfile(policy: PluginPolicy, profile: HostProfile, capability: CapabilityClass, pluginName: str, denied: bool): bool =
  loadsUnder(policy, profile, capability, pluginName, denied) implies admitted(profile, capability, denied)
```

### An action is offered only when the plugin that registered it loaded

Each action name is registered by exactly one plugin, as
[action planning](../../core/actionPlanning.md) refuses a second
registration, so the name names its plugin for as long as it is registered.
An action of a plugin the policy refused is never offered, whatever the
action allowlist says.

```quint
type ActionOwner = { actionName: str, plugin: str }
pure def registeringPlugin(owners: List[ActionOwner], actionName: str): str = owners.select(o => o.actionName == actionName).nthOr(0, { actionName: "", plugin: "" }).plugin
pure def actionOffered(owners: List[ActionOwner], policy: PluginPolicy, actionName: str): bool =
  owners.some(o => o.actionName == actionName) and policyAdmits(policy, registeringPlugin(owners, actionName))
pure val ownersValues = Set(List(), List({ actionName: "REPLY", plugin: "assistant" }, { actionName: "BROWSER", plugin: "browser" }))
pure val actionNameValues = Set("REPLY", "BROWSER", "WALLET")
pure def lawActionOfARefusedPluginIsNeverOffered(owners: List[ActionOwner], policy: PluginPolicy, actionName: str): bool =
  policy.refuse.contains(registeringPlugin(owners, actionName)) implies not(actionOffered(owners, policy, actionName))
pure def lawUnregisteredActionIsNeverOffered(owners: List[ActionOwner], policy: PluginPolicy, actionName: str): bool =
  not(owners.some(o => o.actionName == actionName)) implies not(actionOffered(owners, policy, actionName))
```
