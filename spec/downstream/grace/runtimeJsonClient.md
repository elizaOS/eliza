# Grace runtime JSON client authority

Grace `48b43b9c` directly constructs the Eliza `7743504b`
`createRuntimeJsonClient` from `apps/app/src/runtime-client.ts`.
The producer is `packages/ui/src/api/runtime-json-client.ts`.
[Resident runtime request authority](../mobileRuntime.md) owns the
separate native service epoch. [Reply streaming](./replyStreaming.md)
owns the stream protocol carried by this client.

## Story: Call the runtime for my current account

### Refresh owns the client generation before it touches the bridge

Every refresh advances the generation and clears its previous failure,
even when the platform is web or the native bridge disappeared. A
present native bridge reads status and restarts only if status reports
availability. The refresh has its own startup deadline. The current
refresh failure blocks later requests in that generation until another
refresh. An older refresh can return its own failure to its caller
without installing the failure or clearing the latest refresh.
A request arriving during a current refresh waits on that specific
promise. After it settles, the request still has to own its generation.
It checks platform and bridge availability at that point.
The model represents one held request and the latest refresh. It
receives the first two path characters from the host to model the
exact leading-slash check.

```quint
type RefreshState = NoRefresh | RefreshInProgress | RefreshBlocked
type RefreshReply = RestartReady | RuntimeUnavailable | RefreshFailed
type RequestPhase = ClientIdle | WaitingRefresh | CheckingNative | WaitingNativeStartup |
  NativeDispatched | FixtureDispatched | WebDispatched | ClientSettled
type ClientResult = NoClientResult | InvalidPath | OwnerChanged | RefreshRefused |
  StartupRefused | TransportFailed | FixtureUnavailable | InvalidJson | RuntimeRefused | RuntimeValue
type RuntimeClient = { epoch: int, refreshState: RefreshState, requestEpoch: int, requestPhase: RequestPhase,
  result: ClientResult, nativePlatform: bool, bridgePresent: bool }
pure val noRefresh: RefreshState = NoRefresh
pure val initial: RuntimeClient = { epoch: 0, refreshState: NoRefresh, requestEpoch: 0,
  requestPhase: ClientIdle, result: NoClientResult, nativePlatform: false, bridgePresent: false }
pure def refreshRuntime(s: RuntimeClient, nativePlatform: bool, bridgePresent: bool): RuntimeClient =
  { ...s, epoch: s.epoch + 1, refreshState: if (nativePlatform and bridgePresent) RefreshInProgress else noRefresh }
pure def canObserveRefresh(s: RuntimeClient): bool = s.refreshState == RefreshInProgress
pure def observeRefresh(s: RuntimeClient, exactRefresh: bool, refreshReply: RefreshReply): RuntimeClient =
  if (not(exactRefresh)) s
  else { ...s, refreshState: if (refreshReply == RefreshFailed) RefreshBlocked else noRefresh }
type PathStart = { first: str, second: str }
pure def pathAdmitted(pathStart: PathStart): bool = pathStart.first == "/" and pathStart.second != "/"
pure def finishClientRequest(clientResult: ClientResult, s: RuntimeClient): RuntimeClient =
  { ...s, requestPhase: ClientSettled, result: clientResult }
pure def firstRequestPhase(nativePlatform: bool, bridgePresent: bool): RequestPhase =
  if (not(nativePlatform)) WebDispatched else if (bridgePresent) CheckingNative else FixtureDispatched
pure def canBeginClientRequest(s: RuntimeClient): bool =
  s.requestPhase == ClientIdle or s.requestPhase == ClientSettled
pure def beginClientRequest(s: RuntimeClient, pathStart: PathStart, nativePlatform: bool, bridgePresent: bool): RuntimeClient = {
  val request = { ...s, nativePlatform: nativePlatform, bridgePresent: bridgePresent, requestEpoch: s.epoch }
  if (not(pathAdmitted(pathStart))) finishClientRequest(InvalidPath, request)
  else if (s.refreshState == RefreshBlocked) finishClientRequest(RefreshRefused, request)
  else { ...request, result: NoClientResult,
    requestPhase: if (s.refreshState == RefreshInProgress) WaitingRefresh else firstRequestPhase(nativePlatform, bridgePresent) }
}
type WaitEvidence = { exactPromiseSettled: bool, waitedPromiseFailed: bool, currentPlatformNative: bool, currentBridgePresent: bool }
pure val normalWait: WaitEvidence = { exactPromiseSettled: true, waitedPromiseFailed: false, currentPlatformNative: true, currentBridgePresent: true }
pure val waitEvidenceValues = Set(normalWait, { ...normalWait, exactPromiseSettled: false },
  { ...normalWait, waitedPromiseFailed: true }, { ...normalWait, currentBridgePresent: false },
  { ...normalWait, currentPlatformNative: false })
pure def canReleaseRefreshWait(s: RuntimeClient, waitEvidence: WaitEvidence): bool =
  waitEvidence.exactPromiseSettled and s.requestPhase == WaitingRefresh and
    (s.requestEpoch != s.epoch or s.refreshState != RefreshInProgress)
pure def releaseRefreshWait(s: RuntimeClient, waitEvidence: WaitEvidence): RuntimeClient =
  if (waitEvidence.waitedPromiseFailed) finishClientRequest(RefreshRefused, s)
  else if (s.requestEpoch != s.epoch) finishClientRequest(OwnerChanged, s)
  else if (s.refreshState == RefreshBlocked) finishClientRequest(RefreshRefused, s)
  else { ...s, nativePlatform: waitEvidence.currentPlatformNative, bridgePresent: waitEvidence.currentBridgePresent,
    requestPhase: firstRequestPhase(waitEvidence.currentPlatformNative, waitEvidence.currentBridgePresent) }
pure def alwaysRequestIdentityIsAllocated(s: RuntimeClient): bool =
  s.epoch >= 0 and s.requestEpoch >= 0 and s.requestEpoch <= s.epoch
pure val pathStartValues = Set({ first: "", second: "" }, { first: "h", second: "e" },
  { first: "/", second: "" }, { first: "/", second: "h" }, { first: "/", second: "/" })
pure val weight_beginClientRequest = 5
pure val weight_observeRefresh = 4
```

