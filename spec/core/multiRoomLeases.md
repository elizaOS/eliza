# Multiple-room lease transactions

[RoomHandlerQueue.withLeases](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/room-handler-queue.ts#L433-L484) acquires a deduplicated set of rooms, retains the acquired prefix on failure and releases it in reverse order. [Admission and lease release](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/room-handler-queue.ts#L269-L400) define rejection precedence and durable write settlement. [Legacy RoomHandlerQueue](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/RoomHandlerQueue.qnt) checks ordering, cycle avoidance and caller completion.

## Story: Own a room set through the callback and every admitted write

As a caller I acquire every requested room before entering my callback. If a later acquisition or the callback fails, my promise retains that failure and settles after the acquired leases release.

### Each transaction captures the sorted deduplicated room set

Positive room identities represent the ordering of source room strings by JavaScript code units. Batch identities denote unique invocation promises and, paired with a room, identify the only lease this invocation can hold for that room. The imported room queue owns the actual leases, FIFO tickets, write counts and admission limits. Batch position selects the next requested room. Released room IDs remain in the original request so that failure and completion can be attributed to the exact operation.

```quint
import concurrency as C from "./concurrency"
type BatchLeasePhase = BatchAcquiring | BatchWaiting | BatchInvoking | BatchReleasing | BatchDone
type BatchLeaseResult = BatchPending | BatchSucceeded | FailedClosed | FailedAbort | FailedRoomsLimit | FailedTotalLimit | FailedRoomLimit | FailedBody
type BatchLeaseCall = {id: int, wanted: List[int], position: int, phase: BatchLeasePhase, resultKind: BatchLeaseResult, errorRoom: int, cause: int, aborted: bool, abortCause: int}
type NestedLeaseResult = ReusedAmbient | ReusedExplicit | RefusedWidening
type NestedLeaseCall = {ambient: int, explicitOwner: int, explicitRoom: int, wanted: List[int], reused: List[int], resultKind: NestedLeaseResult}
type MultiRoomLeases = {queue: C::RoomState, calls: List[BatchLeaseCall], nested: List[NestedLeaseCall], closeCause: int}
pure val initial: MultiRoomLeases = {queue: C::initial, calls: List(), nested: List(), closeCause: 0}
pure val capacityValues = Set(2, 3, 4)
pure val maxRoomsValues = Set(1, 2)
pure val maxPerRoomValues = C::maxPerRoomValues
pure val callerValues = C::callerValues
pure val roomValues = C::roomValues
pure val explicitRoomValues = roomValues
pure val ambientValues = Set(0, 1, 2, 3)
pure val explicitOwnerValues = ambientValues
pure val requestedRoomsValues = Set(List(), List(1), List(2), List(1, 2), List(2, 1, 2))
pure val causeValues = Set(0, 1, 2)
pure val noLeaseCall: BatchLeaseCall = {id: 0, wanted: List(), position: 0, phase: BatchDone, resultKind: BatchPending, errorRoom: 0, cause: 0, aborted: false, abortCause: 0}
pure def insertRoom(ordered: List[int], room: int): List[int] = if (ordered.includes(room)) ordered else ordered.select(r => r < room).append(room).concat(ordered.select(r => r > room))
pure def orderedRooms(rooms: List[int]): List[int] = rooms.foldl(List(), (ordered, room) => insertRoom(ordered, room))
pure def batchAt(s: MultiRoomLeases, caller: int): BatchLeaseCall = s.calls.select(c => c.id == caller).nthOr(0, noLeaseCall)
pure def heldRooms(s: MultiRoomLeases, caller: int): List[int] = s.queue.leases.select(l => l.caller == caller).listMap(l => l.room)
pure def exposedBatch(s: MultiRoomLeases, caller: int): bool = {
  val c = batchAt(s, caller)
  c.id != 0 and c.position == c.wanted.length() and (c.phase == BatchInvoking or c.phase == BatchReleasing)
}
pure def ambientRooms(s: MultiRoomLeases, ambient: int): List[int] = if (exposedBatch(s, ambient)) s.queue.leases.select(l => l.caller == ambient and l.acceptingWrites).listMap(l => l.room) else List()
pure def wantedRoom(c: BatchLeaseCall): int = c.wanted.nthOr(c.position, 0)
pure def releaseRoomId(s: MultiRoomLeases, caller: int): int = heldRooms(s, caller).nthOr(heldRooms(s, caller).length() - 1, 0)
pure def canConfigure(s: MultiRoomLeases, capacity: int, maxPerRoom: int, maxRooms: int): bool = C::canConfigureRooms(s.queue, capacity, maxPerRoom, maxRooms)
pure def configure(s: MultiRoomLeases, capacity: int, maxPerRoom: int, maxRooms: int): MultiRoomLeases = { ...s, queue: C::configureRooms(s.queue, capacity, maxPerRoom, maxRooms) }
pure def canOpenBatch(s: MultiRoomLeases, caller: int, requestedRooms: List[int], ambient: int, explicitOwner: int): bool = s.queue.configured and caller > 0 and batchAt(s, caller).id == 0 and requestedRooms.every(r => r > 0) and (requestedRooms.length() == 0 or (ambientRooms(s, ambient).length() == 0 and explicitOwner == 0))
pure def openBatch(s: MultiRoomLeases, caller: int, requestedRooms: List[int], ambient: int, explicitOwner: int): MultiRoomLeases = { ...s, calls: s.calls.append({id: caller, wanted: orderedRooms(requestedRooms), position: 0, phase: if (requestedRooms.length() == 0) BatchInvoking else BatchAcquiring, resultKind: BatchPending, errorRoom: 0, cause: 0, aborted: false, abortCause: 0}) }
```

### The next admission either obtains a FIFO ticket or enters unwind

Closed admission takes precedence over a pre-aborted signal. Exhausting active rooms takes precedence over total and per-room capacity failure. The model uses occupied queue identities at the admission boundary; the separate queue-observer model exposes the empty-object interval around synchronous telemetry and pruning. Error cause denotes the original opaque failure identity. The first available FIFO slot is reserved synchronously, so a later signal cannot cancel it as a waiter.

```quint
pure def roomDepth(s: MultiRoomLeases, room: int): int = s.queue.leases.select(l => l.room == room).length() + s.queue.waiting.select(w => w.room == room).length()
pure def acquisitionFailure(s: MultiRoomLeases, c: BatchLeaseCall): BatchLeaseResult =
  if (s.queue.closed) FailedClosed
  else if (c.aborted) FailedAbort
  else if (not(C::activeRooms(s.queue).includes(wantedRoom(c))) and C::activeRooms(s.queue).length() >= s.queue.maxRooms) FailedRoomsLimit
  else if (s.queue.leases.length() + s.queue.waiting.length() >= s.queue.capacity) FailedTotalLimit
  else if (roomDepth(s, wantedRoom(c)) >= s.queue.maxPerRoom) FailedRoomLimit
  else BatchPending
pure def canAdvanceAcquisition(s: MultiRoomLeases, caller: int): bool = {
  val c = batchAt(s, caller)
  c.phase == BatchAcquiring and wantedRoom(c) > 0 and (acquisitionFailure(s, c) != BatchPending or C::canQueueRoom(s.queue, caller, wantedRoom(c)))
}
pure def grantAvailable(room: int, s: MultiRoomLeases): MultiRoomLeases = {
  val caller = s.queue.waiting.select(w => w.room == room).nthOr(0, {caller: 0, room: 0, ticket: 0}).caller
  if (C::canGrantRoom(s.queue, room)) { ...s, queue: C::grantRoom(s.queue, room), calls: s.calls.listMap(c => if (c.id == caller) { ...c, position: c.position + 1, phase: if (c.position + 1 == c.wanted.length()) BatchInvoking else BatchAcquiring } else c) }
  else s
}
pure def advanceAcquisition(s: MultiRoomLeases, caller: int): MultiRoomLeases = {
  val c = batchAt(s, caller)
  val room = wantedRoom(c)
  val failure = acquisitionFailure(s, c)
  if (failure == BatchPending) grantAvailable(room, { ...s, queue: C::queueRoom(s.queue, caller, room), calls: s.calls.listMap(x => if (x.id == caller) { ...x, phase: BatchWaiting } else x) })
  else { ...s, calls: s.calls.listMap(x => if (x.id == caller) { ...x, phase: BatchReleasing, resultKind: failure, errorRoom: room, cause: if (failure == FailedClosed) s.closeCause else if (failure == FailedAbort) c.abortCause else 0 } else x) }
}
pure def canAbortBatch(s: MultiRoomLeases, caller: int, cause: int): bool = {
  val c = batchAt(s, caller)
  cause > 0 and c.id != 0 and not(c.aborted) and c.phase != BatchDone and (c.phase != BatchWaiting or C::canCancelQueued(s.queue, caller))
}
pure def abortBatch(s: MultiRoomLeases, caller: int, cause: int): MultiRoomLeases = {
  val c = batchAt(s, caller)
  if (c.phase == BatchWaiting) { ...s, queue: C::cancelQueued(s.queue, caller), calls: s.calls.listMap(x => if (x.id == caller) { ...x, aborted: true, abortCause: cause, phase: BatchReleasing, resultKind: FailedAbort, errorRoom: wantedRoom(c), cause: cause } else x) }
  else { ...s, calls: s.calls.listMap(x => if (x.id == caller) { ...x, aborted: true, abortCause: cause } else x) }
}
pure def canCloseAdmission(s: MultiRoomLeases, cause: int): bool = C::canCloseRoomAdmission(s.queue) and cause > 0
pure def closeAdmission(s: MultiRoomLeases, cause: int): MultiRoomLeases = { ...s, queue: C::closeRoomAdmission(s.queue), closeCause: cause }
```

### A nested room request reuses the exact live subset or rejects widening

The host resolves ambient authority to the exact captured batch identity. Zero represents absent context, including explicit-only hosts. When every inherited lease has stopped accepting writes, the caller can enter a new top-level acquisition. For a nonempty nested request, live ambient authority takes precedence over the explicit lease argument. With no live ambient authority, an explicit lease can satisfy only a live singleton for its exact room. An invalid request yields `ROOM_HANDLER_CROSS_ROOM_REENTRY`; its parent keeps its authority and may catch the rejection. Empty requests run their callback with an empty lease map through the ordinary invocation transition.

```quint
pure def canResolveNested(s: MultiRoomLeases, requestedRooms: List[int], ambient: int, explicitOwner: int, explicitRoom: int): bool = requestedRooms.length() > 0 and requestedRooms.every(r => r > 0) and (ambientRooms(s, ambient).length() > 0 or explicitOwner > 0)
pure def resolveNested(s: MultiRoomLeases, requestedRooms: List[int], ambient: int, explicitOwner: int, explicitRoom: int): MultiRoomLeases = {
  val wanted = orderedRooms(requestedRooms)
  val live = ambientRooms(s, ambient)
  val reuseAmbient = live.length() > 0 and wanted.every(r => live.includes(r))
  val reuseExplicit = live.length() == 0 and wanted == List(explicitRoom) and exposedBatch(s, explicitOwner) and C::canReuseLease(s.queue, explicitOwner, explicitRoom)
  { ...s, nested: s.nested.append({ambient: ambient, explicitOwner: explicitOwner, explicitRoom: explicitRoom, wanted: wanted, reused: if (reuseAmbient or reuseExplicit) wanted else List(), resultKind: if (reuseAmbient) ReusedAmbient else if (reuseExplicit) ReusedExplicit else RefusedWidening}) }
}
pure def alwaysNestedReuseExact(s: MultiRoomLeases): bool = s.nested.every(n => if (n.resultKind == RefusedWidening) n.reused.length() == 0 else n.reused == n.wanted)
pure def stepNestedDoesNotAcquire(before: MultiRoomLeases, via: str, after: MultiRoomLeases): bool = via == "resolveNested" implies before.queue.leases == after.queue.leases and before.queue.waiting == after.queue.waiting
pure def sometimesNestedSubsetReused(s: MultiRoomLeases): bool = s.nested.some(n => n.resultKind == ReusedAmbient)
pure def sometimesNestedWideningRejected(s: MultiRoomLeases): bool = s.nested.some(n => n.resultKind == RefusedWidening and n.ambient != 0 and n.explicitOwner == 0)
pure def sometimesOpposingRequestsCoexist(s: MultiRoomLeases): bool = s.calls.some(a => a.wanted.length() > 1 and a.phase == BatchWaiting and s.calls.some(b => b.id != a.id and b.wanted == a.wanted and heldRooms(s, b.id).length() > 0))
```

### Release drains the held prefix from its highest room downward

Each release closes write admission for the highest still-held room, waits for its admitted writes to settle, and releases that room before touching the next. Failure after partial acquisition uses the same sequence. No success or error is observable from the batch promise before that sequence completes.

```quint
pure def canReturnBody(s: MultiRoomLeases, caller: int, cause: int): bool = batchAt(s, caller).phase == BatchInvoking and cause >= 0
pure def returnBody(s: MultiRoomLeases, caller: int, cause: int): MultiRoomLeases = { ...s, calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: BatchReleasing, resultKind: if (cause == 0) BatchSucceeded else FailedBody, cause: cause } else c) }
pure def canBeginWrite(s: MultiRoomLeases, caller: int, room: int): bool = exposedBatch(s, caller) and C::canBeginWrite(s.queue, caller, room)
pure def beginWrite(s: MultiRoomLeases, caller: int, room: int): MultiRoomLeases = { ...s, queue: C::beginWrite(s.queue, caller, room) }
pure def canFinishWrite(s: MultiRoomLeases, caller: int, room: int): bool = C::canFinishWrite(s.queue, caller, room)
pure def finishWrite(s: MultiRoomLeases, caller: int, room: int): MultiRoomLeases = { ...s, queue: C::finishWrite(s.queue, caller, room) }
pure def canCloseBatchWrites(s: MultiRoomLeases, caller: int): bool = batchAt(s, caller).phase == BatchReleasing and C::canCloseWrites(s.queue, caller, releaseRoomId(s, caller))
pure def closeBatchWrites(s: MultiRoomLeases, caller: int): MultiRoomLeases = { ...s, queue: C::closeWrites(s.queue, caller, releaseRoomId(s, caller)) }
pure def canReleaseBatchRoom(s: MultiRoomLeases, caller: int): bool = batchAt(s, caller).phase == BatchReleasing and C::canReleaseRoom(s.queue, caller, releaseRoomId(s, caller))
pure def releaseBatchRoom(s: MultiRoomLeases, caller: int): MultiRoomLeases = {
  val room = releaseRoomId(s, caller)
  grantAvailable(room, { ...s, queue: C::releaseRoom(s.queue, caller, room) })
}
pure def canFinishBatch(s: MultiRoomLeases, caller: int): bool = batchAt(s, caller).phase == BatchReleasing and heldRooms(s, caller).length() == 0 and not(s.queue.waiting.some(w => w.caller == caller))
pure def finishBatch(s: MultiRoomLeases, caller: int): MultiRoomLeases = { ...s, calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: BatchDone } else c) }
pure def alwaysQueueInvariant(s: MultiRoomLeases): bool = C::alwaysRoomMutualExclusion(s.queue) and C::alwaysQueueBounded(s.queue) and C::alwaysWaitersUnique(s.queue) and C::alwaysWritesRetainLease(s.queue) and C::alwaysCancelledWaitersRemoved(s.queue) and C::alwaysAcquisitionOrdered(s.queue) and C::alwaysNoLeakedTerminalOwnership(s.queue) and C::alwaysRoomQueueDeadlockFree(s.queue)
pure def alwaysBatchIdentitiesUnique(s: MultiRoomLeases): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
pure def alwaysBatchesHaveValidPosition(s: MultiRoomLeases): bool = s.calls.every(c => 0 <= c.position and c.position <= c.wanted.length())
pure def alwaysLeasesBelongToBatch(s: MultiRoomLeases): bool = s.queue.leases.every(l => s.calls.some(c => c.id == l.caller and c.phase != BatchDone and c.wanted.includes(l.room)))
pure def alwaysInvocationHoldsAllRooms(s: MultiRoomLeases): bool = s.calls.every(c => c.phase == BatchInvoking implies heldRooms(s, c.id) == c.wanted and c.position == c.wanted.length())
pure def alwaysWaiterMatchesNextRoom(s: MultiRoomLeases): bool = s.queue.waiting.every(w => batchAt(s, w.caller).phase == BatchWaiting and wantedRoom(batchAt(s, w.caller)) == w.room) and s.calls.every(c => c.phase == BatchWaiting implies s.queue.waiting.some(w => w.caller == c.id and w.room == wantedRoom(c)))
pure def alwaysWaiterHasOwner(s: MultiRoomLeases): bool = s.queue.waiting.every(w => s.queue.leases.some(l => l.room == w.room))
pure def alwaysWaitsAboveHeldRooms(s: MultiRoomLeases): bool = s.calls.every(c => c.phase == BatchAcquiring or c.phase == BatchWaiting implies wantedRoom(c) > 0 and heldRooms(s, c.id).every(r => r < wantedRoom(c)))
pure def alwaysDoneHasNoLease(s: MultiRoomLeases): bool = s.calls.every(c => c.phase == BatchDone implies heldRooms(s, c.id).length() == 0 and not(s.queue.waiting.some(w => w.caller == c.id)) and c.resultKind != BatchPending)
pure def stepReleasedAfterWriteSettlement(before: MultiRoomLeases, after: MultiRoomLeases): bool = C::stepReleasedLeaseIsSettled(before.queue, after.queue) and before.queue.leases.every(l => after.queue.leases.some(a => a.caller == l.caller and a.room == l.room) or batchAt(before, l.caller).phase == BatchReleasing)
pure def stepClosedAdmissionCannotGrow(before: MultiRoomLeases, after: MultiRoomLeases): bool = before.queue.closed implies after.queue.waiting.every(w => before.queue.waiting.includes(w))
pure def sometimesAcquisitionFailureUnwinds(s: MultiRoomLeases): bool = s.calls.some(c => c.phase == BatchReleasing and c.errorRoom > 0 and heldRooms(s, c.id).length() > 0)
pure def sometimesBodyFailureFullyUnwound(s: MultiRoomLeases): bool = s.calls.some(c => c.phase == BatchDone and c.resultKind == FailedBody and c.wanted.length() > 1)
```

### Admitted batches progress under fair host settlement

The FIFO queue reserves the next waiting room owner when the current lease releases. Fair settlement of callback bodies and admitted writer promises is an environment obligation. Scheduler witnesses select actual eligible calls and closing writes in retention order. Explicit host callbacks may still settle any eligible addressed invocation or writer. Each closing room's finite writer tail must drain. Batch identities remain in their terminal phase. Awaiting a higher rank than every held room rules out wait cycles across owners by strict ascent around the proposed cycle.

```quint
pure def closingWriter(s: MultiRoomLeases): C::Lease = s.queue.leases.select(l => not(l.acceptingWrites) and l.writes > 0).nthOr(0, {caller: 0, room: 0, acceptingWrites: false, writes: 0})
pure def canFinishNextClosingWrite(s: MultiRoomLeases): bool = canFinishWrite(s, closingWriter(s).caller, closingWriter(s).room)
pure def finishNextClosingWrite(s: MultiRoomLeases): MultiRoomLeases = finishWrite(s, closingWriter(s).caller, closingWriter(s).room)
pure def nextAcquisition(s: MultiRoomLeases): int = s.calls.select(c => canAdvanceAcquisition(s, c.id)).nthOr(0, noLeaseCall).id
pure def canAdvanceNextAcquisition(s: MultiRoomLeases): bool = canAdvanceAcquisition(s, nextAcquisition(s))
pure def advanceNextAcquisition(s: MultiRoomLeases): MultiRoomLeases = advanceAcquisition(s, nextAcquisition(s))
pure def nextBody(s: MultiRoomLeases): int = s.calls.select(c => canReturnBody(s, c.id, 0)).nthOr(0, noLeaseCall).id
pure def canReturnNextBody(s: MultiRoomLeases, cause: int): bool = canReturnBody(s, nextBody(s), cause)
pure def returnNextBody(s: MultiRoomLeases, cause: int): MultiRoomLeases = returnBody(s, nextBody(s), cause)
pure def nextWriteClosure(s: MultiRoomLeases): int = s.calls.select(c => canCloseBatchWrites(s, c.id)).nthOr(0, noLeaseCall).id
pure def canCloseNextBatchWrites(s: MultiRoomLeases): bool = canCloseBatchWrites(s, nextWriteClosure(s))
pure def closeNextBatchWrites(s: MultiRoomLeases): MultiRoomLeases = closeBatchWrites(s, nextWriteClosure(s))
pure def nextRelease(s: MultiRoomLeases): int = s.calls.select(c => canReleaseBatchRoom(s, c.id)).nthOr(0, noLeaseCall).id
pure def canReleaseNextBatchRoom(s: MultiRoomLeases): bool = canReleaseBatchRoom(s, nextRelease(s))
pure def releaseNextBatchRoom(s: MultiRoomLeases): MultiRoomLeases = releaseBatchRoom(s, nextRelease(s))
pure def nextFinishedBatch(s: MultiRoomLeases): int = s.calls.select(c => canFinishBatch(s, c.id)).nthOr(0, noLeaseCall).id
pure def canFinishNextBatch(s: MultiRoomLeases): bool = canFinishBatch(s, nextFinishedBatch(s))
pure def finishNextBatch(s: MultiRoomLeases): MultiRoomLeases = finishBatch(s, nextFinishedBatch(s))
pure val fair_finishNextClosingWrite = "weak"
pure val fair_advanceNextAcquisition = "weak"
pure val fair_returnNextBody = "weak"
pure val fair_closeNextBatchWrites = "weak"
pure val fair_releaseNextBatchRoom = "weak"
pure val fair_finishNextBatch = "weak"
pure def leadsToWaiterLeavesQueue(s: MultiRoomLeases, later: MultiRoomLeases): bool = C::leadsToQueuedCallersServed(s.queue, later.queue)
pure def leadsToEveryBatchFinishes(s: MultiRoomLeases, later: MultiRoomLeases): bool = s.calls.every(c => batchAt(later, c.id).phase == BatchDone)
pure def batchTerminal(s: MultiRoomLeases): bool = s.calls.every(c => c.phase == BatchDone) and C::roomQueueQuiescent(s.queue)
pure def batchProgressEnabled(s: MultiRoomLeases): bool = canFinishNextClosingWrite(s) or canAdvanceNextAcquisition(s) or canReturnNextBody(s, 0) or canCloseNextBatchWrites(s) or canReleaseNextBatchRoom(s) or canFinishNextBatch(s)
pure def alwaysBatchProgressOrTerminal(s: MultiRoomLeases): bool = batchTerminal(s) or batchProgressEnabled(s)
```
