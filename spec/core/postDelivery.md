# Post-delivery task ownership and quarantine

Post-delivery work stays tracked until its original promise settles. Runtime quarantine is permanent and requests cooperative cancellation while retaining pending entries. Sources include [post-delivery-task-tracker.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/services/post-delivery-task-tracker.ts) and [PostDeliveryTasks.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/PostDeliveryTasks.qnt).

## Story: Track detached work under runtime and room ownership

As a host I distinguish diagnostic work from room-state work and wait for real settlement before releasing a room.

### Room-state work captures a live lease and belongs to both indexes

Diagnostic work is runtime-scoped. Room-state work can be roomless only when the host permits implicit ownership.

```quint
type PostTaskKind = DiagnosticTask | RoomStateTask
type PostTaskPhase = PendingTask | WaitingForDelivery | RunningTask | SettledTask
type DeliveryStatus = WaitingDelivery | SavedDelivery | FailedDelivery
type PostRuntime = {id: int, quarantined: bool, requiresOwnership: bool}
type PostLease = {id: int, runtime: int, room: str}
type DeliveryPermission = UnknownPermission | AllowedPermission | DeniedPermission
type PostTask = {id: int, label: str, runtime: int, room: str, lease: int, kind: PostTaskKind, phase: PostTaskPhase, aborted: bool, failed: bool, invoked: bool, cooperative: bool, waitsForDelivery: bool, permission: DeliveryPermission, effectApplied: bool}
type DeliveryBoundary = {runtime: int, room: str, lease: int, status: DeliveryStatus}
type PostDrainPhase = DrainRunning | DrainDone | DrainFailed
type PostDrain = {id: int, entryAborted: bool, runtime: int, room: str, phase: PostDrainPhase, abortable: bool, snapshot: List[int], drained: int, failureLabels: List[str]}
pure val noPostDrain: PostDrain = {id: 0, entryAborted: false, runtime: 0, room: "", phase: DrainFailed, abortable: false, snapshot: List(), drained: 0, failureLabels: List()}
type PostDelivery = {issuedTaskIds: Set[int], issuedDrainIds: Set[int], issuedLeaseIds: Set[int], drains: List[PostDrain], runtimes: List[PostRuntime], leases: List[PostLease], tasks: List[PostTask], boundaries: List[DeliveryBoundary], reportedFailures: int}
pure val initial: PostDelivery = {issuedTaskIds: Set(), issuedDrainIds: Set(), issuedLeaseIds: Set(), drains: List(), runtimes: List(), leases: List(), tasks: List(), boundaries: List(), reportedFailures: 0}
pure val runtimeIdValues = Set(1, 2)
pure val leaseIdValues = Set(1, 2, 3)
pure val taskIdValues = Set(1, 2, 3, 4)
pure val roomValues = Set("", "room-a", "room-b")
pure val labelValues = Set("reflection", "diagnostic")
pure val weight_registerPostRuntime = 4
pure val weight_acquirePostLease = 4
pure val weight_trackPostTask = 12
pure val weight_beginPostDrain = 5
pure val weight_settlePostTask = 5
pure val weight_finishPostDrainBatch = 5
pure def quarantined(s: PostDelivery, runtimeId: int): bool = s.runtimes.some(r => r.id == runtimeId and r.quarantined)
pure def canRegisterPostRuntime(s: PostDelivery, runtimeId: int, requiresOwnership: bool): bool = runtimeId > 0 and not(s.runtimes.some(r => r.id == runtimeId))
pure def registerPostRuntime(s: PostDelivery, runtimeId: int, requiresOwnership: bool): PostDelivery = { ...s, runtimes: s.runtimes.append({id: runtimeId, quarantined: false, requiresOwnership: requiresOwnership}) }
pure def canAcquirePostLease(s: PostDelivery, runtimeId: int, room: str, leaseId: int): bool = leaseId > 0 and not(s.issuedLeaseIds.contains(leaseId)) and room != "" and s.runtimes.some(r => r.id == runtimeId) and not(quarantined(s, runtimeId)) and not(s.leases.some(l => l.id == leaseId or (l.runtime == runtimeId and l.room == room)))
pure def acquirePostLease(s: PostDelivery, runtimeId: int, room: str, leaseId: int): PostDelivery = { ...s, issuedLeaseIds: s.issuedLeaseIds.union(Set(leaseId)), leases: s.leases.append({id: leaseId, runtime: runtimeId, room: room}) }
pure def canTrackPostTask(s: PostDelivery, taskId: int, runtimeId: int, room: str, leaseId: int, kind: PostTaskKind, cooperative: bool): bool = taskId > 0 and s.runtimes.some(r => r.id == runtimeId) and not(quarantined(s, runtimeId)) and not(s.issuedTaskIds.contains(taskId)) and (if (kind == DiagnosticTask) room == "" and leaseId == 0 else if (room == "") leaseId == 0 and s.runtimes.some(r => r.id == runtimeId and not(r.requiresOwnership)) else s.leases.some(l => l.id == leaseId and l.runtime == runtimeId and l.room == room))
pure def trackPostTask(s: PostDelivery, taskId: int, runtimeId: int, room: str, leaseId: int, kind: PostTaskKind, cooperative: bool, label: str, waitsForDelivery: bool): PostDelivery = {
  val captured = waitsForDelivery and kind == RoomStateTask and room != ""
  val permission = if (captured) capturedPermission(s, runtimeId, room, leaseId) else AllowedPermission
  { ...s, issuedTaskIds: s.issuedTaskIds.union(Set(taskId)), tasks: s.tasks.append({id: taskId, label: label, runtime: runtimeId, room: room, lease: leaseId, kind: kind, phase: PendingTask, aborted: false, failed: false, invoked: false, cooperative: cooperative, waitsForDelivery: captured, permission: permission, effectApplied: false}) }
}
pure def capturedPermission(s: PostDelivery, runtimeId: int, room: str, leaseId: int): DeliveryPermission =
  if (s.boundaries.some(b => b.runtime == runtimeId and b.room == room and b.lease == leaseId and b.status == WaitingDelivery)) UnknownPermission
  else if (s.boundaries.some(b => b.runtime == runtimeId and b.room == room and b.lease == leaseId and b.status == FailedDelivery)) DeniedPermission
  else AllowedPermission
pure def pendingRuntimeTasks(s: PostDelivery, runtimeId: int): List[PostTask] = s.tasks.select(t => runtimePending(t, runtimeId))
pure def pendingRoomTasks(s: PostDelivery, runtimeId: int, room: str): List[PostTask] = s.tasks.select(t => roomPending(t, runtimeId, room))
pure def runtimePending(t: PostTask, runtimeId: int): bool = t.runtime == runtimeId and t.phase != SettledTask
pure def roomPending(t: PostTask, runtimeId: int, room: str): bool = room != "" and t.room == room and runtimePending(t, runtimeId)
pure val sampleTask: PostTask = {id: 1, label: "reflection", runtime: 1, room: "room-a", lease: 1, kind: RoomStateTask, phase: PendingTask, aborted: false, failed: false, invoked: false, cooperative: false, waitsForDelivery: true, permission: UnknownPermission, effectApplied: false}
pure val tValues = Set(sampleTask, { ...sampleTask, phase: SettledTask }, { ...sampleTask, kind: DiagnosticTask, room: "", lease: 0, waitsForDelivery: false, permission: AllowedPermission })
pure def lawRoomIndexBelongsToRuntime(t: PostTask, runtimeId: int, room: str): bool =
  roomPending(t, runtimeId, room) implies runtimePending(t, runtimeId)
pure def alwaysPendingRoomTaskHasLease(s: PostDelivery): bool = s.tasks.every(t => t.phase != SettledTask and t.room != "" and not(quarantined(s, t.runtime)) implies s.leases.some(l => l.id == t.lease and l.runtime == t.runtime and l.room == t.room))
pure def sometimesRoomAndDiagnosticWorkCoexist(s: PostDelivery): bool = s.tasks.some(a => a.kind == DiagnosticTask and a.phase != SettledTask and s.tasks.some(b => b.runtime == a.runtime and b.kind == RoomStateTask and b.phase != SettledTask))
```

