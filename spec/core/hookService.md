# Hook service registry eligibility and dispatch

The source is `packages/core/src/services/hook.ts:88-491` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This service is distinct from runtime pipeline hooks. It owns generated registration IDs, event indexes, mutable metadata, configuration reference, binary-hit cache and runtime event interceptors. Directory loading explicitly throws as unsupported in environment-independent core.

## Story: Register eligible event hooks and retain exact dispatch snapshots

As a host I register handlers for one or more hook events, enable or reprioritize them, and dispatch eligible handlers sequentially. Unregistering or stopping the service cannot rewrite registrations already captured by an in-flight dispatch.

### Registration and event indexes retain identity and version together

ID formatting uses an incrementing counter and normalized name suffix. The numeric identity is modeled independently of formatting. Finite priorities pass through; invalid priorities map to the source default zero. Equal priority and timestamp retain event-index insertion order. Stopping clears runtime interceptors, registrations, indexes and binary hits without resetting the counters, configuration or cached PATH value.

```quint
type HookRequirement = {os: Set[str], bins: List[str], anyBins: List[str], env: Set[str], config: List[str]}
type ConfigValue = ConfigMissing | ConfigNull | ConfigBoolean({value: bool}) | ConfigNumber({value: int}) | ConfigNonfinite | ConfigText({text: str, nonblank: bool}) | ConfigObject({identity: int})
pure val absentConfigValue: ConfigValue = ConfigMissing
type ConfigField = {path: str, value: ConfigValue}
type HookRegistration = {id: int, name: str, handler: int, events: List[str], priority: int, registeredAt: int, active: bool, bypassEligibility: bool, requirements: HookRequirement}
type HookIndex = {eventName: str, ids: List[int]}
type CapturedEventHook = {id: int, handler: int}
type EventHookCall = {id: int, snapshot: List[CapturedEventHook], nextIndex: int, running: bool, done: bool, failed: bool}
type Eligibility = {binaryHits: Set[str], eligible: bool}
type HookService = {registrations: List[HookRegistration], index: List[HookIndex], nextId: int, version: int, configIdentity: int, config: List[ConfigField], pathPresent: bool, path: str, binaryHits: Set[str], interceptors: List[str], setupDone: bool, calls: List[EventHookCall]}
pure val initial: HookService = {registrations: List(), index: List(), nextId: 1, version: 0, configIdentity: 0, config: List(), pathPresent: false, path: "", binaryHits: Set(), interceptors: List(), setupDone: false, calls: List()}
pure val emptyRequirements: HookRequirement = {os: Set(), bins: List(), anyBins: List(), env: Set(), config: List()}
pure val requirementsValues = Set(emptyRequirements, {os: Set("linux"), bins: List("git"), anyBins: List("node", "bun"), env: Set("TOKEN"), config: List("feature.active")})
pure val eventsValues = Set(List(), List("HOOK_START"), List("HOOK_START", "HOOK_STOP"))
pure val nameValues = Set("first", "second")
pure val handlerValues = Set(1, 2)
pure val priorityValues = Set(-1, 0, 1)
pure val registeredAtValues = Set(0, 1)
pure val hookIdValues = Set(1, 2, 3)
pure val callIdValues = Set(1, 2)
pure val eventNameValues = Set("HOOK_START", "HOOK_STOP")
pure val platformValues = Set("linux", "darwin")
pure val environmentValues = Set(Set(), Set("TOKEN"))
pure val foundBinsValues = Set(Set(), Set("git"), Set("git", "node"))
pure val pathValues = Set("", "/usr/bin", "/opt/bin")
pure val configIdentityValues = Set(1, 2)
pure val configValues = Set(List(), List({path: "feature.active", value: ConfigBoolean({value: true})}), List({path: "feature.active", value: ConfigBoolean({value: false})}))
pure def canInstallInterceptors(s: HookService, events: List[str]): bool = not(s.setupDone)
pure def installInterceptors(s: HookService, events: List[str]): HookService = { ...s, setupDone: true, interceptors: events }
pure def canRegister(s: HookService, name: str, handler: int, events: List[str], priority: int, registeredAt: int, bypassEligibility: bool, requirements: HookRequirement): bool = handler > 0
pure def register(s: HookService, name: str, handler: int, events: List[str], priority: int, registeredAt: int, bypassEligibility: bool, requirements: HookRequirement): HookService = {
  val added = {id: s.nextId, name: name, handler: handler, events: events, priority: priority, registeredAt: registeredAt, active: true, bypassEligibility: bypassEligibility, requirements: requirements}
  val existing = s.index.listMap(entry => if (events.includes(entry.eventName)) { ...entry, ids: entry.ids.append(s.nextId) } else entry)
  val indexed = events.foldl(existing, (acc, eventName) => if (acc.some(entry => entry.eventName == eventName)) acc else acc.append({eventName: eventName, ids: List(s.nextId)}))
  { ...s, registrations: s.registrations.append(added), index: indexed, nextId: s.nextId + 1, version: s.version + 1 }
}
pure def canUnregister(s: HookService, hookId: int): bool = true
pure def unregister(s: HookService, hookId: int): HookService = if (not(s.registrations.some(r => r.id == hookId))) s else { ...s, registrations: s.registrations.select(r => r.id != hookId), index: s.index.listMap(entry => { ...entry, ids: entry.ids.select(id => id != hookId) }).select(entry => entry.ids.length() > 0), version: s.version + 1 }
pure def setActive(s: HookService, hookId: int, active: bool): HookService = if (not(s.registrations.some(r => r.id == hookId))) s else { ...s, registrations: s.registrations.listMap(r => if (r.id == hookId) { ...r, active: active } else r), version: s.version + 1 }
pure def setPriority(s: HookService, hookId: int, priority: int, finite: bool): HookService = if (not(s.registrations.some(r => r.id == hookId))) s else { ...s, registrations: s.registrations.listMap(r => if (r.id == hookId) { ...r, priority: if (finite) priority else 0 } else r), version: s.version + 1 }
pure def canSetConfig(s: HookService, configIdentity: int, config: List[ConfigField]): bool = configIdentity > 0 and config.every(configEntry => config.select(other => other.path == configEntry.path).length() == 1)
pure def setConfig(s: HookService, configIdentity: int, config: List[ConfigField]): HookService = { ...s, configIdentity: configIdentity, config: config }
pure def stopService(s: HookService): HookService = { ...s, registrations: List(), index: List(), binaryHits: Set(), interceptors: List() }
pure def alwaysIndexAgrees(s: HookService): bool = s.index.every(entry => entry.ids.length() > 0 and entry.ids.every(id => s.registrations.some(r => r.id == id and r.events.includes(entry.eventName)))) and s.registrations.every(r => r.events.every(eventName => s.index.some(entry => entry.eventName == eventName and entry.ids.includes(r.id))))
pure def alwaysRegistrationIds(s: HookService): bool = s.registrations.every(r => r.id > 0 and r.id < s.nextId and s.registrations.select(other => other.id == r.id).length() == 1)
pure def stepCountersNeverReset(before: HookService, after: HookService): bool = after.nextId >= before.nextId and after.version >= before.version
```

