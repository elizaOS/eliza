lemma LeaseFilters(s: RoomState)
  ensures alwaysRoomMutualExclusion(s) == (forall l :: l in s.leases ==> |ProofLib.Filter((x: Lease) => (x.room == l.room), s.leases)| == 1)
{}

lemma QueueFilters(s: RoomState)
  ensures alwaysQueueBounded(s) == (((s.configured || (|s.waiting| == 0 && |s.leases| == 0)) && s.capacity >= 0 && |s.waiting| + |s.leases| <= s.capacity && |activeRooms(s)| <= s.maxRooms) && (forall room :: room in activeRooms(s) ==> |ProofLib.Filter((w: RoomWaiter) => (w.room == room), s.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == room), s.leases)| <= s.maxPerRoom))
{}

lemma LeaseRoomPositions(s: RoomState)
  requires alwaysRoomMutualExclusion(s)
  ensures forall i, j :: 0 <= i < |s.leases| && 0 <= j < |s.leases| && s.leases[i].room == s.leases[j].room ==> i == j
{
  LeaseFilters(s);
  forall i, j | 0 <= i < |s.leases| && 0 <= j < |s.leases| && s.leases[i].room == s.leases[j].room
    ensures i == j
  {
    ProofLib.FilterCountOneIffUnique((x: Lease) => (x.room == s.leases[i].room), s.leases, (x: Lease) => x.room, i);
  }
}

lemma LeaseMaximum(leases: seq<Lease>)
  requires |leases| > 0
  ensures exists candidate :: candidate in leases && (forall l :: l in leases ==> l.room <= candidate.room)
  decreases |leases|
{
  if |leases| > 1 {
    LeaseMaximum(leases[1..]);
    var candidate :| candidate in leases[1..] && (forall l :: l in leases[1..] ==> l.room <= candidate.room);
    if leases[0].room > candidate.room {
      forall l | l in leases ensures l.room <= leases[0].room {
        if l != leases[0] { assert l in leases[1..]; }
      }
      assert leases[0] in leases;
      assert exists candidate :: candidate in leases && (forall l :: l in leases ==> l.room <= candidate.room);
    } else {
      assert candidate in leases;
      forall l | l in leases ensures l.room <= candidate.room {
        if l != leases[0] { assert l in leases[1..]; }
      }
      assert exists chosen :: chosen in leases && (forall l :: l in leases ==> l.room <= chosen.room);
    }
  } else {
    assert |leases| == 1;
    assert forall l :: l in leases ==> l == leases[0];
    assert leases[0] in leases;
    assert exists candidate :: candidate in leases && (forall l :: l in leases ==> l.room <= candidate.room);
  }
}

lemma QueueProgress(s: RoomState)
  requires alwaysWritesRetainLease(s)
  ensures alwaysRoomQueueDeadlockFree(s)
{
  if |s.waiting| > 0 {
    assert canCancelQueued(s, s.waiting[0].caller);
  } else if |s.leases| > 0 {
    if exists l :: l in s.leases && (l.writes > 0 || l.acceptingWrites) {
      var candidate :| candidate in s.leases && (candidate.writes > 0 || candidate.acceptingWrites);
      assert canFinishWrite(s, candidate.caller, candidate.room) || canCloseWrites(s, candidate.caller, candidate.room);
    } else {
      LeaseMaximum(s.leases);
      var candidate :| candidate in s.leases && (forall l :: l in s.leases ==> l.room <= candidate.room);
      assert !candidate.acceptingWrites && candidate.writes == 0;
      assert canReleaseRoom(s, candidate.caller, candidate.room);
    }
  }
}

lemma ActiveRoomProjection(s: RoomState)
  ensures activeRooms(s) == Std.Collections.Seq.FoldLeft((rooms: seq<int>, room: int) => (if (room in rooms) then rooms else (rooms + [room])), [], activeRoomIds(s))
{}

