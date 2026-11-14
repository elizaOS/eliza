# Retire approval work only after admitted reads settle

Source `services/approval.ts:153-209,470-503,663-725` uses the same `RuntimeRetirement` instance for approval work and independent reads. This composition owns the [approval service](./approvalService.md) and its [retirement tracker](./retirementTracker.md), rather than equating an empty pending-approval map with storage quiescence. Work already owned by an approval record remains subject to that component's claim/delete barriers; independent read promises use the tracker directly.

## Story: Stop waits for approvals and their independent queries

A room-list request queries that room; an agent-wide list queries all rooms for the same agent. Both use the approval and awaiting-choice tags. Worker permission reads use the given room and agent, find the named task, and may await room and role resolution. A matching task without a role list passes; a missing task denies. Provider failure rejects that caller and still releases its retirement ownership.

### Query identity is published before the storage or permission await

The query record names scope and current phase, while the retirement tracker is the only owner of the active promise. Room and role results are explicit trusted host observations. No result is fabricated while a query is pending or after its error. Each admitted read retains a unique positive promise identity. Discovered by the proof: removing a settled promise cannot retire a still-unsettled promise; the release guard names this explicitly. For a restricted task an absent world permits the direct-room case; with a world, the exact observed role must be in the allowed list.

```quint
import approvalService as AS from "./approvalService"
import approvals as A from "./approvals"
import approvalWorkers as W from "./approvalWorkers"
import retirementTracker as R from "./retirementTracker"
type ApprovalReadKind = RoomPendingList | AgentPendingList | WorkerPermission
type ApprovalReadPhase = AwaitTasks | AwaitRoom | AwaitRole | ReadReturned | ReadDenied | ReadRejected
type ApprovalQuery = { workId: int, kind: ApprovalReadKind, agentId: str, roomId: str, workerName: str, allowedRoles: Set[str], phase: ApprovalReadPhase, resultRows: List[str] }
type ApprovalRetirement = { approvals: AS::ApprovalServiceState, tracker: R::RetirementTracker, queries: List[ApprovalQuery], drainId: int }
pure val initial: ApprovalRetirement = { approvals: AS::initial, tracker: R::initial, queries: List(), drainId: 0 }
pure val emptyQuery: ApprovalQuery = { workId: 0, kind: AgentPendingList, agentId: "", roomId: "", workerName: "", allowedRoles: Set(), phase: ReadRejected, resultRows: List() }
pure val workIdValues = Set(1, 2)
pure val drainIdValues = Set(1, 2)
pure val roomIdValues = Set("", "room")
pure val agentIdValues = Set("agent")
pure val workerNameValues = Set("", "permission")
pure val resultRowsValues = Set(List(), List("task"))
pure val allowedRolesValues = Set(Set(), Set("owner"), Set("owner", "admin"))
pure val roleValues = Set("", "owner", "guest")
pure def readAt(s: ApprovalRetirement, workId: int): ApprovalQuery = s.queries.select(query => query.workId == workId).nthOr(0, emptyQuery)
pure def putRead(query: ApprovalQuery, s: ApprovalRetirement): List[ApprovalQuery] = s.queries.listMap(prior => if (prior.workId == query.workId) query else prior)
pure def canAdmitRead(s: ApprovalRetirement, workId: int, kind: ApprovalReadKind, agentId: str, roomId: str, workerName: str): bool = not(s.approvals.stopping) and agentId != "" and (if (kind == AgentPendingList) roomId == "" else roomId != "") and (kind != WorkerPermission or workerName != "") and R::canPublishWork(s.tracker, workId, false)
pure def admitRead(s: ApprovalRetirement, workId: int, kind: ApprovalReadKind, agentId: str, roomId: str, workerName: str): ApprovalRetirement = { ...s, tracker: R::invokeWork(R::publishWork(s.tracker, workId, false), workId), queries: s.queries.append({ workId: workId, kind: kind, agentId: agentId, roomId: roomId, workerName: workerName, allowedRoles: Set(), phase: AwaitTasks, resultRows: List() }) }
pure def readFinished(phase: ApprovalReadPhase): bool = phase == ReadReturned or phase == ReadDenied or phase == ReadRejected
pure def readCompletion(query: ApprovalQuery, s: ApprovalRetirement): R::RetirementTracker = if (readFinished(query.phase)) R::settleWork(s.tracker, query.workId, if (query.phase == ReadRejected) "read-rejected" else "") else s.tracker
pure def canSettleTasks(s: ApprovalRetirement, workId: int, ok: bool, resultRows: List[str], foundWorkerTask: bool, allowedRoles: Set[str]): bool = readAt(s, workId).phase == AwaitTasks
pure def settleTasks(s: ApprovalRetirement, workId: int, ok: bool, resultRows: List[str], foundWorkerTask: bool, allowedRoles: Set[str]): ApprovalRetirement = {
  val prior = readAt(s, workId)
  val phase = if (not(ok)) ReadRejected else if (prior.kind != WorkerPermission) ReadReturned else if (not(foundWorkerTask)) ReadDenied else if (allowedRoles.size() == 0) ReadReturned else AwaitRoom
  val query = { ...prior, phase: phase, allowedRoles: if (phase == AwaitRoom) allowedRoles else Set(), resultRows: if (ok and prior.kind != WorkerPermission) resultRows else List() }
  { ...s, queries: putRead(query, s), tracker: readCompletion(query, s) }
}
pure def canSettleRoom(s: ApprovalRetirement, workId: int, ok: bool, worldPresent: bool): bool = readAt(s, workId).phase == AwaitRoom
pure def settleRoom(s: ApprovalRetirement, workId: int, ok: bool, worldPresent: bool): ApprovalRetirement = {
  val phase: ApprovalReadPhase = if (not(ok)) ReadRejected else if (worldPresent) AwaitRole else ReadReturned
  val query = { ...readAt(s, workId), phase: phase }
  { ...s, queries: putRead(query, s), tracker: readCompletion(query, s) }
}
pure def canSettleRole(s: ApprovalRetirement, workId: int, ok: bool, role: str): bool = readAt(s, workId).phase == AwaitRole
pure def settleRole(s: ApprovalRetirement, workId: int, ok: bool, role: str): ApprovalRetirement = {
  val prior = readAt(s, workId)
  val phase: ApprovalReadPhase = if (not(ok)) ReadRejected else if (role != "" and prior.allowedRoles.contains(role)) ReadReturned else ReadDenied
  val query = { ...prior, phase: phase }
  { ...s, queries: putRead(query, s), tracker: readCompletion(query, s) }
}
pure def canReleaseRead(s: ApprovalRetirement, workId: int): bool = R::canRemoveSettled(s.tracker, workId) and not(s.tracker.works.some(work => work.id == workId and not(work.settled)))
pure def releaseRead(s: ApprovalRetirement, workId: int): ApprovalRetirement = { ...s, tracker: R::removeSettled(s.tracker, workId) }
```