### A canceled drain quarantines the runtime and retains unsettled entries

Pending tasks receive abort requests, and a task that ignores cancellation remains visible until it actually settles. The queued rejection caused by an already aborted controller is reported without invoking the task body. An invoked task awaiting its delivery promise remains tracked until that promise settles.

```quint
pure def mayStartTask(t: PostTask, taskId: int): bool = t.id == taskId and t.phase == PendingTask and not(t.aborted)
pure def canStartPostTask(s: PostDelivery, taskId: int): bool = s.tasks.some(t => mayStartTask(t, taskId))
pure def startedPostTask(t: PostTask): PostTask =
  { ...t, invoked: true, phase: if (t.permission == UnknownPermission) WaitingForDelivery else RunningTask }
pure def startPostTask(s: PostDelivery, taskId: int): PostDelivery =
  { ...s, tasks: s.tasks.listMap(t => if (mayStartTask(t, taskId)) startedPostTask(t) else t) }
pure def maySettleTask(t: PostTask, taskId: int, ok: bool): bool =
  t.id == taskId and (t.phase == RunningTask or (t.phase == PendingTask and t.aborted and not(ok)))
pure def canSettlePostTask(s: PostDelivery, taskId: int, ok: bool): bool = s.tasks.some(t => maySettleTask(t, taskId, ok))
pure def settlePostTask(s: PostDelivery, taskId: int, ok: bool): PostDelivery = { ...s, tasks: s.tasks.listMap(t => if (maySettleTask(t, taskId, ok)) { ...t, phase: SettledTask, failed: not(ok) } else t), reportedFailures: s.reportedFailures + (if (ok) 0 else 1) }
pure def quarantineErrorLabels(s: PostDelivery, runtimeId: int): List[str] = pendingRuntimeTasks(s, runtimeId).listMap(task => task.label)
pure def canQuarantineRuntime(s: PostDelivery, runtimeId: int): bool = s.runtimes.some(r => r.id == runtimeId)
pure def quarantineRuntime(s: PostDelivery, runtimeId: int): PostDelivery = { ...s, runtimes: s.runtimes.listMap(r => if (r.id == runtimeId) { ...r, quarantined: true } else r), tasks: s.tasks.listMap(t => if (t.runtime == runtimeId and t.phase != SettledTask) { ...t, aborted: true } else t) }
pure def runtimeDrained(s: PostDelivery, runtimeId: int): bool = not(quarantined(s, runtimeId)) and pendingRuntimeTasks(s, runtimeId).length() == 0
pure def roomDrained(s: PostDelivery, runtimeId: int, room: str): bool = not(quarantined(s, runtimeId)) and pendingRoomTasks(s, runtimeId, room).length() == 0
pure def stepQuarantinePersists(before: PostDelivery, after: PostDelivery): bool = before.runtimes.every(r => r.quarantined implies after.runtimes.some(other => other.id == r.id and other.quarantined))
pure def alwaysQuarantineAbortsPending(s: PostDelivery): bool = s.tasks.every(t => quarantined(s, t.runtime) and t.phase != SettledTask implies t.aborted)
pure def sometimesCancelledWorkStillPending(s: PostDelivery): bool = s.tasks.some(t => t.aborted and t.phase == RunningTask)
```

