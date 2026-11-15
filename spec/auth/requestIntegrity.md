# Request integrity

A mutating request forwarded to the identity service carries a signature
over its method, path, body hash, client address and timestamp, a one-time
nonce, and optionally an idempotency key. The service verifies the request
first and commits it in a separate atomic step against the shared replay
store, so the request may expire, or a duplicate may race it, between the
two. The replay store is configured, and when it is unavailable the service
refuses rather than remembering nonces somewhere else. Times are in seconds.

New in v4. The one-use nonce with an expiry race is ported from develop
`packages/auth/quint/ExecutionAuthorization.qnt`, whose execution
authorization itself (agent custody) is not part of Eliza; the signing,
replay and rate rules come from develop cloud `lib/*/sign.ts` and the
identity service's request middleware.

## Story: Accept a mutating request only once, recently, from a signed caller

> As the identity service, I want each forwarded change to be authentic,
> fresh and applied at most once, so that a captured or retried request can
> never act twice or late.

### A mutating request needs a valid signature over its method, path, body hash, client address and timestamp

```quint
type SignedRequest = { signatureValid: bool, coversCanonicalParts: bool, timestamp: int, nonce: int, idempotencyKey: int, clientIp: int }
pure def signatureAccepted(request: SignedRequest): bool = request.signatureValid and request.coversCanonicalParts
pure def lawPartialSignatureRefused(request: SignedRequest): bool = not(request.coversCanonicalParts) implies not(signatureAccepted(request))
type IntegrityResult = NoRequest | Verified | Executed | ReplayedFirstResult | BadSignature | RequestExpired | ClockSkew | NonceReused | StoreUnavailable | RateLimited
type ReplayStore = StoreUp | StoreDown
type ExecutionRecord = { nonce: int, key: int, timestamp: int, committedAt: int }
type IpCount = { ip: int, count: int }
type RequestIntegrity = { now: int, store: ReplayStore, verified: List[SignedRequest], usedNonces: Set[int], log: List[ExecutionRecord], ipWindowStart: int, ipCounts: List[IpCount], result: IntegrityResult }
pure val initial: RequestIntegrity = { now: 0, store: StoreUp, verified: List(), usedNonces: Set(), log: List(), ipWindowStart: 0, ipCounts: List(), result: NoRequest }
pure val requestWindow = 300
pure val maxClockSkew = 60
pure val requestsPerIpWindow = 3
pure val ipWindow = 60
pure def countIn(counts: List[IpCount], ip: int): int = counts.select(c => c.ip == ip).nthOr(0, { ip: ip, count: 0 }).count
pure def ipCount(s: RequestIntegrity, ip: int): int = if (s.now - s.ipWindowStart >= ipWindow) 0 else countIn(s.ipCounts, ip)
pure def bumped(counts: List[IpCount], ip: int): List[IpCount] =
  if (counts.some(c => c.ip == ip)) counts.listMap(c => if (c.ip == ip) { ...c, count: c.count + 1 } else c) else counts.append({ ip: ip, count: 1 })
pure def canReceive(s: RequestIntegrity, request: SignedRequest): bool = request.nonce > 0
pure def receive(s: RequestIntegrity, request: SignedRequest): RequestIntegrity = {
  val fresh = s.now - s.ipWindowStart >= ipWindow
  val counts = if (fresh) List() else s.ipCounts
  val counted = { ...s, ipWindowStart: if (fresh) s.now else s.ipWindowStart, ipCounts: bumped(counts, request.clientIp) }
  if (ipCount(s, request.clientIp) >= requestsPerIpWindow) { ...s, result: RateLimited }
  else if (not(signatureAccepted(request))) { ...counted, result: BadSignature }
  else if (request.timestamp > s.now + maxClockSkew) { ...counted, result: ClockSkew }
  else if (s.now >= request.timestamp + requestWindow) { ...counted, result: RequestExpired }
  else { ...counted, verified: s.verified.append(request), result: Verified }
}
pure val requestValues = Set(
  { signatureValid: true, coversCanonicalParts: true, timestamp: 0, nonce: 1, idempotencyKey: 0, clientIp: 1 },
  { signatureValid: true, coversCanonicalParts: true, timestamp: 0, nonce: 2, idempotencyKey: 9, clientIp: 1 },
  { signatureValid: true, coversCanonicalParts: true, timestamp: 0, nonce: 3, idempotencyKey: 9, clientIp: 2 },
  { signatureValid: true, coversCanonicalParts: false, timestamp: 0, nonce: 4, idempotencyKey: 0, clientIp: 2 },
  { signatureValid: true, coversCanonicalParts: true, timestamp: 500, nonce: 5, idempotencyKey: 0, clientIp: 2 })
pure def canElapse(s: RequestIntegrity, seconds: int): bool = seconds > 0
pure def elapse(s: RequestIntegrity, seconds: int): RequestIntegrity = { ...s, now: s.now + seconds }
pure val secondsValues = Set(30, 300)
pure def sometimesBadSignatureRefused(s: RequestIntegrity): bool = s.result == BadSignature
```

