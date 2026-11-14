# Single-flight read memo

The owner is `runtime/single-flight-memo.ts` and its public `read-memo.ts`
export at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. One registry owns
all keys of one memo instance. The [read ordering scenario](./memoConcurrency.md)
embeds this registry when relating cache reuse to durable mutation boundaries.
Promise execution remains an external effect; each installed rejection
observer is represented separately from settlement of the promise itself.

## Story: Reuse concurrent reads and evict only the matching rejected promise

As a provider, I retrieve the original promise and metadata while its entry
is live. Replacement, invalidation and eviction retain existing callers'
promises. A rejection observer cannot delete a different resident promise.

### Entries retain insertion order and each put installs its own rejection observer

Overwriting an existing key preserves its position. Inserting a new key at
capacity removes the first key, including expired entries. The source
constructor accepts zero or negative capacity; these still retain at most
one inserted key. A negative or zero TTL gives no live peek. `peek` never
removes an expired entry. Multiple puts may use the same promise object;
an earlier observer may delete a later entry only if it has that same
promise identity. Observer callbacks are distinct from promise settlement.

```quint
type MemoEntry = { key: str, promiseId: int, meta: str, insertedAt: int }
type RejectionObserver = { id: int, key: str, promiseId: int }
type Memo = { configured: bool, ttl: int, capacity: int, now: int, entries: List[MemoEntry], observers: List[RejectionObserver], nextObserver: int }
pure val initial: Memo = { configured: false, ttl: 0, capacity: 0, now: 0, entries: List(), observers: List(), nextObserver: 1 }
pure val absentEntry: MemoEntry = { key: "", promiseId: 0, meta: "", insertedAt: 0 }
pure val absentObserver: RejectionObserver = { id: 0, key: "", promiseId: 0 }
pure def canConfigure(m: Memo, ttl: int, capacity: int): bool = not(m.configured)
pure def configure(m: Memo, ttl: int, capacity: int): Memo = { ...m, configured: true, ttl: ttl, capacity: capacity }
pure def entryAt(m: Memo, key: str): MemoEntry = m.entries.select(entry => entry.key == key).nthOr(0, absentEntry)
pure def hasEntry(m: Memo, key: str): bool = m.entries.some(entry => entry.key == key)
pure def liveAt(m: Memo, key: str): bool = hasEntry(m, key) and m.now - entryAt(m, key).insertedAt < m.ttl
pure def observerAt(m: Memo, observerId: int): RejectionObserver = m.observers.select(observer => observer.id == observerId).nthOr(0, absentObserver)
pure def canStoreEntry(m: Memo, key: str, promiseId: int, meta: str): bool = m.configured and promiseId > 0
pure def storeEntry(m: Memo, key: str, promiseId: int, meta: str): Memo = {
  val fresh = { key: key, promiseId: promiseId, meta: meta, insertedAt: m.now }
  val beforeInsert = if (not(hasEntry(m, key)) and m.entries.length() >= m.capacity) m.entries.removeAt(0) else m.entries
  { ...m, entries: if (hasEntry(m, key)) m.entries.listMap(entry => if (entry.key == key) fresh else entry) else beforeInsert.append(fresh), observers: m.observers.append({ id: m.nextObserver, key: key, promiseId: promiseId }), nextObserver: m.nextObserver + 1 }
}
pure def invalidateKey(m: Memo, key: str): Memo = { ...m, entries: m.entries.select(entry => entry.key != key) }
pure def invalidateAll(m: Memo): Memo = { ...m, entries: List() }
pure def canObserveRejection(m: Memo, observerId: int): bool = m.observers.some(observer => observer.id == observerId)
pure def observeRejection(m: Memo, observerId: int): Memo = {
  val observer = observerAt(m, observerId)
  { ...m, entries: m.entries.select(entry => entry.key != observer.key or entry.promiseId != observer.promiseId), observers: m.observers.select(other => other.id != observerId) }
}
pure def canReleaseObserver(m: Memo, observerId: int): bool = m.observers.some(observer => observer.id == observerId)
pure def releaseObserver(m: Memo, observerId: int): Memo = { ...m, observers: m.observers.select(observer => observer.id != observerId) }
pure def canAdvanceClock(m: Memo, now: int): bool = now >= m.now
pure def advanceClock(m: Memo, now: int): Memo = { ...m, now: now }
pure val promiseIdValues = Set(1, 2, 3)
pure val observerIdValues = Set(1, 2, 3, 4)
pure val capacityValues = Set(-1, 0, 1, 2)
pure val ttlValues = Set(-1, 0, 1, 3)
pure val nowValues = Set(0, 1, 2, 3, 4)
pure def alwaysUniqueEntryKeys(m: Memo): bool = m.entries.every(entry => m.entries.select(other => other.key == entry.key).length() == 1)
pure def alwaysUniqueObserverIds(m: Memo): bool = m.observers.every(observer => m.observers.select(other => other.id == observer.id).length() == 1)
pure def alwaysValidMemoIdentities(m: Memo): bool = m.nextObserver > 0 and m.now >= 0 and m.entries.every(entry => entry.promiseId > 0 and entry.insertedAt >= 0 and entry.insertedAt <= m.now) and m.observers.every(observer => observer.id > 0 and observer.id < m.nextObserver and observer.promiseId > 0)
pure def alwaysCapacityBound(m: Memo): bool = (not(m.configured) implies m.entries.length() == 0) and (m.configured implies m.entries.length() <= (if (m.capacity > 0) m.capacity else 1))
pure def stepInvalidationRetainsPendingObservers(before: Memo, via: str, after: Memo): bool = (via == "invalidateKey" or via == "invalidateAll") implies after.observers == before.observers
pure def stepConfigurationIsStable(before: Memo, after: Memo): bool = before.configured implies after.configured and after.ttl == before.ttl and after.capacity == before.capacity
pure def sometimesExpiredEntryIsRetained(m: Memo): bool = m.entries.some(entry => not(liveAt(m, entry.key)))
pure def sometimesRepeatedPromiseObservers(m: Memo): bool = m.observers.some(left => m.observers.some(right => left.id != right.id and left.promiseId == right.promiseId))
pure def sometimesEvictedPromiseStillHasObserver(m: Memo): bool = m.observers.some(observer => not(hasEntry(m, observer.key)))
```

