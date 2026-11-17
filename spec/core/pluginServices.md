# Plugin registration epochs and service ownership

Each registration epoch of a plugin name keeps its own [lifecycle](./plugins.md) and owns the [service instances](./serviceInstances.md) it declares; a name can be registered again after its previous epoch retires. Sources: `plugin-lifecycle.ts`, `runtime/service-lifecycle.ts`.

## Story: Retry and reload plugins without losing epoch ownership

> As a host, I want concurrent registrations of one name joined, unrelated
> names to progress independently and a registration after cleanup
> recognized as new, so that retries and reloads never confuse epochs.

### A name has at most one active registration epoch

Every new epoch has a fresh identity. Concurrent callers join the active registering epoch and observe its shared result. Registration is refused once requests are sealed or services have stopped.

```quint
import plugins as P from "./plugins"
import serviceInstances as I from "./serviceInstances"
type PluginEpoch = { id: int, name: str, lifecycle: P::PluginState }
pure val nameValues = Set("plugin-a", "plugin-b")
pure val epochIdValues = Set(1, 2, 3)
pure val absentEpoch: PluginEpoch = {id: 0, name: "", lifecycle: P::initial}
pure def epoch(s: PluginServices, epochId: int): PluginEpoch = s.epochs.select(e => e.id == epochId).nthOr(0, absentEpoch)
pure def activePhase(phase: P::PluginPhase): bool = phase == P::Registering or phase == P::Loaded or phase == P::RollingBack or phase == P::Unloading
pure def canBeginPlugin(s: PluginServices, name: str, adapter: bool): bool = not(s.requestsClosed) and not(s.services.stopped) and name != "" and not(s.epochs.some(e => e.name == name and activePhase(e.lifecycle.phase)))
pure def beginPlugin(s: PluginServices, name: str, adapter: bool): PluginServices = { ...s, epochs: s.epochs.append({id: s.nextEpoch, name: name, lifecycle: P::beginRegistration(P::initial, adapter)}), nextEpoch: s.nextEpoch + 1 }
pure def canJoinPlugin(s: PluginServices, epochId: int): bool = P::canJoinRegistration(epoch(s, epochId).lifecycle)
pure def joinPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::joinRegistration(e.lifecycle) } else e) }
pure def canCommitPlugin(s: PluginServices, epochId: int): bool = not(s.services.stopped) and P::canCommitRegistration(epoch(s, epochId).lifecycle)
pure def commitPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::commitRegistration(e.lifecycle) } else e) }
pure def alwaysEpochIdentityUnique(s: PluginServices): bool = s.nextEpoch > 0 and s.epochs.every(e => e.id > 0 and e.id < s.nextEpoch and s.epochs.select(other => other.id == e.id).length() == 1)
pure def alwaysOneActiveEpochPerName(s: PluginServices): bool = s.epochs.every(e => activePhase(e.lifecycle.phase) implies s.epochs.select(other => other.name == e.name and activePhase(other.lifecycle.phase)).length() == 1)
pure def alwaysEpochOutcomeHonest(s: PluginServices): bool = s.epochs.every(e => P::alwaysRegistrationOutcomeAgrees(e.lifecycle) and P::alwaysOneDispose(e.lifecycle) and P::alwaysCleanedHasNoContributions(e.lifecycle) and P::alwaysServiceStopsOnce(e.lifecycle) and P::alwaysConnectorWithdrawalFollowsDisposal(e.lifecycle))
pure def sometimesIndependentPluginLoads(s: PluginServices): bool = s.epochs.some(a => s.epochs.some(b => a.name != b.name and a.lifecycle.phase == P::Loaded and b.lifecycle.phase == P::Registering))
```

### A retired epoch cannot mutate a replacement epoch

Cleanup completion is scoped to the captured epoch identity. A failed registration can be retried after its cleanup finishes. Each retirement belongs to one existing epoch that no longer admits classes, so an epoch is retired at most once.

```quint
pure def canDisposePlugin(s: PluginServices, epochId: int, ok: bool): bool = P::canFinishDispose(epoch(s, epochId).lifecycle, ok)
pure def disposePlugin(s: PluginServices, epochId: int, ok: bool): PluginServices = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::finishDispose(e.lifecycle, ok) } else e) }
pure def canCleanPlugin(s: PluginServices, epochId: int): bool = P::canFinishCleanup(epoch(s, epochId).lifecycle) and retirementSettled(s, epochId)
pure def cleanPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::finishCleanup(e.lifecycle) } else e) }
pure def sometimesFailedRegistrationRetried(s: PluginServices): bool = s.epochs.some(a => a.lifecycle.phase == P::RegistrationFailed and s.epochs.some(b => a.name == b.name and b.id > a.id and b.lifecycle.phase == P::Registering))
pure def alwaysRetirementPerRetiredEpoch(s: PluginServices): bool = s.retirements.every(r => r.epochId > 0 and epoch(s, r.epochId).id == r.epochId and not(epochAdmitsClass(s, r.epochId)) and s.retirements.select(other => other.epochId == r.epochId).length() == 1)
pure def sometimesPluginReloaded(s: PluginServices): bool = s.epochs.some(a => a.lifecycle.phase == P::Unloaded and s.epochs.some(b => a.name == b.name and b.id > a.id and b.lifecycle.phase == P::Loaded))
```

### Connector publication follows the captured owner's withdrawal fence

Send-handler, message-connector and post-connector publication use the same
captured owner gate. An owner reference names its original registration epoch,
even after a same-name reload or a change to the service class-owner map.
While that owner awaits disposal, its captured callbacks can still publish.
The disposal continuation fences only that exact owner before connector
removal and service teardown. A withdrawn callback returns before either
the original registry operation or its ownership claim can run.

The adapter assigns each actual captured ownership reference to its retained
registration epoch. Only references established by that identity mapping are
admitted captured-owner observations. An unassigned numeric reference receives
the model boundary's `BlockPublication` validation result. The adapter maps
absent capture and capture from a different runtime to `UnownedCall`, which
delegates. Disposal and configuration callbacks inherit
their caller's ambient capture as their publication owner. The three
publication flavors delegate their existing registry behavior and collision
policies after this gate.
Connector removal has its own outcome. A traversal failure can retain an
existing registry entry while the owner's publication gate remains closed.

