# Runtime status cache

The [runtime client](./runtimeClient.md) can keep the running native bridge
of the current generation in a cache, so that a request skips the status
probe while the bridge is known to run. This spec owns that cache, the one
retry after a `NOT_READY` rejection, and the choice between the native
bridge and the host's fallback. Provider readiness is an abstract completion
of the bridge's `ensure()`, not a proof of its polling.

## Story: Reuse a running agent without sending a request twice

> As a user of a consumer app, my request goes to the agent that is running
> for my current account, at most once unless the agent refused it before
> running it.

### A request dispatches and publishes only within its own generation

A request belongs to the generation in which it was admitted. If an account
refresh starts a newer generation before the request dispatches or before
its reply returns, the request fails instead of dispatching or publishing.

```quint
type RequestPhase = ReqUnused | ReqRefresh | ReqStatus | ReqReady | ReqDispatch | ReqNative | ReqFallback | ReqDone | ReqFailed
type CachedRequest = { epoch: int, phase: RequestPhase, retried: bool, available: bool, needsStartup: bool, sends: int }
type StatusCache = { generation: int, running: int, refreshing: int, refreshFailure: bool, pendingRefreshes: Set[int], settledRefresh: int, request: CachedRequest }
type RefreshOutcome = RefreshReady | RefreshUnavailable | RefreshFailed
type StatusOutcome = StatusRunning | StatusStopped | StatusUnavailable | StatusError
type NativeOutcome = NativeOk | NativeNotReady | NativeError | NativeOverloaded | NativeOtherHttp
pure val unusedRequest: CachedRequest = { epoch: -1, phase: ReqUnused, retried: false, available: false, needsStartup: false, sends: 0 }
pure val initial: StatusCache = { generation: 0, running: -1, refreshing: -1, refreshFailure: false, pendingRefreshes: Set(), settledRefresh: -1, request: unusedRequest }
pure def admitCurrent(c: StatusCache, r: CachedRequest): CachedRequest =
  if (c.refreshFailure) { ...r, phase: ReqFailed }
  else if (c.running == r.epoch) { ...r, phase: ReqNative, available: true, sends: r.sends + 1 }
  else { ...r, phase: ReqStatus }
pure def withRequest(r: CachedRequest, c: StatusCache): StatusCache = { ...c, request: r }
pure def canAdmitRequest(c: StatusCache): bool = c.request.phase == ReqUnused or c.request.phase == ReqDone or c.request.phase == ReqFailed
pure def admitRequest(c: StatusCache): StatusCache = {
  val fresh = { ...unusedRequest, epoch: c.generation }
  withRequest(if (c.refreshing == c.generation) { ...fresh, phase: ReqRefresh } else admitCurrent(c, fresh), c)
}
pure def canResumeRequest(c: StatusCache): bool = c.request.phase == ReqRefresh and not(c.pendingRefreshes.contains(c.request.epoch))
pure def resumeRequest(c: StatusCache): StatusCache =
  withRequest(if (c.request.epoch != c.generation) { ...c.request, phase: ReqFailed } else admitCurrent(c, c.request), c)
pure def canDispatchRequest(c: StatusCache): bool = c.request.phase == ReqDispatch
pure def dispatchRequest(c: StatusCache): StatusCache =
  withRequest(if (c.request.epoch == c.generation) { ...c.request, phase: ReqNative, sends: c.request.sends + 1 } else { ...c.request, phase: ReqFailed }, c)
pure def canNativeReply(c: StatusCache): bool = c.request.phase == ReqNative
pure def nativeReply(c: StatusCache, nativeOutcome: NativeOutcome): StatusCache = {
  val r = c.request
  val retry = nativeOutcome == NativeNotReady and not(r.retried) and r.epoch == c.generation
  { ...c, running: if (c.running == r.epoch and (nativeOutcome == NativeNotReady or nativeOutcome == NativeError or nativeOutcome == NativeOverloaded)) -1 else c.running,
    request: { ...r, phase: if (retry) ReqStatus else if (nativeOutcome == NativeOk and r.epoch == c.generation) ReqDone else ReqFailed, retried: r.retried or retry } }
}
pure def canFallbackReply(c: StatusCache): bool = c.request.phase == ReqFallback
pure def fallbackReply(c: StatusCache, ok: bool): StatusCache =
  withRequest({ ...c.request, phase: if (ok and c.request.epoch == c.generation) ReqDone else ReqFailed }, c)
pure def stepDispatchInOwnGeneration(before: StatusCache, via: str, after: StatusCache): bool =
  (after.request.phase == ReqNative and before.request.phase != ReqNative) implies after.request.epoch == after.generation
pure def stepPublishInOwnGeneration(before: StatusCache, via: str, after: StatusCache): bool =
  (after.request.phase == ReqDone and before.request.phase != ReqDone) implies before.request.epoch == before.generation
pure def sometimesCachedNativeDone(c: StatusCache): bool = c.request.phase == ReqDone and c.request.available and c.running == c.request.epoch
```

