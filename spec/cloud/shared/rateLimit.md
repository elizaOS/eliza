# Rate limiter

One fixed-window counter for every limited route, counted in the store so
that every process sees the same count. The spec that applies a limit gives
its name and values (plan request rates by class in `billing/plans`) and the
subject: a client address, an organization id, a credential id, a keyed
digest of a presented credential, email address or phone number, or a fixed
deployment-wide subject for a global budget; never a secret itself. The shell
keeps one `Window` per subject and limit name, and a limit name always has
the same window length. It runs every check of one request in one store
transaction, takes `now` from the store's clock in that transaction, and
writes each window with one conditional upsert, so two concurrent requests
never both take the last place.

## Story: Refuse excess requests with a usable retry time

> As a client of the cloud, I want a request over its limit refused with the
> time its window ends, so that I wait once, for exactly as long as needed,
> and then succeed.

### A limit is a positive count of requests in a positive window, named by the spec that applies it

```quint
import types.* from "./types"
type RateLimit = { name: str, limit: int, windowMs: Millis }
pure def validLimit(rule: RateLimit): bool = rule.limit >= 1 and rule.windowMs >= 1
pure def perMinute(name: str, limit: int): RateLimit = { name: name, limit: limit, windowMs: millisPerMinute }
pure def perWindow(name: str, limit: int, windowMs: Millis): RateLimit = { name: name, limit: limit, windowMs: windowMs }
```

### A request falls in the window from the last multiple of its length up to the next

```quint
pure def windowStartOf(now: Millis, windowMs: Millis): Millis = if (windowMs >= 1) now - now % windowMs else now
pure def windowEndOf(now: Millis, windowMs: Millis): Millis = windowStartOf(now, windowMs) + windowMs
pure def lawRequestLiesInItsWindow(now: Millis, windowMs: Millis): bool =
  (now >= 0 and windowMs >= 1) implies (windowStartOf(now, windowMs) <= now and now < windowEndOf(now, windowMs))
pure val windowMsValues = Set(1, 3, 5, 60000)
```

### A request is admitted exactly when its window holds fewer requests than the limit, and a refusal records nothing

A request outside the stored window opens a new one at count zero. The
limit is passed in at each request, so a plan change takes effect in the
current window; `ceiling` is the limit of the last admission.

```quint
type RateDecision = NoDecision | Admitted | Refused({ limit: int, retryAt: Millis })
type Window = { start: Millis, end: Millis, count: int, ceiling: int, clock: Millis, last: RateDecision }
pure val initial: Window = { start: 0, end: 0, count: 0, ceiling: 0, clock: 0, last: NoDecision }
pure def admits(count: int, rule: RateLimit): bool = count < rule.limit
pure def canRequest(w: Window, rule: RateLimit, now: Millis): bool = validLimit(rule) and now >= w.clock
pure def request(w: Window, rule: RateLimit, now: Millis): Window = {
  val inWindow = w.start <= now and now < w.end
  val held = if (inWindow) w.count else 0
  if (admits(held, rule))
    { start: if (inWindow) w.start else windowStartOf(now, rule.windowMs), end: if (inWindow) w.end else windowEndOf(now, rule.windowMs),
      count: held + 1, ceiling: rule.limit, clock: now, last: Admitted }
  else { ...w, clock: now, last: Refused({ limit: rule.limit, retryAt: w.end }) }
}
pure val ruleValues = Set(perWindow("perMinute", 2, 3), perWindow("perMinute", 1, 3), perWindow("perHour", 1, 5))
pure val nowValues = Set(0, 1, 2, 3, 5, 7)
pure def stepRefusalRecordsNothing(before: Window, via: str, after: Window): bool =
  (via == "request" and after.last != Admitted) implies { ...after, clock: before.clock, last: before.last } == before
pure def sometimesAdmitted(w: Window): bool = w.last == Admitted
```

### A window never counts more requests than the limit it last admitted under

```quint
pure def alwaysWindowsStayWithinTheirLimit(w: Window): bool = {
  val d = w.last
  w.count >= 0 and w.count <= w.ceiling and w.start <= w.clock
  and match d { | Refused(x) => x.retryAt == w.end and w.clock < w.end | _ => true }
}
```

