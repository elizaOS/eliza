# Request budgets and logs

The host's HTTP surface bounds what a request may cost. A body over the
route's cap is never handed to a handler and is never held in memory past
the cap; the rejection is flushed before the connection closes, so a peer
still uploading is not reset. Calls are admitted from a per-principal token
bucket, and a budget write that conflicts is retried a bounded number of
times. The recent API log is a small bounded buffer that keeps the newest
entries and any insufficient-credits warning still inside its lookback, so
a reply can still explain why the model refused.

## Story: Refuse what a request may not cost

> As the owner, my host refuses a request body that is too large without
> holding it in memory or cutting the connection, and it limits how often a
> caller may call it.

### A body over the cap is never dispatched, and no more than the cap is retained

The cap is two body increments. A declared length over the cap starts
discarding at once; a chunked body starts when the cap is crossed. Only
increments that arrived are retained.

```quint
type Response = NoResponse | Accepted | TooLarge
type LogEntry = { id: int, credit: bool, at: int }
type Requests = { received: int, retained: int, oversized: bool, requestDone: bool, dispatched: bool, response: Response, flushed: bool, closed: bool, peerAborted: bool, tokens: int -> int, admittedCalls: int -> int, casAttempts: int, casCommitted: bool, nextLog: int, now: int, history: List[LogEntry], buffer: List[LogEntry] }
pure val bodyCap = 2
pure val bucketSize = 2
pure val initial: Requests = { received: 0, retained: 0, oversized: false, requestDone: false, dispatched: false, response: NoResponse, flushed: false, closed: false, peerAborted: false, tokens: Map(1 -> bucketSize, 2 -> bucketSize), admittedCalls: Map(1 -> 0, 2 -> 0), casAttempts: 0, casCommitted: false, nextLog: 0, now: 0, history: List(), buffer: List() }
pure def canDeclareTooLarge(r: Requests): bool = r.received == 0 and r.response == NoResponse and not(r.closed or r.requestDone or r.oversized)
pure def declareTooLarge(r: Requests): Requests = { ...r, oversized: true }
pure def canReceiveChunk(r: Requests): bool = not(r.closed or r.requestDone)
pure def receiveChunk(r: Requests): Requests = {
  val overflow = r.oversized or r.received + 1 > bodyCap
  { ...r, received: r.received + 1, oversized: overflow, retained: if (overflow) r.retained else r.retained + 1 }
}
pure def canEndRequest(r: Requests): bool = r.received > 0 and not(r.closed or r.requestDone)
pure def endRequest(r: Requests): Requests = { ...r, requestDone: true }
pure def canDispatchBody(r: Requests): bool = r.requestDone and not(r.closed or r.oversized or r.dispatched) and r.response == NoResponse
pure def dispatchBody(r: Requests): Requests = { ...r, dispatched: true }
pure def alwaysBodyBounded(r: Requests): bool =
  r.retained >= 0 and r.retained <= r.received and r.retained <= bodyCap and (r.dispatched implies r.requestDone and not(r.oversized))
pure def sometimesChunkedOverflowRefused(r: Requests): bool = r.response == TooLarge and r.received > bodyCap and r.closed and not(r.peerAborted)
```

### A request is answered once: accepted only after dispatch, too large only when over the cap

```quint
pure def canRespondAccepted(r: Requests): bool = r.dispatched and not(r.closed) and r.response == NoResponse
pure def respondAccepted(r: Requests): Requests = { ...r, response: Accepted }
pure def canRespondTooLarge(r: Requests): bool = r.oversized and not(r.closed) and r.response == NoResponse
pure def respondTooLarge(r: Requests): Requests = { ...r, response: TooLarge }
pure def alwaysResponseMatchesRequest(r: Requests): bool =
  (r.response == TooLarge implies r.oversized) and (r.response == Accepted implies r.dispatched)
pure def stepAnsweredOnce(before: Requests, after: Requests): bool =
  before.response != NoResponse implies after.response == before.response
pure def sometimesAccepted(r: Requests): bool = r.response == Accepted and r.closed
```

### The connection closes only after the request ended and the response was flushed, unless the peer aborted

