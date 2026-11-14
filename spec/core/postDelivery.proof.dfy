lemma PostKeepsQuarantineAbort(s: PostDelivery, after: PostDelivery)
  requires alwaysQuarantineAbortsPending(s)
  requires after.runtimes == s.runtimes && |after.tasks| == |s.tasks|
  requires forall i :: 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask? ==>
    !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
      after.tasks[i].aborted == s.tasks[i].aborted
  ensures alwaysQuarantineAbortsPending(after)
{
  forall task | task in after.tasks && !task.phase.SettledTask? && quarantined(after, task.runtime)
    ensures task.aborted
  {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == task;
    var prior := s.tasks[i];
    assert prior in s.tasks;
    assert quarantined(s, prior.runtime);
  }
}

lemma PostKeepsInvocation(s: PostDelivery, after: PostDelivery)
  requires alwaysUnstartedTasksCannotApply(s)
  requires |after.tasks| == |s.tasks|
  requires forall i :: 0 <= i < |s.tasks| && after.tasks[i].phase.PendingTask? ==>
    s.tasks[i].phase.PendingTask? && after.tasks[i] == s.tasks[i]
  requires forall i :: (0 <= i < |s.tasks| &&
    (after.tasks[i].phase.WaitingForDelivery? || after.tasks[i].phase.RunningTask?)) ==>
    (s.tasks[i].phase.WaitingForDelivery? || s.tasks[i].phase.RunningTask?) &&
      after.tasks[i].invoked == s.tasks[i].invoked
  ensures alwaysUnstartedTasksCannotApply(after)
{
  forall task | task in after.tasks
    ensures (task.phase.PendingTask? ==> !task.invoked && !task.effectApplied) &&
      ((task.phase.WaitingForDelivery? || task.phase.RunningTask?) ==> task.invoked)
  {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == task;
    assert s.tasks[i] in s.tasks;
  }
}

lemma PostAcceptsTaskOutsideQuarantine(s: PostDelivery, after: PostDelivery, runtimeId: int, added: PostTask)
  requires alwaysQuarantineAbortsPending(s) && !quarantined(s, runtimeId)
  requires after.runtimes == s.runtimes && after.tasks == s.tasks + [added] && added.runtime == runtimeId
  requires alwaysCapturedSettlementRetained(s) && after.boundaries == s.boundaries
  requires !added.phase.WaitingForDelivery?
  ensures alwaysQuarantineAbortsPending(after)
  ensures stepQuarantinePreventsNewTasks(s, after)
  ensures alwaysCapturedSettlementRetained(after)
{
  forall task | task in after.tasks && !task.phase.SettledTask? && quarantined(after, task.runtime)
    ensures task.aborted
  {
    assert task != added;
    assert task in s.tasks;
  }
  forall task | task in after.tasks && task.phase.WaitingForDelivery? &&
    !(exists b :: b in after.boundaries && b.runtime == task.runtime && b.room == task.room)
    ensures !task.permission.UnknownPermission?
  {
    assert task in s.tasks;
  }
  forall r | r in s.runtimes && r.quarantined
    ensures forall task :: task in after.tasks && task.runtime == r.id ==>
      exists prior :: prior in s.tasks && prior.id == task.id
  {
    assert r.id != runtimeId;
    forall task | task in after.tasks && task.runtime == r.id
      ensures exists prior :: prior in s.tasks && prior.id == task.id
    {
      assert task in s.tasks;
    }
  }
}

lemma PostSettlementKeepsUnresolved(s: PostDelivery, after: PostDelivery)
  requires alwaysUnresolvedCaptureHasBoundary(s)
  requires |after.tasks| == |s.tasks| && after.boundaries == s.boundaries
  requires forall i :: 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask? ==>
    after.tasks[i] == s.tasks[i]
  ensures alwaysUnresolvedCaptureHasBoundary(after)
{
  forall task | task in after.tasks && !task.phase.SettledTask? && task.permission.UnknownPermission?
    ensures (task.phase.PendingTask? || task.phase.WaitingForDelivery?) && task.waitsForDelivery &&
      (exists b :: b in after.boundaries && b.runtime == task.runtime && b.room == task.room &&
        b.lease == task.lease && b.status.WaitingDelivery?)
  {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == task;
    assert task == s.tasks[i] && task in s.tasks;
  }
}

lemma PostPendingFilter(s: PostDelivery, runtimeId: int)
  ensures pendingRuntimeTasks(s, runtimeId) ==
    ProofLib.Filter((task: PostTask) => runtimePending(task, runtimeId), s.tasks)
{}

lemma PostRoomFilter(s: PostDelivery, runtimeId: int, room: string)
  ensures pendingRoomTasks(s, runtimeId, room) ==
    ProofLib.Filter((task: PostTask) => roomPending(task, runtimeId, room), s.tasks)
{}

