# Runtime client

The request client a screen uses to call the agent of the account signed in
now. The device bridge is preferred; plain HTTP serves only when no bridge is
available. Each account refresh starts a new generation, and a request
belongs to the generation in which it was submitted. The client adds no
credentials, retries or replays: the shell sends each request at most once,
over the route this machine names in its output.

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
type BodyLimit = LimitUnknown | Limit({ units: int })
type Failure = AccountChanged | RefreshFailed | StartupFailed | TransportFailed
type RetryAdvice = NoAdvice | RetryAfter({ seconds: int })
type Stage = NoRequest | AwaitRefresh | Probing | AwaitStartup | Sent({ route: Route }) | Replied({ servedBy: Route }) | Refused({ httpStatus: int, retry: RetryAdvice }) | Failed({ why: Failure })
type Request = { gen: int, stage: Stage }
type Refresh = Current | ProbingAccount | Restarting | AwaitRestart | RefreshBroken
type Startup = NoStartup | StartingUp
type RuntimeClient = { gen: int, refresh: Refresh, startup: Startup, limit: BodyLimit, request: Request }
type BridgeCall = CallStart | CallRestart | Send({ over: Route })
type ClientStep = { state: RuntimeClient, out: List[BridgeCall] }
pure val initial: RuntimeClient = { gen: 0, refresh: Current, startup: NoStartup, limit: LimitUnknown, request: { gen: 0, stage: NoRequest } }
pure def emit(out: List[BridgeCall], c: RuntimeClient): ClientStep = { state: c, out: out }
pure def limitOf(report: StatusReport): BodyLimit = match report {
  | Available(a) => if (a.requestBodyLimit > 0) Limit({ units: a.requestBodyLimit }) else LimitUnknown
  | Unavailable => LimitUnknown
}
pure def ensureCalls(phase: RuntimePhase, c: RuntimeClient): List[BridgeCall] = if (c.startup == NoStartup and phase == Stopped) List(CallStart) else List()
pure def refreshAccount(c: RuntimeClient): RuntimeClient = { ...c, gen: c.gen + 1, refresh: ProbingAccount, startup: NoStartup }
pure def canRefreshStatus(c: RuntimeClient, report: StatusReport): bool = c.refresh == ProbingAccount
pure def refreshStatus(c: RuntimeClient, report: StatusReport): ClientStep = {
  val seen = { ...c, limit: limitOf(report) }
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
pure def sometimesReplyAfterRefresh(c: RuntimeClient): bool =
  c.gen >= 1 and c.refresh == Current and c.request.gen == c.gen and c.request.stage == Replied({ servedBy: Bridge })
```

### A request waits for its generation's refresh, and a broken refresh refuses it

Only one request is in flight at a time in this model. A request submitted
while its generation's refresh runs waits for it; when the refresh is
broken, every request of that generation fails until the next refresh.

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
pure def own(c: RuntimeClient): bool = c.request.gen == c.gen
pure def canSubmit(c: RuntimeClient): bool = not(isWaiting(c.request.stage))
pure def submit(c: RuntimeClient): RuntimeClient =
  { ...c, request: { gen: c.gen, stage: if (refreshing(c.refresh)) AwaitRefresh else if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing } }
pure def canResume(c: RuntimeClient): bool = own(c) and c.request.stage == AwaitRefresh and not(refreshing(c.refresh))
pure def resume(c: RuntimeClient): RuntimeClient =
  { ...c, request: { ...c.request, stage: if (c.refresh == RefreshBroken) Failed({ why: RefreshFailed }) else Probing } }
pure def stepBrokenRefreshRefuses(before: RuntimeClient, after: RuntimeClient): bool =
  (after.request.stage == Probing and before.request.stage != Probing) implies after.refresh == Current
pure def sometimesBrokenRefreshRefused(c: RuntimeClient): bool = c.request.stage == Failed({ why: RefreshFailed })
```

### A request dispatches and publishes only in its own generation

A request of an older generation fails as changed instead of being sent, and
its reply, if one comes, is never published.

```quint
pure def canAbandon(c: RuntimeClient): bool = not(own(c)) and isWaiting(c.request.stage)
pure def abandon(c: RuntimeClient): RuntimeClient = { ...c, request: { ...c.request, stage: Failed({ why: AccountChanged }) } }
pure def sends(out: List[BridgeCall]): bool = out.includes(Send({ over: Bridge })) or out.includes(Send({ over: Http }))
pure def isAnswered(s: Stage): bool = match s {
  | Replied(x) => true
  | Refused(x) => true
  | _ => false
}
pure def alwaysGenerationsAreIssued(c: RuntimeClient): bool = c.request.gen >= 0 and c.request.gen <= c.gen
pure def stepSendOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  sends(out) implies (own(after) and isSent(after.request.stage))
pure def stepPublishOnlyInOwnGeneration(before: RuntimeClient, after: RuntimeClient): bool =
  (isAnswered(after.request.stage) and not(isAnswered(before.request.stage))) implies own(before)
pure def sometimesChangedAccountFailsRequest(c: RuntimeClient): bool = c.request.stage == Failed({ why: AccountChanged })
```

## Story: Reach a runtime that is not running yet

> As a user, I want my request to wait while the agent starts, so that I do
> not have to retry by hand, and never to be sent twice.

### A request to a runtime that is not running waits for one shared startup

A status of stopped calls `start()`; a status of starting only waits. A
request or refresh that finds a startup of its generation in progress joins
it instead of starting another. The shell polls status every `pollMs` while a
startup runs.

```quint
pure def dispatch(route: Route, c: RuntimeClient): ClientStep =
  emit(List(Send({ over: route })), { ...c, request: { ...c.request, stage: Sent({ route: route }) } })
pure def canRequestStatus(c: RuntimeClient, report: StatusReport): bool = own(c) and c.request.stage == Probing
pure def requestStatus(c: RuntimeClient, report: StatusReport): ClientStep = {
  val seen = { ...c, limit: limitOf(report) }
  match report {
    | Unavailable => dispatch(Http, seen)
    | Available(a) =>
      if (a.phase == Running) dispatch(Bridge, seen)
      else emit(ensureCalls(a.phase, c), { ...seen, startup: StartingUp, request: { ...c.request, stage: AwaitStartup } })
  }
}
pure val reportValues = Set(Unavailable, Available({ phase: Stopped, requestBodyLimit: 2097152 }), Available({ phase: Starting, requestBodyLimit: 2097152 }), Available({ phase: Running, requestBodyLimit: 2097152 }), Available({ phase: Running, requestBodyLimit: 0 }))
pure def stepStartOnlyWithoutStartup(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(CallStart) implies (before.startup == NoStartup and after.startup == StartingUp)
pure def alwaysWaitersHaveAStartup(c: RuntimeClient): bool =
  ((own(c) and c.request.stage == AwaitStartup) or c.refresh == AwaitRestart) implies c.startup == StartingUp
pure def sometimesSharedStartup(c: RuntimeClient): bool = own(c) and c.request.stage == AwaitStartup and c.refresh == AwaitRestart
```

### A startup ends when the runtime reports running or stopped, or its deadline passes

Running sends each waiting request over the bridge and completes a waiting
refresh. A stopped report, or the deadline `startupTimeoutMs` after the
startup began, fails both.

```quint
pure def settleStartup(ok: bool, c: RuntimeClient): ClientStep = {
  val done = { ...c, startup: NoStartup, refresh: if (c.refresh == AwaitRestart) (if (ok) Current else RefreshBroken) else c.refresh }
  if (own(c) and c.request.stage == AwaitStartup)
    (if (ok) dispatch(Bridge, done) else emit(List(), { ...done, request: { ...c.request, stage: Failed({ why: StartupFailed }) } }))
  else emit(List(), done)
}
pure def canStartupSettled(c: RuntimeClient, phase: RuntimePhase): bool = c.startup == StartingUp and phase != Starting
pure def startupSettled(c: RuntimeClient, phase: RuntimePhase): ClientStep = settleStartup(phase == Running, c)
pure def canStartupExpired(c: RuntimeClient): bool = c.startup == StartingUp
pure def startupExpired(c: RuntimeClient): ClientStep = settleStartup(false, c)
pure def sometimesStartupFailed(c: RuntimeClient): bool = c.request.stage == Failed({ why: StartupFailed })
```

### An available bridge owns the request, and nothing is sent twice

HTTP serves a request only when its first status probe found no bridge; a
request that waited for the bridge's startup goes over the bridge or fails.
A sent request only settles: no reply, failure or refusal sends it again.

```quint
pure def canTransportFailed(c: RuntimeClient): bool = own(c) and (c.request.stage == Probing or isSent(c.request.stage))
pure def transportFailed(c: RuntimeClient): RuntimeClient = { ...c, request: { ...c.request, stage: Failed({ why: TransportFailed }) } }
pure def stepHttpOnlyWithoutBridge(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  out.includes(Send({ over: Http })) implies before.request.stage == Probing
pure def stepSentIsNeverResent(before: RuntimeClient, after: RuntimeClient, out: List[BridgeCall]): bool =
  isSent(before.request.stage) implies (not(sends(out)) and (after.request == before.request or not(isWaiting(after.request.stage))))
pure def sometimesHttpServed(c: RuntimeClient): bool = c.request.stage == Replied({ servedBy: Http })
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
pure def leadsToRequestSettles(c: RuntimeClient, later: RuntimeClient): bool = isWaiting(c.request.stage) implies not(isWaiting(later.request.stage))
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
pure def canReply(c: RuntimeClient, httpStatus: int, retry: RetryAdvice): bool = own(c) and isSent(c.request.stage)
pure def reply(c: RuntimeClient, httpStatus: int, retry: RetryAdvice): RuntimeClient =
  { ...c, request: { ...c.request, stage: if (httpStatus >= 200 and httpStatus < 300) Replied({ servedBy: routeOf(c.request.stage) }) else Refused({ httpStatus: httpStatus, retry: admitAdvice(httpStatus, retry) }) } }
pure val httpStatusValues = Set(200, 409, 429, 503)
pure val retryValues = Set(NoAdvice, RetryAfter({ seconds: -1 }), RetryAfter({ seconds: 0 }), RetryAfter({ seconds: 30 }))
pure def adviceFits(httpStatus: int, retry: RetryAdvice): bool = match retry {
  | RetryAfter(r) => httpStatus == 429 and r.seconds >= 0
  | NoAdvice => true
}
pure def alwaysRefusalAdviceOnlyOn429(c: RuntimeClient): bool = {
  val s = c.request.stage
  match s {
    | Refused(x) => (x.httpStatus < 200 or x.httpStatus >= 300) and adviceFits(x.httpStatus, x.retry)
    | _ => true
  }
}
pure def sometimesRefusedWithAdvice(c: RuntimeClient): bool = c.request.stage == Refused({ httpStatus: 429, retry: RetryAfter({ seconds: 30 }) })
```

### A known request body limit is positive and comes from an available runtime

Each status the client reads sets the limit: the bridge's positive
`requestBodyLimit` when available, unknown otherwise. A screen sizes what it
sends by it.

```quint
pure def alwaysKnownLimitIsPositive(c: RuntimeClient): bool = {
  val known = c.limit
  match known {
    | Limit(l) => l.units > 0
    | LimitUnknown => true
  }
}
pure def sometimesLimitKnown(c: RuntimeClient): bool = c.limit == Limit({ units: 2097152 })
```
