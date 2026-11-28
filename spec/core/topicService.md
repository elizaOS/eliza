# Whole-service topic retirement

`services/channel-topics.vibe` has one stopping flag across every room queue. The [room lifecycle](./channelTopics.md) owns each queue and local/durable ordered topic values. This spec closes admission for all rooms at once, including room IDs that have never been seen, while already admitted operations finish independently.

## Story: Retire all room queues before clearing the service cache

> As a host, I want stopping the topic service to refuse new work in every
> room and clear its caches only after admitted work finishes, so that no
> topic update is lost or applied after shutdown.

### Stop blocks every new room admission and joins the complete room snapshot

Setting stopping is synchronous. Hydration and persistence already queued may settle, including failures. Only after every accepted room operation has joined does stop clear all local cache/hydration state. Fair progress serves one eligible room per turn, rotating the chosen room to the back of the scheduler order while preserving room insertion order. A replacement is a new service instance, with fresh local caches that later hydrate the same durable state; it does not reopen the retired instance.

```quint
import channelTopics as T from "./channelTopics"
type Room = { id: str, unit: T::TopicService }
type TopicServiceRooms = { rooms: List[Room], scheduling: List[str], cacheOrder: List[str], stopping: bool, stopped: bool, instance: int }
pure val initial: TopicServiceRooms = { rooms: List(), scheduling: List(), cacheOrder: List(), stopping: false, stopped: false, instance: 0 }
pure val noRoom: Room = { id: "", unit: T::initial }
pure def roomAt(s: TopicServiceRooms, id: str): T::TopicService = s.rooms.select(room => room.id == id).nthOr(0, noRoom).unit
pure def canAdmit(s: TopicServiceRooms, id: str, capturedGeneration: int, callId: str, readOnly: bool, incoming: List[str]): bool = not(s.stopping) and not(s.stopped) and id != "" and capturedGeneration == s.instance and T::canAdmit({ ...roomAt(s, id), generation: s.instance }, capturedGeneration, callId, readOnly, incoming)
pure def admit(s: TopicServiceRooms, id: str, capturedGeneration: int, callId: str, readOnly: bool, incoming: List[str]): TopicServiceRooms = { ...s, rooms: if (s.rooms.some(room => room.id == id)) s.rooms.listMap(room => if (room.id == id) { ...room, unit: T::admit(room.unit, capturedGeneration, callId, readOnly, incoming) } else room) else s.rooms.append({ id: id, unit: T::admit({ ...T::initial, generation: s.instance }, capturedGeneration, callId, readOnly, incoming) }), scheduling: if (s.scheduling.includes(id)) s.scheduling else s.scheduling.append(id) }
pure def canAdvanceRoom(s: TopicServiceRooms, id: str, hydration: T::TopicHydration): bool = T::canAdvanceRoom(roomAt(s, id), hydration)
pure def advanceRoom(s: TopicServiceRooms, id: str, hydration: T::TopicHydration, persistence: T::TopicPersistence): TopicServiceRooms = {
  val before = roomAt(s, id)
  val updated = T::advanceRoom(before, hydration, persistence)
  { ...s, rooms: s.rooms.listMap(room => if (room.id == id) { ...room, unit: updated } else room), cacheOrder: if (not(before.cachePresent) and updated.cachePresent) s.cacheOrder.append(id) else s.cacheOrder }
}
pure def nextRoom(s: TopicServiceRooms): str = s.scheduling.select(id => T::roomEligible(roomAt(s, id))).nthOr(0, "")
pure def canAdvanceNext(s: TopicServiceRooms, hydration: T::TopicHydration): bool = nextRoom(s) != "" and T::canAdvanceRoom(roomAt(s, nextRoom(s)), hydration)
pure def advanceNext(s: TopicServiceRooms, hydration: T::TopicHydration, persistence: T::TopicPersistence): TopicServiceRooms = {
  val id = nextRoom(s)
  { ...advanceRoom(s, id, hydration, persistence), scheduling: s.scheduling.select(roomId => roomId != id).append(id) }
}
pure def canStop(s: TopicServiceRooms): bool = not(s.stopping) and not(s.stopped)
pure def stop(s: TopicServiceRooms): TopicServiceRooms = { ...s, stopping: true, rooms: s.rooms.listMap(room => { ...room, unit: T::beginStop(room.unit) }) }
pure def canFinishStop(s: TopicServiceRooms): bool = s.stopping and not(s.stopped) and s.rooms.every(room => T::canFinishStop(room.unit))
pure def finishStop(s: TopicServiceRooms): TopicServiceRooms = { ...s, stopped: true, cacheOrder: List(), rooms: s.rooms.listMap(room => { ...room, unit: T::finishStop(room.unit) }) }
pure def canReplace(s: TopicServiceRooms): bool = s.stopped
pure def replace(s: TopicServiceRooms): TopicServiceRooms = { ...s, stopping: false, stopped: false, instance: s.instance + 1, rooms: s.rooms.listMap(room => { ...room, unit: T::replace(room.unit) }) }
pure def alwaysRoomIdsUnique(s: TopicServiceRooms): bool = s.rooms.every(room => s.rooms.select(other => other.id == room.id).length() == 1)
pure def alwaysRoomsRespectLifecycle(s: TopicServiceRooms): bool = s.rooms.every(room => T::alwaysCallIdsUnique(room.unit) and T::alwaysQueueOwnsCalls(room.unit) and T::alwaysOnlyHeadIsActive(room.unit) and T::alwaysTopicCapacity(room.unit) and T::alwaysTopicCacheOwnership(room.unit) and T::alwaysUnhydratedHasNoCache(room.unit) and T::alwaysActiveCallMatchesHydration(room.unit) and T::alwaysRetiredServiceJoined(room.unit))
pure def alwaysRoomsBelongToInstance(s: TopicServiceRooms): bool = s.rooms.every(room => room.unit.generation == s.instance)
pure def alwaysCacheOrderOwnsPresentRooms(s: TopicServiceRooms): bool = s.cacheOrder.every(id => s.rooms.some(room => room.id == id and room.unit.cachePresent) and s.cacheOrder.select(other => other == id).length() == 1) and s.rooms.every(room => room.unit.cachePresent == s.cacheOrder.includes(room.id))
pure def alwaysStoppedCachesCleared(s: TopicServiceRooms): bool = not(s.stopped) or (s.stopping and s.rooms.every(room => room.unit.owner == T::Retired and room.unit.localTopics.length() == 0 and not(room.unit.hydrated)))
pure def stepStoppingCannotGrowRoomQueues(before: TopicServiceRooms, via: str, after: TopicServiceRooms): bool = before.stopping and via != "replace" implies before.rooms.length() == after.rooms.length() and after.rooms.every(room => room.unit.queue.length() <= roomAt(before, room.id).queue.length())
pure def sometimesStopWaitsOnSeveralRooms(s: TopicServiceRooms): bool = s.stopping and s.rooms.select(room => room.unit.queue.length() > 0).length() > 1
pure def sometimesReplacementHydrates(s: TopicServiceRooms): bool = s.instance > 0 and s.rooms.some(room => room.unit.hydrated)
pure val idValues = Set("room1", "room2")
pure val fair_advanceNext = "weak"
pure val callIdValues = T::callIdValues
pure val incomingValues = T::incomingValues
pure val capturedGenerationValues = T::capturedGenerationValues
pure val hydrationValues = T::hydrationValues
pure val fair_finishStop = "weak"
pure def leadsToRoomCallsSettle(s: TopicServiceRooms, later: TopicServiceRooms): bool = s.rooms.every(room => T::leadsToAcceptedCallsSettle(room.unit, roomAt(later, room.id)))
pure def leadsToServiceJoined(s: TopicServiceRooms, later: TopicServiceRooms): bool = s.stopping implies later.stopped or later.instance > s.instance
```