```quint
type ConnectorCapture = UnownedCall | CapturedOwner({epochId: int})
type ConnectorPublication = SendHandlerPublication | MessageConnectorPublication | PostConnectorPublication
type ConnectorPublicationDecision = DelegatePublication | BlockPublication
pure val captureValues = Set(UnownedCall, CapturedOwner({epochId: 1}), CapturedOwner({epochId: 2}), CapturedOwner({epochId: 3}))
pure val publicationValues = Set(SendHandlerPublication, MessageConnectorPublication, PostConnectorPublication)
pure def connectorPublicationDecision(s: PluginServices, capture: ConnectorCapture, publication: ConnectorPublication): ConnectorPublicationDecision = {
  val captured = match capture { | UnownedCall => absentEpoch | CapturedOwner(owner) => epoch(s, owner.epochId) }
  match capture {
    | UnownedCall => DelegatePublication
    | CapturedOwner(owner) => if (owner.epochId > 0 and captured.id == owner.epochId and P::canOwnConnector(captured.lifecycle)) DelegatePublication else BlockPublication
  }
}
pure def lawUnownedConnectorPublicationDelegates(s: PluginServices, publication: ConnectorPublication): bool =
  connectorPublicationDecision(s, UnownedCall, publication) == DelegatePublication
pure def lawWithdrawnConnectorOwnerIsBlocked(s: PluginServices, epochId: int, publication: ConnectorPublication): bool = {
  val captured = epoch(s, epochId)
  epochId > 0 and captured.id == epochId and captured.lifecycle.connectorsWithdrawn implies
    connectorPublicationDecision(s, CapturedOwner({epochId: epochId}), publication) == BlockPublication
}
pure def lawOpenConnectorOwnerDelegates(s: PluginServices, epochId: int, publication: ConnectorPublication): bool = {
  val captured = epoch(s, epochId)
  epochId > 0 and captured.id == epochId and captured.lifecycle.phase != P::Absent and not(captured.lifecycle.connectorsWithdrawn) implies
    connectorPublicationDecision(s, CapturedOwner({epochId: epochId}), publication) == DelegatePublication
}
pure def lawConnectorPublicationFlavorsShareTheOwnerGate(s: PluginServices, capture: ConnectorCapture): bool =
  connectorPublicationDecision(s, capture, SendHandlerPublication) == connectorPublicationDecision(s, capture, MessageConnectorPublication) and
  connectorPublicationDecision(s, capture, MessageConnectorPublication) == connectorPublicationDecision(s, capture, PostConnectorPublication)
pure def lawDisposeContinuationBlocksItsCapturedOwner(s: PluginServices, epochId: int, ok: bool, publication: ConnectorPublication): bool =
  alwaysEpochIdentityUnique(s) and epochId > 0 and canDisposePlugin(s, epochId, ok) implies
    connectorPublicationDecision(disposePlugin(s, epochId, ok), CapturedOwner({epochId: epochId}), publication) == BlockPublication
pure def lawDisposalKeepsOtherCapturedOwners(s: PluginServices, epochId: int, otherId: int, ok: bool, publication: ConnectorPublication): bool =
  alwaysEpochIdentityUnique(s) and epochId != otherId implies
    connectorPublicationDecision(disposePlugin(s, epochId, ok), CapturedOwner({epochId: otherId}), publication) == connectorPublicationDecision(s, CapturedOwner({epochId: otherId}), publication)
```

### Resource ownership remains with active registration epochs

Only registering or loaded epochs admit new owned classes. Retiring epochs continue to own their original resources until cleanup completes.

```quint
pure def epochDisposalFinished(s: PluginServices, epochId: int): bool = epoch(s, epochId).id != 0 and not(epoch(s, epochId).lifecycle.disposePending)
pure def epochAdmitsClass(s: PluginServices, epochId: int): bool = epoch(s, epochId).lifecycle.phase == P::Registering or epoch(s, epochId).lifecycle.phase == P::Loaded
pure def epochOwnsResources(s: PluginServices, epochId: int): bool = epoch(s, epochId).id != 0 and activePhase(epoch(s, epochId).lifecycle.phase)
pure def epochRetiring(s: PluginServices, epochId: int): bool = epoch(s, epochId).lifecycle.phase == P::RollingBack or epoch(s, epochId).lifecycle.phase == P::Unloading
pure def epochOperationSettled(s: PluginServices, epochId: int): bool = epoch(s, epochId).id != 0 and not(epoch(s, epochId).lifecycle.phase == P::Registering or epochRetiring(s, epochId))
```

## Story: Withdraw plugin declarations without losing asynchronous instances

> As a host, I want to unload a plugin while original starts and shared stop
> promises are pending, so that no asynchronous service instance is lost or
> leaked.

Duplicate declarations of the same class reference share its start and instance. Unloading either declaring plugin removes every occurrence of that class, matching the source's alias behavior.

### Plugin epochs own declaration receipts while classes share instance identity

A declaration receipt retains its plugin epoch, class identity, and service
type. Each receipt names a known class with a positive identity and the type
it was declared with. A class keeps that type after withdrawal, so retirement
uses the same service-type bucket that owned the declaration when it was
registered. Only a registered class holds a live instance. Until the runtime
stops, a start still being invoked is its class's pending attempt and that
class holds no live instance yet.

