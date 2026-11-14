# Awareness contributors and caches

The source is `packages/core/src/awareness.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Contributor registration is
global to a registry. Cached summaries are additionally keyed by runtime
identity. The registry's summary and detail boundaries report contributor
errors and render the declared unavailable marker while continuing peers.

## Story: Compose ordered awareness from installed contributors

As an agent, I see contributor output in ascending position order, retaining
registration order for equal positions. Duplicate contributor IDs fail.
Untrusted text passes through the existing sanitization patterns and
summary text passes through well-formed Unicode conversion. Empty summary
lines are omitted and the versioned self-status header remains present.

### Inserting a contributor preserves stable position order

```quint
type Contributor = { id: str, position: int, trusted: bool }
pure def mayRegister(entries: List[Contributor], candidate: Contributor): bool = not(entries.some(entry => entry.id == candidate.id))
pure def inserted(entries: List[Contributor], candidate: Contributor): List[Contributor] =
  entries.select(entry => entry.position <= candidate.position).append(candidate).concat(entries.select(entry => entry.position > candidate.position))
pure val entriesValues = Set(List(), List({ id: "first", position: 1, trusted: true }, { id: "second", position: 2, trusted: false }))
pure val candidateValues = Set({ id: "new", position: 1, trusted: false }, { id: "first", position: 0, trusted: true })
pure def lawDuplicateRegistrationRejected(entries: List[Contributor], candidate: Contributor): bool = entries.some(entry => entry.id == candidate.id) implies not(mayRegister(entries, candidate))
pure def lawInsertionKeepsExistingContributors(entries: List[Contributor], candidate: Contributor): bool = inserted(entries, candidate).length() == entries.length() + 1
```

## Story: Cache each runtime independently and invalidate selected contributors

As a host, I use the configured contributor TTL or its 60000 millisecond
default. Cache expiry uses the invocation's captured clock. Concurrent
cache misses can each call the contributor. Invalidating a contributor
detaches all runtime caches and earlier in-flight results cannot repopulate
the new cache generation.

### A summary request captures its runtime clock and cache generation

This machine owns one contributor's cache. Registry invalidation dispatches
to each matching contributor using its `invalidateOn` event list.

```quint
type CacheRow = { runtimeId: str, text: str, expires: int }
type PendingSummary = { requestId: str, runtimeId: str, startedAt: int, generation: int, ttl: int }
type SummaryCache = { rows: List[CacheRow], pending: List[PendingSummary], now: int, generation: int, failures: int }
pure val initial: SummaryCache = { rows: List(), pending: List(), now: 0, generation: 0, failures: 0 }
pure def cached(s: SummaryCache, runtimeId: str): bool = s.rows.some(row => row.runtimeId == runtimeId and row.expires > s.now)
pure def canStartSummary(s: SummaryCache, requestId: str, runtimeId: str, ttl: int): bool = not(cached(s, runtimeId)) and not(s.pending.some(call => call.requestId == requestId))
pure def startSummary(s: SummaryCache, requestId: str, runtimeId: str, ttl: int): SummaryCache = { ...s, pending: s.pending.append({ requestId: requestId, runtimeId: runtimeId, startedAt: s.now, generation: s.generation, ttl: ttl }) }
pure def canFinishSummary(s: SummaryCache, requestId: str, text: str): bool = s.pending.some(call => call.requestId == requestId)
pure def finishSummary(s: SummaryCache, requestId: str, text: str): SummaryCache = {
  val matching = s.pending.select(candidate => candidate.requestId == requestId)
  val call = matching.nthOr(0, { requestId: requestId, runtimeId: "", startedAt: 0, generation: -1, ttl: 0 })
  if (matching.length() == 0) s else { ...s, pending: s.pending.select(candidate => candidate.requestId != requestId), rows: if (call.generation == s.generation) s.rows.select(row => row.runtimeId != call.runtimeId).append({ runtimeId: call.runtimeId, text: text, expires: call.startedAt + call.ttl }) else s.rows }
}
pure def canFailSummary(s: SummaryCache, requestId: str): bool = s.pending.some(call => call.requestId == requestId)
pure def failSummary(s: SummaryCache, requestId: str): SummaryCache = { ...s, pending: s.pending.select(call => call.requestId != requestId), failures: s.failures + 1 }
pure def invalidateSummary(s: SummaryCache): SummaryCache = { ...s, generation: s.generation + 1, rows: List() }
pure def canSetClock(s: SummaryCache, now: int): bool = now >= 0
pure def setClock(s: SummaryCache, now: int): SummaryCache = { ...s, now: now }
pure val requestIdValues = Set("a", "b", "c")
pure val runtimeIdValues = Set("first", "second")
pure val ttlValues = Set(0, 1, 60000)
pure val nowValues = Set(0, 1, 59999, 60000, 60001)
pure def alwaysOneCachePerRuntime(s: SummaryCache): bool = s.rows.every(row => s.rows.select(other => other.runtimeId == row.runtimeId).length() == 1)
pure def alwaysUniqueRequestIdentity(s: SummaryCache): bool = s.pending.every(call => s.pending.select(other => other.requestId == call.requestId).length() == 1)
pure def alwaysGenerationsAreValid(s: SummaryCache): bool = s.generation >= 0 and s.failures >= 0 and s.pending.every(call => call.generation <= s.generation and call.generation >= 0)
pure def stepInvalidationDetachesOldRows(before: SummaryCache, via: str, after: SummaryCache): bool = via == "invalidateSummary" implies after.rows.length() == 0 and after.generation == before.generation + 1
pure def stepStaleCompletionCannotPopulate(before: SummaryCache, via: str, after: SummaryCache): bool = (via == "finishSummary" and before.pending.every(call => call.generation != before.generation)) implies after.rows == before.rows
pure def sometimesSeparateRuntimeCaches(s: SummaryCache): bool = s.rows.some(row => row.runtimeId == "first") and s.rows.some(row => row.runtimeId == "second")
pure def sometimesConcurrentMisses(s: SummaryCache): bool = s.pending.length() >= 2
pure def sometimesExpiredSummary(s: SummaryCache): bool = s.rows.some(row => row.expires <= s.now)
```
