# Runtime client

The client a consumer's renderer uses to call its agent: one generation per
account refresh, the cached running native bridge of that generation, the
one retry after a `NOT_READY` rejection, and the choice between the bridge
and the host's fallback. [Resident lifecycle](../resident/lifecycle.md)
owns the native service epoch, and [reply streaming](./replyStreaming.md)
the stream this client carries.

## Story: Call the runtime for my current account

> As a user of a consumer app, my requests go to the agent running for the
> account I am signed in to now, and a reply meant for an earlier account
> is never shown to me.

### A late refresh cannot warm, poison or retire the current generation

Generations count up from zero. Each refresh starts a new generation and
clears the previous failure, before
it touches the bridge. When a refresh settles, only the current
generation's refresh may install a running bridge in the cache, record a
failure or clear the refresh in progress; an older one changes nothing. A
request admitted while its generation's refresh runs waits for that
refresh, and a failed current refresh refuses requests until the next one.

```quint
import numbers as Num from "../../core/numbers"
type RequestPhase = ReqUnused | ReqRefresh | ReqStatus | ReqReady | ReqDispatch | ReqNative | ReqFallback | ReqDone | ReqFailed
type CachedRequest = { epoch: int, phase: RequestPhase, retried: bool, available: bool, needsStartup: bool, sends: int }
type RuntimeClient = { generation: int, running: int, refreshing: int, refreshFailure: bool, pendingRefreshes: Set[int], settledRefresh: int, request: CachedRequest }
type RefreshOutcome = RefreshReady | RefreshUnavailable | RefreshFailed
pure val unusedRequest: CachedRequest = { epoch: -1, phase: ReqUnused, retried: false, available: false, needsStartup: false, sends: 0 }
pure val initial: RuntimeClient = { generation: 0, running: -1, refreshing: -1, refreshFailure: false, pendingRefreshes: Set(), settledRefresh: -1, request: unusedRequest }
pure def refreshRuntime(c: RuntimeClient): RuntimeClient =
  { ...c, generation: c.generation + 1, refreshing: c.generation + 1, refreshFailure: false, pendingRefreshes: c.pendingRefreshes.union(Set(c.generation + 1)) }
pure def canFinishRefresh(c: RuntimeClient, epoch: int): bool = c.pendingRefreshes.contains(epoch)
pure def finishRefresh(c: RuntimeClient, epoch: int, refreshOutcome: RefreshOutcome): RuntimeClient =
  { ...c, running: if (epoch == c.generation and refreshOutcome == RefreshReady) epoch else c.running,
    refreshing: if (c.refreshing == epoch) -1 else c.refreshing,
    refreshFailure: if (epoch == c.generation) refreshOutcome == RefreshFailed else c.refreshFailure,
    pendingRefreshes: c.pendingRefreshes.exclude(Set(epoch)), settledRefresh: epoch }
pure val epochValues = Set(0, 1, 2, 3)
pure def alwaysCacheNamesAnIssuedGeneration(c: RuntimeClient): bool =
  c.running >= -1 and c.running <= c.generation and (c.refreshing == -1 or c.refreshing == c.generation) and
  c.request.epoch <= c.generation and c.pendingRefreshes.forall(e => e > 0 and e <= c.generation)
pure def alwaysGenerationsCountFromZero(c: RuntimeClient): bool = c.generation >= 0
pure def stepLateRefreshChangesNothing(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  (via == "finishRefresh" and after.settledRefresh != before.generation) implies
    (after.running == before.running and after.refreshFailure == before.refreshFailure and after.refreshing == before.refreshing)
pure def sometimesLateRefreshIgnored(c: RuntimeClient): bool = c.settledRefresh > 0 and c.settledRefresh < c.generation and c.running == c.generation
pure def sometimesFailedRefreshRefuses(c: RuntimeClient): bool = c.refreshFailure and c.request.phase == ReqFailed and c.request.sends == 0
```

### A request dispatches and publishes only in its own generation

