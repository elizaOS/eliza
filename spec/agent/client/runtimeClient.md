# Runtime client

The request client a screen uses to call the agent of the account signed in
now. The device bridge is preferred; plain HTTP serves only when no bridge is
available. Each account refresh starts a new generation, and a request
belongs to the generation in which it was submitted. The client adds no
credentials, retries or replays: the shell sends each request at most once,
over the route this machine names in its output, and keeps the path, body,
timers and messages.

## Story: Call the runtime for my current account

> As a user, I want my requests to go to the agent of the account I am signed
> in to now, so that a reply meant for an earlier account is never shown to me.

### An account refresh starts a new generation and restarts an available runtime

A refresh asks the bridge for its status. With no bridge available it is
done. Otherwise it restarts the runtime and, if the restart does not report
it running, waits for its startup. A bridge error or the refresh deadline
breaks the refresh. A newer refresh abandons an older one and its startup.

```quint
type Route = Bridge | Http
type RuntimePhase = Stopped | Starting | Running
type StatusReport = Unavailable | Available({ phase: RuntimePhase, requestBodyLimit: int })
type BodyLimit = LimitUnknown | Limit({ units: int, ofGen: int })
type Failure = AccountChanged | RefreshFailed | StartupFailed | TransportFailed
type RetryAdvice = NoAdvice | RetryAfter({ seconds: int })
type Stage = AwaitRefresh | Probing | AwaitStartup | Sent({ route: Route }) | Replied({ servedBy: Route }) | Refused({ httpStatus: int, retry: RetryAdvice }) | Failed({ why: Failure })
type Request = { id: int, gen: int, stage: Stage }
type Refresh = Current | ProbingAccount | Restarting | AwaitRestart | RefreshBroken
type Startup = NoStartup | StartingUp
type RuntimeClient = { gen: int, refresh: Refresh, startup: Startup, limit: BodyLimit, requests: List[Request] }
type BridgeCall = CallStart | CallRestart | Send({ request: int, over: Route })
type ClientStep = { state: RuntimeClient, out: List[BridgeCall] }
pure val initial: RuntimeClient = { gen: 0, refresh: Current, startup: NoStartup, limit: LimitUnknown, requests: List() }
pure val reportValues = Set(Unavailable, Available({ phase: Stopped, requestBodyLimit: 65536 }), Available({ phase: Starting, requestBodyLimit: 65536 }), Available({ phase: Running, requestBodyLimit: 65536 }), Available({ phase: Running, requestBodyLimit: 0 }))
pure val idValues = Set(1, 2)
pure def emit(out: List[BridgeCall], c: RuntimeClient): ClientStep = { state: c, out: out }
pure def limitOf(report: StatusReport, gen: int): BodyLimit = match report {
  | Available(a) => if (a.requestBodyLimit > 0) Limit({ units: a.requestBodyLimit, ofGen: gen }) else LimitUnknown
  | Unavailable => LimitUnknown
}
pure def ensureCalls(phase: RuntimePhase, c: RuntimeClient): List[BridgeCall] = if (c.startup == NoStartup and phase == Stopped) List(CallStart) else List()
pure def refreshAccount(c: RuntimeClient): RuntimeClient = { ...c, gen: c.gen + 1, refresh: ProbingAccount, startup: NoStartup, limit: LimitUnknown }
pure def canRefreshStatus(c: RuntimeClient, report: StatusReport): bool = c.refresh == ProbingAccount
pure def refreshStatus(c: RuntimeClient, report: StatusReport): ClientStep = {
  val seen = { ...c, limit: limitOf(report, c.gen) }
  match report {
    | Available(a) => emit(List(CallRestart), { ...seen, refresh: Restarting })
    | Unavailable => emit(List(), { ...seen, refresh: Current })
  }
}
pure def canRestarted(c: RuntimeClient, phase: RuntimePhase): bool = c.refresh == Restarting
pure def restarted(c: RuntimeClient, phase: RuntimePhase): ClientStep =
  if (phase == Running) emit(List(), { ...c, refresh: Current })
  else emit(ensureCalls(phase, c), { ...c, refresh: AwaitRestart, startup: StartingUp })
pure def canRefreshError(c: RuntimeClient): bool = c.refresh == ProbingAccount or c.refresh == Restarting
pure def refreshError(c: RuntimeClient): RuntimeClient = { ...c, refresh: RefreshBroken }
pure def stepGenerationsAdvanceOnlyByRefresh(before: RuntimeClient, via: str, after: RuntimeClient): bool =
  after.gen == (if (via == "refreshAccount") before.gen + 1 else before.gen)
pure def stepOnlyARefreshRestarts(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(CallRestart) implies (before.refresh == ProbingAccount and after.refresh == Restarting)
pure def sometimesRefreshWaitsForStartup(c: RuntimeClient): bool = c.gen >= 1 and c.refresh == AwaitRestart
```

