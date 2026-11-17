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
    RoomBeginWriteKeepsOwnership(s, caller, room);
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
    RoomFinishWriteKeepsOwnership(s, caller, room);
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
    RoomCloseWritesKeepsOwnership(s, caller);
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
  ensures roomRanksAscending(orderedRooms(rooms))
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
    RoomInsertionPreservesRank(earlier, last);
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

lemma RoomBatchAscendingFromRanks(rooms: seq<int>)
  requires forall i :: 0 <= i < |rooms| ==> 0 < rooms[i]
  requires forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]
  ensures roomRanksAscending(rooms)
  decreases |rooms|
{
  reveal roomRanksAscending();
  if |rooms| > 0 {
    var prefix := rooms[..|rooms|-1];
    var last := rooms[|rooms|-1];
    var rank := (a: HeldRoomOrder, r: int) => HeldRoomOrder(r, a.ascending && a.previous < r);
    assert rooms == prefix + [last];
    RoomBatchAscendingFromRanks(prefix);
    RoomBatchAscendingFold(prefix, emptyHeldRoomOrder);
    ProofLib.FoldLeftAppend(rank, emptyHeldRoomOrder, prefix, last);
  }
}

lemma FilterKeepsRoomRanks(keep: int -> bool, rooms: seq<int>)
  requires forall i, j :: 0 <= i < j < |rooms| ==> rooms[i] < rooms[j]
  ensures var kept := ProofLib.Filter(keep, rooms);
    forall i, j :: 0 <= i < j < |kept| ==> kept[i] < kept[j]
  decreases |rooms|
{
  if |rooms| > 0 {
    var tail := rooms[1..];
    FilterKeepsRoomRanks(keep, tail);
    ProofLib.FilterCons(keep, rooms);
    if keep(rooms[0]) {
      var remainder := ProofLib.Filter(keep, tail);
      var kept := ProofLib.Filter(keep, rooms);
      ProofLib.FilterSubset(keep, tail);
      forall i, j | 0 <= i < j < |kept| ensures kept[i] < kept[j] {
        if i == 0 {
          var index :| 0 <= index < |tail| && tail[index] == remainder[j-1];
          assert rooms[index+1] == kept[j];
        } else {
          assert kept[i] == remainder[i-1] && kept[j] == remainder[j-1];
        }
      }
    }
  }
}

