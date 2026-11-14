# Shared provider executions

The provider registry supplies complete authorized inputs. Equivalent keyed reads share work while explicit refresh and unkeyed reads own independent work. Sources include [provider-execution.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/provider-execution.ts), [state-composition.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/state-composition.ts) and [ProviderExecution.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/ProviderExecution.qnt).

## Story: Share provider work without sharing cancellation

As a turn I detach from shared work while other callers retain their execution.

### A keyed execution admits distinct callers while it remains wanted

Execution identities are monotonically allocated. An aborting execution cannot acquire another waiter.

```quint
type WorkPhase = Dormant | Working | WorkSettled | WorkCleaned
type AbortCause = NoAbort | LastWaiter | RuntimeStop
type ProviderWork = { id: int, phase: WorkPhase, cause: AbortCause, active: bool, invoked: bool }
type ProviderCaller = { id: int, workId: int }
type ProviderState = { nextId: int, works: List[ProviderWork], callers: List[ProviderCaller], abortedCallers: Set[int], keyedId: int, stopping: bool }
pure val initial: ProviderState = { nextId: 1, works: List(), callers: List(), abortedCallers: Set(), keyedId: 0, stopping: false }
pure val callerValues = Set(1, 2, 3)
pure val workIdValues = Set(1, 2, 3)
pure val absentWork: ProviderWork = { id: 0, phase: Dormant, cause: NoAbort, active: false, invoked: false }
pure def providerWork(s: ProviderState, workId: int): ProviderWork = s.works.select(w => w.id == workId).nthOr(0, absentWork)
pure def waiters(s: ProviderState, workId: int): int = s.callers.select(c => c.workId == workId).length()
pure def canAttach(s: ProviderState, caller: int, keyed: bool): bool = caller > 0 and not(s.stopping) and not(s.callers.some(c => c.id == caller)) and not(s.abortedCallers.contains(caller))
pure def attach(s: ProviderState, caller: int, keyed: bool): ProviderState = {
  val shared = keyed and s.keyedId != 0 and providerWork(s, s.keyedId).phase != WorkCleaned and providerWork(s, s.keyedId).cause == NoAbort
  val id = if (shared) s.keyedId else s.nextId
  { ...s, nextId: if (shared) s.nextId else s.nextId + 1,
    works: if (shared) s.works else s.works.append({id: id, phase: Working, cause: NoAbort, active: true, invoked: false}),
    callers: s.callers.append({id: caller, workId: id}), keyedId: if (keyed) id else s.keyedId }
}
pure def alwaysExecutionIdentitiesUnique(s: ProviderState): bool = s.nextId > 0 and s.works.every(w => w.id > 0 and w.id < s.nextId and s.works.select(x => x.id == w.id).length() == 1)
pure def callerFor(s: ProviderState, caller: int): ProviderCaller = s.callers.select(c => c.id == caller).nthOr(0, {id: 0, workId: 0})
pure def alwaysCallersOwnExistingWork(s: ProviderState): bool = s.callers.every(c => c.id > 0 and s.callers.select(x => x.id == c.id).length() == 1 and s.works.some(w => w.id == c.workId))
pure def alwaysKeyedWorkCanBeJoined(s: ProviderState): bool = s.keyedId != 0 implies (providerWork(s, s.keyedId).id == s.keyedId and providerWork(s, s.keyedId).phase != WorkCleaned and providerWork(s, s.keyedId).active and providerWork(s, s.keyedId).cause == NoAbort)
pure def sometimesTwoCallersShare(s: ProviderState): bool = s.works.some(w => waiters(s, w.id) > 1)
```

### Cancellation of the final waiter aborts its work

Signal observation and cancellation listener execution are separate. Other callers retain their references.

