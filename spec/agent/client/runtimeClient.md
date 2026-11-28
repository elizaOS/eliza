# Runtime client

The request client a screen uses to call the agent of the account signed in
now (`createRuntimeJsonClient`, with `refreshNativeAccount()`,
`request(path, body?, headers?)`, `stream(path, body, signal?, headers?)` and
the refusal error `RuntimeRequestError {message, status, code?, retryAfter?}`).
The host gives it a bridge `RuntimeJsonBridge {status(), start(), restart(),
request({path, method, body?, headers?}), requestStream?({path, method, body?,
headers?}, signal)}`, whose
status `RuntimeStatus {available, state: stopped|starting|running, error?,
requestBodyLimit?}` the shell reads as `Unavailable` or `Available({ phase })`;
with no bridge object (a browser page) it reports `Unavailable` without a
call. The host may configure an HTTP base (a browser page or a development
host, never a production device), passed to each probe as the `fallback`.
The client adds no credentials and sends each request at most once, over
the route this machine names in its output. A bridge's
`RUNTIME_NOT_READY` refusal is final for that request. The older UI
transport could opt into replaying that refusal after startup. The client
passes `requestBodyLimit` to the screen unchanged, and only as a safe integer
above 0. Each call's answer carries the generation in which the shell made
the call.

## Story: Call the runtime for my current account

> As a user, I want my requests to go to the agent of the account I am signed
> in to now, so that a reply meant for an earlier account is never shown to me.

### An account refresh starts a new generation and restarts an available runtime

With no bridge available the refresh is done. Otherwise it restarts the
runtime and, unless the restart reports it running, waits for its startup. A
bridge error or the deadline `startupTimeoutMs` breaks it. An answer to an
older refresh or its startup is refused. A new start or restart waits for
an earlier lifecycle call already handed to the bridge to settle. This
keeps a late restart from changing which account owns the current runtime.

```quint
import numbers.* from "../../core/numbers"
type Route = Bridge | Http
type Fallback = NoFallback | HttpFallback
type RuntimePhase = Stopped | Starting | Running
type StatusReport = Unavailable | Available({ phase: RuntimePhase })
type PathShape = Rooted | Unrooted
type Failure = AccountChanged | RefreshFailed | StartupFailed | TransportFailed | NoRoute | Cancelled
type Delivery = Plain | Stream
type RetryAdvice = NoAdvice | RetryAfter({ seconds: int })
type Stage = AwaitRefresh | Probing | AwaitStartup | Sent({ route: Route }) | Streaming({ route: Route }) | Replied({ servedBy: Route }) | Refused({ httpStatus: int, retry: RetryAdvice }) | Failed({ why: Failure })
type Request = { id: int, gen: int, delivery: Delivery, stage: Stage }
type Refresh = Current | ProbingAccount | Restarting | AwaitRestart | RefreshBroken
type Startup = NoStartup | StartingUp
type RuntimeClient = { gen: int, nextId: int, refresh: Refresh, startup: Startup, requests: List[Request] }
type BridgeCall = CallStart | CallRestart | Send({ request: int, over: Route })
type ClientStep = { state: RuntimeClient, out: List[BridgeCall] }
pure val initial: RuntimeClient = { gen: 0, nextId: 0, refresh: Current, startup: NoStartup, requests: List() }
pure val reportValues = Set(Unavailable, Available({ phase: Stopped }), Available({ phase: Starting }), Available({ phase: Running }))
pure val fallbackValues = Set(NoFallback, HttpFallback)
pure val ofGenValues = 0.to(20)
pure val idValues = 0.to(20)
pure def emit(out: List[BridgeCall], c: RuntimeClient): ClientStep = { state: c, out: out }
pure def ensureCalls(phase: RuntimePhase, c: RuntimeClient): List[BridgeCall] = if (c.startup == NoStartup and phase == Stopped) List(CallStart) else List()
pure def refreshing(r: Refresh): bool = r == ProbingAccount or r == Restarting or r == AwaitRestart
pure def refreshAccount(c: RuntimeClient): RuntimeClient = { ...c, gen: c.gen + 1, refresh: ProbingAccount, startup: NoStartup }
pure def canRefreshStatus(c: RuntimeClient, ofGen: int): bool = c.refresh == ProbingAccount and ofGen == c.gen
pure def refreshStatus(c: RuntimeClient, ofGen: int, report: StatusReport): ClientStep = match report {
  | Available(a) => emit(List(CallRestart), { ...c, refresh: Restarting })
  | Unavailable => emit(List(), { ...c, refresh: Current })
}
pure def canRestarted(c: RuntimeClient, ofGen: int): bool = c.refresh == Restarting and ofGen == c.gen
pure def restarted(c: RuntimeClient, ofGen: int, phase: RuntimePhase): ClientStep =
  if (phase == Running) emit(List(), { ...c, refresh: Current })
  else emit(ensureCalls(phase, c), { ...c, refresh: AwaitRestart, startup: StartingUp })
pure def canRefreshError(c: RuntimeClient, ofGen: int): bool = refreshing(c.refresh) and ofGen == c.gen
pure def refreshError(c: RuntimeClient, ofGen: int): RuntimeClient = { ...c, refresh: RefreshBroken }
pure def stepGenerationsAdvanceOnlyByRefresh(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  after.gen == (if (via == "refreshAccount") before.gen + 1 else before.gen)
pure def stepOnlyARefreshRestarts(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(CallRestart) implies (before.refresh == ProbingAccount and after.refresh == Restarting)
pure def sometimesRefreshWaitsForStartup(c: RuntimeClient): bool = c.gen >= 1 and c.refresh == AwaitRestart
```