### A late refresh cannot warm, poison or retire the current generation

Each refresh starts a new generation and clears the previous failure. When
a refresh settles, only the current generation's refresh may install a
running bridge in the cache, record a failure or clear the refresh in
progress. A request admitted while its generation's refresh runs waits for
that refresh; a failed current refresh refuses requests until the next
refresh.

```quint
pure def refreshRuntime(c: StatusCache): StatusCache =
  { ...c, generation: c.generation + 1, refreshing: c.generation + 1, refreshFailure: false, pendingRefreshes: c.pendingRefreshes.union(Set(c.generation + 1)) }
pure def canFinishRefresh(c: StatusCache, epoch: int): bool = c.pendingRefreshes.contains(epoch)
pure def finishRefresh(c: StatusCache, epoch: int, refreshOutcome: RefreshOutcome): StatusCache =
  { ...c, running: if (epoch == c.generation and refreshOutcome == RefreshReady) epoch else c.running,
    refreshing: if (c.refreshing == epoch) -1 else c.refreshing,
    refreshFailure: if (epoch == c.generation) refreshOutcome == RefreshFailed else c.refreshFailure,
    pendingRefreshes: c.pendingRefreshes.exclude(Set(epoch)), settledRefresh: epoch }
pure val epochValues = Set(0, 1, 2, 3)
pure def alwaysCacheNamesAnIssuedGeneration(c: StatusCache): bool =
  c.running >= -1 and c.running <= c.generation and (c.refreshing == -1 or c.refreshing == c.generation) and
  c.request.epoch <= c.generation and c.pendingRefreshes.forall(e => e > 0 and e <= c.generation)
pure def stepLateRefreshChangesNothing(before: StatusCache, via: str, after: StatusCache): bool =
  (via == "finishRefresh" and after.settledRefresh != before.generation) implies
    (after.running == before.running and after.refreshFailure == before.refreshFailure and after.refreshing == before.refreshing)
pure def sometimesLateRefreshIgnored(c: StatusCache): bool = c.settledRefresh > 0 and c.settledRefresh < c.generation and c.running == c.generation
pure def sometimesFailedRefreshRefuses(c: StatusCache): bool = c.refreshFailure and c.request.phase == ReqFailed and c.request.sends == 0
```

### Only a NOT_READY rejection is retried, once, and an available bridge never falls back

`NOT_READY` is a bridge rejection before the request runs, so the request
probes status again and may be sent once more. Every other reply may have
had effects and is never replayed. A status probe that reports the bridge
running or stopped makes the bridge the request's owner: a later
unavailable report or a failed startup fails the request rather than
handing it to the host's fallback.

```quint
pure def canStatusReply(c: StatusCache): bool = c.request.phase == ReqStatus
pure def statusReply(c: StatusCache, statusOutcome: StatusOutcome): StatusCache = {
  val r = c.request
  withRequest(
    if (statusOutcome == StatusError or r.epoch != c.generation) { ...r, phase: ReqFailed }
    else if (statusOutcome == StatusUnavailable) { ...r, phase: if (r.retried or r.available) ReqFailed else ReqFallback }
    else { ...r, available: true, needsStartup: statusOutcome == StatusStopped, phase: ReqReady }, c)
}
pure def canReadyReply(c: StatusCache, succeeded: bool): bool = c.request.phase == ReqReady and (succeeded or c.request.needsStartup)
pure def readyReply(c: StatusCache, succeeded: bool): StatusCache = {
  val ok = succeeded and c.request.epoch == c.generation
  { ...c, running: if (ok) c.request.epoch else c.running, request: { ...c.request, phase: if (ok) ReqDispatch else ReqFailed } }
}
pure def alwaysAtMostOneReplay(c: StatusCache): bool =
  c.request.sends >= 0 and c.request.sends <= (if (c.request.retried) 2 else 1) and
  (c.request.phase == ReqRefresh implies (c.request.sends == 0 and not(c.request.retried))) and
  ((c.request.phase == ReqStatus or c.request.phase == ReqReady or c.request.phase == ReqDispatch) implies c.request.sends == (if (c.request.retried) 1 else 0)) and
  (c.request.phase == ReqNative implies c.request.sends == (if (c.request.retried) 2 else 1))
pure def alwaysAvailableBridgeOwnsRequest(c: StatusCache): bool = c.request.phase == ReqFallback implies not(c.request.available)
pure def sometimesRetriedAfterNotReady(c: StatusCache): bool = c.request.retried and c.request.phase == ReqDone and c.request.sends == 2
pure def sometimesFallbackServed(c: StatusCache): bool = c.request.phase == ReqDone and not(c.request.available)
pure def sometimesStartupFailureWithoutFallback(c: StatusCache): bool = c.request.phase == ReqFailed and c.request.available and c.request.needsStartup
```