```quint
type RetirementGroupPhase = GroupWaiting | GroupStoppingInstances | GroupStoppingClasses | GroupFinished | GroupSkipped | GroupFailed
type ClassHookPhase = HookReady | HookPending | HookFinished | HookFailed
type RetireClass = {id: int, hasStopHook: bool}
type CapturedInstances = {seen: Set[int], instances: List[int]}
type OwnedClass = {epochId: int, classId: int, serviceType: str, hasStopHook: bool}
type InstanceStopObservation = UncheckedStopSlot | AwaitedStopSlot | MissingStopSlot
type InstanceSlot = {instanceId: int, observed: InstanceStopObservation}
type RetirementGroup = {serviceType: str, classes: List[RetireClass], starts: List[int], aggregate: int, instances: List[int], observedStops: List[InstanceSlot], phase: RetirementGroupPhase, instanceCursor: int, classCursor: int, hook: ClassHookPhase}
type SequenceValidation = {index: int, valid: bool}
type ServiceRetirement = {epochId: int, plan: List[str], groups: List[RetirementGroup], cursor: int, failures: List[str], exited: bool, hookError: str}
type PluginServices = {epochs: List[PluginEpoch], nextEpoch: int, services: I::ServiceInstances, ownership: List[OwnedClass], liveOwners: List[OwnedClass], retirements: List[ServiceRetirement], requestsClosed: bool}
pure val initial: PluginServices = {epochs: List(), nextEpoch: 1, services: I::initial, ownership: List(), liveOwners: List(), retirements: List(), requestsClosed: false}
pure def canRegisterOwnedClass(s: PluginServices, epochId: int, classId: int, serviceType: str, hasStopHook: bool): bool = not(s.requestsClosed) and epochAdmitsClass(s, epochId) and I::canRegisterClass(s.services, classId, serviceType)
pure def registerOwnedClass(s: PluginServices, epochId: int, classId: int, serviceType: str, hasStopHook: bool): PluginServices = {
  val captured: OwnedClass = {epochId: epochId, classId: classId, serviceType: serviceType, hasStopHook: hasStopHook}
  { ...s, services: I::registerClass(s.services, classId, serviceType), ownership: s.ownership.append(captured), liveOwners: s.liveOwners.select(o => o.classId != classId).append(captured) }
}
pure def canFinishInitialization(s: PluginServices, ok: bool): bool = I::canFinishInitialization(s.services, ok)
pure def finishInitialization(s: PluginServices, ok: bool): PluginServices = { ...s, services: I::finishInitialization(s.services, ok) }
pure def canEnsureServices(s: PluginServices, callId: int, serviceType: str): bool = not(s.requestsClosed) and I::canAcquireServices(s.services, callId, serviceType)
pure def ensureServices(s: PluginServices, callId: int, serviceType: str): PluginServices = { ...s, services: I::acquireServices(s.services, callId, serviceType) }
pure def canResumeEnsure(s: PluginServices, callId: int): bool = I::canResumeAcquire(s.services, callId)
pure def resumeEnsure(s: PluginServices, callId: int): PluginServices = { ...s, services: I::resumeAcquire(s.services, callId) }
pure def canFinishClassStart(s: PluginServices, attemptId: int, instanceId: int): bool = I::canReturnInstance(s.services, attemptId, instanceId)
pure def finishClassStart(s: PluginServices, attemptId: int, instanceId: int): PluginServices = { ...s, services: I::returnInstance(s.services, attemptId, instanceId) }
pure def canFailClassStart(s: PluginServices, attemptId: int, errorId: str): bool = I::canFailStart(s.services, attemptId, errorId)
pure def failClassStart(s: PluginServices, attemptId: int, errorId: str): PluginServices = { ...s, services: I::failStart(s.services, attemptId, errorId) }
pure def canFinishClassObserver(s: PluginServices, attemptId: int, ok: bool): bool = I::canFinishObserver(s.services, attemptId, ok)
pure def finishClassObserver(s: PluginServices, attemptId: int, ok: bool): PluginServices = { ...s, services: I::finishObserver(s.services, attemptId, ok) }
pure def canResolveNextStart(s: PluginServices, ok: bool, instanceId: int, errorId: str): bool = I::canResolveNextStart(s.services, ok, instanceId, errorId)
pure def resolveNextStart(s: PluginServices, ok: bool, instanceId: int, errorId: str): PluginServices = { ...s, services: I::resolveNextStart(s.services, ok, instanceId, errorId) }
pure def canFinishNextObserver(s: PluginServices, ok: bool): bool = I::canFinishNextObserver(s.services, ok)
pure def finishNextObserver(s: PluginServices, ok: bool): PluginServices = { ...s, services: I::finishNextObserver(s.services, ok) }
pure def canFinishNextLateStart(s: PluginServices): bool = I::canFinishNextLateStart(s.services)
pure def finishNextLateStart(s: PluginServices): PluginServices = { ...s, services: I::finishNextLateStart(s.services) }
pure def canSettleEnsure(s: PluginServices, callId: int): bool = I::canSettleAcquire(s.services, callId)
pure def settleEnsure(s: PluginServices, callId: int): PluginServices = { ...s, services: I::settleAcquire(s.services, callId) }
pure def currentClassOwner(s: PluginServices, classId: int): int = s.liveOwners.select(o => o.classId == classId).listMap(o => o.epochId).nthOr(0, 0)
pure def alwaysLiveClassOwnerUnique(s: PluginServices): bool = s.liveOwners.every(o => s.ownership.includes(o) and s.liveOwners.select(other => other.classId == o.classId).length() == 1)
pure def alwaysServiceOwnerEpochExists(s: PluginServices): bool = s.ownership.every(o => epoch(s, o.epochId).id == o.epochId)
pure def alwaysChildLifecyclesValid(s: PluginServices): bool = I::alwaysTypeEntriesUnique(s.services) and I::alwaysTypeReferencesRetained(s.services) and I::alwaysAggregateAndLoadIdsUnique(s.services) and I::alwaysAcquisitionIdsUnique(s.services) and I::alwaysInitWaitingHasNoAggregate(s.services) and I::alwaysClassAndObjectIdentities(s.services) and I::alwaysPendingAttemptsOwned(s.services) and I::alwaysCapturedAttemptsExist(s.services) and I::alwaysDeclarationsMatch(s.services) and I::alwaysObjectStopOnce(s.services) and I::alwaysClassOwnsKnownObjects(s.services) and I::alwaysPublicationIdentitiesValid(s.services) and I::alwaysAttemptGeneration(s.services) and I::alwaysStoppedHasNoPublication(s.services) and I::alwaysFailedTypeHasNoPublication(s.services)
pure def alwaysOwnedClassesMatchServices(s: PluginServices): bool = s.ownership.every(o => o.classId > 0 and I::serviceClass(s.services, o.classId).id == o.classId and I::serviceClass(s.services, o.classId).serviceType == o.serviceType) and s.services.classes.every(c => c.live == 0 or c.registered)
pure def alwaysInvokingStartHasNoInstance(s: PluginServices): bool = not(s.services.stopped) implies s.services.attempts.every(a => a.phase == I::StartInvoking implies I::serviceClass(s.services, a.classId).pending == a.id and I::serviceClass(s.services, a.classId).live == 0)
pure def sometimesTwoPluginsOwnServices(s: PluginServices): bool = s.ownership.some(a => s.ownership.some(b => a.epochId != b.epochId and I::serviceClass(s.services, a.classId).live != 0 and I::serviceClass(s.services, b.classId).live != 0))
```

