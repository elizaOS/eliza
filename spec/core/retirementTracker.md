# Retirement promise identities and failures

The source is `packages/core/src/runtime/retirement.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This owner retains the exact pending promise identities, before-close classification, append-only failure records and run-admission generation. Rejection of a run does not itself record a retirement failure; callers explicitly call recordFailure.

## Story: Drain every owned retirement operation and report retained failures

As a shutdown caller I wait for original operations and work they spawn. A before-close drain considers only before-close work and failures. Every run increments generation before invoking user code; completion and recorded failures do not increment it.

### Promise publication precedes invocation and drains re-snapshot after settlement

```quint
type RetirementWork = {id: int, beforeClose: bool, invoked: bool, settled: bool, active: bool, errorId: str}
type RetirementFailure = {id: int, scope: str, cause: str, beforeClose: bool}
type RetirementDrain = {id: int, beforeCloseOnly: bool, batch: List[int], waiting: bool, returned: bool, failures: List[RetirementFailure]}
type RetirementTracker = {works: List[RetirementWork], failures: List[RetirementFailure], drains: List[RetirementDrain], generation: int}
pure val initial: RetirementTracker = {works: List(), failures: List(), drains: List(), generation: 0}
pure val workIdValues = Set(1, 2, 3)
pure val drainIdValues = Set(1, 2)
pure val failureIdValues = Set(1, 2)
pure val scopeValues = Set("stop:service", "adapter:close")
pure val causeValues = Set("original-error", "second-error")
pure val errorIdValues = causeValues
pure def canPublishWork(s: RetirementTracker, workId: int, beforeClose: bool): bool = workId > 0 and not(s.works.some(w => w.id == workId))
pure def publishWork(s: RetirementTracker, workId: int, beforeClose: bool): RetirementTracker = { ...s, works: s.works.append({id: workId, beforeClose: beforeClose, invoked: false, settled: false, active: true, errorId: ""}), generation: s.generation + 1 }
pure def canInvokeWork(s: RetirementTracker, workId: int): bool = s.works.some(w => w.id == workId and not(w.invoked))
pure def invokeWork(s: RetirementTracker, workId: int): RetirementTracker = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, invoked: true } else w) }
pure def canSettleWork(s: RetirementTracker, workId: int, errorId: str): bool = s.works.some(w => w.id == workId and w.invoked and not(w.settled))
pure def settleWork(s: RetirementTracker, workId: int, errorId: str): RetirementTracker = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, settled: true, errorId: errorId } else w) }
pure def canRemoveSettled(s: RetirementTracker, workId: int): bool = s.works.some(w => w.id == workId and w.settled and w.active)
pure def removeSettled(s: RetirementTracker, workId: int): RetirementTracker = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, active: false } else w) }
pure def canRecordFailure(s: RetirementTracker, failureId: int, scope: str, cause: str, beforeClose: bool): bool = failureId > 0 and not(s.failures.some(f => f.id == failureId))
pure def recordFailure(s: RetirementTracker, failureId: int, scope: str, cause: str, beforeClose: bool): RetirementTracker = { ...s, failures: s.failures.append({id: failureId, scope: scope, cause: cause, beforeClose: beforeClose}) }
pure def canBeginDrain(s: RetirementTracker, drainId: int, beforeCloseOnly: bool): bool = drainId > 0 and not(s.drains.some(d => d.id == drainId))
pure def beginDrain(s: RetirementTracker, drainId: int, beforeCloseOnly: bool): RetirementTracker = { ...s, drains: s.drains.append({id: drainId, beforeCloseOnly: beforeCloseOnly, batch: List(), waiting: false, returned: false, failures: List()}) }
pure def canSnapshotDrain(s: RetirementTracker, drainId: int): bool = s.drains.some(d => d.id == drainId and not(d.returned) and not(d.waiting))
pure def snapshotDrain(s: RetirementTracker, drainId: int): RetirementTracker = { ...s, drains: s.drains.listMap(d => if (d.id != drainId) d else { ...d, batch: s.works.select(w => w.active and (not(d.beforeCloseOnly) or w.beforeClose)).listMap(w => w.id), waiting: s.works.some(w => w.active and (not(d.beforeCloseOnly) or w.beforeClose)), returned: not(s.works.some(w => w.active and (not(d.beforeCloseOnly) or w.beforeClose))), failures: if (s.works.some(w => w.active and (not(d.beforeCloseOnly) or w.beforeClose))) List() else s.failures.select(f => not(d.beforeCloseOnly) or f.beforeClose) }) }
pure def canFinishBatch(s: RetirementTracker, drainId: int): bool = s.drains.some(d => d.id == drainId and d.waiting and d.batch.every(id => s.works.some(w => w.id == id and w.settled and not(w.active))))
pure def finishBatch(s: RetirementTracker, drainId: int): RetirementTracker = { ...s, drains: s.drains.listMap(d => if (d.id == drainId) { ...d, waiting: false, batch: List() } else d) }
pure def alwaysGenerationCountsAdmissions(s: RetirementTracker): bool = s.generation == s.works.length()
pure def alwaysFailureIdentity(s: RetirementTracker): bool = s.failures.every(f => s.failures.select(other => other.id == f.id).length() == 1)
pure def stepFailureHistoryPreserved(before: RetirementTracker, after: RetirementTracker): bool = before.failures.every(f => after.failures.includes(f))
pure def alwaysDrainedFailuresMatchScope(s: RetirementTracker): bool = s.drains.every(d => d.beforeCloseOnly implies d.failures.every(f => f.beforeClose))
pure def sometimesGenerationStableAfterFailure(s: RetirementTracker): bool = s.failures.length() > 0 and s.generation == 0
pure def sometimesBeforeCloseIgnoresOtherFailure(s: RetirementTracker): bool = s.drains.some(d => d.returned and d.beforeCloseOnly and d.failures.length() == 0) and s.failures.some(f => not(f.beforeClose))
```