### A refusal happens only at a full window, retries at its end, and a retry at that time is admitted

```quint
pure def stepRefusalOnlyAtAFullWindow(before: Window, via: str, after: Window): bool = {
  val d = after.last
  via == "request" implies match d {
    | Refused(x) => before.count >= x.limit and before.start <= after.clock and after.clock < x.retryAt and x.retryAt == before.end
    | _ => true
  }
}
pure def stepRetryAtTheWindowEndIsAdmitted(before: Window, via: str, after: Window): bool = {
  val d = before.last
  via == "request" implies match d { | Refused(x) => after.clock == x.retryAt implies after.last == Admitted | _ => true }
}
pure def sometimesRefusedUntilTheWindowEnds(w: Window): bool = {
  val d = w.last
  match d { | Refused(x) => x.retryAt > w.clock | _ => false }
}
```

### A window that has ended counts as no window, so the shell may delete it

```quint
pure def lawAnEndedWindowCountsAsEmpty(w: Window, rule: RateLimit, now: Millis): bool =
  (validLimit(rule) and now >= w.clock and now >= w.end) implies request(w, rule, now) == request({ ...initial, clock: w.clock }, rule, now)
pure val wValues = Set(initial, { start: 0, end: 3, count: 2, ceiling: 2, clock: 2, last: Refused({ limit: 2, retryAt: 3 }) })
```

### A request checked against several limits is counted in all of them or in none, and retries after its latest full window

```quint
type Check = { window: Window, rule: RateLimit }
pure def admitsAll(checks: List[Check], now: Millis): bool = checks.every(c => request(c.window, c.rule, now).last == Admitted)
pure def requestAll(checks: List[Check], now: Millis): List[Window] =
  if (admitsAll(checks, now)) checks.listMap(c => request(c.window, c.rule, now)) else checks.listMap(c => c.window)
pure def laterRetryAt(d: RateDecision, t: Millis): Millis = match d { | Refused(x) => if (x.retryAt > t) x.retryAt else t | _ => t }
pure def retryAtOfAll(checks: List[Check], now: Millis): Millis = checks.foldl(now, (t, c) => laterRetryAt(request(c.window, c.rule, now).last, t))
pure def lawAGroupRetriesAfterEveryFullWindow(checks: List[Check], now: Millis): bool = {
  val group = retryAtOfAll(checks, now)
  checks.every(c => laterRetryAt(request(c.window, c.rule, now).last, group) == group)
}
pure val checksValues = Set(List(), List({ window: initial, rule: perWindow("perIp", 2, 3) }),
  List({ window: { start: 0, end: 3, count: 1, ceiling: 1, clock: 1, last: Admitted }, rule: perWindow("perAddress", 1, 3) },
       { window: { start: 0, end: 5, count: 1, ceiling: 1, clock: 1, last: Admitted }, rule: perWindow("perIp", 1, 5) }))
```

## Story: Refuse rather than guess when the limiter cannot count

> As an operator, I want a request refused when the limiter's store cannot be
> read or written, so that an outage never lifts every limit at once.

### A limiter refusal is retryable: 429 at the end of a full window, or 503 a second later when the store failed

The shell fails closed and counts nothing when the store fails. It sets
`Retry-After` from the refusal's time as `types` states, rounded up.

```quint
type LimiterRefusal = WindowFull({ retryAt: Millis }) | StoreDown({ now: Millis })
pure val unavailableRetryMs: Millis = millisPerSecond
pure def unavailableRefusal(now: Millis): Refusal = refuseUntil(RateLimitUnavailable, now + unavailableRetryMs)
pure def refusalOf(r: LimiterRefusal): Refusal = match r {
  | WindowFull(x) => refuseUntil(RateLimited, x.retryAt)
  | StoreDown(x) => unavailableRefusal(x.now)
}
pure def lawEveryLimiterRefusalIsRetryable(r: LimiterRefusal): bool = {
  val answer = refusalOf(r)
  wellFormed(answer) and isRetryable(answer.code) and (statusOf(answer.code) == 503 iff match r { | StoreDown(x) => true | _ => false })
}
pure val rValues = Set(WindowFull({ retryAt: 3 }), StoreDown({ now: 1 }))
```
