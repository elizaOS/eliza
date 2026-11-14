lemma ObserverRoomKeys(s: RoomQueueObservers)
  ensures alwaysOneQueueObjectPerRoom(s) == (s.nextQueue > 0 &&
    (forall q :: q in s.queues ==> (q.id > 0 && q.id < s.nextQueue &&
      |ProofLib.Filter((other: QueueObject) => other.room == q.room, s.queues)| == 1)))
{}

lemma ObserverLookup(s: RoomQueueObservers, room: int)
  requires alwaysOneQueueObjectPerRoom(s)
  ensures queueObject(s, room) != 0 <==> exists q :: q in s.queues && q.room == room
{
  var key := (q: QueueObject) => q.room == room;
  var selected := ProofLib.Filter(key, s.queues);
  assert queueObject(s, room) == (if |selected| > 0 then selected[0].id else 0);
  if |selected| > 0 {
    ProofLib.FilterMember(key, s.queues, selected[0]);
    assert selected[0] in s.queues && selected[0].room == room;
    ObserverRoomKeys(s);
    assert selected[0].id > 0;
  } else {
    ProofLib.FilterNone(key, s.queues);
    assert !(exists q :: q in s.queues && q.room == room);
  }
}

lemma ObserverAppendQueue(s: RoomQueueObservers, after: RoomQueueObservers, room: int)
  requires alwaysOneQueueObjectPerRoom(s) && queueObject(s, room) == 0
  requires after.queues == s.queues + [QueueObject(s.nextQueue, room)]
  requires after.nextQueue == s.nextQueue + 1
  ensures alwaysOneQueueObjectPerRoom(after)
{
  ObserverLookup(s, room);
  ObserverRoomKeys(s);
  ObserverRoomKeys(after);
  var entry := QueueObject(s.nextQueue, room);
  forall q | q in after.queues
    ensures q.id > 0 && q.id < after.nextQueue &&
      |ProofLib.Filter((other: QueueObject) => other.room == q.room, after.queues)| == 1
  {
    var key := (other: QueueObject) => other.room == q.room;
    ProofLib.FilterAppend(key, s.queues, entry);
    if q == entry {
      ProofLib.FilterNone(key, s.queues);
    } else {
      assert q in s.queues && q.room != room;
    }
  }
}

lemma ObserverRetainQueue(s: RoomQueueObservers, after: RoomQueueObservers, room: int)
  requires alwaysOneQueueObjectPerRoom(s)
  requires after.queues == ProofLib.Filter((q: QueueObject) => q.room != room, s.queues)
  requires after.nextQueue == s.nextQueue
  ensures alwaysOneQueueObjectPerRoom(after)
{
  ObserverRoomKeys(s);
  ObserverRoomKeys(after);
  var keep := (q: QueueObject) => q.room != room;
  forall q | q in after.queues
    ensures q.id > 0 && q.id < after.nextQueue &&
      |ProofLib.Filter((other: QueueObject) => other.room == q.room, after.queues)| == 1
  {
    var key := (other: QueueObject) => other.room == q.room;
    ProofLib.FilterMember(keep, s.queues, q);
    ProofLib.FilterOfFilterShorter(keep, key, s.queues);
    ProofLib.FilterMember(key, after.queues, q);
  }
}

lemma ObserverPriorRooms(s: RoomQueueObservers, after: RoomQueueObservers)
  requires alwaysOneQueueObjectPerRoom(s) && alwaysOneQueueObjectPerRoom(after)
  requires alwaysPendingWorkHasQueue(s)
  requires forall q :: q in s.queues ==> q in after.queues
  requires forall l :: l in after.queue.leases ==> (l in s.queue.leases ||
    (exists w :: w in s.queue.waiting && w.room == l.room) ||
    queueObject(after, l.room) != 0)
  requires forall w :: w in after.queue.waiting ==> w in s.queue.waiting || queueObject(after, w.room) != 0
  ensures alwaysPendingWorkHasQueue(after)
{
  forall l | l in after.queue.leases && queueObject(after, l.room) == 0
    ensures false
  {
    assert queueObject(s, l.room) != 0;
    ObserverLookup(s, l.room);
    ObserverLookup(after, l.room);
  }
  forall w | w in after.queue.waiting && queueObject(after, w.room) == 0
    ensures false
  {
    assert w in s.queue.waiting && queueObject(s, w.room) != 0;
    ObserverLookup(s, w.room);
    ObserverLookup(after, w.room);
  }
}

lemma ObserverWaitsForCapturedQueues(s: RoomQueueObservers, after: RoomQueueObservers)
  requires alwaysWaiterResolutionAgrees(s)
  requires |after.waiters| == |s.waiters|
  requires forall i :: (0 <= i < |s.waiters| &&
    after.waiters[i] != s.waiters[i]) ==> after.waiters[i].resolved == (|after.waiters[i].pendingQueues| == 0)
  ensures alwaysWaiterResolutionAgrees(after)
{
  forall w | w in after.waiters
    ensures w.resolved == (|w.pendingQueues| == 0)
  {
    var i :| 0 <= i < |after.waiters| && after.waiters[i] == w;
    assert s.waiters[i] in s.waiters;
  }
}