A request belongs to the generation in which it was admitted. If a refresh
starts a newer generation before the request dispatches or before its reply
returns, the request fails instead of dispatching or publishing. A request
in the generation whose bridge the cache knows to be running skips the
status probe.

```quint
pure def admitCurrent(c: RuntimeClient, r: CachedRequest): CachedRequest =
  if (c.refreshFailure) { ...r, phase: ReqFailed }
  else if (c.running == r.epoch) { ...r, phase: ReqNative, available: true, sends: r.sends + 1 }
  else { ...r, phase: ReqStatus }
pure def withRequest(r: CachedRequest, c: RuntimeClient): RuntimeClient = { ...c, request: r }
pure def canAdmitRequest(c: RuntimeClient): bool = c.request.phase == ReqUnused or c.request.phase == ReqDone or c.request.phase == ReqFailed
pure def admitRequest(c: RuntimeClient): RuntimeClient = {
  val fresh = { ...unusedRequest, epoch: c.generation }
  withRequest(if (c.refreshing == c.generation) { ...fresh, phase: ReqRefresh } else admitCurrent(c, fresh), c)
}
pure def canResumeRequest(c: RuntimeClient): bool = c.request.phase == ReqRefresh and not(c.pendingRefreshes.contains(c.request.epoch))
pure def resumeRequest(c: RuntimeClient): RuntimeClient =
  withRequest(if (c.request.epoch != c.generation) { ...c.request, phase: ReqFailed } else admitCurrent(c, c.request), c)
pure def canDispatchRequest(c: RuntimeClient): bool = c.request.phase == ReqDispatch
pure def dispatchRequest(c: RuntimeClient): RuntimeClient =
  withRequest(if (c.request.epoch == c.generation) { ...c.request, phase: ReqNative, sends: c.request.sends + 1 } else { ...c.request, phase: ReqFailed }, c)
pure def canFallbackReply(c: RuntimeClient): bool = c.request.phase == ReqFallback
pure def fallbackReply(c: RuntimeClient, ok: bool): RuntimeClient =
  withRequest({ ...c.request, phase: if (ok and c.request.epoch == c.generation) ReqDone else ReqFailed }, c)
pure def stepDispatchInOwnGeneration(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  (after.request.phase == ReqNative and before.request.phase != ReqNative) implies after.request.epoch == after.generation
pure def stepPublishInOwnGeneration(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  (after.request.phase == ReqDone and before.request.phase != ReqDone) implies before.request.epoch == before.generation
pure def sometimesCachedNativeDone(c: RuntimeClient): bool = c.request.phase == ReqDone and c.request.available and c.running == c.request.epoch
```

### A runtime refusal keeps its status and admitted retry seconds

A non-success response is a runtime refusal carrying its HTTP status, and
the error and code the body gives as strings. Only HTTP 429 provides retry
seconds, and only as a nonnegative safe integer.

```quint
pure def retryAfterAdmitted(statusCode: int, retrySeconds: int, integerValue: bool): bool =
  statusCode == 429 and integerValue and retrySeconds >= 0 and retrySeconds <= Num::maxSafeInteger
pure def lawOtherStatusesHaveNoRetryAdvice(statusCode: int, retrySeconds: int, integerValue: bool): bool =
  statusCode != 429 implies not(retryAfterAdmitted(statusCode, retrySeconds, integerValue))
pure val statusCodeValues = Set(200, 409, 429, 503)
pure val retrySecondsValues = Set(-1, 0, 3)
```

## Story: Reuse a running agent without sending a request twice

> As a user of a consumer app, my request goes to the agent that is running
> for my current account, at most once unless the agent refused it before
> running it.

### An available bridge owns the request, and only NOT_READY is retried, once

`NOT_READY` is a bridge rejection before the request runs, so the request
probes status again and may be sent once more. Every other reply may have
had effects and is never replayed. Without a native bridge the host's
fallback serves the request. A status probe that reports the bridge running,
starting or stopped makes the bridge the request's owner: the request waits
for its startup (sharing a startup already begun in this generation), and a
later unavailable report or a failed startup fails the request rather than
handing it to the fallback.

