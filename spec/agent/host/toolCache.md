# Tool-call cache

Results of cacheable tool calls are kept in two tiers, memory and disk,
keyed by the call and the version of the tool's descriptor. The memory tier
never holds what the disk tier no longer holds, a lookup hits only a fresh
entry of the requested version, and an entry is redacted before it is
written to disk. Concurrent misses for the same key share one execution.
Invalidation deletes entries; it does not cancel a call in flight, which may
fill the cache again when it completes. The research baseline is
`packages/agent/src/runtime/tool-call-cache/{cache,disk-store,lru,key,redact,registry}.ts`
and the `runtime-cache` model.

## Story: Reuse a tool result only while it is valid

> As the owner, my agent reuses a tool's result only for the same call to
> the same version of the tool while the result is fresh, and nothing
> secret from a result is written to disk.

### A lookup hits only a fresh entry of the requested descriptor version

```quint
type ToolCache = { requested: int, memory: int, disk: int, diskRedacted: bool, inflight: Set[int], expired: bool, hit: int, executions: int }
pure val initial: ToolCache = { requested: 0, memory: -1, disk: -1, diskRedacted: true, inflight: Set(), expired: false, hit: -1, executions: 0 }
pure val versionValues = Set(0, 1)
pure def canSelectVersion(c: ToolCache, version: int): bool = version >= 0 and version != c.requested
pure def selectVersion(c: ToolCache, version: int): ToolCache = { ...c, requested: version, hit: -1 }
pure def canLookup(c: ToolCache): bool = not(c.expired) and c.disk == c.requested
pure def lookup(c: ToolCache): ToolCache = { ...c, memory: c.disk, hit: c.disk }
pure def canExpire(c: ToolCache): bool = not(c.expired)
pure def expire(c: ToolCache): ToolCache = { ...c, expired: true, hit: -1 }
pure def alwaysHitIsFreshAndCurrent(c: ToolCache): bool = c.hit != -1 implies c.hit == c.requested and not(c.expired)
pure def sometimesHit(c: ToolCache): bool = c.hit >= 0
```

### The memory tier holds only what the disk tier holds

```quint
pure def canInvalidate(c: ToolCache): bool = c.disk != -1 or c.memory != -1
pure def invalidate(c: ToolCache): ToolCache = { ...c, memory: -1, disk: -1, hit: -1 }
pure def alwaysTiersConsistent(c: ToolCache): bool = c.memory == -1 or c.memory == c.disk
```

### Concurrent misses for one version share one execution, and a failure releases it

```quint
pure def canMiss(c: ToolCache): bool = not(c.inflight.contains(c.requested))
pure def miss(c: ToolCache): ToolCache = { ...c, inflight: c.inflight.union(Set(c.requested)), executions: c.executions + 1, hit: -1 }
pure def canFailCall(c: ToolCache, version: int): bool = c.inflight.contains(version)
pure def failCall(c: ToolCache, version: int): ToolCache = { ...c, inflight: c.inflight.exclude(Set(version)) }
pure def stepOneExecutionPerVersionInFlight(before: ToolCache, via: str, after: ToolCache): bool =
  via == "miss" implies not(before.inflight.contains(before.requested))
pure def sometimesBothVersionsInFlight(c: ToolCache): bool = c.inflight.size() == 2
```

### A completed call is redacted before it is written, and may refill the cache after an invalidation

```quint
pure def canComplete(c: ToolCache, version: int): bool = c.inflight.contains(version)
pure def complete(c: ToolCache, version: int): ToolCache =
  { ...c, inflight: c.inflight.exclude(Set(version)), memory: version, disk: version, diskRedacted: true, expired: false, hit: -1 }
pure def alwaysDiskEntryRedacted(c: ToolCache): bool = c.disk != -1 implies c.diskRedacted
pure def sometimesRefilledAfterInvalidation(c: ToolCache): bool = c.disk >= 0 and c.executions >= 2
```