## Story: Capture and settle a connector delivery boundary

As a connector I bind delivery to its live room lease and drain the room tasks before removing that boundary.

### Each runtime room has one live delivery boundary

A mismatched or stale lease cannot read or establish the boundary. Delivery failure settles waiting consumers with false. The normal connector wrapper releases room ownership after its drain. Quarantine can reject that drain while task promises remain pending, and then the wrapper still removes its boundary and releases the lease.

```quint
pure def canBeginDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str, leaseId: int): bool = s.leases.some(l => l.id == leaseId and l.runtime == runtimeId and l.room == room) and not(s.boundaries.some(b => b.runtime == runtimeId and b.room == room))
pure def beginDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str, leaseId: int): PostDelivery = { ...s, boundaries: s.boundaries.append({runtime: runtimeId, room: room, lease: leaseId, status: WaitingDelivery}) }
pure def deliveryAccessAllowed(s: PostDelivery, runtimeId: int, room: str, leaseId: int): bool = not(s.boundaries.some(b => b.runtime == runtimeId and b.room == room)) or (s.boundaries.some(b => b.runtime == runtimeId and b.room == room and b.lease == leaseId) and s.leases.some(l => l.id == leaseId and l.runtime == runtimeId and l.room == room))
pure def canSettleDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str, delivered: bool): bool = s.boundaries.some(b => b.runtime == runtimeId and b.room == room and b.status == WaitingDelivery)
pure def settleDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str, delivered: bool): PostDelivery = { ...s, boundaries: s.boundaries.listMap(b => if (b.runtime == runtimeId and b.room == room) { ...b, status: if (delivered) SavedDelivery else FailedDelivery } else b), tasks: s.tasks.listMap(t => if (t.runtime == runtimeId and t.room == room and t.permission == UnknownPermission and (t.phase == PendingTask or t.phase == WaitingForDelivery)) { ...t, permission: if (delivered) AllowedPermission else DeniedPermission } else t) }
pure def canRemoveDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str): bool = s.boundaries.some(b => b.runtime == runtimeId and b.room == room and b.status != WaitingDelivery) and (quarantined(s, runtimeId) or pendingRoomTasks(s, runtimeId, room).length() == 0)
pure def removeDeliveryBoundary(s: PostDelivery, runtimeId: int, room: str): PostDelivery = { ...s, boundaries: s.boundaries.select(b => b.runtime != runtimeId or b.room != room) }
pure def canReleasePostLease(s: PostDelivery, runtimeId: int, room: str, leaseId: int): bool = not(s.boundaries.some(b => b.runtime == runtimeId and b.room == room)) and (quarantined(s, runtimeId) or pendingRoomTasks(s, runtimeId, room).length() == 0) and s.leases.some(l => l.id == leaseId and l.runtime == runtimeId and l.room == room)
pure def releasePostLease(s: PostDelivery, runtimeId: int, room: str, leaseId: int): PostDelivery = { ...s, leases: s.leases.select(l => l.id != leaseId) }
pure def alwaysDeliveryBoundaryOwned(s: PostDelivery): bool = s.boundaries.every(b => s.leases.some(l => l.id == b.lease and l.runtime == b.runtime and l.room == b.room))
pure def alwaysOneBoundaryPerRoom(s: PostDelivery): bool = s.boundaries.every(b => s.boundaries.select(other => other.runtime == b.runtime and other.room == b.room).length() == 1)
pure def sometimesFailedDeliveryRetainsBoundary(s: PostDelivery): bool = s.boundaries.some(b => b.status == FailedDelivery and pendingRoomTasks(s, b.runtime, b.room).length() > 0)
```