lemma RoomInsertionPreservesRank(rooms: seq<int>, room: int)
  requires roomRanksAscending(rooms) && room > 0
  ensures roomRanksAscending(insertRoom(rooms, room))
{
  reveal insertRoom(), roomRanksAscending();
  if room !in rooms {
    var smaller := (value: int) => value < room;
    var larger := (value: int) => value > room;
    var lower := ProofLib.Filter(smaller, rooms);
    var upper := ProofLib.Filter(larger, rooms);
    var inserted := insertRoom(rooms, room);
    assert inserted == lower + [room] + upper;
    RoomBatchAscendingFold(rooms, emptyHeldRoomOrder);
    FilterKeepsRoomRanks(smaller, rooms);
    FilterKeepsRoomRanks(larger, rooms);
    forall i | 0 <= i < |inserted|
      ensures 0 < inserted[i]
      ensures i < |lower| ==> inserted[i] < room
      ensures |lower| < i ==> room < inserted[i]
    {
      if i != |lower| {
        if i < |lower| {
          ProofLib.FilterMember(smaller, rooms, inserted[i]);
        } else {
          ProofLib.FilterMember(larger, rooms, inserted[i]);
        }
        var index :| 0 <= index < |rooms| && rooms[index] == inserted[i];
      }
    }
    forall i, j | 0 <= i < j < |inserted| ensures inserted[i] < inserted[j] {
      if j < |lower| {
        assert inserted[i] == lower[i] && inserted[j] == lower[j];
      } else if |lower| < i {
        assert inserted[i] == upper[i-|lower|-1] && inserted[j] == upper[j-|lower|-1];
      }
    }
    RoomBatchAscendingFromRanks(inserted);
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
    ensures roomRanksAscending(c.wanted)
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

lemma abortBatch_ensures(s: MultiRoomLeases, caller: int, cause: int)
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysNestedReuseExact(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysQueueInvariant(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchIdentitiesUnique(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchesHaveValidPosition(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysStoredResultFollowsPhase(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysQueueConfiguredForCalls(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysLeasesBelongToBatch(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaiterHasOwner(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysHeldPrefixMatchesRequests(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysInvocationHoldsAllRooms(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaiterMatchesNextRoom(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysWaitsAboveHeldRooms(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysDoneHasNoLease(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysAcquiringQueueAuthority(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysReverseReleaseRank(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> alwaysBatchProgressOrTerminal(abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepNestedDoesNotAcquire(s, "abortBatch", abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepClosedAdmissionCannotGrow(s, abortBatch(s, caller, cause)))
  ensures (inv(s) ==> canAbortBatch(s, caller, cause) ==> stepReleasedAfterWriteSettlement(s, abortBatch(s, caller, cause)))
{
  if inv(s) && canAbortBatch(s, caller, cause) {
    var after := abortBatch(s, caller, cause);
    AbortBatchFrame(s, caller, cause);
    if batchAt(s, caller).phase.BatchWaiting? {
      reveal canAbortBatch();
      core__concurrency_cancelQueued_ensures(s.queue, caller);
    }
    RoomBatchMapIdentities(s, after);
    AbortBatchPreservesWaiters(s, caller, cause);
    AbortBatchPreservesOwners(s, caller, cause);
    RoomBatchProgress(after);
  }
}

lemma AbortBatchFrame(s: MultiRoomLeases, caller: int, cause: int)
  requires alwaysBatchIdentitiesUnique(s) && canAbortBatch(s, caller, cause)
  ensures var after := abortBatch(s, caller, cause);
    var batch := batchAt(s, caller);
    batch in s.calls && batch.id == caller &&
    after.queue.leases == s.queue.leases && after.queue.configured == s.queue.configured &&
    after.queue.sealedCallers == s.queue.sealedCallers && after.queue.finishedCallers == s.queue.finishedCallers &&
    |after.calls| == |s.calls| &&
    (forall i | 0 <= i < |s.calls| ::
      var prior := s.calls[i];
      var next := after.calls[i];
      next.id == prior.id && next.position == prior.position && next.wanted == prior.wanted &&
      (if prior.id == caller && batch.phase.BatchWaiting? then prior == batch && next.phase.BatchReleasing?
       else next.phase == prior.phase && next.resultKind == prior.resultKind)) &&
    (if batch.phase.BatchWaiting? then
      (forall w :: w in after.queue.waiting <==> w in s.queue.waiting && w.caller != caller) &&
      (forall id :: id in after.queue.cancelled <==> id in s.queue.cancelled || id == caller)
     else after.queue == s.queue)
{
  reveal canAbortBatch(), batchAt(), abortBatch();
  var ids := (c: BatchLeaseCall) => c.id == caller;
  var matches := ProofLib.Filter(ids, s.calls);
  var batch := batchAt(s, caller);
  assert |matches| > 0 && batch == matches[0];
  ProofLib.FilterMember(ids, s.calls, batch);
  var after := abortBatch(s, caller, cause);
  forall i | 0 <= i < |s.calls|
    ensures var prior := s.calls[i];
      var next := after.calls[i];
      next.id == prior.id && next.position == prior.position && next.wanted == prior.wanted &&
      (if prior.id == caller && batch.phase.BatchWaiting? then prior == batch && next.phase.BatchReleasing?
       else next.phase == prior.phase && next.resultKind == prior.resultKind)
  {
    if s.calls[i].id == caller {
      RoomBatchIdentityLookup(s, s.calls[i]);
    }
  }
  if batch.phase.BatchWaiting? {
    reveal core__concurrency_cancelQueued();
    forall w: core__concurrency_RoomWaiter
      ensures w in after.queue.waiting <==> w in s.queue.waiting && w.caller != caller
    {
      ProofLib.FilterMember((w: core__concurrency_RoomWaiter) => w.caller != caller, s.queue.waiting, w);
    }
    var unrecorded := (id: int) => id !in s.queue.cancelled;
    var appended := ProofLib.Filter(unrecorded, [caller]);
    assert after.queue.cancelled == s.queue.cancelled + appended;
    forall id: int
      ensures id in after.queue.cancelled <==> id in s.queue.cancelled || id == caller
    {
      ProofLib.FilterMember(unrecorded, [caller], id);
      assert id in appended <==> id == caller && unrecorded(id);
    }
  }
}

lemma RoomBatchMapIdentities(before: MultiRoomLeases, after: MultiRoomLeases)
  requires alwaysBatchIdentitiesUnique(before)
  requires |before.calls| == |after.calls|
  requires forall i | 0 <= i < |before.calls| :: before.calls[i].id == after.calls[i].id
  ensures alwaysBatchIdentitiesUnique(after)
{
  RoomBatchIdentityProjection(before);
  RoomBatchIdentityProjection(after);
  forall c | c in after.calls
    ensures c.id > 0 && |ProofLib.Filter((other: BatchLeaseCall) => other.id == c.id, after.calls)| == 1
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert before.calls[i] in before.calls;
    var byId := (other: BatchLeaseCall) => other.id == c.id;
    ProofLib.FilterLengthPointwise(byId, byId, before.calls, after.calls);
  }
}

lemma AbortBatchPreservesWaiters(s: MultiRoomLeases, caller: int, cause: int)
  requires inv(s) && canAbortBatch(s, caller, cause)
  ensures alwaysWaiterMatchesNextRoom(abortBatch(s, caller, cause))
  ensures alwaysWaiterHasOwner(abortBatch(s, caller, cause))
  ensures stepClosedAdmissionCannotGrow(s, abortBatch(s, caller, cause))
{
  var after := abortBatch(s, caller, cause);
  AbortBatchFrame(s, caller, cause);
  RoomBatchMapIdentities(s, after);
  forall w | w in after.queue.waiting
    ensures w in s.queue.waiting && batchAt(after, w.caller).phase.BatchWaiting? &&
      wantedRoom(batchAt(after, w.caller)) == w.room
  {
    var prior := batchAt(s, w.caller);
    reveal batchAt();
    var byId := (c: BatchLeaseCall) => c.id == w.caller;
    var matches := ProofLib.Filter(byId, s.calls);
    assert prior.phase.BatchWaiting? && |matches| > 0 && prior == matches[0];
    ProofLib.FilterMember(byId, s.calls, prior);
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    var next := after.calls[i];
    assert next in after.calls && next.id == prior.id && next.phase == prior.phase;
    RoomBatchIdentityLookup(after, next);
  }
  forall c | c in after.calls && c.phase.BatchWaiting?
    ensures exists w :: w in after.queue.waiting && w.caller == c.id && w.room == wantedRoom(c)
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    var prior := s.calls[i];
    assert prior in s.calls && prior.phase.BatchWaiting?;
    var w :| w in s.queue.waiting && w.caller == prior.id && w.room == wantedRoom(prior);
    assert w in after.queue.waiting && w.room == wantedRoom(c);
  }
}

lemma AbortBatchPreservesOwners(s: MultiRoomLeases, caller: int, cause: int)
  requires inv(s) && canAbortBatch(s, caller, cause)
  ensures alwaysLeasesBelongToBatch(abortBatch(s, caller, cause))
  ensures alwaysDoneHasNoLease(abortBatch(s, caller, cause))
  ensures alwaysAcquiringQueueAuthority(abortBatch(s, caller, cause))
{
  var after := abortBatch(s, caller, cause);
  AbortBatchFrame(s, caller, cause);
  forall l | l in after.queue.leases
    ensures exists c :: c in after.calls && c.id == l.caller && !c.phase.BatchDone? && l.room in c.wanted
  {
    var prior :| prior in s.calls && prior.id == l.caller && !prior.phase.BatchDone? && l.room in prior.wanted;
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    assert after.calls[i] in after.calls;
  }
  forall c | c in after.calls && c.phase.BatchDone?
    ensures |heldRooms(after, c.id)| == 0 &&
      (forall w :: w in after.queue.waiting ==> w.caller != c.id) && !c.resultKind.BatchPending?
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert s.calls[i] in s.calls && s.calls[i].phase.BatchDone?;
  }
  forall id | id in after.queue.cancelled
    ensures exists c :: c in after.calls && c.id == id
  {
    var prior :| prior in s.calls && prior.id == id;
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    assert after.calls[i] in after.calls;
  }
  forall c | c in after.calls && c.phase.BatchAcquiring?
    ensures c.id !in after.queue.cancelled
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert s.calls[i] in s.calls && s.calls[i].phase.BatchAcquiring?;
  }
}

lemma RoomWriterRetainsHeldRooms(before: MultiRoomLeases, after: MultiRoomLeases, caller: int)
  requires |before.queue.leases| == |after.queue.leases|
  requires forall i | 0 <= i < |before.queue.leases| ::
    before.queue.leases[i].caller == after.queue.leases[i].caller &&
    before.queue.leases[i].room == after.queue.leases[i].room
  ensures heldRooms(before, caller) == heldRooms(after, caller)
{
  var belongs := (lease: core__concurrency_Lease) => lease.caller == caller;
  var sameRoom := (prior: core__concurrency_Lease, next: core__concurrency_Lease) => prior.room == next.room;
  var original := ProofLib.Filter(belongs, before.queue.leases);
  var retained := ProofLib.Filter(belongs, after.queue.leases);
  ProofLib.FilterPointwise(belongs, belongs, sameRoom, before.queue.leases, after.queue.leases);
  RoomBatchHeldProjection(before, caller);
  RoomBatchHeldProjection(after, caller);
  forall i | 0 <= i < |original| ensures heldRooms(before, caller)[i] == heldRooms(after, caller)[i] {
    assert original[i].room == retained[i].room;
  }
}

lemma RoomWriterKeepsLeasePairs(before: seq<core__concurrency_Lease>, after: seq<core__concurrency_Lease>)
  requires |before| == |after|
  requires forall i | 0 <= i < |before| ::
    before[i].caller == after[i].caller && before[i].room == after[i].room
  ensures forall lease | lease in before ::
    (exists next :: next in after && next.caller == lease.caller && next.room == lease.room)
  ensures forall lease | lease in after ::
    (exists prior :: prior in before && prior.caller == lease.caller && prior.room == lease.room)
{
  forall lease | lease in before
    ensures (exists next :: next in after && next.caller == lease.caller && next.room == lease.room)
  {
    var i :| 0 <= i < |before| && before[i] == lease;
    assert after[i] in after;
  }
  forall lease | lease in after
    ensures (exists prior :: prior in before && prior.caller == lease.caller && prior.room == lease.room)
  {
    var i :| 0 <= i < |after| && after[i] == lease;
    assert before[i] in before;
  }
}

lemma RoomWriterKeepsBatchOwnership(before: MultiRoomLeases, after: MultiRoomLeases)
  requires inv(before)
  requires after == before.(queue := before.queue.(leases := after.queue.leases))
  requires |before.queue.leases| == |after.queue.leases|
  requires forall i | 0 <= i < |before.queue.leases| ::
    before.queue.leases[i].caller == after.queue.leases[i].caller &&
    before.queue.leases[i].room == after.queue.leases[i].room
  ensures alwaysLeasesBelongToBatch(after) && alwaysWaiterHasOwner(after)
  ensures alwaysHeldPrefixMatchesRequests(after) && alwaysInvocationHoldsAllRooms(after)
  ensures alwaysWaiterMatchesNextRoom(after) && alwaysWaitsAboveHeldRooms(after)
  ensures alwaysDoneHasNoLease(after) && alwaysReverseReleaseRank(after)
  ensures stepReleasedAfterWriteSettlement(before, after)
{
  RoomWriterKeepsLeasePairs(before.queue.leases, after.queue.leases);
  RoomWriterRetainsBatchLeaseOwners(before, after);
  RoomWriterRetainsWaiterLeaseOwners(before, after);
  RoomWriterRetainsBatchRoomPlans(before, after);
  RoomWriterRetainsWaitingBatches(before, after);
}

lemma RoomWriterRetainsWaitingBatches(before: MultiRoomLeases, after: MultiRoomLeases)
  requires alwaysWaiterMatchesNextRoom(before)
  requires after.calls == before.calls && after.queue.waiting == before.queue.waiting
  ensures alwaysWaiterMatchesNextRoom(after)
{
  reveal batchAt();
  forall w | w in after.queue.waiting
    ensures batchAt(after, w.caller) == batchAt(before, w.caller)
  {}
}

lemma RoomWriterRetainsBatchLeaseOwners(before: MultiRoomLeases, after: MultiRoomLeases)
  requires alwaysLeasesBelongToBatch(before) && after.calls == before.calls
  requires forall lease | lease in after.queue.leases ::
    (exists prior :: prior in before.queue.leases && prior.caller == lease.caller && prior.room == lease.room)
  ensures alwaysLeasesBelongToBatch(after)
{
  forall lease | lease in after.queue.leases
    ensures (exists c :: c in after.calls && c.id == lease.caller && !c.phase.BatchDone? && lease.room in c.wanted)
  {
    var prior :| prior in before.queue.leases && prior.caller == lease.caller && prior.room == lease.room;
  }
}

lemma RoomWriterRetainsWaiterLeaseOwners(before: MultiRoomLeases, after: MultiRoomLeases)
  requires alwaysWaiterHasOwner(before) && after.queue.waiting == before.queue.waiting
  requires forall lease | lease in before.queue.leases ::
    (exists next :: next in after.queue.leases && next.caller == lease.caller && next.room == lease.room)
  ensures alwaysWaiterHasOwner(after)
  ensures stepReleasedAfterWriteSettlement(before, after)
{
  forall w | w in after.queue.waiting
    ensures (exists lease :: lease in after.queue.leases && lease.room == w.room)
  {
    var prior :| prior in before.queue.leases && prior.room == w.room;
  }
}

lemma RoomWriterRetainsBatchRoomPlans(before: MultiRoomLeases, after: MultiRoomLeases)
  requires after.calls == before.calls && after.queue.waiting == before.queue.waiting
  requires alwaysHeldPrefixMatchesRequests(before) && alwaysInvocationHoldsAllRooms(before)
  requires alwaysWaitsAboveHeldRooms(before) && alwaysDoneHasNoLease(before) && alwaysReverseReleaseRank(before)
  requires |before.queue.leases| == |after.queue.leases|
  requires forall i | 0 <= i < |before.queue.leases| ::
    before.queue.leases[i].caller == after.queue.leases[i].caller &&
    before.queue.leases[i].room == after.queue.leases[i].room
  ensures alwaysHeldPrefixMatchesRequests(after) && alwaysInvocationHoldsAllRooms(after)
  ensures alwaysWaitsAboveHeldRooms(after) && alwaysDoneHasNoLease(after) && alwaysReverseReleaseRank(after)
{
  forall c | c in after.calls ensures heldRooms(before, c.id) == heldRooms(after, c.id) {
    RoomWriterRetainsHeldRooms(before, after, c.id);
  }
}

lemma RoomWriterTransitionKeepsOwnership(before: MultiRoomLeases, after: MultiRoomLeases)
  requires inv(before)
  requires after.calls == before.calls && after.nested == before.nested && after.closeCause == before.closeCause
  requires after.queue == before.queue.(leases := after.queue.leases)
  requires |before.queue.leases| == |after.queue.leases|
  requires forall i | 0 <= i < |before.queue.leases| ::
    before.queue.leases[i].caller == after.queue.leases[i].caller &&
    before.queue.leases[i].room == after.queue.leases[i].room
  ensures alwaysLeasesBelongToBatch(after) && alwaysWaiterHasOwner(after)
  ensures alwaysHeldPrefixMatchesRequests(after) && alwaysInvocationHoldsAllRooms(after)
  ensures alwaysWaiterMatchesNextRoom(after) && alwaysWaitsAboveHeldRooms(after)
  ensures alwaysDoneHasNoLease(after) && alwaysReverseReleaseRank(after)
  ensures stepReleasedAfterWriteSettlement(before, after)
{
  RoomWriterKeepsBatchOwnership(before, after);
}

lemma RoomBeginWriteKeepsOwnership(s: MultiRoomLeases, caller: int, room: int)
  requires inv(s)
  ensures alwaysLeasesBelongToBatch(beginWrite(s, caller, room)) && alwaysWaiterHasOwner(beginWrite(s, caller, room))
  ensures alwaysHeldPrefixMatchesRequests(beginWrite(s, caller, room)) && alwaysInvocationHoldsAllRooms(beginWrite(s, caller, room))
  ensures alwaysWaiterMatchesNextRoom(beginWrite(s, caller, room)) && alwaysWaitsAboveHeldRooms(beginWrite(s, caller, room))
  ensures alwaysDoneHasNoLease(beginWrite(s, caller, room)) && alwaysReverseReleaseRank(beginWrite(s, caller, room))
  ensures stepReleasedAfterWriteSettlement(s, beginWrite(s, caller, room))
{
  var after := beginWrite(s, caller, room);
  RoomWriterTransitionKeepsOwnership(s, after);
}

lemma RoomFinishWriteKeepsOwnership(s: MultiRoomLeases, caller: int, room: int)
  requires inv(s)
  ensures alwaysLeasesBelongToBatch(finishWrite(s, caller, room)) && alwaysWaiterHasOwner(finishWrite(s, caller, room))
  ensures alwaysHeldPrefixMatchesRequests(finishWrite(s, caller, room)) && alwaysInvocationHoldsAllRooms(finishWrite(s, caller, room))
  ensures alwaysWaiterMatchesNextRoom(finishWrite(s, caller, room)) && alwaysWaitsAboveHeldRooms(finishWrite(s, caller, room))
  ensures alwaysDoneHasNoLease(finishWrite(s, caller, room)) && alwaysReverseReleaseRank(finishWrite(s, caller, room))
  ensures stepReleasedAfterWriteSettlement(s, finishWrite(s, caller, room))
{
  var after := finishWrite(s, caller, room);
  RoomWriterTransitionKeepsOwnership(s, after);
}

lemma RoomCloseWritesKeepsOwnership(s: MultiRoomLeases, caller: int)
  requires inv(s)
  ensures alwaysLeasesBelongToBatch(closeBatchWrites(s, caller)) && alwaysWaiterHasOwner(closeBatchWrites(s, caller))
  ensures alwaysHeldPrefixMatchesRequests(closeBatchWrites(s, caller)) && alwaysInvocationHoldsAllRooms(closeBatchWrites(s, caller))
  ensures alwaysWaiterMatchesNextRoom(closeBatchWrites(s, caller)) && alwaysWaitsAboveHeldRooms(closeBatchWrites(s, caller))
  ensures alwaysDoneHasNoLease(closeBatchWrites(s, caller)) && alwaysReverseReleaseRank(closeBatchWrites(s, caller))
  ensures stepReleasedAfterWriteSettlement(s, closeBatchWrites(s, caller))
{
  var after := closeBatchWrites(s, caller);
  RoomWriterTransitionKeepsOwnership(s, after);
}

lemma returnBody_ensures(s: MultiRoomLeases, caller: int, cause: int)
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysNestedReuseExact(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysQueueInvariant(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchIdentitiesUnique(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchesHaveValidPosition(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysStoredResultFollowsPhase(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysQueueConfiguredForCalls(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysLeasesBelongToBatch(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaiterHasOwner(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysHeldPrefixMatchesRequests(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysInvocationHoldsAllRooms(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaiterMatchesNextRoom(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysWaitsAboveHeldRooms(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysDoneHasNoLease(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysAcquiringQueueAuthority(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysReverseReleaseRank(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> alwaysBatchProgressOrTerminal(returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepNestedDoesNotAcquire(s, "returnBody", returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepClosedAdmissionCannotGrow(s, returnBody(s, caller, cause)))
  ensures (inv(s) ==> canReturnBody(s, caller, cause) ==> stepReleasedAfterWriteSettlement(s, returnBody(s, caller, cause)))
{
  if inv(s) && canReturnBody(s, caller, cause) {
    reveal returnBody(), canReturnBody();
    var after := returnBody(s, caller, cause);
    forall i | 0 <= i < |s.calls| && s.calls[i].id == caller
      ensures s.calls[i] == batchAt(s, caller) && s.calls[i].phase.BatchInvoking?
    {
      assert s.calls[i] in s.calls;
      RoomBatchIdentityLookup(s, s.calls[i]);
    }
    RoomCompletionKeepsNonWaitingOwnership(s, after, caller);
    RoomBatchProgress(after);
  }
}

lemma finishBatch_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysNestedReuseExact(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysQueueInvariant(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchIdentitiesUnique(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchesHaveValidPosition(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysStoredResultFollowsPhase(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysQueueConfiguredForCalls(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysLeasesBelongToBatch(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaiterHasOwner(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysHeldPrefixMatchesRequests(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysInvocationHoldsAllRooms(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaiterMatchesNextRoom(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysWaitsAboveHeldRooms(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysDoneHasNoLease(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysAcquiringQueueAuthority(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysReverseReleaseRank(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> alwaysBatchProgressOrTerminal(finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepNestedDoesNotAcquire(s, "finishBatch", finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepClosedAdmissionCannotGrow(s, finishBatch(s, caller)))
  ensures (inv(s) ==> canFinishBatch(s, caller) ==> stepReleasedAfterWriteSettlement(s, finishBatch(s, caller)))
{
  if inv(s) && canFinishBatch(s, caller) {
    reveal finishBatch(), canFinishBatch();
    var after := finishBatch(s, caller);
    forall i | 0 <= i < |s.calls| && s.calls[i].id == caller
      ensures s.calls[i] == batchAt(s, caller) && s.calls[i].phase.BatchReleasing?
    {
      assert s.calls[i] in s.calls;
      RoomBatchIdentityLookup(s, s.calls[i]);
    }
    RoomCompletionKeepsNonWaitingOwnership(s, after, caller);
    RoomBatchProgress(after);
  }
}

lemma RoomCompletionRetainsWaiters(before: MultiRoomLeases, after: MultiRoomLeases, caller: int)
  requires alwaysBatchIdentitiesUnique(before) && alwaysBatchIdentitiesUnique(after)
  requires alwaysWaiterMatchesNextRoom(before) && before.queue == after.queue
  requires |before.calls| == |after.calls|
  requires forall i | 0 <= i < |before.calls| ::
    var prior := before.calls[i];
    var next := after.calls[i];
    (prior.id != caller ==> next == prior) &&
    (prior.id == caller ==> (
      next.id == caller && !prior.phase.BatchWaiting? && !next.phase.BatchWaiting?
    ))
  ensures alwaysWaiterMatchesNextRoom(after)
{
  forall w | w in after.queue.waiting
    ensures batchAt(after, w.caller).phase.BatchWaiting? && wantedRoom(batchAt(after, w.caller)) == w.room
  {
    var prior := batchAt(before, w.caller);
    reveal batchAt();
    var byId := (c: BatchLeaseCall) => c.id == w.caller;
    var matches := ProofLib.Filter(byId, before.calls);
    assert prior.phase.BatchWaiting? && |matches| > 0 && prior == matches[0];
    ProofLib.FilterMember(byId, before.calls, prior);
    var i :| 0 <= i < |before.calls| && before.calls[i] == prior;
    var next := after.calls[i];
    assert next == prior && next in after.calls;
    RoomBatchIdentityLookup(after, next);
  }
  forall c | c in after.calls && c.phase.BatchWaiting?
    ensures (exists w :: w in after.queue.waiting && w.caller == c.id && w.room == wantedRoom(c))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert before.calls[i] == c && c in before.calls;
  }
}

lemma RoomCompletionRetainsLeaseOwners(before: MultiRoomLeases, after: MultiRoomLeases, caller: int)
  requires alwaysLeasesBelongToBatch(before) && alwaysDoneHasNoLease(before)
  requires alwaysBatchIdentitiesUnique(before) && alwaysWaiterMatchesNextRoom(before)
  requires before.queue == after.queue && |before.calls| == |after.calls|
  requires forall i | 0 <= i < |before.calls| ::
    var prior := before.calls[i];
    var next := after.calls[i];
    (prior.id != caller ==> next == prior) &&
    (prior.id == caller ==> (
      next.id == caller && next.wanted == prior.wanted && !prior.phase.BatchWaiting? &&
        !next.resultKind.BatchPending? && (next.phase.BatchDone? ==> |heldRooms(before, caller)| == 0)
    ))
  ensures alwaysLeasesBelongToBatch(after) && alwaysDoneHasNoLease(after)
{
  forall lease | lease in after.queue.leases
    ensures (exists c :: c in after.calls && c.id == lease.caller && !c.phase.BatchDone? && lease.room in c.wanted)
  {
    var prior :| prior in before.calls && prior.id == lease.caller && !prior.phase.BatchDone? && lease.room in prior.wanted;
    var i :| 0 <= i < |before.calls| && before.calls[i] == prior;
    var next := after.calls[i];
    assert next in after.calls && next.id == prior.id && next.wanted == prior.wanted;
    if next.phase.BatchDone? {
      assert prior.id == caller && |heldRooms(before, caller)| == 0;
      RoomBatchIncludesHeldRoom(before, lease);
      assert false;
    }
  }
  forall c | c in after.calls && c.phase.BatchDone?
    ensures |heldRooms(after, c.id)| == 0 && !c.resultKind.BatchPending?
    ensures forall w | w in after.queue.waiting :: w.caller != c.id
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    var prior := before.calls[i];
    assert prior in before.calls && prior.id == c.id;
    if prior.id == caller {
      RoomBatchNoWaitOutsideWaiting(before, prior);
    }
  }
}

lemma RoomCompletionRetainsAcquisitionAuthority(before: MultiRoomLeases, after: MultiRoomLeases, caller: int)
  requires alwaysAcquiringQueueAuthority(before) && alwaysStoredResultFollowsPhase(before)
  requires before.queue == after.queue && |before.calls| == |after.calls|
  requires forall i | 0 <= i < |before.calls| ::
    var prior := before.calls[i];
    var next := after.calls[i];
    (prior.id != caller ==> next == prior) &&
    (prior.id == caller ==> (
      next.id == caller && (next.phase.BatchDone? || next.phase.BatchReleasing?) && !next.resultKind.BatchPending?
    ))
  ensures alwaysAcquiringQueueAuthority(after) && alwaysStoredResultFollowsPhase(after)
{
  forall id | id in after.queue.cancelled
    ensures (exists c :: c in after.calls && c.id == id)
  {
    var prior :| prior in before.calls && prior.id == id;
    var i :| 0 <= i < |before.calls| && before.calls[i] == prior;
    assert after.calls[i] in after.calls;
  }
  forall c | c in after.calls
    ensures c.phase.BatchAcquiring? ==> c.id !in after.queue.cancelled
    ensures (c.phase.BatchReleasing? || c.phase.BatchDone?) == !c.resultKind.BatchPending?
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert before.calls[i] in before.calls;
  }
}

lemma RoomCompletionKeepsNonWaitingOwnership(before: MultiRoomLeases, after: MultiRoomLeases, caller: int)
  requires inv(before)
  requires before.queue == after.queue && |before.calls| == |after.calls|
  requires forall i | 0 <= i < |before.calls| ::
    var prior := before.calls[i];
    var next := after.calls[i];
    (prior.id != caller ==> next == prior) &&
    (prior.id == caller ==> (
      next.id == caller && next.wanted == prior.wanted && !prior.phase.BatchWaiting? &&
        (next.phase.BatchDone? || next.phase.BatchReleasing?) && !next.resultKind.BatchPending? &&
        (next.phase.BatchDone? ==> |heldRooms(before, caller)| == 0)
    ))
  ensures alwaysBatchIdentitiesUnique(after) && alwaysLeasesBelongToBatch(after)
  ensures alwaysWaiterMatchesNextRoom(after) && alwaysAcquiringQueueAuthority(after)
  ensures alwaysStoredResultFollowsPhase(after) && alwaysDoneHasNoLease(after)
{
  RoomBatchMapIdentities(before, after);
  RoomCompletionRetainsWaiters(before, after, caller);
  RoomCompletionRetainsLeaseOwners(before, after, caller);
  RoomCompletionRetainsAcquisitionAuthority(before, after, caller);
}

lemma advanceAcquisition_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysNestedReuseExact(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysQueueInvariant(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchIdentitiesUnique(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchesHaveValidPosition(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysStoredResultFollowsPhase(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysQueueConfiguredForCalls(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysLeasesBelongToBatch(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaiterHasOwner(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysHeldPrefixMatchesRequests(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysInvocationHoldsAllRooms(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaiterMatchesNextRoom(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysWaitsAboveHeldRooms(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysDoneHasNoLease(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysAcquiringQueueAuthority(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysReverseReleaseRank(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> alwaysBatchProgressOrTerminal(advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepNestedDoesNotAcquire(s, "advanceAcquisition", advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepClosedAdmissionCannotGrow(s, advanceAcquisition(s, caller)))
  ensures (inv(s) ==> canAdvanceAcquisition(s, caller) ==> stepReleasedAfterWriteSettlement(s, advanceAcquisition(s, caller)))
{
  if inv(s) && canAdvanceAcquisition(s, caller) {
    var after := advanceAcquisition(s, caller);
    RoomAdvanceFrame(s, caller);
    RoomAdvanceQueueFootprint(s, caller);
    RoomBatchMapIdentities(s, after);
    RoomAdvanceKeepsValidBatchPlans(s, caller);
    RoomAdvanceWaiterMatchesBatch(s, caller);
    RoomAdvanceRetainsLeaseOwners(s, caller);
    RoomAdvanceRetainsAuthorityAndTerminalFacts(s, caller);
    reveal acquisitionFailure();
    RoomBatchProgress(after);
  }
}
lemma RoomAdvanceChoosesNewWaiter(s: MultiRoomLeases, caller: int, room: int)
  requires alwaysWaiterHasOwner(s)
  ensures var waiting := core__concurrency_queueRoom(s.queue, caller, room);
    var joined := core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket);
    var occupied := (exists lease :: lease in s.queue.leases && lease.room == room);
    waiting.leases == s.queue.leases && waiting.waiting == s.queue.waiting + [joined] &&
    core__concurrency_canGrantRoom(waiting, room) == !occupied &&
    (!occupied ==> ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, waiting.waiting) == [joined])
{
  reveal core__concurrency_queueRoom(), core__concurrency_canGrantRoom();
  var inRoom := (w: core__concurrency_RoomWaiter) => w.room == room;
  var joined := core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket);
  var waiting := core__concurrency_queueRoom(s.queue, caller, room);
  assert joined in waiting.waiting;
  if !(exists lease :: lease in s.queue.leases && lease.room == room) {
    forall i | 0 <= i < |s.queue.waiting| ensures !inRoom(s.queue.waiting[i]) {
      assert s.queue.waiting[i] in s.queue.waiting;
    }
    ProofLib.FilterNone(inRoom, s.queue.waiting);
    ProofLib.FilterAppend(inRoom, s.queue.waiting, joined);
  }
}

lemma RoomAdvanceFrame(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  ensures var batch := batchAt(s, caller);
    var room := wantedRoom(batch);
    var failure := acquisitionFailure(s, batch);
    var after := advanceAcquisition(s, caller);
    var queued := core__concurrency_queueRoom(s.queue, caller, room);
    var occupied := (exists lease :: lease in s.queue.leases && lease.room == room);
    var granted := failure.BatchPending? && !occupied;
    after.nested == s.nested && after.closeCause == s.closeCause &&
    after.queue == (if failure.BatchPending? then
      (if occupied then queued else core__concurrency_grantRoom(queued, room)) else s.queue) &&
    |after.calls| == |s.calls| &&
    (forall i | 0 <= i < |s.calls| ::
      var prior := s.calls[i];
      var updated := after.calls[i];
      updated.id == prior.id && updated.wanted == prior.wanted &&
      (prior.id != caller ==> updated == prior) &&
      (prior.id == caller && granted ==> (
        updated.position == prior.position + 1 &&
        updated.phase == (if updated.position == |prior.wanted| then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring) &&
        updated.resultKind == prior.resultKind
      )) &&
      (prior.id == caller && !granted ==> (
        updated.position == prior.position &&
        (failure.BatchPending? ==> updated.phase.BatchWaiting? && updated.resultKind == prior.resultKind) &&
        (!failure.BatchPending? ==> updated.phase.BatchReleasing? && updated.resultKind == failure)
      )))
  ensures alwaysQueueInvariant(advanceAcquisition(s, caller))
{
  reveal canAdvanceAcquisition(), advanceAcquisition(), grantAvailable();
  var batch := batchAt(s, caller);
  var room := wantedRoom(batch);
  var failure := acquisitionFailure(s, batch);
  var after := advanceAcquisition(s, caller);
  var queued := core__concurrency_queueRoom(s.queue, caller, room);
  var occupied := (exists lease :: lease in s.queue.leases && lease.room == room);
  if failure.BatchPending? {
    RoomAdvanceChoosesNewWaiter(s, caller, room);
    core__concurrency_queueRoom_ensures(s.queue, caller, room);
    if !occupied {
      core__concurrency_grantRoom_ensures(queued, room);
    }
  }
  forall i | 0 <= i < |s.calls|
    ensures var prior := s.calls[i];
      var updated := after.calls[i];
      var granted := failure.BatchPending? && !occupied;
      updated.id == prior.id && updated.wanted == prior.wanted &&
      (prior.id != caller ==> updated == prior) &&
      (prior.id == caller && granted ==> (
        updated.position == prior.position + 1 &&
        updated.phase == (if updated.position == |prior.wanted| then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring) &&
        updated.resultKind == prior.resultKind
      )) &&
      (prior.id == caller && !granted ==> (
        updated.position == prior.position &&
        (failure.BatchPending? ==> updated.phase.BatchWaiting? && updated.resultKind == prior.resultKind) &&
        (!failure.BatchPending? ==> updated.phase.BatchReleasing? && updated.resultKind == failure)
      ))
  {
    if s.calls[i].id == caller {
      assert s.calls[i] in s.calls;
      RoomBatchIdentityLookup(s, s.calls[i]);
    }
  }
}

lemma RoomQueueGrantServesOnlyNewWaiter(s: MultiRoomLeases, caller: int, room: int)
  requires alwaysWaiterHasOwner(s) && core__concurrency_alwaysWaitersUnique(s.queue)
  requires !(exists lease :: lease in s.queue.leases && lease.room == room)
  ensures var joined := core__concurrency_queueRoom(s.queue, caller, room);
    var granted := core__concurrency_grantRoom(joined, room);
    granted.waiting == s.queue.waiting &&
    granted.leases == s.queue.leases + [core__concurrency_Lease(caller, room, true, 0)]
{
  RoomAdvanceChoosesNewWaiter(s, caller, room);
  reveal core__concurrency_grantRoom();
  var joined := core__concurrency_queueRoom(s.queue, caller, room);
  var retained := (w: core__concurrency_RoomWaiter) => w.ticket != s.queue.nextTicket;
  var all := (w: core__concurrency_RoomWaiter) => true;
  forall i | 0 <= i < |s.queue.waiting|
    ensures retained(s.queue.waiting[i]) == all(s.queue.waiting[i])
  {
    assert s.queue.waiting[i] in s.queue.waiting;
  }
  ProofLib.FilterSamePredicate(retained, all, s.queue.waiting);
  RoomFilterAllWaiters(s.queue.waiting);
  ProofLib.FilterAppend(retained, s.queue.waiting, core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket));
}

lemma RoomFilterAllWaiters(waiters: seq<core__concurrency_RoomWaiter>)
  ensures ProofLib.Filter((w: core__concurrency_RoomWaiter) => true, waiters) == waiters
  decreases |waiters|
{
  if |waiters| == 0 {
    ProofLib.FilterNil((w: core__concurrency_RoomWaiter) => true, waiters);
  } else {
    ProofLib.FilterCons((w: core__concurrency_RoomWaiter) => true, waiters);
    RoomFilterAllWaiters(waiters[1..]);
    assert waiters == [waiters[0]] + waiters[1..];
  }
}

lemma RoomAdvanceQueueFootprint(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  ensures var batch := batchAt(s, caller);
    var room := wantedRoom(batch);
    var after := advanceAcquisition(s, caller);
    var pending := acquisitionFailure(s, batch).BatchPending?;
    var occupied := (exists owner :: owner in s.queue.leases && owner.room == room);
    after.queue.leases == (if pending && !occupied then
      s.queue.leases + [core__concurrency_Lease(caller, room, true, 0)] else s.queue.leases) &&
    after.queue.waiting == (if pending && occupied then
      s.queue.waiting + [core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket)] else s.queue.waiting) &&
    after.queue.cancelled == s.queue.cancelled &&
    after.queue.sealedCallers == s.queue.sealedCallers &&
    after.queue.finishedCallers == s.queue.finishedCallers &&
    after.queue.configured == s.queue.configured
{
  RoomAdvanceFrame(s, caller);
  reveal core__concurrency_queueRoom(), core__concurrency_grantRoom();
  var batch := batchAt(s, caller);
  var room := wantedRoom(batch);
  if acquisitionFailure(s, batch).BatchPending? && !(exists owner :: owner in s.queue.leases && owner.room == room) {
    RoomQueueGrantServesOnlyNewWaiter(s, caller, room);
  }
}

lemma RoomBatchHeldAfterLeaseAppend(before: MultiRoomLeases, after: MultiRoomLeases,
                                   added: core__concurrency_Lease, caller: int)
  requires after.queue.leases == before.queue.leases + [added]
  ensures heldRooms(after, caller) == (
    if added.caller == caller then heldRooms(before, caller) + [added.room] else heldRooms(before, caller)
  )
{
  var belongs := (lease: core__concurrency_Lease) => lease.caller == caller;
  var prior := ProofLib.Filter(belongs, before.queue.leases);
  var current := ProofLib.Filter(belongs, after.queue.leases);
  ProofLib.FilterAppend(belongs, before.queue.leases, added);
  RoomBatchHeldProjection(before, caller);
  RoomBatchHeldProjection(after, caller);
  if added.caller == caller {
    var held := heldRooms(before, caller);
    var next := heldRooms(after, caller);
    assert |next| == |held| + 1 && next[|held|] == added.room;
    forall i | 0 <= i < |held| ensures next[i] == held[i] {
      assert prior[i] == current[i];
    }
    assert next[..|held|] == held;
    assert next == next[..|held|] + [next[|held|]];
  }
}

lemma RoomSortedSequenceHasDistinctRanks(rooms: seq<int>)
  requires forall i, j | 0 <= i < j < |rooms| :: rooms[i] < rooms[j]
  ensures |set room | room in rooms| == |rooms|
  decreases |rooms|
{
  if |rooms| > 0 {
    var first := rooms[0];
    var rest := rooms[1..];
    assert rooms == [first] + rest;
    RoomSortedSequenceHasDistinctRanks(rest);
    if first in rest {
      var i :| 0 <= i < |rest| && rest[i] == first;
      assert rooms[i + 1] > first && rooms[i + 1] == first;
    }
    assert (set room | room in rooms) == (set room | room in rest) + {first};
  }
}

lemma RoomSameRanksHaveTheSameSortedSequence(left: seq<int>, right: seq<int>)
  requires |left| == |right|
  requires forall i, j | 0 <= i < j < |left| :: left[i] < left[j]
  requires forall i, j | 0 <= i < j < |right| :: right[i] < right[j]
  requires forall room :: room in left <==> room in right
  ensures left == right
  decreases |left|
{
  if |left| > 0 {
    var l := left[0];
    var r := right[0];
    assert l in right && r in left;
    var i :| 0 <= i < |right| && right[i] == l;
    var j :| 0 <= j < |left| && left[j] == r;
    if i > 0 {
      assert r < l;
      if j > 0 { assert l < r; }
      assert false;
    }
    assert l == r;
    var leftTail := left[1..];
    var rightTail := right[1..];
    assert left == [l] + leftTail && right == [r] + rightTail;
    forall room: int ensures room in leftTail <==> room in rightTail {
      if room == l {
        if room in leftTail {
          var k :| 0 <= k < |leftTail| && leftTail[k] == room;
          assert left[k + 1] > l;
        }
        if room in rightTail {
          var k :| 0 <= k < |rightTail| && rightTail[k] == room;
          assert right[k + 1] > r;
        }
      } else {
        assert room in left <==> room in right;
      }
    }
    RoomSameRanksHaveTheSameSortedSequence(leftTail, rightTail);
  }
}

lemma RoomRankSubsetOfSameSizeIsEqual(acquired: set<int>, planned: set<int>)
  requires acquired <= planned && |acquired| == |planned|
  ensures acquired == planned
  decreases |acquired|
{
  if |acquired| > 0 {
    var room :| room in acquired;
    assert room in planned;
    var acquiredRest := acquired - {room};
    var plannedRest := planned - {room};
    assert acquired == acquiredRest + {room} && planned == plannedRest + {room};
    assert |acquiredRest| == |acquired| - 1 && |plannedRest| == |planned| - 1;
    RoomRankSubsetOfSameSizeIsEqual(acquiredRest, plannedRest);
  } else {
    assert acquired == {} && planned == {};
  }
}

lemma RoomHeldRoomsAreTheExactPlanPrefix(s: MultiRoomLeases, call: BatchLeaseCall)
  requires inv(s) && call in s.calls
  requires call.phase.BatchAcquiring? || call.phase.BatchWaiting?
  ensures 0 <= call.position < |call.wanted|
  ensures heldRooms(s, call.id) == call.wanted[..call.position]
{
  var held := heldRooms(s, call.id);
  var wanted := call.wanted;
  var position := call.position;
  var prefix := wanted[..position];
  assert |held| == |prefix| == position;
  reveal roomRanksAscending(), wantedRoom();
  RoomBatchAscendingFold(held, emptyHeldRoomOrder);
  RoomBatchAscendingFold(wanted, emptyHeldRoomOrder);
  forall room | room in held ensures room in prefix {
    assert room in wanted && room < wanted[position];
    var i :| 0 <= i < |wanted| && wanted[i] == room;
    if i >= position {
      if i > position { assert wanted[position] < wanted[i]; }
      assert false;
    }
    assert prefix[i] == wanted[i] && prefix[i] in prefix;
  }
  RoomSortedSequenceHasDistinctRanks(held);
  RoomSortedSequenceHasDistinctRanks(prefix);
  var acquiredRanks := set room | room in held;
  var prefixRanks := set room | room in prefix;
  assert acquiredRanks <= prefixRanks && |acquiredRanks| == |prefixRanks|;
  RoomRankSubsetOfSameSizeIsEqual(acquiredRanks, prefixRanks);
  forall room: int ensures room in held <==> room in prefix {
    assert room in acquiredRanks <==> room in held;
    assert room in prefixRanks <==> room in prefix;
  }
  RoomSameRanksHaveTheSameSortedSequence(held, prefix);
}

lemma RoomPlanRanksHoldForEveryPrefix(plan: seq<int>, position: int)
  requires roomRanksAscending(plan) && 0 <= position <= |plan|
  ensures roomRanksAscending(plan[..position])
  ensures position < |plan| ==> 0 < plan[position] && (forall room | room in plan[..position] :: room < plan[position])
{
  reveal roomRanksAscending();
  RoomBatchAscendingFold(plan, emptyHeldRoomOrder);
  RoomBatchAscendingFromRanks(plan[..position]);
  if position < |plan| {
    assert 0 < plan[position];
    forall room | room in plan[..position] ensures room < plan[position] {
      var i :| 0 <= i < position && plan[..position][i] == room;
      assert plan[i] == room;
    }
  }
}

lemma RoomAdvanceGrantShape(s: MultiRoomLeases, caller: int, i: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  requires 0 <= i < |s.calls| && s.calls[i].id == caller
  requires acquisitionFailure(s, batchAt(s, caller)).BatchPending?
  requires !(exists lease :: lease in s.queue.leases && lease.room == wantedRoom(batchAt(s, caller)))
  ensures var before := s.calls[i];
    var after := advanceAcquisition(s, caller);
    batchAt(s, caller) == before && before.phase.BatchAcquiring? &&
    0 <= before.position < |before.wanted| && roomRanksAscending(before.wanted) &&
    heldRooms(s, caller) == before.wanted[..before.position] &&
    i < |after.calls| && after.calls[i].wanted == before.wanted &&
    after.calls[i].position == before.position + 1 &&
    after.calls[i].phase == (if before.position + 1 == |before.wanted| then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring) &&
    after.queue.leases == s.queue.leases + [core__concurrency_Lease(caller, wantedRoom(before), true, 0)]
{
  RoomAdvanceFrame(s, caller);
  RoomAdvanceQueueFootprint(s, caller);
  var before := s.calls[i];
  RoomBatchIdentityLookup(s, before);
  reveal canAdvanceAcquisition();
  RoomHeldRoomsAreTheExactPlanPrefix(s, before);
}

lemma RoomPlanPrefixGrowsByNextRoom(plan: seq<int>, position: int, held: seq<int>)
  requires roomRanksAscending(plan) && 0 <= position < |plan|
  requires held == plan[..position] + [plan[position]]
  ensures held == plan[..position + 1]
  ensures roomRanksAscending(held)
  ensures position + 1 < |plan| ==> 0 < plan[position + 1] && (forall room | room in held :: room < plan[position + 1])
{
  RoomPlanRanksHoldForEveryPrefix(plan, position + 1);
}

lemma RoomAdvanceAfterGrantFollowsPlan(s: MultiRoomLeases, caller: int, i: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  requires 0 <= i < |s.calls| && s.calls[i].id == caller
  requires acquisitionFailure(s, batchAt(s, caller)).BatchPending?
  requires !(exists lease :: lease in s.queue.leases && lease.room == wantedRoom(batchAt(s, caller)))
  ensures var after := advanceAcquisition(s, caller);
    var call := after.calls[i];
    var held := heldRooms(after, caller);
    0 <= call.position <= |call.wanted| && held == call.wanted[..call.position] &&
    roomRanksAscending(held) &&
    (call.phase.BatchAcquiring? ==> (
      call.position < |call.wanted| && wantedRoom(call) > 0 &&
      (forall room | room in held :: room < wantedRoom(call))
    )) &&
    (call.phase.BatchInvoking? ==> call.position == |call.wanted| && held == call.wanted)
{
  RoomAdvanceGrantShape(s, caller, i);
  var before := s.calls[i];
  var after := advanceAcquisition(s, caller);
  var plan := before.wanted;
  var position := before.position;
  var lease := core__concurrency_Lease(caller, wantedRoom(before), true, 0);
  RoomBatchHeldAfterLeaseAppend(s, after, lease, caller);
  var held := heldRooms(after, caller);
  RoomPlanPrefixGrowsByNextRoom(plan, position, held);
}

lemma RoomAdvanceKeepsHeldRoomsWithoutMatchingGrant(s: MultiRoomLeases, caller: int, other: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  requires other != caller || !acquisitionFailure(s, batchAt(s, caller)).BatchPending? ||
    (exists lease :: lease in s.queue.leases && lease.room == wantedRoom(batchAt(s, caller)))
  ensures heldRooms(advanceAcquisition(s, caller), other) == heldRooms(s, other)
{
  RoomAdvanceQueueFootprint(s, caller);
  var after := advanceAcquisition(s, caller);
  if after.queue.leases != s.queue.leases {
    assert other != caller;
    RoomBatchHeldAfterLeaseAppend(s, after,
      core__concurrency_Lease(caller, wantedRoom(batchAt(s, caller)), true, 0), other);
  } else {
    RoomBatchHeldProjection(s, other);
    RoomBatchHeldProjection(after, other);
  }
}

lemma RoomAdvanceKeepsValidBatchPlans(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  ensures alwaysBatchesHaveValidPosition(advanceAcquisition(s, caller))
  ensures alwaysStoredResultFollowsPhase(advanceAcquisition(s, caller))
  ensures alwaysHeldPrefixMatchesRequests(advanceAcquisition(s, caller))
  ensures alwaysInvocationHoldsAllRooms(advanceAcquisition(s, caller))
  ensures alwaysWaitsAboveHeldRooms(advanceAcquisition(s, caller))
  ensures alwaysReverseReleaseRank(advanceAcquisition(s, caller))
{
  RoomAdvanceFrame(s, caller);
  var after := advanceAcquisition(s, caller);
  var batch := batchAt(s, caller);
  var room := wantedRoom(batch);
  var pending := acquisitionFailure(s, batch).BatchPending?;
  var occupied := (exists lease :: lease in s.queue.leases && lease.room == room);
  forall call | call in after.calls
    ensures 0 <= call.position <= |call.wanted|
    ensures (call.phase.BatchAcquiring? || call.phase.BatchWaiting?) ==> call.position < |call.wanted|
    ensures (call.phase.BatchReleasing? || call.phase.BatchDone?) == !call.resultKind.BatchPending?
    ensures (call.phase.BatchAcquiring? || call.phase.BatchWaiting?) ==> (
      |heldRooms(after, call.id)| == call.position &&
      (forall held | held in heldRooms(after, call.id) :: held in call.wanted)
    )
    ensures call.phase.BatchInvoking? ==> heldRooms(after, call.id) == call.wanted && call.position == |call.wanted|
    ensures roomRanksAscending(call.wanted) && roomRanksAscending(heldRooms(after, call.id))
    ensures (call.phase.BatchAcquiring? || call.phase.BatchWaiting?) ==> (
      wantedRoom(call) > 0 && (forall held | held in heldRooms(after, call.id) :: held < wantedRoom(call))
    )
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls && prior.id == call.id && prior.wanted == call.wanted;
    if prior.id == caller {
      RoomBatchIdentityLookup(s, prior);
      reveal canAdvanceAcquisition();
      assert prior.phase.BatchAcquiring? && prior.resultKind.BatchPending?;
    }
    if prior.id == caller && pending && !occupied {
      RoomAdvanceAfterGrantFollowsPlan(s, caller, i);
    } else {
      RoomAdvanceKeepsHeldRoomsWithoutMatchingGrant(s, caller, prior.id);
      assert call.position == prior.position && wantedRoom(call) == wantedRoom(prior);
    }
  }
}

lemma RoomBatchLookupRetainsNonterminalIdentity(s: MultiRoomLeases, caller: int)
  requires !batchAt(s, caller).phase.BatchDone?
  ensures batchAt(s, caller) in s.calls && batchAt(s, caller).id == caller
{
  reveal batchAt();
  var byId := (c: BatchLeaseCall) => c.id == caller;
  var matches := ProofLib.Filter(byId, s.calls);
  var call := batchAt(s, caller);
  assert noLeaseCall.phase.BatchDone? && |matches| > 0 && call == matches[0];
  ProofLib.FilterMember(byId, s.calls, call);
}

lemma RoomAdvanceWaiterMatchesBatch(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  requires alwaysBatchIdentitiesUnique(advanceAcquisition(s, caller))
  ensures alwaysWaiterMatchesNextRoom(advanceAcquisition(s, caller))
{
  RoomAdvanceFrame(s, caller);
  RoomAdvanceQueueFootprint(s, caller);
  reveal canAdvanceAcquisition();
  var after := advanceAcquisition(s, caller);
  var selected := batchAt(s, caller);
  var room := wantedRoom(selected);
  var added := core__concurrency_RoomWaiter(caller, room, s.queue.nextTicket);
  RoomBatchLookupRetainsNonterminalIdentity(s, caller);
  assert selected.phase.BatchAcquiring?;
  forall w | w in after.queue.waiting
    ensures batchAt(after, w.caller).phase.BatchWaiting? && wantedRoom(batchAt(after, w.caller)) == w.room
  {
    if w in s.queue.waiting {
      var prior := batchAt(s, w.caller);
      assert prior.phase.BatchWaiting? && w.caller != caller;
      RoomBatchLookupRetainsNonterminalIdentity(s, w.caller);
      var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
      assert after.calls[i] == prior && prior in after.calls;
      RoomBatchIdentityLookup(after, prior);
    } else {
      assert w == added && |after.queue.waiting| > |s.queue.waiting|;
      var i :| 0 <= i < |s.calls| && s.calls[i] == selected;
      var next := after.calls[i];
      assert next in after.calls && next.phase.BatchWaiting? && next.position == selected.position;
      assert wantedRoom(next) == room;
      RoomBatchIdentityLookup(after, next);
    }
  }
  forall call | call in after.calls && call.phase.BatchWaiting?
    ensures (exists w :: w in after.queue.waiting && w.caller == call.id && w.room == wantedRoom(call))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == call;
    var prior := s.calls[i];
    assert prior in s.calls;
    if call.id == caller {
      RoomBatchIdentityLookup(s, prior);
      assert wantedRoom(call) == room && added in after.queue.waiting;
    } else {
      assert call == prior;
      var w :| w in s.queue.waiting && w.caller == call.id && w.room == wantedRoom(call);
      assert w in after.queue.waiting;
    }
  }
}

lemma RoomAdvanceRetainsLeaseOwners(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  ensures alwaysLeasesBelongToBatch(advanceAcquisition(s, caller))
  ensures alwaysWaiterHasOwner(advanceAcquisition(s, caller))
{
  RoomAdvanceFrame(s, caller);
  RoomAdvanceQueueFootprint(s, caller);
  reveal canAdvanceAcquisition(), wantedRoom();
  var after := advanceAcquisition(s, caller);
  var selected := batchAt(s, caller);
  var room := wantedRoom(selected);
  RoomBatchLookupRetainsNonterminalIdentity(s, caller);
  assert selected.phase.BatchAcquiring? && 0 <= selected.position < |selected.wanted| && room in selected.wanted;
  forall lease | lease in after.queue.leases
    ensures (exists c :: c in after.calls && c.id == lease.caller && !c.phase.BatchDone? && lease.room in c.wanted)
  {
    if lease in s.queue.leases {
      var prior :| prior in s.calls && prior.id == lease.caller && !prior.phase.BatchDone? && lease.room in prior.wanted;
      var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
      assert after.calls[i] in after.calls && !after.calls[i].phase.BatchDone?;
    } else {
      assert lease == core__concurrency_Lease(caller, room, true, 0);
      var i :| 0 <= i < |s.calls| && s.calls[i] == selected;
      assert after.calls[i] in after.calls && !after.calls[i].phase.BatchDone?;
    }
  }
  forall w | w in after.queue.waiting
    ensures (exists owner :: owner in after.queue.leases && owner.room == w.room)
  {
    if w in s.queue.waiting {
      var owner :| owner in s.queue.leases && owner.room == w.room;
      assert owner in after.queue.leases;
    } else {
      assert w.room == room && |after.queue.waiting| > |s.queue.waiting|;
      var owner :| owner in s.queue.leases && owner.room == room;
      assert owner in after.queue.leases;
    }
  }
}

lemma RoomAdvanceRetainsAuthorityAndTerminalFacts(s: MultiRoomLeases, caller: int)
  requires inv(s) && canAdvanceAcquisition(s, caller)
  ensures alwaysAcquiringQueueAuthority(advanceAcquisition(s, caller))
  ensures alwaysDoneHasNoLease(advanceAcquisition(s, caller))
{
  RoomAdvanceFrame(s, caller);
  RoomAdvanceQueueFootprint(s, caller);
  reveal canAdvanceAcquisition();
  var after := advanceAcquisition(s, caller);
  forall id | id in after.queue.cancelled
    ensures (exists c :: c in after.calls && c.id == id)
  {
    var prior :| prior in s.calls && prior.id == id;
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    assert after.calls[i] in after.calls;
  }
  forall c | c in after.calls && c.phase.BatchAcquiring?
    ensures c.id !in after.queue.cancelled
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    var prior := s.calls[i];
    assert prior in s.calls;
    if prior.id == caller {
      RoomBatchIdentityLookup(s, prior);
    }
    assert prior.phase.BatchAcquiring?;
  }
  forall c | c in after.calls && c.phase.BatchDone?
    ensures |heldRooms(after, c.id)| == 0 && !c.resultKind.BatchPending?
    ensures forall waiter | waiter in after.queue.waiting :: waiter.caller != c.id
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    assert s.calls[i] == c && c in s.calls && c.id != caller;
    RoomAdvanceKeepsHeldRoomsWithoutMatchingGrant(s, caller, c.id);
  }
}

lemma releaseBatchRoom_ensures(s: MultiRoomLeases, caller: int)
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysNestedReuseExact(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysQueueInvariant(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchIdentitiesUnique(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchesHaveValidPosition(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysStoredResultFollowsPhase(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysQueueConfiguredForCalls(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysLeasesBelongToBatch(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaiterHasOwner(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysHeldPrefixMatchesRequests(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysInvocationHoldsAllRooms(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaiterMatchesNextRoom(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysWaitsAboveHeldRooms(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysDoneHasNoLease(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysAcquiringQueueAuthority(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysReverseReleaseRank(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> alwaysBatchProgressOrTerminal(releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepNestedDoesNotAcquire(s, "releaseBatchRoom", releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepClosedAdmissionCannotGrow(s, releaseBatchRoom(s, caller)))
  ensures (inv(s) ==> canReleaseBatchRoom(s, caller) ==> stepReleasedAfterWriteSettlement(s, releaseBatchRoom(s, caller)))
{
  if inv(s) && canReleaseBatchRoom(s, caller) {
    var after := releaseBatchRoom(s, caller);
    RoomReleaseFrame(s, caller);
    RoomReleaseQueueFootprint(s, caller);
    RoomBatchMapIdentities(s, after);
    RoomReleaseKeepsBatchPlans(s, caller);
    RoomReleaseKeepsWaitersWithTheirBatches(s, caller);
    RoomReleaseKeepsLeaseOwners(s, caller);
    RoomReleaseKeepsQueuedRoomOwners(s, caller);
    RoomReleaseRetainsQueueAuthority(s, caller);
    RoomReleaseKeepsTerminalBatchesEmpty(s, caller);
    RoomReleaseKeepsAdmittedWriteSettlement(s, caller);
    RoomBatchProgress(after);
  }
}

lemma RoomReleaseOnlyItsSettledLease(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    (exists lease :: lease in s.queue.leases && lease.caller == caller && lease.room == room &&
      !lease.acceptingWrites && lease.writes == 0) &&
    (forall lease | lease in s.queue.leases && lease.room == room ::
      lease.caller == caller && !lease.acceptingWrites && lease.writes == 0) &&
    (forall lease | lease in core__concurrency_releaseRoom(s.queue, caller, room).leases :: lease.room != room)
{
  reveal canReleaseBatchRoom(), core__concurrency_canReleaseRoom();
  var room := releaseRoomId(s, caller);
  var removed :| removed in s.queue.leases && removed.caller == caller && removed.room == room &&
    !removed.acceptingWrites && removed.writes == 0;
  var inRoom := (lease: core__concurrency_Lease) => lease.room == room;
  var matches := ProofLib.Filter(inRoom, s.queue.leases);
  ProofLib.FilterMember(inRoom, s.queue.leases, removed);
  assert |matches| == 1 && matches[0] == removed;
  forall lease | lease in s.queue.leases && lease.room == room
    ensures lease == removed
  {
    ProofLib.FilterMember(inRoom, s.queue.leases, lease);
    assert lease in matches;
  }
  reveal core__concurrency_releaseRoom();
  var retained := (lease: core__concurrency_Lease) => lease.caller != caller || lease.room != room;
  forall lease | lease in core__concurrency_releaseRoom(s.queue, caller, room).leases
    ensures lease.room != room
  {
    ProofLib.FilterMember(retained, s.queue.leases, lease);
  }
}

lemma RoomReleaseFrame(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
    var after := releaseBatchRoom(s, caller);
    var released := core__concurrency_releaseRoom(s.queue, caller, room);
    after.queue == (if |waiters| > 0 then core__concurrency_grantRoom(released, room) else released) &&
    after.nested == s.nested && after.closeCause == s.closeCause &&
    |after.calls| == |s.calls| &&
    (forall i | 0 <= i < |s.calls| ::
      var before := s.calls[i];
      var next := after.calls[i];
      next.id == before.id && next.wanted == before.wanted &&
      (|waiters| == 0 || before.id != waiters[0].caller ==> next == before) &&
      (|waiters| > 0 && before.id == waiters[0].caller ==> (
        next.position == before.position + 1 && next.resultKind == before.resultKind &&
        next.phase == (if next.position == |next.wanted| then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring)
      ))) &&
    (|waiters| > 0 ==> waiters[0] in s.queue.waiting && waiters[0].caller != caller)
  ensures alwaysQueueInvariant(releaseBatchRoom(s, caller))
{
  RoomReleaseOnlyItsSettledLease(s, caller);
  reveal canReleaseBatchRoom(), releaseBatchRoom(), grantAvailable();
  reveal core__concurrency_releaseRoom(), core__concurrency_canGrantRoom();
  var room := releaseRoomId(s, caller);
  var inRoom := (w: core__concurrency_RoomWaiter) => w.room == room;
  var waiters := ProofLib.Filter(inRoom, s.queue.waiting);
  var released := core__concurrency_releaseRoom(s.queue, caller, room);
  var after := releaseBatchRoom(s, caller);
  RoomBatchQueueState(s);
  core__concurrency_releaseRoom_ensures(s.queue, caller, room);
  if |waiters| > 0 {
    ProofLib.FilterMember(inRoom, s.queue.waiting, waiters[0]);
    assert waiters[0] in released.waiting && waiters[0].room == room;
    assert batchAt(s, waiters[0].caller).phase.BatchWaiting? && batchAt(s, caller).phase.BatchReleasing?;
    core__concurrency_grantRoom_ensures(released, room);
  } else {
    forall w | w in released.waiting ensures w.room != room {
      ProofLib.FilterMember(inRoom, s.queue.waiting, w);
    }
  }
}

lemma RoomReleaseQueueFootprint(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    var after := releaseBatchRoom(s, caller);
    var released := core__concurrency_releaseRoom(s.queue, caller, room);
    var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
    released.leases == ProofLib.Filter((lease: core__concurrency_Lease) => lease.caller != caller || lease.room != room, s.queue.leases) &&
    after.queue.leases == (if |waiters| > 0 then released.leases + [core__concurrency_Lease(waiters[0].caller, room, true, 0)] else released.leases) &&
    after.queue.waiting == (if |waiters| > 0 then
      ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.ticket != waiters[0].ticket, s.queue.waiting) else s.queue.waiting) &&
    after.queue.configured == s.queue.configured && after.queue.closed == s.queue.closed &&
    after.queue.cancelled == s.queue.cancelled && after.queue.sealedCallers == s.queue.sealedCallers &&
    after.queue.finishedCallers == s.queue.finishedCallers
{
  RoomReleaseFrame(s, caller);
  reveal core__concurrency_releaseRoom(), core__concurrency_grantRoom();
}

lemma RoomFiltersCommute<T>(items: seq<T>, keep: T -> bool, belongs: T -> bool)
  ensures ProofLib.Filter(belongs, ProofLib.Filter(keep, items)) ==
    ProofLib.Filter(keep, ProofLib.Filter(belongs, items))
  decreases |items|
{
  if |items| == 0 {
    ProofLib.FilterNil(keep, items);
    ProofLib.FilterNil(belongs, items);
  } else {
    var first := items[0];
    var rest := items[1..];
    var kept := ProofLib.Filter(keep, rest);
    var owned := ProofLib.Filter(belongs, rest);
    ProofLib.FilterCons(keep, items);
    ProofLib.FilterCons(belongs, items);
    RoomFiltersCommute(rest, keep, belongs);
    var fromKept := ProofLib.Filter(keep, items);
    var fromOwned := ProofLib.Filter(belongs, items);
    if keep(first) {
      assert fromKept == [first] + kept && fromKept[0] == first && fromKept[1..] == kept;
      ProofLib.FilterCons(belongs, fromKept);
      assert ProofLib.Filter(belongs, fromKept) ==
        (if belongs(first) then [first] else []) + ProofLib.Filter(belongs, kept);
    } else {
      assert fromKept == kept;
    }
    if belongs(first) {
      assert fromOwned == [first] + owned && fromOwned[0] == first && fromOwned[1..] == owned;
      ProofLib.FilterCons(keep, fromOwned);
      assert ProofLib.Filter(keep, fromOwned) ==
        (if keep(first) then [first] else []) + ProofLib.Filter(keep, owned);
    } else {
      assert fromOwned == owned;
    }
    assert (if keep(first) && belongs(first) then [first] else []) ==
      (if belongs(first) && keep(first) then [first] else []);
  }
}

lemma RoomFilterRetainedRanks(leases: seq<core__concurrency_Lease>, removed: int)
  ensures var ranks := seq(|leases|, i requires 0 <= i < |leases| => leases[i].room);
    var retained := ProofLib.Filter((l: core__concurrency_Lease) => l.room != removed, leases);
    ProofLib.Filter((r: int) => r != removed, ranks) ==
      seq(|retained|, i requires 0 <= i < |retained| => retained[i].room)
  decreases |leases|
{
  var ranks := seq(|leases|, i requires 0 <= i < |leases| => leases[i].room);
  var keepLease := (lease: core__concurrency_Lease) => lease.room != removed;
  var keepRank := (rank: int) => rank != removed;
  if |leases| == 0 {
    ProofLib.FilterNil(keepLease, leases);
    ProofLib.FilterNil(keepRank, ranks);
  } else {
    var first := leases[0];
    var tail := leases[1..];
    var tailRanks := seq(|tail|, i requires 0 <= i < |tail| => tail[i].room);
    assert ranks[..1] == [first.room];
    forall i | 0 <= i < |tail| ensures ranks[i + 1] == tailRanks[i] {}
    assert ranks[1..] == tailRanks;
    ProofLib.FilterCons(keepLease, leases);
    ProofLib.FilterCons(keepRank, ranks);
    RoomFilterRetainedRanks(tail, removed);
    if keepLease(first) {
      var tailRetained := ProofLib.Filter(keepLease, tail);
      var retained := ProofLib.Filter(keepLease, leases);
      assert retained == [first] + tailRetained;
      var after := seq(|retained|, i requires 0 <= i < |retained| => retained[i].room);
      var suffix := seq(|tailRetained|, i requires 0 <= i < |tailRetained| => tailRetained[i].room);
      forall i | 0 <= i < |suffix| ensures after[i + 1] == suffix[i] {}
      assert after[..1] == [first.room] && after[1..] == suffix;
      assert after == [first.room] + suffix;
    }
  }
}

lemma RoomRetainAllOwnedLeases(leases: seq<core__concurrency_Lease>, caller: int, retired: int, room: int)
  requires caller != retired
  requires forall lease | lease in leases :: lease.caller == caller
  ensures ProofLib.Filter((lease: core__concurrency_Lease) => lease.caller != retired || lease.room != room, leases) == leases
  decreases |leases|
{
  var keep := (lease: core__concurrency_Lease) => lease.caller != retired || lease.room != room;
  if |leases| == 0 {
    ProofLib.FilterNil(keep, leases);
  } else {
    var first := leases[0];
    var rest := leases[1..];
    assert first in leases && keep(first);
    assert leases == [first] + rest;
    ProofLib.FilterCons(keep, leases);
    RoomRetainAllOwnedLeases(rest, caller, retired, room);
  }
}

lemma RoomHeldAfterLeaseRetirement(before: MultiRoomLeases, after: MultiRoomLeases,
                                 releasedCaller: int, room: int, other: int)
  requires after.queue.leases ==
    ProofLib.Filter((lease: core__concurrency_Lease) => lease.caller != releasedCaller || lease.room != room, before.queue.leases)
  ensures heldRooms(after, other) == (
    if other == releasedCaller then ProofLib.Filter((rank: int) => rank != room, heldRooms(before, other))
    else heldRooms(before, other)
  )
{
  var owns := (lease: core__concurrency_Lease) => lease.caller == other;
  var keep := (lease: core__concurrency_Lease) => lease.caller != releasedCaller || lease.room != room;
  var matching := ProofLib.Filter(owns, before.queue.leases);
  var retained := ProofLib.Filter(owns, after.queue.leases);
  RoomBatchHeldProjection(before, other);
  RoomBatchHeldProjection(after, other);
  RoomFiltersCommute(before.queue.leases, keep, owns);
  forall lease | lease in matching ensures lease.caller == other {
    ProofLib.FilterMember(owns, before.queue.leases, lease);
  }
  if other == releasedCaller {
    var keepRoom := (lease: core__concurrency_Lease) => lease.room != room;
    forall i | 0 <= i < |matching| ensures keep(matching[i]) == keepRoom(matching[i]) {
      assert matching[i] in matching;
    }
    ProofLib.FilterSamePredicate(keep, keepRoom, matching);
    RoomFilterRetainedRanks(matching, room);
  } else {
    RoomRetainAllOwnedLeases(matching, other, releasedCaller, room);
    assert matching == retained;
  }
}

lemma RoomRetiredRankPreservesOrder(plan: seq<int>, retired: int)
  requires roomRanksAscending(plan)
  ensures roomRanksAscending(ProofLib.Filter((rank: int) => rank != retired, plan))
{
  reveal roomRanksAscending();
  var keep := (rank: int) => rank != retired;
  var retained := ProofLib.Filter(keep, plan);
  RoomBatchAscendingFold(plan, emptyHeldRoomOrder);
  FilterKeepsRoomRanks(keep, plan);
  forall i | 0 <= i < |retained| ensures retained[i] > 0 {
    ProofLib.FilterMember(keep, plan, retained[i]);
    var j :| 0 <= j < |plan| && plan[j] == retained[i];
  }
  RoomBatchAscendingFromRanks(retained);
}

lemma RoomReleaseChangesOnlyTheTwoLeaseOwners(s: MultiRoomLeases, caller: int, other: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    var waiting := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
    var result := heldRooms(releaseBatchRoom(s, caller), other);
    (other == caller ==> result == ProofLib.Filter((rank: int) => rank != room, heldRooms(s, caller))) &&
    (other != caller ==> (
      result == (if |waiting| > 0 && waiting[0].caller == other
        then heldRooms(s, other) + [room] else heldRooms(s, other))
    ))
{
  RoomReleaseFrame(s, caller);
  RoomReleaseQueueFootprint(s, caller);
  var room := releaseRoomId(s, caller);
  var waiting := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
  var removed := s.(queue := core__concurrency_releaseRoom(s.queue, caller, room));
  var after := releaseBatchRoom(s, caller);
  RoomHeldAfterLeaseRetirement(s, removed, caller, room, other);
  if |waiting| > 0 {
    RoomBatchHeldAfterLeaseAppend(removed, after, core__concurrency_Lease(waiting[0].caller, room, true, 0), other);
  } else {
    RoomBatchHeldProjection(removed, other);
    RoomBatchHeldProjection(after, other);
  }
}

lemma RoomAddedLeaseAdvancesExactPlan(before: MultiRoomLeases, after: MultiRoomLeases,
                                    prior: BatchLeaseCall, next: BatchLeaseCall)
  requires inv(before) && prior in before.calls
  requires prior.phase.BatchAcquiring? || prior.phase.BatchWaiting?
  requires next.id == prior.id && next.wanted == prior.wanted && next.position == prior.position + 1
  requires next.phase == (if next.position == |next.wanted| then BatchLeasePhase.BatchInvoking else BatchLeasePhase.BatchAcquiring)
  requires heldRooms(after, next.id) == heldRooms(before, prior.id) + [wantedRoom(prior)]
  ensures 0 <= next.position <= |next.wanted|
  ensures heldRooms(after, next.id) == next.wanted[..next.position]
  ensures roomRanksAscending(heldRooms(after, next.id))
  ensures next.phase.BatchAcquiring? ==> (
    next.position < |next.wanted| && wantedRoom(next) > 0 &&
    (forall room | room in heldRooms(after, next.id) :: room < wantedRoom(next))
  )
  ensures next.phase.BatchInvoking? ==> next.position == |next.wanted| && heldRooms(after, next.id) == next.wanted
{
  RoomHeldRoomsAreTheExactPlanPrefix(before, prior);
  reveal wantedRoom();
  assert prior.wanted[..next.position] == prior.wanted[..prior.position] + [wantedRoom(prior)];
  RoomPlanRanksHoldForEveryPrefix(next.wanted, next.position);
}

lemma RoomReleaseSelectsWaitingBatch(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
    |waiters| > 0 ==> (
      var selected := batchAt(s, waiters[0].caller);
      waiters[0] in s.queue.waiting && waiters[0].room == room &&
      selected in s.calls && selected.id == waiters[0].caller &&
      selected.phase.BatchWaiting? && wantedRoom(selected) == room
    )
{
  RoomReleaseFrame(s, caller);
  var room := releaseRoomId(s, caller);
  var inRoom := (w: core__concurrency_RoomWaiter) => w.room == room;
  var candidates := ProofLib.Filter(inRoom, s.queue.waiting);
  if |candidates| > 0 {
    var w := candidates[0];
    ProofLib.FilterMember(inRoom, s.queue.waiting, w);
    assert batchAt(s, w.caller).phase.BatchWaiting?;
    RoomBatchLookupRetainsNonterminalIdentity(s, w.caller);
  }
}

lemma RoomReleaseKeepsBatchPlans(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures alwaysBatchesHaveValidPosition(releaseBatchRoom(s, caller))
  ensures alwaysStoredResultFollowsPhase(releaseBatchRoom(s, caller))
  ensures alwaysHeldPrefixMatchesRequests(releaseBatchRoom(s, caller))
  ensures alwaysInvocationHoldsAllRooms(releaseBatchRoom(s, caller))
  ensures alwaysWaitsAboveHeldRooms(releaseBatchRoom(s, caller))
  ensures alwaysReverseReleaseRank(releaseBatchRoom(s, caller))
{
  RoomReleaseFrame(s, caller);
  RoomReleaseSelectsWaitingBatch(s, caller);
  reveal canReleaseBatchRoom();
  var after := releaseBatchRoom(s, caller);
  var room := releaseRoomId(s, caller);
  var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
  forall next | next in after.calls
    ensures 0 <= next.position <= |next.wanted|
    ensures (next.phase.BatchAcquiring? || next.phase.BatchWaiting?) ==> next.position < |next.wanted|
    ensures (next.phase.BatchReleasing? || next.phase.BatchDone?) == !next.resultKind.BatchPending?
    ensures (next.phase.BatchAcquiring? || next.phase.BatchWaiting?) ==> (
      |heldRooms(after, next.id)| == next.position &&
      (forall held | held in heldRooms(after, next.id) :: held in next.wanted)
    )
    ensures next.phase.BatchInvoking? ==> heldRooms(after, next.id) == next.wanted && next.position == |next.wanted|
    ensures roomRanksAscending(next.wanted) && roomRanksAscending(heldRooms(after, next.id))
    ensures (next.phase.BatchAcquiring? || next.phase.BatchWaiting?) ==> (
      wantedRoom(next) > 0 && (forall held | held in heldRooms(after, next.id) :: held < wantedRoom(next))
    )
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == next;
    var prior := s.calls[i];
    assert prior in s.calls && prior.id == next.id && prior.wanted == next.wanted;
    RoomReleaseChangesOnlyTheTwoLeaseOwners(s, caller, prior.id);
    if |waiters| > 0 && waiters[0].caller == prior.id {
      RoomBatchIdentityLookup(s, prior);
      assert prior.phase.BatchWaiting? && wantedRoom(prior) == room;
      RoomAddedLeaseAdvancesExactPlan(s, after, prior, next);
    } else if prior.id == caller {
      RoomBatchIdentityLookup(s, prior);
      assert next == prior && prior.phase.BatchReleasing?;
      RoomRetiredRankPreservesOrder(heldRooms(s, prior.id), room);
    } else {
      assert next == prior && heldRooms(after, next.id) == heldRooms(s, prior.id);
    }
  }
}

lemma RoomWaiterKeysIdentify(queue: core__concurrency_RoomState,
                           left: core__concurrency_RoomWaiter, right: core__concurrency_RoomWaiter)
  requires core__concurrency_alwaysWaitersUnique(queue)
  requires left in queue.waiting && right in queue.waiting
  requires left.ticket == right.ticket || left.caller == right.caller
  ensures left == right
{
  if left.ticket == right.ticket {
    var withTicket := (w: core__concurrency_RoomWaiter) => w.ticket == left.ticket;
    var matches := ProofLib.Filter(withTicket, queue.waiting);
    ProofLib.FilterMember(withTicket, queue.waiting, left);
    ProofLib.FilterMember(withTicket, queue.waiting, right);
    assert |matches| == 1 && matches[0] == left && matches[0] == right;
  } else {
    var withCaller := (w: core__concurrency_RoomWaiter) => w.caller == left.caller;
    var matches := ProofLib.Filter(withCaller, queue.waiting);
    ProofLib.FilterMember(withCaller, queue.waiting, left);
    ProofLib.FilterMember(withCaller, queue.waiting, right);
    assert |matches| == 1 && matches[0] == left && matches[0] == right;
  }
}

lemma RoomReleaseWaiterRetained(s: MultiRoomLeases, caller: int, w: core__concurrency_RoomWaiter)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures var room := releaseRoomId(s, caller);
    var waiters := ProofLib.Filter((entry: core__concurrency_RoomWaiter) => entry.room == room, s.queue.waiting);
    w in releaseBatchRoom(s, caller).queue.waiting <==>
      w in s.queue.waiting && (|waiters| == 0 || waiters[0].caller != w.caller)
{
  RoomReleaseQueueFootprint(s, caller);
  RoomReleaseSelectsWaitingBatch(s, caller);
  var room := releaseRoomId(s, caller);
  var waiters := ProofLib.Filter((entry: core__concurrency_RoomWaiter) => entry.room == room, s.queue.waiting);
  if |waiters| > 0 {
    var selected := waiters[0];
    var remains := (entry: core__concurrency_RoomWaiter) => entry.ticket != selected.ticket;
    ProofLib.FilterMember(remains, s.queue.waiting, w);
    if w in s.queue.waiting && (w.ticket == selected.ticket || w.caller == selected.caller) {
      RoomWaiterKeysIdentify(s.queue, w, selected);
    }
  }
}

lemma RoomReleaseKeepsWaitersWithTheirBatches(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  requires alwaysBatchIdentitiesUnique(releaseBatchRoom(s, caller))
  ensures alwaysWaiterMatchesNextRoom(releaseBatchRoom(s, caller))
  ensures stepClosedAdmissionCannotGrow(s, releaseBatchRoom(s, caller))
{
  RoomReleaseFrame(s, caller);
  var after := releaseBatchRoom(s, caller);
  var room := releaseRoomId(s, caller);
  var waiters := ProofLib.Filter((entry: core__concurrency_RoomWaiter) => entry.room == room, s.queue.waiting);
  forall w | w in after.queue.waiting
    ensures w in s.queue.waiting && batchAt(after, w.caller).phase.BatchWaiting? && wantedRoom(batchAt(after, w.caller)) == w.room
  {
    RoomReleaseWaiterRetained(s, caller, w);
    var prior := batchAt(s, w.caller);
    assert prior.phase.BatchWaiting?;
    RoomBatchLookupRetainsNonterminalIdentity(s, w.caller);
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    assert after.calls[i] == prior && prior in after.calls;
    RoomBatchIdentityLookup(after, prior);
  }
  forall next | next in after.calls && next.phase.BatchWaiting?
    ensures (exists w :: w in after.queue.waiting && w.caller == next.id && w.room == wantedRoom(next))
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == next;
    var prior := s.calls[i];
    assert next == prior && prior in s.calls && (|waiters| == 0 || waiters[0].caller != prior.id);
    var w :| w in s.queue.waiting && w.caller == prior.id && w.room == wantedRoom(prior);
    RoomReleaseWaiterRetained(s, caller, w);
  }
}

lemma RoomReleaseRetainsUnrelatedLease(s: MultiRoomLeases, caller: int, lease: core__concurrency_Lease)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  requires lease in s.queue.leases && (lease.caller != caller || lease.room != releaseRoomId(s, caller))
  ensures lease in releaseBatchRoom(s, caller).queue.leases
{
  RoomReleaseQueueFootprint(s, caller);
  var room := releaseRoomId(s, caller);
  var retain := (prior: core__concurrency_Lease) => prior.caller != caller || prior.room != room;
  ProofLib.FilterMember(retain, s.queue.leases, lease);
}

lemma RoomReleaseKeepsAdmittedWriteSettlement(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures stepReleasedAfterWriteSettlement(s, releaseBatchRoom(s, caller))
{
  RoomReleaseOnlyItsSettledLease(s, caller);
  reveal canReleaseBatchRoom();
  var room := releaseRoomId(s, caller);
  var after := releaseBatchRoom(s, caller);
  forall lease | lease in s.queue.leases
    ensures (exists retained :: retained in after.queue.leases && retained.room == lease.room && retained.caller == lease.caller)
      || (!lease.acceptingWrites && lease.writes == 0 && batchAt(s, lease.caller).phase.BatchReleasing?)
  {
    if lease.caller != caller || lease.room != room {
      RoomReleaseRetainsUnrelatedLease(s, caller, lease);
    }
  }
}

lemma RoomReleaseKeepsLeaseOwners(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures alwaysLeasesBelongToBatch(releaseBatchRoom(s, caller))
{
  RoomReleaseFrame(s, caller);
  RoomReleaseQueueFootprint(s, caller);
  RoomReleaseSelectsWaitingBatch(s, caller);
  var room := releaseRoomId(s, caller);
  var after := releaseBatchRoom(s, caller);
  var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
  var retain := (prior: core__concurrency_Lease) => prior.caller != caller || prior.room != room;
  forall lease | lease in after.queue.leases
    ensures (exists c :: c in after.calls && c.id == lease.caller && !c.phase.BatchDone? && lease.room in c.wanted)
  {
    if lease in s.queue.leases {
      var prior :| prior in s.calls && prior.id == lease.caller && !prior.phase.BatchDone? && lease.room in prior.wanted;
      var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
      assert after.calls[i] in after.calls && !after.calls[i].phase.BatchDone?;
    } else {
      ProofLib.FilterMember(retain, s.queue.leases, lease);
      assert |waiters| > 0 && lease == core__concurrency_Lease(waiters[0].caller, room, true, 0);
      var selected := batchAt(s, waiters[0].caller);
      reveal wantedRoom();
      assert 0 <= selected.position < |selected.wanted| && room in selected.wanted;
      var i :| 0 <= i < |s.calls| && s.calls[i] == selected;
      assert after.calls[i] in after.calls && !after.calls[i].phase.BatchDone?;
    }
  }
}

lemma RoomReleaseKeepsQueuedRoomOwners(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures alwaysWaiterHasOwner(releaseBatchRoom(s, caller))
{
  RoomReleaseQueueFootprint(s, caller);
  var room := releaseRoomId(s, caller);
  var after := releaseBatchRoom(s, caller);
  var inRoom := (w: core__concurrency_RoomWaiter) => w.room == room;
  var waiters := ProofLib.Filter(inRoom, s.queue.waiting);
  forall w | w in after.queue.waiting
    ensures (exists lease :: lease in after.queue.leases && lease.room == w.room)
  {
    RoomReleaseWaiterRetained(s, caller, w);
    if w.room == room {
      ProofLib.FilterMember(inRoom, s.queue.waiting, w);
      assert |waiters| > 0;
      assert core__concurrency_Lease(waiters[0].caller, room, true, 0) in after.queue.leases;
    } else {
      var owner :| owner in s.queue.leases && owner.room == w.room;
      RoomReleaseRetainsUnrelatedLease(s, caller, owner);
    }
  }
}

lemma RoomReleaseRetainsQueueAuthority(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures alwaysAcquiringQueueAuthority(releaseBatchRoom(s, caller))
{
  RoomReleaseFrame(s, caller);
  RoomReleaseQueueFootprint(s, caller);
  RoomReleaseSelectsWaitingBatch(s, caller);
  var room := releaseRoomId(s, caller);
  var after := releaseBatchRoom(s, caller);
  var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
  forall id | id in after.queue.cancelled
    ensures (exists c :: c in after.calls && c.id == id)
  {
    var prior :| prior in s.calls && prior.id == id;
    var i :| 0 <= i < |s.calls| && s.calls[i] == prior;
    assert after.calls[i] in after.calls;
  }
  forall c | c in after.calls && c.phase.BatchAcquiring?
    ensures c.id !in after.queue.cancelled
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    var prior := s.calls[i];
    assert prior in s.calls;
    if |waiters| > 0 && waiters[0].caller == prior.id {
      assert waiters[0].caller !in s.queue.cancelled;
    } else {
      assert prior == c;
    }
  }
}

lemma RoomReleaseKeepsTerminalBatchesEmpty(s: MultiRoomLeases, caller: int)
  requires inv(s) && canReleaseBatchRoom(s, caller)
  ensures alwaysDoneHasNoLease(releaseBatchRoom(s, caller))
{
  RoomReleaseFrame(s, caller);
  reveal canReleaseBatchRoom();
  var room := releaseRoomId(s, caller);
  var after := releaseBatchRoom(s, caller);
  var waiters := ProofLib.Filter((w: core__concurrency_RoomWaiter) => w.room == room, s.queue.waiting);
  forall c | c in after.calls && c.phase.BatchDone?
    ensures |heldRooms(after, c.id)| == 0 && !c.resultKind.BatchPending?
    ensures forall w | w in after.queue.waiting :: w.caller != c.id
  {
    var i :| 0 <= i < |after.calls| && after.calls[i] == c;
    var prior := s.calls[i];
    assert prior == c && prior in s.calls && (|waiters| == 0 || waiters[0].caller != c.id);
    if c.id == caller {
      RoomBatchIdentityLookup(s, prior);
      assert false;
    }
    RoomReleaseChangesOnlyTheTwoLeaseOwners(s, caller, c.id);
    forall w | w in after.queue.waiting ensures w.caller != c.id {
      RoomReleaseWaiterRetained(s, caller, w);
    }
  }
}