### A request path starts with one slash and not two

The client also refuses backslashes, spaces and ASCII control characters
through U+0020 before numbering or sending the request. The HTTP fallback
checks the resolved origin against its configured origin. `request`
submits a `Plain` request and `stream` a `Stream` one.

```quint
pure def canSubmit(c: RuntimeClient, path: PathShape, delivery: Delivery): bool = path == Rooted
pure def submit(c: RuntimeClient, path: PathShape, delivery: Delivery): RuntimeClient = {
  val first = if (refreshing(c.refresh)) AwaitRefresh else if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing
  { ...c, nextId: c.nextId + 1, requests: c.requests.append({ id: c.nextId, gen: c.gen, delivery: delivery, stage: first }) }
}
pure val pathValues = Set(Rooted, Unrooted)
pure val deliveryValues = Set(Plain, Stream)
```

### A request carries only device headers and the client id, a bounded few

`request` and `stream` take optional headers, and the client carries them
over either route only when every one is carried: its name, compared without
case, is `x-elizaos-client-id` or `x-eliza-device-` followed by words of
letters and digits joined by hyphens, its value is printable ASCII, and no
other header of the request has that name. A device header whose last word
is `key`, `token`, `secret`, `password` or `signature` is a credential and is
never carried, with one named exception: `x-eliza-device-key` is carried
when its value is exactly 64 lowercase hexadecimal digits, the enrollment
key the agent hashes to know which enrolled installation is speaking. The
native channel is an owner-only boundary on the same device, so its root
token proves the owner but not the installation, and enrollment is keyed
per installation; any other value of that header is a credential like the
rest. An authorization, cookie, host or hop-by-hop header has no allowed
name, so it is never carried either. At most `headerCountLimit` headers go with
one request, of at most `headerBytesLimit` bytes of names and values
together. A request with any other header is refused as `InvalidHeaders`
before it is numbered or sent, so the bridge and the HTTP base carry the same
headers, with lowercase names, beside the content type the HTTP route adds.
The native agent channel holds its callers to this rule
(`spec/os/agentService/channel.md`).