### Teardown processes each service type after disposal

The original registration order determines the first occurrence of each
service type. Disposal completes before the service loop. Each iteration
withdraws only that group's classes and published instances, captures the
type aggregate and class starts present at withdrawal, then awaits them.
Sibling types stay visible until the loop reaches them. After settlement,
the group reconciles status against current declarations and publication
before claiming any captured stop.

Withdrawal filters the current type array by captured object identity.
Different classes can return the same object. An unrelated class keeps
its instance reference even when the object drops out of the type array.
A subsequent successful start rebuilds the array from the class map and
may publish that identity again before the captured teardown finishes.
Repeated declarations of one class produce one captured stop slot because
the first lookup deletes the per-class instance. Distinct classes can
produce separate slots with the same object and share one stop promise.

A retirement visits its planned types in order, one group per type. Every
group before the cursor is finished or skipped, the group at the cursor is
the one in progress, and the retirement has exited exactly when that group
failed, so only the current group can fail a class hook and end the loop. A
waiting group has passed no instance slot, a group stopping
instances has one left, and every other group has passed them all.

```quint
pure val noRetirement: ServiceRetirement = {epochId: 0, plan: List(), groups: List(), cursor: 0, failures: List(), exited: false, hookError: ""}
pure val noGroup: RetirementGroup = {serviceType: "", classes: List(), starts: List(), aggregate: 0, instances: List(), observedStops: List(), phase: GroupFinished, instanceCursor: 0, classCursor: 0, hook: HookReady}
pure val noRetireClass: RetireClass = {id: 0, hasStopHook: false}
pure def retirement(s: PluginServices, epochId: int): ServiceRetirement = s.retirements.select(r => r.epochId == epochId).nthOr(0, noRetirement)
pure def currentGroup(s: PluginServices, epochId: int): RetirementGroup = retirement(s, epochId).groups.nthOr(retirement(s, epochId).cursor, noGroup)
pure def plannedTypes(s: PluginServices, epochId: int): List[str] = s.ownership.select(o => o.epochId == epochId).foldl(List(), (types, owner) => if (types.includes(owner.serviceType)) types else types.append(owner.serviceType))
pure def captureRetirement(epochId: int, s: PluginServices): PluginServices = { ...s, retirements: s.retirements.append({epochId: epochId, plan: plannedTypes(s, epochId), groups: List(), cursor: 0, failures: List(), exited: false, hookError: ""}) }
pure def canFailPlugin(s: PluginServices, epochId: int): bool = P::canFailRegistration(epoch(s, epochId).lifecycle)
pure def failPlugin(s: PluginServices, epochId: int): PluginServices = captureRetirement(epochId, { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::failRegistration(e.lifecycle) } else e) })
pure def canUnloadPlugin(s: PluginServices, epochId: int): bool = P::canBeginUnload(epoch(s, epochId).lifecycle)
pure def unloadPlugin(s: PluginServices, epochId: int): PluginServices = captureRetirement(epochId, { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::beginUnload(e.lifecycle) } else e) })
pure def canWithdrawNextType(s: PluginServices, epochId: int): bool = {
  val r = retirement(s, epochId)
  epochRetiring(s, epochId) and epochDisposalFinished(s, epochId) and not(r.exited) and r.cursor == r.groups.length() and r.cursor < r.plan.length()
}
pure val noCapturedInstances: CapturedInstances = {seen: Set(), instances: List()}
pure def captureClassInstance(captured: CapturedInstances, classId: int, services: I::ServiceInstances): CapturedInstances = {
  val instance = I::serviceClass(services, classId).live
  {seen: captured.seen.union(Set(classId)), instances: if (instance != 0 and not(captured.seen.contains(classId))) captured.instances.append(instance) else captured.instances}
}
pure def captureOwnedInstances(classes: List[RetireClass], services: I::ServiceInstances): List[int] = {
  val result = classes.foldl(noCapturedInstances, (capture, c) => captureClassInstance(capture, c.id, services))
  result.instances
}
pure def retirementClassesForType(s: PluginServices, epochId: int, serviceType: str): List[RetireClass] =
  s.ownership.select(o => o.epochId == epochId and o.serviceType == serviceType).listMap(o => {id: o.classId, hasStopHook: o.hasStopHook})
pure def withdrawRetiringClasses(classes: List[RetireClass], s: I::ServiceInstances): I::ServiceInstances =
  classes.foldl(s, (acc, c) => I::withdrawClass(c.id, acc))
pure def withdrawNextType(s: PluginServices, epochId: int): PluginServices = {
  val r = retirement(s, epochId)
  val serviceType = r.plan.nthOr(r.cursor, "")
  val skip = not(s.services.declarations.some(d => d.serviceType == serviceType))
  val classes = retirementClassesForType(s, epochId, serviceType)
  val captured = classes.listMap(c => I::serviceClass(s.services, c.id))
  val group: RetirementGroup = {serviceType: serviceType, classes: if (skip) List() else classes, starts: if (skip) List() else captured.select(c => c.pending != 0).listMap(c => c.pending), aggregate: if (skip) 0 else I::serviceTypeEntry(s.services, serviceType).latestAggregate, instances: if (skip) List() else captureOwnedInstances(classes, s.services), observedStops: List(), phase: if (skip) GroupSkipped else GroupWaiting, instanceCursor: 0, classCursor: 0, hook: HookReady}
  val withdrawn = if (skip) s.services else withdrawRetiringClasses(classes, s.services)
  val services = if (skip) withdrawn else I::removePublishedInstances(serviceType, group.instances, withdrawn)
  { ...s, services: services, retirements: s.retirements.listMap(x => if (x.epochId == epochId) { ...x, groups: x.groups.append(group), cursor: x.cursor + (if (skip) 1 else 0) } else x) }
}
pure def canSettleTypeAggregate(s: PluginServices, callId: int): bool = I::canSettleTypeAggregate(s.services, callId)
pure def settleTypeAggregate(s: PluginServices, callId: int): PluginServices = { ...s, services: I::settleTypeAggregate(s.services, callId) }
pure def canClearTypeAggregate(s: PluginServices, callId: int): bool = I::canClearTypeAggregate(s.services, callId)
pure def clearTypeAggregate(s: PluginServices, callId: int): PluginServices = { ...s, services: I::clearTypeAggregate(s.services, callId) }
pure def startsSettled(s: PluginServices, epochId: int): bool = capturedStartsSettled(s, currentGroup(s, epochId))
pure def capturedStartsSettled(s: PluginServices, g: RetirementGroup): bool = g.starts.every(id => I::attemptSettled(s.services, id)) and (g.aggregate == 0 or I::typeAggregate(s.services, g.aggregate).settled)
pure def putCurrentGroup(g: RetirementGroup, epochId: int, s: PluginServices): PluginServices = { ...s, retirements: s.retirements.listMap(r => if (r.epochId == epochId) { ...r, groups: r.groups.listMap(other => if (other.serviceType == g.serviceType) g else other) } else r) }
pure def canRequestOwnedStops(s: PluginServices, epochId: int): bool = currentGroup(s, epochId).phase == GroupWaiting and startsSettled(s, epochId)
type PlanCheck = {position: int, followed: bool}
pure val unplannedGroups: PlanCheck = {position: 0, followed: true}
pure def checkGroupPlan(check: PlanCheck, r: ServiceRetirement, g: RetirementGroup): PlanCheck = {position: check.position + 1, followed: check.followed and r.plan.nthOr(check.position, "") == g.serviceType}
pure def groupsFollowPlan(r: ServiceRetirement): bool = r.groups.foldl(unplannedGroups, (check, g) => checkGroupPlan(check, r, g)).followed
pure def isCurrentGroup(r: ServiceRetirement, g: RetirementGroup): bool = r.groups.length() == r.cursor + 1 and r.groups.nthOr(r.cursor, noGroup).serviceType == g.serviceType
pure def groupSlotsPassed(g: RetirementGroup): bool = if (g.phase == GroupWaiting) g.instanceCursor == 0 else if (g.phase == GroupStoppingInstances) g.instanceCursor < g.instances.length() else g.instanceCursor == g.instances.length()
pure def retirementShaped(r: ServiceRetirement): bool = r.cursor >= 0 and r.cursor <= r.groups.length() and r.groups.length() <= r.cursor + 1 and r.groups.length() <= r.plan.length() and r.plan.every(t => r.plan.select(u => u == t).length() == 1) and groupsFollowPlan(r) and r.groups.every(g => groupSlotsPassed(g) and ((g.phase == GroupFinished or g.phase == GroupSkipped) iff not(isCurrentGroup(r, g)))) and (r.exited iff (r.groups.length() == r.cursor + 1 and r.groups.nthOr(r.cursor, noGroup).phase == GroupFailed))
pure def alwaysRetirementFollowsPlan(s: PluginServices): bool = s.retirements.every(r => retirementShaped(r))
pure def requestOwnedStops(s: PluginServices, epochId: int): PluginServices = {
  val g = currentGroup(s, epochId)
  putCurrentGroup({ ...g, phase: if (g.instances.length() == 0) GroupStoppingClasses else GroupStoppingInstances }, epochId, { ...s, services: I::reconcileType(g.serviceType, s.services) })
}
```