```quint
pure def canFlush(r: Requests): bool = r.response != NoResponse and not(r.closed) and not(r.flushed)
pure def flush(r: Requests): Requests = { ...r, flushed: true }
pure def canCloseConnection(r: Requests): bool = r.requestDone and r.flushed and not(r.closed)
pure def closeConnection(r: Requests): Requests = { ...r, closed: true }
pure def canPeerAbort(r: Requests): bool = not(r.closed)
pure def peerAbort(r: Requests): Requests = { ...r, closed: true, peerAborted: true }
pure def alwaysCloseAfterFlush(r: Requests): bool = (r.closed and not(r.peerAborted)) implies r.requestDone and r.flushed
pure def sometimesPeerAbortedBeforeAnswer(r: Requests): bool = r.peerAborted and not(r.flushed)
```

### Each principal's calls are admitted from its own bucket of two tokens, and a refused call spends nothing

One principal's calls and refills never touch another principal's bucket.

```quint
pure val principals = Set(1, 2)
pure val principalValues = principals
pure def tokensOf(r: Requests, principal: int): int = r.tokens.getOr(principal, 0)
pure def admittedOf(r: Requests, principal: int): int = r.admittedCalls.getOr(principal, 0)
pure def canAdmitCall(r: Requests, principal: int): bool = principals.contains(principal) and tokensOf(r, principal) > 0
pure def admitCall(r: Requests, principal: int): Requests =
  { ...r, tokens: r.tokens.put(principal, tokensOf(r, principal) - 1), admittedCalls: r.admittedCalls.put(principal, admittedOf(r, principal) + 1) }
pure def canRefill(r: Requests, principal: int): bool = principals.contains(principal) and tokensOf(r, principal) < bucketSize
pure def refill(r: Requests, principal: int): Requests =
  { ...r, tokens: r.tokens.put(principal, bucketSize), admittedCalls: r.admittedCalls.put(principal, 0) }
pure def alwaysBucketBalanced(r: Requests): bool =
  principals.forall(p => tokensOf(r, p) >= 0 and tokensOf(r, p) <= bucketSize and tokensOf(r, p) + admittedOf(r, p) == bucketSize)
pure def stepBucketsAreIndependent(before: Requests, after: Requests): bool =
  principals.filter(p => tokensOf(before, p) != tokensOf(after, p)).size() <= 1
pure def sometimesOneBucketEmptyOtherFull(r: Requests): bool = tokensOf(r, 1) == 0 and tokensOf(r, 2) == bucketSize
```

### A budget write retries a conflict at most three times

```quint
pure val casLimit = 3
pure def canCasConflict(r: Requests): bool = not(r.casCommitted) and r.casAttempts < casLimit
pure def casConflict(r: Requests): Requests = { ...r, casAttempts: r.casAttempts + 1 }
pure def canCasCommit(r: Requests): bool = not(r.casCommitted) and r.casAttempts < casLimit
pure def casCommit(r: Requests): Requests = { ...r, casAttempts: r.casAttempts + 1, casCommitted: true }
pure def alwaysCasBounded(r: Requests): bool = r.casAttempts >= 0 and r.casAttempts <= casLimit
pure def sometimesCommittedOnLastAttempt(r: Requests): bool = r.casCommitted and r.casAttempts == casLimit
```

### An unframed body from the native process gets a length, and explicit framing is kept

A request relayed from the native process carries its body without HTTP
framing. A positive unframed body gets a length so the route reads all of
it; an empty one stays unframed; an explicit length, zero or chunked
framing is never replaced.

```quint
type Framing = Unframed | LengthFraming | ZeroLength | Chunked
pure def preparedFraming(bytes: int, supplied: Framing): Framing = if (bytes > 0 and supplied == Unframed) LengthFraming else supplied
pure def bytesRead(bytes: int, framing: Framing): int = if (framing == LengthFraming or framing == Chunked) bytes else 0
pure def lawExplicitFramingKept(bytes: int, supplied: Framing): bool = supplied != Unframed implies preparedFraming(bytes, supplied) == supplied
pure def lawUnframedBodyReadWhole(bytes: int): bool = bytes > 0 implies bytesRead(bytes, preparedFraming(bytes, Unframed)) == bytes
```

