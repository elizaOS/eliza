# Provider access tokens

When the agent calls a linked model provider it asks for a usable access
token for one account. A token that will outlive the requested buffer is
returned at once. Otherwise the request waits its turn in a first-in,
first-out queue for that account in its process, reads the account again,
and only then spends the refresh grant with the provider. The refreshed
credential is committed only if nobody replaced, removed or reset the account
meanwhile, under the generation that [account storage](./accountStorage.md)
gives each replacement.

## Story: Get a usable provider access token without duplicate refreshes

> As the agent, I want a token that is good for my request, and I want
> concurrent requests for one account to share one refresh, so that a
> provider never sees a refresh grant spent twice or a stale token written
> over a newer one.

### Refreshes for one account run one at a time in arrival order, and other accounts do not wait

Each account's queue in a process admits the request at its head, and the
provider and storage answer the one request that queue has admitted.

```quint
type TokenRecord = { root: int, generation: int, token: int, grant: int, expires: int, refreshable: bool }
type CapturedEpoch = { epoch: int }
type CapturedPolicy = NoPolicy | Policy(CapturedEpoch)
type ResolutionPhase = AtStart | Queued | AtProvider | Committing | ResolutionDone
type ResolutionOutcome = Pending | TokenOk | NeedsAuth | Transient | Insufficient | PolicyError | StorageError
type Resolution = {
  id: int, root: int, process: int, policy: CapturedPolicy, buffer: int, phase: ResolutionPhase, observedGeneration: int, issuedGrant: int,
  responseToken: int, responseGrant: int, responseLifetime: int, outcome: ResolutionOutcome, resultToken: int, resultGeneration: int, resultExpires: int,
  decidedAt: int, refreshed: bool, published: bool, committedGeneration: int
}
type KeyQueue = { process: int, root: int, waiting: List[int], active: int }
type AccessTokens = { now: int, records: List[TokenRecord], epochs: List[int], requests: List[Resolution], queues: List[KeyQueue], usedGrants: Set[int], nextGeneration: int, nextId: int }
pure val initial: AccessTokens = {
  now: 0, records: List({ root: 1, generation: 1, token: 1, grant: 1, expires: 0, refreshable: true }, { root: 2, generation: 2, token: 2, grant: 2, expires: 0, refreshable: false }),
  epochs: List(0, 0), requests: List(), queues: List(), usedGrants: Set(), nextGeneration: 3, nextId: 1
}
pure val noRecord: TokenRecord = { root: 0, generation: 0, token: 0, grant: 0, expires: 0, refreshable: false }
pure val noRequest: Resolution = {
  id: 0, root: 0, process: 0, policy: Policy({ epoch: 0 }), buffer: 1, phase: ResolutionDone, observedGeneration: 0, issuedGrant: 0,
  responseToken: 0, responseGrant: 0, responseLifetime: 0, outcome: Pending, resultToken: 0, resultGeneration: 0, resultExpires: 0,
  decidedAt: 0, refreshed: false, published: false, committedGeneration: 0
}
pure def recordOf(s: AccessTokens, root: int): TokenRecord = s.records.select(r => r.root == root).nthOr(0, noRecord)
pure def present(s: AccessTokens, root: int): bool = s.records.some(r => r.root == root)
pure def requestOf(s: AccessTokens, id: int): Resolution = s.requests.select(r => r.id == id).nthOr(0, noRequest)
pure def epochOf(s: AccessTokens, root: int): int = s.epochs.nthOr(root - 1, 0)
pure def policyValid(s: AccessTokens, r: Resolution): bool = {
  val policy = r.policy
  match policy { | NoPolicy => true | Policy(captured) => captured.epoch == epochOf(s, r.root) }
}
pure def usable(expires: int, now: int, buffer: int): bool = expires > now + buffer
pure def queueOf(s: AccessTokens, process: int, root: int): KeyQueue = s.queues.select(q => q.process == process and q.root == root).nthOr(0, { process: process, root: root, waiting: List(), active: 0 })
pure def withRequest(id: int, change: Resolution, s: AccessTokens): List[Resolution] = s.requests.listMap(r => if (r.id == id) change else r)
pure def dequeued(id: int, s: AccessTokens): List[KeyQueue] = s.queues.listMap(q => { ...q, waiting: q.waiting.select(w => w != id), active: if (q.active == id) 0 else q.active })
pure def finished(id: int, verdict: ResolutionOutcome, token: int, generation: int, expires: int, refreshed: bool, s: AccessTokens): AccessTokens = {
  val r = requestOf(s, id)
  { ...s, queues: dequeued(id, s),
    requests: withRequest(id, { ...r, phase: ResolutionDone, outcome: verdict, resultToken: if (verdict == TokenOk) token else 0, resultGeneration: generation, resultExpires: expires, decidedAt: s.now, refreshed: refreshed }, s) }
}
pure def activeOf(s: AccessTokens, process: int, root: int): Resolution = requestOf(s, queueOf(s, process, root).active)
pure def canAdmit(s: AccessTokens, process: int, root: int): bool = {
  val q = queueOf(s, process, root)
  q.active == 0 and requestOf(s, q.waiting.nthOr(0, 0)).phase == Queued
}
pure def admit(s: AccessTokens, process: int, root: int): AccessTokens = {
  val r = requestOf(s, queueOf(s, process, root).waiting.nthOr(0, 0))
  val id = r.id
  val record = recordOf(s, r.root)
  val reread = { ...r, observedGeneration: record.generation }
  val s2 = { ...s, requests: withRequest(id, reread, s) }
  if (not(policyValid(s, r))) finished(id, StorageError, 0, 0, 0, false, s2)
  else if (not(present(s, r.root))) finished(id, NeedsAuth, 0, 0, 0, false, s2)
  else if (usable(record.expires, s.now, r.buffer)) finished(id, TokenOk, record.token, record.generation, record.expires, false, s2)
  else if (r.policy == NoPolicy) finished(id, PolicyError, 0, 0, 0, false, s2)
  else { ...s2, requests: withRequest(id, { ...reread, phase: AtProvider, issuedGrant: record.grant }, s2),
    queues: s2.queues.listMap(q => if (q.process == r.process and q.root == r.root) { ...q, active: id } else q) }
}
pure val idValues = Set(1, 2, 3)
type ArrivalCursor = { ok: bool, last: int }
pure val arrivalStart: ArrivalCursor = { ok: true, last: 0 }
pure def ascending(ids: List[int]): bool = ids.foldl(arrivalStart, (acc, id) => { ok: acc.ok and id > acc.last, last: id }).ok
pure def alwaysQueuesKeepArrivalOrder(s: AccessTokens): bool = s.queues.every(q => ascending(q.waiting) and q.waiting.every(id => id < s.nextId))
pure def alwaysOneRefreshPerAccountKey(s: AccessTokens): bool =
  s.requests.every(r => (r.phase == AtProvider or r.phase == Committing) implies (queueOf(s, r.process, r.root).active == r.id and queueOf(s, r.process, r.root).waiting.nthOr(0, 0) == r.id))
    and s.queues.every(q => s.queues.select(o => o.process == q.process and o.root == q.root).length() == 1 and (q.active == 0 or q.waiting.nthOr(0, 0) == q.active))
pure def sometimesTwoProcessesRefreshAtOnce(s: AccessTokens): bool = s.requests.some(a => a.phase == AtProvider and s.requests.some(b => b.phase == AtProvider and b.process != a.process))
pure def sometimesQueuedCallerUsesRotatedToken(s: AccessTokens): bool = s.requests.some(r => r.outcome == TokenOk and r.issuedGrant == 0 and r.process == 1 and r.observedGeneration >= 3)
```

