# Configuration

The host keeps its configuration as one document on disk. A write replaces
the whole document atomically: it is staged, synced and then renamed over
the committed one, so a failed write leaves the previous document intact.
The running host applies only a committed document. Includes are followed
to a bounded depth and never in a cycle. The access scope the host
computes from the running document and the runtime mode is cached, and the
cache never outlives either. Who may change configuration
is in [route access](./access.md).

## Story: Change host configuration without losing live state

> As the owner, I change my host's configuration and either the whole new
> document takes effect or the old one stays; a change of runtime mode never
> leaves the host deciding access from stale settings.

### A write becomes the committed document only after it is synced, and the host runs only a committed document

```quint
type WritePhase = WriteIdle | Staged | Synced
type ScopeSource = { document: int, mode: int }
type Config = { committed: int, staged: int, phase: WritePhase, active: int, mode: int, includes: List[int], includeRefused: bool, scopeCached: bool, scopeFrom: ScopeSource, reloadFailed: bool, writesFailed: int }
pure val initial: Config = { committed: 0, staged: -1, phase: WriteIdle, active: 0, mode: 0, includes: List(), includeRefused: false, scopeCached: false, scopeFrom: { document: 0, mode: 0 }, reloadFailed: false, writesFailed: 0 }
pure val documentValues = Set(0, 1, 2)
pure def canStage(c: Config, document: int): bool = c.phase == WriteIdle and document >= 0 and document != c.committed
pure def stage(c: Config, document: int): Config = { ...c, staged: document, phase: Staged }
pure def canSync(c: Config): bool = c.phase == Staged
pure def sync(c: Config): Config = { ...c, phase: Synced }
pure def canCommit(c: Config): bool = c.phase == Synced
pure def commit(c: Config): Config = { ...c, committed: c.staged, staged: -1, phase: WriteIdle }
pure def alwaysStagedDocumentIsNew(c: Config): bool =
  (c.phase == WriteIdle implies c.staged == -1) and (c.phase != WriteIdle implies c.staged >= 0 and c.staged != c.committed)
pure def stepCommitOnlyAfterSync(before: Config, after: Config): bool =
  after.committed != before.committed implies before.phase == Synced and after.committed == before.staged
pure def canActivate(c: Config): bool = c.phase == WriteIdle and c.active != c.committed
pure def activate(c: Config): Config = { ...c, active: c.committed, scopeCached: false }
pure def stepHostRunsOnlyCommittedDocument(before: Config, after: Config): bool =
  after.active != before.active implies after.active == before.committed
pure def sometimesNewDocumentActive(c: Config): bool = c.active != 0
```

### A failed write leaves the committed document as it was

```quint
pure def canFailWrite(c: Config): bool = c.phase != WriteIdle
pure def failWrite(c: Config): Config = { ...c, staged: -1, phase: WriteIdle, writesFailed: c.writesFailed + 1 }
pure def stepFailedWriteKeepsDocument(before: Config, via: str, after: Config): bool =
  via == "failWrite" implies after.committed == before.committed
pure def sometimesWriteFailedAfterACommit(c: Config): bool = c.writesFailed > 0 and c.committed != 0
```

### Includes are followed to a depth of two and never in a cycle

The depth bound stands for the configured finite bound. An include that
names a document already on the include path is refused.

```quint
pure val includeDepth = 2
pure val includeValues = Set(1, 2)
pure def canEnterInclude(c: Config, include: int): bool = c.includes.length() < includeDepth and not(c.includes.includes(include))
pure def enterInclude(c: Config, include: int): Config = { ...c, includes: c.includes.append(include) }
pure def canLeaveInclude(c: Config): bool = c.includes.length() > 0
pure def leaveInclude(c: Config): Config = { ...c, includes: c.includes.select(i => i != c.includes.nthOr(c.includes.length() - 1, 0)) }
pure def canRefuseInclude(c: Config, include: int): bool = c.includes.includes(include)
pure def refuseInclude(c: Config, include: int): Config = { ...c, includeRefused: true }
pure def alwaysIncludesBoundedAndAcyclic(c: Config): bool =
  c.includes.length() <= includeDepth and c.includes.every(i => c.includes.select(j => j == i).length() == 1)
pure def sometimesNestedInclude(c: Config): bool = c.includes.length() == includeDepth
pure def sometimesCycleRefused(c: Config): bool = c.includeRefused
```