lemma SameRoomProjection(before: RoomState, after: RoomState)
  requires before.waiting == after.waiting
  requires |before.leases| == |after.leases|
  requires forall i :: 0 <= i < |before.leases| ==> before.leases[i].room == after.leases[i].room
  ensures activeRooms(before) == activeRooms(after)
{
  ActiveRoomProjection(before); ActiveRoomProjection(after);
  assert |activeRoomIds(before)| == |activeRoomIds(after)|;
  forall i | 0 <= i < |activeRoomIds(before)| ensures activeRoomIds(before)[i] == activeRoomIds(after)[i] {}
  assert activeRoomIds(before) == activeRoomIds(after);
}

lemma LeaseMapPreserves(before: RoomState, after: RoomState)
  requires inv(before)
  requires after == before.(leases := after.leases)
  requires |before.leases| == |after.leases|
  requires forall i :: 0 <= i < |before.leases| ==> before.leases[i].caller == after.leases[i].caller && before.leases[i].room == after.leases[i].room && after.leases[i].writes >= 0
  ensures inv(after)
  ensures stepReleasedLeaseIsSettled(before, after)
{
  LeaseFilters(before); LeaseFilters(after);
  QueueFilters(before); QueueFilters(after);
  SameRoomProjection(before, after);
  forall l | l in after.leases
    ensures |ProofLib.Filter((x: Lease) => (x.room == l.room), after.leases)| == 1
  {
    var i :| 0 <= i < |after.leases| && after.leases[i] == l;
    ProofLib.FilterLengthPointwise((x: Lease) => (x.room == l.room), (x: Lease) => (x.room == l.room), before.leases, after.leases);
  }
  forall room | room in activeRooms(after)
    ensures |ProofLib.Filter((w: RoomWaiter) => (w.room == room), after.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == room), after.leases)| <= after.maxPerRoom
  {
    ProofLib.FilterLengthPointwise((l: Lease) => (l.room == room), (l: Lease) => (l.room == room), before.leases, after.leases);
  }
  forall w, l | w in after.waiting && l in after.leases
    ensures l.caller != w.caller || l.room < w.room
  {
    var i :| 0 <= i < |after.leases| && after.leases[i] == l;
    assert before.leases[i] in before.leases;
  }
  forall caller, l | caller in after.finishedCallers && l in after.leases
    ensures l.caller != caller
  {
    var i :| 0 <= i < |after.leases| && after.leases[i] == l;
    assert before.leases[i] in before.leases;
  }
  forall l | l in before.leases
    ensures exists other :: other in after.leases && other.room == l.room && other.caller == l.caller
  {
    var i :| 0 <= i < |before.leases| && before.leases[i] == l;
    assert after.leases[i] in after.leases;
  }
  QueueProgress(after);
}