```quint
type HeaderName = DeviceFact | EnrollmentKey | DeviceCredential | ClientIdHeader | OtherHeader
type RequestHeader = { key: str, name: HeaderName, bytes: int, printable: bool }
pure val headerCountLimit = 16
pure val headerBytesLimit = 8192
pure def carriedName(name: HeaderName): bool = name == DeviceFact or name == EnrollmentKey or name == ClientIdHeader
pure def headerCrosses(header: RequestHeader): bool = header.printable and carriedName(header.name)
pure def headersCross(headers: List[RequestHeader]): bool =
  headers.every(h => headerCrosses(h) and headers.select(o => o.key == h.key).length() == 1)
pure def headersFit(headers: List[RequestHeader]): bool =
  headers.length() <= headerCountLimit and headers.foldl(0, (total, h) => total + h.bytes) <= headerBytesLimit
pure def headersCarried(headers: List[RequestHeader]): bool = headersCross(headers) and headersFit(headers)
pure val headersValues = Set(
  List(),
  List({ key: "x-eliza-device-capabilities", name: DeviceFact, bytes: 61, printable: true }, { key: "x-elizaos-client-id", name: ClientIdHeader, bytes: 27, printable: true }),
  List({ key: "x-eliza-device-id", name: DeviceFact, bytes: 53, printable: true }, { key: "x-eliza-device-id", name: DeviceFact, bytes: 53, printable: true }),
  List({ key: "x-eliza-device-id", name: DeviceFact, bytes: 53, printable: true }, { key: "x-eliza-device-key", name: EnrollmentKey, bytes: 82, printable: true }),
  List({ key: "x-eliza-device-key", name: DeviceCredential, bytes: 50, printable: true }),
  List({ key: "x-eliza-device-token", name: DeviceCredential, bytes: 40, printable: true }),
  List({ key: "authorization", name: OtherHeader, bytes: 40, printable: true }),
  List({ key: "x-eliza-device-enrollment-id", name: DeviceFact, bytes: 30, printable: false }),
  List({ key: "x-eliza-device-protocol", name: DeviceFact, bytes: 9000, printable: true }))
pure def lawOnlyDeviceFactsTheEnrollmentKeyAndTheClientIdAreCarried(headers: List[RequestHeader]): bool =
  headersCarried(headers) implies headers.every(h => h.printable and carriedName(h.name) and h.name != DeviceCredential and h.name != OtherHeader)
```

### Each request has a number no other request has

`submit` gives the request the number `nextId`, which the shell reads first.

```quint
pure def alwaysRequestNumbersAreUnique(c: RuntimeClient): bool =
  c.requests.every(r => r.id < c.nextId and c.requests.select(q => q.id == r.id).length() == 1)
```

### A request waits for its generation's refresh, and a broken refresh fails it

Every waiter resumes when the refresh ends; while it is broken, every request
of the generation fails.

```quint
pure def isWaiting(s: Stage): bool = match s {
  | AwaitRefresh => true
  | Probing => true
  | AwaitStartup => true
  | Sent(x) => true
  | Streaming(x) => true
  | _ => false
}
pure def isSent(s: Stage): bool = match s {
  | Sent(x) => true
  | _ => false
}
pure def own(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and r.gen == c.gen)
pure def stageIs(c: RuntimeClient, id: int, s: Stage): bool = c.requests.some(r => r.id == id and r.stage == s)
pure def sentNow(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and isSent(r.stage))
pure def setStage(c: RuntimeClient, id: int, s: Stage): List[Request] = c.requests.listMap(r => if (r.id == id) { ...r, stage: s } else r)
pure def canResume(c: RuntimeClient): bool = not(refreshing(c.refresh)) and c.requests.some(r => r.gen == c.gen and r.stage == AwaitRefresh)
pure def resume(c: RuntimeClient): RuntimeClient = {
  val resumed = if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing
  { ...c, requests: c.requests.listMap(r => if (r.gen == c.gen and r.stage == AwaitRefresh) { ...r, stage: resumed } else r) }
}
pure def stepProbeOnlyAfterACurrentRefresh(before: RuntimeClient, after: RuntimeClient): bool =
  after.requests.every(r => (r.stage == Probing and not(stageIs(before, r.id, Probing))) implies after.refresh == Current)
pure def sometimesBrokenRefreshFailsRequest(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: RefreshFailed }))
```

### A request dispatches and publishes only in its own generation

After a refresh, each unsettled request of an older generation, sent or not,
fails as `AccountChanged`, and a late reply to it is refused. A request's
generation is one the client has issued.

```quint
pure def stale(c: RuntimeClient, r: Request): bool = r.gen != c.gen and isWaiting(r.stage)
pure def canAbandon(c: RuntimeClient): bool = c.requests.some(r => stale(c, r))
pure def abandon(c: RuntimeClient): RuntimeClient =
  { ...c, requests: c.requests.listMap(r => if (stale(c, r)) { ...r, stage: Failed({ why: AccountChanged }) } else r) }
pure def isAnswered(s: Stage): bool = match s {
  | Replied(x) => true
  | Refused(x) => true
  | Streaming(x) => true
  | _ => false
}
pure def sentIn(after: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => own(after, x.request) and sentNow(after, x.request)
  | _ => true
}
pure def alwaysGenerationsAreIssued(c: RuntimeClient): bool = c.gen >= 0 and c.requests.every(r => r.gen >= 0 and r.gen <= c.gen)
pure def stepSendOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => sentIn(after, o))
pure def stepPublishOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient): bool =
  after.requests.every(r => (isAnswered(r.stage) and not(before.requests.some(q => q.id == r.id and isAnswered(q.stage)))) implies r.gen == before.gen)
pure def sometimesChangedAccountFailsRequest(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: AccountChanged }))
pure def sometimesReplyAfterRefresh(c: RuntimeClient): bool =
  c.gen >= 1 and c.requests.some(r => r.gen == c.gen and r.stage == Replied({ servedBy: Bridge }))
```