lemma PostQuarantineRetainsTasks(s: PostDelivery, after: PostDelivery)
  requires |after.tasks| == |s.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==>
    (after.tasks[i].id == s.tasks[i].id &&
      after.tasks[i].runtime == s.tasks[i].runtime &&
      after.tasks[i].phase == s.tasks[i].phase)
  ensures stepQuarantineRetainsPending(s, after)
{
  forall r | r in s.runtimes && !quarantined(s, r.id) && quarantined(after, r.id)
    ensures forall prior :: prior in pendingRuntimeTasks(s, r.id) ==>
      (exists retained :: retained in pendingRuntimeTasks(after, r.id) && retained.id == prior.id)
  {
    var key := (task: PostTask) => runtimePending(task, r.id);
    PostPendingFilter(s, r.id);
    PostPendingFilter(after, r.id);
    forall prior | prior in pendingRuntimeTasks(s, r.id)
      ensures exists retained :: retained in pendingRuntimeTasks(after, r.id) && retained.id == prior.id
    {
      ProofLib.FilterMember(key, s.tasks, prior);
      var i :| 0 <= i < |s.tasks| && s.tasks[i] == prior;
      var retained := after.tasks[i];
      assert retained in after.tasks;
      assert key(retained);
      ProofLib.FilterMember(key, after.tasks, retained);
    }
  }
}

lemma PostNoQuarantineChange(s: PostDelivery, after: PostDelivery)
  requires after.runtimes == s.runtimes
  ensures stepQuarantineRetainsPending(s, after)
  ensures stepQuarantinePersists(s, after)
{}

lemma PostQuarantinesPersist(s: PostDelivery, changed: int)
  ensures stepQuarantinePersists(s, quarantineRuntime(s, changed))
  ensures forall id :: quarantined(s, id) ==> quarantined(quarantineRuntime(s, changed), id)
{
  var after := quarantineRuntime(s, changed);
  forall prior | prior in s.runtimes && prior.quarantined
    ensures exists later :: later in after.runtimes && later.id == prior.id && later.quarantined
  {
    var i :| 0 <= i < |s.runtimes| && s.runtimes[i] == prior;
    assert after.runtimes[i].id == prior.id && after.runtimes[i].quarantined;
    assert after.runtimes[i] in after.runtimes;
  }
  forall id | quarantined(s, id)
    ensures quarantined(after, id)
  {
    var prior :| prior in s.runtimes && prior.id == id && prior.quarantined;
    assert exists later :: later in after.runtimes && later.id == id && later.quarantined;
  }
}

lemma PostQuarantineKeepsLeases(s: PostDelivery, runtimeId: int)
  requires alwaysPendingRoomTaskHasLease(s)
  ensures alwaysPendingRoomTaskHasLease(quarantineRuntime(s, runtimeId))
{
  var after := quarantineRuntime(s, runtimeId);
  PostQuarantinesPersist(s, runtimeId);
  forall t | t in after.tasks && !t.phase.SettledTask? && t.room != "" && !quarantined(after, t.runtime)
    ensures exists l :: l in after.leases && l.id == t.lease && l.runtime == t.runtime && l.room == t.room
  {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == t;
    var prior := s.tasks[i];
    assert prior in s.tasks;
    assert !quarantined(s, prior.runtime);
    assert exists l :: l in s.leases && l.id == prior.lease && l.runtime == prior.runtime && l.room == prior.room;
  }
}

lemma PostIssuedTaskAppend(s: PostDelivery, after: PostDelivery, id: int)
  requires alwaysLiveTasksWereIssued(s)
  requires id !in s.issuedTaskIds
  requires after.issuedTaskIds == s.issuedTaskIds + ProofLib.Filter((set_x: int) => !((set_x in s.issuedTaskIds)), [id])
  requires |after.tasks| == |s.tasks| + 1 && after.tasks[|s.tasks|].id == id
  requires after.tasks[..|s.tasks|] == s.tasks
  ensures alwaysLiveTasksWereIssued(after)
{
  var keep := (set_x: int) => !((set_x in s.issuedTaskIds));
  ProofLib.FilterMember(keep, [id], id);
  forall task | task in after.tasks
    ensures task.id in after.issuedTaskIds
  {
    if task !in s.tasks {
      assert task.id == id;
    }
  }
}

lemma PostIssuedDrainAppend(s: PostDelivery, after: PostDelivery, id: int)
  requires alwaysLiveDrainsWereIssued(s)
  requires id !in s.issuedDrainIds
  requires after.issuedDrainIds == s.issuedDrainIds + ProofLib.Filter((set_x: int) => !((set_x in s.issuedDrainIds)), [id])
  requires |after.drains| == |s.drains| + 1 && after.drains[|s.drains|].id == id
  requires after.drains[..|s.drains|] == s.drains
  ensures alwaysLiveDrainsWereIssued(after)
{
  var keep := (set_x: int) => !((set_x in s.issuedDrainIds));
  ProofLib.FilterMember(keep, [id], id);
  forall observer | observer in after.drains
    ensures observer.id in after.issuedDrainIds
  {
    if observer !in s.drains {
      assert observer.id == id;
    }
  }
}

