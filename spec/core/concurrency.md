# Room leases and durable writes

Room handler ownership serializes durable effects. Multiple-room requests acquire ascending room IDs and release in reverse order. Sources include [room-handler-queue.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/room-handler-queue.ts) and [RoomHandlerQueue.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/RoomHandlerQueue.qnt). Capacity is a host configuration input.

## Story: Own each room through durable settlement

As a caller I acquire room leases in a deadlock-free order and keep them while admitted writes settle.

### Room leases admit bounded FIFO requests and one owner per room

The host supplies capacity. An already-held room is reentrant through the existing owner, while a new room must follow ascending acquisition order.

Discovered by the proof: an unconfigured queue has no leases or waiters. Configuration therefore cannot reduce limits beneath already-admitted work; all admission requires configuration first. Ticket allocation starts positive, remains positive and never assigns the same ticket to two waiting callers.

The active-room view is a list without duplicate IDs. Its membership and length
represent the set of active source room identities; the ordering has no effect on admission.

```quint
type Lease = { caller: int, room: int, acceptingWrites: bool, writes: int }
type RoomWaiter = { caller: int, room: int, ticket: int }
type RoomState = { configured: bool, capacity: int, maxPerRoom: int, maxRooms: int, nextTicket: int, closed: bool, leases: List[Lease], waiting: List[RoomWaiter], cancelled: Set[int], sealedCallers: Set[int], finishedCallers: Set[int] }
pure val initial: RoomState = { configured: false, capacity: 0, maxPerRoom: 0, maxRooms: 0, nextTicket: 1, closed: false, leases: List(), waiting: List(), cancelled: Set(), sealedCallers: Set(), finishedCallers: Set() }
pure val capacityValues = Set(2, 3)
pure val callerValues = Set(1, 2, 3)
pure val roomValues = Set(1, 2)
pure def canConfigureRooms(s: RoomState, capacity: int, maxPerRoom: int, maxRooms: int): bool = not(s.configured) and capacity > 0 and maxPerRoom > 0 and maxRooms > 0
pure def configureRooms(s: RoomState, capacity: int, maxPerRoom: int, maxRooms: int): RoomState = { ...s, configured: true, capacity: capacity, maxPerRoom: maxPerRoom, maxRooms: maxRooms }
pure val maxPerRoomValues = Set(1, 2)
pure val maxRoomsValues = Set(1, 2)
pure def activeRoomIds(s: RoomState): List[int] = s.leases.listMap(l => l.room).concat(s.waiting.listMap(w => w.room))
pure def activeRooms(s: RoomState): List[int] = activeRoomIds(s).foldl(List(), (rooms, room) => if (rooms.includes(room)) rooms else rooms.append(room))
pure def canReuseLease(s: RoomState, caller: int, room: int): bool = s.leases.some(l => l.caller == caller and l.room == room and l.acceptingWrites)
pure def reuseLease(s: RoomState, caller: int, room: int): RoomState = s
pure def canQueueRoom(s: RoomState, caller: int, room: int): bool = s.configured and not(s.closed) and caller > 0 and room > 0 and not(s.cancelled.contains(caller)) and not(s.sealedCallers.contains(caller)) and not(s.finishedCallers.contains(caller)) and s.waiting.length() + s.leases.length() < s.capacity and not(s.waiting.some(w => w.caller == caller)) and s.leases.every(l => l.caller != caller or l.room < room) and s.waiting.select(w => w.room == room).length() + s.leases.select(l => l.room == room).length() < s.maxPerRoom and (activeRooms(s).includes(room) or activeRooms(s).length() < s.maxRooms)
pure def queueRoom(s: RoomState, caller: int, room: int): RoomState = { ...s, waiting: s.waiting.append({caller: caller, room: room, ticket: s.nextTicket}), nextTicket: s.nextTicket + 1 }
pure def canGrantRoom(s: RoomState, room: int): bool = not(s.leases.some(l => l.room == room)) and s.waiting.some(w => w.room == room)
pure def grantRoom(s: RoomState, room: int): RoomState = {
  val grant = s.waiting.select(w => w.room == room).nthOr(0, {caller: 0, room: 0, ticket: 0})
  { ...s, waiting: s.waiting.select(w => w.ticket != grant.ticket), leases: s.leases.append({caller: grant.caller, room: room, acceptingWrites: true, writes: 0}) }
}
pure def alwaysRoomMutualExclusion(s: RoomState): bool = s.leases.every(l => s.leases.select(x => x.room == l.room).length() == 1)
pure def alwaysQueueBounded(s: RoomState): bool = (s.configured or (s.waiting.length() == 0 and s.leases.length() == 0)) and s.capacity >= 0 and s.waiting.length() + s.leases.length() <= s.capacity and activeRooms(s).length() <= s.maxRooms and activeRooms(s).every(room => s.waiting.select(w => w.room == room).length() + s.leases.select(l => l.room == room).length() <= s.maxPerRoom)
pure def alwaysWaitersUnique(s: RoomState): bool = s.nextTicket > 0 and s.waiting.every(w => w.caller > 0 and w.room > 0 and w.ticket > 0 and w.ticket < s.nextTicket and s.waiting.select(x => x.caller == w.caller).length() == 1 and s.waiting.select(x => x.ticket == w.ticket).length() == 1)
pure def sometimesOtherRoomsProceed(s: RoomState): bool = s.leases.length() > 1 and s.leases.some(a => s.leases.some(b => a.room != b.room and a.caller != b.caller))
```