### A stream is sent at most once and only in its generation

A stream goes through the same probe, startup and route as a request, and a
2xx head opens it as `Streaming`: the screen then reads its body as bytes.
Its body ending makes it `Replied`; a broken body fails it as
`TransportFailed`, and the caller's signal as `Cancelled`. A refresh fails a
stream of an older generation as `AccountChanged`, and the shell aborts its
body through the bridge or the HTTP call, so no byte of it reaches the
screen after the refresh.

```quint
pure def isStreaming(s: Stage): bool = match s {
  | Streaming(x) => true
  | _ => false
}
pure def streamingNow(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and isStreaming(r.stage))
pure def bodyEnded(s: Stage): Stage = match s {
  | Streaming(x) => Replied({ servedBy: x.route })
  | _ => s
}
pure def canStreamEnded(c: RuntimeClient, id: int): bool = own(c, id) and streamingNow(c, id)
pure def streamEnded(c: RuntimeClient, id: int): RuntimeClient =
  { ...c, requests: c.requests.listMap(r => if (r.id == id) { ...r, stage: bodyEnded(r.stage) } else r) }
pure def canCancel(c: RuntimeClient, id: int): bool = own(c, id) and c.requests.some(r => r.id == id and r.delivery == Stream and isWaiting(r.stage))
pure def cancel(c: RuntimeClient, id: int): RuntimeClient = { ...c, requests: setStage(c, id, Failed({ why: Cancelled })) }
pure def streamSentOnce(before: RuntimeClient, after: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => after.requests.some(r => r.id == x.request and r.delivery == Stream) implies
      (own(after, x.request) and before.requests.some(q => q.id == x.request and not(isSent(q.stage)) and not(isStreaming(q.stage))))
  | _ => true
}
pure def stepStreamSentOnceInItsGeneration(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => streamSentOnce(before, after, o))
pure def stepStreamEndsOnlyInItsGeneration(before: RuntimeClient, after: RuntimeClient): bool =
  after.requests.every(r => (not(isWaiting(r.stage)) and before.requests.some(q => q.id == r.id and isStreaming(q.stage))) implies (r.gen == before.gen or r.stage == Failed({ why: AccountChanged })))
pure def sometimesStreamReplied(c: RuntimeClient): bool = c.requests.some(r => r.delivery == Stream and r.stage == Replied({ servedBy: Bridge }))
pure def sometimesStreamAbandoned(c: RuntimeClient): bool =
  c.gen >= 1 and c.requests.some(r => r.delivery == Stream and r.gen == 0 and r.stage == Failed({ why: AccountChanged }))
```

### Only a settled request can be released

The screen releases a request once it has read its outcome.

```quint
pure def canRelease(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and not(isWaiting(r.stage)))
pure def release(c: RuntimeClient, id: int): RuntimeClient = { ...c, requests: c.requests.select(r => r.id != id) }
pure def stepWaitingIsNeverDropped(before: RuntimeClient, after: RuntimeClient): bool =
  before.requests.every(r => isWaiting(r.stage) implies after.requests.some(q => q.id == r.id))
```

## Story: Reach a runtime that is not running yet

> As a user, I want my request to wait while the agent starts, so that I do
> not have to retry by hand, and never to be sent twice.

### Requests to a runtime that is not running wait for one shared startup

A status of stopped calls `start()`; a status of starting only waits. A
request that finds a startup of its generation in progress joins it. The
shell polls status every `pollMs` while a startup runs.

