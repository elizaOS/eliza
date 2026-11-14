# Read memo capture and invalidation ordering

This expands `quint/SingleFlightMemo.qnt` with independent reader, fetch and writer records. Each identity denotes one invocation. The model has no fixed number of invocations. The simulator supplies a finite identity set. The [resident memo](./memo.md) is embedded as the sole cache owner. This scenario tracks one query key and its external storage effects; other cache keys retain the registry's capacity and observer semantics. The runtime configures a 1000 ms TTL and 1000 entries.

## Story: Read after a completed mutation without receiving an older snapshot

As a provider, I want a read begun after an invalidated write to observe that completed write, while earlier readers retain their original promises.

### Every served reader observes at least its invocation's completed-write floor

Commit, invalidation, fetch capture, resolution and reader continuation are separate events. Sharing is allowed only through the currently resident promise. Mutation completion clears that residency. An old fetch can still finish for its old readers, and its late rejection only evicts itself.

```quint
import memo as M from "./memo"
type FetchPhase = FetchAbsent | FetchWaiting | FetchResolved | FetchRejected
type ReadPhase = ReadAbsent | ReadWaiting | ReadServed | ReadFailed
type WritePhase = WriteAbsent | WriteCommitted | WriteInvalidated
pure val fetchAbsentValue: FetchPhase = FetchAbsent
pure val fetchWaitingValue: FetchPhase = FetchWaiting
pure val fetchResolvedValue: FetchPhase = FetchResolved
pure val fetchRejectedValue: FetchPhase = FetchRejected
pure val readAbsentValue: ReadPhase = ReadAbsent
pure val readWaitingValue: ReadPhase = ReadWaiting
pure val readServedValue: ReadPhase = ReadServed
pure val readFailedValue: ReadPhase = ReadFailed
pure val writeAbsentValue: WritePhase = WriteAbsent
pure val writeCommittedValue: WritePhase = WriteCommitted
pure val writeInvalidatedValue: WritePhase = WriteInvalidated
type FetchRecord = { phase: FetchPhase, captured: bool, version: int, floor: int }
type ReadRecord = { phase: ReadPhase, fetchId: int, floor: int, observed: int }
type WriteRecord = { phase: WritePhase, version: int }
type MemoReads = { durable: int, completed: int, serial: int, memo: M::Memo, fetchIds: List[int], fetches: int -> FetchRecord, readerIds: List[str], readers: str -> ReadRecord, writerIds: List[str], writers: str -> WriteRecord }
pure val emptyFetch: FetchRecord = { phase: fetchAbsentValue, captured: false, version: 0, floor: 0 }
pure val emptyRead: ReadRecord = { phase: readAbsentValue, fetchId: 0, floor: 0, observed: 0 }
pure val emptyWrite: WriteRecord = { phase: writeAbsentValue, version: 0 }
pure val initial: MemoReads = { durable: 0, completed: 0, serial: 0, memo: M::configure(M::initial, 1000, 1000), fetchIds: List(), fetches: Map(), readerIds: List(), readers: Map(), writerIds: List(), writers: Map() }
pure def residentPromise(m: MemoReads): int = M::entryAt(m.memo, "query").promiseId
pure def fetchAt(m: MemoReads, id: int): FetchRecord = if (m.fetchIds.includes(id)) m.fetches.getOr(id, emptyFetch) else emptyFetch
pure def readerAt(m: MemoReads, id: str): ReadRecord = if (m.readerIds.includes(id)) m.readers.getOr(id, emptyRead) else emptyRead
pure def writerAt(m: MemoReads, id: str): WriteRecord = if (m.writerIds.includes(id)) m.writers.getOr(id, emptyWrite) else emptyWrite
pure def canReadFresh(m: MemoReads, readerId: str): bool = readerId != "" and not(m.readerIds.includes(readerId))
pure def readFresh(m: MemoReads, readerId: str): MemoReads = { ...m, serial: m.serial + 1, memo: M::storeEntry(m.memo, "query", m.serial + 1, "query-shape"), fetchIds: m.fetchIds.append(m.serial + 1), fetches: m.fetches.put(m.serial + 1, { phase: fetchWaitingValue, captured: false, version: 0, floor: m.completed }), readerIds: m.readerIds.append(readerId), readers: m.readers.put(readerId, { phase: readWaitingValue, fetchId: m.serial + 1, floor: m.completed, observed: 0 }) }
pure def canReadShared(m: MemoReads, readerId: str): bool = readerId != "" and not(m.readerIds.includes(readerId)) and residentPromise(m) != 0 and m.fetchIds.includes(residentPromise(m)) and M::liveAt(m.memo, "query")
pure def readShared(m: MemoReads, readerId: str): MemoReads = { ...m, readerIds: m.readerIds.append(readerId), readers: m.readers.put(readerId, { phase: readWaitingValue, fetchId: residentPromise(m), floor: m.completed, observed: 0 }) }
pure def canCaptureFetch(m: MemoReads, fetchId: int): bool = m.fetchIds.includes(fetchId) and fetchAt(m, fetchId).phase == fetchWaitingValue and not(fetchAt(m, fetchId).captured)
pure def captureFetch(m: MemoReads, fetchId: int): MemoReads = { ...m, fetches: m.fetches.put(fetchId, { ...fetchAt(m, fetchId), captured: true, version: m.durable }) }
pure def canResolveFetch(m: MemoReads, fetchId: int): bool = m.fetchIds.includes(fetchId) and fetchAt(m, fetchId).phase == fetchWaitingValue and fetchAt(m, fetchId).captured
pure def resolveFetch(m: MemoReads, fetchId: int): MemoReads = { ...m, fetches: m.fetches.put(fetchId, { ...fetchAt(m, fetchId), phase: fetchResolvedValue }) }
pure def canRejectFetch(m: MemoReads, fetchId: int): bool = m.fetchIds.includes(fetchId) and fetchAt(m, fetchId).phase == fetchWaitingValue
pure def rejectFetch(m: MemoReads, fetchId: int): MemoReads = { ...m, fetches: m.fetches.put(fetchId, { ...fetchAt(m, fetchId), phase: fetchRejectedValue }) }
pure def canCompleteRead(m: MemoReads, readerId: str): bool = m.readerIds.includes(readerId) and readerAt(m, readerId).phase == readWaitingValue and (fetchAt(m, readerAt(m, readerId).fetchId).phase == fetchResolvedValue or fetchAt(m, readerAt(m, readerId).fetchId).phase == fetchRejectedValue)
pure def completeRead(m: MemoReads, readerId: str): MemoReads = { ...m, readers: m.readers.put(readerId, { ...readerAt(m, readerId), phase: if (fetchAt(m, readerAt(m, readerId).fetchId).phase == fetchResolvedValue) readServedValue else readFailedValue, observed: fetchAt(m, readerAt(m, readerId).fetchId).version }) }
pure def canCommitWrite(m: MemoReads, writerId: str): bool = writerId != "" and not(m.writerIds.includes(writerId))
pure def commitWrite(m: MemoReads, writerId: str): MemoReads = { ...m, durable: m.durable + 1, writerIds: m.writerIds.append(writerId), writers: m.writers.put(writerId, { phase: writeCommittedValue, version: m.durable + 1 }) }
pure def canInvalidateWrite(m: MemoReads, writerId: str): bool = m.writerIds.includes(writerId) and writerAt(m, writerId).phase == writeCommittedValue
pure def invalidateWrite(m: MemoReads, writerId: str): MemoReads = { ...m, memo: M::invalidateKey(m.memo, "query"), completed: if (m.completed > writerAt(m, writerId).version) m.completed else writerAt(m, writerId).version, writers: m.writers.put(writerId, { ...writerAt(m, writerId), phase: writeInvalidatedValue }) }
pure def invalidateResident(m: MemoReads): MemoReads = { ...m, memo: M::invalidateKey(m.memo, "query") }
pure def canDeliverRejection(m: MemoReads, observerId: int): bool = M::canObserveRejection(m.memo, observerId) and fetchAt(m, M::observerAt(m.memo, observerId).promiseId).phase == fetchRejectedValue
pure def deliverRejection(m: MemoReads, observerId: int): MemoReads = { ...m, memo: M::observeRejection(m.memo, observerId) }
pure val observerIdValues = Set(1, 2, 3, 4)
pure def canAdvanceMemoClock(m: MemoReads, now: int): bool = M::canAdvanceClock(m.memo, now)
pure def advanceMemoClock(m: MemoReads, now: int): MemoReads = { ...m, memo: M::advanceClock(m.memo, now) }
pure def alwaysMemoPolicy(m: MemoReads): bool = m.memo.configured and m.memo.ttl == 1000 and m.memo.capacity == 1000
pure def alwaysMemoOwnsCache(m: MemoReads): bool = M::alwaysUniqueEntryKeys(m.memo) and M::alwaysUniqueObserverIds(m.memo) and M::alwaysValidMemoIdentities(m.memo) and M::alwaysCapacityBound(m.memo)
pure def alwaysVersionOrder(m: MemoReads): bool = m.durable >= m.completed and m.completed >= 0 and m.serial >= 0
pure def alwaysFetchCaptureAfterFloor(m: MemoReads): bool = m.fetchIds.every(id => id > 0 and id <= m.serial and fetchAt(m, id).phase != fetchAbsentValue and fetchAt(m, id).floor >= 0 and fetchAt(m, id).floor <= m.completed and (fetchAt(m, id).captured implies fetchAt(m, id).version >= fetchAt(m, id).floor and fetchAt(m, id).version <= m.durable) and (fetchAt(m, id).phase == fetchResolvedValue implies fetchAt(m, id).captured))
pure def alwaysResidentUsesCurrentFloor(m: MemoReads): bool = residentPromise(m) == 0 or (m.fetchIds.includes(residentPromise(m)) and fetchAt(m, residentPromise(m)).floor == m.completed)
pure def alwaysReaderBoundToItsFetch(m: MemoReads): bool = m.readerIds.every(id => readerAt(m, id).phase != readAbsentValue and m.fetchIds.includes(readerAt(m, id).fetchId) and readerAt(m, id).floor >= 0 and readerAt(m, id).floor <= fetchAt(m, readerAt(m, id).fetchId).floor)
pure def alwaysServedReadMeetsFloor(m: MemoReads): bool = m.readerIds.every(id => readerAt(m, id).phase == readServedValue implies fetchAt(m, readerAt(m, id).fetchId).phase == fetchResolvedValue and readerAt(m, id).observed == fetchAt(m, readerAt(m, id).fetchId).version and readerAt(m, id).observed >= readerAt(m, id).floor)
pure def alwaysFailedReadHasRejectedFetch(m: MemoReads): bool = m.readerIds.every(id => readerAt(m, id).phase == readFailedValue implies fetchAt(m, readerAt(m, id).fetchId).phase == fetchRejectedValue)
pure def alwaysWriterVersion(m: MemoReads): bool = m.writerIds.every(id => writerAt(m, id).phase != writeAbsentValue and writerAt(m, id).version > 0 and writerAt(m, id).version <= m.durable and (writerAt(m, id).phase == writeInvalidatedValue implies writerAt(m, id).version <= m.completed))
pure def sometimesOldReaderSurvivesInvalidation(m: MemoReads): bool = m.readerIds.some(id => readerAt(m, id).phase == readServedValue and readerAt(m, id).observed < m.completed)
pure def sometimesReadAfterWrite(m: MemoReads): bool = m.readerIds.some(id => readerAt(m, id).phase == readServedValue and readerAt(m, id).floor > 0)
pure def sometimesSharedReaders(m: MemoReads): bool = m.readerIds.some(first => m.readerIds.some(second => first != second and readerAt(m, first).fetchId == readerAt(m, second).fetchId))
```

