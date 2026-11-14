lemma admit_ensures(s: TopicServiceRooms, id: string, capturedGeneration: int, callId: string, readOnly: bool, incoming: seq<string>)
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> alwaysRoomIdsUnique(admit(s, id, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> alwaysRoomsRespectLifecycle(admit(s, id, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> alwaysRoomsBelongToInstance(admit(s, id, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> alwaysCacheOrderOwnsPresentRooms(admit(s, id, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> alwaysStoppedCachesCleared(admit(s, id, capturedGeneration, callId, readOnly, incoming)))
  ensures (inv(s) ==> canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) ==> stepStoppingCannotGrowRoomQueues(s, "admit", admit(s, id, capturedGeneration, callId, readOnly, incoming)))
{
  if inv(s) && canAdmit(s, id, capturedGeneration, callId, readOnly, incoming) {
    var after := admit(s, id, capturedGeneration, callId, readOnly, incoming);
    var found := (exists room :: room in s.rooms && room.id == id);
    if found {
      TopicRoomIdentityFrame(s, after);
      TopicRoomLookup(s, id);
      forall i | 0 <= i < |after.rooms| && after.rooms[i].id == id ensures core__channelTopics_inv(after.rooms[i].unit) {
        var prior := s.rooms[i];
        assert prior in s.rooms && prior.id == id && roomAt(s, id) == prior.unit;
        TopicRoomLeafInvariant(prior.unit);
        core__channelTopics_admit_ensures(prior.unit, capturedGeneration, callId, readOnly, incoming);
      }
      TopicCacheMembershipFrame(s, after);
    } else {
      var freshRoom := Room(id, core__channelTopics_admit(core__channelTopics_initial.(generation := s.instance), capturedGeneration, callId, readOnly, incoming));
      assert after.rooms == s.rooms + [freshRoom];
      TopicRoomKeys(s.rooms);
      ProofLib.DistinctByConcat(s.rooms, [freshRoom], (room: Room) => room.id);
      TopicRoomKeys(after.rooms);
      var unit := core__channelTopics_initial.(generation := s.instance);
      assert core__channelTopics_inv(unit);
      core__channelTopics_admit_ensures(unit, capturedGeneration, callId, readOnly, incoming);
      assert id !in after.cacheOrder by {
        if id in after.cacheOrder { var row :| row in s.rooms && row.id == id && row.unit.cachePresent; }
      }
    }
  }
}

lemma stop_ensures(s: TopicServiceRooms)
  ensures (inv(s) ==> canStop(s) ==> alwaysRoomIdsUnique(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRoomsRespectLifecycle(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRoomsBelongToInstance(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysCacheOrderOwnsPresentRooms(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysStoppedCachesCleared(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepStoppingCannotGrowRoomQueues(s, "stop", stop(s)))
{
  if inv(s) && canStop(s) {
    var after := stop(s);
    TopicRoomIdentityFrame(s, after);
    TopicCacheMembershipFrame(s, after);
  }
}

lemma finishStop_ensures(s: TopicServiceRooms)
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysRoomIdsUnique(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysRoomsRespectLifecycle(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysRoomsBelongToInstance(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysCacheOrderOwnsPresentRooms(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysStoppedCachesCleared(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> stepStoppingCannotGrowRoomQueues(s, "finishStop", finishStop(s)))
{
  if inv(s) && canFinishStop(s) {
    var after := finishStop(s);
    TopicRoomIdentityFrame(s, after);
    forall room | room in after.rooms ensures |room.unit.queue| <= |roomAt(s, room.id).queue| {
      var i :| 0 <= i < |after.rooms| && after.rooms[i] == room;
      assert s.rooms[i] in s.rooms;
      TopicRoomLookup(s, room.id);
      assert roomAt(s, room.id) == s.rooms[i].unit;
    }
  }
}

lemma replace_ensures(s: TopicServiceRooms)
  ensures (inv(s) ==> canReplace(s) ==> alwaysRoomIdsUnique(replace(s)))
  ensures (inv(s) ==> canReplace(s) ==> alwaysRoomsRespectLifecycle(replace(s)))
  ensures (inv(s) ==> canReplace(s) ==> alwaysRoomsBelongToInstance(replace(s)))
  ensures (inv(s) ==> canReplace(s) ==> alwaysCacheOrderOwnsPresentRooms(replace(s)))
  ensures (inv(s) ==> canReplace(s) ==> alwaysStoppedCachesCleared(replace(s)))
  ensures (inv(s) ==> canReplace(s) ==> stepStoppingCannotGrowRoomQueues(s, "replace", replace(s)))
{
  if inv(s) && canReplace(s) {
    var after := replace(s);
    TopicRoomIdentityFrame(s, after);
    TopicCacheMembershipFrame(s, after);
  }
}

lemma advanceRoom_ensures(s: TopicServiceRooms, id: string, hydration: core__channelTopics_TopicHydration, persistence: core__channelTopics_TopicPersistence)
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> alwaysRoomIdsUnique(advanceRoom(s, id, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> alwaysRoomsRespectLifecycle(advanceRoom(s, id, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> alwaysRoomsBelongToInstance(advanceRoom(s, id, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> alwaysCacheOrderOwnsPresentRooms(advanceRoom(s, id, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> alwaysStoppedCachesCleared(advanceRoom(s, id, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceRoom(s, id, hydration) ==> stepStoppingCannotGrowRoomQueues(s, "advanceRoom", advanceRoom(s, id, hydration, persistence)))
{
  if inv(s) && canAdvanceRoom(s, id, hydration) {
    var after := advanceRoom(s, id, hydration, persistence);
    TopicRoomIdentityFrame(s, after);
    TopicRoomLookup(s, id);
    var prior := roomAt(s, id);
    var updated := core__channelTopics_advanceRoom(prior, hydration, persistence);
    var own :| own in s.rooms && own.id == id && own.unit == prior;
    assert core__channelTopics_inv(prior) by { TopicRoomLeafInvariant(own.unit); }
    core__channelTopics_advanceRoom_ensures(prior, hydration, persistence);
    TopicAdvancePreservesPresentCache(prior, hydration, persistence);
    assert |updated.queue| <= |prior.queue|;
    forall room | room in after.rooms ensures |room.unit.queue| <= |roomAt(s, room.id).queue| {
      var i :| 0 <= i < |after.rooms| && after.rooms[i] == room;
      assert s.rooms[i] in s.rooms;
      TopicRoomLookup(s, room.id);
      assert roomAt(s, room.id) == s.rooms[i].unit;
    }
    if !prior.cachePresent && updated.cachePresent {
      assert id !in s.cacheOrder;
      TopicCacheKeys(s.cacheOrder);
      ProofLib.DistinctByConcat(s.cacheOrder, [id], (key: string) => key);
      TopicCacheKeys(after.cacheOrder);
    }
    TopicCacheUpdate(s, after, id, prior, updated);
  }
}

lemma TopicAdvancePreservesPresentCache(prior: core__channelTopics_TopicService, hydration: core__channelTopics_TopicHydration, persistence: core__channelTopics_TopicPersistence)
  requires core__channelTopics_inv(prior) && core__channelTopics_canAdvanceRoom(prior, hydration)
  ensures prior.cachePresent ==> core__channelTopics_advanceRoom(prior, hydration, persistence).cachePresent
{
  if prior.cachePresent {
    assert prior.hydrated && !core__channelTopics_isHydrating(prior);
  }
}

lemma advanceNext_ensures(s: TopicServiceRooms, hydration: core__channelTopics_TopicHydration, persistence: core__channelTopics_TopicPersistence)
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> alwaysRoomIdsUnique(advanceNext(s, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> alwaysRoomsRespectLifecycle(advanceNext(s, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> alwaysRoomsBelongToInstance(advanceNext(s, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> alwaysCacheOrderOwnsPresentRooms(advanceNext(s, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> alwaysStoppedCachesCleared(advanceNext(s, hydration, persistence)))
  ensures (inv(s) ==> canAdvanceNext(s, hydration) ==> stepStoppingCannotGrowRoomQueues(s, "advanceNext", advanceNext(s, hydration, persistence)))
{
  if inv(s) && canAdvanceNext(s, hydration) {
    advanceRoom_ensures(s, nextRoom(s), hydration, persistence);
  }
}

lemma TopicRoomLeafInvariant(t: core__channelTopics_TopicService)
  requires core__channelTopics_alwaysCallIdsUnique(t) && core__channelTopics_alwaysQueueOwnsCalls(t) && core__channelTopics_alwaysOnlyHeadIsActive(t)
  requires core__channelTopics_alwaysTopicCapacity(t) && core__channelTopics_alwaysTopicCacheOwnership(t) && core__channelTopics_alwaysUnhydratedHasNoCache(t)
  requires core__channelTopics_alwaysActiveCallMatchesHydration(t) && core__channelTopics_alwaysRetiredServiceJoined(t)
  ensures core__channelTopics_inv(t)
{
}

lemma TopicRoomIdentityFrame(before: TopicServiceRooms, after: TopicServiceRooms)
  requires alwaysRoomIdsUnique(before)
  requires |after.rooms| == |before.rooms|
  requires forall i :: 0 <= i < |after.rooms| ==> after.rooms[i].id == before.rooms[i].id
  ensures alwaysRoomIdsUnique(after)
{
  forall room | room in after.rooms ensures |ProofLib.Filter((other: Room) => other.id == room.id, after.rooms)| == 1 {
    var i :| 0 <= i < |after.rooms| && after.rooms[i] == room;
    assert before.rooms[i] in before.rooms;
    var p := (other: Room) => other.id == room.id;
    ProofLib.FilterLengthPointwise(p, p, before.rooms, after.rooms);
  }
}

lemma TopicRoomKeys(rooms: seq<Room>)
  ensures ProofLib.DistinctBy(rooms, (room: Room) => room.id) <==> (forall room :: room in rooms ==> |ProofLib.Filter((other: Room) => other.id == room.id, rooms)| == 1)
{
  var key := (room: Room) => room.id;
  if ProofLib.DistinctBy(rooms, key) {
    forall room | room in rooms ensures |ProofLib.Filter((other: Room) => other.id == room.id, rooms)| == 1 {
      var i :| 0 <= i < |rooms| && rooms[i] == room;
      ProofLib.FilterCountOneIffUnique((other: Room) => other.id == room.id, rooms, key, i);
    }
  } else if forall room :: room in rooms ==> |ProofLib.Filter((other: Room) => other.id == room.id, rooms)| == 1 {
    forall i, j | 0 <= i < |rooms| && 0 <= j < |rooms| && i != j ensures rooms[i].id != rooms[j].id {
      assert rooms[i] in rooms;
      var p := (other: Room) => other.id == rooms[i].id;
      assert |ProofLib.Filter(p, rooms)| == 1;
      ProofLib.FilterCountOneIffUnique(p, rooms, key, i);
    }
  }
}

lemma TopicCacheKeys(cache: seq<string>)
  ensures ProofLib.DistinctBy(cache, (key: string) => key) <==> (forall id :: id in cache ==> |ProofLib.Filter((other: string) => other == id, cache)| == 1)
{
  var key := (id: string) => id;
  if ProofLib.DistinctBy(cache, key) {
    forall id | id in cache ensures |ProofLib.Filter((other: string) => other == id, cache)| == 1 {
      var i :| 0 <= i < |cache| && cache[i] == id;
      ProofLib.FilterCountOneIffUnique((other: string) => other == id, cache, key, i);
    }
  } else if forall id :: id in cache ==> |ProofLib.Filter((other: string) => other == id, cache)| == 1 {
    forall i, j | 0 <= i < |cache| && 0 <= j < |cache| && i != j ensures cache[i] != cache[j] {
      assert cache[i] in cache;
      var p := (other: string) => other == cache[i];
      assert |ProofLib.Filter(p, cache)| == 1;
      ProofLib.FilterCountOneIffUnique(p, cache, key, i);
    }
  }
}

lemma TopicRoomLookup(s: TopicServiceRooms, id: string)
  requires alwaysRoomIdsUnique(s)
  ensures forall room :: room in s.rooms && room.id == id ==> roomAt(s, id) == room.unit
  ensures !(exists room :: room in s.rooms && room.id == id) ==> roomAt(s, id) == noRoom.unit
{
  var p := (room: Room) => room.id == id;
  var matches := ProofLib.Filter(p, s.rooms);
  if |matches| > 0 {
    ProofLib.FilterMember(p, s.rooms, matches[0]);
  }
  forall room | room in s.rooms && room.id == id ensures roomAt(s, id) == room.unit {
    ProofLib.FilterMember(p, s.rooms, room);
    assert |matches| == 1 && matches[0] == room;
  }
}

lemma TopicCacheMembershipFrame(before: TopicServiceRooms, after: TopicServiceRooms)
  requires alwaysCacheOrderOwnsPresentRooms(before) && before.cacheOrder == after.cacheOrder
  requires |before.rooms| == |after.rooms|
  requires forall i :: 0 <= i < |before.rooms| ==> before.rooms[i].id == after.rooms[i].id && before.rooms[i].unit.cachePresent == after.rooms[i].unit.cachePresent
  ensures alwaysCacheOrderOwnsPresentRooms(after)
{
  forall id | id in after.cacheOrder ensures exists room :: room in after.rooms && room.id == id && room.unit.cachePresent {
    var row :| row in before.rooms && row.id == id && row.unit.cachePresent;
    var i :| 0 <= i < |before.rooms| && before.rooms[i] == row;
    assert after.rooms[i] in after.rooms;
  }
  forall room | room in after.rooms ensures room.unit.cachePresent == (room.id in after.cacheOrder) {
    var i :| 0 <= i < |after.rooms| && after.rooms[i] == room;
    assert before.rooms[i] in before.rooms;
  }
}

lemma TopicCacheUpdate(before: TopicServiceRooms, after: TopicServiceRooms, id: string, prior: core__channelTopics_TopicService, updated: core__channelTopics_TopicService)
  requires alwaysCacheOrderOwnsPresentRooms(before)
  requires prior.cachePresent ==> updated.cachePresent
  requires prior.cachePresent == (id in before.cacheOrder)
  requires |before.rooms| == |after.rooms|
  requires forall i :: 0 <= i < |before.rooms| ==> before.rooms[i].id == after.rooms[i].id && (if after.rooms[i].id == id then before.rooms[i].unit == prior && after.rooms[i].unit == updated else before.rooms[i].unit == after.rooms[i].unit)
  requires after.cacheOrder == (if !prior.cachePresent && updated.cachePresent then before.cacheOrder + [id] else before.cacheOrder)
  requires exists room :: room in before.rooms && room.id == id
  requires forall key :: key in after.cacheOrder ==> |ProofLib.Filter((other: string) => other == key, after.cacheOrder)| == 1
  ensures alwaysCacheOrderOwnsPresentRooms(after)
{
  forall key | key in after.cacheOrder ensures exists room :: room in after.rooms && room.id == key && room.unit.cachePresent {
    if key == id {
      var row :| row in before.rooms && row.id == id;
      var i :| 0 <= i < |before.rooms| && before.rooms[i] == row;
      assert after.rooms[i] in after.rooms && updated.cachePresent;
    } else {
      var row :| row in before.rooms && row.id == key && row.unit.cachePresent;
      var i :| 0 <= i < |before.rooms| && before.rooms[i] == row;
      assert after.rooms[i] in after.rooms;
    }
  }
  forall room | room in after.rooms ensures room.unit.cachePresent == (room.id in after.cacheOrder) {
    var i :| 0 <= i < |after.rooms| && after.rooms[i] == room;
    assert before.rooms[i] in before.rooms;
  }
}