lemma beginWrite_ensures(s: RoomState, caller: int, room: int)
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysRoomMutualExclusion(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaitersUnique(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueBounded(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWritesRetainLease(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysCancelledWaitersRemoved(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysAcquisitionOrdered(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysNoLeakedTerminalOwnership(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysRoomQueueDeadlockFree(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepClosedQueueCannotGrow(s, beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepReleasedLeaseIsSettled(s, beginWrite(s, caller, room)))
{
  if inv(s) && canBeginWrite(s, caller, room) {
    LeaseMapPreserves(s, beginWrite(s, caller, room));
  }
}

lemma finishWrite_ensures(s: RoomState, caller: int, room: int)
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysRoomMutualExclusion(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaitersUnique(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueBounded(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWritesRetainLease(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysCancelledWaitersRemoved(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysAcquisitionOrdered(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysNoLeakedTerminalOwnership(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysRoomQueueDeadlockFree(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepClosedQueueCannotGrow(s, finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepReleasedLeaseIsSettled(s, finishWrite(s, caller, room)))
{
  if inv(s) && canFinishWrite(s, caller, room) {
    LeaseRoomPositions(s);
    var selected :| selected in s.leases && selected.caller == caller && selected.room == room && selected.writes > 0;
    var j :| 0 <= j < |s.leases| && s.leases[j] == selected;
    var after := finishWrite(s, caller, room);
    forall i | 0 <= i < |s.leases|
      ensures after.leases[i].writes >= 0
    {
      if s.leases[i].caller == caller && s.leases[i].room == room { assert i == j; }
    }
    LeaseMapPreserves(s, after);
  }
}

lemma closeWrites_ensures(s: RoomState, caller: int, room: int)
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysRoomMutualExclusion(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysWaitersUnique(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysQueueBounded(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysWritesRetainLease(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysCancelledWaitersRemoved(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysAcquisitionOrdered(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysNoLeakedTerminalOwnership(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysRoomQueueDeadlockFree(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> stepClosedQueueCannotGrow(s, closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> stepReleasedLeaseIsSettled(s, closeWrites(s, caller, room)))
{
  if inv(s) && canCloseWrites(s, caller, room) {
    LeaseMapPreserves(s, closeWrites(s, caller, room));
  }
}

lemma FoldRooms(acc: seq<int>, ids: seq<int>)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft((rooms: seq<int>, room: int) => (if (room in rooms) then rooms else (rooms + [room])), acc, ids))
  ensures forall room :: room in Std.Collections.Seq.FoldLeft((rooms: seq<int>, room: int) => (if (room in rooms) then rooms else (rooms + [room])), acc, ids) <==> room in acc || room in ids
  decreases |ids|
{
  forall rooms: seq<int>, room: int
    ensures (if (room in rooms) then rooms else (rooms + [room])) == (if room in rooms then rooms else rooms + [room])
  {}
  ProofLib.FoldLeftDedupDistinct((rooms: seq<int>, room: int) => (if (room in rooms) then rooms else (rooms + [room])), acc, ids);
  if |ids| > 0 {
    var prefix := ids[..|ids| - 1];
    var last := ids[|ids| - 1];
    FoldRooms(acc, prefix);
    assert ids == prefix + [last];
    ProofLib.FoldLeftAppend((rooms: seq<int>, room: int) => (if (room in rooms) then rooms else (rooms + [room])), acc, prefix, last);
  }
}

lemma RoomSetCardinality(rooms: seq<int>)
  requires ProofLib.Distinct(rooms)
  ensures |set room | room in rooms :: room| == |rooms|
  decreases |rooms|
{
  if |rooms| > 0 {
    var prefix := rooms[..|rooms| - 1];
    var last := rooms[|rooms| - 1];
    RoomSetCardinality(prefix);
    assert rooms == prefix + [last];
    assert last !in prefix;
    var allIds := set room | room in rooms :: room;
    var prefixIds := set room | room in prefix :: room;
    forall id: int
      ensures (id in allIds) <==> (id in prefixIds + {last})
    {
      if id in rooms && id != last { assert id in prefix; }
      if id in prefix || id == last { assert id in rooms; }
    }
    assert (set room | room in rooms :: room) == (set room | room in prefix :: room) + {last};
  }
}

lemma ActiveRoomFacts(s: RoomState)
  ensures ProofLib.Distinct(activeRooms(s))
  ensures forall room :: room in activeRooms(s) <==> (exists l :: l in s.leases && l.room == room) || (exists w :: w in s.waiting && w.room == room)
{
  ActiveRoomProjection(s);
  var leaseIds := seq(|s.leases|, i requires 0 <= i < |s.leases| => s.leases[i].room);
  var waiterIds := seq(|s.waiting|, i requires 0 <= i < |s.waiting| => s.waiting[i].room);
  assert activeRoomIds(s) == leaseIds + waiterIds;
  FoldRooms([], activeRoomIds(s));
  forall room
    ensures (room in leaseIds <==> (exists l :: l in s.leases && l.room == room)) && (room in waiterIds <==> (exists w :: w in s.waiting && w.room == room))
  {
    if room in leaseIds {
      var i :| 0 <= i < |leaseIds| && leaseIds[i] == room;
      assert s.leases[i] in s.leases;
    }
    if exists l :: l in s.leases && l.room == room {
      var l :| l in s.leases && l.room == room;
      var i :| 0 <= i < |s.leases| && s.leases[i] == l;
      assert leaseIds[i] == room;
    }
    if room in waiterIds {
      var i :| 0 <= i < |waiterIds| && waiterIds[i] == room;
      assert s.waiting[i] in s.waiting;
    }
    if exists w :: w in s.waiting && w.room == room {
      var w :| w in s.waiting && w.room == room;
      var i :| 0 <= i < |s.waiting| && s.waiting[i] == w;
      assert waiterIds[i] == room;
    }
  }
  forall room: int
    ensures (room in activeRooms(s)) <==> ((exists l :: l in s.leases && l.room == room) || (exists w :: w in s.waiting && w.room == room))
  {
    assert (room in activeRooms(s)) <==> (room in activeRoomIds(s));
    assert (room in activeRoomIds(s)) <==> (room in leaseIds || room in waiterIds);
    assert (room in leaseIds) <==> (exists l :: l in s.leases && l.room == room);
    assert (room in waiterIds) <==> (exists w :: w in s.waiting && w.room == room);
  }
}

lemma ActiveRoomSubset(before: RoomState, after: RoomState)
  requires forall l :: l in after.leases ==> (exists prior :: prior in before.leases && prior.room == l.room) || (exists prior :: prior in before.waiting && prior.room == l.room)
  requires forall w :: w in after.waiting ==> (exists prior :: prior in before.leases && prior.room == w.room) || (exists prior :: prior in before.waiting && prior.room == w.room)
  ensures |activeRooms(after)| <= |activeRooms(before)|
{
  ActiveRoomFacts(before); ActiveRoomFacts(after);
  RoomSetCardinality(activeRooms(before)); RoomSetCardinality(activeRooms(after));
  var beforeSet := set room | room in activeRooms(before) :: room;
  var afterSet := set room | room in activeRooms(after) :: room;
  forall room | room in activeRooms(after)
    ensures room in activeRooms(before)
  {
    if exists l :: l in after.leases && l.room == room {
      var l :| l in after.leases && l.room == room;
      assert (exists prior :: prior in before.leases && prior.room == room) || (exists prior :: prior in before.waiting && prior.room == room);
    } else {
      var w :| w in after.waiting && w.room == room;
      assert (exists prior :: prior in before.leases && prior.room == room) || (exists prior :: prior in before.waiting && prior.room == room);
    }
  }
  assert afterSet <= beforeSet;
  ProofLib.SubsetCard(afterSet, beforeSet);
}

lemma FinishedCallerParts(s: RoomState, caller: int)
  ensures finishCaller(s, caller).finishedCallers == s.finishedCallers + ProofLib.Filter((set_x: int) => !((set_x in s.finishedCallers)), [caller])
{}

lemma finishCaller_ensures(s: RoomState, caller: int)
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysRoomMutualExclusion(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysWaitersUnique(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysQueueBounded(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysWritesRetainLease(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysCancelledWaitersRemoved(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysAcquisitionOrdered(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysNoLeakedTerminalOwnership(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> alwaysRoomQueueDeadlockFree(finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> stepClosedQueueCannotGrow(s, finishCaller(s, caller)))
  ensures (inv(s) ==> canFinishCaller(s, caller) ==> stepReleasedLeaseIsSettled(s, finishCaller(s, caller)))
{
  if inv(s) && canFinishCaller(s, caller) {
    var after := finishCaller(s, caller);
    FinishedCallerParts(s, caller);
    forall terminal | terminal in after.finishedCallers
      ensures !(exists l :: l in after.leases && l.caller == terminal) && !(exists w :: w in after.waiting && w.caller == terminal)
    {
      if terminal !in s.finishedCallers {
        ProofLib.FilterMember((set_x: int) => !((set_x in s.finishedCallers)), [caller], terminal);
        assert terminal == caller;
      }
    }
  }
}

lemma QueueFilterEverything<T>(xs: seq<T>)
  ensures ProofLib.Filter((x: T) => true, xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((x: T) => true, xs);
  } else {
    ProofLib.FilterCons((x: T) => true, xs);
    QueueFilterEverything(xs[1..]);
  }
}

lemma WaiterFilters(s: RoomState)
  ensures alwaysWaitersUnique(s) == (s.nextTicket > 0 && (forall w :: w in s.waiting ==> w.caller > 0 && w.room > 0 && w.ticket > 0 && w.ticket < s.nextTicket && |ProofLib.Filter((x: RoomWaiter) => (x.caller == w.caller), s.waiting)| == 1 && |ProofLib.Filter((x: RoomWaiter) => (x.ticket == w.ticket), s.waiting)| == 1))
{}

lemma FilterQueuePreserves(before: RoomState, after: RoomState, keepLease: Lease -> bool, keepWaiter: RoomWaiter -> bool)
  requires inv(before)
  requires after == before.(leases := ProofLib.Filter(keepLease, before.leases), waiting := ProofLib.Filter(keepWaiter, before.waiting), cancelled := after.cancelled)
  requires forall w :: w in after.waiting ==> w.caller !in after.cancelled
  ensures inv(after)
  ensures |after.waiting| <= |before.waiting|
{
  LeaseFilters(before); LeaseFilters(after);
  WaiterFilters(before); WaiterFilters(after);
  QueueFilters(before); QueueFilters(after);
  ProofLib.FilterSubset(keepLease, before.leases);
  ProofLib.FilterSubset(keepWaiter, before.waiting);
  QueueFilterEverything(before.leases); QueueFilterEverything(before.waiting);
  ProofLib.FilterImpLength(keepLease, (x: Lease) => true, before.leases);
  ProofLib.FilterImpLength(keepWaiter, (x: RoomWaiter) => true, before.waiting);
  ActiveRoomSubset(before, after);
  ActiveRoomFacts(before); ActiveRoomFacts(after);
  forall l | l in after.leases
    ensures |ProofLib.Filter((x: Lease) => (x.room == l.room), after.leases)| == 1
  {
    assert l in before.leases;
    ProofLib.FilterOfFilterShorter(keepLease, (x: Lease) => (x.room == l.room), before.leases);
    ProofLib.FilterMember((x: Lease) => (x.room == l.room), after.leases, l);
  }
  forall w | w in after.waiting
    ensures w.caller > 0 && w.room > 0 && w.ticket > 0 && w.ticket < after.nextTicket && |ProofLib.Filter((x: RoomWaiter) => (x.caller == w.caller), after.waiting)| == 1 && |ProofLib.Filter((x: RoomWaiter) => (x.ticket == w.ticket), after.waiting)| == 1
  {
    assert w in before.waiting;
    ProofLib.FilterOfFilterShorter(keepWaiter, (x: RoomWaiter) => (x.caller == w.caller), before.waiting);
    ProofLib.FilterOfFilterShorter(keepWaiter, (x: RoomWaiter) => (x.ticket == w.ticket), before.waiting);
    ProofLib.FilterMember((x: RoomWaiter) => (x.caller == w.caller), after.waiting, w);
    ProofLib.FilterMember((x: RoomWaiter) => (x.ticket == w.ticket), after.waiting, w);
  }
  forall room | room in activeRooms(after)
    ensures |ProofLib.Filter((w: RoomWaiter) => (w.room == room), after.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == room), after.leases)| <= after.maxPerRoom
  {
    if exists l :: l in after.leases && l.room == room {
      var l :| l in after.leases && l.room == room;
      assert l in before.leases;
    } else {
      var w :| w in after.waiting && w.room == room;
      assert w in before.waiting;
    }
    assert room in activeRooms(before);
    ProofLib.FilterOfFilterShorter(keepLease, (l: Lease) => (l.room == room), before.leases);
    ProofLib.FilterOfFilterShorter(keepWaiter, (w: RoomWaiter) => (w.room == room), before.waiting);
  }
  QueueProgress(after);
}

lemma ReleaseParts(s: RoomState, caller: int, room: int)
  ensures releaseRoom(s, caller, room).leases == ProofLib.Filter((l: Lease) => ((l.caller != caller) || (l.room != room)), s.leases)
{}

lemma CancelParts(s: RoomState, caller: int)
  ensures cancelQueued(s, caller).waiting == ProofLib.Filter((w: RoomWaiter) => (w.caller != caller), s.waiting)
  ensures cancelQueued(s, caller).cancelled == s.cancelled + ProofLib.Filter((set_x: int) => !((set_x in s.cancelled)), [caller])
{}

lemma releaseRoom_ensures(s: RoomState, caller: int, room: int)
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysRoomMutualExclusion(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysWaitersUnique(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysQueueBounded(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysWritesRetainLease(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysCancelledWaitersRemoved(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysAcquisitionOrdered(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysNoLeakedTerminalOwnership(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> alwaysRoomQueueDeadlockFree(releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> stepClosedQueueCannotGrow(s, releaseRoom(s, caller, room)))
  ensures (inv(s) ==> canReleaseRoom(s, caller, room) ==> stepReleasedLeaseIsSettled(s, releaseRoom(s, caller, room)))
{
  if inv(s) && canReleaseRoom(s, caller, room) {
    var after := releaseRoom(s, caller, room);
    ReleaseParts(s, caller, room);
    QueueFilterEverything(s.waiting);
    ProofLib.FilterSubset((l: Lease) => ((l.caller != caller) || (l.room != room)), s.leases);
    FilterQueuePreserves(s, after, (l: Lease) => ((l.caller != caller) || (l.room != room)), (x: RoomWaiter) => true);
    LeaseRoomPositions(s);
    var selected :| selected in s.leases && selected.caller == caller && selected.room == room && !selected.acceptingWrites && selected.writes == 0;
    var j :| 0 <= j < |s.leases| && s.leases[j] == selected;
    forall l | l in s.leases
      ensures (exists other :: other in after.leases && other.room == l.room && other.caller == l.caller) || (!l.acceptingWrites && l.writes == 0)
    {
      if l.caller != caller || l.room != room {
        ProofLib.FilterMember((l: Lease) => ((l.caller != caller) || (l.room != room)), s.leases, l);
      } else {
        var i :| 0 <= i < |s.leases| && s.leases[i] == l;
        assert i == j;
      }
    }
  }
}

lemma cancelQueued_ensures(s: RoomState, caller: int)
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysRoomMutualExclusion(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysWaitersUnique(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysQueueBounded(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysWritesRetainLease(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysCancelledWaitersRemoved(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysAcquisitionOrdered(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysNoLeakedTerminalOwnership(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> alwaysRoomQueueDeadlockFree(cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> stepClosedQueueCannotGrow(s, cancelQueued(s, caller)))
  ensures (inv(s) ==> canCancelQueued(s, caller) ==> stepReleasedLeaseIsSettled(s, cancelQueued(s, caller)))
{
  if inv(s) && canCancelQueued(s, caller) {
    var after := cancelQueued(s, caller);
    CancelParts(s, caller);
    QueueFilterEverything(s.leases);
    ProofLib.FilterSubset((w: RoomWaiter) => (w.caller != caller), s.waiting);
    forall w | w in after.waiting
      ensures w.caller !in after.cancelled
    {
      ProofLib.FilterMember((w: RoomWaiter) => (w.caller != caller), s.waiting, w);
      if w.caller in ProofLib.Filter((set_x: int) => !((set_x in s.cancelled)), [caller]) {
        ProofLib.FilterMember((set_x: int) => !((set_x in s.cancelled)), [caller], w.caller);
      }
    }
    FilterQueuePreserves(s, after, (x: Lease) => true, (w: RoomWaiter) => (w.caller != caller));
  }
}

lemma ActiveRoomUpperBound(before: RoomState, after: RoomState, added: int)
  requires forall l :: l in after.leases ==> l.room == added || (exists prior :: prior in before.leases && prior.room == l.room) || (exists prior :: prior in before.waiting && prior.room == l.room)
  requires forall w :: w in after.waiting ==> w.room == added || (exists prior :: prior in before.leases && prior.room == w.room) || (exists prior :: prior in before.waiting && prior.room == w.room)
  ensures |activeRooms(after)| <= |activeRooms(before)| + 1
  ensures added in activeRooms(before) ==> |activeRooms(after)| <= |activeRooms(before)|
{
  ActiveRoomFacts(before); ActiveRoomFacts(after);
  RoomSetCardinality(activeRooms(before)); RoomSetCardinality(activeRooms(after));
  var beforeSet := set room | room in activeRooms(before) :: room;
  var afterSet := set room | room in activeRooms(after) :: room;
  forall room | room in activeRooms(after) && room != added
    ensures room in activeRooms(before)
  {
    if exists l :: l in after.leases && l.room == room {
      var l :| l in after.leases && l.room == room;
      assert (exists prior :: prior in before.leases && prior.room == room) || (exists prior :: prior in before.waiting && prior.room == room);
    } else {
      var w :| w in after.waiting && w.room == room;
      assert (exists prior :: prior in before.leases && prior.room == room) || (exists prior :: prior in before.waiting && prior.room == room);
    }
  }
  assert afterSet <= beforeSet + {added};
  ProofLib.SubsetCard(afterSet, beforeSet + {added});
  assert |beforeSet + {added}| <= |beforeSet| + 1;
  if added in activeRooms(before) { assert beforeSet + {added} == beforeSet; }
}

lemma QueueAdmissionCounts(s: RoomState, caller: int, room: int)
  ensures canQueueRoom(s, caller, room) ==> |ProofLib.Filter((w: RoomWaiter) => (w.room == room), s.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == room), s.leases)| < s.maxPerRoom
{}

lemma queueRoom_ensures(s: RoomState, caller: int, room: int)
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysRoomMutualExclusion(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysWaitersUnique(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysQueueBounded(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysWritesRetainLease(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysCancelledWaitersRemoved(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysAcquisitionOrdered(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysNoLeakedTerminalOwnership(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> alwaysRoomQueueDeadlockFree(queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> stepClosedQueueCannotGrow(s, queueRoom(s, caller, room)))
  ensures (inv(s) ==> canQueueRoom(s, caller, room) ==> stepReleasedLeaseIsSettled(s, queueRoom(s, caller, room)))
{
  if inv(s) && canQueueRoom(s, caller, room) {
    var after := queueRoom(s, caller, room);
    var added := RoomWaiter(caller, room, s.nextTicket);
    WaiterFilters(s); WaiterFilters(after);
    QueueFilters(s); QueueFilters(after);
    QueueAdmissionCounts(s, caller, room);
    ActiveRoomFacts(s); ActiveRoomFacts(after);
    ActiveRoomUpperBound(s, after, room);
    forall w | w in after.waiting
      ensures w.caller > 0 && w.room > 0 && w.ticket > 0 && w.ticket < after.nextTicket && |ProofLib.Filter((x: RoomWaiter) => (x.caller == w.caller), after.waiting)| == 1 && |ProofLib.Filter((x: RoomWaiter) => (x.ticket == w.ticket), after.waiting)| == 1
    {
      ProofLib.FilterAppend((x: RoomWaiter) => (x.caller == w.caller), s.waiting, added);
      ProofLib.FilterAppend((x: RoomWaiter) => (x.ticket == w.ticket), s.waiting, added);
      if w.caller == caller {
        ProofLib.FilterNone((x: RoomWaiter) => (x.caller == w.caller), s.waiting);
      } else { assert w in s.waiting; }
      if w.ticket == s.nextTicket {
        ProofLib.FilterNone((x: RoomWaiter) => (x.ticket == w.ticket), s.waiting);
      } else { assert w in s.waiting; }
    }
    forall target | target in activeRooms(after)
      ensures |ProofLib.Filter((w: RoomWaiter) => (w.room == target), after.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == target), after.leases)| <= after.maxPerRoom
    {
      ProofLib.FilterAppend((w: RoomWaiter) => (w.room == target), s.waiting, added);
      if target != room { assert target in activeRooms(s); }
    }
    QueueProgress(after);
  }
}

lemma WaiterCallerPositions(s: RoomState)
  requires alwaysWaitersUnique(s)
  ensures forall i, j :: 0 <= i < |s.waiting| && 0 <= j < |s.waiting| && s.waiting[i].caller == s.waiting[j].caller ==> i == j
{
  WaiterFilters(s);
  forall i, j | 0 <= i < |s.waiting| && 0 <= j < |s.waiting| && s.waiting[i].caller == s.waiting[j].caller
    ensures i == j
  {
    ProofLib.FilterCountOneIffUnique((x: RoomWaiter) => (x.caller == s.waiting[i].caller), s.waiting, (x: RoomWaiter) => x.caller, i);
  }
}

lemma GrantParts(s: RoomState, room: int)
  ensures grantRoom(s, room) == (var matching := ProofLib.Filter((w: RoomWaiter) => (w.room == room), s.waiting); var picked := if |matching| > 0 then matching[0] else RoomWaiter(0, 0, 0); s.(waiting := ProofLib.Filter((w: RoomWaiter) => (w.ticket != picked.ticket), s.waiting), leases := s.leases + [Lease(picked.caller, room, true, 0)]))
{}

lemma grantRoom_ensures(s: RoomState, room: int)
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysRoomMutualExclusion(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysWaitersUnique(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysQueueBounded(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysWritesRetainLease(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysCancelledWaitersRemoved(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysAcquisitionOrdered(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysNoLeakedTerminalOwnership(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> alwaysRoomQueueDeadlockFree(grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> stepClosedQueueCannotGrow(s, grantRoom(s, room)))
  ensures (inv(s) ==> canGrantRoom(s, room) ==> stepReleasedLeaseIsSettled(s, grantRoom(s, room)))
{
  if inv(s) && canGrantRoom(s, room) {
    GrantParts(s, room);
    LeaseFilters(s); WaiterFilters(s); QueueFilters(s);
    var matching := ProofLib.Filter((w: RoomWaiter) => (w.room == room), s.waiting);
    var candidate :| candidate in s.waiting && candidate.room == room;
    ProofLib.FilterMember((w: RoomWaiter) => (w.room == room), s.waiting, candidate);
    assert |matching| > 0;
    var picked := matching[0];
    ProofLib.FilterMember((w: RoomWaiter) => (w.room == room), s.waiting, picked);
    assert picked in s.waiting && picked.room == room;
    var after := grantRoom(s, room);
    var middle := s.(waiting := ProofLib.Filter((w: RoomWaiter) => (w.ticket != picked.ticket), s.waiting));
    QueueFilterEverything(s.leases); QueueFilterEverything(s.waiting);
    ProofLib.FilterSubset((w: RoomWaiter) => (w.ticket != picked.ticket), s.waiting);
    FilterQueuePreserves(s, middle, (x: Lease) => true, (w: RoomWaiter) => (w.ticket != picked.ticket));
    WaiterCallerPositions(s);
    var added := Lease(picked.caller, room, true, 0);
    LeaseFilters(after); QueueFilters(after);
    ProofLib.FilterImpLength((w: RoomWaiter) => (w.ticket != picked.ticket), (x: RoomWaiter) => true, s.waiting);
    ActiveRoomSubset(s, after);
    ActiveRoomFacts(s); ActiveRoomFacts(after);
    forall l | l in after.leases
      ensures |ProofLib.Filter((x: Lease) => (x.room == l.room), after.leases)| == 1
    {
      ProofLib.FilterAppend((x: Lease) => (x.room == l.room), s.leases, added);
      if l.room == room {
        ProofLib.FilterNone((x: Lease) => (x.room == l.room), s.leases);
      } else { assert l in s.leases; }
    }
    forall target | target in activeRooms(after)
      ensures |ProofLib.Filter((w: RoomWaiter) => (w.room == target), after.waiting)| + |ProofLib.Filter((l: Lease) => (l.room == target), after.leases)| <= after.maxPerRoom
    {
      assert target in activeRooms(s);
      ProofLib.FilterOfFilterLength((w: RoomWaiter) => (w.ticket != picked.ticket), (w: RoomWaiter) => (w.room == target), (w: RoomWaiter) => (w.room == target), s.waiting);
      ProofLib.FilterAppend((l: Lease) => (l.room == target), s.leases, added);
      if target == room {
        var i :| 0 <= i < |s.waiting| && s.waiting[i] == picked;
        assert s.waiting[i].room == target && s.waiting[i].ticket == picked.ticket;
      }
    }
    forall w | w in after.waiting
      ensures picked.caller != w.caller
    {
      ProofLib.FilterMember((w: RoomWaiter) => (w.ticket != picked.ticket), s.waiting, w);
      if picked.caller == w.caller {
        var i :| 0 <= i < |s.waiting| && s.waiting[i] == picked;
        var j :| 0 <= j < |s.waiting| && s.waiting[j] == w;
        assert i == j;
      }
    }
    assert after.waiting == middle.waiting;
    assert alwaysWaitersUnique(after) && alwaysCancelledWaitersRemoved(after);
    QueueProgress(after);
  }
}