lemma ObserverRoomHasNoWork(s: RoomQueueObservers, room: int)
  requires pendingRoom(s, room) == 0
  ensures !(exists l :: l in s.queue.leases && l.room == room)
  ensures !(exists w :: w in s.queue.waiting && w.room == room)
{
  var leases := (l: core__concurrency_Lease) => l.room == room;
  var waiters := (w: core__concurrency_RoomWaiter) => w.room == room;
  assert pendingRoom(s, room) ==
    |ProofLib.Filter(leases, s.queue.leases)| + |ProofLib.Filter(waiters, s.queue.waiting)|;
  ProofLib.FilterNone(leases, s.queue.leases);
  ProofLib.FilterNone(waiters, s.queue.waiting);
}

lemma ObserverGrantPreservesPriorWaiters(q: core__concurrency_RoomState, room: int)
  ensures forall w :: w in core__concurrency_grantRoom(q, room).waiting ==> w in q.waiting
{
  var candidates := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, q.waiting);
  var selected := if |candidates| > 0 then candidates[0] else core__concurrency_RoomWaiter(0, 0, 0);
  var keep := (w: core__concurrency_RoomWaiter) => w.ticket != selected.ticket;
  var remaining := core__concurrency_grantRoom(q, room).waiting;
  assert remaining == ProofLib.Filter(keep, q.waiting);
  forall w | w in remaining ensures w in q.waiting {
    ProofLib.FilterMember(keep, q.waiting, w);
  }
}

lemma beginWrite_ensures(s: RoomQueueObservers, caller: int, room: int)
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueSafety(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysOneQueueObjectPerRoom(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaiterResolutionAgrees(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysPendingWorkHasQueue(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepResolvedWaitersStayResolved(s, beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepTelemetryPreservesQueue(s, "beginWrite", beginWrite(s, caller, room)))
{
  if inv(s) && canBeginWrite(s, caller, room) {
    core__concurrency_beginWrite_ensures(s.queue, caller, room);
  }
}

lemma finishWrite_ensures(s: RoomQueueObservers, caller: int, room: int)
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueSafety(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysOneQueueObjectPerRoom(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaiterResolutionAgrees(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysPendingWorkHasQueue(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepResolvedWaitersStayResolved(s, finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepTelemetryPreservesQueue(s, "finishWrite", finishWrite(s, caller, room)))
{
  if inv(s) && canFinishWrite(s, caller, room) {
    core__concurrency_finishWrite_ensures(s.queue, caller, room);
  }
}

lemma closeWrites_ensures(s: RoomQueueObservers, caller: int, room: int)
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysQueueSafety(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysOneQueueObjectPerRoom(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysWaiterResolutionAgrees(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> alwaysPendingWorkHasQueue(closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> stepResolvedWaitersStayResolved(s, closeWrites(s, caller, room)))
  ensures (inv(s) ==> canCloseWrites(s, caller, room) ==> stepTelemetryPreservesQueue(s, "closeWrites", closeWrites(s, caller, room)))
{
  if inv(s) && canCloseWrites(s, caller, room) {
    core__concurrency_closeWrites_ensures(s.queue, caller, room);
  }
}

lemma cancelQueued_ensures(s: RoomQueueObservers, caller: int, room: int, errorId: string)
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> alwaysQueueSafety(cancelQueued(s, caller, room, errorId)))
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> alwaysOneQueueObjectPerRoom(cancelQueued(s, caller, room, errorId)))
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> alwaysWaiterResolutionAgrees(cancelQueued(s, caller, room, errorId)))
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> alwaysPendingWorkHasQueue(cancelQueued(s, caller, room, errorId)))
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> stepResolvedWaitersStayResolved(s, cancelQueued(s, caller, room, errorId)))
  ensures (inv(s) ==> canCancelQueued(s, caller, room, errorId) ==> stepTelemetryPreservesQueue(s, "cancelQueued", cancelQueued(s, caller, room, errorId)))
{
  if inv(s) && canCancelQueued(s, caller, room, errorId) {
    core__concurrency_cancelQueued_ensures(s.queue, caller);
    var after := cancelQueued(s, caller, room, errorId);
    var keep := (w: core__concurrency_RoomWaiter) => w.caller != caller;
    forall w | w in after.queue.waiting ensures w in s.queue.waiting {
      ProofLib.FilterMember(keep, s.queue.waiting, w);
    }
    ObserverPriorRooms(s, after);
  }
}

lemma enqueue_ensures(s: RoomQueueObservers, caller: int, room: int)
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> alwaysQueueSafety(enqueue(s, caller, room)))
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> alwaysOneQueueObjectPerRoom(enqueue(s, caller, room)))
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> alwaysWaiterResolutionAgrees(enqueue(s, caller, room)))
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> alwaysPendingWorkHasQueue(enqueue(s, caller, room)))
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> stepResolvedWaitersStayResolved(s, enqueue(s, caller, room)))
  ensures (inv(s) ==> canEnqueue(s, caller, room) ==> stepTelemetryPreservesQueue(s, "enqueue", enqueue(s, caller, room)))
{
  if inv(s) && canEnqueue(s, caller, room) {
    var after := enqueue(s, caller, room);
    var queued := core__concurrency_queueRoom(s.queue, caller, room);
    core__concurrency_queueRoom_ensures(s.queue, caller, room);
    if core__concurrency_canGrantRoom(queued, room) {
      core__concurrency_grantRoom_ensures(queued, room);
      ObserverGrantPreservesPriorWaiters(queued, room);
    }
    if queueObject(s, room) == 0 {
      ObserverAppendQueue(s, after, room);
    }
    ObserverLookup(after, room);
    assert queueObject(after, room) != 0;
    forall l | l in after.queue.leases && l.room != room
      ensures l in s.queue.leases
    {}
    forall w | w in after.queue.waiting && w.room != room
      ensures w in s.queue.waiting
    {
      assert w in queued.waiting;
      assert queued.waiting == s.queue.waiting + [core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket)];
    }
    ObserverPriorRooms(s, after);
  }
}

