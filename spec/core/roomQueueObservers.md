# Room queue observers and idle waiters

The source is `packages/core/src/runtime/room-handler-queue.ts:131-207,268-342,610-671` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. This composition stores one authoritative room lease queue, plus the concrete RoomQueue object identities, quiescence promises and live telemetry listener set. Listener invocation is synchronous and may reenter admission only after the original slot has been reserved.


Discovered by the proof: each embedded machine must retain its complete safety
invariant before the composition can rely on that machine's transition lemmas.

## Story: Observe and drain room queues without racing their owners

As a caller I can await a room or the current set of rooms becoming idle. Each promise captures queue objects once and stays resolved even if later work arrives. Empty queues are pruned after the outer invocation's terminal telemetry finishes. Listener failure and diagnostic failure cannot change a handler result.

### Queue identities and idle promises follow actual admission and drain

Discovered by the proof: the next queue-object identity stays positive even
when the last room is removed. Admission uses zero to distinguish an absent
room from a live queue object. An errored handler preserves its error in the
call result. The telemetry record carries the error reference from which the
shell derives the message.

```quint
import concurrency as C from "./concurrency"
type QueueObject = {id: int, room: int}
type QueueCallPhase = QueuedCall | CancelNoticePending | SettledCall | FinalizedCall
type QueueCall = {id: int, room: int, queueId: int, phase: QueueCallPhase, terminalNotice: int, ok: bool, errorId: str}
type IdleWaiter = {id: int, pendingQueues: List[int], resolved: bool}
type QueueNoticeKind = EnqueuedNotice | CompletedNotice | CancelledNotice | ErroredNotice | SaturatedNotice
type QueueNotice = {id: int, kind: QueueNoticeKind, room: int, depth: int, errorId: str, cursor: int, invoking: bool, listener: int, finished: bool}
type QueueListener = {callback: int, generation: int, present: bool}
type RoomQueueObservers = {queue: C::RoomState, queues: List[QueueObject], calls: List[QueueCall], waiters: List[IdleWaiter], listeners: List[QueueListener], notices: List[QueueNotice], stack: List[int], nextQueue: int, nextNotice: int, nextListener: int, listenerErrors: int, diagnosticErrors: int}
pure val initial: RoomQueueObservers = {queue: C::initial, queues: List(), calls: List(), waiters: List(), listeners: List(), notices: List(), stack: List(), nextQueue: 1, nextNotice: 1, nextListener: 1, listenerErrors: 0, diagnosticErrors: 0}
pure val callerValues = C::callerValues
pure val roomValues = C::roomValues
pure val capacityValues = C::capacityValues
pure val maxPerRoomValues = C::maxPerRoomValues
pure val maxRoomsValues = C::maxRoomsValues
pure val waiterIdValues = Set(1, 2, 3)
pure val callbackValues = Set(1, 2, 3)
pure val errorIdValues = Set("handler-error", "caller-abort")
pure def pendingRoom(s: RoomQueueObservers, room: int): int = C::roomOccupancy(s.queue, room)
pure def queueObject(s: RoomQueueObservers, room: int): int = s.queues.select(q => q.room == room).nthOr(0, {id: 0, room: 0}).id
pure val noQueueCall: QueueCall = {id: 0, room: 0, queueId: 0, phase: FinalizedCall, terminalNotice: 0, ok: false, errorId: ""}
pure val noNotice: QueueNotice = {id: 0, kind: EnqueuedNotice, room: 0, depth: 0, errorId: "", cursor: 0, invoking: false, listener: 0, finished: true}
pure def noticeAt(s: RoomQueueObservers, noticeId: int): QueueNotice = s.notices.select(n => n.id == noticeId).nthOr(0, noNotice)
pure def topNotice(s: RoomQueueObservers): QueueNotice = noticeAt(s, s.stack.nthOr(s.stack.length() - 1, 0))
pure def mayReenter(s: RoomQueueObservers): bool = s.stack.length() == 0 or topNotice(s).invoking
pure def addNotice(kind: QueueNoticeKind, room: int, depth: int, errorId: str, s: RoomQueueObservers): RoomQueueObservers = { ...s, notices: s.notices.append({id: s.nextNotice, kind: kind, room: room, depth: depth, errorId: errorId, cursor: 0, invoking: false, listener: 0, finished: false}), stack: s.stack.append(s.nextNotice), nextNotice: s.nextNotice + 1 }
pure def canConfigure(s: RoomQueueObservers, capacity: int, maxPerRoom: int, maxRooms: int): bool = C::canConfigureRooms(s.queue, capacity, maxPerRoom, maxRooms)
pure def configure(s: RoomQueueObservers, capacity: int, maxPerRoom: int, maxRooms: int): RoomQueueObservers = { ...s, queue: C::configureRooms(s.queue, capacity, maxPerRoom, maxRooms) }
pure def canEnqueue(s: RoomQueueObservers, caller: int, room: int): bool = mayReenter(s) and not(s.calls.some(c => c.id == caller)) and C::canQueueRoom(s.queue, caller, room) and (queueObject(s, room) != 0 or s.queues.length() < s.queue.maxRooms)
pure def enqueue(s: RoomQueueObservers, caller: int, room: int): RoomQueueObservers = {
  val id = if (queueObject(s, room) == 0) s.nextQueue else queueObject(s, room)
  val queued = C::queueRoom(s.queue, caller, room)
  val reserved = if (C::canGrantRoom(queued, room)) C::grantRoom(queued, room) else queued
  addNotice(EnqueuedNotice, room, pendingRoom(s, room) + 1, "", { ...s, queue: reserved, queues: if (queueObject(s, room) == 0) s.queues.append({id: id, room: room}) else s.queues, nextQueue: s.nextQueue + (if (queueObject(s, room) == 0) 1 else 0), calls: s.calls.append({id: caller, room: room, queueId: id, phase: QueuedCall, terminalNotice: 0, ok: false, errorId: ""}) })
}
pure def canBeginWrite(s: RoomQueueObservers, caller: int, room: int): bool = C::canBeginWrite(s.queue, caller, room)
pure def beginWrite(s: RoomQueueObservers, caller: int, room: int): RoomQueueObservers = { ...s, queue: C::beginWrite(s.queue, caller, room) }
pure def canFinishWrite(s: RoomQueueObservers, caller: int, room: int): bool = C::canFinishWrite(s.queue, caller, room)
pure def finishWrite(s: RoomQueueObservers, caller: int, room: int): RoomQueueObservers = { ...s, queue: C::finishWrite(s.queue, caller, room) }
pure def canCloseWrites(s: RoomQueueObservers, caller: int, room: int): bool = C::canCloseWrites(s.queue, caller, room)
pure def closeWrites(s: RoomQueueObservers, caller: int, room: int): RoomQueueObservers = { ...s, queue: C::closeWrites(s.queue, caller, room) }
pure def idleForWaiter(w: IdleWaiter, queueId: int): IdleWaiter = {
  val remaining = w.pendingQueues.select(id => id != queueId)
  { ...w, pendingQueues: remaining, resolved: remaining.length() == 0 }
}
pure def canFinishWork(s: RoomQueueObservers, caller: int, room: int, ok: bool, errorId: str): bool = s.stack.length() == 0 and C::canReleaseRoom(s.queue, caller, room)
pure def finishWork(s: RoomQueueObservers, caller: int, room: int, ok: bool, errorId: str): RoomQueueObservers = {
  val released = C::releaseRoom(s.queue, caller, room)
  val advanced = if (C::canGrantRoom(released, room)) C::grantRoom(released, room) else released
  val idle = not(advanced.leases.some(l => l.room == room))
  val id = queueObject(s, room)
  val error = if (ok) "" else errorId
  addNotice(if (ok) CompletedNotice else ErroredNotice, room, 0, error, { ...s, queue: advanced, calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: SettledCall, terminalNotice: s.nextNotice, ok: ok, errorId: error } else c), waiters: if (idle) s.waiters.listMap(w => idleForWaiter(w, id)) else s.waiters })
}
pure def canCancelQueued(s: RoomQueueObservers, caller: int, room: int, errorId: str): bool = mayReenter(s) and s.queue.waiting.some(w => w.caller == caller and w.room == room)
pure def cancelQueued(s: RoomQueueObservers, caller: int, room: int, errorId: str): RoomQueueObservers = { ...s, queue: C::cancelQueued(s.queue, caller), calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: CancelNoticePending, errorId: errorId } else c) }
pure def canEmitQueuedCancellation(s: RoomQueueObservers, caller: int): bool = s.stack.length() == 0 and s.calls.some(c => c.id == caller and c.phase == CancelNoticePending)
pure def emitQueuedCancellation(s: RoomQueueObservers, caller: int): RoomQueueObservers = {
  val call = s.calls.select(c => c.id == caller).nthOr(0, noQueueCall)
  addNotice(CancelledNotice, call.room, 0, "", { ...s, calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: SettledCall, terminalNotice: s.nextNotice } else c) })
}
pure def canReportSaturated(s: RoomQueueObservers, room: int): bool = mayReenter(s) and s.queue.configured and not(s.queue.closed) and queueObject(s, room) != 0 and pendingRoom(s, room) >= s.queue.maxPerRoom and s.queue.waiting.length() + s.queue.leases.length() < s.queue.capacity
pure def reportSaturated(s: RoomQueueObservers, room: int): RoomQueueObservers = addNotice(SaturatedNotice, room, pendingRoom(s, room), "", s)
pure def canReportPreAborted(s: RoomQueueObservers, room: int): bool = mayReenter(s) and not(s.queue.closed)
pure def reportPreAborted(s: RoomQueueObservers, room: int): RoomQueueObservers = addNotice(CancelledNotice, room, 0, "", s)
pure def canAwaitIdle(s: RoomQueueObservers, waiterId: int, room: int, allRooms: bool): bool = mayReenter(s) and waiterId > 0 and not(s.waiters.some(w => w.id == waiterId))
pure def awaitIdle(s: RoomQueueObservers, waiterId: int, room: int, allRooms: bool): RoomQueueObservers = {
  val captured = s.queues.select(q => (allRooms or q.room == room) and pendingRoom(s, q.room) > 0).listMap(q => q.id)
  { ...s, waiters: s.waiters.append({id: waiterId, pendingQueues: captured, resolved: captured.length() == 0}) }
}
pure def canPruneFinishedCall(s: RoomQueueObservers, caller: int): bool = s.stack.length() == 0 and s.calls.some(c => c.id == caller and c.phase == SettledCall and noticeAt(s, c.terminalNotice).finished)
pure def pruneFinishedCall(s: RoomQueueObservers, caller: int): RoomQueueObservers = {
  val room = s.calls.select(c => c.id == caller).nthOr(0, noQueueCall).room
  { ...s, calls: s.calls.listMap(c => if (c.id == caller) { ...c, phase: FinalizedCall } else c), queues: if (pendingRoom(s, room) == 0) s.queues.select(q => q.room != room) else s.queues }
}
pure def canCloseAdmission(s: RoomQueueObservers): bool = C::canCloseRoomAdmission(s.queue)
pure def closeAdmission(s: RoomQueueObservers): RoomQueueObservers = { ...s, queue: C::closeRoomAdmission(s.queue) }
```