### Each request has its own number, and a queue holds only its own account's requests in that process

Numbers start at one, and each request takes the next, so every request's
number is below the next one to be given and no two requests share one.
Every number waiting in a queue belongs to a request for that queue's
account in that queue's process.

```quint
pure def alwaysRequestsNumberedOnce(s: AccessTokens): bool =
  s.nextId >= 1 and s.requests.every(r => r.id >= 1 and r.id < s.nextId and s.requests.select(o => o.id == r.id).length() == 1)
pure def alwaysQueuesHoldTheirOwnRequests(s: AccessTokens): bool =
  s.queues.every(q => q.waiting.every(id => s.requests.some(r => r.id == id and r.process == q.process and r.root == q.root)))
```

### A request returns a token only when it outlives the requested buffer, and a stored token that cannot be refreshed is never refreshed

A requested buffer below one second counts as one second.

```quint
pure def canRequestToken(s: AccessTokens, root: int, process: int, policy: CapturedPolicy, buffer: int): bool = root >= 1 and root <= 2 and process > 0
pure def requestToken(s: AccessTokens, root: int, process: int, policy: CapturedPolicy, buffer: int): AccessTokens = {
  val r = { ...noRequest, id: s.nextId, root: root, process: process, policy: policy, buffer: if (buffer > 1) buffer else 1, phase: AtStart, outcome: Pending }
  val record = recordOf(s, root)
  val s2 = { ...s, nextId: s.nextId + 1, requests: s.requests.append({ ...r, observedGeneration: record.generation }) }
  if (not(policyValid(s, r))) finished(r.id, StorageError, 0, 0, 0, false, s2)
  else if (not(present(s, root))) finished(r.id, NeedsAuth, 0, 0, 0, false, s2)
  else if (usable(record.expires, s.now, r.buffer)) finished(r.id, TokenOk, record.token, record.generation, record.expires, false, s2)
  else if (not(record.refreshable)) finished(r.id, NeedsAuth, 0, record.generation, record.expires, false, s2)
  else {
    ...s2, requests: withRequest(r.id, { ...r, observedGeneration: record.generation, phase: Queued }, s2),
    queues: if (s2.queues.some(q => q.process == process and q.root == root)) s2.queues.listMap(q => if (q.process == process and q.root == root) { ...q, waiting: q.waiting.append(r.id) } else q)
      else s2.queues.append({ process: process, root: root, waiting: List(r.id), active: 0 })
  }
}
pure val rootValues = Set(1, 2)
pure val processValues = Set(1, 2)
pure val policyValues = Set(NoPolicy, Policy({ epoch: 0 }), Policy({ epoch: 1 }))
pure val bufferValues = Set(-1, 1, 3)
pure def canElapse(s: AccessTokens, seconds: int): bool = seconds > 0
pure def elapse(s: AccessTokens, seconds: int): AccessTokens = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 3)
pure def alwaysTokenMatchesOutcome(s: AccessTokens): bool =
  s.requests.every(r => (r.outcome == TokenOk iff r.resultToken > 0) and (r.outcome == TokenOk implies (r.resultGeneration > 0 and r.resultExpires > r.decidedAt + r.buffer)) and r.buffer >= 1)
pure def alwaysExplicitPolicyBeforeGrant(s: AccessTokens): bool = s.requests.every(r => r.issuedGrant == 0 or r.policy != NoPolicy)
pure def sometimesInsufficientLifetime(s: AccessTokens): bool = s.requests.some(r => r.outcome == Insufficient)
pure def sometimesMissingPolicyRefusedWithoutGrant(s: AccessTokens): bool = s.requests.some(r => r.outcome == PolicyError and r.issuedGrant == 0)
```