### A change of the running document or runtime mode drops the cached access scope

A cached scope is always the one computed from the running document and
the current runtime mode; a failed reload drops it too.

```quint
pure val modeValues = Set(0, 1)
pure def loadScope(c: Config): Config = { ...c, scopeCached: true, scopeFrom: { document: c.active, mode: c.mode }, reloadFailed: false }
pure def canChangeMode(c: Config, mode: int): bool = mode != c.mode
pure def changeMode(c: Config, mode: int): Config = { ...c, mode: mode, scopeCached: false }
pure def failReload(c: Config): Config = { ...c, scopeCached: false, reloadFailed: true }
pure def alwaysCachedScopeIsCurrent(c: Config): bool =
  c.scopeCached implies c.scopeFrom == { document: c.active, mode: c.mode } and not(c.reloadFailed)
pure def sometimesScopeDroppedAfterFailedReload(c: Config): bool = c.reloadFailed and not(c.scopeCached)
pure def sometimesScopeCachedAfterModeChange(c: Config): bool = c.scopeCached and c.mode != 0 and c.active != 0
```

## Story: Boot with the launch policy my host supplies

> As the maker of a host that renders some screens natively, I hand the agent
> the native views, browser commands and time zone of my device at launch;
> the agent takes them as I gave them, refuses a malformed policy, and never
> lets one of mine replace a view the agent ships.

### A host's native view policy is admitted whole or refused, and never renames or replaces a released view

The policy is trusted host configuration read once before the runtime
starts, never renderer input. It is a list of at most 32 navigation-only
views of at most 16,384 characters, each with a unique id and path, a label
and at most four aliases that shadow no id, label or alias of another view.
Any entry that breaks this refuses the whole policy and the boot. A host
view may stand in for a preview view the agent ships with the same id and
path, never for a released or system one. Each admitted view is owner-only,
has no capabilities and stays unavailable as a hosted view. A plugin view
that is installed stays authoritative; a later plugin replaces a host view
only when the host view names that plugin as the one it stands in for.

```quint
type ShippedKind = NotShipped | ShippedPreview | ShippedRelease
type HostView = { idUnique: bool, pathUnique: bool, wellFormed: bool, aliasesFree: bool, sameAsShipped: bool, shipped: ShippedKind }
type ViewPolicy = { present: bool, characters: int, views: List[HostView] }
pure val nativeViewLimit = 32
pure val nativeViewPolicyCharacters = 16384
pure def hostViewAdmitted(v: HostView): bool =
  v.idUnique and v.pathUnique and v.wellFormed and v.aliasesFree and
    (v.shipped == NotShipped or (v.shipped == ShippedPreview and v.sameAsShipped))
pure def viewPolicyAdmitted(p: ViewPolicy): bool =
  not(p.present) or (p.characters <= nativeViewPolicyCharacters and p.views.length() <= nativeViewLimit and p.views.every(v => hostViewAdmitted(v)))
pure def pluginReplacesHostView(namedFallback: bool, sameRouteAndModality: bool): bool = namedFallback and sameRouteAndModality
pure val goodView: HostView = { idUnique: true, pathUnique: true, wellFormed: true, aliasesFree: true, sameAsShipped: false, shipped: NotShipped }
pure val pValues = Set({ present: false, characters: 0, views: List() }, { present: true, characters: 120, views: List(goodView) },
  { present: true, characters: 120, views: List(goodView, { ...goodView, shipped: ShippedRelease, sameAsShipped: true }) },
  { present: true, characters: 120, views: List({ ...goodView, shipped: ShippedPreview, sameAsShipped: true }) },
  { present: true, characters: 20000, views: List(goodView) })
pure def lawPolicyNeverReplacesAReleasedView(p: ViewPolicy): bool =
  (p.present and viewPolicyAdmitted(p)) implies p.views.every(v => v.shipped != ShippedRelease and (v.shipped == ShippedPreview implies v.sameAsShipped))
pure def lawOneBadEntryRefusesThePolicy(p: ViewPolicy): bool =
  (p.present and p.views.some(v => not(hostViewAdmitted(v)))) implies not(viewPolicyAdmitted(p))
pure def lawOnlyANamedPluginReplacesAHostView(sameRouteAndModality: bool): bool = not(pluginReplacesHostView(false, sameRouteAndModality))
```

