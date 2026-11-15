# Shared agent runtime

A shared room serves many readers from one hosted runtime. It loads the
room's history once in the background, answers each reader by a warming
deadline whether or not the load has finished, and keeps an interrupted
turn in the history before anyone reads it. One room is the state machine.
The in-memory cache the runtime uses is a boundary stated as laws.

Develop sources: the cloud `SharedHistoryHydration`,
`SharedInterruptedTurn` and `in_memory_lru` models.

## Story: Serve readers while the room's history loads

> As a member of a shared room, I want an answer by the warming deadline,
> and once the history has loaded, every answer built on all of it.

### The room admits one waiting reader at a time and loads its history once

The room is serialized: a reader is admitted only when no other reader is
waiting and no stream holds the room. A reader that finds no history and no
lookup running starts one; a failed lookup leaves the next reader to start
another. Once the history is ready, a reader is served at once with all of
it.

```quint
type HistoryLoad = HistoryEmpty | HistoryReading | HistoryReady
type TurnPhase = RoomOpen | TurnStreaming | TurnCheckpointing | TurnPersisted | RoomReloading | RoomClosed
type FinalizerState = FinalizerIdle | FinalizerPending | FinalizerSettled | FinalizerFailed | FinalizerRetired
type SharedRoom = { load: HistoryLoad, requests: int, replies: int, served: int, attempts: int, historyLoaded: bool, turn: TurnPhase, streams: int, generation: int, archived: bool, finalizer: FinalizerState, readGeneration: int, readSawInterrupted: bool }
pure val initial: SharedRoom = { load: HistoryEmpty, requests: 0, replies: 0, served: 0, attempts: 0, historyLoaded: false, turn: RoomOpen, streams: 0, generation: 1, archived: false, finalizer: FinalizerIdle, readGeneration: 0, readSawInterrupted: false }
pure def readerWaiting(r: SharedRoom): bool = r.requests != r.replies
pure def canAdmitReader(r: SharedRoom): bool = not(readerWaiting(r)) and r.turn == RoomOpen
pure def admitReader(r: SharedRoom): SharedRoom =
  if (r.load == HistoryReady) { ...r, requests: r.requests + 1, replies: r.replies + 1, served: r.served + 1 }
  else if (r.load == HistoryReading) { ...r, requests: r.requests + 1 }
  else { ...r, load: HistoryReading, requests: r.requests + 1, attempts: r.attempts + 1 }
pure def canLoadReply(r: SharedRoom, success: bool): bool = r.load == HistoryReading
pure def loadReply(r: SharedRoom, success: bool): SharedRoom = if (success) { ...r, load: HistoryReady, historyLoaded: true } else { ...r, load: HistoryEmpty }
pure def alwaysOneWaitingReader(r: SharedRoom): bool = r.replies >= 0 and r.replies <= r.requests and r.requests <= r.replies + 1 and r.served >= 0 and r.served <= r.replies and r.attempts >= 0
pure def alwaysReadyMeansLoaded(r: SharedRoom): bool = (r.load == HistoryReady) == r.historyLoaded and (r.served > 0 implies r.historyLoaded)
pure def alwaysWaitingReaderHasALookup(r: SharedRoom): bool = r.load == HistoryReading implies r.attempts >= 1
pure def sometimesReaderServedWithHistory(r: SharedRoom): bool = r.served >= 2
```

### A reader is answered by the deadline and the lookup keeps running

A waiting reader is answered when the lookup settles, served if it
succeeded. If the warming deadline comes first, the reader is answered
without the history and the lookup goes on, so the next reader can use it.

```quint
pure def canReplyReader(r: SharedRoom): bool = readerWaiting(r) and r.load != HistoryReading
pure def replyReader(r: SharedRoom): SharedRoom = { ...r, replies: r.replies + 1, served: r.served + (if (r.load == HistoryReady) 1 else 0) }
pure def canWarmingDeadline(r: SharedRoom): bool = readerWaiting(r) and r.load == HistoryReading
pure def warmingDeadline(r: SharedRoom): SharedRoom = { ...r, replies: r.replies + 1 }
pure def stepDeadlineKeepsTheLookup(before: SharedRoom, via: str, after: SharedRoom): bool =
  via == "warmingDeadline" implies (after.load == HistoryReading and after.attempts == before.attempts)
pure def sometimesDeadlineAnsweredBeforeLoad(r: SharedRoom): bool = r.replies > r.served and r.historyLoaded
pure val fair_replyReader = "weak"
pure val fair_warmingDeadline = "weak"
pure def leadsToReaderAnswered(r: SharedRoom, later: SharedRoom): bool = readerWaiting(r) implies later.replies >= r.requests
```

## Story: Keep an interrupted turn in the shared history

> As a member of a shared room, when a reply is cut off, I want my words and
> the partial reply, marked interrupted, in the history the next reader sees,
> even after the room is reloaded.

### A cancelled stream holds the room until its turn is checkpointed

One stream at a time holds the room. When it is cancelled, the room stays
held while the exact user text and the partial reply, marked interrupted,
are written to the durable checkpoint. Only a written checkpoint releases
the room; a failed checkpoint closes it. The stream's finalizer settles on
its own and never gates the release.

