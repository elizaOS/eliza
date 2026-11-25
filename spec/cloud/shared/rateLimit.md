# Rate limiter

One fixed-window counter for every limited route, counted in the store so
that every process sees the same count. The spec that applies a limit names
it, gives its values and picks the subject: a client address, an
organization id, a credential id, a keyed digest of a presented credential,
email address or phone number, or a fixed deployment-wide subject; never a
secret itself. The shell keeps one `Window` row per subject and limit name,
and a limit name always has the same window length. It runs every check of
one request in one store transaction, takes `now` from the store's clock, and
writes each row with one conditional upsert, so two concurrent requests
never both take the last place.

## Story: Refuse excess requests with a usable retry time

> As a client of the cloud, I want a request over its limit refused with the
> time its window ends, so that I know when retrying can succeed.

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

### A request is admitted exactly when its window holds fewer requests than the limit, and a refusal leaves the window and its count unchanged

A request outside the stored window opens a new one at count zero. The
limit is passed in at each request, so a plan change takes effect in the
current window; `ceiling` is the limit of the last admission. A refusal
writes only the row's clock and last decision. A request the guard refuses
(an invalid limit, or a store clock behind the row) is answered like a store
failure: `503`, nothing counted.

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
pure val ruleValues = Set(perWindow("probe", 2, 3), perWindow("probe", 1, 3), perWindow("probe", 0, 3))
pure val nowValues = Set(0, 1, 2, 3, 5, 7)
pure def sometimesALaterWindowAdmits(w: Window): bool = w.last == Admitted and w.start >= 1
```

### A window never counts more requests than the limit it last admitted under

```quint
pure def alwaysWindowsStayWithinTheirLimit(w: Window): bool = {
  val d = w.last
  w.clock >= 0 and w.count >= 0 and w.count <= w.ceiling and w.start <= w.clock
  and match d { | Refused(x) => x.retryAt == w.end and w.clock < w.end and w.count >= x.limit | _ => true }
}
```

### A refusal happens only at a full window, and the next request at or after its retry time is admitted

The first request for that subject and limit at or after `retryAt` opens a
new window. Other callers sharing the subject may fill that window first.

```quint
pure def stepRefusalOnlyAtAFullWindow(before: Window, after: Window): bool = {
  val d = after.last
  match d {
    | Refused(x) => before.count >= x.limit and { ...after, clock: before.clock, last: before.last } == before
    | _ => true
  }
}
pure def stepRetryAtTheWindowEndIsAdmitted(before: Window, after: Window): bool = {
  val d = before.last
  match d { | Refused(x) => after.clock >= x.retryAt implies after.last == Admitted | _ => true }
}
pure def sometimesRefusedUntilTheWindowEnds(w: Window): bool = {
  val d = w.last
  match d { | Refused(x) => true | _ => false }
}
```

### A window that has ended counts as no window, so the shell may delete it

```quint
pure def lawAnEndedWindowCountsAsEmpty(w: Window, rule: RateLimit, now: Millis): bool =
  (validLimit(rule) and now >= w.clock and now >= w.end) implies request(w, rule, now) == request(initial, rule, now)
pure val wValues = Set(initial, { start: 0, end: 3, count: 2, ceiling: 2, clock: 2, last: Refused({ limit: 2, retryAt: 3 }) })
```

### A request checked against several limits is counted in all of them or in none, and is told to retry when all of them admit

```quint
type Check = { window: Window, rule: RateLimit }
pure def allCountable(checks: List[Check], now: Millis): bool = checks.every(c => canRequest(c.window, c.rule, now))
pure def admitsAll(checks: List[Check], now: Millis): bool =
  allCountable(checks, now) and checks.every(c => request(c.window, c.rule, now).last == Admitted)
pure def requestAll(checks: List[Check], now: Millis): List[Window] =
  if (admitsAll(checks, now)) checks.listMap(c => request(c.window, c.rule, now)) else checks.listMap(c => c.window)
pure def laterRetryAt(d: RateDecision, t: Millis): Millis = match d { | Refused(x) => if (x.retryAt > t) x.retryAt else t | _ => t }
pure def retryAtOfAll(checks: List[Check], now: Millis): Millis = checks.foldl(now, (t, c) => laterRetryAt(request(c.window, c.rule, now).last, t))
pure def lawAGroupCountsAllOrNone(checks: List[Check], now: Millis): bool = {
  val after = requestAll(checks, now)
  after.length() == checks.length()
    and (after == checks.listMap(c => c.window) or after.every(w => w.last == Admitted and w.clock == now))
}
pure def lawAGroupRetryAtItsTimeIsAdmitted(checks: List[Check], now: Millis): bool =
  (allCountable(checks, now) and checks.every(c => alwaysWindowsStayWithinTheirLimit(c.window)) and not(admitsAll(checks, now)))
    implies admitsAll(checks, retryAtOfAll(checks, now))
pure val checksValues = Set(List(), List({ window: initial, rule: perWindow("perIp", 2, 3) }),
  List({ window: { start: 0, end: 3, count: 1, ceiling: 1, clock: 1, last: Admitted }, rule: perWindow("perAddress", 1, 3) },
       { window: { start: 0, end: 5, count: 1, ceiling: 1, clock: 1, last: Admitted }, rule: perWindow("perIp", 1, 5) }))
```

## Story: Refuse rather than guess when the limiter cannot count

> As an operator, I want a request refused when the limiter's store cannot be
> read or written, so that an outage never lifts every limit at once.

### A limiter refusal is retryable: 429 at the latest full window's end, or 503 a second later when the limiter could not count

A single limit is a group of one. The shell fails closed and counts nothing
when the store fails, or when the guard refuses (an invalid limit, or a store
clock behind a row). A 429 from the gate carries the reason
`cloud_gate_rate_limited`. It sets `Retry-After` from the refusal's time as
`types` states.

```quint
pure val unavailableRetryMs: Millis = millisPerSecond
pure def unavailableRefusal(now: Millis): Refusal = refuseUntil(RateLimitUnavailable, now + unavailableRetryMs)
pure def groupRefusal(checks: List[Check], now: Millis): Refusal =
  if (allCountable(checks, now)) { code: RateLimited, reason: CloudGateRateLimited, wait: RetryAt({ retryAtMs: retryAtOfAll(checks, now) }) }
  else unavailableRefusal(now)
pure def lawACloudGateRateLimitNamesTheGate(checks: List[Check], now: Millis): bool = {
  val answer = groupRefusal(checks, now)
  (answer.code == RateLimited) iff (answer.reason == CloudGateRateLimited)
}
pure def lawEveryLimiterRefusalIsRetryable(checks: List[Check], now: Millis): bool = {
  val answer = groupRefusal(checks, now)
  wellFormed(answer) and isRetryable(answer.code) and (statusOf(answer.code) == 503 iff not(allCountable(checks, now)))
}
```
