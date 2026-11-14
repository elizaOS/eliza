# Whole-service topic retirement

`services/channel-topics.ts` has one stopping flag across every room queue. The [room lifecycle](./channelTopics.md) owns each queue and local/durable ordered topic values. This product closes admission for all rooms at once, including room IDs that have never been seen, while already admitted operations finish independently.

## Story: Retire all room queues before clearing the service cache

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
