lemma RoomBatchQueueState(s: MultiRoomLeases)
  requires inv(s)
  ensures core__concurrency_inv(s.queue)
{}

lemma RoomBatchGrantInvariant(s: MultiRoomLeases, room: int)
  requires alwaysQueueInvariant(s)
  ensures alwaysQueueInvariant(grantAvailable(room, s))
{
  if core__concurrency_canGrantRoom(s.queue, room) {
    assert core__concurrency_inv(s.queue);
    core__concurrency_grantRoom_ensures(s.queue, room);
  }
}

lemma RoomBatchLargestWaiter(waiters: seq<core__concurrency_RoomWaiter>)
  requires |waiters| > 0
  ensures (exists largest :: largest in waiters && (forall w :: w in waiters ==> w.room <= largest.room))
  decreases |waiters|
{
  var head := waiters[0];
  if |waiters| > 1 {
    RoomBatchLargestWaiter(waiters[1..]);
    var suffix :| suffix in waiters[1..] && (forall w :: w in waiters[1..] ==> w.room <= suffix.room);
    var largest := if head.room >= suffix.room then head else suffix;
    assert largest in waiters;
    forall w | w in waiters ensures w.room <= largest.room
    {
      if w != head {
        var i :| 0 <= i < |waiters| && waiters[i] == w;
        assert 0 < i;
        assert waiters[1..][i - 1] == w && w in waiters[1..];
      }
    }
  } else {
    assert waiters == [head];
  }
}

lemma RoomBatchIncludesHeldRoom(s: MultiRoomLeases, lease: core__concurrency_Lease)
  requires lease in s.queue.leases
  ensures lease.room in heldRooms(s, lease.caller)
{
  RoomBatchHeldProjection(s, lease.caller);
  var candidates := ProofLib.Filter((l: core__concurrency_Lease) => (l.caller == lease.caller), s.queue.leases);
  ProofLib.FilterMember((l: core__concurrency_Lease) => (l.caller == lease.caller), s.queue.leases, lease);
  var i :| 0 <= i < |candidates| && candidates[i] == lease;
  assert heldRooms(s, lease.caller)[i] == lease.room;
}

lemma RoomBatchHeldProjection(s: MultiRoomLeases, caller: int)
  ensures heldRooms(s, caller) ==
    (var matching := ProofLib.Filter((l: core__concurrency_Lease) => (l.caller == caller), s.queue.leases);
      seq(|matching|, i requires 0 <= i < |matching| => matching[i].room))
{}

lemma RoomBatchWaitChainHasRunnableOwner(s: MultiRoomLeases)
  requires alwaysWaiterHasOwner(s) && alwaysLeasesBelongToBatch(s)
  requires alwaysWaiterMatchesNextRoom(s) && alwaysWaitsAboveHeldRooms(s)
  requires |s.queue.waiting| > 0
  ensures (exists c :: c in s.calls && !c.phase.BatchDone? && !c.phase.BatchWaiting?)
{
  RoomBatchLargestWaiter(s.queue.waiting);
  var largest :| largest in s.queue.waiting && (forall w :: w in s.queue.waiting ==> w.room <= largest.room);
  var lease :| lease in s.queue.leases && lease.room == largest.room;
  var owner :| owner in s.calls && owner.id == lease.caller && !owner.phase.BatchDone? && lease.room in owner.wanted;
  if owner.phase.BatchWaiting? {
    RoomBatchIncludesHeldRoom(s, lease);
    var later :| later in s.queue.waiting && later.caller == owner.id && later.room == wantedRoom(owner);
    assert lease.room < wantedRoom(owner) && later.room <= largest.room;
    assert false;
  }
}