### Each drain waits for its captured batch and observes newly spawned work

A drain call counts each captured task batch, waits for those original promises, and captures newly admitted work before returning. An initially empty drain returns before looking at its signal. An already aborted signal quarantines a nonempty runtime before capturing a batch. The cancellation error carries pending labels in registration order. External quarantine prevents new drains and an existing drain can still finish after its captured tasks settle.

```quint
pure val drainIdValues = Set(1, 2, 3)
pure def drainTasks(s: PostDelivery, runtimeId: int, room: str): List[PostTask] = if (room == "") pendingRuntimeTasks(s, runtimeId) else pendingRoomTasks(s, runtimeId, room)
pure def canBeginPostDrain(s: PostDelivery, drainId: int, runtimeId: int, room: str, abortable: bool): bool = drainId > 0 and s.runtimes.some(r => r.id == runtimeId) and not(s.issuedDrainIds.contains(drainId))
pure def beginPostDrain(s: PostDelivery, drainId: int, runtimeId: int, room: str, abortable: bool, alreadyAborted: bool): PostDelivery = {
  val tasks = drainTasks(s, runtimeId, room)
  val cancelled = room == "" and abortable and alreadyAborted and tasks.length() > 0
  val prior = if (cancelled) quarantineRuntime(s, runtimeId) else s
  val rejected = quarantined(s, runtimeId) or cancelled
  val snapshot = if (rejected) List() else tasks
  { ...prior, issuedDrainIds: s.issuedDrainIds.union(Set(drainId)),
    drains: s.drains.append({id: drainId, entryAborted: alreadyAborted and abortable and room == "", runtime: runtimeId, room: room, abortable: abortable and room == "", phase: if (rejected) DrainFailed else if (tasks.length() == 0) DrainDone else DrainRunning, snapshot: snapshot.listMap(t => t.id), drained: snapshot.length(), failureLabels: if (rejected) quarantineErrorLabels(s, runtimeId) else List()}) }
}
pure def canFinishPostDrainBatch(s: PostDelivery, drainId: int): bool = s.drains.some(d => d.id == drainId and d.phase == DrainRunning and d.snapshot.every(id => s.tasks.some(t => t.id == id and t.phase == SettledTask)))
pure def finishPostDrainBatch(s: PostDelivery, drainId: int): PostDelivery = { ...s, drains: s.drains.listMap(d => if (d.id != drainId) d else { ...d, phase: if (drainTasks(s, d.runtime, d.room).length() == 0) DrainDone else DrainRunning, snapshot: drainTasks(s, d.runtime, d.room).listMap(t => t.id), drained: d.drained + drainTasks(s, d.runtime, d.room).length() }) }
pure def canCancelPostDrain(s: PostDelivery, drainId: int): bool = s.drains.some(d => d.id == drainId and d.phase == DrainRunning and d.abortable)
pure def cancelPostDrain(s: PostDelivery, drainId: int): PostDelivery = {
  val runtimeId = s.drains.select(d => d.id == drainId).nthOr(0, noPostDrain).runtime
  val quarantinedState = quarantineRuntime(s, runtimeId)
  { ...quarantinedState, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, phase: DrainFailed } else d) }
}
pure def alwaysDrainCountsNonnegative(s: PostDelivery): bool = s.drains.every(d => d.drained >= 0)
pure def alwaysLiveTasksWereIssued(s: PostDelivery): bool = s.tasks.every(t => s.issuedTaskIds.contains(t.id))
pure def alwaysLiveDrainsWereIssued(s: PostDelivery): bool = s.drains.every(d => s.issuedDrainIds.contains(d.id))
pure def alwaysUnstartedTasksCannotApply(s: PostDelivery): bool = s.tasks.every(t =>
  (t.phase == PendingTask implies not(t.invoked) and not(t.effectApplied)) and
  ((t.phase == RunningTask or t.phase == WaitingForDelivery) implies t.invoked))
pure def sometimesEmptyAbortedDrainReturns(s: PostDelivery): bool =
  s.drains.some(d => d.phase == DrainDone and d.entryAborted and d.drained == 0 and not(quarantined(s, d.runtime)))
pure def sometimesDrainCapturesSecondBatch(s: PostDelivery): bool = s.drains.some(d => d.drained > d.snapshot.length() and d.phase == DrainRunning)
pure def sometimesQuarantineDrainFails(s: PostDelivery): bool = s.drains.some(d => d.phase == DrainFailed and quarantined(s, d.runtime))
```

