# Shared provider promise and native completion

This is one execution-owned cancellation boundary in [provider-execution.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/provider-execution.ts#L129-L166).
[Provider executions](./providerExecutions.md) own pooling, callers and cache
cleanup. This model follows the two promises inside one shared execution.
References denote the original result, thrown error or signal reason. The
host supplies their identities and schedules the actual promise reactions.
The empty reference means the host observed a nullish reason. A non-nullish
reason such as the empty string has its own identity.

## Story: Release an aborted execution while observing native work

As a caller, I want the execution to stop waiting when its owner cancels it.
If the provider already ran, its late fulfillment or rejection still needs an
observer. Both successful results and failures retain their original values.

### The invocation microtask checks the execution signal before starting

The provider promise and its race observer already exist when the execution
is created. A signal that is already aborted rejects the abort candidate
immediately. The provider's queued invocation still runs its guard. It
rejects with the signal reason or its own fallback error without calling the
provider. Once invoked, work may settle even after the shared promise returns.

```quint
type SignalState = LiveSignal | Signalled({ reason: str, rejection: str })
type PromiseValue = Fulfilled({ ref: str }) | Rejected({ ref: str })
type NativePhase = QueuedProvider | RunningProvider | SkippedProvider({ ref: str }) | SettledProvider({ result: PromiseValue })
type RaceResult = Undecided | NativeWon({ result: PromiseValue }) | AbortWon({ ref: str })
type Candidate = NoCandidate | NativeCandidate | AbortCandidate
type ProviderPromiseRace = { created: bool, signal: SignalState, native: NativePhase, firstReady: Candidate, shared: RaceResult, published: bool, listening: bool }
pure val initial: ProviderPromiseRace = { created: false, signal: LiveSignal, native: QueuedProvider, firstReady: NoCandidate, shared: Undecided, published: false, listening: false }
pure val reasonValues = Set("", "caller-signal")
pure val fallbackRefValues = Set("abort-fallback", "invocation-fallback")
pure val resultValues = Set(Fulfilled({ ref: "provider-result" }), Rejected({ ref: "provider-error" }))
pure def rejectionRef(reason: str, fallbackRef: str): str = if (reason == "") fallbackRef else reason
pure def liveSignal(signal: SignalState): bool = match signal { | LiveSignal => true | _ => false }
pure def queuedNative(native: NativePhase): bool = match native { | QueuedProvider => true | _ => false }
pure def runningNative(native: NativePhase): bool = match native { | RunningProvider => true | _ => false }
pure def undecidedRace(winnerValue: RaceResult): bool = match winnerValue { | Undecided => true | _ => false }
pure def canCreateExecution(s: ProviderPromiseRace, fallbackRef: str): bool = not(s.created) and fallbackRef != ""
pure def createExecution(s: ProviderPromiseRace, alreadyAborted: bool, reason: str, fallbackRef: str): ProviderPromiseRace =
  { ...s, created: true, signal: if (alreadyAborted) Signalled({ reason: reason, rejection: rejectionRef(reason, fallbackRef) }) else LiveSignal, firstReady: if (alreadyAborted) AbortCandidate else NoCandidate, listening: not(alreadyAborted) }
pure def canAbortExecution(s: ProviderPromiseRace, fallbackRef: str): bool = s.created and liveSignal(s.signal) and fallbackRef != ""
pure def abortExecution(s: ProviderPromiseRace, reason: str, fallbackRef: str): ProviderPromiseRace =
  { ...s, signal: Signalled({ reason: reason, rejection: if (s.listening) rejectionRef(reason, fallbackRef) else "" }), firstReady: if (s.firstReady == NoCandidate and s.listening) AbortCandidate else s.firstReady, listening: false }
pure def canEnterInvocation(s: ProviderPromiseRace, fallbackRef: str): bool = s.created and queuedNative(s.native) and fallbackRef != ""
pure def enterInvocation(s: ProviderPromiseRace, fallbackRef: str): ProviderPromiseRace = {
  val signal = s.signal
  { ...s, native: match signal {
    | LiveSignal => RunningProvider
    | Signalled(abort) => SkippedProvider({ ref: rejectionRef(abort.reason, fallbackRef) })
  } }
}
pure def canSettleNative(s: ProviderPromiseRace): bool = s.created and runningNative(s.native)
pure def settleNative(s: ProviderPromiseRace, result: PromiseValue): ProviderPromiseRace =
  { ...s, native: SettledProvider({ result: result }), firstReady: if (s.firstReady == NoCandidate) NativeCandidate else s.firstReady }
pure def nativeWasInvoked(native: NativePhase): bool = match native {
  | RunningProvider => true
  | SettledProvider(_) => true
  | _ => false
}
pure def stepOnlyLiveSignalStartsProvider(before: ProviderPromiseRace, after: ProviderPromiseRace): bool =
  not(nativeWasInvoked(before.native)) and nativeWasInvoked(after.native) implies liveSignal(before.signal)
pure def sometimesInvocationSkipped(s: ProviderPromiseRace): bool = {
  val n = s.native
  match n { | SkippedProvider(_) => true | _ => false }
}
```

### The first delivered race reaction fixes the shared outcome

Native fulfillment and rejection both reach the race, as does execution
abort. The first candidate to queue its race reaction has priority. A
skipped invocation may allocate a different fallback error after the abort
reaction is already queued. Publishing the shared outcome follows listener
cleanup. A signal abort after that cleanup queues no new reaction. Once published,
native work can still settle through its original observer. That settlement
cannot replace the shared outcome or publish it a second time.

```quint
pure def canChooseNative(s: ProviderPromiseRace): bool = {
  val n = s.native
  s.created and undecidedRace(s.shared) and s.firstReady == NativeCandidate and (match n {
    | SettledProvider(_) => true
    | _ => false
  })
}
pure def chooseNative(s: ProviderPromiseRace): ProviderPromiseRace = {
  val n = s.native
  { ...s, shared: match n {
    | SettledProvider(done) => NativeWon({ result: done.result })
    | _ => Undecided
  } }
}
pure def canChooseAbort(s: ProviderPromiseRace): bool = s.created and undecidedRace(s.shared) and s.firstReady == AbortCandidate and not(liveSignal(s.signal))
pure def chooseAbort(s: ProviderPromiseRace): ProviderPromiseRace = {
  val signal = s.signal
  { ...s, shared: match signal {
    | Signalled(abort) => AbortWon({ ref: abort.rejection })
    | _ => Undecided
  } }
}
pure def canPublishShared(s: ProviderPromiseRace): bool = s.created and not(undecidedRace(s.shared)) and not(s.published)
pure def publishShared(s: ProviderPromiseRace): ProviderPromiseRace = { ...s, published: true, listening: false }
pure def alwaysEmptyBeforeCreation(s: ProviderPromiseRace): bool =
  not(s.created) implies s == initial
pure def alwaysFirstCandidateHasOrigin(s: ProviderPromiseRace): bool = {
  val native = s.native
  val signal = s.signal
  val candidate = s.firstReady
  match candidate {
    | NativeCandidate => match native { | SettledProvider(_) => true | _ => false }
    | AbortCandidate => match signal { | Signalled(abort) => abort.rejection != "" | _ => false }
    | NoCandidate => true
  }
}
pure def alwaysPublishedHasOutcomeAndNoListener(s: ProviderPromiseRace): bool =
  s.published implies s.created and not(undecidedRace(s.shared)) and not(s.listening)
pure def alwaysListenerBelongsToLiveRace(s: ProviderPromiseRace): bool =
  s.listening iff s.created and liveSignal(s.signal) and not(s.published)
pure def alwaysOutcomeKeepsOrigin(s: ProviderPromiseRace): bool = {
  val winnerValue = s.shared
  val signal = s.signal
  val native = s.native
  match winnerValue {
    | NativeWon(winner) => s.firstReady == NativeCandidate and
      (match native { | SettledProvider(done) => done.result == winner.result | _ => false })
    | AbortWon(winner) => s.firstReady == AbortCandidate and
      (match signal { | Signalled(abort) => abort.rejection == winner.ref | _ => false })
    | Undecided => true
  }
}
pure def stepRaceWinnerStaysFixed(before: ProviderPromiseRace, after: ProviderPromiseRace): bool =
  not(undecidedRace(before.shared)) implies after.shared == before.shared
pure def stepFirstCandidateStaysFixed(before: ProviderPromiseRace, after: ProviderPromiseRace): bool =
  before.firstReady != NoCandidate implies after.firstReady == before.firstReady
pure def sometimesAbortPublishesWhileNativeRuns(s: ProviderPromiseRace): bool = {
  val winnerValue = s.shared
  s.published and runningNative(s.native) and (match winnerValue { | AbortWon(_) => true | _ => false })
}
pure def sometimesLateNativeRejectionObserved(s: ProviderPromiseRace): bool = {
  val winnerValue = s.shared
  val native = s.native
  s.published and (match winnerValue { | AbortWon(_) => true | _ => false }) and
    (match native { | SettledProvider(done) => isRejected(done.result) | _ => false })
}
pure def isRejected(value: PromiseValue): bool = match value { | Rejected(_) => true | _ => false }
pure def sometimesNativeResultPublished(s: ProviderPromiseRace): bool = {
  val winnerValue = s.shared
  s.published and (match winnerValue {
    | NativeWon(done) => not(isRejected(done.result))
    | _ => false
  })
}
```