### Captured instance stops and class hooks settle in source order

A class's old failure flag is removed immediately before its hook. The class
owner mapping is deleted after a fulfilled hook only if it still names the
retiring epoch. A successor registration retains its mapping. The ownership
history remains available independently of the live class-owner map.

An instance stop uses the shared runtime stop-once owner, so plugin unload
and runtime shutdown can join the exact same attempt. A rejected instance
stop adds its original error identity and then advances to the next.
A missing or non-callable instance stop advances the slot synchronously and
records the boundary observation without invoking or joining a stop promise.
Class hooks start after every captured instance slot settles. A finished or
failed class phase retains those settled observations.
The observation is scoped to that slot because a plugin object may expose
a different method when another slot reads the property. Runtime shutdown
and late-start retirement have a distinct malformed-object reporting path.
Those paths in the shared service owner currently project callable instances.
A missing static class hook completes its slot immediately. An invoked hook
awaits its own outcome. That hook's rejection ends the service loop before
advancing the class or any later service type, preserves its original failure,
and leaves outer plugin teardown eligible to continue.

Once a group has reconciled its type, that type stays unknown while no class
declares it and no withdrawal of it is still waiting, until the runtime stops.
Reconciliation happens before the first captured stop or class hook, and a
finished or failed group keeps that status rule while teardown processes
later service types. A skipped group captures no instance slot. A live
instance of a registered class that no stop has claimed stays published under
its type or held by a retirement group, so runtime shutdown or teardown
reaches it. Runtime shutdown reads the published arrays, so an object that no
stop has claimed and no retirement group holds is the live instance of a
registered class and is published.