## Story: Explain a refusal from the recent log

> As the owner, when my agent cannot answer because the model provider is
> out of credits, the reply says so, even if other log lines arrived since.

### The log buffer holds at most three entries and always the two newest

```quint
pure val logCapacity = 3
pure val creditLookback = 60
pure def recentCredit(entries: List[LogEntry], now: int): int =
  entries.foldl(-1, (latest, e) => if (e.credit and now - e.at <= creditLookback and e.id > latest) e.id else latest)
pure def evicted(entries: List[LogEntry], newest: int, now: int): List[LogEntry] = {
  val keep = recentCredit(entries, now)
  if (entries.length() > logCapacity) entries.select(e => e.id >= newest - 1 or e.id == keep) else entries
}
pure def appendLog(r: Requests, credit: bool): Requests = {
  val entry = { id: r.nextLog, credit: credit, at: r.now }
  { ...r, nextLog: r.nextLog + 1, history: r.history.append(entry), buffer: evicted(r.buffer.append(entry), r.nextLog, r.now) }
}
pure def elapse(r: Requests): Requests = { ...r, now: r.now + 30 }
pure def alwaysLogBounded(r: Requests): bool =
  r.buffer.length() <= logCapacity and r.history.every(e => e.id < r.nextLog - 2 or r.buffer.includes(e))
```

### Log entries are numbered and stamped in order, and the buffer holds each logged entry once

Each entry takes the next number, counting from zero, and the current
time, so no two entries share a number and a later entry is never older.
The buffer holds only logged entries, none of them twice.

```quint
pure def alwaysLogEntriesInOrder(r: Requests): bool =
  r.nextLog >= 0 and r.history.every(e => e.id >= 0 and e.id < r.nextLog and e.at <= r.now and r.history.select(f => f.id == e.id).length() == 1 and r.history.every(f => e.id < f.id implies e.at <= f.at))
    and r.buffer.every(e => r.history.includes(e) and r.buffer.select(f => f.id == e.id).length() == 1)
```

### A credit warning inside the lookback survives a burst of later entries

```quint
pure def alwaysRecentCreditWarningRetained(r: Requests): bool = recentCredit(r.history, r.now) == recentCredit(r.buffer, r.now)
pure def replyMentionsCredits(r: Requests): bool = recentCredit(r.buffer, r.now) >= 0
pure def sometimesWarningSurvivesBurst(r: Requests): bool = replyMentionsCredits(r) and r.history.length() >= logCapacity + 2 and r.buffer.length() == logCapacity
pure def sometimesOldWarningExpired(r: Requests): bool = r.history.some(e => e.credit) and not(replyMentionsCredits(r))
```

## Story: Serve a route the same behind any proxy

> As a user reaching the agent through proxies, a route builds the same
> base address for my request as it would without them.

### The route reads the first forwarded scheme

A route's base address uses the Host header and the first value of
`X-Forwarded-Proto`: proxies append hops, and repeated header lines are
joined with a comma. The header decoder splits and trims the values. An
absent, empty or unrecognised first value means the request's own scheme,
so every request is served with an HTTP or HTTPS base address.

```quint
pure val forwardedValues = Set(List(), List(""), List("https"), List("http", "https"), List("https", "http"), List("ftp", "https"), List("", "https"))
pure val ownSchemeValues = Set("http", "https")
pure val servedSchemes = Set("http", "https")
pure def firstForwardedScheme(forwarded: List[str], ownScheme: str): str =
  if (servedSchemes.contains(forwarded.nthOr(0, ""))) forwarded.nthOr(0, "") else ownScheme
pure def lawEveryProxiedRequestIsServed(forwarded: List[str], ownScheme: str): bool =
  servedSchemes.contains(ownScheme) implies servedSchemes.contains(firstForwardedScheme(forwarded, ownScheme))
pure def lawAbsentForwardingUsesOwnScheme(ownScheme: str): bool =
  firstForwardedScheme(List(), ownScheme) == ownScheme and firstForwardedScheme(List(""), ownScheme) == ownScheme
```
