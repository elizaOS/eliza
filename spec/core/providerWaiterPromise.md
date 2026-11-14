# Provider waiter promises

[Provider executions](./providerExecutions.md) own work IDs, waiter totals,
and eviction. The [provider promise race](./providerPromiseRace.md) owns the
execution's result. This spec follows one caller through
[awaitProviderExecution](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/provider-execution.ts#L64-L109).
The host owns the association between this attachment and the work it joined.

## Story: Release a caller with its own outcome

As a provider consumer, I want my own abort signal to stop my wait without
changing the shared work's result. I want the original provider value or
error when the shared callback reaches me first.

### Every admitted caller observes the shared promise before checking its signal

The unsignalled caller uses the shared promise's finalizer. The signalled
caller installs both shared result callbacks before checking its own signal.
An already-aborted signal releases this caller and supplies its own rejection
in the same invocation. A non-nullish reason retains its identity. A nullish
reason receives a new fallback error. Only a live signal has a listener.

```quint
type WaiterSignal = NoWaiterSignal | LiveWaiterSignal | AlreadyAbortedSignal
type WaiterOutcome = AwaitingValue | SharedValue({ ref: str }) | SharedError({ ref: str }) | CallerAbort({ ref: str })
type SharedSelection = NoSharedSelection | SharedReady({ successful: bool, ref: str })
type ProviderWaiterPromise = { attached: bool, signal: WaiterSignal, listening: bool, selected: SharedSelection, callbackRan: bool, answer: WaiterOutcome }
pure val initial: ProviderWaiterPromise = { attached: false, signal: NoWaiterSignal, listening: false, selected: NoSharedSelection, callbackRan: false, answer: AwaitingValue }
pure val reasonValues = Set("", "own-reason")
pure val fallbackValues = Set("own-fallback")
pure val refValues = Set("shared-value", "shared-error")
pure def awaitingAnswer(answer: WaiterOutcome): bool = match answer { | AwaitingValue => true | _ => false }
pure def selectionMissing(selected: SharedSelection): bool = match selected { | NoSharedSelection => true | _ => false }
pure def abortedValue(reason: str, fallback: str): WaiterOutcome = CallerAbort({ ref: if (reason == "") fallback else reason })
pure def canAttachWaiter(s: ProviderWaiterPromise, fallback: str): bool = not(s.attached) and fallback != ""
pure def attachWaiter(s: ProviderWaiterPromise, signal: WaiterSignal, reason: str, fallback: str): ProviderWaiterPromise =
  { ...s, attached: true, signal: signal, listening: signal == LiveWaiterSignal, answer: if (signal == AlreadyAbortedSignal) abortedValue(reason, fallback) else AwaitingValue }
pure def canAbortWaiter(s: ProviderWaiterPromise, fallback: str): bool = s.attached and s.listening and fallback != ""
pure def abortWaiter(s: ProviderWaiterPromise, reason: str, fallback: str): ProviderWaiterPromise =
  { ...s, listening: false, answer: abortedValue(reason, fallback) }
pure def alwaysUnattachedHasNoCallbacks(s: ProviderWaiterPromise): bool = not(s.attached) implies s == initial
pure def alwaysListenerBelongsToWaitingSignal(s: ProviderWaiterPromise): bool =
  s.listening iff s.attached and s.signal == LiveWaiterSignal and awaitingAnswer(s.answer)
pure def sometimesAlreadyAbortedObservesSharedRejection(s: ProviderWaiterPromise): bool = {
  val a = s.answer
  val r = s.selected
  s.signal == AlreadyAbortedSignal and s.callbackRan and
    (match a { | CallerAbort(_) => true | _ => false }) and
    (match r { | SharedReady(done) => not(done.successful) | _ => false })
}
```

### A queued shared callback releases the caller only if it still owns the wait

Shared settlement queues the callback. Delivery is a later reaction. A caller
abort in that interval wins because its signal callback runs synchronously.
The shared callback still runs and observes the result after release. The
release and listener removal happen once, before the winning answer is
delivered. The execution owner separately consumes the release to update its
waiter count and may synchronously evict and abort final-waiter work.

```quint
pure def canQueueSharedCallback(s: ProviderWaiterPromise): bool = s.attached and selectionMissing(s.selected)
pure def queueSharedCallback(s: ProviderWaiterPromise, successful: bool, ref: str): ProviderWaiterPromise =
  { ...s, selected: SharedReady({ successful: successful, ref: ref }) }
pure def canRunSharedCallback(s: ProviderWaiterPromise): bool = s.attached and not(selectionMissing(s.selected)) and not(s.callbackRan)
pure def sharedAnswer(selected: SharedSelection): WaiterOutcome = match selected {
  | NoSharedSelection => AwaitingValue
  | SharedReady(done) => if (done.successful) SharedValue({ ref: done.ref }) else SharedError({ ref: done.ref })
}
pure def runSharedCallback(s: ProviderWaiterPromise): ProviderWaiterPromise =
  { ...s, callbackRan: true, listening: false, answer: if (awaitingAnswer(s.answer)) sharedAnswer(s.selected) else s.answer }
pure def callerAborted(answer: WaiterOutcome): bool = match answer { | CallerAbort(_) => true | _ => false }
pure def alwaysSharedAnswerMatchesSelection(s: ProviderWaiterPromise): bool =
  not(awaitingAnswer(s.answer)) and not(callerAborted(s.answer)) implies s.callbackRan and s.answer == sharedAnswer(s.selected)
pure def alwaysObservedSharedCallbackHasSelection(s: ProviderWaiterPromise): bool =
  s.callbackRan implies s.attached and not(selectionMissing(s.selected)) and not(awaitingAnswer(s.answer))
pure def stepReleasedAnswerStaysFixed(before: ProviderWaiterPromise, after: ProviderWaiterPromise): bool =
  not(awaitingAnswer(before.answer)) implies after.answer == before.answer
pure def stepSharedSelectionStaysFixed(before: ProviderWaiterPromise, after: ProviderWaiterPromise): bool =
  not(selectionMissing(before.selected)) implies after.selected == before.selected
pure def sometimesCallerAbortWinsQueuedSharedResult(s: ProviderWaiterPromise): bool =
  s.signal == LiveWaiterSignal and not(selectionMissing(s.selected)) and not(s.callbackRan) and callerAborted(s.answer)
pure def sometimesUnsignalledCallerReceivesValue(s: ProviderWaiterPromise): bool = {
  val a = s.answer
  s.signal == NoWaiterSignal and (match a { | SharedValue(_) => true | _ => false })
}
```
