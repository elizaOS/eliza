# Approval service aggregate

The source is `packages/core/src/services/approval.ts:153-209,233-375,588-659`. This aggregate owns the pending-approval ID map, in-flight request records, service-wide retirement and the [worker-name registry](./approvalWorkers.md). Each approval record embeds the [single approval protocol](./approvals.md); those components have no independently running owner when composed here. Claimed callbacks leave the pending map immediately but their in-flight records remain until completion.

## Story: Drain every approval without crossing identities

### Admission and callback ownership compose under one service stop

Absolute wall-clock observations may move backward. An armed timer retains its remaining monotonic delay across such observations. A failed receipt cancellation rearms from the same absolute expiry using the then-current wall clock, as the source `Math.max(0, expiresAt - Date.now())` requires.

Discovered by the proof: even an empty retired service must already be stopping. A cancellable record retains its persisted deadline while its timer is disarmed, so a refused deletion can restore the same deadline.

```quint
import approvals as A from "./approvals"
import approvalWorkers as W from "./approvalWorkers"
type ServiceApproval = { id: str, name: str, timeoutMs: int, createdAt: int, expiresAt: int, timeoutRemaining: int, timeoutArmed: bool, approval: A::Approval }
type ApprovalServiceState = { now: int, records: List[ServiceApproval], pendingIds: Set[str], workers: W::ApprovalWorkers, stopping: bool, retired: bool, lastRejectedId: str }
pure val initial: ApprovalServiceState = { now: 0, records: List(), pendingIds: Set(), workers: W::initial, stopping: false, retired: false, lastRejectedId: "" }
pure val absent: ServiceApproval = { id: "", name: "", timeoutMs: 0, createdAt: 0, expiresAt: 0, timeoutRemaining: 0, timeoutArmed: false, approval: A::initial }
pure val idValues = Set("approval1", "approval2", "unknown")
pure val nameValues = W::nameValues
pure val desiredValues = A::desiredValues
pure val timeoutMsValues = Set(0, 1, 10)
pure val elapsedValues = Set(0, 1, 10)
pure def canElapse(s: ApprovalServiceState, elapsed: int): bool = elapsed >= 0
pure def elapse(s: ApprovalServiceState, elapsed: int): ApprovalServiceState = { ...s, now: s.now + elapsed, records: s.records.listMap(record => if (record.timeoutArmed) { ...record, timeoutRemaining: if (elapsed >= record.timeoutRemaining) 0 else record.timeoutRemaining - elapsed } else record) }
pure val nowValues = Set(0, 1, 5, 10)
pure def canObserveTime(s: ApprovalServiceState, now: int): bool = now >= 0
pure def observeTime(s: ApprovalServiceState, now: int): ApprovalServiceState = { ...s, now: now }
pure def approvalAt(s: ApprovalServiceState, id: str): ServiceApproval = s.records.select(record => record.id == id).nthOr(0, absent)
pure def replaceApproval(record: ServiceApproval, s: ApprovalServiceState): ApprovalServiceState = { ...s, records: s.records.listMap(existing => if (existing.id == record.id) record else existing) }
pure def canAdmit(s: ApprovalServiceState, id: str, name: str, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int): bool = not(s.stopping) and id != "" and not(s.records.some(record => record.id == id))
pure def admit(s: ApprovalServiceState, id: str, name: str, callbackRequired: bool, registrationSucceeds: bool, timeoutMs: int): ApprovalServiceState = {
  val workers = W::ensureWorker(s.workers, name, registrationSucceeds)
  if (W::taskMayPersist(workers, name)) { ...s, workers: workers, records: s.records.append({ id: id, name: name, timeoutMs: timeoutMs, createdAt: 0, expiresAt: 0, timeoutRemaining: 0, timeoutArmed: false, approval: A::write(A::initial, callbackRequired) }) }
  else { ...s, workers: workers, lastRejectedId: id }
}
pure def canFinishWrite(s: ApprovalServiceState, id: str, succeeded: bool): bool = approvalAt(s, id).approval.phase == A::Writing
pure def finishWrite(s: ApprovalServiceState, id: str, succeeded: bool): ApprovalServiceState = {
  val record = approvalAt(s, id)
  val nextState = if (not(succeeded)) A::writeFailed(record.approval) else if (s.stopping) A::finishLateWrite(record.approval) else A::publish(record.approval)
  { ...replaceApproval({ ...record, approval: nextState, createdAt: s.now, expiresAt: s.now + (if (record.timeoutMs > 0) record.timeoutMs else 0), timeoutRemaining: if (record.timeoutMs > 0) record.timeoutMs else 0, timeoutArmed: nextState.phase == A::Pending and record.timeoutMs > 0 }, s), pendingIds: if (nextState.phase == A::Pending) s.pendingIds.union(Set(id)) else s.pendingIds.exclude(Set(id)) }
}
pure def canClaim(s: ApprovalServiceState, id: str, desired: A::Resolution): bool = s.pendingIds.contains(id) and A::canClaim(approvalAt(s, id).approval, desired) and (desired != A::TimedOut or (approvalAt(s, id).timeoutArmed and approvalAt(s, id).timeoutRemaining == 0))
pure def claim(s: ApprovalServiceState, id: str, desired: A::Resolution): ApprovalServiceState = { ...replaceApproval({ ...approvalAt(s, id), approval: A::claim(approvalAt(s, id).approval, desired), timeoutArmed: false }, s), pendingIds: if (desired == A::Cancelled) s.pendingIds else s.pendingIds.exclude(Set(id)) }
pure def canCallback(s: ApprovalServiceState, id: str, succeeded: bool): bool = approvalAt(s, id).id != "" and A::canCallback(approvalAt(s, id).approval, succeeded)
pure def callback(s: ApprovalServiceState, id: str, succeeded: bool): ApprovalServiceState = replaceApproval({ ...approvalAt(s, id), approval: A::callback(approvalAt(s, id).approval, succeeded) }, s)
pure def canDeleteResult(s: ApprovalServiceState, id: str, succeeded: bool): bool = A::canDeleted(approvalAt(s, id).approval)
pure def deleteResult(s: ApprovalServiceState, id: str, succeeded: bool): ApprovalServiceState = {
  val record = approvalAt(s, id)
  val outcomeState = if (succeeded) A::deleted(record.approval) else A::deleteFailed(record.approval)
  { ...replaceApproval({ ...record, approval: outcomeState, timeoutArmed: outcomeState.phase == A::Pending and record.timeoutMs > 0, timeoutRemaining: if (outcomeState.phase == A::Pending and record.expiresAt > s.now) record.expiresAt - s.now else 0 }, s), pendingIds: if (outcomeState.phase == A::Pending) s.pendingIds.union(Set(id)) else s.pendingIds.exclude(Set(id)) }
}
pure def canLegacyCancel(s: ApprovalServiceState, id: str): bool = A::canLegacyCancel(approvalAt(s, id).approval)
pure def legacyCancel(s: ApprovalServiceState, id: str): ApprovalServiceState = { ...replaceApproval({ ...approvalAt(s, id), approval: A::legacyCancel(approvalAt(s, id).approval), timeoutArmed: false }, s), pendingIds: s.pendingIds.exclude(Set(id)) }
pure def canStop(s: ApprovalServiceState): bool = not(s.stopping)
pure def stop(s: ApprovalServiceState): ApprovalServiceState = { ...s, stopping: true, pendingIds: Set(), records: s.records.listMap(record => { ...record, approval: A::stop(record.approval), timeoutArmed: false }) }
pure def canRetire(s: ApprovalServiceState): bool = s.stopping and not(s.retired) and s.records.every(record => record.approval.phase == A::Terminal)
pure def retire(s: ApprovalServiceState): ApprovalServiceState = { ...s, retired: true, records: s.records.listMap(record => { ...record, approval: A::retire(record.approval) }) }
pure def alwaysPendingMapOwnsExactlyPending(s: ApprovalServiceState): bool = s.records.every(record => ((record.approval.phase == A::Pending or record.approval.phase == A::Cancelling) and not(s.stopping)) == s.pendingIds.contains(record.id)) and (if (s.stopping) s.pendingIds.size() == 0 else s.pendingIds.forall(id => s.records.some(record => record.id == id)))
pure def alwaysArmedTimersBelongToPending(s: ApprovalServiceState): bool = s.now >= 0 and s.records.every(record => record.timeoutArmed implies record.approval.phase == A::Pending and not(s.stopping) and record.timeoutMs > 0 and record.timeoutRemaining >= 0 and record.expiresAt == record.createdAt + record.timeoutMs)
pure def alwaysCancellableRecordsKeepDeadline(s: ApprovalServiceState): bool = s.records.every(record => ((record.approval.phase == A::Pending or record.approval.phase == A::Cancelling) and record.timeoutMs > 0) implies record.expiresAt == record.createdAt + record.timeoutMs)
pure def alwaysApprovalRecordsAreUnique(s: ApprovalServiceState): bool = s.records.every(record => record.id != "" and s.records.select(other => other.id == record.id).length() == 1 and s.workers.registered.contains(record.name))
pure def alwaysAllComponentsRetainSafety(s: ApprovalServiceState): bool = W::alwaysCountMatchesDistinctWorkers(s.workers) and s.records.every(record => A::validApproval(record.approval) and record.approval.stopping == s.stopping)
pure def alwaysRetirementDrainsEveryApproval(s: ApprovalServiceState): bool = s.retired implies s.stopping and s.pendingIds.size() == 0 and s.records.every(record => record.approval.retired)
pure def sometimesTwoPendingApprovals(s: ApprovalServiceState): bool = s.pendingIds.size() > 1
pure val fair_finishWrite = "weak"
pure val fair_callback = "weak"
pure val fair_deleteResult = "weak"
pure val fair_retire = "weak"
pure def leadsToServiceRetires(s: ApprovalServiceState, later: ApprovalServiceState): bool = s.stopping implies later.retired
```
