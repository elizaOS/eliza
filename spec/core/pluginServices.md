# Plugin and service ownership composition

Sources are `packages/core/src/plugin-lifecycle.ts:565-683,1069-1094` and `runtime/service-lifecycle.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This is the authoritative composition of plugin epochs with the detailed service instance owner. [Registry observations](./serviceRegistry.md) are pure projections of this same service state, not a second stored lifecycle.

## Story: Withdraw plugin declarations without losing asynchronous instances

As a host I can unload a plugin while original starts and shared stop promises are pending. Duplicate declarations of the same class reference share its start and instance. Unloading either declaring plugin removes every occurrence of that class, matching the source's alias behavior.

### Plugin epochs own declaration receipts while classes share instance identity

```quint
import pluginRegistry as E from "./pluginRegistry"
import serviceInstances as I from "./serviceInstances"
import plugins as P from "./plugins"
type ClassOwnership = {epochId: int, classId: int}
type ServiceRetirement = {epochId: int, starts: List[int], aggregates: List[int], serviceTypes: List[str], instances: List[int], stopsRequested: bool}
type PluginServices = {plugins: E::PluginEpochs, services: I::ServiceInstances, ownership: List[ClassOwnership], retirements: List[ServiceRetirement], requestsClosed: bool}
pure val initial: PluginServices = {plugins: E::initial, services: I::initial, ownership: List(), retirements: List(), requestsClosed: false}
pure val nameValues = Set("plugin-a", "plugin-b")
pure val epochIdValues = Set(1, 2, 3)
pure val classIdValues = I::classIdValues
pure val callIdValues = I::callIdValues
pure val serviceTypeValues = I::serviceTypeValues
pure val attemptIdValues = I::attemptIdValues
pure val instanceIdValues = I::instanceIdValues
pure val errorIdValues = I::errorIdValues
pure def canBeginPlugin(s: PluginServices, name: str, adapter: bool): bool = not(s.requestsClosed) and not(s.services.stopped) and E::canBeginPlugin(s.plugins, name, adapter)
pure def beginPlugin(s: PluginServices, name: str, adapter: bool): PluginServices = { ...s, plugins: E::beginPlugin(s.plugins, name, adapter) }
pure def canJoinPlugin(s: PluginServices, epochId: int): bool = E::canJoinPlugin(s.plugins, epochId)
pure def joinPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, plugins: E::joinPlugin(s.plugins, epochId) }
pure def canCommitPlugin(s: PluginServices, epochId: int): bool = not(s.services.stopped) and E::canCommitPlugin(s.plugins, epochId)
pure def commitPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, plugins: E::commitPlugin(s.plugins, epochId) }
pure def canRegisterOwnedClass(s: PluginServices, epochId: int, classId: int, serviceType: str): bool = not(s.requestsClosed) and E::epochAdmitsClass(s.plugins, epochId) and I::canRegisterClass(s.services, classId, serviceType)
pure def registerOwnedClass(s: PluginServices, epochId: int, classId: int, serviceType: str): PluginServices = { ...s, services: I::registerClass(s.services, classId, serviceType), ownership: s.ownership.append({epochId: epochId, classId: classId}) }
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
pure def currentClassOwner(s: PluginServices, classId: int): int = {
  val captures = s.ownership.select(o => o.classId == classId)
  val owner = captures.nthOr(captures.length() - 1, {epochId: 0, classId: 0}).epochId
  if (E::epochOwnsResources(s.plugins, owner)) owner else 0
}
pure def alwaysServiceOwnerEpochExists(s: PluginServices): bool = s.ownership.every(o => E::epoch(s.plugins, o.epochId).id == o.epochId)
pure def alwaysChildLifecyclesValid(s: PluginServices): bool = E::alwaysEpochIdentityUnique(s.plugins) and E::alwaysOneActiveEpochPerName(s.plugins) and E::alwaysEpochOutcomeHonest(s.plugins) and I::alwaysClassAndObjectIdentities(s.services) and I::alwaysPendingAttemptsOwned(s.services) and I::alwaysCapturedAttemptsExist(s.services) and I::alwaysDeclarationsMatch(s.services) and I::alwaysObjectStopOnce(s.services) and I::alwaysAttemptGeneration(s.services) and I::alwaysTypeEntriesUnique(s.services) and I::alwaysTypeReferencesRetained(s.services) and I::alwaysFailedTypeHasNoPublication(s.services)
pure def sometimesTwoPluginsOwnServices(s: PluginServices): bool = s.ownership.some(a => s.ownership.some(b => a.epochId != b.epochId and I::serviceClass(s.services, a.classId).live != 0 and I::serviceClass(s.services, b.classId).live != 0))
```

### Teardown withdraws all aliases before awaiting captured starts and instances

The retirement receipt captures the original pending starts and published object identities before removing class declarations. It waits for those starts and the captured type aggregate, reconciles status
against current publication and declarations, then requests stop on the
captured objects. A start that returns after withdrawal stops its own late object. Re-registration may reuse the same class reference, but old cleanup never re-reads a later instance as its original captured object.

```quint
pure def retirement(s: PluginServices, epochId: int): ServiceRetirement = s.retirements.select(r => r.epochId == epochId).nthOr(0, {epochId: 0, starts: List(), aggregates: List(), serviceTypes: List(), instances: List(), stopsRequested: false})
pure def captureRetirement(epochId: int, s: PluginServices): PluginServices = {
  val classes = s.ownership.select(o => o.epochId == epochId).listMap(o => o.classId)
  val captured = s.services.classes.select(c => classes.includes(c.id))
  val types = captured.foldl(List(), (types, c) => if (types.includes(c.serviceType)) types else types.append(c.serviceType))
  val aggregates = types.listMap(serviceType => I::serviceTypeEntry(s.services, serviceType).latestAggregate).select(id => id != 0)
  val services = captured.foldl(s.services, (acc, c) => I::withdrawClass(c.id, acc))
  { ...s, services: services, retirements: s.retirements.append({epochId: epochId, starts: captured.select(c => c.pending != 0).listMap(c => c.pending), aggregates: aggregates, serviceTypes: types, instances: captured.select(c => c.live != 0).listMap(c => c.live), stopsRequested: false}) }
}
pure def canFailPlugin(s: PluginServices, epochId: int): bool = E::canFailPlugin(s.plugins, epochId)
pure def failPlugin(s: PluginServices, epochId: int): PluginServices = captureRetirement(epochId, { ...s, plugins: E::failPlugin(s.plugins, epochId) })
pure def canUnloadPlugin(s: PluginServices, epochId: int): bool = E::canUnloadPlugin(s.plugins, epochId)
pure def unloadPlugin(s: PluginServices, epochId: int): PluginServices = captureRetirement(epochId, { ...s, plugins: E::unloadPlugin(s.plugins, epochId) })
pure def canDisposePlugin(s: PluginServices, epochId: int, ok: bool): bool = E::canDisposePlugin(s.plugins, epochId, ok)
pure def disposePlugin(s: PluginServices, epochId: int, ok: bool): PluginServices = { ...s, plugins: E::disposePlugin(s.plugins, epochId, ok) }
pure def canSettleTypeAggregate(s: PluginServices, callId: int): bool = I::canSettleTypeAggregate(s.services, callId)
pure def settleTypeAggregate(s: PluginServices, callId: int): PluginServices = { ...s, services: I::settleTypeAggregate(s.services, callId) }
pure def canClearTypeAggregate(s: PluginServices, callId: int): bool = I::canClearTypeAggregate(s.services, callId)
pure def clearTypeAggregate(s: PluginServices, callId: int): PluginServices = { ...s, services: I::clearTypeAggregate(s.services, callId) }
pure def startsSettled(s: PluginServices, epochId: int): bool = retirement(s, epochId).starts.every(id => I::attemptSettled(s.services, id)) and retirement(s, epochId).aggregates.every(id => I::typeAggregate(s.services, id).settled)
pure def canRequestOwnedStops(s: PluginServices, epochId: int): bool = retirement(s, epochId).epochId != 0 and not(retirement(s, epochId).stopsRequested) and startsSettled(s, epochId)
pure def requestOwnedStops(s: PluginServices, epochId: int): PluginServices = { ...s, services: retirement(s, epochId).instances.foldl(retirement(s, epochId).serviceTypes.foldl(s.services, (acc, serviceType) => I::reconcileType(serviceType, acc)), (acc, id) => I::stopObjectOnce(id, acc)), retirements: s.retirements.listMap(r => if (r.epochId == epochId) { ...r, stopsRequested: true } else r) }
pure def canInvokeClassStop(s: PluginServices, instanceId: int): bool = I::canInvokeObjectStop(s.services, instanceId)
pure def invokeClassStop(s: PluginServices, instanceId: int): PluginServices = { ...s, services: I::invokeObjectStop(s.services, instanceId) }
pure def canFinishClassStop(s: PluginServices, instanceId: int, ok: bool, errorId: str): bool = I::canSettleObjectStop(s.services, instanceId, ok, errorId)
pure def finishClassStop(s: PluginServices, instanceId: int, ok: bool, errorId: str): PluginServices = { ...s, services: I::settleObjectStop(s.services, instanceId, ok, errorId) }
pure def canFinishLateStart(s: PluginServices, attemptId: int): bool = I::canFinishLateStart(s.services, attemptId)
pure def finishLateStart(s: PluginServices, attemptId: int): PluginServices = { ...s, services: I::finishLateStart(s.services, attemptId) }
pure def retirementSettled(s: PluginServices, epochId: int): bool = retirement(s, epochId).stopsRequested and startsSettled(s, epochId) and retirement(s, epochId).instances.every(id => I::serviceObject(s.services, id).stopPhase == I::StopSucceeded or I::serviceObject(s.services, id).stopPhase == I::StopFailed)
pure def canCleanPlugin(s: PluginServices, epochId: int): bool = E::canCleanPlugin(s.plugins, epochId) and retirementSettled(s, epochId)
pure def cleanPlugin(s: PluginServices, epochId: int): PluginServices = { ...s, plugins: E::cleanPlugin(s.plugins, epochId) }
pure def canStopServices(s: PluginServices): bool = I::canStopRuntime(s.services)
pure def stopServices(s: PluginServices): PluginServices = { ...s, services: I::stopRuntime(s.services) }
pure def alwaysNoOrphanInstance(s: PluginServices): bool = s.services.objects.every(instanceRecord => instanceRecord.stopCalls > 0 or s.services.classes.some(c => c.live == instanceRecord.id and c.registered) or s.retirements.some(r => E::epochOwnsResources(s.plugins, r.epochId) and r.instances.includes(instanceRecord.id)))
pure def alwaysRetiredUndeclaredTypeIsUnknown(s: PluginServices): bool = not(s.services.stopped) implies s.retirements.every(r => not(E::epochOwnsResources(s.plugins, r.epochId)) implies r.serviceTypes.every(serviceType => not(s.services.declarations.some(d => d.serviceType == serviceType)) and not(s.retirements.some(other => other.serviceTypes.includes(serviceType) and not(other.stopsRequested))) implies I::serviceTypeEntry(s.services, serviceType).status == I::TypeUnknown))
pure def alwaysRetiredEpochHasNoResources(s: PluginServices): bool = s.retirements.every(r => not(E::epochOwnsResources(s.plugins, r.epochId)) implies retirementSettled(s, r.epochId))
pure def sometimesLateStartStillOwned(s: PluginServices): bool = s.retirements.some(r => not(startsSettled(s, r.epochId)))
pure def sometimesUnloadedEpochHasNoLiveServices(s: PluginServices): bool = s.retirements.some(r => not(E::epochOwnsResources(s.plugins, r.epochId)) and retirementSettled(s, r.epochId))
```

### A sealed request set eventually settles under fair external completion

```quint
pure def canSealRequests(s: PluginServices): bool = not(s.requestsClosed)
pure def sealRequests(s: PluginServices): PluginServices = { ...s, requestsClosed: true }
pure def allOperationsSettled(s: PluginServices): bool = s.plugins.epochs.every(p => E::epochOperationSettled(s.plugins, p.id)) and s.services.attempts.every(a => a.phase == I::StartSucceeded or a.phase == I::StartFailed) and s.services.objects.every(o => o.stopPhase != I::StopWaiting) and s.services.calls.every(c => c.status != I::AcquireWaiting and c.status != I::AcquireWaitingInit)
pure def alwaysSealedOwnedClassesStable(s: PluginServices): bool = s.requestsClosed implies alwaysServiceOwnerEpochExists(s)
pure val fair_commitPlugin = "strong"
pure val fair_failPlugin = "strong"
pure val fair_finishInitialization = "weak"
pure val fair_resumeEnsure = "strong"
pure val fair_resolveNextStart = "strong"
pure val fair_finishNextObserver = "strong"
pure val fair_requestOwnedStops = "strong"
pure val fair_invokeClassStop = "strong"
pure val fair_finishClassStop = "strong"
pure val fair_finishNextLateStart = "strong"
pure val fair_disposePlugin = "strong"
pure val fair_cleanPlugin = "strong"
pure val fair_settleEnsure = "strong"
pure val fair_settleTypeAggregate = "strong"
pure val fair_clearTypeAggregate = "strong"
pure def leadsToSealedOperationsSettle(s: PluginServices, later: PluginServices): bool = s.requestsClosed implies allOperationsSettled(later)
pure def sometimesSealedOperationsSettled(s: PluginServices): bool = s.requestsClosed and allOperationsSettled(s)
```
