# Plugin profile

A host boots with a profile: the plugin capability classes a deployment
admits, and the plugins it denies by name. The
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

```quint
pure def canInvalidate(r: Registration): bool = r.phase != Absent and r.phase != Unloading
pure def invalidate(r: Registration): Registration = { ...r, inGeneration: false, published: false, phase: Unloading }
pure def canRollBack(r: Registration): bool = r.phase == Migrating or r.phase == Registering or r.phase == Unloading
pure def rollBack(r: Registration): Registration = { ...r, phase: Absent, published: false, schema: false, roles: false }
pure def canCloseRegistry(r: Registration): bool = not(r.closed)
pure def closeRegistry(r: Registration): Registration = { ...r, closed: true, published: false, inGeneration: false, phase: if (r.phase == Absent) Absent else Unloading }
pure def sometimesInvalidatedMidMigration(r: Registration): bool = r.phase == Absent and not(r.inGeneration) and not(r.closed)
```