### Delivery permission is captured before room-state effects run

Evidence-bearing work explicitly captures the current delivery promise before
starting. Ordinary tracked tasks can run independently of delivery. Captured
work receives the boundary result even if invocation or continuation happens
after cleanup. A failed delivery prevents its effects. An abort prevents an uninvoked task from running, while an already invoked task may ignore cancellation only when its implementation is noncooperative.

```quint
pure def mayResumeTask(t: PostTask, taskId: int): bool =
  t.id == taskId and t.phase == WaitingForDelivery and t.permission != UnknownPermission
pure def canResumePostTask(s: PostDelivery, taskId: int): bool = s.tasks.some(t => mayResumeTask(t, taskId))
pure def resumePostTask(s: PostDelivery, taskId: int): PostDelivery = { ...s, tasks: s.tasks.listMap(t => if (mayResumeTask(t, taskId)) { ...t, phase: RunningTask } else t) }
pure def mayApplyTask(t: PostTask, taskId: int): bool =
  t.id == taskId and t.phase == RunningTask and t.permission == AllowedPermission and not(t.cooperative and t.aborted)
pure def canApplyPostTaskEffect(s: PostDelivery, taskId: int): bool = s.tasks.some(t => mayApplyTask(t, taskId))
pure def applyPostTaskEffect(s: PostDelivery, taskId: int): PostDelivery = { ...s, tasks: s.tasks.listMap(t => if (mayApplyTask(t, taskId)) { ...t, effectApplied: true } else t) }
pure def alwaysEffectsRequireInvocation(s: PostDelivery): bool = s.tasks.every(t => t.effectApplied implies t.invoked)
pure def alwaysDeniedDeliveryBlocksEffects(s: PostDelivery): bool = s.tasks.every(t => t.permission == DeniedPermission implies not(t.effectApplied))
pure def alwaysAbortedBeforeInvocationHasNoEffect(s: PostDelivery): bool = s.tasks.every(t => t.aborted and not(t.invoked) implies not(t.effectApplied))
pure def alwaysCapturedSettlementRetained(s: PostDelivery): bool = s.tasks.every(t => t.phase == WaitingForDelivery and not(s.boundaries.some(b => b.runtime == t.runtime and b.room == t.room)) implies t.permission != UnknownPermission)
pure def alwaysUnresolvedCaptureHasBoundary(s: PostDelivery): bool = s.tasks.every(t =>
  t.phase != SettledTask and t.permission == UnknownPermission implies
    t.waitsForDelivery and s.boundaries.some(b =>
      b.runtime == t.runtime and b.room == t.room and b.lease == t.lease and b.status == WaitingDelivery))
pure def sometimesNoncooperativeTaskContinues(s: PostDelivery): bool = s.tasks.some(t => t.aborted and not(t.cooperative) and t.effectApplied)
```