lemma configure_ensures(s: MultiRoomLeases, capacity: int, maxPerRoom: int, maxRooms: int)
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysNestedReuseExact(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysQueueInvariant(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchIdentitiesUnique(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchesHaveValidPosition(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysStoredResultFollowsPhase(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysQueueConfiguredForCalls(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysLeasesBelongToBatch(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaiterHasOwner(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysHeldPrefixMatchesRequests(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysInvocationHoldsAllRooms(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaiterMatchesNextRoom(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysWaitsAboveHeldRooms(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysDoneHasNoLease(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysAcquiringQueueAuthority(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysReverseReleaseRank(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> alwaysBatchProgressOrTerminal(configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepNestedDoesNotAcquire(s, "configure", configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepClosedAdmissionCannotGrow(s, configure(s, capacity, maxPerRoom, maxRooms)))
  ensures (inv(s) ==> canConfigure(s, capacity, maxPerRoom, maxRooms) ==> stepReleasedAfterWriteSettlement(s, configure(s, capacity, maxPerRoom, maxRooms)))
{
  if inv(s) && canConfigure(s, capacity, maxPerRoom, maxRooms) {
    RoomBatchQueueState(s);
    core__concurrency_configureRooms_ensures(s.queue, capacity, maxPerRoom, maxRooms);

    RoomBatchProgress(configure(s, capacity, maxPerRoom, maxRooms));
  }
}

lemma beginWrite_ensures(s: MultiRoomLeases, caller: int, room: int)
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysNestedReuseExact(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueInvariant(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchIdentitiesUnique(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchesHaveValidPosition(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysStoredResultFollowsPhase(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysQueueConfiguredForCalls(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysLeasesBelongToBatch(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaiterHasOwner(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysHeldPrefixMatchesRequests(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysInvocationHoldsAllRooms(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaiterMatchesNextRoom(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysWaitsAboveHeldRooms(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysDoneHasNoLease(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysAcquiringQueueAuthority(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysReverseReleaseRank(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> alwaysBatchProgressOrTerminal(beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepNestedDoesNotAcquire(s, "beginWrite", beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepClosedAdmissionCannotGrow(s, beginWrite(s, caller, room)))
  ensures (inv(s) ==> canBeginWrite(s, caller, room) ==> stepReleasedAfterWriteSettlement(s, beginWrite(s, caller, room)))
{
  if inv(s) && canBeginWrite(s, caller, room) {
    RoomBatchQueueState(s);
    core__concurrency_beginWrite_ensures(s.queue, caller, room);
    RoomBatchProgress(beginWrite(s, caller, room));
  }
}

lemma finishWrite_ensures(s: MultiRoomLeases, caller: int, room: int)
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysNestedReuseExact(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueInvariant(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchIdentitiesUnique(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchesHaveValidPosition(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysStoredResultFollowsPhase(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysQueueConfiguredForCalls(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysLeasesBelongToBatch(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaiterHasOwner(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysHeldPrefixMatchesRequests(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysInvocationHoldsAllRooms(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaiterMatchesNextRoom(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysWaitsAboveHeldRooms(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysDoneHasNoLease(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysAcquiringQueueAuthority(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysReverseReleaseRank(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> alwaysBatchProgressOrTerminal(finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepNestedDoesNotAcquire(s, "finishWrite", finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepClosedAdmissionCannotGrow(s, finishWrite(s, caller, room)))
  ensures (inv(s) ==> canFinishWrite(s, caller, room) ==> stepReleasedAfterWriteSettlement(s, finishWrite(s, caller, room)))
{
  if inv(s) && canFinishWrite(s, caller, room) {
    RoomBatchQueueState(s);
    core__concurrency_finishWrite_ensures(s.queue, caller, room);
    RoomBatchProgress(finishWrite(s, caller, room));
  }
}

lemma closeBatchWrites_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysNestedReuseExact(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysQueueInvariant(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchIdentitiesUnique(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchesHaveValidPosition(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysStoredResultFollowsPhase(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysQueueConfiguredForCalls(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysLeasesBelongToBatch(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaiterHasOwner(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysHeldPrefixMatchesRequests(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysInvocationHoldsAllRooms(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaiterMatchesNextRoom(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysWaitsAboveHeldRooms(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysDoneHasNoLease(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysAcquiringQueueAuthority(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysReverseReleaseRank(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> alwaysBatchProgressOrTerminal(closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepNestedDoesNotAcquire(s, "closeBatchWrites", closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepClosedAdmissionCannotGrow(s, closeBatchWrites(s, caller)))
  ensures (inv(s) ==> canCloseBatchWrites(s, caller) ==> stepReleasedAfterWriteSettlement(s, closeBatchWrites(s, caller)))
{
  if inv(s) && canCloseBatchWrites(s, caller) {
    RoomBatchQueueState(s);
    core__concurrency_closeWrites_ensures(s.queue, caller, releaseRoomId(s, caller));
    RoomBatchProgress(closeBatchWrites(s, caller));
  }
}

lemma finishNextClosingWrite_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysNestedReuseExact(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysQueueInvariant(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchIdentitiesUnique(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchesHaveValidPosition(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysStoredResultFollowsPhase(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysQueueConfiguredForCalls(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysLeasesBelongToBatch(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaiterHasOwner(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysHeldPrefixMatchesRequests(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysInvocationHoldsAllRooms(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaiterMatchesNextRoom(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysWaitsAboveHeldRooms(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysDoneHasNoLease(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysAcquiringQueueAuthority(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysReverseReleaseRank(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> alwaysBatchProgressOrTerminal(finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepNestedDoesNotAcquire(s, "finishNextClosingWrite", finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepClosedAdmissionCannotGrow(s, finishNextClosingWrite(s)))
  ensures (inv(s) ==> canFinishNextClosingWrite(s) ==> stepReleasedAfterWriteSettlement(s, finishNextClosingWrite(s)))
{
  if inv(s) && canFinishNextClosingWrite(s) {
    finishWrite_ensures(s, closingWriter(s).caller, closingWriter(s).room);
    RoomBatchProgress(finishNextClosingWrite(s));
  }
}

lemma advanceNextAcquisition_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysNestedReuseExact(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysQueueInvariant(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchIdentitiesUnique(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchesHaveValidPosition(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysStoredResultFollowsPhase(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysQueueConfiguredForCalls(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysLeasesBelongToBatch(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaiterHasOwner(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysHeldPrefixMatchesRequests(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysInvocationHoldsAllRooms(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaiterMatchesNextRoom(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysWaitsAboveHeldRooms(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysDoneHasNoLease(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysAcquiringQueueAuthority(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysReverseReleaseRank(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> alwaysBatchProgressOrTerminal(advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepNestedDoesNotAcquire(s, "advanceNextAcquisition", advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepClosedAdmissionCannotGrow(s, advanceNextAcquisition(s)))
  ensures (inv(s) ==> canAdvanceNextAcquisition(s) ==> stepReleasedAfterWriteSettlement(s, advanceNextAcquisition(s)))
{
  if inv(s) && canAdvanceNextAcquisition(s) {
    advanceAcquisition_ensures(s, nextAcquisition(s));
  }
}

lemma returnNextBody_ensures(s: MultiRoomLeases, cause: int)
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysNestedReuseExact(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysQueueInvariant(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchIdentitiesUnique(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchesHaveValidPosition(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysStoredResultFollowsPhase(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysQueueConfiguredForCalls(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysLeasesBelongToBatch(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaiterHasOwner(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysHeldPrefixMatchesRequests(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysInvocationHoldsAllRooms(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaiterMatchesNextRoom(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysWaitsAboveHeldRooms(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysDoneHasNoLease(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysAcquiringQueueAuthority(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysReverseReleaseRank(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> alwaysBatchProgressOrTerminal(returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepNestedDoesNotAcquire(s, "returnNextBody", returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepClosedAdmissionCannotGrow(s, returnNextBody(s, cause)))
  ensures (inv(s) ==> canReturnNextBody(s, cause) ==> stepReleasedAfterWriteSettlement(s, returnNextBody(s, cause)))
{
  if inv(s) && canReturnNextBody(s, cause) {
    returnBody_ensures(s, nextBody(s), cause);
    RoomBatchProgress(returnNextBody(s, cause));
  }
}

lemma closeNextBatchWrites_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysNestedReuseExact(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysQueueInvariant(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchIdentitiesUnique(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchesHaveValidPosition(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysStoredResultFollowsPhase(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysQueueConfiguredForCalls(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysLeasesBelongToBatch(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaiterHasOwner(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysHeldPrefixMatchesRequests(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysInvocationHoldsAllRooms(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaiterMatchesNextRoom(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysWaitsAboveHeldRooms(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysDoneHasNoLease(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysAcquiringQueueAuthority(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysReverseReleaseRank(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> alwaysBatchProgressOrTerminal(closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepNestedDoesNotAcquire(s, "closeNextBatchWrites", closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepClosedAdmissionCannotGrow(s, closeNextBatchWrites(s)))
  ensures (inv(s) ==> canCloseNextBatchWrites(s) ==> stepReleasedAfterWriteSettlement(s, closeNextBatchWrites(s)))
{
  if inv(s) && canCloseNextBatchWrites(s) {
    closeBatchWrites_ensures(s, nextWriteClosure(s));
    RoomBatchProgress(closeNextBatchWrites(s));
  }
}

lemma releaseNextBatchRoom_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysNestedReuseExact(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysQueueInvariant(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchIdentitiesUnique(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchesHaveValidPosition(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysStoredResultFollowsPhase(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysQueueConfiguredForCalls(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysLeasesBelongToBatch(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaiterHasOwner(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysHeldPrefixMatchesRequests(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysInvocationHoldsAllRooms(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaiterMatchesNextRoom(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysWaitsAboveHeldRooms(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysDoneHasNoLease(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysAcquiringQueueAuthority(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysReverseReleaseRank(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> alwaysBatchProgressOrTerminal(releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepNestedDoesNotAcquire(s, "releaseNextBatchRoom", releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepClosedAdmissionCannotGrow(s, releaseNextBatchRoom(s)))
  ensures (inv(s) ==> canReleaseNextBatchRoom(s) ==> stepReleasedAfterWriteSettlement(s, releaseNextBatchRoom(s)))
{
  if inv(s) && canReleaseNextBatchRoom(s) {
    releaseBatchRoom_ensures(s, nextRelease(s));
  }
}

lemma finishNextBatch_ensures(s: MultiRoomLeases)
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysNestedReuseExact(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysQueueInvariant(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchIdentitiesUnique(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchesHaveValidPosition(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysStoredResultFollowsPhase(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysQueueConfiguredForCalls(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysLeasesBelongToBatch(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaiterHasOwner(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysHeldPrefixMatchesRequests(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysInvocationHoldsAllRooms(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaiterMatchesNextRoom(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysWaitsAboveHeldRooms(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysDoneHasNoLease(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysAcquiringQueueAuthority(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysReverseReleaseRank(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> alwaysBatchProgressOrTerminal(finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepNestedDoesNotAcquire(s, "finishNextBatch", finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepClosedAdmissionCannotGrow(s, finishNextBatch(s)))
  ensures (inv(s) ==> canFinishNextBatch(s) ==> stepReleasedAfterWriteSettlement(s, finishNextBatch(s)))
{
  if inv(s) && canFinishNextBatch(s) {
    finishBatch_ensures(s, nextFinishedBatch(s));
    RoomBatchProgress(finishNextBatch(s));
  }
}

lemma RoomBatchIdentityLookup(s: MultiRoomLeases, expected: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && expected in s.calls
  ensures batchAt(s, expected.id) == expected
{
  RoomBatchIdentityProjection(s);
  var byId := (c: BatchLeaseCall) => c.id == expected.id;
  var matches := ProofLib.Filter(byId, s.calls);
  ProofLib.FilterMember(byId, s.calls, expected);
  assert |matches| == 1 && matches[0] == expected;
}

lemma RoomBatchIdentityProjection(s: MultiRoomLeases)
  ensures alwaysBatchIdentitiesUnique(s) == (forall c :: c in s.calls ==>
    c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, s.calls)| == 1)
{}

lemma RoomBatchNoWaitOutsideWaiting(s: MultiRoomLeases, expected: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires expected in s.calls && !expected.phase.BatchWaiting?
  ensures forall w :: w in s.queue.waiting ==> w.caller != expected.id
{
  RoomBatchIdentityLookup(s, expected);
}

lemma RoomBatchDedupRetains<T>(xs: seq<T>, acc: seq<T>, item: T)
  ensures (item in acc || item in xs) ==>
    item in Std.Collections.Seq.FoldLeft((a: seq<T>, x: T) => if x in a then a else a + [x], acc, xs)
  decreases |xs|
{
  if |xs| > 0 {
    var appendNew := (a: seq<T>, x: T) => if x in a then a else a + [x];
    var prefix := xs[..|xs|-1];
    var last := xs[|xs|-1];
    assert xs == prefix + [last];
    RoomBatchDedupRetains(prefix, acc, item);
    ProofLib.FoldLeftAppend(appendNew, acc, prefix, last);
  }
}

lemma RoomBatchActiveRoomProjection(s: core__concurrency_RoomState)
  ensures forall l :: l in s.leases ==> l.room in core__concurrency_activeRooms(s)
  ensures forall w :: w in s.waiting ==> w.room in core__concurrency_activeRooms(s)
{
  forall l | l in s.leases ensures l.room in core__concurrency_activeRooms(s) {
    var i :| 0 <= i < |s.leases| && s.leases[i] == l;
    var ids := core__concurrency_activeRoomIds(s);
    assert ids[i] == l.room && l.room in ids;
    RoomBatchDedupRetains(ids, [], l.room);
  }
  forall w | w in s.waiting ensures w.room in core__concurrency_activeRooms(s) {
    var i :| 0 <= i < |s.waiting| && s.waiting[i] == w;
    var ids := core__concurrency_activeRoomIds(s);
    assert ids[|s.leases| + i] == w.room && w.room in ids;
    RoomBatchDedupRetains(ids, [], w.room);
  }
}

lemma RoomBatchAcquisitionCanAdvance(s: MultiRoomLeases, c: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires alwaysQueueConfiguredForCalls(s) && alwaysAcquiringQueueAuthority(s) && alwaysWaitsAboveHeldRooms(s)
  requires c in s.calls && c.phase.BatchAcquiring?
  ensures canAdvanceAcquisition(s, c.id)
{
  RoomBatchIdentityLookup(s, c);
  RoomBatchNoWaitOutsideWaiting(s, c);
  RoomBatchActiveRoomProjection(s.queue);
  var room := wantedRoom(c);
  assert c.id > 0 && room > 0;
  if acquisitionFailure(s, c).BatchPending? {
    assert s.queue.configured && !s.queue.closed;
    assert c.id !in s.queue.cancelled && c.id !in s.queue.sealedCallers && c.id !in s.queue.finishedCallers;
    assert |s.queue.waiting| + |s.queue.leases| < s.queue.capacity;
    assert room in core__concurrency_activeRooms(s.queue) || |core__concurrency_activeRooms(s.queue)| < s.queue.maxRooms;
    assert roomDepth(s, room) < s.queue.maxPerRoom;
    assert core__concurrency_roomOccupancy(s.queue, room) < s.queue.maxPerRoom;
    forall l | l in s.queue.leases && l.caller == c.id ensures l.room < room {
      RoomBatchIncludesHeldRoom(s, l);
    }
    assert core__concurrency_canQueueRoom(s.queue, c.id, room);
  }
}

lemma RoomBatchAscendingFold(rooms: seq<int>, start: HeldRoomOrder)
  ensures Std.Collections.Seq.FoldLeft((a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r), start, rooms).previous ==
    (if |rooms| == 0 then start.previous else rooms[|rooms|-1])
  ensures Std.Collections.Seq.FoldLeft((a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r), start, rooms).ascending ==>
    (start.ascending &&
      (forall i :: 0 <= i < |rooms| ==> start.previous < rooms[i]) &&
      (forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]))
  decreases |rooms|
{
  if |rooms| > 0 {
    var localStep := (a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r);
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    assert rooms == prefix + [last];
    RoomBatchAscendingFold(prefix, start);
    ProofLib.FoldLeftAppend(localStep, start, prefix, last);
    var partial := Std.Collections.Seq.FoldLeft(localStep, start, prefix);
    if partial.ascending && partial.previous < last {
      forall i | 0 <= i < |rooms| ensures start.previous < rooms[i] {
        if i == |prefix| {
          if |prefix| > 0 { assert start.previous < prefix[|prefix|-1] == partial.previous; }
        } else {
          assert prefix[i] == rooms[i];
        }
      }
      forall i, j | 0 <= i < j < |rooms| ensures rooms[i] < rooms[j] {
        if j == |prefix| {
          assert partial.previous == prefix[|prefix|-1];
          if i < |prefix|-1 { assert prefix[i] < partial.previous; }
        } else {
          assert rooms[i] == prefix[i] && rooms[j] == prefix[j];
        }
      }
    }
  }
}

lemma RoomBatchReleaseAuthority(s: MultiRoomLeases, c: BatchLeaseCall)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s)
  requires alwaysReverseReleaseRank(s) && alwaysQueueInvariant(s)
  requires c in s.calls && c.phase.BatchReleasing?
  ensures canFinishBatch(s, c.id) || canCloseBatchWrites(s, c.id) || canReleaseBatchRoom(s, c.id) ||
    (exists item :: item in s.queue.leases && !item.acceptingWrites && item.writes > 0)
{
  RoomBatchIdentityLookup(s, c);
  RoomBatchNoWaitOutsideWaiting(s, c);
  var rooms := heldRooms(s, c.id);
  if |rooms| > 0 {
    var room := releaseRoomId(s, c.id);
    assert room == rooms[|rooms|-1];
    RoomBatchHeldProjection(s, c.id);
    RoomBatchAscendingFold(rooms, emptyHeldRoomOrder);
    var selected := ProofLib.Filter((l: core__concurrency_Lease) => l.caller == c.id, s.queue.leases);
    assert |selected| == |rooms|;
    var lease := selected[|selected|-1];
    ProofLib.FilterMember((l: core__concurrency_Lease) => l.caller == c.id, s.queue.leases, lease);
    assert lease in s.queue.leases && lease.caller == c.id && lease.room == room;
    if lease.acceptingWrites {
      assert core__concurrency_canCloseWrites(s.queue, c.id, room);
    } else if lease.writes == 0 {
      forall l | l in s.queue.leases && l.caller == c.id ensures l.room <= room {
        RoomBatchIncludesHeldRoom(s, l);
        var i :| 0 <= i < |rooms| && rooms[i] == l.room;
        assert rooms[i] <= rooms[|rooms|-1];
      }
      assert core__concurrency_canReleaseRoom(s.queue, c.id, room);
    } else {
      assert lease.writes > 0;
    }
  }
}

lemma RoomBatchEnableScheduler(s: MultiRoomLeases, c: BatchLeaseCall)
  requires c in s.calls
  requires canAdvanceAcquisition(s, c.id) || canReturnBody(s, c.id, 0) || canFinishBatch(s, c.id) || canCloseBatchWrites(s, c.id) || canReleaseBatchRoom(s, c.id)
  ensures batchProgressEnabled(s)
{
  if canAdvanceAcquisition(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canAdvanceAcquisition(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextAcquisition(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canReturnBody(s, c.id, 0) {
    var canRun := (x: BatchLeaseCall) => canReturnBody(s, x.id, 0);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextBody(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canFinishBatch(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canFinishBatch(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextFinishedBatch(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else if canCloseBatchWrites(s, c.id) {
    var canRun := (x: BatchLeaseCall) => canCloseBatchWrites(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextWriteClosure(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  } else {
    var canRun := (x: BatchLeaseCall) => canReleaseBatchRoom(s, x.id);
    var ready := ProofLib.Filter(canRun, s.calls);
    ProofLib.FilterMember(canRun, s.calls, c);
    assert |ready| > 0 && nextRelease(s) == ready[0].id;
    ProofLib.FilterMember(canRun, s.calls, ready[0]);
  }
}

lemma RoomBatchProgress(s: MultiRoomLeases)
  requires alwaysBatchIdentitiesUnique(s) && alwaysWaiterMatchesNextRoom(s) && alwaysQueueInvariant(s)
  requires alwaysQueueConfiguredForCalls(s) && alwaysAcquiringQueueAuthority(s) && alwaysWaitsAboveHeldRooms(s)
  requires alwaysReverseReleaseRank(s) && alwaysLeasesBelongToBatch(s) && alwaysWaiterHasOwner(s)
  ensures alwaysBatchProgressOrTerminal(s)
{
  if !batchTerminal(s) {
    if |s.queue.waiting| > 0 {
      RoomBatchWaitChainHasRunnableOwner(s);
    } else if |s.queue.leases| > 0 {
      var lease := s.queue.leases[0];
      assert lease in s.queue.leases;
      var owner :| owner in s.calls && owner.id == lease.caller && !owner.phase.BatchDone? && lease.room in owner.wanted;
      assert !owner.phase.BatchWaiting?;
    }
    var c :| c in s.calls && !c.phase.BatchDone? && !c.phase.BatchWaiting?;
    if c.phase.BatchAcquiring? {
      RoomBatchAcquisitionCanAdvance(s, c);
    } else if c.phase.BatchInvoking? {
      RoomBatchIdentityLookup(s, c);
      assert canReturnBody(s, c.id, 0);
    } else {
      RoomBatchReleaseAuthority(s, c);
    }
    if exists item :: item in s.queue.leases && !item.acceptingWrites && item.writes > 0 {
      var item :| item in s.queue.leases && !item.acceptingWrites && item.writes > 0;
      var canRun := (l: core__concurrency_Lease) => !l.acceptingWrites && l.writes > 0;
      var ready := ProofLib.Filter(canRun, s.queue.leases);
      ProofLib.FilterMember(canRun, s.queue.leases, item);
      assert |ready| > 0 && closingWriter(s) == ready[0];
      ProofLib.FilterMember(canRun, s.queue.leases, ready[0]);
      assert core__concurrency_canFinishWrite(s.queue, ready[0].caller, ready[0].room);
    } else {
      RoomBatchEnableScheduler(s, c);
    }
  }
}

lemma openBatch_ensures(s: MultiRoomLeases, caller: int, requestedRooms: seq<int>, ambient: int, explicitOwner: int)
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysNestedReuseExact(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysQueueInvariant(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchIdentitiesUnique(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchesHaveValidPosition(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysStoredResultFollowsPhase(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysQueueConfiguredForCalls(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysLeasesBelongToBatch(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaiterHasOwner(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysHeldPrefixMatchesRequests(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysInvocationHoldsAllRooms(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaiterMatchesNextRoom(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysWaitsAboveHeldRooms(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysDoneHasNoLease(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysAcquiringQueueAuthority(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysReverseReleaseRank(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> alwaysBatchProgressOrTerminal(openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepNestedDoesNotAcquire(s, "openBatch", openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepClosedAdmissionCannotGrow(s, openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
  ensures (inv(s) ==> canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) ==> stepReleasedAfterWriteSettlement(s, openBatch(s, caller, requestedRooms, ambient, explicitOwner)))
{
  if inv(s) && canOpenBatch(s, caller, requestedRooms, ambient, explicitOwner) {
    var after := openBatch(s, caller, requestedRooms, ambient, explicitOwner);
    OpenBatchFrame(s, caller, requestedRooms, ambient, explicitOwner);
    OpenBatchPreservesIdentities(s, caller, requestedRooms, ambient, explicitOwner);
    OpenBatchPreservesRoomFacts(s, caller, requestedRooms, ambient, explicitOwner);
    OpenBatchPreservesWaiters(s, caller, requestedRooms, ambient, explicitOwner);
    RoomBatchProgress(after);
  }
}

lemma OpenBatchFrame(s: MultiRoomLeases, caller: int, rooms: seq<int>, ambient: int, owner: int)
  ensures var after := openBatch(s, caller, rooms, ambient, owner);
    after.queue == s.queue && after.nested == s.nested && after.closeCause == s.closeCause &&
    |after.calls| == |s.calls| + 1 &&
    (var added := after.calls[|s.calls|];
      after.calls == s.calls + [added] && added.id == caller && added.position == 0 &&
      added.wanted == orderedRooms(rooms) &&
      (if |rooms| == 0 then added.phase.BatchInvoking? else added.phase.BatchAcquiring?))
{
  reveal openBatch();
}

lemma OrderedBatchRoomsArePositive(rooms: seq<int>)
  requires forall room | room in rooms :: room > 0
  ensures forall room | room in orderedRooms(rooms) :: room > 0
  ensures |orderedRooms(rooms)| == 0 <==> |rooms| == 0
  decreases |rooms|
{
  reveal orderedRooms();
  if |rooms| > 0 {
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    var order := (ordered: seq<int>, room: int) => insertRoom(ordered, room);
    assert rooms == prefix + [last];
    assert last in rooms && last > 0;
    forall room | room in prefix ensures room > 0 {
      assert room in rooms;
    }
    OrderedBatchRoomsArePositive(prefix);
    ProofLib.FoldLeftAppend(order, [], prefix, last);
    var earlier := orderedRooms(prefix);
    var sorted := orderedRooms(rooms);
    assert sorted == insertRoom(earlier, last);
    if last !in earlier {
      reveal insertRoom(), ProofLib.Filter();
      var smaller := (r: int) => r < last;
      var larger := (r: int) => r > last;
      ProofLib.FilterSubset(smaller, earlier);
      ProofLib.FilterSubset(larger, earlier);
      assert sorted == ProofLib.Filter(smaller, earlier) + [last] + ProofLib.Filter(larger, earlier);
      forall room | room in sorted ensures room > 0 {
        if room != last {
          assert room in ProofLib.Filter(smaller, earlier) || room in ProofLib.Filter(larger, earlier);
          assert room in earlier;
        }
      }
    } else {
      reveal insertRoom();
      assert sorted == earlier;
    }
    assert last in sorted;
  }
}

lemma FreshBatchHasNoQueueHistory(s: MultiRoomLeases, caller: int, rooms: seq<int>, ambient: int, owner: int)
  requires inv(s) && canOpenBatch(s, caller, rooms, ambient, owner)
  ensures forall c | c in s.calls :: c.id != caller
  ensures caller !in s.queue.cancelled
  ensures heldRooms(s, caller) == []
{
  reveal canOpenBatch();
  forall c | c in s.calls
    ensures c.id != caller
  {
    if c.id == caller {
      RoomBatchIdentityLookup(s, c);
    }
  }
  assert forall lease | lease in s.queue.leases :: lease.caller != caller;
  RoomBatchHeldProjection(s, caller);
  var sameCaller := (l: core__concurrency_Lease) => (l.caller == caller);
  ProofLib.FilterNone(sameCaller, s.queue.leases);
}

lemma OpenBatchPreservesIdentities(s: MultiRoomLeases, caller: int, rooms: seq<int>, ambient: int, owner: int)
  requires inv(s) && canOpenBatch(s, caller, rooms, ambient, owner)
  ensures alwaysBatchIdentitiesUnique(openBatch(s, caller, rooms, ambient, owner))
{
  var after := openBatch(s, caller, rooms, ambient, owner);
  OpenBatchFrame(s, caller, rooms, ambient, owner);
  FreshBatchHasNoQueueHistory(s, caller, rooms, ambient, owner);
  RoomBatchIdentityProjection(s);
  RoomBatchIdentityProjection(after);
  reveal canOpenBatch();
  var added := after.calls[|s.calls|];
  forall c | c in after.calls
    ensures c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, after.calls)| == 1
  {
    var sameId := (other: BatchLeaseCall) => other.id == c.id;
    ProofLib.FilterAppend(sameId, s.calls, added);
    if c == added {
      ProofLib.FilterNone(sameId, s.calls);
    } else {
      assert c in s.calls;
      assert c.id != added.id;
    }
  }
}

lemma OpenBatchPreservesRoomFacts(s: MultiRoomLeases, caller: int, rooms: seq<int>, ambient: int, owner: int)
  requires inv(s) && canOpenBatch(s, caller, rooms, ambient, owner)
  ensures alwaysBatchesHaveValidPosition(openBatch(s, caller, rooms, ambient, owner))
  ensures alwaysHeldPrefixMatchesRequests(openBatch(s, caller, rooms, ambient, owner))
  ensures alwaysInvocationHoldsAllRooms(openBatch(s, caller, rooms, ambient, owner))
  ensures alwaysWaitsAboveHeldRooms(openBatch(s, caller, rooms, ambient, owner))
  ensures alwaysAcquiringQueueAuthority(openBatch(s, caller, rooms, ambient, owner))
{
  var after := openBatch(s, caller, rooms, ambient, owner);
  OpenBatchFrame(s, caller, rooms, ambient, owner);
  FreshBatchHasNoQueueHistory(s, caller, rooms, ambient, owner);
  reveal canOpenBatch();
  OrderedBatchRoomsArePositive(rooms);
  var added := after.calls[|s.calls|];
  assert heldRooms(after, caller) == [];
  if |rooms| > 0 {
    assert |added.wanted| > 0;
    assert added.wanted[0] in orderedRooms(rooms);
    assert added.wanted[0] > 0;
    reveal wantedRoom();
    assert wantedRoom(added) == added.wanted[0];
  }
  forall c | c in after.calls
    ensures 0 <= c.position <= |c.wanted| &&
      (c.phase.BatchAcquiring? || c.phase.BatchWaiting? ==> c.position < |c.wanted|)
    ensures c.phase.BatchAcquiring? || c.phase.BatchWaiting? ==>
      |heldRooms(after, c.id)| == c.position && (forall room | room in heldRooms(after, c.id) :: room in c.wanted)
    ensures c.phase.BatchInvoking? ==> heldRooms(after, c.id) == c.wanted && c.position == |c.wanted|
    ensures c.phase.BatchAcquiring? || c.phase.BatchWaiting? ==>
      wantedRoom(c) > 0 && (forall room | room in heldRooms(after, c.id) :: room < wantedRoom(c))
    ensures c.phase.BatchAcquiring? ==> c.id !in after.queue.cancelled
  {
    if c != added {
      assert c in s.calls;
      assert heldRooms(s, c.id) == heldRooms(after, c.id);
    }
  }
}

lemma OpenBatchPreservesWaiters(s: MultiRoomLeases, caller: int, rooms: seq<int>, ambient: int, owner: int)
  requires inv(s) && canOpenBatch(s, caller, rooms, ambient, owner)
  requires alwaysBatchIdentitiesUnique(openBatch(s, caller, rooms, ambient, owner))
  ensures alwaysWaiterMatchesNextRoom(openBatch(s, caller, rooms, ambient, owner))
{
  var after := openBatch(s, caller, rooms, ambient, owner);
  OpenBatchFrame(s, caller, rooms, ambient, owner);
  var added := after.calls[|s.calls|];
  forall waiter | waiter in after.queue.waiting
    ensures batchAt(after, waiter.caller).phase.BatchWaiting? &&
      wantedRoom(batchAt(after, waiter.caller)) == waiter.room
  {
    var prior := batchAt(s, waiter.caller);
    assert prior.phase.BatchWaiting?;
    var byId := (c: BatchLeaseCall) => (c.id == waiter.caller);
    var matching := ProofLib.Filter(byId, s.calls);
    reveal batchAt(), ProofLib.Filter();
    assert |matching| > 0 && prior == matching[0];
    ProofLib.FilterMember(byId, s.calls, prior);
    assert prior in after.calls && prior.id == waiter.caller;
    RoomBatchIdentityLookup(after, prior);
  }
  assert forall c | c in after.calls && c.phase.BatchWaiting? :: c in s.calls && c != added;
}

lemma closeAdmission_ensures(s: MultiRoomLeases, cause: int)
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysNestedReuseExact(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysQueueInvariant(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchIdentitiesUnique(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchesHaveValidPosition(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysStoredResultFollowsPhase(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysQueueConfiguredForCalls(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysLeasesBelongToBatch(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaiterHasOwner(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysHeldPrefixMatchesRequests(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysInvocationHoldsAllRooms(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaiterMatchesNextRoom(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysWaitsAboveHeldRooms(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysDoneHasNoLease(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysAcquiringQueueAuthority(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysReverseReleaseRank(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> alwaysBatchProgressOrTerminal(closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepNestedDoesNotAcquire(s, "closeAdmission", closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepClosedAdmissionCannotGrow(s, closeAdmission(s, cause)))
  ensures (inv(s) ==> canCloseAdmission(s, cause) ==> stepReleasedAfterWriteSettlement(s, closeAdmission(s, cause)))
{
  if inv(s) && canCloseAdmission(s, cause) {
    RoomBatchProgress(closeAdmission(s, cause));
  }
}

lemma resolveNested_ensures(s: MultiRoomLeases, requestedRooms: seq<int>, ambient: int, explicitOwner: int, explicitRoom: int)
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysNestedReuseExact(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysQueueInvariant(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchIdentitiesUnique(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchesHaveValidPosition(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysStoredResultFollowsPhase(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysQueueConfiguredForCalls(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysLeasesBelongToBatch(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaiterHasOwner(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysHeldPrefixMatchesRequests(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysInvocationHoldsAllRooms(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaiterMatchesNextRoom(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysWaitsAboveHeldRooms(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysDoneHasNoLease(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysAcquiringQueueAuthority(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysReverseReleaseRank(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> alwaysBatchProgressOrTerminal(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepNestedDoesNotAcquire(s, "resolveNested", resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepClosedAdmissionCannotGrow(s, resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
  ensures (inv(s) ==> canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) ==> stepReleasedAfterWriteSettlement(s, resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom)))
{
  if inv(s) && canResolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom) {
    RoomBatchProgress(resolveNested(s, requestedRooms, ambient, explicitOwner, explicitRoom));
  }
}