```quint
type ProbeOutcome = ViaBridge | ViaHttp | MustStart({ phase: RuntimePhase }) | Unrouted
pure def probeOutcome(report: StatusReport, fallback: Fallback): ProbeOutcome = match report {
  | Unavailable => if (fallback == HttpFallback) ViaHttp else Unrouted
  | Available(a) => if (a.phase == Running) ViaBridge else MustStart({ phase: a.phase })
}
pure def dispatch(id: int, route: Route, c: RuntimeClient): ClientStep =
  emit(List(Send({ request: id, over: route })), { ...c, requests: setStage(c, id, Sent({ route: route })) })
pure def canRequestStatus(c: RuntimeClient, id: int): bool = own(c, id) and stageIs(c, id, Probing)
pure def requestStatus(c: RuntimeClient, id: int, report: StatusReport, fallback: Fallback): ClientStep = {
  val found = probeOutcome(report, fallback)
  match found {
    | ViaBridge => dispatch(id, Bridge, c)
    | ViaHttp => dispatch(id, Http, c)
    | MustStart(m) => emit(ensureCalls(m.phase, c), { ...c, startup: StartingUp, requests: setStage(c, id, AwaitStartup) })
    | Unrouted => emit(List(), { ...c, requests: setStage(c, id, Failed({ why: NoRoute })) })
  }
}
pure def awaitsStartup(c: RuntimeClient, r: Request): bool = r.gen == c.gen and r.stage == AwaitStartup
pure def stepStartOnlyWithoutStartup(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(CallStart) implies (before.startup == NoStartup and after.startup == StartingUp)
pure def alwaysWaitersHaveAStartup(c: RuntimeClient): bool =
  (c.requests.some(r => awaitsStartup(c, r)) or c.refresh == AwaitRestart) implies c.startup == StartingUp
pure def sometimesSharedStartup(c: RuntimeClient): bool = c.requests.select(r => awaitsStartup(c, r)).length() >= 2
```

### A startup ends when the runtime reports running, or else fails

Running sends each waiting request of the generation over the bridge and
completes a waiting refresh. A stopped report, a bridge error, or the
deadline `startupTimeoutMs` after the startup began fails them all.

```quint
pure def settleStartup(ok: bool, c: RuntimeClient): ClientStep = {
  val ended = c.requests.listMap(r => if (awaitsStartup(c, r)) { ...r, stage: if (ok) Sent({ route: Bridge }) else Failed({ why: StartupFailed }) } else r)
  val sends = c.requests.foldl(List(), (acc, r) => if (ok and awaitsStartup(c, r)) acc.append(Send({ request: r.id, over: Bridge })) else acc)
  emit(sends, { ...c, startup: NoStartup, requests: ended, refresh: if (c.refresh == AwaitRestart) (if (ok) Current else RefreshBroken) else c.refresh })
}
pure def canStartupRan(c: RuntimeClient, ofGen: int): bool = c.startup == StartingUp and ofGen == c.gen
pure def startupRan(c: RuntimeClient, ofGen: int): ClientStep = settleStartup(true, c)
pure def canStartupFailed(c: RuntimeClient, ofGen: int): bool = c.startup == StartingUp and ofGen == c.gen
pure def startupFailed(c: RuntimeClient, ofGen: int): ClientStep = settleStartup(false, c)
pure def sometimesStartupFailed(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: StartupFailed }))
pure def sometimesRefreshServedAfterStartup(c: RuntimeClient): bool =
  c.gen >= 1 and c.refresh == Current and c.startup == NoStartup and c.requests.some(r => r.gen == c.gen and r.stage == Replied({ servedBy: Bridge }))
```

### An available bridge owns the request, and nothing is sent twice

HTTP serves a request only when its probe found no bridge and the host
configured an HTTP base; with no base the request fails as `NoRoute`. A
request that waited for a startup goes over the bridge or fails. A sent
request only settles or opens as a stream. The request timeout applies to
probing, a buffered call and opening a stream. A successful buffered HTTP
answer must have a JSON body or status `204`; invalid JSON fails as
`TransportFailed`. A non-2xx HTTP answer can still report the refusal
status when its body is unreadable.