lemma PostBoundaryKeys(s: PostDelivery)
  ensures alwaysOneBoundaryPerRoom(s) ==
    (forall b :: b in s.boundaries ==>
      (|ProofLib.Filter((other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room)), s.boundaries)| == 1))
{}

lemma PostBeginBoundary(s: PostDelivery, after: PostDelivery, added: DeliveryBoundary)
  requires alwaysOneBoundaryPerRoom(s)
  requires !(exists b :: b in s.boundaries && b.runtime == added.runtime && b.room == added.room)
  requires after.boundaries == s.boundaries + [added]
  ensures alwaysOneBoundaryPerRoom(after)
{
  PostBoundaryKeys(s);
  PostBoundaryKeys(after);
  forall b | b in after.boundaries
    ensures |ProofLib.Filter((other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room)), after.boundaries)| == 1
  {
    var key := (other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room));
    ProofLib.FilterAppend(key, s.boundaries, added);
    if b == added {
      ProofLib.FilterNone(key, s.boundaries);
    } else {
      assert b in s.boundaries;
    }
  }
}

lemma PostKeepBoundaries(s: PostDelivery, after: PostDelivery, keep: DeliveryBoundary -> bool)
  requires alwaysOneBoundaryPerRoom(s) && alwaysDeliveryBoundaryOwned(s)
  requires after.boundaries == ProofLib.Filter(keep, s.boundaries) && after.leases == s.leases
  ensures alwaysOneBoundaryPerRoom(after) && alwaysDeliveryBoundaryOwned(after)
{
  PostBoundaryKeys(s);
  PostBoundaryKeys(after);
  forall b | b in after.boundaries
    ensures |ProofLib.Filter((other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room)), after.boundaries)| == 1
    ensures exists l :: l in after.leases && l.id == b.lease && l.runtime == b.runtime && l.room == b.room
  {
    var key := (other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room));
    ProofLib.FilterMember(keep, s.boundaries, b);
    ProofLib.FilterOfFilterShorter(keep, key, s.boundaries);
    ProofLib.FilterMember(key, after.boundaries, b);
  }
}

lemma PostKeepBoundaryKeys(s: PostDelivery, after: PostDelivery)
  requires alwaysOneBoundaryPerRoom(s)
  requires |after.boundaries| == |s.boundaries|
  requires forall i :: 0 <= i < |s.boundaries| ==>
    (after.boundaries[i].runtime == s.boundaries[i].runtime && after.boundaries[i].room == s.boundaries[i].room)
  ensures alwaysOneBoundaryPerRoom(after)
{
  PostBoundaryKeys(s);
  PostBoundaryKeys(after);
  forall b | b in after.boundaries
    ensures |ProofLib.Filter((other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room)), after.boundaries)| == 1
  {
    var i :| 0 <= i < |after.boundaries| && after.boundaries[i] == b;
    assert s.boundaries[i] in s.boundaries;
    var key := (other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room));
    ProofLib.FilterLengthPointwise(key, key, s.boundaries, after.boundaries);
  }
}

lemma PostDrainsUnchanged(s: PostDelivery, after: PostDelivery)
  requires after.drains == s.drains
  ensures stepDrainsReturnEmpty(s, after)
{
  forall d | d in after.drains && d.phase.DrainDone?
    ensures exists prior :: prior in s.drains && prior.id == d.id && prior.phase.DrainDone?
  {
    assert d in s.drains;
  }
}

lemma PostSameTaskCustody(s: PostDelivery, after: PostDelivery)
  requires |after.tasks| == |s.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==>
    (after.tasks[i].id == s.tasks[i].id && after.tasks[i].runtime == s.tasks[i].runtime)
  ensures stepQuarantinePreventsNewTasks(s, after)
{
  forall t | t in after.tasks
    ensures exists prior :: prior in s.tasks && prior.id == t.id
  {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == t;
    assert s.tasks[i] in s.tasks;
  }
}