### A provider failure publishes nothing and is classified as a sign-in problem or a transient one

```quint
type ProviderFailure = InvalidGrant | Unauthorized | Forbidden | RateLimit | ServerError | NetworkFailure | MalformedReply | ProviderTimeout
pure def authFailure(reason: ProviderFailure): bool = reason == InvalidGrant or reason == Unauthorized or reason == Forbidden
pure def canProviderSucceeds(s: AccessTokens, process: int, root: int, lifetime: int, rotate: bool): bool =
  activeOf(s, process, root).phase == AtProvider and not(s.usedGrants.contains(activeOf(s, process, root).issuedGrant))
pure def providerSucceeds(s: AccessTokens, process: int, root: int, lifetime: int, rotate: bool): AccessTokens = {
  val r = activeOf(s, process, root)
  { ...s, usedGrants: if (rotate) s.usedGrants.union(Set(r.issuedGrant)) else s.usedGrants,
    requests: withRequest(r.id, { ...r, phase: Committing, responseToken: r.id + 10, responseGrant: if (rotate) r.id + 10 else r.issuedGrant, responseLifetime: lifetime }, s) }
}
pure val lifetimeValues = Set(1, 4)
pure def canProviderFails(s: AccessTokens, process: int, root: int, reason: ProviderFailure, consumed: bool): bool =
  activeOf(s, process, root).phase == AtProvider and (not(consumed) or reason == NetworkFailure or reason == MalformedReply or reason == ProviderTimeout)
pure def providerFails(s: AccessTokens, process: int, root: int, reason: ProviderFailure, consumed: bool): AccessTokens = {
  val r = activeOf(s, process, root)
  finished(r.id, if (authFailure(reason)) NeedsAuth else Transient, 0, r.observedGeneration, 0, false, { ...s, usedGrants: if (consumed) s.usedGrants.union(Set(r.issuedGrant)) else s.usedGrants })
}
pure def stepFailureDoesNotPublish(before: AccessTokens, via: str, after: AccessTokens): bool = via == "providerFails" implies after.records == before.records
pure def alwaysTransientFailureKeepsCapturedGeneration(s: AccessTokens): bool = s.requests.every(r => r.outcome == Transient implies (r.resultGeneration == r.observedGeneration and not(r.published)))
pure def sometimesTransientFailure(s: AccessTokens): bool = s.requests.some(r => r.outcome == Transient)
```

