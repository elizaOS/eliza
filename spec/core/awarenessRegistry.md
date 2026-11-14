# Awareness registry composition

This model composes the contributor cache protocol from
[awareness](./awareness.md) into the registry in `packages/core/src/awareness.ts`
at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Each registered contributor
owns one cache containing separate rows for runtime identities.

## Story: Register independent awareness contributors

As a plugin, I register a unique contributor ID with its position, TTL,
trust classification and invalidating events. Equal-position registration
is stable. Invalidation drops caches for matching contributors across all
runtimes and preserves every unrelated contributor's cache.

### A registry keeps one ordered contributor and one cache per ID

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
pure def registerContributor(r: Registry, id: str, position: int, ttl: int, trusted: bool, events: Set[str]): Registry = {
  val entry = { id: id, position: position, ttl: ttl, trusted: trusted, events: events, cache: A::initial }
  { entries: r.entries.select(existing => existing.position <= position).append(entry).concat(r.entries.select(existing => existing.position > position)) }
}
pure val eventsValues = Set(Set(), Set("settings-updated"), Set("plugin-loaded", "settings-updated"))
pure val idValues = Set("first", "second")
pure val entriesValues: Set[List[Entry]] = Set(List())
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
