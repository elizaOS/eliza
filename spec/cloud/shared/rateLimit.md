# Rate limiter

One fixed-window counter for every limited route. The store holds one row per
subject, limit and window; a request is admitted while its row counts fewer
than the limit, and a refusal tells the client when the window ends. Sources
are develop `packages/cloud/shared/src/lib/services/plan-request-limiter.ts`
and `packages/cloud/quint/plan_request_buckets.qnt`, and the limiter rules of
the old `spec/cloud/authService.md` and `spec/cloud/entitlements.md`. The
burst and sustained token buckets and the sliding window are replaced by this
one window, counted in the store so that every process sees the same count.

Limit values live in the spec that applies them (`requestAuth`,
`codeChallenges`, `deviceKeys`, `grantCodes`, `inference`, `speech`, `maps`;
plan request rates by class in `billing/plans`). A subject is what the
applying spec names: a client address, a credential id, or a keyed digest of
an email address or phone number, never a secret itself. The shell admits in
one statement (`INSERT … ON CONFLICT … DO UPDATE … WHERE count < limit`),
answers a refusal with `Retry-After`, and deletes ended windows on a schedule.

## Story: Refuse excess requests with a usable retry time

> As a client of the cloud, I want a request over its limit refused with the
> time its window ends, so that I wait once, for exactly as long as needed,
> and then succeed.

### A limit is a positive count of requests in a positive window, named by the spec that applies it

`perMinute` builds the common case; `name` keeps two limits with the same
numbers in separate rows.

```quint
import types.* from "./types"
type RateLimit = { name: str, limit: int, windowMs: Millis }
pure def validLimit(rule: RateLimit): bool = rule.limit >= 1 and rule.windowMs >= 1
pure def perMinute(name: str, limit: int): RateLimit = { name: name, limit: limit, windowMs: millisPerMinute }
pure def perWindow(name: str, limit: int, windowMs: Millis): RateLimit = { name: name, limit: limit, windowMs: windowMs }
```

### A request falls in the window from the last multiple of its length up to the next

The window of `now` is `[floor(now / w) × w, floor(now / w) × w + w)`. Times
are epoch milliseconds, so never negative.

```quint
pure def windowStartOf(now: Millis, windowMs: Millis): Millis = if (windowMs >= 1) (now / windowMs) * windowMs else now
pure def windowEndOf(now: Millis, windowMs: Millis): Millis = windowStartOf(now, windowMs) + windowMs
pure def lawRequestLiesInItsWindow(now: Millis, windowMs: Millis): bool =
  (now >= 0 and windowMs >= 1) implies (windowStartOf(now, windowMs) <= now and now < windowEndOf(now, windowMs))
pure val windowMsValues = Set(1, 3, 5, 60000)
pure val nowValues = Set(0, 1, 2, 3, 4, 7)
```

### The end of a window is the start of the next one, so a retry at that time meets an empty window

This is what makes `retryAt` usable: the retried request counts in a row that
does not exist yet.

```quint
pure def lawWindowEndOpensTheNextWindow(now: Millis, windowMs: Millis): bool =
  (now >= 0 and windowMs >= 1) implies windowStartOf(windowEndOf(now, windowMs), windowMs) == windowEndOf(now, windowMs)
```

### A request is admitted exactly when its window holds fewer requests than the limit, and a refusal records nothing

Admission and counting are one step: the admitted request adds one to its
row, creating the row at one; a refused request leaves every row as it was
and answers the end of its window as `retryAt`.

```quint
type WindowRow = { subject: str, rule: RateLimit, start: Millis, count: int }
type RateDecision = NoDecision | Admitted | Refused({ retryAt: Millis }) | Unavailable
type RateWindows = { rows: List[WindowRow], clock: Millis, last: RateDecision }
pure val initial: RateWindows = { rows: List(), clock: 0, last: NoDecision }
pure def sameKey(r: WindowRow, subject: str, rule: RateLimit, start: Millis): bool = r.subject == subject and r.rule == rule and r.start == start
pure def countIn(rows: List[WindowRow], subject: str, rule: RateLimit, start: Millis): int = rows.foldl(0, (total, r) => if (sameKey(r, subject, rule, start)) total + r.count else total)
pure def admits(count: int, rule: RateLimit): bool = count < rule.limit
pure def canRequest(s: RateWindows, subject: str, rule: RateLimit, now: Millis): bool = subject != "" and validLimit(rule) and now >= 0
pure def request(s: RateWindows, subject: str, rule: RateLimit, now: Millis): RateWindows = {
  val start = windowStartOf(now, rule.windowMs)
  val held = s.rows.some(r => sameKey(r, subject, rule, start))
  if (admits(countIn(s.rows, subject, rule, start), rule))
    { ...s, clock: now, last: Admitted,
      rows: if (held) s.rows.listMap(r => if (sameKey(r, subject, rule, start)) { ...r, count: r.count + 1 } else r)
            else s.rows.append({ subject: subject, rule: rule, start: start, count: 1 }) }
  else { ...s, clock: now, last: Refused({ retryAt: start + rule.windowMs }) }
}
pure val subjectValues = Set("203.0.113.7", "credential-1")
pure val ruleValues = Set({ name: "perMinute", limit: 2, windowMs: 3 }, { name: "perHour", limit: 1, windowMs: 5 })
pure def stepRefusalRecordsNothing(before: RateWindows, via: str, after: RateWindows): bool =
  (via == "request" and after.last != Admitted) implies after.rows == before.rows
pure def sometimesAdmitted(s: RateWindows): bool = s.last == Admitted
```

