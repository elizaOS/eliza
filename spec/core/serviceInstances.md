# Service instances attempts and eager retries

Sources are `packages/core/src/runtime/service-lifecycle.ts:42-89,101-125,164-382` and `plugin-lifecycle.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This identity model refines the class-level lifecycle: every start promise, returned instance and shared stop promise has its own identity. Successful instance publication precedes the awaited service-started observer; a throwing send-handler registration can leave a published instance even though the start attempt rejects.

## Story: Share starts and stop each returned object once

As a runtime I start pending classes together, retain their exact attempt generations for each caller, and retain stop-once ownership across unload, runtime shutdown and late completion.

### Acquisition snapshots keep each class and attempt generation

Discovered by the proof. The attempt and type-promise allocators stay positive
even when their history is empty. Each acquisition and type aggregate retains
a unique identity so that clearing one captured promise cannot affect another. Class
generations and pending IDs start at zero and stay nonnegative. A registered
class has a nonempty service type, so its returned instance can publish a
valid type key even when this is the first publication. A caller waiting
for initialization owns no aggregate until it is admitted; resuming the same
caller therefore cannot replace a prior aggregate under its identity.

All active classes of a type are considered in declaration order. A failed
sibling is skipped when another class of the type already holds an
implementation. A running implementation is reused. A class's pending
promise is shared until observer completion or failure. The
ServiceInstances state also owns the per-type registration status, retained
load promise, pending resolver and latest aggregate of ordered startup results.
The aggregate and its initiating caller settle independently after the captured
class results are ready. Clearing an aggregate compares the captured identity.
Fair completion selects actual pending attempt identities even when the
allocator passes the numeric examples used for explicit callback inputs.
Success retains the fulfilled load promise and releases its handler. Failure
rejects the pending promise and removes its entry. Runtime reset rejects active
handlers, clears the promise and aggregate lookups and retains status values.

The synchronous service lookup array and the per-class instance map have
separate lifetimes. A successful start republishes the type array from
the current declaration order. Teardown removes every occurrence of each
captured object from that array, including an occurrence reached through a
different class. A surviving class still holds its instance, so a later
start can rebuild the type array with that same identity.

```quint
type AttemptPhase = StartInvoking | StartObserver | StartLateStop | StartSucceeded | StartFailed
type StopPhase = StopNotRequested | StopWaiting | StopSucceeded | StopFailed
type ServiceClassEntry = {id: int, serviceType: str, registered: bool, generation: int, pending: int, live: int, failed: bool}
type ServiceAttempt = {id: int, classId: int, generation: int, phase: AttemptPhase, instance: int, errorId: str}
type ServiceObject = {id: int, stopPhase: StopPhase, stopCalls: int, stopInvoked: bool, errorId: str}
type Initialization = InitializationPending | InitializationReady | InitializationFailed
type AcquireStatus = AcquireWaitingInit | AcquireWaiting | AcquireSucceeded | AcquireFailed | AcquireAbsent
type Acquire = {id: int, serviceType: str, attempts: List[int], status: AcquireStatus, result: int}
type ServiceDeclaration = {classId: int, serviceType: str}
type TypeStatus = TypeUnknown | TypePending | TypeRegistering | TypeRegistered | TypeFailed
type LoadPhase = LoadPending | LoadFulfilled | LoadFailed | LoadStopped
type LoadPromise = {id: int, serviceType: str, phase: LoadPhase, instance: int}
type AggregateMember = {attemptId: int, immediateInstance: int}
type TypeAggregate = {id: int, serviceType: str, members: List[AggregateMember], settled: bool, firstInstance: int}
type TypeEntry = {serviceType: str, status: TypeStatus, promiseId: int, handlerId: int, latestAggregate: int}
type ServicePublication = {serviceType: str, instances: List[int]}
type ServiceInstances = {declarations: List[ServiceDeclaration], classes: List[ServiceClassEntry], attempts: List[ServiceAttempt], objects: List[ServiceObject], published: List[ServicePublication], calls: List[Acquire], nextAttempt: int, initialization: Initialization, stopped: bool, observerErrors: int, typeEntries: List[TypeEntry], loadPromises: List[LoadPromise], aggregates: List[TypeAggregate], nextLoad: int}
pure val initial: ServiceInstances = {declarations: List(), classes: List(), attempts: List(), objects: List(), published: List(), calls: List(), nextAttempt: 1, initialization: InitializationPending, stopped: false, observerErrors: 0, typeEntries: List(), loadPromises: List(), aggregates: List(), nextLoad: 1}
pure val classIdValues = Set(1, 2, 3)
pure val instanceIdValues = Set(1, 2, 3)
pure val attemptIdValues = Set(1, 2, 3, 4)
pure val callIdValues = Set(1, 2, 3, 4)
pure val serviceTypeValues = Set("storage", "messages")
pure val errorIdValues = Set("start-failed", "stop-failed")
pure val noClass: ServiceClassEntry = {id: 0, serviceType: "", registered: false, generation: 0, pending: 0, live: 0, failed: false}
pure val noAttempt: ServiceAttempt = {id: 0, classId: 0, generation: 0, phase: StartFailed, instance: 0, errorId: ""}
pure val noObject: ServiceObject = {id: 0, stopPhase: StopNotRequested, stopCalls: 0, stopInvoked: false, errorId: ""}
pure val noAcquire: Acquire = {id: 0, serviceType: "", attempts: List(), status: AcquireAbsent, result: 0}
pure def serviceClass(s: ServiceInstances, classId: int): ServiceClassEntry = s.classes.select(c => c.id == classId).nthOr(0, noClass)
pure def serviceAttempt(s: ServiceInstances, attemptId: int): ServiceAttempt = s.attempts.select(a => a.id == attemptId).nthOr(0, noAttempt)
pure def serviceObject(s: ServiceInstances, instanceId: int): ServiceObject = s.objects.select(o => o.id == instanceId).nthOr(0, noObject)
pure def acquireCall(s: ServiceInstances, callId: int): Acquire = s.calls.select(c => c.id == callId).nthOr(0, noAcquire)
pure val absentPublication: ServicePublication = {serviceType: "", instances: List()}
pure def publishedInstances(s: ServiceInstances, serviceType: str): List[int] = s.published.select(p => p.serviceType == serviceType).nthOr(0, absentPublication).instances
pure def firstLive(s: ServiceInstances, serviceType: str): int = publishedInstances(s, serviceType).nthOr(0, 0)
pure def classInstances(s: ServiceInstances, serviceType: str): List[int] = s.declarations.select(d => d.serviceType == serviceType and serviceClass(s, d.classId).live != 0).listMap(d => serviceClass(s, d.classId).live)
pure def replacePublication(serviceType: str, instances: List[int], s: ServiceInstances): ServiceInstances = {
  val entry: ServicePublication = {serviceType: serviceType, instances: instances}
  { ...s, published: if (instances.length() == 0) s.published.select(p => p.serviceType != serviceType) else if (s.published.some(p => p.serviceType == serviceType)) s.published.listMap(p => if (p.serviceType == serviceType) entry else p) else s.published.append(entry) }
}
pure def removePublishedInstances(serviceType: str, removed: List[int], s: ServiceInstances): ServiceInstances = replacePublication(serviceType, publishedInstances(s, serviceType).select(id => not(removed.includes(id))), s)
pure val noTypeEntry: TypeEntry = {serviceType: "", status: TypeUnknown, promiseId: 0, handlerId: 0, latestAggregate: 0}
pure val noAggregate: TypeAggregate = {id: 0, serviceType: "", members: List(), settled: false, firstInstance: 0}
pure def serviceTypeEntry(s: ServiceInstances, serviceType: str): TypeEntry = s.typeEntries.select(e => e.serviceType == serviceType).nthOr(0, noTypeEntry)
pure def typeAggregate(s: ServiceInstances, aggregateId: int): TypeAggregate = s.aggregates.select(a => a.id == aggregateId).nthOr(0, noAggregate)
pure def putType(entry: TypeEntry, s: ServiceInstances): ServiceInstances = { ...s, typeEntries: if (s.typeEntries.some(e => e.serviceType == entry.serviceType)) s.typeEntries.listMap(e => if (e.serviceType == entry.serviceType) entry else e) else s.typeEntries.append(entry) }
pure val pendingTypeStatus: TypeStatus = TypePending
pure def registerType(serviceType: str, s: ServiceInstances): ServiceInstances = {
  val entry = serviceTypeEntry(s, serviceType)
  val allocated = entry.promiseId == 0
  val registered = {serviceType: serviceType, status: pendingTypeStatus, promiseId: if (allocated) s.nextLoad else entry.promiseId, handlerId: if (allocated) s.nextLoad else entry.handlerId, latestAggregate: entry.latestAggregate}
  putType(registered, { ...s, loadPromises: if (allocated) s.loadPromises.append({id: s.nextLoad, serviceType: serviceType, phase: LoadPending, instance: 0}) else s.loadPromises, nextLoad: if (allocated) s.nextLoad + 1 else s.nextLoad })
}
pure def setTypeStatus(serviceType: str, status: TypeStatus, s: ServiceInstances): ServiceInstances = {
  val entry = serviceTypeEntry(s, serviceType)
  putType({ ...entry, serviceType: serviceType, status: status }, s)
}
pure def canRegisterClass(s: ServiceInstances, classId: int, serviceType: str): bool = classId > 0 and serviceType != "" and not(s.stopped) and (serviceClass(s, classId).id == 0 or serviceClass(s, classId).serviceType == serviceType)
pure def registerClass(s: ServiceInstances, classId: int, serviceType: str): ServiceInstances = registerType(serviceType, { ...s, declarations: s.declarations.append({classId: classId, serviceType: serviceType}), classes: if (serviceClass(s, classId).id == 0) s.classes.append({id: classId, serviceType: serviceType, registered: true, generation: 0, pending: 0, live: 0, failed: false}) else s.classes.listMap(c => if (c.id == classId) { ...c, registered: true } else c) })
pure def beginClassAttempt(classId: int, s: ServiceInstances): ServiceInstances = {
  val c = serviceClass(s, classId)
  { ...s, classes: s.classes.listMap(x => if (x.id == classId) { ...x, generation: x.generation + 1, pending: s.nextAttempt } else x), attempts: s.attempts.append({id: s.nextAttempt, classId: classId, generation: c.generation + 1, phase: StartInvoking, instance: 0, errorId: ""}), nextAttempt: s.nextAttempt + 1 }
}
pure def ensureClasses(serviceType: str, s: ServiceInstances): ServiceInstances = s.declarations.foldl(s, (acc, d) => if (d.serviceType == serviceType and serviceClass(acc, d.classId).live == 0 and serviceClass(acc, d.classId).pending == 0 and not(serviceClass(acc, d.classId).failed and classInstances(s, serviceType).length() != 0)) beginClassAttempt(d.classId, acc) else acc)
pure def canAcquireServices(s: ServiceInstances, callId: int, serviceType: str): bool = callId > 0 and not(s.calls.some(c => c.id == callId)) and not(s.aggregates.some(a => a.id == callId))
pure def capturedAggregateMember(owner: ServiceClassEntry, fallback: int): AggregateMember = if (owner.live != 0) {attemptId: 0, immediateInstance: owner.live} else if (owner.pending != 0) {attemptId: owner.pending, immediateInstance: 0} else {attemptId: 0, immediateInstance: fallback}
pure def publishTypeAggregate(callId: int, serviceType: str, s: ServiceInstances): ServiceInstances = {
  val entry = serviceTypeEntry(s, serviceType)
  val fallback = classInstances(s, serviceType).nthOr(0, 0)
  val members = s.declarations.select(d => d.serviceType == serviceType).listMap(d => capturedAggregateMember(serviceClass(s, d.classId), fallback))
  val tracked: TypeEntry = { ...entry, serviceType: serviceType, latestAggregate: callId }
  putType(tracked, { ...s, aggregates: s.aggregates.append({id: callId, serviceType: serviceType, members: members, settled: false, firstInstance: 0}) })
}
pure def admittedAcquire(callId: int, serviceType: str, s: ServiceInstances): ServiceInstances = {
  val absent = s.stopped or s.initialization == InitializationFailed or (s.initialization == InitializationReady and not(s.classes.some(c => c.registered and c.serviceType == serviceType)))
  val waitingInit = not(absent) and s.initialization == InitializationPending and firstLive(s, serviceType) == 0
  val early = not(absent) and s.initialization == InitializationPending and firstLive(s, serviceType) != 0
  val ensured = if (absent or waitingInit or early) s else ensureClasses(serviceType, s)
  val startStatus = if (ensured.nextAttempt != s.nextAttempt and firstLive(s, serviceType) == 0) setTypeStatus(serviceType, TypeRegistering, ensured) else ensured
  val started = if (absent or waitingInit or early) startStatus else publishTypeAggregate(callId, serviceType, startStatus)
  { ...started, calls: started.calls.append({id: callId, serviceType: serviceType, attempts: if (absent or waitingInit or early) List() else started.declarations.select(d => d.serviceType == serviceType and serviceClass(started, d.classId).pending > 0).listMap(d => serviceClass(started, d.classId).pending), status: if (absent) AcquireAbsent else if (waitingInit) AcquireWaitingInit else if (early) AcquireSucceeded else AcquireWaiting, result: if (early) firstLive(s, serviceType) else 0}) }
}
pure def acquireServices(s: ServiceInstances, callId: int, serviceType: str): ServiceInstances = admittedAcquire(callId, serviceType, s)
pure def canFinishInitialization(s: ServiceInstances, ok: bool): bool = s.initialization == InitializationPending
pure def finishInitialization(s: ServiceInstances, ok: bool): ServiceInstances = { ...s, initialization: if (ok) InitializationReady else InitializationFailed }
pure def canResumeAcquire(s: ServiceInstances, callId: int): bool = acquireCall(s, callId).status == AcquireWaitingInit and s.initialization != InitializationPending
pure def resumeAcquire(s: ServiceInstances, callId: int): ServiceInstances = {
  val c = acquireCall(s, callId)
  admittedAcquire(callId, c.serviceType, { ...s, calls: s.calls.select(other => other.id != callId) })
}
pure def stopObjectOnce(instanceId: int, s: ServiceInstances): ServiceInstances = { ...s, objects: s.objects.listMap(o => if (o.id == instanceId and o.stopPhase == StopNotRequested) { ...o, stopPhase: StopWaiting, stopCalls: 1 } else o) }
pure def canReturnInstance(s: ServiceInstances, attemptId: int, instanceId: int): bool = serviceAttempt(s, attemptId).id > 0 and serviceAttempt(s, attemptId).phase == StartInvoking and instanceId > 0
pure def returnInstance(s: ServiceInstances, attemptId: int, instanceId: int): ServiceInstances = {
  val a = serviceAttempt(s, attemptId)
  val c = serviceClass(s, a.classId)
  val late = s.stopped or not(c.registered)
  val added = { ...s, objects: if (serviceObject(s, instanceId).id == 0) s.objects.append({id: instanceId, stopPhase: StopNotRequested, stopCalls: 0, stopInvoked: false, errorId: ""}) else s.objects, attempts: s.attempts.listMap(x => if (x.id == attemptId) { ...x, instance: instanceId, phase: if (late) StartLateStop else StartObserver } else x), classes: s.classes.listMap(c => if (c.id == a.classId and not(late)) { ...c, live: instanceId } else c) }
  if (late) stopObjectOnce(instanceId, added) else setTypeStatus(c.serviceType, TypeRegistered, replacePublication(c.serviceType, classInstances(added, c.serviceType), added))
}
pure def canFailStart(s: ServiceInstances, attemptId: int, errorId: str): bool = serviceAttempt(s, attemptId).id > 0 and (serviceAttempt(s, attemptId).phase == StartInvoking or serviceAttempt(s, attemptId).phase == StartObserver)
pure def rejectStartAttempt(attemptId: int, errorId: str, s: ServiceInstances): ServiceInstances = {
  val a = serviceAttempt(s, attemptId)
  { ...s, attempts: s.attempts.listMap(x => if (x.id == attemptId) { ...x, phase: StartFailed, errorId: errorId } else x), classes: s.classes.listMap(c => if (c.id == a.classId and c.pending == attemptId) { ...c, pending: 0, failed: true } else c) }
}
pure def failStart(s: ServiceInstances, attemptId: int, errorId: str): ServiceInstances = rejectStartAttempt(attemptId, errorId, s)
pure def canFinishObserver(s: ServiceInstances, attemptId: int, ok: bool): bool = serviceAttempt(s, attemptId).id > 0 and serviceAttempt(s, attemptId).phase == StartObserver
pure def finishObserver(s: ServiceInstances, attemptId: int, ok: bool): ServiceInstances = {
  val a = serviceAttempt(s, attemptId)
  { ...s, observerErrors: s.observerErrors + (if (ok) 0 else 1), attempts: s.attempts.listMap(x => if (x.id == attemptId) { ...x, phase: StartSucceeded } else x), classes: s.classes.listMap(c => if (c.id == a.classId and c.pending == attemptId) { ...c, pending: 0, failed: false } else c) }
}
pure def attemptSettled(s: ServiceInstances, attemptId: int): bool = serviceAttempt(s, attemptId).phase == StartSucceeded or serviceAttempt(s, attemptId).phase == StartFailed
pure def aggregateReady(s: ServiceInstances, callId: int): bool = typeAggregate(s, callId).id > 0 and typeAggregate(s, callId).members.every(m => m.attemptId == 0 or attemptSettled(s, m.attemptId))
pure def aggregateMemberResult(s: ServiceInstances, m: AggregateMember): int = if (m.attemptId == 0) m.immediateInstance else if (serviceAttempt(s, m.attemptId).phase == StartSucceeded) serviceAttempt(s, m.attemptId).instance else 0
pure def canSettleTypeAggregate(s: ServiceInstances, callId: int): bool = aggregateReady(s, callId) and not(typeAggregate(s, callId).settled)
pure def settleTypeAggregate(s: ServiceInstances, callId: int): ServiceInstances = { ...s, aggregates: s.aggregates.listMap(a => if (a.id == callId) { ...a, settled: true, firstInstance: a.members.listMap(m => aggregateMemberResult(s, m)).select(id => id != 0).nthOr(0, 0) } else a) }
pure def canClearTypeAggregate(s: ServiceInstances, callId: int): bool = typeAggregate(s, callId).settled and s.typeEntries.some(e => e.latestAggregate == callId)
pure def clearTypeAggregate(s: ServiceInstances, callId: int): ServiceInstances = { ...s, typeEntries: s.typeEntries.listMap(e => if (e.latestAggregate == callId) { ...e, latestAggregate: 0 } else e) }
pure def canSettleAcquire(s: ServiceInstances, callId: int): bool = acquireCall(s, callId).status == AcquireWaiting and acquireCall(s, callId).id > 0 and aggregateReady(s, callId)
pure def settleAcquire(s: ServiceInstances, callId: int): ServiceInstances = {
  val serviceType = acquireCall(s, callId).serviceType
  val entry = serviceTypeEntry(s, serviceType)
  val result = firstLive(s, serviceType)
  val classesRemain = s.declarations.some(d => d.serviceType == serviceType)
  val disposition = if (result != 0) TypeRegistered else if (classesRemain) TypeFailed else TypeUnknown
  val finished = { ...s, calls: s.calls.listMap(c => if (c.id != callId) c else { ...c, result: result, status: if (result != 0) AcquireSucceeded else AcquireFailed }), loadPromises: s.loadPromises.listMap(p => if (p.id == entry.handlerId) { ...p, phase: if (result != 0) LoadFulfilled else LoadFailed, instance: result } else p) }
  putType({ ...entry, serviceType: serviceType, status: disposition, promiseId: if (result == 0 and entry.handlerId != 0) 0 else entry.promiseId, handlerId: 0 }, finished)
}
```

### Instance stop promises retain identity across every caller

The stop promise is published before the object's stop method runs. An invoked
stop rejection remains the same rejected promise on every later request.
A late instance's start fails after its stop attempt settles. This owner
projects callable objects for runtime shutdown and late starts. The shared
composition still needs the runtime's missing or invalid stop reporting.
The plugin retirement model records the synchronous skip as a slot observation.

```quint
pure def canRequestObjectStop(s: ServiceInstances, instanceId: int): bool = serviceObject(s, instanceId).id > 0
pure def requestObjectStop(s: ServiceInstances, instanceId: int): ServiceInstances = stopObjectOnce(instanceId, s)
pure def canInvokeObjectStop(s: ServiceInstances, instanceId: int): bool = serviceObject(s, instanceId).stopPhase == StopWaiting and not(serviceObject(s, instanceId).stopInvoked)
pure def invokeObjectStop(s: ServiceInstances, instanceId: int): ServiceInstances = { ...s, objects: s.objects.listMap(o => if (o.id == instanceId) { ...o, stopInvoked: true } else o) }
pure def canSettleObjectStop(s: ServiceInstances, instanceId: int, ok: bool, errorId: str): bool = serviceObject(s, instanceId).stopPhase == StopWaiting and serviceObject(s, instanceId).stopInvoked
pure def settleObjectStop(s: ServiceInstances, instanceId: int, ok: bool, errorId: str): ServiceInstances = { ...s, objects: s.objects.listMap(o => if (o.id == instanceId) { ...o, stopPhase: if (ok) StopSucceeded else StopFailed, errorId: if (ok) "" else errorId } else o) }
pure def canFinishLateStart(s: ServiceInstances, attemptId: int): bool = serviceAttempt(s, attemptId).phase == StartLateStop and (serviceObject(s, serviceAttempt(s, attemptId).instance).stopPhase == StopSucceeded or serviceObject(s, serviceAttempt(s, attemptId).instance).stopPhase == StopFailed)
pure def finishLateStart(s: ServiceInstances, attemptId: int): ServiceInstances = rejectStartAttempt(attemptId, "late-service-start", s)
pure def withdrawClass(classId: int, s: ServiceInstances): ServiceInstances = { ...s, declarations: s.declarations.select(d => d.classId != classId), classes: s.classes.listMap(c => if (c.id == classId) { ...c, registered: false, live: 0 } else c) }
pure def canUnregisterClass(s: ServiceInstances, classId: int): bool = serviceClass(s, classId).registered
pure def unregisterClass(s: ServiceInstances, classId: int): ServiceInstances = {
  val c = serviceClass(s, classId)
  val stopped = if (c.live != 0) stopObjectOnce(c.live, s) else s
  val withdrawn = removePublishedInstances(c.serviceType, List(c.live), withdrawClass(classId, stopped))
  reconcileType(c.serviceType, withdrawn)
}
pure def reconcileType(serviceType: str, s: ServiceInstances): ServiceInstances = {
  val entry = serviceTypeEntry(s, serviceType)
  val published = firstLive(s, serviceType) != 0
  val classesRemain = s.declarations.some(d => d.serviceType == serviceType)
  putType({ ...entry, serviceType: serviceType, status: if (published) TypeRegistered else if (classesRemain) TypePending else TypeUnknown, promiseId: if (classesRemain or published) entry.promiseId else 0, handlerId: if (classesRemain or published) entry.handlerId else 0 }, s)
}
pure def canStopRuntime(s: ServiceInstances): bool = not(s.stopped)
pure def stopPublishedType(publication: ServicePublication, s: ServiceInstances): ServiceInstances = publication.instances.foldl(s, (acc, id) => stopObjectOnce(id, acc))
pure def stopRuntime(s: ServiceInstances): ServiceInstances = {
  val stopped = s.published.foldl(s, (acc, p) => stopPublishedType(p, acc))
  { ...stopped, stopped: true, published: List(), classes: stopped.classes.listMap(c => { ...c, live: 0, pending: 0, failed: false }), typeEntries: stopped.typeEntries.listMap(e => { ...e, promiseId: 0, handlerId: 0, latestAggregate: 0 }), loadPromises: stopped.loadPromises.listMap(p => if (s.typeEntries.some(e => e.handlerId == p.id)) { ...p, phase: LoadStopped } else p) }
}
pure def hasFailedPublishedType(s: ServiceInstances): bool = s.typeEntries.some(e => e.status == TypeFailed and firstLive(s, e.serviceType) != 0)
pure def alwaysFailedTypeHasNoPublication(s: ServiceInstances): bool = not(hasFailedPublishedType(s))
pure def alwaysTypeEntriesUnique(s: ServiceInstances): bool = s.typeEntries.every(e => s.typeEntries.select(other => other.serviceType == e.serviceType).length() == 1)
pure def alwaysAggregateAndLoadIdsUnique(s: ServiceInstances): bool = s.nextLoad > 0 and s.loadPromises.every(p => p.id > 0 and p.id < s.nextLoad and s.loadPromises.select(other => other.id == p.id).length() == 1) and s.aggregates.every(a => a.id > 0 and s.aggregates.select(other => other.id == a.id).length() == 1)
pure def alwaysAcquisitionIdsUnique(s: ServiceInstances): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
pure def alwaysInitWaitingHasNoAggregate(s: ServiceInstances): bool = s.calls.every(c => c.status == AcquireWaitingInit implies not(s.aggregates.some(a => a.id == c.id)))
pure def alwaysTypeReferencesRetained(s: ServiceInstances): bool = s.typeEntries.every(e => (e.promiseId == 0 or s.loadPromises.some(p => p.id == e.promiseId and p.serviceType == e.serviceType)) and (e.handlerId == 0 or (e.handlerId == e.promiseId and s.loadPromises.some(p => p.id == e.handlerId and p.phase == LoadPending))) and (e.latestAggregate == 0 or s.aggregates.some(a => a.id == e.latestAggregate and a.serviceType == e.serviceType)))
pure def stepSupersededAggregateKeepsSuccessor(before: ServiceInstances, via: str, after: ServiceInstances): bool = via == "clearTypeAggregate" implies before.typeEntries.every(e => after.typeEntries.some(a => a.serviceType == e.serviceType and (a.latestAggregate == e.latestAggregate or (a.latestAggregate == 0 and typeAggregate(before, e.latestAggregate).settled))))
pure def sometimesFulfilledPromiseRetained(s: ServiceInstances): bool = s.typeEntries.some(e => e.handlerId == 0 and s.loadPromises.some(p => p.id == e.promiseId and p.phase == LoadFulfilled))
pure def sometimesStaleAggregateCannotClearSuccessor(s: ServiceInstances): bool = s.typeEntries.some(e => e.latestAggregate > 0 and s.aggregates.some(a => a.serviceType == e.serviceType and a.id != e.latestAggregate and a.settled and not(canClearTypeAggregate(s, a.id))))
pure def alwaysClassAndObjectIdentities(s: ServiceInstances): bool = s.classes.every(c => c.id > 0 and c.generation >= 0 and c.pending >= 0 and s.classes.select(other => other.id == c.id).length() == 1) and s.objects.every(o => o.id > 0 and s.objects.select(other => other.id == o.id).length() == 1)
pure def alwaysPendingAttemptsOwned(s: ServiceInstances): bool = s.classes.every(c => c.pending == 0 or (serviceAttempt(s, c.pending).classId == c.id and serviceAttempt(s, c.pending).generation == c.generation and (serviceAttempt(s, c.pending).phase == StartInvoking or serviceAttempt(s, c.pending).phase == StartObserver or serviceAttempt(s, c.pending).phase == StartLateStop)))
pure def alwaysCapturedAttemptsExist(s: ServiceInstances): bool = s.calls.every(c => c.attempts.every(id => id > 0 and serviceAttempt(s, id).id == id)) and s.attempts.every(a => a.instance == 0 or serviceObject(s, a.instance).id == a.instance) and s.aggregates.every(a => a.members.every(m => m.attemptId == 0 or serviceAttempt(s, m.attemptId).id == m.attemptId))
pure def alwaysDeclarationsMatch(s: ServiceInstances): bool = s.declarations.every(d => d.serviceType != "" and serviceClass(s, d.classId).registered and serviceClass(s, d.classId).serviceType == d.serviceType) and s.classes.every(c => c.registered iff s.declarations.some(d => d.classId == c.id))
pure def alwaysObjectStopOnce(s: ServiceInstances): bool = s.objects.every(o => o.stopCalls >= 0 and o.stopCalls <= 1 and (o.stopPhase != StopNotRequested iff o.stopCalls == 1))
pure def alwaysClassOwnsKnownObjects(s: ServiceInstances): bool = s.classes.every(c => c.live == 0 or s.objects.some(o => o.id == c.live))
pure def alwaysAttemptGeneration(s: ServiceInstances): bool = s.nextAttempt > 0 and s.attempts.every(a => a.id > 0 and a.id < s.nextAttempt and a.generation > 0 and a.generation <= serviceClass(s, a.classId).generation and s.attempts.select(other => other.id == a.id).length() == 1)
pure def alwaysStoppedHasNoPublication(s: ServiceInstances): bool = s.stopped implies s.published.length() == 0 and s.classes.every(c => c.live == 0)
pure def alwaysPublicationIdentitiesValid(s: ServiceInstances): bool = s.published.every(p => p.serviceType != "" and p.instances.length() > 0 and s.published.select(other => other.serviceType == p.serviceType).length() == 1 and p.instances.every(id => id > 0 and s.classes.some(c => c.serviceType == p.serviceType and c.live == id)))
pure def stepStopIdentityRetained(before: ServiceInstances, after: ServiceInstances): bool = before.objects.every(o => o.stopPhase != StopNotRequested implies after.objects.some(laterObject => laterObject.id == o.id and laterObject.stopCalls == 1 and (o.stopPhase == StopWaiting or laterObject.stopPhase == o.stopPhase)))
pure def sometimesRetryHasNewGeneration(s: ServiceInstances): bool = s.classes.some(c => c.generation >= 2)
pure def sometimesSharedObjectStoppedOnce(s: ServiceInstances): bool = s.objects.some(o => o.stopCalls == 1 and s.attempts.select(a => a.instance == o.id).length() > 1)
pure def sometimesFailedAttemptLeftPublishedObject(s: ServiceInstances): bool = s.classes.some(c => c.live != 0 and c.failed)
pure def sometimesWithdrawnAliasRemainsInClassMap(s: ServiceInstances): bool = s.classes.some(c => c.registered and c.live > 0 and serviceObject(s, c.live).stopCalls == 1 and not(publishedInstances(s, c.serviceType).includes(c.live)))
pure def nextInvokingAttempt(s: ServiceInstances): int = s.attempts.select(a => a.phase == StartInvoking).nthOr(0, noAttempt).id
pure def nextObservableAttempt(s: ServiceInstances): int = s.attempts.select(a => a.phase == StartObserver).nthOr(0, noAttempt).id
pure def nextRetiredAttempt(s: ServiceInstances): int = s.attempts.select(a => canFinishLateStart(s, a.id)).nthOr(0, noAttempt).id
pure def canResolveNextStart(s: ServiceInstances, ok: bool, instanceId: int, errorId: str): bool = if (ok) canReturnInstance(s, nextInvokingAttempt(s), instanceId) else canFailStart(s, nextInvokingAttempt(s), errorId)
pure def resolveNextStart(s: ServiceInstances, ok: bool, instanceId: int, errorId: str): ServiceInstances = if (ok) returnInstance(s, nextInvokingAttempt(s), instanceId) else failStart(s, nextInvokingAttempt(s), errorId)
pure def canFinishNextObserver(s: ServiceInstances, ok: bool): bool = canFinishObserver(s, nextObservableAttempt(s), ok)
pure def finishNextObserver(s: ServiceInstances, ok: bool): ServiceInstances = finishObserver(s, nextObservableAttempt(s), ok)
pure def canFinishNextLateStart(s: ServiceInstances): bool = canFinishLateStart(s, nextRetiredAttempt(s))
pure def finishNextLateStart(s: ServiceInstances): ServiceInstances = finishLateStart(s, nextRetiredAttempt(s))
pure val fair_finishInitialization = "weak"
pure val fair_resumeAcquire = "strong"
pure val fair_resolveNextStart = "strong"
pure val fair_finishNextObserver = "strong"
pure val fair_settleObjectStop = "strong"
pure val fair_invokeObjectStop = "strong"
pure val fair_finishNextLateStart = "strong"
pure val fair_settleAcquire = "strong"
pure val fair_settleTypeAggregate = "strong"
pure val fair_clearTypeAggregate = "strong"
pure def leadsToAcquisitionsSettle(s: ServiceInstances, later: ServiceInstances): bool = s.calls.every(c => (c.status == AcquireWaiting or c.status == AcquireWaitingInit) implies later.calls.some(done => done.id == c.id and done.status != AcquireWaiting and done.status != AcquireWaitingInit))
```
