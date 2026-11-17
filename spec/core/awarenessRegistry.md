# Awareness registry

The source is `packages/core/src/awareness.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The registry orders contributors
and gives each registered contributor one [summary cache](./awareness.md),
with separate rows for runtime identities. Its summary and detail boundaries
report contributor errors and render the declared unavailable marker while
continuing peers.

## Story: Register independent awareness contributors

> As a plugin, I want to register an awareness contributor under a unique
> ID, so that my contribution never replaces another plugin's.

As a plugin, I register a unique contributor ID with its position, TTL,
trust classification and invalidating events. Equal-position registration
is stable. Invalidation drops caches for matching contributors across all
runtimes and preserves every unrelated contributor's cache.

As an agent, I see contributor output in ascending position order, retaining
registration order for equal positions. Duplicate contributor IDs fail.
Untrusted text passes through the existing sanitization patterns and
summary text passes through well-formed Unicode conversion. Empty summary
lines are omitted and the versioned self-status header remains present.

### A registry keeps one ordered contributor and one cache per ID

Registering inserts the new contributor after every contributor at or below
its position and before every contributor above it, keeping every existing
contributor. A duplicate ID is refused.

```quint
import awareness as A from "./awareness"
type Entry = { id: str, position: int, ttl: int, trusted: bool, events: Set[str], cache: A::SummaryCache }
type Registry = { entries: List[Entry] }
type PositionCheck = { seen: bool, previous: int, ordered: bool }
pure val positionStart: PositionCheck = { seen: false, previous: 0, ordered: true }
pure def orderedContributors(entries: List[Entry]): bool = entries.foldl(positionStart, (checked, entry) => { seen: true, previous: entry.position, ordered: checked.ordered and (not(checked.seen) or checked.previous <= entry.position) }).ordered
pure val initial: Registry = { entries: List() }
pure val noEntry: Entry = { id: "", position: 0, ttl: 60000, trusted: false, events: Set(), cache: A::initial }
pure def entryAt(r: Registry, id: str): Entry = r.entries.select(entry => entry.id == id).nthOr(0, noEntry)
pure def contributorRegistered(r: Registry, id: str): bool = r.entries.some(entry => entry.id == id)
pure def canRegisterContributor(r: Registry, id: str, position: int, ttl: int, trusted: bool, events: Set[str]): bool = not(contributorRegistered(r, id))
pure def inserted(entries: List[Entry], candidate: Entry): List[Entry] =
  entries.select(existing => existing.position <= candidate.position).append(candidate).concat(entries.select(existing => existing.position > candidate.position))
pure def registerContributor(r: Registry, id: str, position: int, ttl: int, trusted: bool, events: Set[str]): Registry =
  { entries: inserted(r.entries, { id: id, position: position, ttl: ttl, trusted: trusted, events: events, cache: A::initial }) }
pure def lawInsertionKeepsExistingContributors(entries: List[Entry], candidate: Entry): bool = inserted(entries, candidate).length() == entries.length() + 1
pure val eventsValues = Set(Set(), Set("settings-updated"), Set("plugin-loaded", "settings-updated"))
pure val idValues = Set("first", "second")
pure val entriesValues: Set[List[Entry]] = Set(List(), List({ ...noEntry, id: "first", position: 1, trusted: true }, { ...noEntry, id: "second", position: 2 }))
pure val candidateValues: Set[Entry] = Set({ ...noEntry, id: "new", position: 1 }, { ...noEntry, id: "first", position: 0, trusted: true })
pure val ttlValues = A::ttlValues
pure def alwaysUniqueContributorIds(r: Registry): bool = r.entries.every(entry => r.entries.select(other => other.id == entry.id).length() == 1)
pure def alwaysContributorCachesValid(r: Registry): bool = r.entries.every(entry => A::alwaysOneCachePerRuntime(entry.cache) and A::alwaysUniqueRequestIdentity(entry.cache) and A::alwaysGenerationsAreValid(entry.cache))
pure def alwaysContributorsOrdered(r: Registry): bool = orderedContributors(r.entries)
```

### A request uses its contributor's TTL and runtime cache

The invocation's timestamp is captured before awaiting the contributor.
Cache invalidation during that await detaches the result from the current
registry generation. Contributor failures preserve peer cache entries.

```quint
pure def canStartSummary(r: Registry, id: str, requestId: str, runtimeId: str): bool = contributorRegistered(r, id) and A::canStartSummary(entryAt(r, id).cache, requestId, runtimeId, entryAt(r, id).ttl)
pure def startSummary(r: Registry, id: str, requestId: str, runtimeId: str): Registry = { entries: r.entries.listMap(entry => if (entry.id == id) { ...entry, cache: A::startSummary(entry.cache, requestId, runtimeId, entry.ttl) } else entry) }
pure def canFinishSummary(r: Registry, id: str, requestId: str, text: str): bool = contributorRegistered(r, id) and A::canFinishSummary(entryAt(r, id).cache, requestId, text)
pure def finishSummary(r: Registry, id: str, requestId: str, text: str): Registry = { entries: r.entries.listMap(entry => if (entry.id == id) { ...entry, cache: A::finishSummary(entry.cache, requestId, text) } else entry) }
pure def canFailSummary(r: Registry, id: str, requestId: str): bool = contributorRegistered(r, id) and A::canFailSummary(entryAt(r, id).cache, requestId)
pure def failSummary(r: Registry, id: str, requestId: str): Registry = { entries: r.entries.listMap(entry => if (entry.id == id) { ...entry, cache: A::failSummary(entry.cache, requestId) } else entry) }
pure def canSetClock(r: Registry, now: int): bool = now >= 0
pure def setClock(r: Registry, now: int): Registry = { entries: r.entries.listMap(entry => { ...entry, cache: A::setClock(entry.cache, now) }) }
pure def invalidateEvent(r: Registry, invalidationEvent: str): Registry = { entries: r.entries.listMap(entry => if (entry.events.contains(invalidationEvent)) { ...entry, cache: A::invalidateSummary(entry.cache) } else entry) }
pure val requestIdValues = A::requestIdValues
pure val runtimeIdValues = A::runtimeIdValues
pure val nowValues = A::nowValues
pure val invalidationEventValues = Set("plugin-loaded", "settings-updated", "unrelated")
pure def sometimesDistinctContributorCaches(r: Registry): bool = r.entries.some(entry => entry.cache.rows.length() > 0) and r.entries.some(entry => entry.cache.rows.length() == 0)
pure def sometimesInvalidatedPendingContributor(r: Registry): bool = r.entries.some(entry => entry.cache.pending.some(call => call.generation < entry.cache.generation))
```