### Pending fetches and reader continuations finish under per-invocation fairness

The progress actions select the oldest eligible invocation from its
admission history. New admissions cannot overtake an already eligible
invocation. Each eligible phase leaves that phase after one progress
step. Rejection may settle a fetch before resolution and is delivered
to its observers separately. Fairness assumes the store read and write
continuations eventually settle; it does not assert that I/O succeeds.
The identity-specific transitions still model out-of-order completions.

```quint
pure def nextCaptureId(m: MemoReads): int = m.fetchIds.select(id => canCaptureFetch(m, id)).nthOr(0, 0)
pure def nextResolutionId(m: MemoReads): int = m.fetchIds.select(id => canResolveFetch(m, id)).nthOr(0, 0)
pure def nextReaderId(m: MemoReads): str = m.readerIds.select(id => canCompleteRead(m, id)).nthOr(0, "")
pure def nextWriterId(m: MemoReads): str = m.writerIds.select(id => canInvalidateWrite(m, id)).nthOr(0, "")
pure def canCaptureNextFetch(m: MemoReads): bool = canCaptureFetch(m, nextCaptureId(m))
pure def captureNextFetch(m: MemoReads): MemoReads = captureFetch(m, nextCaptureId(m))
pure def canResolveNextFetch(m: MemoReads): bool = canResolveFetch(m, nextResolutionId(m))
pure def resolveNextFetch(m: MemoReads): MemoReads = resolveFetch(m, nextResolutionId(m))
pure def canCompleteNextRead(m: MemoReads): bool = canCompleteRead(m, nextReaderId(m))
pure def completeNextRead(m: MemoReads): MemoReads = completeRead(m, nextReaderId(m))
pure def canInvalidateNextWrite(m: MemoReads): bool = canInvalidateWrite(m, nextWriterId(m))
pure def invalidateNextWrite(m: MemoReads): MemoReads = invalidateWrite(m, nextWriterId(m))
pure val fair_captureNextFetch = "weak"
pure val fair_resolveNextFetch = "weak"
pure val fair_completeNextRead = "weak"
pure val fair_invalidateNextWrite = "weak"
pure def leadsToReadersFinish(m: MemoReads, later: MemoReads): bool =
  m.readerIds.every(id => readerAt(m, id).phase == readWaitingValue implies readerAt(later, id).phase == readServedValue or readerAt(later, id).phase == readFailedValue)
pure def leadsToCommittedWritersInvalidate(m: MemoReads, later: MemoReads): bool =
  m.writerIds.every(id => writerAt(m, id).phase == writeCommittedValue implies writerAt(later, id).phase == writeInvalidatedValue)
```