### Quarantine preserves pending ownership and successful drains return empty

Entering quarantine retains every pending entry and prevents new task admission. Each newly completed drain observes an empty scope at its return boundary.

Progress assumes that delivery and invoked task promises eventually settle
and that only finitely many new tasks enter a draining scope. A callback that
ignores its signal can postpone that scope indefinitely.

```quint
pure def stepQuarantineRetainsPending(before: PostDelivery, after: PostDelivery): bool = before.runtimes.every(r => not(r.quarantined) and quarantined(after, r.id) implies pendingRuntimeTasks(before, r.id).every(t => pendingRuntimeTasks(after, r.id).some(retained => retained.id == t.id)))
pure def stepQuarantinePreventsNewTasks(before: PostDelivery, after: PostDelivery): bool = before.runtimes.every(r => r.quarantined implies after.tasks.every(t => t.runtime != r.id or before.tasks.some(old => old.id == t.id)))
pure def stepDrainsReturnEmpty(before: PostDelivery, after: PostDelivery): bool = after.drains.every(d => d.phase == DrainDone and not(before.drains.some(old => old.id == d.id and old.phase == DrainDone)) implies drainTasks(after, d.runtime, d.room).length() == 0)
pure def stepInvocationChecksAbort(before: PostDelivery, via: str, after: PostDelivery): bool =
  via == "startPostTask" implies after.tasks.every(t => t.invoked implies before.tasks.some(prior =>
    prior.id == t.id and (prior.invoked or not(prior.aborted))))
pure val fair_startPostTask = "strong"
pure val fair_settlePostTask = "strong"
pure val fair_resumePostTask = "strong"
pure val fair_settleDeliveryBoundary = "strong"
pure val fair_finishPostDrainBatch = "strong"
pure def leadsToPostDrainsFinish(s: PostDelivery, later: PostDelivery): bool = s.drains.every(d => d.phase == DrainRunning implies later.drains.some(done => done.id == d.id and done.phase != DrainRunning))
```