### Live telemetry observers finish nested emissions before resuming

Registration uses callback identity. A stale unsubscribe deletes the current registration of that callback. Removal skips an unvisited callback; remove-and-readd appends a new Set slot. Each listener failure invokes the diagnostic boundary once, and a diagnostic failure remains isolated.

```quint
pure def canSubscribe(s: RoomQueueObservers, callback: int): bool = mayReenter(s) and callback > 0
pure def subscribe(s: RoomQueueObservers, callback: int): RoomQueueObservers = if (s.listeners.some(l => l.callback == callback and l.present)) s else { ...s, listeners: s.listeners.append({callback: callback, generation: s.nextListener, present: true}), nextListener: s.nextListener + 1 }
pure def canUnsubscribe(s: RoomQueueObservers, callback: int): bool = mayReenter(s)
pure def unsubscribe(s: RoomQueueObservers, callback: int): RoomQueueObservers = { ...s, listeners: s.listeners.listMap(l => if (l.callback == callback) { ...l, present: false } else l) }
pure def nextListener(s: RoomQueueObservers): QueueListener = s.listeners.select(l => l.present and l.generation > topNotice(s).cursor).nthOr(0, {callback: 0, generation: 0, present: false})
pure def canBeginListener(s: RoomQueueObservers): bool = topNotice(s).id != 0 and not(topNotice(s).invoking) and nextListener(s).present
pure def beginListener(s: RoomQueueObservers): RoomQueueObservers = {
  val n = topNotice(s)
  val l = nextListener(s)
  { ...s, notices: s.notices.listMap(x => if (x.id == n.id) { ...x, cursor: l.generation, invoking: true, listener: l.callback } else x) }
}
pure def canEndListener(s: RoomQueueObservers, ok: bool, diagnosticOk: bool): bool = topNotice(s).id != 0 and topNotice(s).invoking
pure def endListener(s: RoomQueueObservers, ok: bool, diagnosticOk: bool): RoomQueueObservers = { ...s, listenerErrors: s.listenerErrors + (if (ok) 0 else 1), diagnosticErrors: s.diagnosticErrors + (if (not(ok) and not(diagnosticOk)) 1 else 0), notices: s.notices.listMap(n => if (n.id == topNotice(s).id) { ...n, invoking: false, listener: 0 } else n) }
pure def canFinishNotice(s: RoomQueueObservers): bool = topNotice(s).id != 0 and not(topNotice(s).invoking) and not(nextListener(s).present)
pure def finishNotice(s: RoomQueueObservers): RoomQueueObservers = { ...s, stack: s.stack.removeAt(s.stack.length() - 1), notices: s.notices.listMap(n => if (n.id == topNotice(s).id) { ...n, finished: true } else n) }
pure def alwaysQueueSafety(s: RoomQueueObservers): bool = C::alwaysRoomMutualExclusion(s.queue) and C::alwaysWaitersUnique(s.queue) and C::alwaysQueueBounded(s.queue) and C::alwaysWritesRetainLease(s.queue) and C::alwaysCancelledWaitersRemoved(s.queue) and C::alwaysAcquisitionOrdered(s.queue) and C::alwaysNoLeakedTerminalOwnership(s.queue) and C::alwaysRoomQueueDeadlockFree(s.queue)
pure def alwaysOneQueueObjectPerRoom(s: RoomQueueObservers): bool = s.nextQueue > 0 and s.queues.every(q => s.queues.select(other => other.room == q.room).length() == 1 and q.id > 0 and q.id < s.nextQueue)
pure def alwaysPendingWorkHasQueue(s: RoomQueueObservers): bool = s.queue.leases.every(l => queueObject(s, l.room) != 0) and s.queue.waiting.every(w => queueObject(s, w.room) != 0)
pure def alwaysWaiterResolutionAgrees(s: RoomQueueObservers): bool = s.waiters.every(w => w.resolved iff w.pendingQueues.length() == 0)
pure def stepResolvedWaitersStayResolved(before: RoomQueueObservers, after: RoomQueueObservers): bool = before.waiters.every(w => w.resolved implies after.waiters.some(other => other.id == w.id and other.resolved))
pure def sameQueue(first: C::RoomState, second: C::RoomState): bool = first.configured == second.configured and first.capacity == second.capacity and first.maxPerRoom == second.maxPerRoom and first.maxRooms == second.maxRooms and first.nextTicket == second.nextTicket and first.closed == second.closed and first.leases == second.leases and first.waiting == second.waiting and first.cancelled.subseteq(second.cancelled) and second.cancelled.subseteq(first.cancelled) and first.sealedCallers.subseteq(second.sealedCallers) and second.sealedCallers.subseteq(first.sealedCallers) and first.finishedCallers.subseteq(second.finishedCallers) and second.finishedCallers.subseteq(first.finishedCallers)
pure def stepTelemetryPreservesQueue(before: RoomQueueObservers, via: str, after: RoomQueueObservers): bool = (via == "beginListener" or via == "endListener" or via == "finishNotice") implies sameQueue(after.queue, before.queue)
pure def sometimesNestedQueueNotice(s: RoomQueueObservers): bool = s.stack.length() > 1
pure def sometimesIdleBeforePrune(s: RoomQueueObservers): bool = s.queues.some(q => pendingRoom(s, q.room) == 0) and s.waiters.some(w => w.resolved)
```
