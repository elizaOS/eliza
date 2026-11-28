# Maps request pause

When the Maps provider refuses a request and asks the client to wait,
the client pauses its requests for that long. Only a refusal of the
current request, from the current Maps session, sets the pause.
Reopening the screen keeps the pause; leaving the Maps session for a new
one clears it. The connected provider is the
[Cloud Maps connection](./cloudConnection.md).

## Story: Back off when Maps asks me to wait

> As the owner, I want Maps to stop sending requests while the provider
> has asked it to wait, and to allow the next request when the wait is over.

### No request starts while a pause is in effect

A connected provider request may start only once the clock has reached the
end of any pause. The newest request's sequence becomes the current pending
identity. Requests already sent may still finish.

```quint
type MapRequests = { now: int, until: int, generation: int, pending: int, calls: int, lastReply: int }
pure val initial: MapRequests = { now: 0, until: 0, generation: 1, pending: 0, calls: 0, lastReply: 0 }
pure def canRequest(s: MapRequests): bool = s.now >= s.until
pure def request(s: MapRequests): MapRequests = { ...s, pending: s.calls + 1, calls: s.calls + 1 }
pure def canTick(s: MapRequests): bool = true
pure def tick(s: MapRequests): MapRequests = { ...s, now: s.now + 1 }
pure def stepNoRequestDuringPause(before: MapRequests, via: str, after: MapRequests): bool =
  via == "request" implies before.now >= before.until
pure def alwaysPendingIsLatestRequest(s: MapRequests): bool = s.calls >= 0 and (s.pending == 0 or s.pending == s.calls)
pure def sometimesResumedAfterPause(s: MapRequests): bool = s.calls >= 2 and s.until > 0 and s.pending > 0
```

### Only a refusal of the current request sets the pause

A refusal that names the current session's pending request pauses
requests for the time the provider asked and settles the request. A
refusal for a superseded request, an older session, or a request that
already settled leaves the pause and pending identity alone. A non-pausing
completion clears only its own pending identity. Reopening the screen forgets
the pending request but keeps the pause. A new session forgets both.

```quint
pure val tokenValues = Set(1, 2, 3)
pure val retryAfterValues = Set(1, 3)
pure def canRefusal(s: MapRequests, token: int, retryAfter: int): bool = retryAfter > 0
pure def refusal(s: MapRequests, token: int, retryAfter: int): MapRequests =
  if (token > 0 and s.pending == token) { ...s, until: s.now + retryAfter, pending: 0, lastReply: token }
  else { ...s, lastReply: token }
pure def canSettleRequest(s: MapRequests, token: int): bool = token > 0 and s.pending == token
pure def settleRequest(s: MapRequests, token: int): MapRequests = { ...s, pending: 0 }
pure def canReopen(s: MapRequests): bool = true
pure def reopen(s: MapRequests): MapRequests = { ...s, pending: 0 }
pure def canRetireSession(s: MapRequests): bool = true
pure def retireSession(s: MapRequests): MapRequests = { ...s, generation: s.generation + 1, until: 0, pending: 0 }
pure def stepStaleRefusalKeepsPause(before: MapRequests, via: str, after: MapRequests): bool =
  via == "refusal" and (before.pending == 0 or after.lastReply != before.pending) implies
  after.until == before.until and after.pending == before.pending
pure def stepReopenKeepsPause(before: MapRequests, via: str, after: MapRequests): bool =
  via == "reopen" implies after.until == before.until
pure def sometimesPaused(s: MapRequests): bool = s.until > s.now and s.calls == 1
```