### A request older than its window, or stamped too far ahead, is refused, also between verification and commit

The commit checks the window again, so a request verified in time but
committed after its window has passed is refused.

```quint
pure def stillFresh(s: RequestIntegrity, request: SignedRequest): bool = s.now < request.timestamp + requestWindow and request.timestamp <= s.now + maxClockSkew
pure def canCommitRequest(s: RequestIntegrity, nonce: int): bool = s.verified.some(r => r.nonce == nonce)
pure def commitRequest(s: RequestIntegrity, nonce: int): RequestIntegrity = {
  val request = s.verified.select(r => r.nonce == nonce).nthOr(0, { signatureValid: false, coversCanonicalParts: false, timestamp: 0, nonce: 0, idempotencyKey: 0, clientIp: 0 })
  val rest = s.verified.select(r => r.nonce != nonce)
  if (s.store == StoreDown) { ...s, verified: rest, result: StoreUnavailable }
  else if (s.usedNonces.contains(nonce)) { ...s, verified: rest, result: NonceReused }
  else if (not(stillFresh(s, request))) { ...s, verified: rest, result: RequestExpired }
  else if (request.idempotencyKey > 0 and s.log.some(e => e.key == request.idempotencyKey)) { ...s, verified: rest, usedNonces: s.usedNonces.union(Set(nonce)), result: ReplayedFirstResult }
  else { ...s, verified: rest, usedNonces: s.usedNonces.union(Set(nonce)), log: s.log.append({ nonce: nonce, key: request.idempotencyKey, timestamp: request.timestamp, committedAt: s.now }), result: Executed }
}
pure val nonceValues = Set(1, 2, 3)
pure def alwaysExecutedWithinWindow(s: RequestIntegrity): bool =
  s.log.every(e => e.committedAt < e.timestamp + requestWindow and e.timestamp <= e.committedAt + maxClockSkew and e.committedAt <= s.now)
pure def sometimesExpiredBetweenVerifyAndCommit(s: RequestIntegrity): bool = s.result == RequestExpired and s.log.length() == 0 and s.usedNonces.size() == 0
```

### A nonce is used once, and an idempotency key replays the first result without executing again

```quint
pure def alwaysNonceExecutesOnce(s: RequestIntegrity): bool =
  s.log.every(e => s.log.select(o => o.nonce == e.nonce).length() == 1 and s.usedNonces.contains(e.nonce))
pure def alwaysKeyExecutesOnce(s: RequestIntegrity): bool = s.log.every(e => e.key == 0 or s.log.select(o => o.key == e.key).length() == 1)
pure def sometimesReplayedFirstResult(s: RequestIntegrity): bool = s.result == ReplayedFirstResult
pure def sometimesDuplicateNonceRefused(s: RequestIntegrity): bool = s.result == NonceReused
```

### A replay-store outage fails closed and never switches to another store

```quint
pure def storeFails(s: RequestIntegrity): RequestIntegrity = { ...s, store: StoreDown }
pure def storeRecovers(s: RequestIntegrity): RequestIntegrity = { ...s, store: StoreUp }
pure def stepOutageExecutesNothing(before: RequestIntegrity, after: RequestIntegrity): bool =
  before.store == StoreDown implies (after.log == before.log and after.usedNonces.subseteq(before.usedNonces) and before.usedNonces.subseteq(after.usedNonces))
pure def sometimesOutageRefused(s: RequestIntegrity): bool = s.result == StoreUnavailable
```

### Requests are limited per client address

```quint
pure def alwaysWithinIpLimit(s: RequestIntegrity): bool = s.ipCounts.every(c => c.count >= 1 and c.count <= requestsPerIpWindow and s.ipCounts.select(o => o.ip == c.ip).length() == 1)
pure def sometimesRateLimited(s: RequestIntegrity): bool = s.result == RateLimited
```