## Story: Read the cached topics of one room or of every room

> As a provider or a topic search, I want to read one room's topics or a
> snapshot of every room's topics from the local cache, so that I see each
> room's current topics without waiting for its queue.

### Room reads return the local cache, empty without a cache entry, and the all-room snapshot follows cache insertion order

A room that was never admitted reads as the empty per-room lifecycle, so its topic read is an empty list. The single-room read returns the room's local topics when the room has a cache entry and an empty list when it has none. The all-room snapshot has one entry for each room with a cache entry (the cache-order rule above makes every such room appear once), in the order the cache entries were inserted. That order can differ from the first-admission order, and only stop clears it. Lists are values, so each read is a separate copy that a caller cannot use to change the cache.

```quint
type RoomTopics = { id: str, topics: List[str] }
pure def roomIds(s: TopicServiceRooms): List[str] = s.rooms.listMap(room => room.id)
pure def topicsForRoom(s: TopicServiceRooms, id: str): List[str] = if (roomAt(s, id).cachePresent) roomAt(s, id).localTopics else List()
pure def topicsForAllRooms(s: TopicServiceRooms): List[RoomTopics] = s.cacheOrder.listMap(id => { id: id, topics: topicsForRoom(s, id) })
pure def lawMissingRoomReadsEmpty(s: TopicServiceRooms, id: str): bool = s.rooms.some(room => room.id == id) or (roomAt(s, id) == T::initial and topicsForRoom(s, id) == List())
pure def stepCacheOrderKeepsInsertionOrder(before: TopicServiceRooms, via: str, after: TopicServiceRooms): bool = via == "finishStop" or after.cacheOrder == before.cacheOrder.concat(after.cacheOrder.select(id => not(before.cacheOrder.includes(id))))
pure def sometimesCacheOrderDiffersFromAdmission(s: TopicServiceRooms): bool = s.cacheOrder != roomIds(s).select(id => s.cacheOrder.includes(id))
pure val sValues: Set[TopicServiceRooms] = Set(initial)
```

### The model keeps one room record for each admitted room, in first-admission order

The model keeps one room record for each room ever admitted, in first-admission order: a step can only add a new room ID at the end. The service's own queue map drops a room when its queue drains, and no read returns room IDs, so this order is only the model's.

```quint
pure def stepRoomIdsKeepFirstAdmissionOrder(before: TopicServiceRooms, after: TopicServiceRooms): bool = roomIds(after) == roomIds(before).concat(roomIds(after).select(id => not(roomIds(before).includes(id))))
```