### Release closes write admission and waits for every admitted write

Queued cancellation removes the waiter. A lease already acquired remains owned until its write count reaches zero.

```quint
pure def canBeginWrite(s: RoomState, caller: int, room: int): bool = s.leases.some(l => l.caller == caller and l.room == room and l.acceptingWrites)
pure def beginWrite(s: RoomState, caller: int, room: int): RoomState = { ...s, leases: s.leases.listMap(l => if (l.caller == caller and l.room == room) { ...l, writes: l.writes + 1 } else l) }
pure def canFinishWrite(s: RoomState, caller: int, room: int): bool = s.leases.some(l => l.caller == caller and l.room == room and l.writes > 0)
pure def finishWrite(s: RoomState, caller: int, room: int): RoomState = { ...s, leases: s.leases.listMap(l => if (l.caller == caller and l.room == room) { ...l, writes: l.writes - 1 } else l) }
pure def canCloseWrites(s: RoomState, caller: int, room: int): bool = s.leases.some(l => l.caller == caller and l.room == room and l.acceptingWrites)
pure def closeWrites(s: RoomState, caller: int, room: int): RoomState = { ...s, leases: s.leases.listMap(l => if (l.caller == caller and l.room == room) { ...l, acceptingWrites: false } else l) }
pure def canReleaseRoom(s: RoomState, caller: int, room: int): bool = s.leases.some(l => l.caller == caller and l.room == room and not(l.acceptingWrites) and l.writes == 0) and s.leases.every(l => l.caller != caller or l.room <= room)
pure def releaseRoom(s: RoomState, caller: int, room: int): RoomState = { ...s, leases: s.leases.select(l => l.caller != caller or l.room != room) }
pure def canCancelQueued(s: RoomState, caller: int): bool = s.waiting.some(w => w.caller == caller)
pure def cancelQueued(s: RoomState, caller: int): RoomState = { ...s, waiting: s.waiting.select(w => w.caller != caller), cancelled: s.cancelled.union(Set(caller)) }
pure def canCloseRoomAdmission(s: RoomState): bool = not(s.closed)
pure def closeRoomAdmission(s: RoomState): RoomState = { ...s, closed: true }
pure def alwaysWritesRetainLease(s: RoomState): bool = s.leases.every(l => l.writes >= 0)
pure def alwaysCancelledWaitersRemoved(s: RoomState): bool = s.waiting.every(w => not(s.cancelled.contains(w.caller)))
pure def stepClosedQueueCannotGrow(before: RoomState, after: RoomState): bool = before.closed implies after.waiting.length() <= before.waiting.length()
pure def sometimesPendingWritePreventsRelease(s: RoomState): bool = s.leases.some(l => l.writes > 0 and not(l.acceptingWrites) and not(canReleaseRoom(s, l.caller, l.room)))
pure def sometimesAllRoomsDrained(s: RoomState): bool = s.closed and s.leases.length() == 0 and s.waiting.length() == 0 and s.nextTicket > 1
```