### A rejection affects only its captured key and promise identity

A rejected promise can remain resident until the installed observer runs.
No rule equates rejection settlement with callback delivery. The earlier
single-key model did; this rule corrects that abstraction to the source's
asynchronous ordering.

```quint
pure def lawRejectionPreservesOtherKeys(m: Memo, observerId: int, key: str): bool =
  observerAt(m, observerId).key != key implies entryAt(observeRejection(m, observerId), key) == entryAt(m, key)
pure def lawRejectionPreservesReplacement(m: Memo, observerId: int): bool =
  (alwaysUniqueEntryKeys(m) and entryAt(m, observerAt(m, observerId).key).promiseId != observerAt(m, observerId).promiseId) implies observeRejection(m, observerId).entries == m.entries
pure def lawPutRetainsExactPromiseAndMetadata(m: Memo, key: str, promiseId: int, meta: str): bool =
  entryAt(storeEntry(m, key, promiseId, meta), key).promiseId == promiseId and entryAt(storeEntry(m, key, promiseId, meta), key).meta == meta
```


### Live entries expire as monotonic time advances

The host timestamps entries and checks their age with `performance.now()`.
Wall-clock corrections do not change that age. As elapsed time advances,
the earliest live deadline eventually passes. The model can advance
directly to that observed deadline or accept an explicit monotonic reading.
A prior entry stops serving cache hits after it expires, is removed or is
replaced. Deadline passage leaves the stored promise and observer intact.

```quint
pure def earlierDeadline(earliest: int, deadline: int, now: int): int =
  if (deadline > now and (earliest == 0 or deadline < earliest)) deadline else earliest
pure def earliestDeadline(m: Memo): int =
  m.entries.foldl(0, (earliest, entry) => earlierDeadline(earliest, entry.insertedAt + m.ttl, m.now))
pure def canPassMemoDeadline(m: Memo): bool = earliestDeadline(m) > m.now
pure def passMemoDeadline(m: Memo): Memo = advanceClock(m, earliestDeadline(m))
pure val fair_passMemoDeadline = "weak"
pure def leadsToPriorEntriesStopServing(m: Memo, later: Memo): bool =
  m.entries.every(entry => liveAt(m, entry.key) implies
    not(liveAt(later, entry.key)) or entryAt(later, entry.key) != entry)
pure def stepElapsedTimeRetainsEntries(before: Memo, via: str, after: Memo): bool =
  (via == "passMemoDeadline" or via == "advanceClock") implies
    after.now >= before.now and after.entries == before.entries and after.observers == before.observers
```
