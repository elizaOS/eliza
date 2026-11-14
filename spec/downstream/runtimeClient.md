# Runtime JSON request and account restart

Grace imports `createRuntimeJsonClient`, `RuntimeRequestError`, and
`fetchAgentTransport` in `apps/app/src/runtime-client.ts`. The producer is
`packages/ui/src/api/runtime-json-client.ts` and `transport.ts` at its
vendored Eliza pin. The [native bridge](./mobileRuntime.md) owns process
and route authority. This client owns transport selection and publication
across account epochs.

## Story: Restart account-bound requests without sending a write twice

### A native runtime owns its request once selected

Paths begin with one slash. A body selects POST, absence selects GET.
Web requests serialize JSON and use the configured timeout. Native
requests consult the bridge and its status. If available, they share
startup for their generation and dispatch only after ready. An available
bridge failure is the outcome, even before dispatch, and cannot select
HTTP fallback. Fallback remains an injected policy for an unavailable
bridge. A bad JSON web reply is refused. A non-2xx response carries its
status, a string code if present and nonnegative whole retry seconds
on 429 only. Client budgets are positive bounded integers.

```quint
type RuntimeRoute = RejectPath | ViaNative | ViaFallback | ViaWeb
type RuntimeVerb = RuntimeGet | RuntimePost
pure def selectRoute(validPath: bool, nativePlatform: bool, bridgeAvailable: bool): RuntimeRoute =
  if (not(validPath)) RejectPath else if (not(nativePlatform)) ViaWeb else if (bridgeAvailable) ViaNative else ViaFallback
pure def selectVerb(hasBody: bool): RuntimeVerb = if (hasBody) RuntimePost else RuntimeGet
pure def retrySeconds(status: int, supplied: bool, seconds: int): int = if (status == 429 and supplied and seconds >= 0 and seconds <= 9007199254740991) seconds else -1
pure val statusValues = Set(200, 429, 500)
pure val secondsValues = Set(-1, 0, 30, 2147483648)
pure def lawAvailableNativeOwnsRequest(validPath: bool): bool = validPath implies selectRoute(validPath, true, true) == ViaNative
pure def lawOnlyRateLimitHasRetrySeconds(status: int, supplied: bool, seconds: int): bool = retrySeconds(status, supplied, seconds) >= 0 implies status == 429 and supplied and seconds >= 0 and seconds <= 9007199254740991
```

The bounded witness domain uses values that can round-trip through the trace encoder. The law applies to every integer.

### Account refresh retires older callbacks before the next dispatch

Refresh advances the epoch before checking for a bridge. A request waits
on refresh for its own epoch, then checks any failure recorded there.
A timeout or startup failure returns explicitly. A previous generation's
late success cannot publish or clear a successor's refresh. The model
projects a single observed request while the native refresh slot may be
superseded. It uses explicit generation identity for completion and lets
transport outcomes remain independent of whether a write landed.

```quint
type RequestStage = NoRequest | WaitingRestart | RequestInFlight | ClientResponded | ClientRetired | ClientFailed
type RuntimeRequest = { generation: int, refreshing: bool, refreshFailed: bool, requestGeneration: int, phase: RequestStage, sent: bool }
pure val initial: RuntimeRequest = { generation: 0, refreshing: false, refreshFailed: false, requestGeneration: 0, phase: NoRequest, sent: false }
pure def refreshAccount(r: RuntimeRequest, hasBridge: bool): RuntimeRequest =
  { ...r, generation: r.generation + 1, refreshing: hasBridge, refreshFailed: false, phase: if (r.phase == WaitingRestart or r.phase == RequestInFlight) ClientRetired else r.phase }
pure def canFinishRefresh(r: RuntimeRequest, epoch: int): bool = r.refreshing and epoch == r.generation
pure def finishRefresh(r: RuntimeRequest, epoch: int, confirmed: bool): RuntimeRequest = { ...r, refreshing: false, refreshFailed: not(confirmed), phase: if (r.phase == WaitingRestart and not(confirmed)) ClientFailed else r.phase }
pure def canBeginRequest(r: RuntimeRequest): bool = r.phase != WaitingRestart and r.phase != RequestInFlight
pure def beginRequest(r: RuntimeRequest): RuntimeRequest =
  { ...r, requestGeneration: r.generation, sent: false, phase: if (r.refreshFailed) ClientFailed else WaitingRestart }
pure def canDispatchRequest(r: RuntimeRequest): bool = r.phase == WaitingRestart and r.requestGeneration == r.generation and not(r.refreshing) and not(r.refreshFailed)
pure def dispatchRequest(r: RuntimeRequest): RuntimeRequest = { ...r, phase: RequestInFlight, sent: true }
pure def canCompleteRequest(r: RuntimeRequest, epoch: int): bool = r.phase == RequestInFlight and epoch == r.requestGeneration and epoch == r.generation
pure def completeRequest(r: RuntimeRequest, epoch: int, validResponse: bool): RuntimeRequest =
  { ...r, phase: if (validResponse) ClientResponded else ClientFailed }
pure val epochValues = Set(0, 1, 2, 3)
pure def alwaysCurrentRequestOwnsDispatch(r: RuntimeRequest): bool = r.generation >= 0 and r.requestGeneration >= 0 and r.requestGeneration <= r.generation and ((r.phase == WaitingRestart or r.phase == RequestInFlight) implies r.requestGeneration == r.generation) and (r.phase == RequestInFlight implies r.sent and not(r.refreshing) and not(r.refreshFailed))
pure def alwaysRefreshFailureIsSettled(r: RuntimeRequest): bool = r.refreshFailed implies not(r.refreshing)
pure def alwaysWaitingRequestHasNotSent(r: RuntimeRequest): bool = r.phase == WaitingRestart implies not(r.sent)
pure def stepRefreshCannotReplay(before: RuntimeRequest, via: str, after: RuntimeRequest): bool = via == "refreshAccount" implies after.sent == before.sent and after.phase != RequestInFlight
pure def sometimesAwaitRefresh(r: RuntimeRequest): bool = r.phase == WaitingRestart and r.refreshing
pure def sometimesRetiredAfterSend(r: RuntimeRequest): bool = r.phase == ClientRetired and r.sent
pure def sometimesCurrentResponse(r: RuntimeRequest): bool = r.phase == ClientResponded
```