### A closed room queue eventually becomes quiescent under fair owner completion

Each owner finishes its writes, closes write admission and releases its leases. Waiting requests receive fair room grants or cancellation.

```quint
pure val fair_grantRoom = "strong"
pure val fair_finishWrite = "weak"
pure val fair_closeWrites = "weak"
pure val fair_releaseRoom = "weak"
pure def leadsToRoomQuiescence(s: RoomState, later: RoomState): bool = s.closed implies (later.waiting.length() == 0 and later.leases.length() == 0)
```

### Ownership can be released only after its admitted writes settle

Every lease removed by a transition has already closed write admission and settled its write count.

```quint
pure def stepReleasedLeaseIsSettled(before: RoomState, after: RoomState): bool = before.leases.every(l => after.leases.some(other => other.room == l.room and other.caller == l.caller) or (not(l.acceptingWrites) and l.writes == 0))
pure def alwaysAcquisitionOrdered(s: RoomState): bool = s.waiting.every(w => s.leases.every(l => l.caller != w.caller or l.room < w.room))
```

### Terminal callers own no lease or queued request

Cancellation can retain an acquired lease while its writes drain. A caller becomes terminal only after its request set is sealed and every lease and waiter is gone.

```quint
pure def canSealRoomRequests(s: RoomState, caller: int): bool = caller > 0 and not(s.waiting.some(w => w.caller == caller)) and not(s.sealedCallers.contains(caller))
pure def sealRoomRequests(s: RoomState, caller: int): RoomState = { ...s, sealedCallers: s.sealedCallers.union(Set(caller)) }
pure def canFinishCaller(s: RoomState, caller: int): bool = s.sealedCallers.contains(caller) and not(s.finishedCallers.contains(caller)) and not(s.leases.some(l => l.caller == caller)) and not(s.waiting.some(w => w.caller == caller))
pure def finishCaller(s: RoomState, caller: int): RoomState = { ...s, finishedCallers: s.finishedCallers.union(Set(caller)) }
pure def alwaysNoLeakedTerminalOwnership(s: RoomState): bool = s.finishedCallers.forall(caller => not(s.leases.some(l => l.caller == caller)) and not(s.waiting.some(w => w.caller == caller)))
pure val fair_sealRoomRequests = "strong"
pure val fair_finishCaller = "weak"
pure def leadsToSealedCallerFinishes(s: RoomState, later: RoomState): bool = s.sealedCallers.forall(caller => later.finishedCallers.contains(caller))
pure def sometimesCancelledCallerFullyDrained(s: RoomState): bool = s.finishedCallers.intersect(s.cancelled).size() > 0
```

### Every occupied room queue has an enabled lease step

No leases and no queued requests is quiescent. Otherwise an unowned room can grant its oldest waiter, or an owner can finish a write, close write admission or release a drained lease.

```quint
pure def roomQueueQuiescent(s: RoomState): bool = s.leases.length() == 0 and s.waiting.length() == 0
pure def roomProgressEnabled(s: RoomState): bool = s.waiting.some(w => canGrantRoom(s, w.room) or canCancelQueued(s, w.caller)) or s.leases.some(l => canFinishWrite(s, l.caller, l.room) or canCloseWrites(s, l.caller, l.room) or canReleaseRoom(s, l.caller, l.room))
pure def alwaysRoomQueueDeadlockFree(s: RoomState): bool = roomQueueQuiescent(s) or roomProgressEnabled(s)
pure def leadsToQueuedCallersServed(s: RoomState, later: RoomState): bool = s.waiting.every(w => not(later.waiting.some(pending => pending.ticket == w.ticket)))
```