```quint
pure def canStartStream(r: SharedRoom): bool = r.turn == RoomOpen and r.streams == 0 and not(readerWaiting(r))
pure def startStream(r: SharedRoom): SharedRoom = { ...r, turn: TurnStreaming, streams: 1 }
pure def canFinishStream(r: SharedRoom): bool = r.turn == TurnStreaming
pure def finishStream(r: SharedRoom): SharedRoom = { ...r, turn: RoomOpen }
pure def canCancelStream(r: SharedRoom): bool = r.turn == TurnStreaming
pure def cancelStream(r: SharedRoom): SharedRoom = { ...r, turn: TurnCheckpointing, finalizer: FinalizerPending }
pure def canCheckpointReply(r: SharedRoom, success: bool): bool = r.turn == TurnCheckpointing
pure def checkpointReply(r: SharedRoom, success: bool): SharedRoom = if (success) { ...r, turn: TurnPersisted, archived: true } else { ...r, turn: RoomClosed }
pure def canReleaseRoom(r: SharedRoom): bool = r.turn == TurnPersisted
pure def releaseRoom(r: SharedRoom): SharedRoom = { ...r, turn: RoomOpen }
pure def canFinalizeReply(r: SharedRoom, success: bool): bool = r.finalizer == FinalizerPending
pure def finalizeReply(r: SharedRoom, success: bool): SharedRoom = { ...r, finalizer: if (success) FinalizerSettled else FinalizerFailed }
pure def alwaysPersistedTurnIsArchived(r: SharedRoom): bool = r.turn == TurnPersisted implies r.archived
pure def stepFailedCheckpointArchivesNothing(before: SharedRoom, after: SharedRoom): bool =
  (before.turn == TurnCheckpointing and after.turn == RoomClosed) implies after.archived == before.archived
pure def alwaysHeldRoomHasNoWaitingReader(r: SharedRoom): bool = (r.turn == TurnStreaming or r.turn == TurnCheckpointing or r.turn == TurnPersisted) implies not(readerWaiting(r))
pure def stepCheckpointIsDurable(before: SharedRoom, after: SharedRoom): bool = before.archived implies after.archived
pure def sometimesRoomReleasedWhileFinalizerPending(r: SharedRoom): bool = r.turn == RoomOpen and r.archived and r.finalizer == FinalizerPending
pure def sometimesFailedCheckpointClosesRoom(r: SharedRoom): bool = r.turn == RoomClosed
```

### A reloaded room reads the checkpoint, not its lost memory

Evicting an open room starts a new generation and retires a finalizer that
has not settled. A reader of a reloaded generation reads the history from
the durable checkpoint, so it sees an interrupted turn exactly when one was
checkpointed.

```quint
pure def canEvictRoom(r: SharedRoom): bool = r.turn == RoomOpen and not(readerWaiting(r))
pure def evictRoom(r: SharedRoom): SharedRoom = { ...r, turn: RoomReloading, generation: r.generation + 1, finalizer: if (r.finalizer == FinalizerPending) FinalizerRetired else r.finalizer }
pure def canReloadRoom(r: SharedRoom): bool = r.turn == RoomReloading
pure def reloadRoom(r: SharedRoom): SharedRoom = { ...r, turn: RoomOpen }
pure def canReadHistory(r: SharedRoom): bool = r.turn == RoomOpen and r.readGeneration != r.generation
pure def readHistory(r: SharedRoom): SharedRoom = { ...r, readGeneration: r.generation, readSawInterrupted: r.archived }
pure def alwaysRetiredFinalizerOnlyAfterEviction(r: SharedRoom): bool = r.finalizer == FinalizerRetired implies r.generation > 1
pure def stepReloadedReaderSeesTheCheckpoint(before: SharedRoom, via: str, after: SharedRoom): bool =
  (via == "readHistory" and after.generation > 1) implies after.readSawInterrupted == before.archived
pure def sometimesReloadedReaderSeesInterruptedTurn(r: SharedRoom): bool = r.readGeneration > 1 and r.readSawInterrupted
pure val fair_reloadRoom = "weak"
pure def leadsToReloadedRoomOpens(r: SharedRoom, later: SharedRoom): bool = r.turn == RoomReloading implies later.turn == RoomOpen
```

## Story: Keep the runtime's memory cache bounded

> As an operator, I want the runtime's in-memory cache to stay within its
> capacity and to keep the entries it was just asked for.

### The cache keeps at most four entries and evicts the least recently used

Writing a key moves it to the newest position; a new key evicts the oldest
entry when the cache is full; rewriting a cached key evicts nothing. Reading
a cached key makes it the newest.

```quint
pure val lruCapacity = 4
pure def distinctKeys(order: List[int]): bool = order.foldl(true, (ok, k) => ok and order.select(other => other == k).length() == 1)
pure def lruWrite(order: List[int], key: int): List[int] = {
  val without = order.select(k => k != key)
  (if (without.length() >= lruCapacity) without.tail() else without).append(key)
}
pure def lruRead(order: List[int], key: int): List[int] = if (order.select(k => k == key).length() > 0) order.select(k => k != key).append(key) else order
pure def lawLruStaysWithinCapacity(order: List[int], key: int): bool = order.length() <= lruCapacity implies lruWrite(order, key).length() <= lruCapacity
pure def lawWrittenKeyIsNewest(order: List[int], key: int): bool = lruWrite(order, key).nthOr(lruWrite(order, key).length() - 1, -1) == key
pure def lawRewriteEvictsNothing(order: List[int], key: int): bool =
  (distinctKeys(order) and order.length() <= lruCapacity and order.select(k => k == key).length() == 1) implies
    (lruWrite(order, key).length() == order.length() and order.foldl(true, (ok, k) => ok and lruWrite(order, key).select(other => other == k).length() == 1))
pure def lawReadKeepsEveryEntry(order: List[int], key: int): bool = distinctKeys(order) implies lruRead(order, key).length() == order.length()
```
