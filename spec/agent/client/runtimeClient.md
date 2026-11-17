# Runtime client

The request client a screen uses to call the agent of the account signed in
now (`createRuntimeJsonClient`, with `refreshNativeAccount()`,
`request(path, body?)` and the refusal error `RuntimeRequestError {message,
status, code?, retryAfter?}`). The host gives it a bridge `RuntimeJsonBridge
{status(), start(), restart(), request({path, method, body?})}`, whose
status `RuntimeStatus {available, state: stopped|starting|running, error?,
requestBodyLimit?}` the shell reads as `Unavailable` or `Available({ phase })`;
with no bridge object (a browser page) it reports `Unavailable` without a
call. The host may configure an HTTP base (a browser page or a development
host, never a production device), passed to each probe as the `fallback`.
The client adds no credentials, retries or replays: the shell sends each
request at most once, over the route this machine names in its output. It
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
older refresh or its startup is refused.

```quint
import numbers.* from "../../core/numbers"
type Route = Bridge | Http
type Fallback = NoFallback | HttpFallback
type RuntimePhase = Stopped | Starting | Running
type StatusReport = Unavailable | Available({ phase: RuntimePhase })
type PathShape = Rooted | Unrooted
type Failure = AccountChanged | RefreshFailed | StartupFailed | TransportFailed | NoRoute
type RetryAdvice = NoAdvice | RetryAfter({ seconds: int })
type Stage = AwaitRefresh | Probing | AwaitStartup | Sent({ route: Route }) | Replied({ servedBy: Route }) | Refused({ httpStatus: int, retry: RetryAdvice }) | Failed({ why: Failure })
type Request = { id: int, gen: int, stage: Stage }
type Refresh = Current | ProbingAccount | Restarting | AwaitRestart | RefreshBroken
type Startup = NoStartup | StartingUp
type RuntimeClient = { gen: int, nextId: int, refresh: Refresh, startup: Startup, requests: List[Request] }
type BridgeCall = CallStart | CallRestart | Send({ request: int, over: Route })
type ClientStep = { state: RuntimeClient, out: List[BridgeCall] }
pure val initial: RuntimeClient = { gen: 0, nextId: 0, refresh: Current, startup: NoStartup, requests: List() }
pure val reportValues = Set(Unavailable, Available({ phase: Stopped }), Available({ phase: Starting }), Available({ phase: Running }))
pure val fallbackValues = Set(NoFallback, HttpFallback)
pure val ofGenValues = Set(0, 1, 2)
pure val idValues = Set(0, 1, 2)
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

Any other path is refused before it is numbered or sent, so a
protocol-relative path never reaches another host.

```quint
pure def canSubmit(c: RuntimeClient, path: PathShape): bool = path == Rooted
pure def submit(c: RuntimeClient, path: PathShape): RuntimeClient = {
  val first = if (refreshing(c.refresh)) AwaitRefresh else if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing
  { ...c, nextId: c.nextId + 1, requests: c.requests.append({ id: c.nextId, gen: c.gen, stage: first }) }
}
pure val pathValues = Set(Rooted, Unrooted)
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
request only settles. A bridge probe or call settles by the bridge's own
contract (one answer or one failure, `Restarted` included); an HTTP call
fails after `requestTimeoutMs`, and an answer whose body is not JSON fails as
`TransportFailed` and is not published.

```quint
pure def canTransportFailed(c: RuntimeClient, id: int): bool = own(c, id) and (stageIs(c, id, Probing) or sentNow(c, id))
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
  out.every(o => firstSend(before, o)) and before.requests.every(r => isSent(r.stage) implies after.requests.every(q => q.id == r.id implies (q.stage == r.stage or not(isWaiting(q.stage)))))
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

A 2xx answer is the reply. The refusal error also carries the body's `error`
and `code` strings, which the shell keeps and the machine does not see; a
`retryAfter` that is not a whole number is dropped by the shell.

```quint
pure def admitAdvice(httpStatus: int, retry: RetryAdvice): RetryAdvice = match retry {
  | RetryAfter(r) => if (httpStatus == 429 and r.seconds >= 0 and r.seconds <= maxSafeInteger) RetryAfter({ seconds: r.seconds }) else NoAdvice
  | NoAdvice => NoAdvice
}
pure def answerOf(s: Stage, httpStatus: int, retry: RetryAdvice): Stage = match s {
  | Sent(x) => if (httpStatus >= 200 and httpStatus < 300) Replied({ servedBy: x.route }) else Refused({ httpStatus: httpStatus, retry: admitAdvice(httpStatus, retry) })
  | _ => s
}
pure def canReply(c: RuntimeClient, id: int): bool = own(c, id) and sentNow(c, id)
pure def reply(c: RuntimeClient, id: int, httpStatus: int, retry: RetryAdvice): RuntimeClient =
  { ...c, requests: c.requests.listMap(r => if (r.id == id) { ...r, stage: answerOf(r.stage, httpStatus, retry) } else r) }
pure val httpStatusValues = Set(200, 409, 429, 503)
pure val retryValues = Set(NoAdvice, RetryAfter({ seconds: -1 }), RetryAfter({ seconds: 0 }), RetryAfter({ seconds: 30 }), RetryAfter({ seconds: 9007199254740992 }))
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