```quint
pure def currentInstance(s: PluginServices, epochId: int): int = currentGroup(s, epochId).instances.nthOr(currentGroup(s, epochId).instanceCursor, 0)
pure val noObservedInstanceSlot: InstanceSlot = {instanceId: 0, observed: UncheckedStopSlot}
pure def stopSlotObservation(g: RetirementGroup): InstanceStopObservation = g.observedStops.nthOr(g.instanceCursor, noObservedInstanceSlot).observed
pure def observedInstanceSlot(instanceId: int, observation: InstanceStopObservation): InstanceSlot = {instanceId: instanceId, observed: observation}
pure def canClaimInstanceStop(s: PluginServices, epochId: int): bool = {
  val g = currentGroup(s, epochId)
  g.phase == GroupStoppingInstances and g.observedStops.length() == g.instanceCursor and I::serviceObject(s.services, currentInstance(s, epochId)).id != 0
}
pure def claimInstanceStop(s: PluginServices, epochId: int): PluginServices = {
  val g = currentGroup(s, epochId)
  val id = currentInstance(s, epochId)
  val slot = observedInstanceSlot(id, AwaitedStopSlot)
  putCurrentGroup({ ...g, observedStops: g.observedStops.append(slot) }, epochId, { ...s, services: I::stopObjectOnce(id, s.services) })
}
pure def canSkipMissingStop(s: PluginServices, epochId: int): bool = canClaimInstanceStop(s, epochId)
pure def advanceInstanceSlot(g: RetirementGroup): RetirementGroup = { ...g, instanceCursor: g.instanceCursor + 1, phase: if (g.instanceCursor + 1 == g.instances.length()) GroupStoppingClasses else GroupStoppingInstances }
pure def skipMissingStop(s: PluginServices, epochId: int): PluginServices = {
  val g = currentGroup(s, epochId)
  val slot = observedInstanceSlot(currentInstance(s, epochId), MissingStopSlot)
  putCurrentGroup(advanceInstanceSlot({ ...g, observedStops: g.observedStops.append(slot) }), epochId, s)
}
pure def canInvokeClassStop(s: PluginServices, instanceId: int): bool = I::canInvokeObjectStop(s.services, instanceId)
pure def invokeClassStop(s: PluginServices, instanceId: int): PluginServices = { ...s, services: I::invokeObjectStop(s.services, instanceId) }
pure def canFinishClassStop(s: PluginServices, instanceId: int, ok: bool, errorId: str): bool = I::canSettleObjectStop(s.services, instanceId, ok, errorId)
pure def finishClassStop(s: PluginServices, instanceId: int, ok: bool, errorId: str): PluginServices = { ...s, services: I::settleObjectStop(s.services, instanceId, ok, errorId) }
pure def canObserveInstanceStop(s: PluginServices, epochId: int): bool = {
  val g = currentGroup(s, epochId)
  val o = I::serviceObject(s.services, currentInstance(s, epochId))
  g.phase == GroupStoppingInstances and stopSlotObservation(g) == AwaitedStopSlot and o.id != 0 and (o.stopPhase == I::StopSucceeded or o.stopPhase == I::StopFailed)
}
pure def observeInstanceStop(s: PluginServices, epochId: int): PluginServices = {
  val g = currentGroup(s, epochId)
  val o = I::serviceObject(s.services, currentInstance(s, epochId))
  val counted = { ...s, retirements: s.retirements.listMap(r => if (r.epochId == epochId and o.stopPhase == I::StopFailed) { ...r, failures: r.failures.append(o.errorId) } else r) }
  putCurrentGroup(advanceInstanceSlot(g), epochId, counted)
}
pure def currentClassHook(s: PluginServices, epochId: int): RetireClass = currentGroup(s, epochId).classes.nthOr(currentGroup(s, epochId).classCursor, noRetireClass)
pure def canInvokeClassHook(s: PluginServices, epochId: int): bool = currentGroup(s, epochId).phase == GroupStoppingClasses and currentGroup(s, epochId).hook == HookReady and currentClassHook(s, epochId).hasStopHook
pure def clearRetiredClassFailure(classId: int, s: PluginServices): PluginServices = { ...s, services: { ...s.services, classes: s.services.classes.listMap(c => if (c.id == classId) { ...c, failed: false } else c) } }
pure def invokeClassHook(s: PluginServices, epochId: int): PluginServices = putCurrentGroup({ ...currentGroup(s, epochId), hook: HookPending }, epochId, clearRetiredClassFailure(currentClassHook(s, epochId).id, s))
pure def canFinishClassHook(s: PluginServices, epochId: int, ok: bool, errorId: str): bool = currentGroup(s, epochId).phase == GroupStoppingClasses and currentGroup(s, epochId).hook == HookPending
pure def finishClassHook(s: PluginServices, epochId: int, ok: bool, errorId: str): PluginServices = {
  val g = currentGroup(s, epochId)
  if (ok) putCurrentGroup({ ...g, hook: HookFinished }, epochId, s)
  else putCurrentGroup({ ...g, hook: HookFailed, phase: GroupFailed }, epochId, { ...s, retirements: s.retirements.listMap(r => if (r.epochId == epochId) { ...r, exited: true, hookError: errorId } else r) })
}
pure def canFinishClassSlot(s: PluginServices, epochId: int): bool = {
  val g = currentGroup(s, epochId)
  val c = currentClassHook(s, epochId)
  g.phase == GroupStoppingClasses and c.id != 0 and (g.hook == HookFinished or (g.hook == HookReady and not(c.hasStopHook)))
}
pure def finishClassSlot(s: PluginServices, epochId: int): PluginServices = {
  val g = currentGroup(s, epochId)
  val c = currentClassHook(s, epochId)
  val cleared = if (g.hook == HookReady) clearRetiredClassFailure(c.id, s) else s
  val updated = { ...cleared, liveOwners: cleared.liveOwners.select(o => o.classId != c.id or o.epochId != epochId) }
  putCurrentGroup({ ...g, classCursor: g.classCursor + 1, hook: HookReady }, epochId, updated)
}
pure def canFinishRetirementGroup(s: PluginServices, epochId: int): bool = currentGroup(s, epochId).phase == GroupStoppingClasses and currentGroup(s, epochId).classCursor == currentGroup(s, epochId).classes.length()
pure def finishRetirementGroup(s: PluginServices, epochId: int): PluginServices = {
  val updated = putCurrentGroup({ ...currentGroup(s, epochId), phase: GroupFinished }, epochId, s)
  { ...updated, retirements: updated.retirements.listMap(r => if (r.epochId == epochId) { ...r, cursor: r.cursor + 1 } else r) }
}
pure def canFinishLateStart(s: PluginServices, attemptId: int): bool = I::canFinishLateStart(s.services, attemptId)
pure def finishLateStart(s: PluginServices, attemptId: int): PluginServices = { ...s, services: I::finishLateStart(s.services, attemptId) }
pure def retirementSettled(s: PluginServices, epochId: int): bool = {
  val r = retirement(s, epochId)
  r.epochId != 0 and (r.exited or r.cursor == r.plan.length())
}
pure def canStopServices(s: PluginServices): bool = I::canStopRuntime(s.services)
pure def stopServices(s: PluginServices): PluginServices = { ...s, services: I::stopRuntime(s.services) }
pure def stopSlotSettled(slot: InstanceSlot, services: I::ServiceInstances): bool = {
  val objectStop = I::serviceObject(services, slot.instanceId).stopPhase
  slot.observed == MissingStopSlot or (slot.observed == AwaitedStopSlot and (objectStop == I::StopSucceeded or objectStop == I::StopFailed))
}
pure def missingStopObservedFor(g: RetirementGroup, instanceId: int): bool = g.observedStops.some(slot => slot.instanceId == instanceId and slot.observed == MissingStopSlot)
pure def alwaysLiveInstanceReachable(s: PluginServices): bool = s.services.classes.every(c => c.live == 0 or not(c.registered) or I::serviceObject(s.services, c.live).stopCalls > 0 or I::publishedInstances(s.services, c.serviceType).includes(c.live) or s.retirements.some(r => r.groups.some(g => missingStopObservedFor(g, c.live) or (epochOwnsResources(s, r.epochId) and g.instances.includes(c.live)))))
pure def alwaysNoOrphanInstance(s: PluginServices): bool = s.services.objects.every(o => o.stopCalls > 0 or (s.services.classes.some(c => c.live == o.id and c.registered) and s.services.published.some(p => p.instances.includes(o.id))) or s.retirements.some(r => r.groups.some(g => missingStopObservedFor(g, o.id) or (epochOwnsResources(s, r.epochId) and g.instances.includes(o.id)))))
pure def validStopObservation(g: RetirementGroup, i: int, slot: InstanceSlot, services: I::ServiceInstances): bool = {
  slot.instanceId == g.instances.nthOr(i, 0) and
    (if (i < g.instanceCursor) stopSlotSettled(slot, services) else g.phase == GroupStoppingInstances and slot.observed == AwaitedStopSlot)
}
pure val uncheckedSequence: SequenceValidation = {index: 0, valid: true}
pure def validateNextStop(check: SequenceValidation, g: RetirementGroup, slot: InstanceSlot, services: I::ServiceInstances): SequenceValidation = {index: check.index + 1, valid: check.valid and validStopObservation(g, check.index, slot, services)}
pure def allStopObservationsValid(g: RetirementGroup, services: I::ServiceInstances): bool = g.observedStops.foldl(uncheckedSequence, (check, slot) => validateNextStop(check, g, slot, services)).valid
pure def classPhaseFollowsInstances(g: RetirementGroup): bool =
  ((g.phase == GroupStoppingClasses or g.phase == GroupFinished or g.phase == GroupFailed) implies
    g.instanceCursor == g.instances.length())
  and (g.phase == GroupSkipped implies g.instanceCursor == 0 and g.instances.length() == 0)
pure def alwaysStopObservationsFollowSlots(s: PluginServices): bool = s.retirements.every(r => r.groups.every(g => g.instanceCursor >= 0 and g.instanceCursor <= g.instances.length() and g.observedStops.length() >= g.instanceCursor and g.observedStops.length() <= g.instances.length() and g.observedStops.length() <= g.instanceCursor + 1 and classPhaseFollowsInstances(g) and allStopObservationsValid(g, s.services)))
pure def alwaysRetiredUndeclaredTypeIsUnknown(s: PluginServices): bool = not(s.services.stopped) implies s.retirements.every(r => r.groups.every(g => g.phase != GroupWaiting and g.phase != GroupSkipped and not(s.services.declarations.some(d => d.serviceType == g.serviceType)) and not(s.retirements.some(other => other.groups.some(pending => pending.serviceType == g.serviceType and pending.phase == GroupWaiting))) implies I::serviceTypeEntry(s.services, g.serviceType).status == I::TypeUnknown))
pure def alwaysRetiredEpochHasNoResources(s: PluginServices): bool = s.retirements.every(r => not(epochOwnsResources(s, r.epochId)) implies retirementSettled(s, r.epochId) and r.groups.every(g => g.instanceCursor == g.instances.length() and g.observedStops.every(slot => stopSlotSettled(slot, s.services))))
pure def pluginServiceTeardownError(s: PluginServices, epochId: int): str = if (retirement(s, epochId).exited) retirement(s, epochId).hookError else retirement(s, epochId).failures.nthOr(0, "")
pure def pluginServiceTeardownAggregated(s: PluginServices, epochId: int): bool = not(retirement(s, epochId).exited) and retirement(s, epochId).failures.length() > 1
pure def sometimesLateStartStillOwned(s: PluginServices): bool = s.retirements.some(r => currentGroup(s, r.epochId).phase == GroupWaiting and not(startsSettled(s, r.epochId)))
pure def sometimesUnloadedEpochHasNoLiveServices(s: PluginServices): bool = s.retirements.some(r => not(epochOwnsResources(s, r.epochId)) and retirementSettled(s, r.epochId) and not(r.exited) and r.groups.some(g => g.instances.length() > 0))
pure def sometimesHookFailureLeavesLaterType(s: PluginServices): bool = s.retirements.some(r => r.exited and not(epochOwnsResources(s, r.epochId)) and r.cursor + 1 < r.plan.length() and r.plan.nthOr(r.cursor + 1, "") != "" and s.services.declarations.some(d => d.serviceType == r.plan.nthOr(r.cursor + 1, "")))
pure def sometimesWithdrawalKeepsSiblingObject(s: PluginServices): bool = s.retirements.some(r => r.groups.some(g => g.phase == GroupWaiting and g.instances.some(id => not(I::publishedInstances(s.services, g.serviceType).includes(id)) and s.services.classes.some(c => c.registered and c.serviceType == g.serviceType and c.live == id and not(g.classes.some(owner => owner.id == c.id))))))
pure def sometimesMissingStopSkipped(s: PluginServices): bool = s.retirements.some(r => r.groups.some(g => g.instances.some(id => missingStopObservedFor(g, id) and I::serviceObject(s.services, id).stopCalls == 0)))
```