### Stop closes admission and joins the original read and approval work

A drain snapshots its active promises and waits for their settlement and pending-map removal. It resnapshots after a settled batch. The approval service cannot retire until both its original record owners and the composed retirement drain finish.

```quint
pure val idValues = AS::idValues
pure val nameValues = AS::nameValues
pure val desiredValues = A::desiredValues
pure val timeoutMsValues = AS::timeoutMsValues
pure val elapsedValues = AS::elapsedValues
pure val nowValues = AS::nowValues
pure def canElapse(s: ApprovalRetirement, elapsed: int): bool = AS::canElapse(s.approvals, elapsed)
pure def elapse(s: ApprovalRetirement, elapsed: int): ApprovalRetirement = { ...s, approvals: AS::elapse(s.approvals, elapsed) }
pure def canObserveTime(s: ApprovalRetirement, now: int): bool = AS::canObserveTime(s.approvals, now)
pure def observeTime(s: ApprovalRetirement, now: int): ApprovalRetirement = { ...s, approvals: AS::observeTime(s.approvals, now) }
pure def canAdmit(s: ApprovalRetirement, id: str, name: str, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int): bool = AS::canAdmit(s.approvals, id, name, callbackRequired, registrationSucceeds, timeoutMs)
pure def admit(s: ApprovalRetirement, id: str, name: str, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int): ApprovalRetirement = { ...s, approvals: AS::admit(s.approvals, id, name, callbackRequired, registrationSucceeds, timeoutMs) }
pure def canFinishWrite(s: ApprovalRetirement, id: str, succeeded: bool): bool = AS::canFinishWrite(s.approvals, id, succeeded)
pure def finishWrite(s: ApprovalRetirement, id: str, succeeded: bool): ApprovalRetirement = { ...s, approvals: AS::finishWrite(s.approvals, id, succeeded) }
pure def canClaim(s: ApprovalRetirement, id: str, desired: A::Resolution): bool = AS::canClaim(s.approvals, id, desired)
pure def claim(s: ApprovalRetirement, id: str, desired: A::Resolution): ApprovalRetirement = { ...s, approvals: AS::claim(s.approvals, id, desired) }
pure def canCallback(s: ApprovalRetirement, id: str, succeeded: bool): bool = AS::canCallback(s.approvals, id, succeeded)
pure def callback(s: ApprovalRetirement, id: str, succeeded: bool): ApprovalRetirement = { ...s, approvals: AS::callback(s.approvals, id, succeeded) }
pure def canDeleteResult(s: ApprovalRetirement, id: str, succeeded: bool): bool = AS::canDeleteResult(s.approvals, id, succeeded)
pure def deleteResult(s: ApprovalRetirement, id: str, succeeded: bool): ApprovalRetirement = { ...s, approvals: AS::deleteResult(s.approvals, id, succeeded) }
pure def canLegacyCancel(s: ApprovalRetirement, id: str): bool = AS::canLegacyCancel(s.approvals, id)
pure def legacyCancel(s: ApprovalRetirement, id: str): ApprovalRetirement = { ...s, approvals: AS::legacyCancel(s.approvals, id) }
pure def canStop(s: ApprovalRetirement, drainId: int): bool = AS::canStop(s.approvals) and R::canBeginDrain(s.tracker, drainId, false)
pure def stop(s: ApprovalRetirement, drainId: int): ApprovalRetirement = { ...s, approvals: AS::stop(s.approvals), tracker: R::beginDrain(s.tracker, drainId, false), drainId: drainId }
pure def canSnapshotReads(s: ApprovalRetirement): bool = R::canSnapshotDrain(s.tracker, s.drainId)
pure def snapshotReads(s: ApprovalRetirement): ApprovalRetirement = { ...s, tracker: R::snapshotDrain(s.tracker, s.drainId) }
pure def canFinishReadBatch(s: ApprovalRetirement): bool = R::canFinishBatch(s.tracker, s.drainId)
pure def finishReadBatch(s: ApprovalRetirement): ApprovalRetirement = { ...s, tracker: R::finishBatch(s.tracker, s.drainId) }
pure def canRetire(s: ApprovalRetirement): bool = AS::canRetire(s.approvals) and s.tracker.drains.some(drain => drain.id == s.drainId and drain.returned) and not(s.tracker.works.some(work => work.active))
pure def retire(s: ApprovalRetirement): ApprovalRetirement = { ...s, approvals: AS::retire(s.approvals) }
pure def alwaysRetiredHasNoReadOwner(s: ApprovalRetirement): bool = s.approvals.retired implies (s.approvals.stopping and not(s.tracker.works.some(work => work.active)))
pure def alwaysReadIdentitiesAreUnique(s: ApprovalRetirement): bool = s.queries.every(query => query.workId > 0 and s.queries.select(other => other.workId == query.workId).length() == 1)
pure def alwaysReadPromisesStayAccounted(s: ApprovalRetirement): bool = s.tracker.generation == s.queries.length() and R::alwaysGenerationCountsAdmissions(s.tracker) and s.queries.every(query => s.tracker.works.some(work => work.id == query.workId and work.invoked and (work.settled == readFinished(query.phase)) and (work.active or readFinished(query.phase))))
pure def alwaysApprovalComponentIsConsistent(s: ApprovalRetirement): bool = AS::alwaysPendingMapOwnsExactlyPending(s.approvals) and AS::alwaysArmedTimersBelongToPending(s.approvals) and AS::alwaysCancellableRecordsKeepDeadline(s.approvals) and AS::alwaysApprovalRecordsAreUnique(s.approvals) and AS::alwaysAllComponentsRetainSafety(s.approvals) and AS::alwaysRetirementDrainsEveryApproval(s.approvals)
pure def alwaysStopClosesAdmission(s: ApprovalRetirement): bool = (s.drainId != 0) == s.approvals.stopping
pure def sometimesStoppedWithPermissionAwait(s: ApprovalRetirement): bool = s.approvals.stopping and s.queries.some(query => query.kind == WorkerPermission and query.phase == AwaitRole)
pure def sometimesReadRejectionStillRetires(s: ApprovalRetirement): bool = s.approvals.retired and s.queries.some(query => query.phase == ReadRejected)
pure val fair_settleTasks = "weak"
pure val fair_settleRoom = "weak"
pure val fair_settleRole = "weak"
pure val fair_releaseRead = "weak"
pure val fair_snapshotReads = "weak"
pure val fair_finishReadBatch = "weak"
pure val fair_finishWrite = "weak"
pure val fair_callback = "weak"
pure val fair_deleteResult = "weak"
pure val fair_retire = "weak"
pure def leadsToReadRetirement(s: ApprovalRetirement, later: ApprovalRetirement): bool = s.approvals.stopping implies later.approvals.retired
```
