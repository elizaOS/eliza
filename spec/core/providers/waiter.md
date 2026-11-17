# Provider waiter promises

The callers' waits in `awaitProviderExecution` on one shared execution. [Provider executions](./index.md) own work IDs, waiter totals and eviction; each wait observes the outcome its execution's [promise race](./race.md) published.

## Story: Release a caller with its own outcome

> As a provider consumer, I want my own abort signal to stop my wait without
> changing the shared work's result, and otherwise the original provider
> value or error the execution published, so that my cancellation never
> affects another caller and I never receive another execution's result.

### Every admitted caller observes the shared promise before checking its signal

The unsignalled caller uses the shared promise's finalizer. The signalled
caller installs both shared result callbacks before checking its own signal.
An already-aborted signal releases this caller and supplies its own rejection
in the same invocation. A non-nullish reason retains its identity. A nullish
reason receives a new fallback error. Only a live signal has a listener.
Each caller has its own identity, and the execution's race runs as its own
component.

```quint
import race as R from "./race"
type WaiterSignal = NoWaiterSignal | LiveWaiterSignal | AlreadyAbortedSignal
type WaiterOutcome = AwaitingValue | SharedValue({ ref: str }) | SharedError({ ref: str }) | CallerAbort({ ref: str })
type SharedSelection = NoSharedSelection | SharedReady({ successful: bool, ref: str })
type ProviderWaiter = { id: int, signal: WaiterSignal, listening: bool, selected: SharedSelection, callbackRan: bool, answer: WaiterOutcome }
type ProviderWaiters = { race: R::ProviderPromiseRace, waiters: List[ProviderWaiter] }
pure val initial: ProviderWaiters = { race: R::initial, waiters: List() }
pure val waiterValues = Set(1, 2)
pure val reasonValues = Set("", "own-reason")
pure val fallbackValues = Set("own-fallback")
pure val absentWaiter: ProviderWaiter = { id: 0, signal: NoWaiterSignal, listening: false, selected: NoSharedSelection, callbackRan: false, answer: AwaitingValue }
pure def waiterAt(s: ProviderWaiters, waiter: int): ProviderWaiter = s.waiters.select(w => w.id == waiter).nthOr(0, absentWaiter)
pure def replaceWaiter(updated: ProviderWaiter, s: ProviderWaiters): ProviderWaiters = { ...s, waiters: s.waiters.listMap(w => if (w.id == updated.id) updated else w) }
pure def awaitingAnswer(answer: WaiterOutcome): bool = match answer { | AwaitingValue => true | _ => false }
pure def selectionMissing(selected: SharedSelection): bool = match selected { | NoSharedSelection => true | _ => false }
pure def abortedValue(reason: str, fallback: str): WaiterOutcome = CallerAbort({ ref: if (reason == "") fallback else reason })
pure def canAttachWaiter(s: ProviderWaiters, waiter: int, fallback: str): bool = s.race.created and waiter > 0 and waiterAt(s, waiter).id == 0 and fallback != ""
pure def attachWaiter(s: ProviderWaiters, waiter: int, signal: WaiterSignal, reason: str, fallback: str): ProviderWaiters =
  { ...s, waiters: s.waiters.append({ ...absentWaiter, id: waiter, signal: signal, listening: signal == LiveWaiterSignal, answer: if (signal == AlreadyAbortedSignal) abortedValue(reason, fallback) else AwaitingValue }) }
pure def canAbortWaiter(s: ProviderWaiters, waiter: int, fallback: str): bool = waiterAt(s, waiter).id != 0 and waiterAt(s, waiter).listening and fallback != ""
pure def abortWaiter(s: ProviderWaiters, waiter: int, reason: str, fallback: str): ProviderWaiters =
  replaceWaiter({ ...waiterAt(s, waiter), listening: false, answer: abortedValue(reason, fallback) }, s)
pure def alwaysWaiterIdentitiesUnique(s: ProviderWaiters): bool = s.waiters.every(w => w.id > 0 and s.waiters.select(other => other.id == w.id).length() == 1)
pure def alwaysWaitersFollowCreatedRace(s: ProviderWaiters): bool = s.waiters.length() > 0 implies s.race.created
pure def alwaysListenerBelongsToWaitingSignal(s: ProviderWaiters): bool =
  s.waiters.every(w => w.listening iff (w.signal == LiveWaiterSignal and awaitingAnswer(w.answer)))
pure def sometimesAlreadyAbortedObservesSharedRejection(s: ProviderWaiters): bool =
  s.waiters.some(w => w.signal == AlreadyAbortedSignal and w.callbackRan and callerAborted(w.answer) and not(selectionMissing(w.selected)) and not(R::outcomeSucceeded(s.race.shared)))
```

### The execution's race runs inside the wait

Creation, execution abort, the invocation guard, native settlement and
publication of the race keep the rules of the [promise race](./race.md)
while callers wait on it.