### A sealed request set eventually settles under fair external completion

Each scheduler step selects one already-enabled retirement transition. The
transition's identity-specific entry point remains available. Class hook
settlement likewise selects a pending captured hook only, with its original
success or rejection supplied by the host.

Completion scheduler witnesses choose one actual pending registration or
disposal, keeping the guards of the identity-specific callbacks and
supplying the finite-workload fairness witness.

```quint
pure def canSealRequests(s: PluginServices): bool = not(s.requestsClosed)
pure def sealRequests(s: PluginServices): PluginServices = { ...s, requestsClosed: true }
pure def allOperationsSettled(s: PluginServices): bool = s.epochs.every(p => epochOperationSettled(s, p.id)) and s.services.attempts.every(a => a.phase == I::StartSucceeded or a.phase == I::StartFailed) and s.services.objects.every(o => o.stopPhase != I::StopWaiting) and s.services.calls.every(c => c.status != I::AcquireWaiting and c.status != I::AcquireWaitingInit)
pure def alwaysSealedOwnedClassesStable(s: PluginServices): bool = s.requestsClosed implies alwaysServiceOwnerEpochExists(s)
pure def nextRetirementStage(s: PluginServices, epochId: int): bool = canWithdrawNextType(s, epochId) or canRequestOwnedStops(s, epochId) or canClaimInstanceStop(s, epochId) or canObserveInstanceStop(s, epochId) or canInvokeClassHook(s, epochId) or canFinishClassSlot(s, epochId) or canFinishRetirementGroup(s, epochId) or canCleanPlugin(s, epochId)
pure def automaticRetirement(s: PluginServices): int = s.retirements.select(r => nextRetirementStage(s, r.epochId)).listMap(r => r.epochId).nthOr(0, 0)
pure def canAdvanceRetirement(s: PluginServices): bool = automaticRetirement(s) > 0 and nextRetirementStage(s, automaticRetirement(s))
pure def advanceRetirement(s: PluginServices): PluginServices = {
  val epochId = automaticRetirement(s)
  if (canWithdrawNextType(s, epochId)) withdrawNextType(s, epochId)
  else if (canRequestOwnedStops(s, epochId)) requestOwnedStops(s, epochId)
  else if (canClaimInstanceStop(s, epochId)) claimInstanceStop(s, epochId)
  else if (canObserveInstanceStop(s, epochId)) observeInstanceStop(s, epochId)
  else if (canInvokeClassHook(s, epochId)) invokeClassHook(s, epochId)
  else if (canFinishClassSlot(s, epochId)) finishClassSlot(s, epochId)
  else if (canFinishRetirementGroup(s, epochId)) finishRetirementGroup(s, epochId)
  else if (canCleanPlugin(s, epochId)) cleanPlugin(s, epochId)
  else s
}
pure def pendingClassHookEpoch(s: PluginServices): int = s.retirements.select(r => canFinishClassHook(s, r.epochId, true, "")).listMap(r => r.epochId).nthOr(0, 0)
pure def canFinishNextClassHook(s: PluginServices, ok: bool, errorId: str): bool = pendingClassHookEpoch(s) > 0 and canFinishClassHook(s, pendingClassHookEpoch(s), ok, errorId)
pure def finishNextClassHook(s: PluginServices, ok: bool, errorId: str): PluginServices = finishClassHook(s, pendingClassHookEpoch(s), ok, errorId)
pure def pendingPluginDisposal(s: PluginServices): int = s.retirements.select(r => canDisposePlugin(s, r.epochId, true)).listMap(r => r.epochId).nthOr(0, 0)
pure def canFinishNextPluginDisposal(s: PluginServices, ok: bool): bool = pendingPluginDisposal(s) > 0 and canDisposePlugin(s, pendingPluginDisposal(s), ok)
pure def finishNextPluginDisposal(s: PluginServices, ok: bool): PluginServices = disposePlugin(s, pendingPluginDisposal(s), ok)
pure def pendingRegistration(s: PluginServices): int = s.epochs.select(e => canCommitPlugin(s, e.id) or canFailPlugin(s, e.id)).listMap(e => e.id).nthOr(0, 0)
pure def canFinishNextRegistration(s: PluginServices, ok: bool): bool = pendingRegistration(s) > 0 and (if (ok) canCommitPlugin(s, pendingRegistration(s)) else canFailPlugin(s, pendingRegistration(s)))
pure def finishNextRegistration(s: PluginServices, ok: bool): PluginServices = if (ok) commitPlugin(s, pendingRegistration(s)) else failPlugin(s, pendingRegistration(s))
pure val fair_finishNextRegistration = "strong"
pure val fair_finishInitialization = "weak"
pure val fair_resumeEnsure = "strong"
pure val fair_resolveNextStart = "strong"
pure val fair_finishNextObserver = "strong"
pure val fair_advanceRetirement = "weak"
pure val fair_skipMissingStop = "strong"
pure val fair_finishNextClassHook = "weak"
pure val fair_invokeClassStop = "strong"
pure val fair_finishClassStop = "strong"
pure val fair_finishNextLateStart = "strong"
pure val fair_finishNextPluginDisposal = "weak"
pure val fair_settleEnsure = "strong"
pure val fair_settleTypeAggregate = "strong"
pure val fair_clearTypeAggregate = "strong"
pure def leadsToSealedOperationsSettle(s: PluginServices, later: PluginServices): bool = s.requestsClosed implies allOperationsSettled(later)
pure def sometimesSealedOperationsSettled(s: PluginServices): bool = s.requestsClosed and allOperationsSettled(s)
pure val weight_advanceRetirement = 6
pure val weight_withdrawNextType = 2
pure val weight_finishNextPluginDisposal = 3
pure val weight_finishNextRegistration = 3
pure val weight_requestOwnedStops = 2
pure val weight_skipMissingStop = 8
pure val weight_registerOwnedClass = 3
pure val weight_ensureServices = 4
pure val weight_resolveNextStart = 4
pure val weight_finishNextObserver = 3
pure val weight_unloadPlugin = 3
pure val weight_invokeClassStop = 10
pure val weight_finishClassStop = 10
pure val weight_claimInstanceStop = 20
pure val weight_observeInstanceStop = 20
pure val weight_beginPlugin = 4
pure val weight_finishClassStart = 6
```