```quint
type StatusOutcome = StatusRunning | StatusStarting | StatusStopped | StatusUnavailable | StatusError
type NativeOutcome = NativeOk | NativeNotReady | NativeError | NativeOverloaded | NativeOtherHttp
type StartupPlan = UseRunning | JoinStartup | StartRuntime | RefuseStartup
pure def startupPlan(statusOutcome: StatusOutcome, sameGenerationStart: bool): StartupPlan =
  if (statusOutcome == StatusRunning) UseRunning
  else if (statusOutcome == StatusUnavailable or statusOutcome == StatusError) RefuseStartup
  else if (sameGenerationStart or statusOutcome == StatusStarting) JoinStartup else StartRuntime
pure def lawUnavailableBridgeNeverStarts(sameGenerationStart: bool): bool =
  startupPlan(StatusUnavailable, sameGenerationStart) == RefuseStartup and startupPlan(StatusError, sameGenerationStart) == RefuseStartup
pure def canStatusReply(c: RuntimeClient): bool = c.request.phase == ReqStatus
pure def statusReply(c: RuntimeClient, statusOutcome: StatusOutcome): RuntimeClient = {
  val r = c.request
  withRequest(
    if (statusOutcome == StatusError or r.epoch != c.generation) { ...r, phase: ReqFailed }
    else if (statusOutcome == StatusUnavailable) { ...r, phase: if (r.retried or r.available) ReqFailed else ReqFallback }
    else { ...r, available: true, needsStartup: statusOutcome != StatusRunning, phase: ReqReady }, c)
}
pure def canReadyReply(c: RuntimeClient, succeeded: bool): bool = c.request.phase == ReqReady and (succeeded or c.request.needsStartup)
pure def readyReply(c: RuntimeClient, succeeded: bool): RuntimeClient = {
  val ok = succeeded and c.request.epoch == c.generation
  { ...c, running: if (ok) c.request.epoch else c.running, request: { ...c.request, phase: if (ok) ReqDispatch else ReqFailed } }
}
pure def canNativeReply(c: RuntimeClient): bool = c.request.phase == ReqNative
pure def nativeReply(c: RuntimeClient, nativeOutcome: NativeOutcome): RuntimeClient = {
  val r = c.request
  val retry = nativeOutcome == NativeNotReady and not(r.retried) and r.epoch == c.generation
  { ...c, running: if (c.running == r.epoch and (nativeOutcome == NativeNotReady or nativeOutcome == NativeError or nativeOutcome == NativeOverloaded)) -1 else c.running,
    request: { ...r, phase: if (retry) ReqStatus else if (nativeOutcome == NativeOk and r.epoch == c.generation) ReqDone else ReqFailed, retried: r.retried or retry } }
}
pure def alwaysAtMostOneReplay(c: RuntimeClient): bool =
  c.request.sends >= 0 and c.request.sends <= (if (c.request.retried) 2 else 1) and
  (c.request.phase == ReqRefresh implies (c.request.sends == 0 and not(c.request.retried))) and
  ((c.request.phase == ReqStatus or c.request.phase == ReqReady or c.request.phase == ReqDispatch) implies c.request.sends == (if (c.request.retried) 1 else 0)) and
  (c.request.phase == ReqNative implies c.request.sends == (if (c.request.retried) 2 else 1))
pure def alwaysAvailableBridgeOwnsRequest(c: RuntimeClient): bool = c.request.phase == ReqFallback implies not(c.request.available)
pure def sometimesRetriedAfterNotReady(c: RuntimeClient): bool = c.request.retried and c.request.phase == ReqDone and c.request.sends == 2
pure def sometimesFallbackServed(c: RuntimeClient): bool = c.request.phase == ReqDone and not(c.request.available)
pure def sometimesStartupFailureWithoutFallback(c: RuntimeClient): bool = c.request.phase == ReqFailed and c.request.available and c.request.needsStartup
```
