# Hook service registry eligibility and dispatch

This service owns event hook registrations, event index membership, mutable metadata, the eligibility configuration and PATH cache, and the interceptors it installs in the runtime event system. Runtime pipeline hooks have their own dispatch contract in `concurrentHooks.md`. The source is `packages/core/src/services/hook.ts:38-505`, `packages/core/src/types/hook.ts` and `packages/core/src/types/events.ts:127-154` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`.

## Story: Dispatch eligible event hooks in a stable order

As a host I can register, inspect and configure event hooks. Each event invokes the registrations eligible when the interceptor captured them. Each handler sees the same mutable event payload and runs after the previous handler resolves.

### Registration identities, event membership and live metadata are separate

The ID format joins the incrementing counter and the lowercased name with whitespace runs replaced by underscores. The public ID encoder binds the generated string to its counter component; the model uses that counter as the immutable map key. The registration retains the source tag, optional owner and description. The registration decoder supplies runtime when the source is omitted and omitted or nonfinite priority becomes zero. A finite priority's ordered numeric value is supplied by the adapter, which preserves source ordering including fractional priorities. Equal priorities and timestamps keep insertion order. Writes through the service increment snapshot version only if a registration exists. Stopping clears registrations, index memberships, positive hits and installed interceptors, preserving the counters, PATH observation and config reference. Directory registration rejects with the unsupported error.

The index is a projection of each row's indexed event memberships, read in registration insertion order. A source array or returned `metadata.events` array can change without reindexing. Unregister uses the current array to remove index memberships and detaches the registration. A stale membership for a detached row is skipped, exactly like finding no registration for its ID in the source. A caller retaining a registration object can observe its changed metadata or handler. The model keeps object IDs and preserves detached rows to account for captured references. JavaScript aliases and garbage collection are adapter obligations.

```quint
type HookRequirement = {os: List[str], bins: List[str], anyBins: List[str], env: List[str], config: List[str]}
type ConfigValue = ConfigMissing | ConfigNull | ConfigBoolean({value: bool}) | ConfigNumber({value: int}) | ConfigNonfinite | ConfigText({text: str, nonblank: bool}) | ConfigObject({identity: int})
pure val absentConfigValue: ConfigValue = ConfigMissing
type ConfigField = {path: str, value: ConfigValue}
type HookSource = BundledHook | ManagedHook | WorkspaceHook | PluginHook | RuntimeHook
type HookMetadata = {name: str, description: str, hasDescription: bool, source: HookSource, pluginId: str, hasPlugin: bool, eventRef: int, priority: int, active: bool, bypassEligibility: bool, requirementRef: int}
type HookRegistration = {id: int, handler: int, registeredAt: int, registered: bool, metadata: HookMetadata, indexedEvents: Set[str]}
type HookSummary = {name: str, eventRef: int, source: HookSource, active: bool, pluginId: str, hasPlugin: bool, priority: int}
type HookSnapshot = {hooks: List[HookSummary], version: int, timestamp: int}
type EventArray = {ref: int, names: List[str]}
type RequirementRow = {ref: int, requirements: HookRequirement}
type Interceptor = {eventName: str, owner: int}
type EventHookCall = {id: int, payloadRef: int, snapshot: List[int], nextIndex: int, runningHandler: int, done: bool, errorRef: int}
type EligibilityReason = HookMissing | WrongPlatform({currentPlatform: str, allowedPlatforms: List[str]}) | MissingBinary({bin: str}) | MissingAlternatives({choices: List[str]}) | MissingEnvironment({envName: str}) | FalsyConfig({configPath: str})
type Eligibility = {binaryHits: Set[str], eligible: bool, reasons: List[EligibilityReason]}
type ReflectedEligibility = {eligible: bool, reasons: List[EligibilityReason]}
type HookService = {registrations: List[HookRegistration], eventArrays: List[EventArray], requirementRows: List[RequirementRow], nextId: int, version: int, configIdentity: int, config: List[ConfigField], pathPresent: bool, path: str, binaryHits: Set[str], interceptors: List[Interceptor], installedOwner: int, calls: List[EventHookCall], lastEligibility: ReflectedEligibility}
pure val noReasons: List[EligibilityReason] = List()
pure val noHookReason: EligibilityReason = HookMissing
pure val missingResult: ReflectedEligibility = {eligible: false, reasons: List(noHookReason)}
pure val eligibleResult: ReflectedEligibility = {eligible: true, reasons: noReasons}
pure val initial: HookService = {registrations: List(), eventArrays: List(), requirementRows: List(), nextId: 1, version: 0, configIdentity: 0, config: List(), pathPresent: false, path: "", binaryHits: Set(), interceptors: List(), installedOwner: 0, calls: List(), lastEligibility: eligibleResult}
pure val emptyRequirements: HookRequirement = {os: List(), bins: List(), anyBins: List(), env: List(), config: List()}
pure val defaultHookSource: HookSource = RuntimeHook
pure val emptyMetadata: HookMetadata = {name: "", description: "", hasDescription: false, source: defaultHookSource, pluginId: "", hasPlugin: false, eventRef: 0, priority: 0, active: false, bypassEligibility: false, requirementRef: 0}
pure val noRegistration: HookRegistration = {id: 0, handler: 0, registeredAt: 0, registered: false, metadata: emptyMetadata, indexedEvents: Set()}
pure val eventCatalog = List("HOOK_COMMAND_NEW", "HOOK_COMMAND_RESET", "HOOK_COMMAND_STOP", "HOOK_SESSION_START", "HOOK_SESSION_END", "HOOK_AGENT_BASIC_CAPABILITIES", "HOOK_AGENT_START", "HOOK_AGENT_END", "HOOK_GATEWAY_START", "HOOK_GATEWAY_STOP", "HOOK_COMPACTION_BEFORE", "HOOK_COMPACTION_AFTER", "HOOK_TOOL_BEFORE", "HOOK_TOOL_AFTER", "HOOK_TOOL_PERSIST", "HOOK_MESSAGE_SENDING")
pure val commandEvents = List("HOOK_COMMAND_NEW")
pure val agentEvents = List("HOOK_AGENT_START")
pure val extendedEvents = List("HOOK_COMMAND_NEW", "HOOK_AGENT_START")
pure val requirementsValues = Set(emptyRequirements, {os: List("linux"), bins: List("git"), anyBins: List("node", "bun"), env: List("TOKEN"), config: List("feature.active")})
pure val namesValues = Set(List(), commandEvents, agentEvents, extendedEvents)
pure val metadataValues = Set({ ...emptyMetadata, name: "standard", eventRef: 1, active: true}, { ...emptyMetadata, name: "preferred", eventRef: 1, active: true, priority: 1, bypassEligibility: true}, { ...emptyMetadata, name: "checked", eventRef: 2, active: true, requirementRef: 1})
pure val handlerValues = Set(1, 2)
pure val priorityValues = Set(-1, 0, 1)
pure val registeredAtValues = Set(0, 1)
pure val hookIdValues = Set(1, 2, 3)
pure val callIdValues = Set(1, 2)
pure val ownerValues = Set(1)
pure val payloadRefValues = Set(1, 2)
pure val errorRefValues = Set(0, 1)
pure val referenceValues = Set(1, 2)
pure val eventNameValues = Set("HOOK_COMMAND_NEW", "HOOK_AGENT_START")
pure val platformValues = Set("linux", "darwin")
pure val environmentValues = Set(Set(), Set("TOKEN"))
pure val foundBinsValues = Set(Set(), Set("git"), Set("git", "node"))
pure val pathValues = Set("", "/usr/bin", "/opt/bin")
pure val configIdentityValues = Set(1, 2)
pure val configValues = Set(List(), List({path: "feature.active", value: ConfigBoolean({value: true})}), List({path: "feature.active", value: ConfigBoolean({value: false})}))
pure def canInstallInterceptors(s: HookService, owner: int): bool = s.installedOwner == 0 and owner > 0
pure def installInterceptors(s: HookService, owner: int): HookService = { ...s, installedOwner: owner, interceptors: eventCatalog.listMap(eventName => {eventName: eventName, owner: owner}) }
pure def eventNames(s: HookService, reference: int): List[str] = s.eventArrays.select(entry => entry.ref == reference).nthOr(0, {ref: 0, names: List()}).names
pure def requirementsAt(s: HookService, reference: int): HookRequirement = s.requirementRows.select(entry => entry.ref == reference).nthOr(0, {ref: 0, requirements: emptyRequirements}).requirements
pure def registrationAt(s: HookService, hookId: int): HookRegistration = s.registrations.select(entry => entry.id == hookId).nthOr(0, noRegistration)
pure def isRegistered(s: HookService, hookId: int): bool = s.registrations.some(entry => entry.id == hookId and entry.registered)
pure def getHook(s: HookService, hookId: int): HookRegistration = if (isRegistered(s, hookId)) registrationAt(s, hookId) else noRegistration
pure def getAllHooks(s: HookService): List[HookRegistration] = s.registrations.select(entry => entry.registered)
pure def getHooksByEvent(s: HookService, eventName: str): List[HookRegistration] = s.registrations.select(entry => entry.registered and entry.indexedEvents.contains(eventName))
pure def getSnapshot(s: HookService, timestamp: int): HookSnapshot = {hooks: getAllHooks(s).listMap(entry => {name: entry.metadata.name, eventRef: entry.metadata.eventRef, source: entry.metadata.source, active: entry.metadata.active, pluginId: entry.metadata.pluginId, hasPlugin: entry.metadata.hasPlugin, priority: entry.metadata.priority}), version: s.version, timestamp: timestamp}
pure val directoryRegistrationError: str = "registerFromDirectory is not supported in the environment-agnostic core."
pure def normalizedPriority(priority: int, finite: bool): int = if (finite) priority else 0
pure def canRegister(s: HookService, handler: int, metadata: HookMetadata, names: List[str], requirements: HookRequirement, registeredAt: int, finite: bool): bool = handler > 0 and metadata.eventRef > 0 and metadata.requirementRef >= 0
pure def register(s: HookService, handler: int, metadata: HookMetadata, names: List[str], requirements: HookRequirement, registeredAt: int, finite: bool): HookService = {
  val knownEvents = s.eventArrays.some(entry => entry.ref == metadata.eventRef)
  val knownRequirements = s.requirementRows.some(entry => entry.ref == metadata.requirementRef)
  val actualEvents = if (knownEvents) eventNames(s, metadata.eventRef) else names
  val added: HookRegistration = {id: s.nextId, handler: handler, registeredAt: registeredAt, registered: true, metadata: { ...metadata, active: true, priority: normalizedPriority(metadata.priority, finite) }, indexedEvents: actualEvents.foldl(Set(), (ever, eventName) => ever.union(Set(eventName)))}
  { ...s, registrations: s.registrations.append(added), eventArrays: if (knownEvents) s.eventArrays else s.eventArrays.append({ref: metadata.eventRef, names: names}), requirementRows: if (knownRequirements or metadata.requirementRef == 0) s.requirementRows else s.requirementRows.append({ref: metadata.requirementRef, requirements: requirements}), nextId: s.nextId + 1, version: s.version + 1 }
}
pure def canUnregister(s: HookService, hookId: int): bool = true
pure def unregister(s: HookService, hookId: int): HookService = if (not(isRegistered(s, hookId))) s else { ...s, registrations: s.registrations.listMap(entry => if (entry.id == hookId) { ...entry, registered: false, indexedEvents: entry.indexedEvents.filter(eventName => not(eventNames(s, entry.metadata.eventRef).includes(eventName))) } else entry), version: s.version + 1 }
pure def setActive(s: HookService, hookId: int, active: bool): HookService = if (not(isRegistered(s, hookId))) s else { ...s, registrations: s.registrations.listMap(entry => if (entry.id == hookId) { ...entry, metadata: { ...entry.metadata, active: active } } else entry), version: s.version + 1 }
pure def setPriority(s: HookService, hookId: int, priority: int, finite: bool): HookService = if (not(isRegistered(s, hookId))) s else { ...s, registrations: s.registrations.listMap(entry => if (entry.id == hookId) { ...entry, metadata: { ...entry.metadata, priority: normalizedPriority(priority, finite) } } else entry), version: s.version + 1 }
pure def canObserveRegistrationAlias(s: HookService, hookId: int, handler: int, metadata: HookMetadata, registeredAt: int): bool = registrationAt(s, hookId).id != 0 and handler > 0 and metadata.eventRef > 0 and metadata.requirementRef >= 0 and s.eventArrays.some(entry => entry.ref == metadata.eventRef) and (metadata.requirementRef == 0 or s.requirementRows.some(entry => entry.ref == metadata.requirementRef))
pure def observeRegistrationAlias(s: HookService, hookId: int, handler: int, metadata: HookMetadata, registeredAt: int): HookService = { ...s, registrations: s.registrations.listMap(entry => if (entry.id == hookId) { ...entry, handler: handler, metadata: metadata, registeredAt: registeredAt } else entry) }
pure def canObserveEventArray(s: HookService, reference: int, names: List[str]): bool = reference > 0
pure def observeEventArray(s: HookService, reference: int, names: List[str]): HookService = { ...s, eventArrays: if (s.eventArrays.some(entry => entry.ref == reference)) s.eventArrays.listMap(entry => if (entry.ref == reference) { ...entry, names: names } else entry) else s.eventArrays.append({ref: reference, names: names}) }
pure def canObserveRequirements(s: HookService, reference: int, requirements: HookRequirement): bool = reference > 0
pure def observeRequirements(s: HookService, reference: int, requirements: HookRequirement): HookService = { ...s, requirementRows: if (s.requirementRows.some(entry => entry.ref == reference)) s.requirementRows.listMap(entry => if (entry.ref == reference) { ...entry, requirements: requirements } else entry) else s.requirementRows.append({ref: reference, requirements: requirements}) }
pure def stopService(s: HookService): HookService = { ...s, registrations: s.registrations.listMap(entry => { ...entry, registered: false, indexedEvents: Set() }), binaryHits: Set(), interceptors: List() }
pure def alwaysRegistrationIds(s: HookService): bool = s.nextId > 0 and s.registrations.every(entry => entry.id > 0 and entry.id < s.nextId and s.registrations.select(other => other.id == entry.id).length() == 1)
pure def stepCountersNeverReset(before: HookService, after: HookService): bool = after.nextId >= before.nextId and after.version >= before.version
```

### Eligibility returns every failure in source order and caches successful binary probes

The filesystem boundary validates names and reports regular executable files on POSIX or regular files at the supported Windows suffixes. A changed raw PATH, including unset versus empty, invalidates positive entries on the next binary probe. Each probe checks all required binaries and visits alternative binaries until the first hit. Failures accumulate in platform, required binary, alternatives, environment and configuration order. The environment observation contains keys with nonempty string values. A direct requirements check with no config object skips config paths. Registration eligibility uses the service's config reference, and always-enabled hooks bypass requirements. Dispatch still respects enabled metadata. The adapter resolves JS properties along the dot-separated path after removing empty segments. Nonblank strings, nonzero numbers and objects are truthy under the source helper.

```quint
pure def configTruthy(value: ConfigValue): bool = match value { | ConfigMissing => false | ConfigNull => false | ConfigBoolean(v) => v.value | ConfigNumber(v) => v.value != 0 | ConfigText(v) => v.nonblank | _ => true }
pure def configPathTruthy(config: List[ConfigField], configPath: str): bool = configTruthy(config.select(entry => entry.path == configPath).nthOr(0, {path: "", value: absentConfigValue}).value)
pure def requiresProbe(requirements: HookRequirement): bool = requirements.bins.length() > 0 or requirements.anyBins.length() > 0
pure def requirementEligibility(requirements: HookRequirement, hits: Set[str], foundBins: Set[str], platform: str, environment: Set[str], config: List[ConfigField], hasConfig: bool): Eligibility = {
  val allHits = requirements.bins.foldl(hits, (acc, bin) => if (bin != "" and foundBins.contains(bin)) acc.union(Set(bin)) else acc)
  val positives = requirements.anyBins.select(bin => bin != "" and (allHits.contains(bin) or foundBins.contains(bin)))
  val firstAny = positives.nthOr(0, "")
  val wrongOs = if (requirements.os.length() > 0 and not(requirements.os.includes(platform))) List(WrongPlatform({currentPlatform: platform, allowedPlatforms: requirements.os})) else noReasons
  val missingBins = requirements.bins.select(bin => not(allHits.contains(bin))).listMap(bin => MissingBinary({bin: bin}))
  val missingAlternatives = if (requirements.anyBins.length() > 0 and firstAny == "") List(MissingAlternatives({choices: requirements.anyBins})) else noReasons
  val missingEnvironment = requirements.env.select(envName => not(environment.contains(envName))).listMap(envName => MissingEnvironment({envName: envName}))
  val missingConfig = if (hasConfig) requirements.config.select(configPath => not(configPathTruthy(config, configPath))).listMap(configPath => FalsyConfig({configPath: configPath})) else noReasons
  val reasons = wrongOs.concat(missingBins).concat(missingAlternatives).concat(missingEnvironment).concat(missingConfig)
  {binaryHits: if (firstAny == "") allHits else allHits.union(Set(firstAny)), eligible: reasons.length() == 0, reasons: reasons}
}
pure def samePath(s: HookService, pathPresent: bool, path: str): bool = s.pathPresent == pathPresent and (not(pathPresent) or s.path == path)
pure def binaryBaseline(s: HookService, needsBinary: bool, pathPresent: bool, path: str): Set[str] = if (not(needsBinary) or samePath(s, pathPresent, path)) s.binaryHits else Set()
pure def eligibilityState(needsBinary: bool, verdict: Eligibility, pathPresent: bool, path: str, s: HookService): HookService = { ...s, pathPresent: if (needsBinary) pathPresent else s.pathPresent, path: if (needsBinary) path else s.path, binaryHits: verdict.binaryHits, lastEligibility: {eligible: verdict.eligible, reasons: verdict.reasons} }
pure def checkRequirements(s: HookService, requirements: HookRequirement, foundBins: Set[str], platform: str, environment: Set[str], pathPresent: bool, path: str, config: List[ConfigField], hasConfig: bool): HookService = {
  val needsBinary = requiresProbe(requirements)
  eligibilityState(needsBinary, requirementEligibility(requirements, binaryBaseline(s, needsBinary, pathPresent, path), foundBins, platform, environment, config, hasConfig), pathPresent, path, s)
}
pure def checkEligibility(s: HookService, hookId: int, foundBins: Set[str], platform: str, environment: Set[str], pathPresent: bool, path: str): HookService = {
  val registration = getHook(s, hookId)
  val requirements = requirementsAt(s, registration.metadata.requirementRef)
  val needsBinary = requiresProbe(requirements)
  if (registration.id == 0) { ...s, lastEligibility: missingResult }
  else if (registration.metadata.bypassEligibility or registration.metadata.requirementRef == 0) { ...s, lastEligibility: eligibleResult }
  else eligibilityState(needsBinary, requirementEligibility(requirements, binaryBaseline(s, needsBinary, pathPresent, path), foundBins, platform, environment, s.config, true), pathPresent, path, s)
}
pure def canSetConfig(s: HookService, configIdentity: int, config: List[ConfigField]): bool = configIdentity > 0 and config.every(entry => config.select(other => other.path == entry.path).length() == 1)
pure def setConfig(s: HookService, configIdentity: int, config: List[ConfigField]): HookService = { ...s, configIdentity: configIdentity, config: config }
pure def canUpdateConfigReference(s: HookService, configIdentity: int, config: List[ConfigField]): bool = configIdentity > 0 and config.every(entry => config.select(other => other.path == entry.path).length() == 1)
pure def updateConfigReference(s: HookService, configIdentity: int, config: List[ConfigField]): HookService = if (configIdentity == s.configIdentity) { ...s, config: config } else s
```

### A captured interceptor dispatches sequentially against one payload object

The runtime supplies an interceptor handle previously allocated for this service, including when the runtime captured it before `stop` and invokes it later. Dispatch reads the current live rows and eligibility in event index order and then sorts the captured registration references by priority and timestamp. Handler lookup reads the current property of the captured registration when its turn arrives. The handler receives the original payload identity. A thrown or rejected handler settles the dispatch with that error and prevents later peers from running. The callback can modify the payload, register and unregister other hooks, or start another dispatch. The adapter retains and passes the actual payload object and reads the source callback result.

Discovered by the proof: a running handler must own a valid cursor slot in its dispatch. Bounding the idle cursor alone allowed an arbitrary state to start or finish a callback past the end of its captured list.

```quint
type DispatchEligibility = {binaryHits: Set[str], selected: List[HookRegistration]}
pure val noHooks: List[HookRegistration] = List()
pure val noCall: EventHookCall = {id: 0, payloadRef: 0, snapshot: List(), nextIndex: 0, runningHandler: 0, done: true, errorRef: 0}
pure def callAt(s: HookService, callId: int): EventHookCall = s.calls.select(entry => entry.id == callId).nthOr(0, noCall)
pure def hookBefore(first: HookRegistration, second: HookRegistration): bool = first.metadata.priority > second.metadata.priority or (first.metadata.priority == second.metadata.priority and first.registeredAt <= second.registeredAt)
pure def insertHook(hooks: List[HookRegistration], hook: HookRegistration): List[HookRegistration] = hooks.select(old => hookBefore(old, hook)).append(hook).concat(hooks.select(old => not(hookBefore(old, hook))))
pure def orderEligible(hooks: List[HookRegistration]): List[int] = hooks.foldl(noHooks, (acc, entry) => insertHook(acc, entry)).listMap(entry => entry.id)
pure def selectEligible(entry: HookRegistration, acc: DispatchEligibility, foundBins: Set[str], platform: str, environment: Set[str], s: HookService): DispatchEligibility = {
  val verdict = requirementEligibility(requirementsAt(s, entry.metadata.requirementRef), acc.binaryHits, foundBins, platform, environment, s.config, true)
  if (entry.metadata.bypassEligibility or entry.metadata.requirementRef == 0) { ...acc, selected: acc.selected.append(entry) }
  else {binaryHits: verdict.binaryHits, selected: if (verdict.eligible) acc.selected.append(entry) else acc.selected}
}
pure def canDispatch(s: HookService, callId: int, owner: int, payloadRef: int, eventName: str): bool = callId > 0 and owner > 0 and owner == s.installedOwner and payloadRef > 0 and eventCatalog.includes(eventName) and not(s.calls.some(entry => entry.id == callId))
pure def dispatch(s: HookService, callId: int, owner: int, payloadRef: int, eventName: str, foundBins: Set[str], platform: str, environment: Set[str], pathPresent: bool, path: str): HookService = {
  val checked = getHooksByEvent(s, eventName).select(entry => entry.metadata.active)
  val needsBinary = checked.some(entry => not(entry.metadata.bypassEligibility) and requiresProbe(requirementsAt(s, entry.metadata.requirementRef)))
  val initialProbe: DispatchEligibility = {binaryHits: binaryBaseline(s, needsBinary, pathPresent, path), selected: noHooks}
  val selection = checked.foldl(initialProbe, (acc, entry) => selectEligible(entry, acc, foundBins, platform, environment, s))
  val ordered = orderEligible(selection.selected)
  { ...s, pathPresent: if (needsBinary) pathPresent else s.pathPresent, path: if (needsBinary) path else s.path, binaryHits: selection.binaryHits, calls: s.calls.append({id: callId, payloadRef: payloadRef, snapshot: ordered, nextIndex: 0, runningHandler: 0, done: ordered.length() == 0, errorRef: 0}) }
}
pure def nextHandler(s: HookService, callId: int): int = {
  val call = callAt(s, callId)
  registrationAt(s, call.snapshot.nthOr(call.nextIndex, 0)).handler
}
pure def canBeginHandler(s: HookService, callId: int): bool = callId > 0 and s.calls.some(entry => entry.id == callId and not(entry.done) and entry.runningHandler == 0 and entry.nextIndex < entry.snapshot.length()) and nextHandler(s, callId) > 0
pure def beginHandler(s: HookService, callId: int): HookService = { ...s, calls: s.calls.listMap(entry => if (entry.id == callId) { ...entry, runningHandler: nextHandler(s, callId) } else entry) }
pure def canFinishHandler(s: HookService, callId: int, errorRef: int): bool = callId > 0 and errorRef >= 0 and s.calls.some(entry => entry.id == callId and entry.runningHandler > 0)
pure def finishHandler(s: HookService, callId: int, errorRef: int): HookService = { ...s, calls: s.calls.listMap(entry => if (entry.id == callId) { ...entry, runningHandler: 0, nextIndex: entry.nextIndex + 1, errorRef: errorRef, done: errorRef > 0 or entry.nextIndex + 1 == entry.snapshot.length() } else entry) }
pure def validCall(entry: EventHookCall): bool = entry.id > 0 and entry.payloadRef > 0 and entry.nextIndex >= 0 and entry.nextIndex <= entry.snapshot.length() and entry.runningHandler >= 0 and entry.errorRef >= 0 and (not(entry.done) implies entry.nextIndex < entry.snapshot.length()) and (entry.runningHandler > 0 implies not(entry.done)) and (entry.errorRef > 0 implies entry.done)
pure def alwaysDispatchBounds(s: HookService): bool = s.calls.every(entry => validCall(entry) and s.calls.select(other => other.id == entry.id).length() == 1)
pure def stepSnapshotsImmutable(before: HookService, via: str, after: HookService): bool =
  if (via == "beginHandler" or via == "finishHandler" or via == "dispatch")
    before.calls.every(entry => after.calls.some(other => other.id == entry.id and other.payloadRef == entry.payloadRef and other.snapshot == entry.snapshot))
  else before.calls == after.calls
pure def sometimesStoppedWhileSnapshotRuns(s: HookService): bool = s.installedOwner > 0 and s.interceptors.length() == 0 and s.calls.some(entry => not(entry.done))
pure def sometimesHandlerFailureStopsPeers(s: HookService): bool = s.calls.some(entry => entry.errorRef > 0 and entry.nextIndex < entry.snapshot.length())
```