```quint
pure def canAbortCaller(s: ProviderState, caller: int): bool = s.callers.some(c => c.id == caller) and not(s.abortedCallers.contains(caller))
pure def abortCaller(s: ProviderState, caller: int): ProviderState = { ...s, abortedCallers: s.abortedCallers.union(Set(caller)) }
pure def canDetachCancelled(s: ProviderState, caller: int): bool = s.abortedCallers.contains(caller) and s.callers.some(c => c.id == caller)
pure def detachCancelled(s: ProviderState, caller: int): ProviderState = {
  val id = callerFor(s, caller).workId
  val finalWaiter = waiters(s, id) == 1
  { ...s, callers: s.callers.select(c => c.id != caller), keyedId: if (finalWaiter and s.keyedId == id) 0 else s.keyedId,
    works: s.works.listMap(w => if (w.id == id and finalWaiter and w.phase == Working and w.cause == NoAbort) { ...w, cause: LastWaiter } else w) }
}
pure def alwaysUnwantedWorkAborted(s: ProviderState): bool = s.works.every(w => w.phase == Working and w.cause == NoAbort implies s.callers.some(c => c.workId == w.id))
pure def alwaysWaiterAbortHasNoCallers(s: ProviderState): bool = s.works.every(w => w.cause == LastWaiter implies not(s.callers.some(c => c.workId == w.id)))
pure def sometimesFinalWaiterAborts(s: ProviderState): bool = s.works.some(w => w.phase == Working and w.cause == LastWaiter)
pure def sometimesCancelledExecutionHasReplacement(s: ProviderState): bool = s.keyedId != 0 and s.works.some(w => w.id != s.keyedId and w.cause == LastWaiter and w.phase == Working)
```

### Cleanup never clears a newer keyed execution

Discovered by the proof. A published keyed execution references an existing
work item. A scheduler completion uses the same guard as its explicit
identity counterpart.

The provider function begins only in its deferred microtask after an abort recheck. A controller aborted before that microtask never invokes provider code. Settling, cleanup and caller result delivery preserve distinct ownership boundaries. Shutdown reaches keyed and unkeyed work.

```quint
pure def canInvokeWork(s: ProviderState, workId: int): bool = providerWork(s, workId).phase == Working and not(providerWork(s, workId).invoked) and providerWork(s, workId).cause == NoAbort
pure def invokeWork(s: ProviderState, workId: int): ProviderState = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, invoked: true } else w) }
pure def canSettleWork(s: ProviderState, workId: int): bool = providerWork(s, workId).phase == Working and (providerWork(s, workId).invoked or providerWork(s, workId).cause != NoAbort)
pure def settleWork(s: ProviderState, workId: int): ProviderState = { ...s, works: s.works.listMap(w => if (w.id == workId) { ...w, phase: WorkSettled } else w) }
pure def canCleanWork(s: ProviderState, workId: int): bool = providerWork(s, workId).phase == WorkSettled
pure def cleanWork(s: ProviderState, workId: int): ProviderState = { ...s, keyedId: if (s.keyedId == workId) 0 else s.keyedId, works: s.works.listMap(w => if (w.id == workId) { ...w, phase: WorkCleaned, active: false } else w) }
pure def canReceiveResult(s: ProviderState, caller: int): bool = s.callers.some(c => c.id == caller and providerWork(s, c.workId).phase == WorkCleaned)
pure def receiveResult(s: ProviderState, caller: int): ProviderState = { ...s, callers: s.callers.select(c => c.id != caller) }
pure def canStopProviders(s: ProviderState): bool = not(s.stopping)
pure def stopProviders(s: ProviderState): ProviderState = { ...s, stopping: true, keyedId: 0, works: s.works.listMap(w => if (w.phase == Working and w.cause == NoAbort) { ...w, cause: RuntimeStop, active: false } else { ...w, active: false }) }
pure def alwaysStopReachesEveryExecution(s: ProviderState): bool = s.stopping implies s.works.every(w => w.phase == Working implies w.cause != NoAbort)
pure def alwaysCleanedWorkIsInactive(s: ProviderState): bool = s.works.every(w => w.phase == WorkCleaned implies not(w.active))
pure def sometimesAllCallersReceive(s: ProviderState): bool = s.works.length() > 0 and s.callers.length() == 0 and s.works.every(w => w.phase == WorkCleaned)
```

### Stopped and settled provider work eventually releases its callers

The environment settles aborted provider work. Fair cleanup, cancellation
listeners and result delivery then detach its callers.

Discovered by simulation: execution identities can exceed the examples used
for explicit callback inputs. The scheduler steps select real pending work
from the registry. Explicit callbacks can still select any eligible identity.
Progress follows the captured attachment, so reuse of a caller identity on a
different execution does not count as retaining that attachment. Each
scheduler callback consumes the first eligible attachment in the retained list.
An older eligible attachment has only a finite prefix ahead of it. New
attachments join the tail. These scheduler steps witness progress under fair
host callbacks; the identity-specific completion events retain their original
guards.