### A window never counts more requests than its limit, and a subject has one row per limit and window

The row is the one place a window's count lives, so two concurrent requests
can never both take the last place.

```quint
pure def rowWellFormed(r: WindowRow): bool = r.subject != "" and validLimit(r.rule) and r.start >= 0 and r.count >= 1 and r.count <= r.rule.limit
pure def alwaysWindowsStayWithinTheirLimit(s: RateWindows): bool = s.rows.every(r => rowWellFormed(r))
pure def alwaysOneRowPerSubjectLimitAndWindow(s: RateWindows): bool =
  s.rows.every(r => s.rows.select(x => sameKey(x, r.subject, r.rule, r.start)).length() == 1)
```

### A refusal happens only at a full window and names a retry time after the request

```quint
pure def stepRefusalOnlyAtAFullWindow(before: RateWindows, via: str, after: RateWindows): bool = {
  val d = after.last
  via == "request" implies match d {
    | Refused(x) => x.retryAt > after.clock and before.rows.some(r => r.count == r.rule.limit and r.start <= after.clock and r.start + r.rule.windowMs == x.retryAt)
    | _ => true
  }
}
pure def sometimesRefusedUntilTheWindowEnds(s: RateWindows): bool = {
  val d = s.last
  match d { | Refused(x) => x.retryAt > s.clock | _ => false }
}
pure def sometimesAdmittedAgainInALaterWindow(s: RateWindows): bool =
  s.rows.some(a => a.count == a.rule.limit and s.rows.some(b => b.subject == a.subject and b.rule == a.rule and b.start > a.start))
```

### A refused request answers 429 rate_limited with retryAt at the end of its window

```quint
pure def rateLimitedRefusal(retryAt: Millis): Refusal = refuseUntil(RateLimited, retryAt)
pure def lawRateLimitedIsRetryableWithATime(retryAt: Millis): bool = {
  val r = rateLimitedRefusal(retryAt)
  wellFormed(r) and statusOf(r.code) == 429 and isRetryable(r.code)
}
```

### Only windows that have ended are swept

Sweeping keeps every row whose window is still open at the sweep time, so it
never gives a subject back requests it already spent.

```quint
pure def canSweep(s: RateWindows, now: Millis): bool = now >= 0
pure def sweep(s: RateWindows, now: Millis): RateWindows = { ...s, clock: now, rows: s.rows.select(r => r.start + r.rule.windowMs > now) }
pure def stepSweepRemovesOnlyEndedWindows(before: RateWindows, via: str, after: RateWindows): bool =
  via == "sweep" implies (after.rows.every(r => before.rows.includes(r)) and before.rows.every(r => r.start + r.rule.windowMs <= after.clock or after.rows.includes(r)))
```

## Story: Refuse rather than guess when the limiter cannot count

> As an operator, I want a request refused when the limiter's store cannot be
> read or written, so that an outage never lifts every limit at once.

### A store failure refuses the request with 503 rate_limit_unavailable and counts nothing

The develop limiter admitted from memory when it could not decide; this one
fails closed. The refusal is retryable and carries no time.

```quint
pure def canStoreUnavailable(s: RateWindows, now: Millis): bool = now >= 0
pure def storeUnavailable(s: RateWindows, now: Millis): RateWindows = { ...s, clock: now, last: Unavailable }
pure val unavailableRefusal: Refusal = refuse(RateLimitUnavailable)
pure def stepStoreFailureCountsNothing(before: RateWindows, via: str, after: RateWindows): bool =
  via == "storeUnavailable" implies (after.rows == before.rows and after.last == Unavailable)
pure def sometimesStoreUnavailable(s: RateWindows): bool = s.last == Unavailable
```

### A limiter refusal is always retryable, 429 with a time when the window is full and 503 when the store failed

`refusalOf` is the answer the shell renders for a decision that is not
`Admitted`.

```quint
pure def refusalOf(d: RateDecision): Refusal = match d { | Refused(x) => rateLimitedRefusal(x.retryAt) | _ => unavailableRefusal }
pure def isRefusal(d: RateDecision): bool = match d { | Refused(x) => true | Unavailable => true | _ => false }
pure def lawEveryLimiterRefusalIsRetryable(d: RateDecision): bool = {
  val r = refusalOf(d)
  isRefusal(d) implies (wellFormed(r) and isRetryable(r.code) and (d == Unavailable iff statusOf(r.code) == 503))
}
pure val dValues = Set(NoDecision, Admitted, Unavailable, Refused({ retryAt: 3 }))
```