### A request waits for its generation's refresh, and a broken refresh fails it

A request submitted while its generation's refresh runs waits for it; when
the refresh is broken, every request of that generation fails until the next
refresh.

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
pure def refreshing(r: Refresh): bool = r == ProbingAccount or r == Restarting or r == AwaitRestart
pure def stageOf(c: RuntimeClient, id: int): Stage = c.requests.select(r => r.id == id).nthOr(0, { id: id, gen: -1, stage: Failed({ why: AccountChanged }) }).stage
pure def own(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and r.gen == c.gen)
pure def setStage(c: RuntimeClient, id: int, s: Stage): List[Request] = c.requests.listMap(r => if (r.id == id) { ...r, stage: s } else r)
pure def canSubmit(c: RuntimeClient, id: int): bool = not(isWaiting(stageOf(c, id)))
pure def submit(c: RuntimeClient, id: int): RuntimeClient = {
  val first = if (refreshing(c.refresh)) AwaitRefresh else if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing
  { ...c, requests: c.requests.select(r => r.id != id).append({ id: id, gen: c.gen, stage: first }) }
}
pure def canResume(c: RuntimeClient, id: int): bool = own(c, id) and stageOf(c, id) == AwaitRefresh and not(refreshing(c.refresh))
pure def resume(c: RuntimeClient, id: int): RuntimeClient =
  { ...c, requests: setStage(c, id, if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing) }
pure def alwaysOneRequestPerId(c: RuntimeClient): bool =
  c.requests.every(r => c.requests.select(q => q.id == r.id).length() == 1)
pure def stepProbeOnlyAfterACurrentRefresh(before: RuntimeClient, after: RuntimeClient): bool =
  after.requests.every(r => (r.stage == Probing and stageOf(before, r.id) != Probing) implies after.refresh == Current)
pure def sometimesBrokenRefreshRefused(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: RefreshFailed }))
```

### A request dispatches and publishes only in its own generation

A waiting request of an older generation fails as changed instead of being
sent, and its reply, if one comes, is never published.

```quint
pure def canAbandon(c: RuntimeClient, id: int): bool = c.requests.some(r => r.id == id and r.gen != c.gen and isWaiting(r.stage))
pure def abandon(c: RuntimeClient, id: int): RuntimeClient = { ...c, requests: setStage(c, id, Failed({ why: AccountChanged })) }
pure def isAnswered(s: Stage): bool = match s {
  | Replied(x) => true
  | Refused(x) => true
  | _ => false
}
pure def sentIn(after: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => own(after, x.request) and isSent(stageOf(after, x.request))
  | _ => true
}
pure def alwaysGenerationsAreIssued(c: RuntimeClient): bool = c.gen >= 0 and c.requests.every(r => r.gen >= 0 and r.gen <= c.gen)
pure def stepSendOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => sentIn(after, o))
pure def stepPublishOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient): bool =
  after.requests.every(r => (isAnswered(r.stage) and not(isAnswered(stageOf(before, r.id)))) implies r.gen == before.gen)
pure def sometimesChangedAccountFailsRequest(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: AccountChanged }))
pure def sometimesReplyAfterRefresh(c: RuntimeClient): bool =
  c.gen >= 1 and c.requests.some(r => r.gen == c.gen and r.stage == Replied({ servedBy: Bridge }))