### A refreshed credential is committed only if the account's generation is unchanged, and a policy epoch change invalidates it

When another writer replaced the account meanwhile, the request returns the
current credential instead and publishes nothing; a removed account stays
removed. A rotated grant that was published is the one kept.

```quint
type AccountChange = ReplaceAccount | RemoveAccount | ResetPolicy
pure def canCommit(s: AccessTokens, process: int, root: int): bool = activeOf(s, process, root).phase == Committing
pure def commit(s: AccessTokens, process: int, root: int): AccessTokens = {
  val r = activeOf(s, process, root)
  val id = r.id
  val latest = recordOf(s, r.root)
  val fresh = { ...latest, generation: s.nextGeneration, token: r.responseToken, grant: r.responseGrant, expires: s.now + r.responseLifetime }
  val ok = usable(fresh.expires, s.now, r.buffer)
  if (not(policyValid(s, r))) finished(id, StorageError, 0, 0, 0, false, s)
  else if (not(present(s, r.root))) finished(id, NeedsAuth, 0, r.observedGeneration, 0, false, s)
  else if (latest.generation != r.observedGeneration)
    finished(id, if (usable(latest.expires, s.now, r.buffer)) TokenOk else if (latest.expires > s.now) Insufficient else NeedsAuth, latest.token, latest.generation, latest.expires, false, s)
  else finished(id, if (ok) TokenOk else Insufficient, fresh.token, fresh.generation, fresh.expires, ok,
    { ...s, records: s.records.listMap(x => if (x.root == r.root) fresh else x), nextGeneration: s.nextGeneration + 1,
      requests: withRequest(id, { ...r, published: true, committedGeneration: fresh.generation }, s) })
}
pure def canStorageFails(s: AccessTokens, process: int, root: int, written: bool): bool = {
  val r = activeOf(s, process, root)
  r.phase == Committing and policyValid(s, r) and present(s, r.root) and recordOf(s, r.root).generation == r.observedGeneration
}
pure def storageFails(s: AccessTokens, process: int, root: int, written: bool): AccessTokens = {
  val r = activeOf(s, process, root)
  val id = r.id
  val fresh = { ...recordOf(s, r.root), generation: s.nextGeneration, token: r.responseToken, grant: r.responseGrant, expires: s.now + r.responseLifetime }
  finished(id, StorageError, 0, 0, 0, false,
    { ...s, records: if (written) s.records.listMap(x => if (x.root == r.root) fresh else x) else s.records, nextGeneration: if (written) s.nextGeneration + 1 else s.nextGeneration,
      requests: withRequest(id, { ...r, published: written, committedGeneration: if (written) fresh.generation else 0 }, s) })
}
pure def canChangeAccount(s: AccessTokens, root: int, change: AccountChange): bool = s.requests.some(r => r.phase == Queued or r.phase == AtProvider or r.phase == Committing)
pure def changeAccount(s: AccessTokens, root: int, change: AccountChange): AccessTokens =
  if (change == ReplaceAccount) { ...s, nextGeneration: s.nextGeneration + 1,
    records: if (present(s, root)) s.records.listMap(x => if (x.root == root) { ...x, generation: s.nextGeneration, token: 5, grant: 5, expires: s.now + 5 } else x)
      else s.records.append({ root: root, generation: s.nextGeneration, token: 5, grant: 5, expires: s.now + 5, refreshable: true }) }
  else if (change == RemoveAccount) { ...s, records: s.records.select(x => x.root != root) }
  else { ...s, records: s.records.select(x => x.root != root), epochs: List(epochOf(s, 1) + (if (root == 1) 1 else 0), epochOf(s, 2) + (if (root == 2) 1 else 0)) }
pure def stepStaleResponseCannotReplace(before: AccessTokens, via: str, after: AccessTokens): bool =
  (via == "commit" or via == "storageFails") implies before.records.every(b => after.records.includes(b) or before.requests.some(r => r.phase == Committing and r.root == b.root and r.observedGeneration == b.generation and policyValid(before, r)))
pure def stepRemovedAccountNotResurrected(before: AccessTokens, via: str, after: AccessTokens): bool =
  (via == "commit" or via == "storageFails") implies after.records.every(a => before.records.some(b => b.root == a.root))
pure def stepStalePolicyCommitFails(before: AccessTokens, via: str, after: AccessTokens): bool =
  via == "commit" implies after.requests.every(r => (r.phase == ResolutionDone and before.requests.some(b => b.id == r.id and b.phase == Committing and not(policyValid(before, b)))) implies (r.outcome == StorageError and not(r.published)))
pure def alwaysRefreshedRequiresPublication(s: AccessTokens): bool = s.requests.every(r => r.refreshed implies (r.published and r.outcome == TokenOk))
pure def alwaysRotatedGrantIsRetained(s: AccessTokens): bool =
  s.requests.every(r => (r.published and present(s, r.root) and recordOf(s, r.root).generation == r.committedGeneration) implies recordOf(s, r.root).grant == r.responseGrant)
pure def sometimesReplacementWinsBeforeCommit(s: AccessTokens): bool = s.requests.some(r => r.outcome == TokenOk and r.resultToken == 5 and not(r.refreshed))
pure def sometimesResetRejectsCommit(s: AccessTokens): bool = s.requests.some(r => r.outcome == StorageError and r.responseToken > 0 and not(r.published))
pure def sometimesRefreshed(s: AccessTokens): bool = s.requests.some(r => r.refreshed)
```