### Eligibility keeps only successful binary probes for the current PATH

The filesystem adapter validates a binary name has no slash or backslash and reports only regular executable files on POSIX, or the supported executable extensions on Windows. Missing probes are not cached. The normalized configuration path adapter splits on dots and discards empty segments. `ConfigText.nonblank` records trimmed length, and objects and nonfinite numeric values are truthy under the source's explicit helper.

```quint
pure def configTruthy(value: ConfigValue): bool = match value { | ConfigMissing => false | ConfigNull => false | ConfigBoolean(v) => v.value | ConfigNumber(v) => v.value != 0 | ConfigText(v) => v.nonblank | _ => true }
pure def configPathTruthy(config: List[ConfigField], path: str): bool = configTruthy(config.select(configEntry => configEntry.path == path).nthOr(0, {path: "", value: absentConfigValue}).value)
pure def requirementEligibility(requirements: HookRequirement, hits: Set[str], foundBins: Set[str], platform: str, environment: Set[str], config: List[ConfigField]): Eligibility = {
  val allHits = requirements.bins.foldl(hits, (acc, bin) => if (foundBins.contains(bin)) acc.union(Set(bin)) else acc)
  val eligible = (requirements.os.size() == 0 or requirements.os.contains(platform)) and requirements.bins.every(bin => allHits.contains(bin)) and (requirements.anyBins.length() == 0 or requirements.anyBins.some(bin => allHits.contains(bin) or foundBins.contains(bin))) and requirements.env.forall(key => environment.contains(key)) and requirements.config.every(path => configPathTruthy(config, path))
  val firstAny = requirements.anyBins.select(bin => allHits.contains(bin) or foundBins.contains(bin)).nthOr(0, "")
  {binaryHits: if (firstAny == "") allHits else allHits.union(Set(firstAny)), eligible: eligible}
}
pure def canProbeBinary(s: HookService, bin: str, validName: bool, found: bool, pathPresent: bool, path: str): bool = true
pure def probeBinary(s: HookService, bin: str, validName: bool, found: bool, pathPresent: bool, path: str): HookService = {
  val hits = if (s.pathPresent == pathPresent and s.path == path) s.binaryHits else Set()
  { ...s, pathPresent: pathPresent, path: path, binaryHits: if (validName and found) hits.union(Set(bin)) else hits }
}
pure def canUpdateConfigReference(s: HookService, configIdentity: int, config: List[ConfigField]): bool = config.every(configEntry => config.select(other => other.path == configEntry.path).length() == 1)
pure def updateConfigReference(s: HookService, configIdentity: int, config: List[ConfigField]): HookService = if (configIdentity == s.configIdentity) { ...s, config: config } else s
pure def hookBefore(first: HookRegistration, second: HookRegistration): bool = first.priority > second.priority or (first.priority == second.priority and first.registeredAt <= second.registeredAt)
pure def insertHook(hooks: List[HookRegistration], hook: HookRegistration): List[HookRegistration] = hooks.select(old => hookBefore(old, hook)).append(hook).concat(hooks.select(old => not(hookBefore(old, hook))))
pure val emptyHooks: List[HookRegistration] = List()
pure def canDispatch(s: HookService, callId: int, eventName: str, foundBins: Set[str], platform: str, environment: Set[str], pathPresent: bool, path: str): bool = callId > 0 and not(s.calls.some(c => c.id == callId))
pure def dispatch(s: HookService, callId: int, eventName: str, foundBins: Set[str], platform: str, environment: Set[str], pathPresent: bool, path: str): HookService = {
  val checked = s.registrations.select(r => r.events.includes(eventName) and r.active and not(r.bypassEligibility))
  val needsProbe = checked.some(r => r.requirements.bins.length() > 0 or r.requirements.anyBins.length() > 0)
  val hits = if (not(needsProbe) or (s.pathPresent == pathPresent and s.path == path)) s.binaryHits else Set()
  val selected = s.registrations.select(r => r.events.includes(eventName) and r.active and (r.bypassEligibility or requirementEligibility(r.requirements, hits, foundBins, platform, environment, s.config).eligible))
  val cache = checked.foldl(hits, (acc, r) => requirementEligibility(r.requirements, acc, foundBins, platform, environment, s.config).binaryHits)
  { ...s, pathPresent: if (needsProbe) pathPresent else s.pathPresent, path: if (needsProbe) path else s.path, binaryHits: cache, calls: s.calls.append({id: callId, snapshot: selected.foldl(emptyHooks, (acc, hook) => insertHook(acc, hook)).listMap(hook => {id: hook.id, handler: hook.handler}), nextIndex: 0, running: false, done: selected.length() == 0, failed: false}) }
}
pure def canBeginHandler(s: HookService, callId: int): bool = s.calls.some(c => c.id == callId and not(c.done) and not(c.running) and c.nextIndex < c.snapshot.length())
pure def beginHandler(s: HookService, callId: int): HookService = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, running: true } else c) }
pure def canFinishHandler(s: HookService, callId: int, ok: bool): bool = s.calls.some(c => c.id == callId and c.running)
pure def finishHandler(s: HookService, callId: int, ok: bool): HookService = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, running: false, nextIndex: c.nextIndex + 1, failed: not(ok), done: not(ok) or c.nextIndex + 1 == c.snapshot.length() } else c) }
pure def alwaysDispatchBounds(s: HookService): bool = s.calls.every(c => c.nextIndex >= 0 and c.nextIndex <= c.snapshot.length() and (c.failed implies c.done))
pure def stepSnapshotsImmutable(before: HookService, after: HookService): bool = before.calls.every(c => after.calls.some(other => other.id == c.id and other.snapshot == c.snapshot))
pure def sometimesStoppedWhileSnapshotRuns(s: HookService): bool = s.registrations.length() == 0 and s.interceptors.length() == 0 and s.calls.some(c => not(c.done))
pure def sometimesHandlerFailureStopsPeers(s: HookService): bool = s.calls.some(c => c.failed and c.nextIndex < c.snapshot.length())
```