### A native bridge that reports available owns the request through settlement

Without a native bridge, or after a successful status reply reporting
unavailable, the client delegates to the host's native fallback.
Grace's fallback is available only to the fixture build and calls a
pinned loopback runtime. The available bridge takes sole ownership.
Failed status, startup or bridge request does not select fallback.
Any startup in the same generation can share its promise. Already
running status bypasses startup. A new start is requested only for
status other than running or starting. Starting state polls within
the original monotonic deadline, and terminal non-running state or
deadline rejects. A retired entry's cleanup cannot remove its
successor. The request reducer receives the readiness observation.

The web transport sends an HTTP JSON request with an abort deadline.
An undefined body means GET, including through the native bridge.
An explicit null means POST, as does any other supplied JSON value.
No request is retried here. The port keeps transport rejection distinct
from a completed response. A web response parses JSON before it checks
its current generation. An available native request rechecks after
status, startup and a returned response. A native fallback rejection
maps to the host fallback error before response classification.

```quint
type NativeReading = NativeRunning | NativeStarting | NativeStopped | NativeAbsent | StatusFailed
type TransportReading = ResponseReturned | TransportRejected | BodyInvalidJson
type StartupPlan = UseRunning | JoinStartup | PollStartup | StartRuntime | RefuseStartup
pure def startupPlan(statusRead: NativeReading, sameGenerationStart: bool): StartupPlan =
  if (statusRead == NativeRunning) UseRunning
  else if (statusRead == NativeAbsent or statusRead == StatusFailed) RefuseStartup
  else if (sameGenerationStart) JoinStartup
  else if (statusRead == NativeStarting) PollStartup else StartRuntime
pure def clientMethod(bodySupplied: bool): str = if (bodySupplied) "POST" else "GET"
pure def canObserveNativeStatus(s: RuntimeClient): bool = s.requestPhase == CheckingNative
pure def observeNativeStatus(s: RuntimeClient, statusRead: NativeReading): RuntimeClient =
  if (statusRead == StatusFailed) finishClientRequest(TransportFailed, s)
  else if (s.requestEpoch != s.epoch) finishClientRequest(OwnerChanged, s)
  else if (statusRead == NativeAbsent) { ...s, requestPhase: FixtureDispatched }
  else if (statusRead == NativeRunning) { ...s, requestPhase: NativeDispatched }
  else { ...s, requestPhase: WaitingNativeStartup }
pure def canObserveNativeStartup(s: RuntimeClient): bool = s.requestPhase == WaitingNativeStartup
pure def observeNativeStartup(s: RuntimeClient, startupSucceeded: bool): RuntimeClient =
  if (not(startupSucceeded)) finishClientRequest(StartupRefused, s)
  else if (s.requestEpoch != s.epoch) finishClientRequest(OwnerChanged, s)
  else { ...s, requestPhase: NativeDispatched }
pure def canObserveClientReply(s: RuntimeClient): bool =
  s.requestPhase == NativeDispatched or s.requestPhase == FixtureDispatched or s.requestPhase == WebDispatched
pure def observeClientReply(s: RuntimeClient, transportRead: TransportReading, statusCode: int): RuntimeClient =
  if (transportRead == TransportRejected) finishClientRequest(
    if (s.requestPhase == FixtureDispatched) FixtureUnavailable else TransportFailed, s)
  else if (transportRead == BodyInvalidJson and s.requestPhase == WebDispatched) finishClientRequest(InvalidJson, s)
  else if (s.requestEpoch != s.epoch) finishClientRequest(OwnerChanged, s)
  else finishClientRequest(if (statusCode >= 200 and statusCode < 300) RuntimeValue else RuntimeRefused, s)
pure def stepOnlyCurrentReplyPublishes(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  via == "observeClientReply" and after.result == RuntimeValue implies before.requestEpoch == before.epoch
pure def stepNativeStartupCannotSelectFixture(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  via == "observeNativeStartup" implies after.requestPhase != FixtureDispatched
pure def sometimesNativeDispatch(s: RuntimeClient): bool = s.requestPhase == NativeDispatched
pure def sometimesCurrentReply(s: RuntimeClient): bool = s.result == RuntimeValue
pure def sometimesRetiredReply(s: RuntimeClient): bool = s.result == OwnerChanged
pure def sometimesRefreshRefusal(s: RuntimeClient): bool = s.result == RefreshRefused
pure val statusCodeValues = Set(199, 200, 299, 300, 409, 429, 503)
pure val weight_observeClientReply = 8
```

### Runtime refusal preserves its status and admitted retry information

A non-success response becomes `RuntimeRequestError`. A string error
or code comes from the body. A missing or nonstring error uses the
host's request message, and a nonstring code is omitted. Only HTTP 429
can provide retry seconds, through a numeric nonnegative safe integer.
The bridge data, raw parsed JSON and exception causes stay at the port.

```quint
pure def retryAfterAdmitted(statusCode: int, retrySeconds: int, integerValue: bool): bool =
  statusCode == 429 and integerValue and retrySeconds >= 0 and retrySeconds <= 9007199254740991
pure def lawOtherStatusesHaveNoRetryAdvice(statusCode: int, retrySeconds: int, integerValue: bool): bool =
  statusCode != 429 implies not(retryAfterAdmitted(statusCode, retrySeconds, integerValue))
pure val retrySecondsValues = Set(-1, 0, 3)
```

Grace chooses 210 seconds for startup, 200 milliseconds between polls
and 120 seconds for the web request. The model treats timeouts, timer
cleanup and bridge results as port observations. The source client
does not impose the web abort deadline on the native bridge request.