```quint
pure def nextInvokableWork(s: ProviderState): ProviderWork = s.works.select(w => canInvokeWork(s, w.id)).nthOr(0, absentWork)
pure def nextSettleableWork(s: ProviderState): ProviderWork = s.works.select(w => canSettleWork(s, w.id)).nthOr(0, absentWork)
pure def nextCleanableWork(s: ProviderState): ProviderWork = s.works.select(w => canCleanWork(s, w.id)).nthOr(0, absentWork)
pure def canInvokeNextWork(s: ProviderState): bool = nextInvokableWork(s).id != 0 and canInvokeWork(s, nextInvokableWork(s).id)
pure def invokeNextWork(s: ProviderState): ProviderState = invokeWork(s, nextInvokableWork(s).id)
pure def canSettleNextWork(s: ProviderState): bool = nextSettleableWork(s).id != 0 and canSettleWork(s, nextSettleableWork(s).id)
pure def settleNextWork(s: ProviderState): ProviderState = settleWork(s, nextSettleableWork(s).id)
pure def canCleanNextWork(s: ProviderState): bool = nextCleanableWork(s).id != 0 and canCleanWork(s, nextCleanableWork(s).id)
pure def cleanNextWork(s: ProviderState): ProviderState = cleanWork(s, nextCleanableWork(s).id)
pure val fair_invokeNextWork = "strong"
pure val fair_settleNextWork = "weak"
pure val fair_cleanNextWork = "weak"
pure val absentCaller: ProviderCaller = {id: 0, workId: 0}
pure def nextCallbackCaller(s: ProviderState): ProviderCaller = s.callers.select(c => canDetachCancelled(s, c.id) or canReceiveResult(s, c.id)).nthOr(0, absentCaller)
pure def canRunNextCallback(s: ProviderState): bool = nextCallbackCaller(s).id != 0 and (canDetachCancelled(s, nextCallbackCaller(s).id) or canReceiveResult(s, nextCallbackCaller(s).id))
pure def runNextCallback(s: ProviderState): ProviderState = {
  val caller = nextCallbackCaller(s).id
  if (canDetachCancelled(s, caller)) detachCancelled(s, caller) else receiveResult(s, caller)
}
pure val fair_runNextCallback = "weak"
pure def leadsToCancelledAttachmentLeaves(s: ProviderState, later: ProviderState): bool = s.callers.every(c => s.abortedCallers.contains(c.id) implies not(later.callers.some(other => other.id == c.id and other.workId == c.workId)))
pure def leadsToSettledCallersLeave(s: ProviderState, later: ProviderState): bool = s.callers.every(c => (providerWork(s, c.workId).phase == WorkSettled or providerWork(s, c.workId).phase == WorkCleaned) implies not(later.callers.some(other => other.id == c.id and other.workId == c.workId)))
pure def leadsToStoppedCallersLeave(s: ProviderState, later: ProviderState): bool = s.stopping implies s.callers.every(c => not(later.callers.some(other => other.id == c.id and other.workId == c.workId)))
pure def leadsToAbortedCallersLeave(s: ProviderState, later: ProviderState): bool = s.callers.every(c => providerWork(s, c.workId).cause != NoAbort implies not(later.callers.some(other => other.id == c.id and other.workId == c.workId)))
```

### Every unsettled provider execution has an enabled completion step

No caller and only cleaned executions is terminal. Otherwise a provider may settle, cleanup may run, a cancelled caller may detach, or a caller may receive its result.

```quint
pure def providersTerminal(s: ProviderState): bool = s.callers.length() == 0 and s.works.every(w => w.phase == WorkCleaned)
pure def providersProgressEnabled(s: ProviderState): bool = s.works.some(w => canInvokeWork(s, w.id) or canSettleWork(s, w.id) or canCleanWork(s, w.id)) or s.callers.some(c => canDetachCancelled(s, c.id) or canReceiveResult(s, c.id))
pure def alwaysProviderDeadlockFree(s: ProviderState): bool = providersTerminal(s) or providersProgressEnabled(s)
pure def alwaysCreatedWorkHasStarted(s: ProviderState): bool = s.works.every(w => w.phase != Dormant)
pure def stepAbortedWorkCannotStart(before: ProviderState, after: ProviderState): bool = before.works.every(w => not(w.invoked) and w.cause != NoAbort implies after.works.some(laterWork => laterWork.id == w.id and not(laterWork.invoked)))
```