lemma beginDeliveryBoundary_ensures(s: PostDelivery, runtimeId: int, room: string, leaseId: int)
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysPendingRoomTaskHasLease(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysQuarantineAbortsPending(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysDeliveryBoundaryOwned(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysOneBoundaryPerRoom(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysDrainCountsNonnegative(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysLiveTasksWereIssued(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysLiveDrainsWereIssued(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysUnstartedTasksCannotApply(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysEffectsRequireInvocation(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysDeniedDeliveryBlocksEffects(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysAbortedBeforeInvocationHasNoEffect(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysCapturedSettlementRetained(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysUnresolvedCaptureHasNoEffect(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> alwaysUnresolvedCaptureHasBoundary(beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> stepQuarantinePersists(s, beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> stepQuarantinePreventsNewTasks(s, beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> stepInvocationChecksAbort(s, "beginDeliveryBoundary", beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> stepQuarantineRetainsPending(s, beginDeliveryBoundary(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canBeginDeliveryBoundary(s, runtimeId, room, leaseId) ==> stepDrainsReturnEmpty(s, beginDeliveryBoundary(s, runtimeId, room, leaseId)))
{
  if inv(s) && canBeginDeliveryBoundary(s, runtimeId, room, leaseId) {
    PostBeginBoundary(s, beginDeliveryBoundary(s, runtimeId, room, leaseId),
      DeliveryBoundary(runtimeId, room, leaseId, DeliveryStatus.WaitingDelivery));
  }
}

lemma removeDeliveryBoundary_ensures(s: PostDelivery, runtimeId: int, room: string)
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysPendingRoomTaskHasLease(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysQuarantineAbortsPending(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysDeliveryBoundaryOwned(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysOneBoundaryPerRoom(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysDrainCountsNonnegative(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysLiveTasksWereIssued(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysLiveDrainsWereIssued(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysUnstartedTasksCannotApply(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysEffectsRequireInvocation(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysDeniedDeliveryBlocksEffects(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysAbortedBeforeInvocationHasNoEffect(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysCapturedSettlementRetained(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysUnresolvedCaptureHasNoEffect(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> alwaysUnresolvedCaptureHasBoundary(removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> stepQuarantinePersists(s, removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> stepQuarantinePreventsNewTasks(s, removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> stepInvocationChecksAbort(s, "removeDeliveryBoundary", removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> stepQuarantineRetainsPending(s, removeDeliveryBoundary(s, runtimeId, room)))
  ensures (inv(s) ==> canRemoveDeliveryBoundary(s, runtimeId, room) ==> stepDrainsReturnEmpty(s, removeDeliveryBoundary(s, runtimeId, room)))
{
  if inv(s) && canRemoveDeliveryBoundary(s, runtimeId, room) {
    var after := removeDeliveryBoundary(s, runtimeId, room);
    var keep := (b: DeliveryBoundary) => ((b.runtime != runtimeId) || (b.room != room));
    PostKeepBoundaries(s, after, keep);
    forall b | b in s.boundaries && b.status.WaitingDelivery?
      ensures b in after.boundaries
    {
      if b.runtime == runtimeId && b.room == room {
        var prior :| prior in s.boundaries && prior.runtime == runtimeId && prior.room == room && !prior.status.WaitingDelivery?;
        PostBoundaryKeys(s);
        var key := (other: DeliveryBoundary) => ((other.runtime == b.runtime) && (other.room == b.room));
        var i :| 0 <= i < |s.boundaries| && s.boundaries[i] == b;
        var j :| 0 <= j < |s.boundaries| && s.boundaries[j] == prior;
        assert i != j;
        ProofLib.FilterTwo(key, s.boundaries, i, j);
        assert false;
      }
      assert keep(b);
      ProofLib.FilterMember(keep, s.boundaries, b);
    }
    forall t | t in after.tasks && !t.phase.SettledTask? && t.permission.UnknownPermission?
      ensures (t.phase.PendingTask? || t.phase.WaitingForDelivery?) && t.waitsForDelivery &&
        (exists b :: b in after.boundaries && b.runtime == t.runtime && b.room == t.room &&
          b.lease == t.lease && b.status.WaitingDelivery?)
    {
      assert t in s.tasks;
      var b :| b in s.boundaries && b.runtime == t.runtime && b.room == t.room &&
        b.lease == t.lease && b.status.WaitingDelivery?;
      assert b in after.boundaries;
    }
    assert alwaysUnresolvedCaptureHasBoundary(after);
    assert alwaysCapturedSettlementRetained(after);
  }
}

lemma settleDeliveryBoundary_ensures(s: PostDelivery, runtimeId: int, room: string, delivered: bool)
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysPendingRoomTaskHasLease(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysQuarantineAbortsPending(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysDeliveryBoundaryOwned(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysOneBoundaryPerRoom(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysDrainCountsNonnegative(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysLiveTasksWereIssued(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysLiveDrainsWereIssued(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysUnstartedTasksCannotApply(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysEffectsRequireInvocation(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysDeniedDeliveryBlocksEffects(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysAbortedBeforeInvocationHasNoEffect(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysCapturedSettlementRetained(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysUnresolvedCaptureHasNoEffect(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> alwaysUnresolvedCaptureHasBoundary(settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> stepQuarantinePersists(s, settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> stepQuarantinePreventsNewTasks(s, settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> stepInvocationChecksAbort(s, "settleDeliveryBoundary", settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> stepQuarantineRetainsPending(s, settleDeliveryBoundary(s, runtimeId, room, delivered)))
  ensures (inv(s) ==> canSettleDeliveryBoundary(s, runtimeId, room, delivered) ==> stepDrainsReturnEmpty(s, settleDeliveryBoundary(s, runtimeId, room, delivered)))
{
  if inv(s) && canSettleDeliveryBoundary(s, runtimeId, room, delivered) {
    var after := settleDeliveryBoundary(s, runtimeId, room, delivered);
    forall i | 0 <= i < |s.boundaries|
      ensures after.boundaries[i].runtime == s.boundaries[i].runtime &&
        after.boundaries[i].room == s.boundaries[i].room && after.boundaries[i].lease == s.boundaries[i].lease
    {}
    PostKeepBoundaryKeys(s, after);
    forall b | b in after.boundaries
      ensures exists l :: l in after.leases && l.id == b.lease && l.runtime == b.runtime && l.room == b.room
    {
      var i :| 0 <= i < |after.boundaries| && after.boundaries[i] == b;
      assert s.boundaries[i] in s.boundaries;
    }
    PostNoQuarantineChange(s, after);
    PostDrainsUnchanged(s, after);
    PostSameTaskCustody(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
        after.tasks[i].aborted == s.tasks[i].aborted
    {}
    PostKeepsQuarantineAbort(s, after);
    forall t | t in after.tasks && !t.phase.SettledTask? && t.permission.UnknownPermission?
      ensures (t.phase.PendingTask? || t.phase.WaitingForDelivery?) && t.waitsForDelivery &&
        (exists b :: b in after.boundaries && b.runtime == t.runtime && b.room == t.room &&
          b.lease == t.lease && b.status.WaitingDelivery?)
    {
      var i :| 0 <= i < |after.tasks| && after.tasks[i] == t;
      var prior := s.tasks[i];
      assert prior in s.tasks;
      assert prior.permission.UnknownPermission? && !prior.phase.SettledTask?;
      assert prior.phase.PendingTask? || prior.phase.WaitingForDelivery?;
      assert prior.runtime != runtimeId || prior.room != room;
      assert t == prior;
      var j :| 0 <= j < |s.boundaries| && s.boundaries[j].runtime == prior.runtime &&
        s.boundaries[j].room == prior.room && s.boundaries[j].lease == prior.lease &&
        s.boundaries[j].status.WaitingDelivery?;
      assert after.boundaries[j] == s.boundaries[j];
      assert after.boundaries[j] in after.boundaries;
    }
    assert alwaysUnresolvedCaptureHasBoundary(after);
    assert alwaysCapturedSettlementRetained(after);
  }
}

lemma trackPostTask_ensures(s: PostDelivery, taskId: int, runtimeId: int, room: string, leaseId: int, kind: PostTaskKind, cooperative: bool, label_: string, waitsForDelivery: bool)
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysPendingRoomTaskHasLease(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysQuarantineAbortsPending(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysDeliveryBoundaryOwned(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysOneBoundaryPerRoom(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysDrainCountsNonnegative(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysLiveTasksWereIssued(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysLiveDrainsWereIssued(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysUnstartedTasksCannotApply(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysEffectsRequireInvocation(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysDeniedDeliveryBlocksEffects(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysAbortedBeforeInvocationHasNoEffect(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysCapturedSettlementRetained(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysUnresolvedCaptureHasNoEffect(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> alwaysUnresolvedCaptureHasBoundary(trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> stepQuarantinePersists(s, trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> stepQuarantinePreventsNewTasks(s, trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> stepInvocationChecksAbort(s, "trackPostTask", trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> stepQuarantineRetainsPending(s, trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
  ensures (inv(s) ==> canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) ==> stepDrainsReturnEmpty(s, trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery)))
{
  if inv(s) && canTrackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative) {
    var after := trackPostTask(s, taskId, runtimeId, room, leaseId, kind, cooperative, label_, waitsForDelivery);
    PostNoQuarantineChange(s, after);
    var added := after.tasks[|s.tasks|];
    assert after.tasks == s.tasks + [added];
    assert added.runtime == runtimeId;
    PostAcceptsTaskOutsideQuarantine(s, after, runtimeId, added);
    PostIssuedTaskAppend(s, after, taskId);
    PostDrainsUnchanged(s, after);

  }
}

lemma startPostTask_ensures(s: PostDelivery, taskId: int)
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysPendingRoomTaskHasLease(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysQuarantineAbortsPending(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysDeliveryBoundaryOwned(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysOneBoundaryPerRoom(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysDrainCountsNonnegative(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysLiveTasksWereIssued(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysLiveDrainsWereIssued(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysUnstartedTasksCannotApply(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysEffectsRequireInvocation(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysDeniedDeliveryBlocksEffects(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysAbortedBeforeInvocationHasNoEffect(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysCapturedSettlementRetained(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysUnresolvedCaptureHasNoEffect(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> alwaysUnresolvedCaptureHasBoundary(startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> stepQuarantinePersists(s, startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> stepQuarantinePreventsNewTasks(s, startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> stepInvocationChecksAbort(s, "startPostTask", startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> stepQuarantineRetainsPending(s, startPostTask(s, taskId)))
  ensures (inv(s) ==> canStartPostTask(s, taskId) ==> stepDrainsReturnEmpty(s, startPostTask(s, taskId)))
{
  if inv(s) && canStartPostTask(s, taskId) {
    var after := startPostTask(s, taskId);
    PostNoQuarantineChange(s, after);
    PostDrainsUnchanged(s, after);
    PostSameTaskCustody(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
        after.tasks[i].aborted == s.tasks[i].aborted
    {}
    PostKeepsQuarantineAbort(s, after);
  }
}

lemma settlePostTask_ensures(s: PostDelivery, taskId: int, ok: bool)
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysPendingRoomTaskHasLease(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysQuarantineAbortsPending(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysDeliveryBoundaryOwned(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysOneBoundaryPerRoom(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysDrainCountsNonnegative(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysLiveTasksWereIssued(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysLiveDrainsWereIssued(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysUnstartedTasksCannotApply(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysEffectsRequireInvocation(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysDeniedDeliveryBlocksEffects(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysAbortedBeforeInvocationHasNoEffect(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysCapturedSettlementRetained(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysUnresolvedCaptureHasNoEffect(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> alwaysUnresolvedCaptureHasBoundary(settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> stepQuarantinePersists(s, settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> stepQuarantinePreventsNewTasks(s, settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> stepInvocationChecksAbort(s, "settlePostTask", settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> stepQuarantineRetainsPending(s, settlePostTask(s, taskId, ok)))
  ensures (inv(s) ==> canSettlePostTask(s, taskId, ok) ==> stepDrainsReturnEmpty(s, settlePostTask(s, taskId, ok)))
{
  if inv(s) && canSettlePostTask(s, taskId, ok) {
    var after := settlePostTask(s, taskId, ok);
    PostNoQuarantineChange(s, after);
    PostDrainsUnchanged(s, after);
    PostSameTaskCustody(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
        after.tasks[i].aborted == s.tasks[i].aborted
    {}
    PostKeepsQuarantineAbort(s, after);
    forall i | 0 <= i < |s.tasks| && after.tasks[i].phase.PendingTask?
      ensures s.tasks[i].phase.PendingTask? && after.tasks[i] == s.tasks[i]
    {}
    forall i | 0 <= i < |s.tasks| && (after.tasks[i].phase.WaitingForDelivery? || after.tasks[i].phase.RunningTask?)
      ensures (s.tasks[i].phase.WaitingForDelivery? || s.tasks[i].phase.RunningTask?) &&
        after.tasks[i].invoked == s.tasks[i].invoked
    {}
    PostKeepsInvocation(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures after.tasks[i] == s.tasks[i]
    {}
    PostSettlementKeepsUnresolved(s, after);
  }
}

lemma quarantineRuntime_ensures(s: PostDelivery, runtimeId: int)
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysPendingRoomTaskHasLease(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysQuarantineAbortsPending(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysDeliveryBoundaryOwned(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysOneBoundaryPerRoom(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysDrainCountsNonnegative(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysLiveTasksWereIssued(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysLiveDrainsWereIssued(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysUnstartedTasksCannotApply(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysEffectsRequireInvocation(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysDeniedDeliveryBlocksEffects(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysAbortedBeforeInvocationHasNoEffect(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysCapturedSettlementRetained(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysUnresolvedCaptureHasNoEffect(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> alwaysUnresolvedCaptureHasBoundary(quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> stepQuarantinePersists(s, quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> stepQuarantinePreventsNewTasks(s, quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> stepInvocationChecksAbort(s, "quarantineRuntime", quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> stepQuarantineRetainsPending(s, quarantineRuntime(s, runtimeId)))
  ensures (inv(s) ==> canQuarantineRuntime(s, runtimeId) ==> stepDrainsReturnEmpty(s, quarantineRuntime(s, runtimeId)))
{
  if inv(s) && canQuarantineRuntime(s, runtimeId) {
    var after := quarantineRuntime(s, runtimeId);
    PostDrainsUnchanged(s, after);
    PostQuarantinesPersist(s, runtimeId);
    PostQuarantineKeepsLeases(s, runtimeId);
    PostQuarantineRetainsTasks(s, after);
    PostSameTaskCustody(s, after);
  }
}

lemma resumePostTask_ensures(s: PostDelivery, taskId: int)
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysPendingRoomTaskHasLease(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysQuarantineAbortsPending(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysDeliveryBoundaryOwned(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysOneBoundaryPerRoom(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysDrainCountsNonnegative(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysLiveTasksWereIssued(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysLiveDrainsWereIssued(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysUnstartedTasksCannotApply(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysEffectsRequireInvocation(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysDeniedDeliveryBlocksEffects(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysAbortedBeforeInvocationHasNoEffect(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysCapturedSettlementRetained(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysUnresolvedCaptureHasNoEffect(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> alwaysUnresolvedCaptureHasBoundary(resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> stepQuarantinePersists(s, resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> stepQuarantinePreventsNewTasks(s, resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> stepInvocationChecksAbort(s, "resumePostTask", resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> stepQuarantineRetainsPending(s, resumePostTask(s, taskId)))
  ensures (inv(s) ==> canResumePostTask(s, taskId) ==> stepDrainsReturnEmpty(s, resumePostTask(s, taskId)))
{
  if inv(s) && canResumePostTask(s, taskId) {
    var after := resumePostTask(s, taskId);
    PostNoQuarantineChange(s, after);
    PostDrainsUnchanged(s, after);
    PostSameTaskCustody(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
        after.tasks[i].aborted == s.tasks[i].aborted
    {}
    PostKeepsQuarantineAbort(s, after);
    forall i | 0 <= i < |s.tasks| && after.tasks[i].phase.PendingTask?
      ensures s.tasks[i].phase.PendingTask? && after.tasks[i] == s.tasks[i]
    {}
    forall i | 0 <= i < |s.tasks| && (after.tasks[i].phase.WaitingForDelivery? || after.tasks[i].phase.RunningTask?)
      ensures (s.tasks[i].phase.WaitingForDelivery? || s.tasks[i].phase.RunningTask?) &&
        after.tasks[i].invoked == s.tasks[i].invoked
    {}
    PostKeepsInvocation(s, after);
    forall t | t in after.tasks && t.effectApplied
      ensures t.invoked
    {
      var i :| 0 <= i < |after.tasks| && after.tasks[i] == t;
      var prior := s.tasks[i];
      assert prior in s.tasks && prior.effectApplied && prior.invoked;
    }
    assert alwaysEffectsRequireInvocation(after);
  }
}

lemma applyPostTaskEffect_ensures(s: PostDelivery, taskId: int)
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysPendingRoomTaskHasLease(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysQuarantineAbortsPending(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysDeliveryBoundaryOwned(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysOneBoundaryPerRoom(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysDrainCountsNonnegative(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysLiveTasksWereIssued(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysLiveDrainsWereIssued(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysUnstartedTasksCannotApply(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysEffectsRequireInvocation(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysDeniedDeliveryBlocksEffects(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysAbortedBeforeInvocationHasNoEffect(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysCapturedSettlementRetained(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysUnresolvedCaptureHasNoEffect(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> alwaysUnresolvedCaptureHasBoundary(applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> stepQuarantinePersists(s, applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> stepQuarantinePreventsNewTasks(s, applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> stepInvocationChecksAbort(s, "applyPostTaskEffect", applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> stepQuarantineRetainsPending(s, applyPostTaskEffect(s, taskId)))
  ensures (inv(s) ==> canApplyPostTaskEffect(s, taskId) ==> stepDrainsReturnEmpty(s, applyPostTaskEffect(s, taskId)))
{
  if inv(s) && canApplyPostTaskEffect(s, taskId) {
    var after := applyPostTaskEffect(s, taskId);
    PostNoQuarantineChange(s, after);
    PostDrainsUnchanged(s, after);
    PostSameTaskCustody(s, after);
    forall i | 0 <= i < |s.tasks| && !after.tasks[i].phase.SettledTask?
      ensures !s.tasks[i].phase.SettledTask? && after.tasks[i].runtime == s.tasks[i].runtime &&
        after.tasks[i].aborted == s.tasks[i].aborted
    {}
    PostKeepsQuarantineAbort(s, after);
    forall i | 0 <= i < |s.tasks| && after.tasks[i].phase.PendingTask?
      ensures s.tasks[i].phase.PendingTask? && after.tasks[i] == s.tasks[i]
    {}
    forall i | 0 <= i < |s.tasks| && (after.tasks[i].phase.WaitingForDelivery? || after.tasks[i].phase.RunningTask?)
      ensures (s.tasks[i].phase.WaitingForDelivery? || s.tasks[i].phase.RunningTask?) &&
        after.tasks[i].invoked == s.tasks[i].invoked
    {}
    PostKeepsInvocation(s, after);
  }
}

lemma beginPostDrain_ensures(s: PostDelivery, drainId: int, runtimeId: int, room: string, abortable: bool, alreadyAborted: bool)
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysPendingRoomTaskHasLease(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysQuarantineAbortsPending(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysDeliveryBoundaryOwned(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysOneBoundaryPerRoom(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysDrainCountsNonnegative(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysLiveTasksWereIssued(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysLiveDrainsWereIssued(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysUnstartedTasksCannotApply(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysEffectsRequireInvocation(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysDeniedDeliveryBlocksEffects(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysAbortedBeforeInvocationHasNoEffect(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysCapturedSettlementRetained(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysUnresolvedCaptureHasNoEffect(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> alwaysUnresolvedCaptureHasBoundary(beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> stepQuarantinePersists(s, beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> stepQuarantinePreventsNewTasks(s, beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> stepInvocationChecksAbort(s, "beginPostDrain", beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> stepQuarantineRetainsPending(s, beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
  ensures (inv(s) ==> canBeginPostDrain(s, drainId, runtimeId, room, abortable) ==> stepDrainsReturnEmpty(s, beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted)))
{
  if inv(s) && canBeginPostDrain(s, drainId, runtimeId, room, abortable) {
    var after := beginPostDrain(s, drainId, runtimeId, room, abortable, alreadyAborted);
    PostIssuedDrainAppend(s, after, drainId);
    if room == "" && abortable && alreadyAborted && |drainTasks(s, runtimeId, room)| > 0 {
      PostQuarantinesPersist(s, runtimeId);
      PostQuarantineKeepsLeases(s, runtimeId);
      PostQuarantineRetainsTasks(s, after);
    } else {
      PostNoQuarantineChange(s, after);
    }
  }
}

lemma cancelPostDrain_ensures(s: PostDelivery, drainId: int)
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysPendingRoomTaskHasLease(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysQuarantineAbortsPending(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysDeliveryBoundaryOwned(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysOneBoundaryPerRoom(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysDrainCountsNonnegative(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysLiveTasksWereIssued(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysLiveDrainsWereIssued(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysUnstartedTasksCannotApply(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysEffectsRequireInvocation(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysDeniedDeliveryBlocksEffects(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysAbortedBeforeInvocationHasNoEffect(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysCapturedSettlementRetained(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysUnresolvedCaptureHasNoEffect(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> alwaysUnresolvedCaptureHasBoundary(cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> stepQuarantinePersists(s, cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> stepQuarantinePreventsNewTasks(s, cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> stepInvocationChecksAbort(s, "cancelPostDrain", cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> stepQuarantineRetainsPending(s, cancelPostDrain(s, drainId)))
  ensures (inv(s) ==> canCancelPostDrain(s, drainId) ==> stepDrainsReturnEmpty(s, cancelPostDrain(s, drainId)))
{
  if inv(s) && canCancelPostDrain(s, drainId) {
    var selected := ProofLib.Filter((d: PostDrain) => (d.id == drainId), s.drains);
    var runtimeId := if |selected| > 0 then selected[0].runtime else noPostDrain.runtime;
    var after := cancelPostDrain(s, drainId);
    assert after.tasks == quarantineRuntime(s, runtimeId).tasks;
    assert after.runtimes == quarantineRuntime(s, runtimeId).runtimes;
    PostQuarantinesPersist(s, runtimeId);
    PostQuarantineKeepsLeases(s, runtimeId);
    PostQuarantineRetainsTasks(s, after);
  }
}

lemma releasePostLease_ensures(s: PostDelivery, runtimeId: int, room: string, leaseId: int)
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysPendingRoomTaskHasLease(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysQuarantineAbortsPending(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysDeliveryBoundaryOwned(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysOneBoundaryPerRoom(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysDrainCountsNonnegative(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysLiveTasksWereIssued(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysLiveDrainsWereIssued(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysUnstartedTasksCannotApply(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysEffectsRequireInvocation(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysDeniedDeliveryBlocksEffects(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysAbortedBeforeInvocationHasNoEffect(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysCapturedSettlementRetained(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysUnresolvedCaptureHasNoEffect(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> alwaysUnresolvedCaptureHasBoundary(releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> stepQuarantinePersists(s, releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> stepQuarantinePreventsNewTasks(s, releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> stepInvocationChecksAbort(s, "releasePostLease", releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> stepQuarantineRetainsPending(s, releasePostLease(s, runtimeId, room, leaseId)))
  ensures (inv(s) ==> canReleasePostLease(s, runtimeId, room, leaseId) ==> stepDrainsReturnEmpty(s, releasePostLease(s, runtimeId, room, leaseId)))
{
  if inv(s) && canReleasePostLease(s, runtimeId, room, leaseId) {
    var after := releasePostLease(s, runtimeId, room, leaseId);
    var keep := (l: PostLease) => (((l.id != leaseId) || (l.runtime != runtimeId)) || (l.room != room));
    forall b | b in s.boundaries
      ensures exists l :: l in after.leases && l.id == b.lease && l.runtime == b.runtime && l.room == b.room
    {
      var l :| l in s.leases && l.id == b.lease && l.runtime == b.runtime && l.room == b.room;
      assert keep(l);
      ProofLib.FilterMember(keep, s.leases, l);
    }
    PostRoomFilter(s, runtimeId, room);
    forall t | t in after.tasks && !t.phase.SettledTask? && t.room != "" && !quarantined(after, t.runtime)
      ensures exists l :: l in after.leases && l.id == t.lease && l.runtime == t.runtime && l.room == t.room
    {
      assert t in s.tasks;
      if t.runtime == runtimeId && t.room == room {
        var key := (task: PostTask) => roomPending(task, runtimeId, room);
        assert key(t);
        ProofLib.FilterMember(key, s.tasks, t);
        assert t in pendingRoomTasks(s, runtimeId, room);
        assert |pendingRoomTasks(s, runtimeId, room)| == 0;
        assert false;
      }
      var l :| l in s.leases && l.id == t.lease && l.runtime == t.runtime && l.room == t.room;
      assert keep(l);
      ProofLib.FilterMember(keep, s.leases, l);
    }
  }
}