### The agent sends a native browser only the commands its host allows

A host names the browser commands its native browser handles and whether
it serves a browser automation target. A command the host did not name is
refused before it reaches the native browser, and with the target off no
automation session is opened on the device.

```quint
type BrowserCommand = BackCommand | ForwardCommand | ReloadCommand | NavigateCommand | ScreenshotCommand
pure def nativeCommandSent(allowed: Set[BrowserCommand], command: BrowserCommand): bool = allowed.contains(command)
pure def automationOpened(targetOn: bool, requested: bool): bool = targetOn and requested
pure val allowedValues = Set(Set(), Set(BackCommand, ForwardCommand, ReloadCommand))
pure def lawUnnamedBrowserCommandIsRefused(allowed: Set[BrowserCommand], command: BrowserCommand): bool =
  not(allowed.contains(command)) implies not(nativeCommandSent(allowed, command))
pure def lawTargetOffOpensNoAutomation(requested: bool): bool = not(automationOpened(false, requested))
```

### A relative date outside a workflow is read in the host's time zone

The host supplies its device time zone at launch. A relative date that a
workflow schedules is read in the workflow's own zone; any other relative
date the agent reads, such as "tomorrow" in a reminder or a reply, is read
in the host's time zone, never the server's or the runtime's default.

```quint
type ZoneSource = HostZone | WorkflowZone | RuntimeDefaultZone
pure def relativeDateZone(inWorkflow: bool): ZoneSource = if (inWorkflow) WorkflowZone else HostZone
pure def lawRuntimeDefaultZoneIsNeverUsed(inWorkflow: bool): bool =
  relativeDateZone(inWorkflow) != RuntimeDefaultZone and (not(inWorkflow) implies relativeDateZone(inWorkflow) == HostZone)
```

### A private runtime launches with literal settings from a private file, and the launch's own values win

A desktop host that launches a private runtime for its account reads the
runtime's settings, token and configuration from files only it can read: a
file that is not a regular file with a single link is refused. Settings are
read literally, one assignment a line, never expanded or run; one line that
is neither blank, a comment nor an assignment refuses the launch. The
runtime's environment takes the inherited values the host allows, then the
host's settings, then the values the launch itself owns, and a key the
launch removes is unset whatever set it.

```quint
type SettingsLine = BlankLine | CommentLine | AssignmentLine | MalformedLine
type PrivateFile = { regular: bool, singleLink: bool }
type EnvSource = FromInherited | FromSettings | FromLaunch | EnvUnset
type EnvKey = { inherited: bool, allowed: bool, inSettings: bool, launchOwned: bool, removed: bool }
pure def settingsAdmitted(lines: List[SettingsLine]): bool = lines.every(line => line != MalformedLine)
pure def privateFileReadable(privateFile: PrivateFile): bool = privateFile.regular and privateFile.singleLink
pure def envSource(envKey: EnvKey): EnvSource =
  if (envKey.removed) EnvUnset
  else if (envKey.launchOwned) FromLaunch
  else if (envKey.inSettings) FromSettings
  else if (envKey.inherited and envKey.allowed) FromInherited
  else EnvUnset
pure val privateFileValues = Set({ regular: true, singleLink: true }, { regular: true, singleLink: false }, { regular: false, singleLink: true })
pure val envKeyValues = Set({ inherited: true, allowed: false, inSettings: false, launchOwned: false, removed: false },
  { inherited: true, allowed: true, inSettings: true, launchOwned: true, removed: false },
  { inherited: true, allowed: true, inSettings: false, launchOwned: false, removed: false },
  { inherited: false, allowed: false, inSettings: true, launchOwned: true, removed: true })
pure def lawOneMalformedLineRefusesTheSettings(lines: List[SettingsLine]): bool =
  lines.includes(MalformedLine) implies not(settingsAdmitted(lines))
pure def lawOnlyAPrivateRegularFileIsRead(privateFile: PrivateFile): bool =
  privateFileReadable(privateFile) implies (privateFile.regular and privateFile.singleLink)
pure def lawTheLaunchDecidesLast(envKey: EnvKey): bool =
  (envKey.removed implies envSource(envKey) == EnvUnset) and
    ((envKey.launchOwned and not(envKey.removed)) implies envSource(envKey) == FromLaunch) and
    (not(envKey.allowed) implies envSource(envKey) != FromInherited)
```