```

## Story: Reach a runtime that is not running yet

> As a user, I want my request to wait while the agent starts, so that I do
> not have to retry by hand, and never to be sent twice.

### Requests to a runtime that is not running wait for one shared startup

A status of stopped calls `start()`; a status of starting only waits. A
request or refresh that finds a startup of its generation in progress joins
it instead of starting another. The shell polls status every `pollMs` while a
startup runs.

```quint
pure def dispatch(id: int, route: Route, c: RuntimeClient): ClientStep =
  emit(List(Send({ request: id, over: route })), { ...c, requests: setStage(c, id, Sent({ route: route })) })
pure def canRequestStatus(c: RuntimeClient, id: int, report: StatusReport): bool = own(c, id) and stageOf(c, id) == Probing
pure def requestStatus(c: RuntimeClient, id: int, report: StatusReport): ClientStep = {
  val seen = { ...c, limit: limitOf(report, c.gen) }
  match report {
    | Unavailable => dispatch(id, Http, seen)
    | Available(a) =>
      if (a.phase == Running) dispatch(id, Bridge, seen)
      else emit(ensureCalls(a.phase, c), { ...seen, startup: StartingUp, requests: setStage(c, id, AwaitStartup) })
  }
}
pure def awaitsStartup(c: RuntimeClient, r: Request): bool = r.gen == c.gen and r.stage == AwaitStartup
pure def stepStartOnlyWithoutStartup(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(CallStart) implies (before.startup == NoStartup and after.startup == StartingUp)
pure def alwaysWaitersHaveAStartup(c: RuntimeClient): bool =
  (c.requests.some(r => awaitsStartup(c, r)) or c.refresh == AwaitRestart) implies c.startup == StartingUp
pure def sometimesSharedStartup(c: RuntimeClient): bool = c.requests.select(r => awaitsStartup(c, r)).length() >= 2
```

### A startup ends when the runtime reports running or stopped, or its deadline passes

Running sends each waiting request of the generation over the bridge and
completes a waiting refresh. A stopped report, or the deadline
`startupTimeoutMs` after the startup began, fails them all.

```quint
pure def settleStartup(ok: bool, c: RuntimeClient): ClientStep = {
  val outcome = c.requests.listMap(r => if (awaitsStartup(c, r)) { ...r, stage: if (ok) Sent({ route: Bridge }) else Failed({ why: StartupFailed }) } else r)
  val sends = c.requests.foldl(List(), (acc, r) => if (ok and awaitsStartup(c, r)) acc.append(Send({ request: r.id, over: Bridge })) else acc)
  emit(sends, { ...c, startup: NoStartup, requests: outcome, refresh: if (c.refresh == AwaitRestart) (if (ok) Current else RefreshBroken) else c.refresh })
}
pure def canStartupSettled(c: RuntimeClient, phase: RuntimePhase): bool = c.startup == StartingUp and phase != Starting
pure def startupSettled(c: RuntimeClient, phase: RuntimePhase): ClientStep = settleStartup(phase == Running, c)
pure def canStartupExpired(c: RuntimeClient): bool = c.startup == StartingUp
pure def startupExpired(c: RuntimeClient): ClientStep = settleStartup(false, c)
pure def sometimesStartupFailed(c: RuntimeClient): bool = c.requests.some(r => r.stage == Failed({ why: StartupFailed }))
```

### An available bridge owns the request, and nothing is sent twice

HTTP serves a request only when its own status probe found no bridge; a
request that waited for the bridge's startup goes over the bridge or fails.
A sent request only settles: no reply, failure or refusal sends it again.

```quint
pure def canTransportFailed(c: RuntimeClient, id: int): bool = own(c, id) and (stageOf(c, id) == Probing or isSent(stageOf(c, id)))
pure def transportFailed(c: RuntimeClient, id: int): RuntimeClient = { ...c, requests: setStage(c, id, Failed({ why: TransportFailed })) }
pure def httpAfterProbe(before: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => x.over == Http implies stageOf(before, x.request) == Probing
  | _ => true
}
pure def firstSend(before: RuntimeClient, call: BridgeCall): bool = match call {
  | Send(x) => not(isSent(stageOf(before, x.request)))
  | _ => true
}
pure def stepHttpOnlyWithoutBridge(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => httpAfterProbe(before, o))
pure def stepSentIsNeverResent(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.every(o => firstSend(before, o)) and before.requests.every(r => isSent(r.stage) implies (stageOf(after, r.id) == r.stage or not(isWaiting(stageOf(after, r.id)))))
pure def sometimesHttpServed(c: RuntimeClient): bool = c.requests.some(r => r.stage == Replied({ servedBy: Http }))
```

### Every submitted request settles

Assuming each bridge or HTTP call answers or fails, and each deadline
passes, a request never waits for ever.

```quint
pure val fair_transportFailed = "weak"
pure val fair_startupExpired = "weak"
pure val fair_refreshError = "weak"
pure val fair_resume = "weak"
pure val fair_abandon = "weak"
pure def leadsToRequestSettles(c: RuntimeClient, later: RuntimeClient): bool =
  c.requests.every(r => isWaiting(r.stage) implies not(isWaiting(stageOf(later, r.id))))
```

## Story: Understand why the runtime refused

> As a user, I want a refusal to say what the runtime said, so that the screen
> can tell me whether and when to try again.

### A refusal keeps its HTTP status, and retry advice only from a 429

A 2xx answer is the reply. Any other status is a refusal that keeps the
status and the body's error and code strings; its `retryAfter` seconds are
kept only on a 429 and only when not negative.

```quint
pure def admitAdvice(httpStatus: int, retry: RetryAdvice): RetryAdvice = match retry {
  | RetryAfter(r) => if (httpStatus == 429 and r.seconds >= 0) RetryAfter({ seconds: r.seconds }) else NoAdvice
  | NoAdvice => NoAdvice
}
pure def routeOf(s: Stage): Route = match s {
  | Sent(x) => x.route
  | _ => Http
}
pure def canReply(c: RuntimeClient, id: int, httpStatus: int, retry: RetryAdvice): bool = own(c, id) and isSent(stageOf(c, id))
pure def reply(c: RuntimeClient, id: int, httpStatus: int, retry: RetryAdvice): RuntimeClient = {
  val answer = if (httpStatus >= 200 and httpStatus < 300) Replied({ servedBy: routeOf(stageOf(c, id)) }) else Refused({ httpStatus: httpStatus, retry: admitAdvice(httpStatus, retry) })
  { ...c, requests: setStage(c, id, answer) }
}
pure val httpStatusValues = Set(200, 409, 429, 503)
pure val retryValues = Set(NoAdvice, RetryAfter({ seconds: -1 }), RetryAfter({ seconds: 0 }), RetryAfter({ seconds: 30 }))
pure def adviceAdmitted(httpStatus: int, retry: RetryAdvice): bool = match retry {
  | RetryAfter(r) => httpStatus == 429 and r.seconds >= 0
  | NoAdvice => true
}
pure def adviceFits(s: Stage): bool = match s {
  | Refused(x) => (x.httpStatus < 200 or x.httpStatus >= 300) and adviceAdmitted(x.httpStatus, x.retry)
  | _ => true
}
pure def alwaysRefusalAdviceOnlyOn429(c: RuntimeClient): bool = c.requests.every(r => adviceFits(r.stage))
pure def sometimesRefusedWithAdvice(c: RuntimeClient): bool = c.requests.some(r => r.stage == Refused({ httpStatus: 429, retry: RetryAfter({ seconds: 30 }) }))
```

### A known request body limit is positive and was reported in the current generation

Each status the client reads sets the limit: the bridge's positive
`requestBodyLimit` when available, unknown otherwise. An account refresh
forgets it. A screen sizes what it sends by it.

```quint
pure def alwaysKnownLimitIsCurrent(c: RuntimeClient): bool = {
  val known = c.limit
  match known {
    | Limit(l) => l.units > 0 and l.ofGen == c.gen
    | LimitUnknown => true
  }
}
pure def sometimesLimitKnown(c: RuntimeClient): bool = c.limit == Limit({ units: 65536, ofGen: c.gen })
```