### A request has an outcome and publishes only once it settles

Until a request settles, its outcome is pending and it has published
nothing.

```quint
pure def alwaysSettlesBeforeOutcomeOrPublication(s: AccessTokens): bool =
  s.requests.every(r => (r.published implies r.phase == ResolutionDone) and (r.phase != ResolutionDone implies r.outcome == Pending))
```

### A provider response waiting to be committed carries a token

```quint
pure def alwaysCommitCarriesToken(s: AccessTokens): bool = s.requests.every(r => r.phase == Committing implies r.responseToken > 0)
```

### The next generation to be given is above every generation a request committed

The next generation is at least one, and a request that committed nothing
counts as having committed generation zero.

```quint
pure def alwaysCommittedGenerationsBelowNext(s: AccessTokens): bool =
  s.nextGeneration >= 1 and s.requests.every(r => r.committedGeneration < s.nextGeneration)
```

### Storage holds at most one credential per account, each with a token and a generation

Every stored credential's token and generation are above zero.

```quint
pure def alwaysOneCredentialPerAccount(s: AccessTokens): bool =
  s.records.every(x => x.token > 0 and x.generation > 0 and s.records.select(y => y.root == x.root).length() == 1)
```

### Every admitted request settles

```quint
pure val fair_admit = "weak"
pure val fair_commit = "weak"
pure def canProviderTimesOut(s: AccessTokens, process: int, root: int): bool = activeOf(s, process, root).phase == AtProvider
pure def providerTimesOut(s: AccessTokens, process: int, root: int): AccessTokens = {
  val r = activeOf(s, process, root)
  finished(r.id, Transient, 0, r.observedGeneration, 0, false, s)
}
pure val fair_providerTimesOut = "weak"
pure def leadsToRequestsSettle(s: AccessTokens, later: AccessTokens): bool = later.requests.every(r => r.phase == ResolutionDone or r.phase == AtStart)
```