lemma finishWork_ensures(s: RoomQueueObservers, caller: int, room: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> alwaysQueueSafety(finishWork(s, caller, room, ok, errorId)))
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> alwaysOneQueueObjectPerRoom(finishWork(s, caller, room, ok, errorId)))
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> alwaysWaiterResolutionAgrees(finishWork(s, caller, room, ok, errorId)))
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> alwaysPendingWorkHasQueue(finishWork(s, caller, room, ok, errorId)))
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> stepResolvedWaitersStayResolved(s, finishWork(s, caller, room, ok, errorId)))
  ensures (inv(s) ==> canFinishWork(s, caller, room, ok, errorId) ==> stepTelemetryPreservesQueue(s, "finishWork", finishWork(s, caller, room, ok, errorId)))
{
  if inv(s) && canFinishWork(s, caller, room, ok, errorId) {
    var after := finishWork(s, caller, room, ok, errorId);
    var released := core__concurrency_releaseRoom(s.queue, caller, room);
    core__concurrency_releaseRoom_ensures(s.queue, caller, room);
    if core__concurrency_canGrantRoom(released, room) {
      core__concurrency_grantRoom_ensures(released, room);
      ObserverGrantPreservesPriorWaiters(released, room);
      assert exists w :: w in s.queue.waiting && w.room == room;
    }
    var keep := (l: core__concurrency_Lease) => l.caller != caller || l.room != room;
    forall l | l in released.leases ensures l in s.queue.leases {
      ProofLib.FilterMember(keep, s.queue.leases, l);
    }
    assert forall w :: w in after.queue.waiting ==> w in s.queue.waiting;
    forall l | l in after.queue.leases && l.room != room
      ensures l in s.queue.leases
    {
      assert l in released.leases;
    }
    ObserverPriorRooms(s, after);
    ObserverWaitsForCapturedQueues(s, after);
  }
}

lemma pruneFinishedCall_ensures(s: RoomQueueObservers, caller: int)
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> alwaysQueueSafety(pruneFinishedCall(s, caller)))
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> alwaysOneQueueObjectPerRoom(pruneFinishedCall(s, caller)))
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> alwaysWaiterResolutionAgrees(pruneFinishedCall(s, caller)))
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> alwaysPendingWorkHasQueue(pruneFinishedCall(s, caller)))
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> stepResolvedWaitersStayResolved(s, pruneFinishedCall(s, caller)))
  ensures (inv(s) ==> canPruneFinishedCall(s, caller) ==> stepTelemetryPreservesQueue(s, "pruneFinishedCall", pruneFinishedCall(s, caller)))
{
  if inv(s) && canPruneFinishedCall(s, caller) {
    var after := pruneFinishedCall(s, caller);
    var calls := ProofLib.Filter((c: QueueCall) => c.id == caller, s.calls);
    var room := (if |calls| > 0 then calls[0] else noQueueCall).room;
    assert after.queue == s.queue;
    if pendingRoom(s, room) == 0 {
      ObserverRetainQueue(s, after, room);
      ObserverRoomHasNoWork(s, room);
      var keep := (q: QueueObject) => q.room != room;
      forall l | l in after.queue.leases ensures queueObject(after, l.room) != 0 {
        assert l in s.queue.leases && l.room != room;
        ObserverLookup(s, l.room);
        var q :| q in s.queues && q.room == l.room;
        ProofLib.FilterMember(keep, s.queues, q);
        ObserverLookup(after, l.room);
      }
      forall w | w in after.queue.waiting ensures queueObject(after, w.room) != 0 {
        assert w in s.queue.waiting && w.room != room;
        ObserverLookup(s, w.room);
        var q :| q in s.queues && q.room == w.room;
        ProofLib.FilterMember(keep, s.queues, q);
        ObserverLookup(after, w.room);
      }
    }
  }
}