```quint
pure def canCreateExecution(s: ProviderWaiters, fallbackRef: str): bool = R::canCreateExecution(s.race, fallbackRef)
pure def createExecution(s: ProviderWaiters, alreadyAborted: bool, reason: str, fallbackRef: str): ProviderWaiters = { ...s, race: R::createExecution(s.race, alreadyAborted, reason, fallbackRef) }
pure def canAbortExecution(s: ProviderWaiters, fallbackRef: str): bool = R::canAbortExecution(s.race, fallbackRef)
pure def abortExecution(s: ProviderWaiters, reason: str, fallbackRef: str): ProviderWaiters = { ...s, race: R::abortExecution(s.race, reason, fallbackRef) }
pure def canEnterInvocation(s: ProviderWaiters, fallbackRef: str): bool = R::canEnterInvocation(s.race, fallbackRef)
pure def enterInvocation(s: ProviderWaiters, fallbackRef: str): ProviderWaiters = { ...s, race: R::enterInvocation(s.race, fallbackRef) }
pure def canSettleNative(s: ProviderWaiters): bool = R::canSettleNative(s.race)
pure def settleNative(s: ProviderWaiters, result: R::PromiseValue): ProviderWaiters = { ...s, race: R::settleNative(s.race, result) }
pure def canChooseNative(s: ProviderWaiters): bool = R::canChooseNative(s.race)
pure def chooseNative(s: ProviderWaiters): ProviderWaiters = { ...s, race: R::chooseNative(s.race) }
pure def canChooseAbort(s: ProviderWaiters): bool = R::canChooseAbort(s.race)
pure def chooseAbort(s: ProviderWaiters): ProviderWaiters = { ...s, race: R::chooseAbort(s.race) }
pure def canPublishShared(s: ProviderWaiters): bool = R::canPublishShared(s.race)
pure def publishShared(s: ProviderWaiters): ProviderWaiters = { ...s, race: R::publishShared(s.race) }
pure def alwaysRaceKeepsItsRules(s: ProviderWaiters): bool = R::alwaysEmptyBeforeCreation(s.race) and R::alwaysFirstCandidateHasOrigin(s.race) and R::alwaysPublishedHasOutcomeAndNoListener(s.race) and R::alwaysListenerBelongsToLiveRace(s.race) and R::alwaysOutcomeKeepsOrigin(s.race)
```

### A queued shared callback carries the outcome its execution published

Shared settlement queues the callback with the outcome the race published:
a native fulfillment as a value, a native rejection or the execution's abort
rejection as an error. Delivery is a later reaction. A caller abort in that
interval wins because its signal callback runs synchronously. The shared
callback still runs and observes the result after release. The release and
listener removal happen once, before the winning answer is delivered. The
execution owner separately consumes the release to update its waiter count
and may synchronously evict and abort final-waiter work.

```quint
pure def publishedSelection(s: ProviderWaiters): SharedSelection = SharedReady({ successful: R::outcomeSucceeded(s.race.shared), ref: R::outcomeRef(s.race.shared) })
pure def canQueueSharedCallback(s: ProviderWaiters, waiter: int): bool = s.race.published and waiterAt(s, waiter).id != 0 and selectionMissing(waiterAt(s, waiter).selected)
pure def queueSharedCallback(s: ProviderWaiters, waiter: int): ProviderWaiters = replaceWaiter({ ...waiterAt(s, waiter), selected: publishedSelection(s) }, s)
pure def canRunSharedCallback(s: ProviderWaiters, waiter: int): bool = waiterAt(s, waiter).id != 0 and not(selectionMissing(waiterAt(s, waiter).selected)) and not(waiterAt(s, waiter).callbackRan)
pure def sharedAnswer(selected: SharedSelection): WaiterOutcome = match selected {
  | NoSharedSelection => AwaitingValue
  | SharedReady(done) => if (done.successful) SharedValue({ ref: done.ref }) else SharedError({ ref: done.ref })
}
pure def runSharedCallback(s: ProviderWaiters, waiter: int): ProviderWaiters = {
  val w = waiterAt(s, waiter)
  replaceWaiter({ ...w, callbackRan: true, listening: false, answer: if (awaitingAnswer(w.answer)) sharedAnswer(w.selected) else w.answer }, s)
}
pure def callerAborted(answer: WaiterOutcome): bool = match answer { | CallerAbort(_) => true | _ => false }
pure def sharedValueAnswer(answer: WaiterOutcome): bool = match answer { | SharedValue(_) => true | _ => false }
pure def sharedErrorAnswer(answer: WaiterOutcome): bool = match answer { | SharedError(_) => true | _ => false }
pure def alwaysSelectionIsThePublishedOutcome(s: ProviderWaiters): bool =
  s.waiters.every(w => not(selectionMissing(w.selected)) implies (s.race.published and w.selected == publishedSelection(s)))
pure def alwaysSharedAnswerMatchesSelection(s: ProviderWaiters): bool =
  s.waiters.every(w => not(awaitingAnswer(w.answer)) and not(callerAborted(w.answer)) implies (w.callbackRan and w.answer == sharedAnswer(w.selected)))
pure def alwaysObservedSharedCallbackHasSelection(s: ProviderWaiters): bool =
  s.waiters.every(w => w.callbackRan implies (not(selectionMissing(w.selected)) and not(awaitingAnswer(w.answer))))
pure def stepReleasedAnswerStaysFixed(before: ProviderWaiters, after: ProviderWaiters): bool =
  before.waiters.every(w => not(awaitingAnswer(w.answer)) implies waiterAt(after, w.id).answer == w.answer)
pure def stepSharedSelectionStaysFixed(before: ProviderWaiters, after: ProviderWaiters): bool =
  before.waiters.every(w => not(selectionMissing(w.selected)) implies waiterAt(after, w.id).selected == w.selected)
pure def sometimesCallerAbortWinsQueuedSharedResult(s: ProviderWaiters): bool =
  s.waiters.some(w => w.signal == LiveWaiterSignal and not(selectionMissing(w.selected)) and not(w.callbackRan) and callerAborted(w.answer))
pure def sometimesUnsignalledCallerReceivesValue(s: ProviderWaiters): bool =
  s.waiters.some(w => w.signal == NoWaiterSignal and sharedValueAnswer(w.answer))
pure def sometimesTwoCallersShareOnePublishedError(s: ProviderWaiters): bool =
  s.waiters.some(a => s.waiters.some(b => a.id != b.id and a.callbackRan and b.callbackRan and a.answer == b.answer and sharedErrorAnswer(a.answer)))
```