```quint
pure def canTransportFailed(c: RuntimeClient, id: int): bool = own(c, id) and (stageIs(c, id, Probing) or sentNow(c, id) or streamingNow(c, id))
pure def transportFailed(c: RuntimeClient, id: int): RuntimeClient = { ...c, requests: setStage(c, id, Failed({ why: TransportFailed })) }
pure def lawHttpOnlyWithoutBridge(report: StatusReport, fallback: Fallback): bool =
  probeOutcome(report, fallback) == ViaHttp implies (report == Unavailable and fallback == HttpFallback)
pure def httpAfterProbe(before: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => x.over == Http implies stageIs(before, x.request, Probing)
  | _ => true
}
pure def firstSend(before: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => not(sentNow(before, x.request))
  | _ => true
}
pure def stepHttpOnlyWithoutBridge(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => httpAfterProbe(before, o))
pure def stepSentIsNeverResent(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => firstSend(before, o)) and before.requests.every(r => isSent(r.stage) implies after.requests.every(q => q.id == r.id implies (q.stage == r.stage or isStreaming(q.stage) or not(isWaiting(q.stage)))))
pure def sometimesHttpServed(c: RuntimeClient): bool = c.requests.some(r => r.stage == Replied({ servedBy: Http }))
pure def sometimesNoRoute(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: NoRoute }))
```

### Every submitted request settles

Assuming the bridge settles each call, each deadline passes, and each
refresh, startup and stale request is followed up, no request waits for ever.

```quint
pure val fair_transportFailed = "weak"
pure val fair_startupFailed = "weak"
pure val fair_refreshError = "weak"
pure val fair_resume = "weak"
pure val fair_abandon = "weak"
pure def leadsToRequestSettles(c: RuntimeClient, later: RuntimeClient): bool =
  c.requests.every(r => isWaiting(r.stage) implies later.requests.every(q => q.id == r.id implies not(isWaiting(q.stage))))
```

## Story: Understand why the runtime refused

> As a user, I want a refusal to say what the runtime said, so that the screen
> can tell me whether and when to try again.

### A refusal is a non-2xx status, and keeps retry advice only from a 429 with a safe whole number of seconds

A 2xx answer is the reply, or for a stream its head. The refusal error also carries the body's `error`
and `code` strings, which the shell keeps and the machine does not see. The
shell drops a `retryAfter` outside the safely representable whole numbers
before passing retry advice to the machine.

```quint
pure def admitAdvice(httpStatus: int, retry: RetryAdvice): RetryAdvice = match retry {
  | RetryAfter(r) => if (httpStatus == 429 and r.seconds >= 0 and r.seconds <= maxSafeInteger) RetryAfter({ seconds: r.seconds }) else NoAdvice
  | NoAdvice => NoAdvice
}
pure def answerOf(s: Stage, delivery: Delivery, httpStatus: int, retry: RetryAdvice): Stage = match s {
  | Sent(x) => if (httpStatus >= 200 and httpStatus < 300) (if (delivery == Stream) Streaming({ route: x.route }) else Replied({ servedBy: x.route })) else Refused({ httpStatus: httpStatus, retry: admitAdvice(httpStatus, retry) })
  | _ => s
}
pure def canReply(c: RuntimeClient, id: int): bool = own(c, id) and sentNow(c, id)
pure def reply(c: RuntimeClient, id: int, httpStatus: int, retry: RetryAdvice): RuntimeClient =
  { ...c, requests: c.requests.listMap(r => if (r.id == id) { ...r, stage: answerOf(r.stage, r.delivery, httpStatus, retry) } else r) }
pure val httpStatusValues = Set(200, 409, 429, 503)
pure val retryValues = Set(NoAdvice, RetryAfter({ seconds: -1 }), RetryAfter({ seconds: 0 }), RetryAfter({ seconds: 30 }), RetryAfter({ seconds: maxSafeInteger }))
pure def adviceAllowed(httpStatus: int, advice: RetryAdvice): bool = match advice {
  | RetryAfter(a) => httpStatus == 429 and a.seconds >= 0 and a.seconds <= maxSafeInteger
  | NoAdvice => true
}
pure def adviceFits(s: Stage): bool = match s {
  | Refused(x) => (x.httpStatus < 200 or x.httpStatus >= 300) and adviceAllowed(x.httpStatus, x.retry)
  | _ => true
}
pure def alwaysRefusalAdviceOnlyOn429(c: RuntimeClient): bool = c.requests.every(r => adviceFits(r.stage))
pure def sometimesRefusedWithAdvice(c: RuntimeClient): bool = c.requests.some(r => r.stage == Refused({ httpStatus: 429, retry: RetryAfter({ seconds: 30 }) }))
```
