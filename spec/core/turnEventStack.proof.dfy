lemma cleanupTurn_ensures(s: TurnEventStack, turnId: int)
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysCleanupFrameAtBottom(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysControllerIdentitiesValid(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysGroupAllocatorValid(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysTurnsRetainGroups(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysLiveGroupOwnsTurns(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysClosedPendingHasGlobalOwner(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysFramesRetainNotices(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepFirstRegistryAbortReasonStays(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepOuterCallbackWaits(s, "cleanupTurn", cleanupTurn(s, turnId)))
{
  if inv(s) && canCleanupTurn(s, turnId) {
    var after := cleanupTurn(s, turnId);
    TurnCleanupPopsSoleContinuation(s, turnId);
    TurnCleanupPreservesClosedTurnAborts(s, after, turnId);
    TurnCleanupPreservesFirstAbortReasons(s, after, turnId);
    TurnGroupAllocatorPreservedOnCleanup(s, turnId);
    TurnLiveGroupsCleaned(s, turnId);
    TurnControllerIdentityCleaned(s, turnId);
    TurnKeepsGroupsAfterCleanup(s, turnId);
  }
}

lemma TurnCleanupPopsSoleContinuation(s: TurnEventStack, turnId: int)
  requires alwaysControllerIdentitiesValid(s) && alwaysCleanupFrameAtBottom(s)
  requires canCleanupTurn(s, turnId)
  ensures s.frames == [CleanupFrameKind(turnId)]
  ensures cleanupTurn(s, turnId).frames == []
{
  var byId := (t: core__turnControllers_TurnEntry) => (t.id == turnId);
  var matches := ProofLib.Filter(byId, s.controllers.turns);
  assert |matches| > 0;
  var chosen := matches[0];
  ProofLib.FilterMember(byId, s.controllers.turns, chosen);
  assert chosen.id == turnId && chosen.id > 0;
  assert topFrame(s) == CleanupFrameKind(turnId);
  assert |s.frames| > 0;
  var top := s.frames[|s.frames| - 1];
  assert top == topFrame(s);
  if |s.frames| > 1 {
    assert top in s.frames[1..];
    assert s.frames[0..0] + s.frames[1..] == s.frames[1..];
    assert false;
  }
  assert s.frames[0] == top;
  assert s.frames == [top];
}

lemma TurnCleanupPreservesClosedTurnAborts(s: TurnEventStack, after: TurnEventStack, turnId: int)
  requires alwaysClosedPendingHasGlobalOwner(s)
  requires s.frames == [CleanupFrameKind(turnId)] && after == cleanupTurn(s, turnId)
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  if s.controllers.closed {
    forall prior | prior in s.controllers.turns && !prior.phase.TurnDetached? ensures prior.aborted {
      if !prior.aborted {
        var f :| f in s.frames && frameOwnsPendingTurn(s, f, prior.id, groupOf(s, prior.id));
        assert f == CleanupFrameKind(turnId);
        assert !frameOwnsPendingTurn(s, f, prior.id, groupOf(s, prior.id));
      }
    }
    forall current | current in after.controllers.turns && !current.phase.TurnDetached? ensures current.aborted {
      var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == current;
      assert s.controllers.turns[i] in s.controllers.turns;
      assert current == s.controllers.turns[i];
    }
  }
}

lemma TurnCleanupPreservesFirstAbortReasons(s: TurnEventStack, after: TurnEventStack, turnId: int)
  requires after == cleanupTurn(s, turnId)
  ensures stepFirstRegistryAbortReasonStays(s, after)
{
  TurnFirstAbortReasonsPreserved(s, after);
}

lemma TurnFirstAbortReasonsPreserved(before: TurnEventStack, after: TurnEventStack)
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| && before.controllers.turns[i].aborted ==>
    (after.controllers.turns[i].id == before.controllers.turns[i].id &&
      after.controllers.turns[i].aborted && after.controllers.turns[i].reason == before.controllers.turns[i].reason)
  ensures stepFirstRegistryAbortReasonStays(before, after)
{
  forall t | t in before.controllers.turns && t.aborted
    ensures (exists later :: later in after.controllers.turns && later.id == t.id && later.aborted && later.reason == t.reason)
  {
    var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
    var later := after.controllers.turns[i];
    assert later in after.controllers.turns;
    assert later.id == t.id && later.aborted && later.reason == t.reason;
  }
}

lemma TurnFirstAbortReasonsAfterReturn(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  ensures stepFirstRegistryAbortReasonStays(s, returnTurn(s, turnId, resolved, errorId))
{
  TurnFirstAbortReasonsPreserved(s, returnTurn(s, turnId, resolved, errorId));
}

lemma TurnMembershipSnapshotPreserved(before: TurnEventStack, after: TurnEventStack)
  requires alwaysTurnsRetainGroups(before)
  requires after.turnGroups == before.turnGroups && after.groups == before.groups && after.controllers.turns == before.controllers.turns
  ensures alwaysTurnsRetainGroups(after)
{
  forall entry | entry in after.controllers.turns ensures groupOf(after, entry.id) == groupOf(before, entry.id) {}
}

lemma abortRoom_ensures(s: TurnEventStack, room: string, selfId: int, reason: string)
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysCleanupFrameAtBottom(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysControllerIdentitiesValid(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysGroupAllocatorValid(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysTurnsRetainGroups(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysLiveGroupOwnsTurns(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysClosedPendingHasGlobalOwner(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysFramesRetainNotices(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepFirstRegistryAbortReasonStays(s, abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepOuterCallbackWaits(s, "abortRoom", abortRoom(s, room, selfId, reason)))
{
  if inv(s) && canAbortRoom(s, room, selfId, reason) {
    var after := abortRoom(s, room, selfId, reason);
    TurnMembershipSnapshotPreserved(s, after);
    TurnPendingOwnerFramesPreserved(s, after);
    TurnFrameBeganRoomAbort(s, room, selfId, reason);
  }
}

lemma beginGlobalAbort_ensures(s: TurnEventStack, reason: string, close: bool)
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysCleanupFrameAtBottom(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysControllerIdentitiesValid(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysGroupAllocatorValid(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysTurnsRetainGroups(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysLiveGroupOwnsTurns(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysClosedPendingHasGlobalOwner(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysFramesRetainNotices(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepFirstRegistryAbortReasonStays(s, beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepOuterCallbackWaits(s, "beginGlobalAbort", beginGlobalAbort(s, reason, close)))
{
  if inv(s) && canBeginGlobalAbort(s, reason, close) {
    TurnMembershipSnapshotPreserved(s, beginGlobalAbort(s, reason, close));
    TurnControllerIdentityFieldsPreserved(s, beginGlobalAbort(s, reason, close));
    TurnFrameBeganGlobalAbort(s, reason, close);
    TurnGlobalAbortKeepsAllocatorAndPendingOwners(s, reason, close);
  }
}

lemma finishGlobalAbort_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysCleanupFrameAtBottom(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysControllerIdentitiesValid(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysGroupAllocatorValid(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysTurnsRetainGroups(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysLiveGroupOwnsTurns(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysClosedPendingHasGlobalOwner(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysFramesRetainNotices(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepFirstRegistryAbortReasonStays(s, finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepOuterCallbackWaits(s, "finishGlobalAbort", finishGlobalAbort(s)))
{
  if inv(s) && canFinishGlobalAbort(s) {
    TurnMembershipSnapshotPreserved(s, finishGlobalAbort(s));
    TurnPendingOwnerFinishedGlobal(s);
    TurnControllerIdentityFieldsPreserved(s, finishGlobalAbort(s));
    TurnFrameFinishedGlobal(s);
  }
}

lemma advanceGlobalAbort_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysCleanupFrameAtBottom(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysControllerIdentitiesValid(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysGroupAllocatorValid(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysTurnsRetainGroups(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysLiveGroupOwnsTurns(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysClosedPendingHasGlobalOwner(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysFramesRetainNotices(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepFirstRegistryAbortReasonStays(s, advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepOuterCallbackWaits(s, "advanceGlobalAbort", advanceGlobalAbort(s)))
{
  if inv(s) && canAdvanceGlobalAbort(s) {
    TurnMembershipSnapshotPreserved(s, advanceGlobalAbort(s));
    TurnFrameAdvancedGlobal(s);
    TurnPendingAdvanceRetainsOwnership(s);
    TurnAllocatorAfterGlobalAdvance(s);
  }
}

lemma returnNativeSignal_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysCleanupFrameAtBottom(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysControllerIdentitiesValid(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysGroupAllocatorValid(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysTurnsRetainGroups(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysLiveGroupOwnsTurns(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysClosedPendingHasGlobalOwner(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysFramesRetainNotices(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepFirstRegistryAbortReasonStays(s, returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepOuterCallbackWaits(s, "returnNativeSignal", returnNativeSignal(s)))
{
  if inv(s) && canReturnNativeSignal(s) {
    TurnMembershipSnapshotPreserved(s, returnNativeSignal(s));
    TurnPendingOwnerReturnedNative(s);
    TurnFrameReturnedNative(s);
  }
}

lemma returnRoomAbort_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysCleanupFrameAtBottom(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysControllerIdentitiesValid(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysGroupAllocatorValid(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysTurnsRetainGroups(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysLiveGroupOwnsTurns(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysClosedPendingHasGlobalOwner(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysFramesRetainNotices(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepFirstRegistryAbortReasonStays(s, returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepOuterCallbackWaits(s, "returnRoomAbort", returnRoomAbort(s)))
{
  if inv(s) && canReturnRoomAbort(s) {
    TurnMembershipSnapshotPreserved(s, returnRoomAbort(s));
    TurnPendingOwnerReturnedRoom(s);
    TurnControllerIdentityFieldsPreserved(s, returnRoomAbort(s));
    TurnFrameReturnedRoom(s);
  }
}

lemma finishRoomSignal_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysCleanupFrameAtBottom(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysControllerIdentitiesValid(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysGroupAllocatorValid(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysTurnsRetainGroups(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysLiveGroupOwnsTurns(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysClosedPendingHasGlobalOwner(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysFramesRetainNotices(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepFirstRegistryAbortReasonStays(s, finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepOuterCallbackWaits(s, "finishRoomSignal", finishRoomSignal(s)))
{
  if inv(s) && canFinishRoomSignal(s) {
    TurnMembershipSnapshotPreserved(s, finishRoomSignal(s));
    TurnPendingOwnerFinishedRoom(s);
    TurnControllerNoticeFinishedRoom(s);
    TurnFrameFinishedRoom(s);
  }
}

lemma subscribe_ensures(s: TurnEventStack, callback: int)
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysCleanupFrameAtBottom(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysControllerIdentitiesValid(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysGroupAllocatorValid(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysTurnsRetainGroups(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysLiveGroupOwnsTurns(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysClosedPendingHasGlobalOwner(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysFramesRetainNotices(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepFirstRegistryAbortReasonStays(s, subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepOuterCallbackWaits(s, "subscribe", subscribe(s, callback)))
{
  if inv(s) && canSubscribe(s, callback) {
    var after := subscribe(s, callback);
    TurnMembershipSnapshotPreserved(s, after);
    TurnFirstAbortReasonsPreserved(s, after);
    TurnLiveGroupsUnchanged(s, after);
    TurnPendingOwnerFramesPreserved(s, after);
    TurnControllerIdentitySubscribe(s, callback);
    TurnFrameSnapshotValid(s, after);
  }
}

lemma unsubscribe_ensures(s: TurnEventStack, callback: int)
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysCleanupFrameAtBottom(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysControllerIdentitiesValid(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysGroupAllocatorValid(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysTurnsRetainGroups(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysLiveGroupOwnsTurns(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysClosedPendingHasGlobalOwner(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysFramesRetainNotices(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepFirstRegistryAbortReasonStays(s, unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepOuterCallbackWaits(s, "unsubscribe", unsubscribe(s, callback)))
{
  if inv(s) && canUnsubscribe(s, callback) {
    var after := unsubscribe(s, callback);
    TurnMembershipSnapshotPreserved(s, after);
    TurnPendingOwnerFramesPreserved(s, after);
    TurnControllerIdentityUnsubscribe(s, callback);
    TurnFrameSnapshotValid(s, after);
  }
}

lemma finishEvent_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysCleanupFrameAtBottom(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysControllerIdentitiesValid(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysGroupAllocatorValid(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysTurnsRetainGroups(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysLiveGroupOwnsTurns(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysClosedPendingHasGlobalOwner(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysFramesRetainNotices(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepFirstRegistryAbortReasonStays(s, finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepOuterCallbackWaits(s, "finishEvent", finishEvent(s)))
{
  if inv(s) && canFinishEvent(s) {
    var after := finishEvent(s);
    TurnMembershipSnapshotPreserved(s, after);
    TurnPendingOwnerEventFrames(s, after);
    TurnControllerNoticeFinishedEvent(s);
    TurnFrameFinishedEvent(s);
  }
}

lemma endListener_ensures(s: TurnEventStack, ok: bool)
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysCleanupFrameAtBottom(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysControllerIdentitiesValid(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysGroupAllocatorValid(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysTurnsRetainGroups(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysLiveGroupOwnsTurns(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysClosedPendingHasGlobalOwner(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysFramesRetainNotices(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepFirstRegistryAbortReasonStays(s, endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepOuterCallbackWaits(s, "endListener", endListener(s, ok)))
{
  if inv(s) && canEndListener(s, ok) {
    var after := endListener(s, ok);
    TurnMembershipSnapshotPreserved(s, after);
    TurnPendingOwnerEventFrames(s, after);
    TurnControllerNoticeEndedListener(s, ok);
    TurnFrameEndedListener(s, ok);
  }
}

lemma beginListener_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysCleanupFrameAtBottom(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysControllerIdentitiesValid(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysGroupAllocatorValid(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysTurnsRetainGroups(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysLiveGroupOwnsTurns(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysClosedPendingHasGlobalOwner(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysFramesRetainNotices(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepFirstRegistryAbortReasonStays(s, beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepOuterCallbackWaits(s, "beginListener", beginListener(s)))
{
  if inv(s) && canBeginListener(s) {
    var after := beginListener(s);
    TurnMembershipSnapshotPreserved(s, after);
    TurnPendingOwnerEventFrames(s, after);
    TurnControllerNoticeBeganListener(s);
    TurnFrameBeganListener(s);
  }
}

lemma startTurn_ensures(s: TurnEventStack, turnId: int, room: string)
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysCleanupFrameAtBottom(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysControllerIdentitiesValid(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysGroupAllocatorValid(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysTurnsRetainGroups(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysLiveGroupOwnsTurns(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysClosedPendingHasGlobalOwner(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysFramesRetainNotices(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepFirstRegistryAbortReasonStays(s, startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepOuterCallbackWaits(s, "startTurn", startTurn(s, turnId, room)))
{
  hide *;
  reveal inv(), stepOuterCallbackWaits();
  if inv(s) && canStartTurn(s, turnId, room) {
    TurnStartRetainsCleanupFrame(s, turnId, room);
    TurnStartKeepsFirstAbortReason(s, turnId, room);
    TurnGroupAllocatorPreservedOnStart(s, turnId, room);
    TurnLiveGroupsStarted(s, turnId, room);
    TurnStartRetainsRoomMemberships(s, turnId, room);
    TurnPendingOwnerStarted(s, turnId, room);
    TurnControllerIdentityStarted(s, turnId, room);
    TurnFrameStartedTurn(s, turnId, room);
  }
}

lemma TurnGroupAllocatorProjection(s: TurnEventStack)
  ensures alwaysGroupAllocatorValid(s) ==
    (s.nextGroup > 0 && (forall g :: g in s.groups ==>
      (0 < g.id < s.nextGroup &&
        |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), s.groups)| == 1 &&
        (g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), s.groups)| == 1))))
{}

lemma TurnGroupAllocatorKnown(s: TurnEventStack, g: RoomGroup)
  requires alwaysGroupAllocatorValid(s) && g in s.groups
  ensures 0 < g.id < s.nextGroup
  ensures |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), s.groups)| == 1
  ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), s.groups)| == 1
{
  TurnGroupAllocatorProjection(s);
}

lemma TurnGroupAllocatorVacantRoom(s: TurnEventStack, room: string)
  requires alwaysGroupAllocatorValid(s) && liveGroup(s, room) == 0
  ensures forall g :: g in s.groups ==> !g.active || g.room != room
{
  var byRoom := (g: RoomGroup) => (g.room == room) && g.active;
  var matches := ProofLib.Filter(byRoom, s.groups);
  if |matches| > 0 {
    assert matches[0].id == liveGroup(s, room);
    ProofLib.FilterMember(byRoom, s.groups, matches[0]);
    TurnGroupAllocatorKnown(s, matches[0]);
    assert false;
  }
  forall g | g in s.groups ensures !g.active || g.room != room {
    ProofLib.FilterMember(byRoom, s.groups, g);
  }
}

lemma TurnGroupAllocatorAppendedGroup(before: TurnEventStack, after: TurnEventStack, added: RoomGroup, g: RoomGroup)
  requires alwaysGroupAllocatorValid(before)
  requires added.active && added.id == before.nextGroup && after.nextGroup == before.nextGroup + 1
  requires after.groups == before.groups + [added] && g in after.groups
  requires forall prior :: prior in before.groups ==> !prior.active || prior.room != added.room
  ensures 0 < g.id < after.nextGroup
  ensures |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), after.groups)| == 1
  ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups)| == 1
{
  var byId := (other: RoomGroup) => (other.id == g.id);
  var activeInRoom := (other: RoomGroup) => (other.active && (other.room == g.room));
  ProofLib.FilterAppend(byId, before.groups, added);
  if g == added {
    forall prior | prior in before.groups ensures !byId(prior) {
      TurnGroupAllocatorKnown(before, prior);
    }
    ProofLib.FilterNone(byId, before.groups);
    ProofLib.FilterNone(activeInRoom, before.groups);
    ProofLib.FilterAppend(activeInRoom, before.groups, added);
  } else {
    assert g in before.groups;
    TurnGroupAllocatorKnown(before, g);
    assert !byId(added);
    if g.active {
      assert g.room != added.room;
      assert !activeInRoom(added);
      ProofLib.FilterAppend(activeInRoom, before.groups, added);
    }
  }
}

lemma TurnGroupAllocatorPreservedOnStart(s: TurnEventStack, turnId: int, room: string)
  requires alwaysGroupAllocatorValid(s)
  ensures alwaysGroupAllocatorValid(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  if liveGroup(s, room) == 0 {
    var added := RoomGroup(s.nextGroup, room, true);
    TurnGroupAllocatorProjection(s);
    TurnGroupAllocatorProjection(after);
    TurnGroupAllocatorVacantRoom(s, room);
    forall g | g in after.groups
      ensures 0 < g.id < after.nextGroup
      ensures |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), after.groups)| == 1
      ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups)| == 1
    {
      TurnGroupAllocatorAppendedGroup(s, after, added, g);
    }
  }
}

lemma TurnGroupAllocatorMappedGroup(before: TurnEventStack, after: TurnEventStack, i: int)
  requires alwaysGroupAllocatorValid(before) && after.nextGroup == before.nextGroup
  requires |before.groups| == |after.groups| && 0 <= i < |after.groups|
  requires forall j :: 0 <= j < |before.groups| ==>
    (after.groups[j].id == before.groups[j].id && after.groups[j].room == before.groups[j].room &&
      (after.groups[j].active ==> before.groups[j].active))
  ensures 0 < after.groups[i].id < after.nextGroup
  ensures |ProofLib.Filter((other: RoomGroup) => (other.id == after.groups[i].id), after.groups)| == 1
  ensures after.groups[i].active ==>
    |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == after.groups[i].room)), after.groups)| == 1
{
  var prior := before.groups[i];
  var kept := after.groups[i];
  assert prior in before.groups;
  TurnGroupAllocatorKnown(before, prior);
  var byId := (other: RoomGroup) => (other.id == kept.id);
  ProofLib.FilterLengthPointwise(byId, byId, before.groups, after.groups);
  if kept.active {
    var activeInRoom := (other: RoomGroup) => (other.active && (other.room == kept.room));
    assert activeInRoom(prior);
    forall j | 0 <= j < |after.groups| && j != i ensures !activeInRoom(after.groups[j]) {
      if activeInRoom(after.groups[j]) {
        assert activeInRoom(before.groups[j]);
        ProofLib.FilterTwo(activeInRoom, before.groups, i, j);
        assert false;
      }
    }
    ProofLib.FilterOne(activeInRoom, after.groups, i);
  }
}

lemma TurnGroupAllocatorPreservedOnCleanup(s: TurnEventStack, turnId: int)
  requires alwaysGroupAllocatorValid(s)
  ensures alwaysGroupAllocatorValid(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  TurnGroupAllocatorProjection(s);
  TurnGroupAllocatorProjection(after);
  forall g | g in after.groups
    ensures 0 < g.id < after.nextGroup
    ensures |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), after.groups)| == 1
    ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups)| == 1
  {
    var i :| 0 <= i < |after.groups| && g == after.groups[i];
    TurnGroupAllocatorMappedGroup(s, after, i);
  }
}

lemma returnTurn_ensures(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysCleanupFrameAtBottom(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysControllerIdentitiesValid(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysGroupAllocatorValid(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysTurnsRetainGroups(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysLiveGroupOwnsTurns(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysClosedPendingHasGlobalOwner(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysFramesRetainNotices(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepFirstRegistryAbortReasonStays(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepOuterCallbackWaits(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
{
  hide *;
  reveal inv(), stepOuterCallbackWaits(), alwaysControllerIdentitiesValid();
  if inv(s) && canReturnTurn(s, turnId, resolved, errorId) {
    TurnReturnRetainsStructuralFrame(s, turnId, resolved, errorId);
    TurnFirstAbortReasonsAfterReturn(s, turnId, resolved, errorId);
    TurnLiveGroupsReturned(s, turnId, resolved, errorId);
    TurnPendingOwnerReturned(s, turnId, resolved, errorId);
    TurnControllerIdentityReturned(s, turnId, resolved, errorId);
    TurnKeepsGroupsAfterReturn(s, turnId, resolved, errorId);
    TurnFrameReturnedTurn(s, turnId, resolved, errorId);
  }
}

lemma visitRoomSignal_ensures(s: TurnEventStack)
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysCleanupFrameAtBottom(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysControllerIdentitiesValid(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysGroupAllocatorValid(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysTurnsRetainGroups(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysLiveGroupOwnsTurns(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysClosedPendingHasGlobalOwner(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysFramesRetainNotices(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepFirstRegistryAbortReasonStays(s, visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepOuterCallbackWaits(s, "visitRoomSignal", visitRoomSignal(s)))
{
  if inv(s) && canVisitRoomSignal(s) {
    var after := visitRoomSignal(s);
    TurnFirstAbortReasonsPreserved(s, after);
    TurnLiveGroupsVisited(s);
    TurnPendingOwnerVisited(s);
    TurnControllerIdentityVisited(s);
    TurnKeepsGroupsAfterSignalVisit(s);
    TurnFrameVisitedRoom(s);
  }
}

lemma TurnLiveGroupsUnchanged(before: TurnEventStack, after: TurnEventStack)
  requires alwaysLiveGroupOwnsTurns(before)
  requires before.groups == after.groups && before.turnGroups == after.turnGroups
  requires before.controllers.turns == after.controllers.turns
  ensures alwaysLiveGroupOwnsTurns(after)
{
  forall t | t in after.controllers.turns ensures groupOf(before, t.id) == groupOf(after, t.id) {}
}

lemma TurnLiveGroupWitness(before: TurnEventStack, after: TurnEventStack, group: int)
  requires before.turnGroups == after.turnGroups
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==>
    (before.controllers.turns[i].id == after.controllers.turns[i].id &&
      before.controllers.turns[i].phase.TurnDetached? == after.controllers.turns[i].phase.TurnDetached?)
  requires exists t :: t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == group
  ensures exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group
{
  var t :| t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == group;
  var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
  var retained := after.controllers.turns[i];
  assert retained in after.controllers.turns && !retained.phase.TurnDetached?;
  assert groupOf(after, retained.id) == groupOf(before, t.id);
}

lemma TurnLiveGroupsMapped(before: TurnEventStack, after: TurnEventStack)
  requires alwaysLiveGroupOwnsTurns(before)
  requires before.groups == after.groups && before.turnGroups == after.turnGroups
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==>
    (before.controllers.turns[i].id == after.controllers.turns[i].id &&
      before.controllers.turns[i].phase.TurnDetached? == after.controllers.turns[i].phase.TurnDetached?)
  ensures alwaysLiveGroupOwnsTurns(after)
{
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    assert g in before.groups;
    if g.active {
      TurnLiveGroupWitness(before, after, g.id);
    } else if (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id) {
      TurnLiveGroupWitness(after, before, g.id);
      assert false;
    }
  }
}

lemma TurnLiveGroupsReturnIsAttached(s: TurnEventStack, turnId: int, resolved: bool, errorId: string, t: core__turnControllers_TurnEntry)
  requires core__turnControllers_alwaysTurnIdentity(s.controllers)
  requires canReturnTurn(s, turnId, resolved, errorId)
  requires t in s.controllers.turns && t.id == turnId
  ensures !t.phase.TurnDetached?
{
  var byId := (other: core__turnControllers_TurnEntry) => (other.id == t.id);
  var matches := ProofLib.Filter(byId, s.controllers.turns);
  assert |matches| == 1;
  ProofLib.FilterMember(byId, s.controllers.turns, t);
  assert t == matches[0];
  assert t == core__turnControllers_controller(s.controllers, turnId);
}

lemma TurnLiveGroupsReturned(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysLiveGroupOwnsTurns(s) && core__turnControllers_alwaysTurnIdentity(s.controllers)
  requires canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysLiveGroupOwnsTurns(returnTurn(s, turnId, resolved, errorId))
{
  var after := returnTurn(s, turnId, resolved, errorId);
  forall i | 0 <= i < |s.controllers.turns|
    ensures s.controllers.turns[i].id == after.controllers.turns[i].id
    ensures s.controllers.turns[i].phase.TurnDetached? == after.controllers.turns[i].phase.TurnDetached?
  {
    var t := s.controllers.turns[i];
    if t.id == turnId {
      assert t in s.controllers.turns;
      TurnLiveGroupsReturnIsAttached(s, turnId, resolved, errorId, t);
    }
  }
  TurnLiveGroupsMapped(s, after);
}

lemma TurnLiveGroupsVisited(s: TurnEventStack)
  requires alwaysLiveGroupOwnsTurns(s)
  ensures alwaysLiveGroupOwnsTurns(visitRoomSignal(s))
{
  TurnLiveGroupsMapped(s, visitRoomSignal(s));
}

lemma TurnLiveGroupKnown(s: TurnEventStack, g: RoomGroup)
  requires alwaysLiveGroupOwnsTurns(s) && g in s.groups
  ensures g.active == (exists t :: t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) == g.id)
{}

lemma TurnLiveGroupMembersAfterCleanup(before: TurnEventStack, after: TurnEventStack, turnId: int, group: int)
  requires after == cleanupTurn(before, turnId)
  ensures (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group) ==
    (exists t :: t in before.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(before, t.id) == group)
{
  if (exists t :: t in before.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(before, t.id) == group) {
    var t :| t in before.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(before, t.id) == group;
    var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
    assert t == after.controllers.turns[i] && t in after.controllers.turns;
    assert groupOf(before, t.id) == groupOf(after, t.id);
  } else if (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group) {
    var t :| t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group;
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
    assert t.id != turnId && t == before.controllers.turns[i] && t in before.controllers.turns;
    assert groupOf(before, t.id) == groupOf(after, t.id);
    assert false;
  }
}

lemma TurnLiveGroupCleanupAt(s: TurnEventStack, after: TurnEventStack, turnId: int, i: int)
  requires alwaysLiveGroupOwnsTurns(s) && after == cleanupTurn(s, turnId)
  requires 0 <= i < |after.groups|
  ensures after.groups[i].active ==
    (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == after.groups[i].id)
{
  var prior := s.groups[i];
  var current := after.groups[i];
  assert prior in s.groups && current.id == prior.id;
  TurnLiveGroupKnown(s, prior);
  TurnLiveGroupMembersAfterCleanup(s, after, turnId, prior.id);
  var retained := (exists t :: t in s.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(s, t.id) == prior.id);
  if retained {
    assert prior.active;
    assert current.active;
  } else if prior.id == groupOf(s, turnId) {
    assert !current.active;
  } else if current.active {
    assert prior.active;
    var t :| t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) == prior.id;
    assert t.id != turnId;
    assert false;
  }
}

lemma TurnLiveGroupsCleaned(s: TurnEventStack, turnId: int)
  requires alwaysLiveGroupOwnsTurns(s)
  ensures alwaysLiveGroupOwnsTurns(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    var i :| 0 <= i < |after.groups| && after.groups[i] == g;
    TurnLiveGroupCleanupAt(s, after, turnId, i);
  }
}

lemma TurnLiveGroupLookupProjection(s: TurnEventStack, turnId: int)
  ensures groupOf(s, turnId) ==
    (var matches := ProofLib.Filter((g: TurnGroup) => (g.turnId == turnId), s.turnGroups);
     if |matches| > 0 then matches[0].group else 0)
{}

lemma TurnLiveGroupLookupAfterAppend(before: TurnEventStack, after: TurnEventStack, added: TurnGroup, turnId: int)
  requires after.turnGroups == before.turnGroups + [added]
  requires forall g :: g in before.turnGroups ==> g.turnId != added.turnId
  ensures groupOf(after, turnId) == (if turnId == added.turnId then added.group else groupOf(before, turnId))
{
  TurnLiveGroupLookupProjection(before, turnId);
  TurnLiveGroupLookupProjection(after, turnId);
  var byTurn := (g: TurnGroup) => (g.turnId == turnId);
  ProofLib.FilterAppend(byTurn, before.turnGroups, added);
  if turnId == added.turnId {
    ProofLib.FilterNone(byTurn, before.turnGroups);
  }
}

lemma TurnLiveGroupsStartMembershipIsFresh(s: TurnEventStack, turnId: int, room: string)
  requires alwaysTurnsRetainGroups(s) && canStartTurn(s, turnId, room)
  ensures forall m :: m in s.turnGroups ==> m.turnId != turnId
{
  forall m | m in s.turnGroups ensures m.turnId != turnId {
    if m.turnId == turnId {
      assert (exists t :: (t in s.controllers.turns && t.id == m.turnId &&
        (exists g :: g in s.groups && g.id == m.group && g.room == t.room)));
      assert false;
    }
  }
}

lemma TurnLiveGroupMembersAfterStart(before: TurnEventStack, after: TurnEventStack, turnId: int, room: string, group: int)
  requires after == startTurn(before, turnId, room)
  requires forall m :: m in before.turnGroups ==> m.turnId != turnId
  requires forall t :: t in before.controllers.turns ==> t.id != turnId
  ensures (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group) ==
    ((if liveGroup(before, room) == 0 then before.nextGroup else liveGroup(before, room)) == group ||
      (exists t :: t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == group))
{
  var added := after.turnGroups[|before.turnGroups|];
  var started := after.controllers.turns[|before.controllers.turns|];
  assert started in after.controllers.turns && started.id == turnId && !started.phase.TurnDetached?;
  if added.group == group {
    TurnLiveGroupLookupAfterAppend(before, after, added, started.id);
  } else if (exists t :: t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == group) {
    var t :| t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == group;
    assert t in after.controllers.turns && t.id != turnId;
    TurnLiveGroupLookupAfterAppend(before, after, added, t.id);
  } else if (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group) {
    var t :| t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == group;
    TurnLiveGroupLookupAfterAppend(before, after, added, t.id);
    if t == started {
      assert false;
    }
    assert t in before.controllers.turns && t.id != turnId;
    assert false;
  }
}

lemma TurnLiveGroupChosenRoomIsActive(s: TurnEventStack, room: string, g: RoomGroup)
  requires alwaysGroupAllocatorValid(s) && g in s.groups
  requires g.id == liveGroup(s, room) && g.id != 0
  ensures g.active
{
  var activeInRoom := (other: RoomGroup) => ((other.room == room) && other.active);
  var matching := ProofLib.Filter(activeInRoom, s.groups);
  assert |matching| > 0 && matching[0].id == g.id;
  var chosen := matching[0];
  ProofLib.FilterMember(activeInRoom, s.groups, chosen);
  var byId := (other: RoomGroup) => (other.id == g.id);
  TurnGroupAllocatorKnown(s, g);
  ProofLib.FilterMember(byId, s.groups, g);
  ProofLib.FilterMember(byId, s.groups, chosen);
  assert g == chosen;
}

lemma TurnLiveGroupStartAt(s: TurnEventStack, after: TurnEventStack, turnId: int, room: string, g: RoomGroup)
  requires after == startTurn(s, turnId, room) && g in after.groups
  requires alwaysLiveGroupOwnsTurns(s) && alwaysGroupAllocatorValid(s)
  requires forall m :: m in s.turnGroups ==> m.turnId != turnId
  requires forall t :: t in s.controllers.turns ==> t.id != turnId
  ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
{
  TurnLiveGroupMembersAfterStart(s, after, turnId, room, g.id);
  if g in s.groups {
    TurnLiveGroupKnown(s, g);
    if liveGroup(s, room) == 0 {
      TurnGroupAllocatorKnown(s, g);
      assert g.id != s.nextGroup;
    } else if g.id == liveGroup(s, room) {
      TurnLiveGroupChosenRoomIsActive(s, room, g);
    }
  } else {
    assert liveGroup(s, room) == 0 && g == RoomGroup(s.nextGroup, room, true);
  }
}

lemma TurnLiveGroupsStarted(s: TurnEventStack, turnId: int, room: string)
  requires alwaysLiveGroupOwnsTurns(s) && alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s)
  requires canStartTurn(s, turnId, room)
  ensures alwaysLiveGroupOwnsTurns(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  TurnLiveGroupsStartMembershipIsFresh(s, turnId, room);
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    TurnLiveGroupStartAt(s, after, turnId, room, g);
  }
}

lemma TurnPendingOwnerMemberSequence(before: TurnEventStack, after: TurnEventStack, group: int)
  requires before.controllers.turns == after.controllers.turns && before.turnGroups == after.turnGroups
  ensures roomGroupMembers(before, group) == roomGroupMembers(after, group)
{
  var beforeMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(before, t.id) == group)) && (group > 0));
  var afterMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0));
  forall i | 0 <= i < |before.controllers.turns|
    ensures beforeMember(before.controllers.turns[i]) == afterMember(before.controllers.turns[i])
  {
    var t := before.controllers.turns[i];
    assert groupOf(before, t.id) == groupOf(after, t.id);
  }
  ProofLib.FilterSamePredicate(beforeMember, afterMember, before.controllers.turns);
}

lemma TurnPendingOwnerFramesPreserved(before: TurnEventStack, after: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(before)
  requires before.controllers.closed == after.controllers.closed
  requires before.controllers.turns == after.controllers.turns && before.turnGroups == after.turnGroups
  requires forall f :: f in before.frames && (f.GlobalFrameKind? || f.RoomScanKind?) ==> f in after.frames
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      var group := groupOf(before, t.id);
      assert group == groupOf(after, t.id);
      var f :| f in before.frames && frameOwnsPendingTurn(before, f, t.id, group);
      assert f.GlobalFrameKind? || f.RoomScanKind?;
      assert f in after.frames;
      if f.RoomScanKind? {
        TurnPendingOwnerMemberSequence(before, after, group);
      }
      assert frameOwnsPendingTurn(after, f, t.id, group);
    }
  }
}

lemma TurnPendingOwnerEventFrames(before: TurnEventStack, after: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(before)
  requires before.controllers.closed == after.controllers.closed
  requires before.controllers.turns == after.controllers.turns && before.turnGroups == after.turnGroups
  requires |before.frames| > 0 && topFrame(before).EventFrameKind?
  requires |after.frames| >= |before.frames| - 1
  requires before.frames[..|before.frames| - 1] == after.frames[..|before.frames| - 1]
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  forall f | f in before.frames && (f.GlobalFrameKind? || f.RoomScanKind?) ensures f in after.frames {
    var i :| 0 <= i < |before.frames| && before.frames[i] == f;
    assert i != |before.frames| - 1;
    assert f == after.frames[i];
  }
  TurnPendingOwnerFramesPreserved(before, after);
}

lemma TurnPendingOwnerReturnWithoutFrames(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && s.controllers.closed && |s.frames| == 0
  ensures forall t :: t in s.controllers.turns && !t.phase.TurnDetached? ==> t.aborted
{}

lemma TurnPendingOwnerReturned(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysClosedPendingHasGlobalOwner(s) && core__turnControllers_alwaysTurnIdentity(s.controllers)
  requires canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysClosedPendingHasGlobalOwner(returnTurn(s, turnId, resolved, errorId))
{
  var after := returnTurn(s, turnId, resolved, errorId);
  if after.controllers.closed {
    TurnPendingOwnerReturnWithoutFrames(s);
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? ensures t.aborted {
      var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
      var prior := s.controllers.turns[i];
      assert prior in s.controllers.turns;
      if prior.id == turnId {
        TurnLiveGroupsReturnIsAttached(s, turnId, resolved, errorId, prior);
      }
      assert !prior.phase.TurnDetached? && prior.aborted;
      assert t.aborted;
    }
  }
}

lemma TurnPendingOwnerSuffixWitness(groups: seq<int>, cursor: int, group: int)
  ensures Std.Collections.Seq.FoldLeft(
    (point: GlobalGroupCursor, id: int) => GlobalGroupCursor((point.remaining - 1), (point.retained || ((point.remaining <= 0) && (id == group)))),
    GlobalGroupCursor(cursor, false), groups).remaining == cursor - |groups|
  ensures groupInSuffix(groups, cursor, group) ==
    (exists i :: 0 <= i < |groups| && cursor <= i && groups[i] == group)
  decreases |groups|
{
  if |groups| > 0 {
    var last := |groups| - 1;
    var prefix := groups[..last];
    var advance := (point: GlobalGroupCursor, id: int) => GlobalGroupCursor((point.remaining - 1), (point.retained || ((point.remaining <= 0) && (id == group))));
    assert groups == prefix + [groups[last]];
    ProofLib.FoldLeftAppend(advance, GlobalGroupCursor(cursor, false), prefix, groups[last]);
    TurnPendingOwnerSuffixWitness(prefix, cursor, group);
    if (exists i :: 0 <= i < |groups| && cursor <= i && groups[i] == group) {
      var i :| 0 <= i < |groups| && cursor <= i && groups[i] == group;
      if i < last {
        assert prefix[i] == groups[i];
        assert groupInSuffix(prefix, cursor, group);
      } else {
        assert i == last;
      }
    } else if groupInSuffix(prefix, cursor, group) {
      var i :| 0 <= i < |prefix| && cursor <= i && prefix[i] == group;
      assert groups[i] == group;
      assert false;
    }
  }
}

lemma TurnPendingOwnerEquivalentFrame(before: TurnEventStack, after: TurnEventStack, owner: TurnFrame, retained: TurnFrame, turnId: int, group: int)
  requires before.controllers.turns == after.controllers.turns && before.turnGroups == after.turnGroups
  requires frameOwnsPendingTurn(before, owner, turnId, group)
  requires (if owner.GlobalFrameKind? then
    (retained.GlobalFrameKind? && owner.groups == retained.groups && owner.cursor == retained.cursor)
    else (owner.RoomScanKind? && retained.RoomScanKind? && owner.global == retained.global &&
      owner.group == retained.group && owner.scan.cursor == retained.scan.cursor))
  ensures frameOwnsPendingTurn(after, retained, turnId, group)
{
  if owner.RoomScanKind? {
    TurnPendingOwnerMemberSequence(before, after, group);
  }
}

lemma TurnPendingOwnerReturnedNative(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && canReturnNativeSignal(s)
  ensures alwaysClosedPendingHasGlobalOwner(returnNativeSignal(s))
{
  var after := returnNativeSignal(s);
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      var group := groupOf(s, t.id);
      assert group == groupOf(after, t.id);
      var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, t.id, group);
      var i :| 0 <= i < |s.frames| && s.frames[i] == owner;
      var retained := after.frames[i];
      assert retained in after.frames;
      if i == |s.frames| - 1 {
        assert owner == topFrame(s) && owner.RoomScanKind?;
        assert retained.RoomScanKind? && owner.scan.cursor == retained.scan.cursor;
      } else {
        assert retained == owner;
      }
      TurnPendingOwnerEquivalentFrame(s, after, owner, retained, t.id, group);
    }
  }
}

lemma TurnPendingOwnerReturnedRoom(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && canReturnRoomAbort(s)
  ensures alwaysClosedPendingHasGlobalOwner(returnRoomAbort(s))
{
  var after := returnRoomAbort(s);
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      var group := groupOf(s, t.id);
      assert group == groupOf(after, t.id);
      var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, t.id, group);
      var i :| 0 <= i < |s.frames| && s.frames[i] == owner;
      assert i < |s.frames| - 1;
      var retained := after.frames[i];
      assert retained in after.frames;
      if retained != owner {
        assert owner.GlobalFrameKind? && retained.GlobalFrameKind?;
        assert owner.groups == retained.groups && owner.cursor == retained.cursor;
      }
      TurnPendingOwnerEquivalentFrame(s, after, owner, retained, t.id, group);
    }
  }
}

lemma TurnPendingOwnerFramesBelowCompletedTop(s: TurnEventStack, after: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && s.controllers.closed == after.controllers.closed
  requires s.controllers.turns == after.controllers.turns && s.turnGroups == after.turnGroups
  requires 0 < |s.frames| && |s.frames| - 1 <= |after.frames|
  requires s.frames[..|s.frames| - 1] == after.frames[..|s.frames| - 1]
  requires forall turnId, group :: !frameOwnsPendingTurn(s, topFrame(s), turnId, group)
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      var group := groupOf(s, t.id);
      assert group == groupOf(after, t.id);
      var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, t.id, group);
      var i :| 0 <= i < |s.frames| && s.frames[i] == owner;
      if i == |s.frames| - 1 {
        assert owner == topFrame(s);
        assert !frameOwnsPendingTurn(s, topFrame(s), t.id, group);
        assert false;
      }
      assert owner == after.frames[i] && owner in after.frames;
      TurnPendingOwnerEquivalentFrame(s, after, owner, owner, t.id, group);
    }
  }
}

lemma TurnPendingOwnerFinishedGlobal(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && canFinishGlobalAbort(s)
  ensures alwaysClosedPendingHasGlobalOwner(finishGlobalAbort(s))
{
  var completed := topFrame(s);
  forall turnId, group | frameOwnsPendingTurn(s, completed, turnId, group) ensures false {
    TurnPendingOwnerSuffixWitness(completed.groups, completed.cursor, group);
  }
  TurnPendingOwnerFramesBelowCompletedTop(s, finishGlobalAbort(s));
}

lemma TurnPendingOwnerFinishedRoom(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && canFinishRoomSignal(s)
  ensures alwaysClosedPendingHasGlobalOwner(finishRoomSignal(s))
{
  var completed := topFrame(s);
  assert completed.RoomScanKind?;
  forall turnId, group | frameOwnsPendingTurn(s, completed, turnId, group) ensures false {
    assert completed.global && completed.group == group;
    var ids := (var s_map := roomGroupMembers(s, group);
      seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
    assert groupInSuffix(ids, completed.scan.cursor, turnId);
    assert completed.scan.cursor == |ids|;
    TurnPendingOwnerSuffixWitness(ids, completed.scan.cursor, turnId);
    assert false;
  }
  TurnPendingOwnerFramesBelowCompletedTop(s, finishRoomSignal(s));
}

lemma TurnPendingOwnerMemberIdsMapped(before: TurnEventStack, after: TurnEventStack, group: int)
  requires before.turnGroups == after.turnGroups
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==>
    (before.controllers.turns[i].id == after.controllers.turns[i].id &&
      before.controllers.turns[i].phase.TurnDetached? == after.controllers.turns[i].phase.TurnDetached?)
  ensures
    (var s_map := roomGroupMembers(before, group); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id)) ==
    (var s_map := roomGroupMembers(after, group); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id))
{
  var beforeMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(before, t.id) == group)) && (group > 0));
  var afterMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0));
  var sameId := (prior: core__turnControllers_TurnEntry, current: core__turnControllers_TurnEntry) => prior.id == current.id;
  forall i | 0 <= i < |before.controllers.turns|
    ensures beforeMember(before.controllers.turns[i]) == afterMember(after.controllers.turns[i])
    ensures sameId(before.controllers.turns[i], after.controllers.turns[i])
  {
    var prior := before.controllers.turns[i];
    var current := after.controllers.turns[i];
    assert groupOf(before, prior.id) == groupOf(after, current.id);
  }
  ProofLib.FilterPointwise(beforeMember, afterMember, sameId, before.controllers.turns, after.controllers.turns);
}

lemma TurnPendingOwnerSameControllerId(s: TurnEventStack, a: core__turnControllers_TurnEntry, b: core__turnControllers_TurnEntry)
  requires core__turnControllers_alwaysTurnIdentity(s.controllers)
  requires a in s.controllers.turns && b in s.controllers.turns && a.id == b.id
  ensures a == b && a.id > 0
{
  var byId := (other: core__turnControllers_TurnEntry) => (other.id == a.id);
  var matches := ProofLib.Filter(byId, s.controllers.turns);
  assert |matches| == 1;
  ProofLib.FilterMember(byId, s.controllers.turns, a);
  ProofLib.FilterMember(byId, s.controllers.turns, b);
  assert a == matches[0] && b == matches[0];
}

lemma TurnPendingOwnerVisitSelectedAborts(s: TurnEventStack, after: TurnEventStack, k: int)
  requires after == visitRoomSignal(s)
  requires topFrame(s).RoomScanKind? && topFrame(s).scan.excluded == 0
  requires 0 <= k < |s.controllers.turns|
  requires 0 <= topFrame(s).scan.cursor < |roomGroupMembers(s, topFrame(s).group)|
  requires s.controllers.turns[k] == roomGroupMembers(s, topFrame(s).group)[topFrame(s).scan.cursor]
  requires s.controllers.turns[k].id > 0 && !s.controllers.turns[k].aborted
  ensures after.controllers.turns[k].aborted
{
  var scan := currentRoomScan(s);
  var projection := scanProjection(s, scan);
  var chosen := s.controllers.turns[k];
  assert projection.turns[scan.scan.cursor].turnId == chosen.id;
  assert !projection.turns[scan.scan.cursor].aborted;
  var visited := core__turnSignalScan_topScan(core__turnSignalScan_visitSignalTurn(projection));
  assert visited.notifying == chosen.id;
}

lemma TurnPendingOwnerVisitTop(s: TurnEventStack, after: TurnEventStack, k: int)
  requires after == visitRoomSignal(s) && canVisitRoomSignal(s)
  requires alwaysFramesRetainNotices(s) && core__turnControllers_alwaysTurnIdentity(s.controllers)
  requires 0 <= k < |s.controllers.turns| && !after.controllers.turns[k].aborted
  requires frameOwnsPendingTurn(s, topFrame(s), s.controllers.turns[k].id, groupOf(s, s.controllers.turns[k].id))
  ensures frameOwnsPendingTurn(after, topFrame(after), after.controllers.turns[k].id, groupOf(after, after.controllers.turns[k].id))
{
  var prior := s.controllers.turns[k];
  var owner := topFrame(s);
  var retained := topFrame(after);
  var group := groupOf(s, prior.id);
  assert owner in s.frames && owner.RoomScanKind? && owner.global && owner.group == group;
  assert retained.RoomScanKind? && retained.global && retained.group == group;
  assert validStackFrame(s, owner);
  var beforeIds := (var s_map := roomGroupMembers(s, group);
    seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
  var afterIds := (var s_map := roomGroupMembers(after, group);
    seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
  TurnPendingOwnerMemberIdsMapped(s, after, group);
  assert groupInSuffix(beforeIds, owner.scan.cursor, prior.id);
  TurnPendingOwnerSuffixWitness(beforeIds, owner.scan.cursor, prior.id);
  var i :| 0 <= i < |beforeIds| && owner.scan.cursor <= i && beforeIds[i] == prior.id;
  if i == owner.scan.cursor {
    var selected := roomGroupMembers(s, group)[i];
    var belongs := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0));
    ProofLib.FilterMember(belongs, s.controllers.turns, selected);
    assert selected.id == prior.id && prior in s.controllers.turns;
    TurnPendingOwnerSameControllerId(s, selected, prior);
    assert owner.scan.excluded == 0 && !prior.aborted;
    TurnPendingOwnerVisitSelectedAborts(s, after, k);
    assert false;
  }
  assert retained.scan.cursor == owner.scan.cursor + 1;
  TurnPendingOwnerSuffixWitness(afterIds, retained.scan.cursor, prior.id);
  assert groupInSuffix(afterIds, retained.scan.cursor, prior.id);
}

lemma TurnPendingOwnerVisited(s: TurnEventStack)
  requires canVisitRoomSignal(s) && alwaysClosedPendingHasGlobalOwner(s)
  requires alwaysFramesRetainNotices(s) && core__turnControllers_alwaysTurnIdentity(s.controllers)
  ensures alwaysClosedPendingHasGlobalOwner(visitRoomSignal(s))
{
  var after := visitRoomSignal(s);
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      var k :| 0 <= k < |after.controllers.turns| && after.controllers.turns[k] == t;
      var prior := s.controllers.turns[k];
      var group := groupOf(s, prior.id);
      assert prior in s.controllers.turns && prior.id == t.id && !prior.aborted && !prior.phase.TurnDetached?;
      assert group == groupOf(after, t.id);
      var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, prior.id, group);
      var i :| 0 <= i < |s.frames| && s.frames[i] == owner;
      if i == |s.frames| - 1 {
        TurnPendingOwnerVisitTop(s, after, k);
        assert topFrame(after) in after.frames;
      } else {
        assert owner == after.frames[i] && owner in after.frames;
        if owner.RoomScanKind? {
          TurnPendingOwnerMemberIdsMapped(s, after, group);
        }
        assert frameOwnsPendingTurn(after, owner, t.id, group);
      }
    }
  }
}

lemma TurnControllerIdentityFieldsPreserved(before: TurnEventStack, after: TurnEventStack)
  requires alwaysControllerIdentitiesValid(before)
  requires before.controllers.turns == after.controllers.turns && before.controllers.rooms == after.controllers.rooms
  requires before.controllers.notices == after.controllers.notices && before.controllers.nextNotice == after.controllers.nextNotice
  requires before.controllers.listeners == after.controllers.listeners
  ensures alwaysControllerIdentitiesValid(after)
{}

lemma TurnControllerIdentityListenersPreserved(before: TurnEventStack, after: TurnEventStack)
  requires alwaysControllerIdentitiesValid(before)
  requires before.controllers.turns == after.controllers.turns && before.controllers.rooms == after.controllers.rooms
  requires before.controllers.notices == after.controllers.notices && before.controllers.nextNotice == after.controllers.nextNotice
  requires core__turnControllers_alwaysOneLiveListener(after.controllers)
  ensures alwaysControllerIdentitiesValid(after)
{}

lemma TurnControllerIdentityListenerRule(s: core__turnControllers_TurnControllers)
  ensures core__turnControllers_alwaysOneLiveListener(s) ==
    (forall l :: l in s.listeners && l.present ==>
      |ProofLib.Filter((other: core__turnControllers_TurnListener) => ((other.callback == l.callback) && other.present), s.listeners)| == 1)
{}

lemma TurnControllerIdentityAddedListener(s: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers, callback: int)
  requires core__turnControllers_alwaysOneLiveListener(s)
  requires after == core__turnControllers_subscribeTurnEvents(s, callback)
  ensures core__turnControllers_alwaysOneLiveListener(after)
{
  if !(exists l :: l in s.listeners && ((l.callback == callback) && l.present)) {
    var added := core__turnControllers_TurnListener(callback, s.nextListener, true);
    TurnControllerIdentityListenerRule(s);
    TurnControllerIdentityListenerRule(after);
    forall l | l in after.listeners && l.present
      ensures |ProofLib.Filter((other: core__turnControllers_TurnListener) => ((other.callback == l.callback) && other.present), after.listeners)| == 1
    {
      var live := (other: core__turnControllers_TurnListener) => ((other.callback == l.callback) && other.present);
      ProofLib.FilterAppend(live, s.listeners, added);
      if l == added {
        ProofLib.FilterNone(live, s.listeners);
      } else {
        assert l in s.listeners && l.callback != callback;
        assert !live(added);
      }
    }
  }
}

lemma TurnControllerIdentityRemovedListener(s: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers, callback: int)
  requires core__turnControllers_alwaysOneLiveListener(s)
  requires after == core__turnControllers_unsubscribeTurnEvents(s, callback)
  ensures core__turnControllers_alwaysOneLiveListener(after)
{
  TurnControllerIdentityListenerRule(s);
  TurnControllerIdentityListenerRule(after);
  forall l | l in after.listeners && l.present
    ensures |ProofLib.Filter((other: core__turnControllers_TurnListener) => ((other.callback == l.callback) && other.present), after.listeners)| == 1
  {
    var i :| 0 <= i < |after.listeners| && after.listeners[i] == l;
    assert l == s.listeners[i] && l in s.listeners;
    var live := (other: core__turnControllers_TurnListener) => ((other.callback == l.callback) && other.present);
    forall j | 0 <= j < |after.listeners| && j != i ensures !live(after.listeners[j]) {
      if live(after.listeners[j]) {
        assert after.listeners[j] == s.listeners[j];
        ProofLib.FilterTwo(live, s.listeners, i, j);
        assert false;
      }
    }
    ProofLib.FilterOne(live, after.listeners, i);
  }
}

lemma TurnControllerIdentitySubscribe(s: TurnEventStack, callback: int)
  requires alwaysControllerIdentitiesValid(s)
  ensures alwaysControllerIdentitiesValid(subscribe(s, callback))
{
  var after := subscribe(s, callback);
  TurnControllerIdentityAddedListener(s.controllers, after.controllers, callback);
  TurnControllerIdentityListenersPreserved(s, after);
}

lemma TurnControllerIdentityUnsubscribe(s: TurnEventStack, callback: int)
  requires alwaysControllerIdentitiesValid(s)
  ensures alwaysControllerIdentitiesValid(unsubscribe(s, callback))
{
  var after := unsubscribe(s, callback);
  TurnControllerIdentityRemovedListener(s.controllers, after.controllers, callback);
  TurnControllerIdentityListenersPreserved(s, after);
}

lemma TurnControllerNoticeIdentityFields(before: TurnEventStack, after: TurnEventStack)
  requires alwaysControllerIdentitiesValid(before)
  requires before.controllers.turns == after.controllers.turns && before.controllers.rooms == after.controllers.rooms
  requires before.controllers.listeners == after.controllers.listeners
  requires core__turnControllers_alwaysNoticesUnique(after.controllers)
  ensures alwaysControllerIdentitiesValid(after)
{}

lemma TurnControllerNoticeRule(s: core__turnControllers_TurnControllers)
  ensures core__turnControllers_alwaysNoticesUnique(s) ==
    (s.nextNotice > 0 && (forall n :: n in s.notices ==>
      (0 < n.id < s.nextNotice &&
        |ProofLib.Filter((other: core__turnControllers_TurnNotice) => (other.id == n.id), s.notices)| == 1 &&
        (forall generation :: generation in n.delivered ==> generation <= n.cursor))))
{}

lemma TurnControllerNoticeKnown(s: core__turnControllers_TurnControllers, n: core__turnControllers_TurnNotice)
  requires core__turnControllers_alwaysNoticesUnique(s) && n in s.notices
  ensures 0 < n.id < s.nextNotice
  ensures |ProofLib.Filter((other: core__turnControllers_TurnNotice) => (other.id == n.id), s.notices)| == 1
  ensures forall generation :: generation in n.delivered ==> generation <= n.cursor
{
  TurnControllerNoticeRule(s);
}

lemma TurnControllerNoticeSelected(s: core__turnControllers_TurnControllers, n: core__turnControllers_TurnNotice, noticeId: int)
  requires core__turnControllers_alwaysNoticesUnique(s) && n in s.notices && n.id == noticeId
  ensures core__turnControllers_notice(s, noticeId) == n
{
  TurnControllerNoticeKnown(s, n);
  var byId := (other: core__turnControllers_TurnNotice) => (other.id == n.id);
  var matches := ProofLib.Filter(byId, s.notices);
  ProofLib.FilterMember(byId, s.notices, n);
  assert n == matches[0];
  assert n == core__turnControllers_notice(s, noticeId);
}

lemma TurnControllerNoticeMapped(before: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers)
  requires core__turnControllers_alwaysNoticesUnique(before)
  requires before.nextNotice == after.nextNotice && |before.notices| == |after.notices|
  requires forall i :: 0 <= i < |before.notices| ==> before.notices[i].id == after.notices[i].id
  requires forall n :: n in after.notices ==> (forall generation :: generation in n.delivered ==> generation <= n.cursor)
  ensures core__turnControllers_alwaysNoticesUnique(after)
{
  TurnControllerNoticeRule(before);
  TurnControllerNoticeRule(after);
  forall n | n in after.notices
    ensures 0 < n.id < after.nextNotice
    ensures |ProofLib.Filter((other: core__turnControllers_TurnNotice) => (other.id == n.id), after.notices)| == 1
  {
    var i :| 0 <= i < |after.notices| && after.notices[i] == n;
    var prior := before.notices[i];
    assert prior in before.notices;
    TurnControllerNoticeKnown(before, prior);
    var byId := (other: core__turnControllers_TurnNotice) => (other.id == n.id);
    ProofLib.FilterLengthPointwise(byId, byId, before.notices, after.notices);
  }
}

lemma TurnControllerNoticeFinishedEvent(s: TurnEventStack)
  requires alwaysControllerIdentitiesValid(s)
  ensures alwaysControllerIdentitiesValid(finishEvent(s))
{
  var after := finishEvent(s);
  forall n | n in after.controllers.notices
    ensures forall generation :: generation in n.delivered ==> generation <= n.cursor
  {
    var i :| 0 <= i < |after.controllers.notices| && after.controllers.notices[i] == n;
    var prior := s.controllers.notices[i];
    assert prior in s.controllers.notices;
    TurnControllerNoticeKnown(s.controllers, prior);
  }
  TurnControllerNoticeMapped(s.controllers, after.controllers);
  TurnControllerNoticeIdentityFields(s, after);
}

lemma TurnControllerNoticeListenerAdvances(s: core__turnControllers_TurnControllers, noticeId: int)
  requires core__turnControllers_nextTurnListener(s, noticeId).present
  ensures core__turnControllers_nextTurnListener(s, noticeId).generation > core__turnControllers_notice(s, noticeId).cursor
{
  var local_6 := core__turnControllers_notice(s, noticeId);
  var eligible := (l: core__turnControllers_TurnListener) => (l.present && (l.generation > local_6.cursor));
  var matches := ProofLib.Filter(eligible, s.listeners);
  var chosen := core__turnControllers_nextTurnListener(s, noticeId);
  assert |matches| > 0 && matches[0] == chosen;
  ProofLib.FilterMember(eligible, s.listeners, chosen);
}

lemma TurnControllerNoticeBeganListener(s: TurnEventStack)
  requires alwaysControllerIdentitiesValid(s) && canBeginListener(s)
  ensures alwaysControllerIdentitiesValid(beginListener(s))
{
  var after := beginListener(s);
  var noticeId := currentEvent(s).noticeId;
  TurnControllerNoticeListenerAdvances(s.controllers, noticeId);
  forall n | n in after.controllers.notices
    ensures forall generation :: generation in n.delivered ==> generation <= n.cursor
  {
    var i :| 0 <= i < |after.controllers.notices| && after.controllers.notices[i] == n;
    var prior := s.controllers.notices[i];
    assert prior in s.controllers.notices;
    TurnControllerNoticeKnown(s.controllers, prior);
    if prior.id == noticeId {
      TurnControllerNoticeSelected(s.controllers, prior, noticeId);
      assert n.cursor > prior.cursor;
    }
  }
  TurnControllerNoticeMapped(s.controllers, after.controllers);
  TurnControllerNoticeIdentityFields(s, after);
}

lemma TurnControllerNoticeFrameGeneration(s: TurnEventStack, ok: bool, notice: core__turnControllers_TurnNotice)
  requires alwaysControllerIdentitiesValid(s) && alwaysFramesRetainNotices(s) && canEndListener(s, ok)
  requires notice in s.controllers.notices && notice.id == currentEvent(s).noticeId
  ensures notice.cursor == currentEvent(s).listenerGeneration
{
  var frame := topFrame(s);
  assert frame in s.frames && frame.EventFrameKind? && frame.invoking;
  assert validStackFrame(s, frame);
  var matching :| matching in s.controllers.notices && matching.id == frame.noticeId && matching.cursor == frame.listenerGeneration;
  TurnControllerNoticeSelected(s.controllers, notice, frame.noticeId);
  TurnControllerNoticeSelected(s.controllers, matching, frame.noticeId);
}

lemma TurnControllerNoticeEndedListener(s: TurnEventStack, ok: bool)
  requires alwaysControllerIdentitiesValid(s) && alwaysFramesRetainNotices(s) && canEndListener(s, ok)
  ensures alwaysControllerIdentitiesValid(endListener(s, ok))
{
  var after := endListener(s, ok);
  forall n | n in after.controllers.notices
    ensures forall generation :: generation in n.delivered ==> generation <= n.cursor
  {
    var i :| 0 <= i < |after.controllers.notices| && after.controllers.notices[i] == n;
    var prior := s.controllers.notices[i];
    assert prior in s.controllers.notices;
    TurnControllerNoticeKnown(s.controllers, prior);
    if prior.id == currentEvent(s).noticeId {
      TurnControllerNoticeFrameGeneration(s, ok, prior);
    }
  }
  TurnControllerNoticeMapped(s.controllers, after.controllers);
  TurnControllerNoticeIdentityFields(s, after);
}

lemma TurnPendingOwnerStartedMembershipPrefix(s: TurnEventStack, after: TurnEventStack, turnId: int, room: string, group: int)
  requires after == startTurn(s, turnId, room)
  requires forall m :: m in s.turnGroups ==> m.turnId != turnId
  requires forall t :: t in s.controllers.turns ==> t.id != turnId
  ensures |roomGroupMembers(s, group)| <= |roomGroupMembers(after, group)|
  ensures roomGroupMembers(after, group)[..|roomGroupMembers(s, group)|] == roomGroupMembers(s, group)
{
  var added := after.turnGroups[|s.turnGroups|];
  var started := after.controllers.turns[|s.controllers.turns|];
  var beforeMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0));
  var afterMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0));
  forall i | 0 <= i < |s.controllers.turns|
    ensures beforeMember(s.controllers.turns[i]) == afterMember(s.controllers.turns[i])
  {
    var t := s.controllers.turns[i];
    assert t in s.controllers.turns && t.id != turnId;
    TurnLiveGroupLookupAfterAppend(s, after, added, t.id);
  }
  ProofLib.FilterSamePredicate(beforeMember, afterMember, s.controllers.turns);
  ProofLib.FilterAppend(afterMember, s.controllers.turns, started);
}

lemma TurnPendingOwnerStartedFrame(s: TurnEventStack, after: TurnEventStack, turnId: int, room: string, owner: TurnFrame, t: core__turnControllers_TurnEntry)
  requires after == startTurn(s, turnId, room)
  requires forall m :: m in s.turnGroups ==> m.turnId != turnId
  requires forall prior :: prior in s.controllers.turns ==> prior.id != turnId
  requires t in s.controllers.turns && frameOwnsPendingTurn(s, owner, t.id, groupOf(s, t.id))
  ensures frameOwnsPendingTurn(after, owner, t.id, groupOf(after, t.id))
{
  var added := after.turnGroups[|s.turnGroups|];
  var group := groupOf(s, t.id);
  TurnLiveGroupLookupAfterAppend(s, after, added, t.id);
  assert group == groupOf(after, t.id);
  if owner.RoomScanKind? {
    TurnPendingOwnerStartedMembershipPrefix(s, after, turnId, room, group);
    var before := roomGroupMembers(s, group);
    var current := roomGroupMembers(after, group);
    var beforeIds := (var s_map := roomGroupMembers(s, group);
      seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
    var afterIds := (var s_map := roomGroupMembers(after, group);
      seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
    assert owner.global && owner.group == group;
    assert groupInSuffix(beforeIds, owner.scan.cursor, t.id);
    TurnPendingOwnerSuffixWitness(beforeIds, owner.scan.cursor, t.id);
    var i :| 0 <= i < |beforeIds| && owner.scan.cursor <= i && beforeIds[i] == t.id;
    assert before[i] == current[i] && afterIds[i] == t.id;
    TurnPendingOwnerSuffixWitness(afterIds, owner.scan.cursor, t.id);
    assert groupInSuffix(afterIds, owner.scan.cursor, t.id);
  }
}

lemma TurnPendingOwnerStartedWitness(s: TurnEventStack, after: TurnEventStack, turnId: int, room: string, t: core__turnControllers_TurnEntry)
  requires after == startTurn(s, turnId, room)
  requires alwaysClosedPendingHasGlobalOwner(s) && after.controllers.closed
  requires t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
  requires forall m :: m in s.turnGroups ==> m.turnId != turnId
  requires forall prior :: prior in s.controllers.turns ==> prior.id != turnId
  ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
{
  var started := after.controllers.turns[|s.controllers.turns|];
  assert s.controllers.closed && started.aborted;
  assert t in s.controllers.turns;
  var group := groupOf(s, t.id);
  var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, t.id, group);
  assert owner in after.frames;
  TurnPendingOwnerStartedFrame(s, after, turnId, room, owner, t);
}

lemma TurnPendingOwnerStarted(s: TurnEventStack, turnId: int, room: string)
  requires canStartTurn(s, turnId, room)
  requires alwaysTurnsRetainGroups(s) && alwaysClosedPendingHasGlobalOwner(s)
  ensures alwaysClosedPendingHasGlobalOwner(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  if after.controllers.closed {
    TurnLiveGroupsStartMembershipIsFresh(s, turnId, room);
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      TurnPendingOwnerStartedWitness(s, after, turnId, room, t);
    }
  }
}

lemma TurnFrameSnapshotValid(before: TurnEventStack, after: TurnEventStack)
  requires alwaysFramesRetainNotices(before)
  requires before.frames == after.frames
  requires forall n :: n in before.controllers.notices ==> n in after.controllers.notices
  requires before.groups == after.groups && before.turnGroups == after.turnGroups
  requires before.controllers.turns == after.controllers.turns
  ensures alwaysFramesRetainNotices(after)
{
  forall f | f in after.frames ensures validStackFrame(after, f) {
    assert f in before.frames && validStackFrame(before, f);
    if f.EventFrameKind? {
      var persisted :| persisted in before.controllers.notices && persisted.id == f.noticeId && !persisted.finished;
      assert persisted in after.controllers.notices;
      if f.invoking {
        var cursor :| cursor in before.controllers.notices && cursor.id == f.noticeId && cursor.cursor == f.listenerGeneration;
        assert cursor in after.controllers.notices;
      }
    } else if f.RoomScanKind? {
      TurnPendingOwnerMemberSequence(before, after, f.group);
    }
  }
}

lemma TurnControllerIdentityOpenView(s: TurnEventStack)
  ensures alwaysControllerIdentitiesValid(s) == core__turnControllers_inv(s.controllers.(closed := false))
{}

lemma TurnControllerIdentityReturned(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysControllerIdentitiesValid(s) && canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysControllerIdentitiesValid(returnTurn(s, turnId, resolved, errorId))
{
  TurnControllerIdentityOpenView(s);
  var controller := s.controllers.(closed := false);
  var after := returnTurn(s, turnId, resolved, errorId);
  assert core__turnControllers_canReturnTurn(controller, turnId, resolved, errorId);
  core__turnControllers_returnTurn_ensures(controller, turnId, resolved, errorId);
  assert after.controllers.(closed := false) == core__turnControllers_returnTurn(controller, turnId, resolved, errorId);
  TurnControllerIdentityOpenView(after);
}

lemma TurnControllerIdentityCleaned(s: TurnEventStack, turnId: int)
  requires alwaysControllerIdentitiesValid(s) && canCleanupTurn(s, turnId)
  ensures alwaysControllerIdentitiesValid(cleanupTurn(s, turnId))
{
  TurnControllerIdentityOpenView(s);
  var controller := s.controllers.(closed := false);
  var after := cleanupTurn(s, turnId);
  assert core__turnControllers_canCleanupTurn(controller, turnId);
  core__turnControllers_cleanupTurn_ensures(controller, turnId);
  assert after.controllers.(closed := false) == core__turnControllers_cleanupTurn(controller, turnId);
  TurnControllerIdentityOpenView(after);
}

lemma TurnControllerIdentityProjectedKeys(before: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers)
  requires core__turnControllers_alwaysTurnIdentity(before)
  requires |before.turns| == |after.turns|
  requires forall i :: 0 <= i < |before.turns| ==> before.turns[i].id == after.turns[i].id
  ensures core__turnControllers_alwaysTurnIdentity(after)
{
  forall t | t in after.turns
    ensures 0 < t.id
    ensures |ProofLib.Filter((other: core__turnControllers_TurnEntry) => (other.id == t.id), after.turns)| == 1
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == t;
    var prior := before.turns[i];
    assert prior in before.turns && prior.id == t.id;
    var byId := (other: core__turnControllers_TurnEntry) => (other.id == t.id);
    ProofLib.FilterLengthPointwise(byId, byId, before.turns, after.turns);
  }
}

lemma TurnControllerIdentityProjectedRooms(before: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers)
  requires core__turnControllers_alwaysActiveRoomsMatch(before)
  requires before.rooms == after.rooms && |before.turns| == |after.turns|
  requires forall i :: 0 <= i < |before.turns| ==>
    (before.turns[i].room == after.turns[i].room &&
      before.turns[i].phase.TurnDetached? == after.turns[i].phase.TurnDetached?)
  ensures core__turnControllers_alwaysActiveRoomsMatch(after)
{
  forall room | room in after.rooms
    ensures |ProofLib.Filter((other: string) => (other == room), after.rooms)| == 1
    ensures (exists t :: t in after.turns && t.room == room && !t.phase.TurnDetached?)
  {
    var prior :| prior in before.turns && prior.room == room && !prior.phase.TurnDetached?;
    var i :| 0 <= i < |before.turns| && before.turns[i] == prior;
    var current := after.turns[i];
    assert current in after.turns && current.room == room && !current.phase.TurnDetached?;
  }
  forall t | t in after.turns && !t.phase.TurnDetached? ensures t.room in after.rooms {
    var i :| 0 <= i < |after.turns| && after.turns[i] == t;
    var prior := before.turns[i];
    assert prior in before.turns && !prior.phase.TurnDetached?;
    assert prior.room in before.rooms && prior.room == t.room;
  }
}

lemma TurnControllerIdentityProjectedTurns(before: TurnEventStack, after: TurnEventStack)
  requires alwaysControllerIdentitiesValid(before)
  requires before.controllers.rooms == after.controllers.rooms && before.controllers.listeners == after.controllers.listeners
  requires before.controllers.notices == after.controllers.notices && before.controllers.nextNotice == after.controllers.nextNotice
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==>
    (before.controllers.turns[i].id == after.controllers.turns[i].id &&
      before.controllers.turns[i].room == after.controllers.turns[i].room &&
      before.controllers.turns[i].phase.TurnDetached? == after.controllers.turns[i].phase.TurnDetached?)
  ensures alwaysControllerIdentitiesValid(after)
{
  TurnControllerIdentityProjectedKeys(before.controllers, after.controllers);
  TurnControllerIdentityProjectedRooms(before.controllers, after.controllers);
}

lemma TurnControllerIdentityStarted(s: TurnEventStack, turnId: int, room: string)
  requires alwaysControllerIdentitiesValid(s) && canStartTurn(s, turnId, room)
  ensures alwaysControllerIdentitiesValid(startTurn(s, turnId, room))
{
  TurnControllerIdentityOpenView(s);
  var controller := s.controllers.(closed := false);
  var after := startTurn(s, turnId, room);
  assert core__turnControllers_canStartTurn(controller, turnId, room);
  core__turnControllers_startTurn_ensures(controller, turnId, room);
  var projected := after.(controllers := core__turnControllers_startTurn(controller, turnId, room));
  assert !projected.controllers.closed;
  TurnControllerIdentityOpenView(projected);
  TurnControllerIdentityProjectedTurns(projected, after);
}

lemma TurnControllerIdentityVisited(s: TurnEventStack)
  requires alwaysControllerIdentitiesValid(s)
  ensures alwaysControllerIdentitiesValid(visitRoomSignal(s))
{
  TurnControllerIdentityProjectedTurns(s, visitRoomSignal(s));
}

lemma TurnControllerNoticeAppend(before: core__turnControllers_TurnControllers, after: core__turnControllers_TurnControllers, added: core__turnControllers_TurnNotice)
  requires core__turnControllers_alwaysNoticesUnique(before)
  requires after.notices == before.notices + [added] && after.nextNotice == before.nextNotice + 1
  requires added.id == before.nextNotice
  requires forall generation :: generation in added.delivered ==> generation <= added.cursor
  ensures core__turnControllers_alwaysNoticesUnique(after)
{
  TurnControllerNoticeRule(before);
  TurnControllerNoticeRule(after);
  forall n | n in after.notices
    ensures 0 < n.id < after.nextNotice
    ensures |ProofLib.Filter((other: core__turnControllers_TurnNotice) => (other.id == n.id), after.notices)| == 1
    ensures forall generation :: generation in n.delivered ==> generation <= n.cursor
  {
    var byId := (other: core__turnControllers_TurnNotice) => (other.id == n.id);
    ProofLib.FilterAppend(byId, before.notices, added);
    if n == added {
      forall prior | prior in before.notices ensures !byId(prior) {
        TurnControllerNoticeKnown(before, prior);
      }
      ProofLib.FilterNone(byId, before.notices);
    } else {
      assert n in before.notices;
      TurnControllerNoticeKnown(before, n);
      assert !byId(added);
    }
  }
}

lemma TurnControllerNoticeFinishedRoom(s: TurnEventStack)
  requires alwaysControllerIdentitiesValid(s)
  ensures alwaysControllerIdentitiesValid(finishRoomSignal(s))
{
  var after := finishRoomSignal(s);
  if s.controllers.nextNotice != after.controllers.nextNotice {
    var added := after.controllers.notices[|s.controllers.notices|];
    assert added.delivered == [];
    TurnControllerNoticeAppend(s.controllers, after.controllers, added);
  }
  TurnControllerNoticeIdentityFields(s, after);
}

lemma TurnFrameCountBeforeSuffix(frames: seq<TurnFrame>, prefix: int, selected: TurnFrame -> bool)
  requires 0 <= prefix <= |frames|
  requires forall i :: prefix <= i < |frames| ==> !selected(frames[i])
  ensures ProofLib.Filter(selected, frames) == ProofLib.Filter(selected, frames[..prefix])
  decreases |frames| - prefix
{
  if prefix < |frames| {
    var last := |frames| - 1;
    var front := frames[..last];
    assert frames == front + [frames[last]];
    assert !selected(frames[last]);
    ProofLib.FilterAppend(selected, front, frames[last]);
    TurnFrameCountBeforeSuffix(front, prefix, selected);
    assert front[..prefix] == frames[..prefix];
  } else {
    assert prefix == |frames| && frames[..prefix] == frames;
  }
}

lemma TurnFrameRegistryCounts(before: seq<TurnFrame>, after: seq<TurnFrame>, prefix: int, selected: TurnFrame -> bool)
  requires 0 <= prefix <= |before| && prefix <= |after|
  requires before[..prefix] == after[..prefix]
  requires forall i :: prefix <= i < |before| ==> !selected(before[i])
  requires forall i :: prefix <= i < |after| ==> !selected(after[i])
  ensures ProofLib.Filter(selected, before) == ProofLib.Filter(selected, after)
{
  TurnFrameCountBeforeSuffix(before, prefix, selected);
  TurnFrameCountBeforeSuffix(after, prefix, selected);
}

lemma TurnFrameNonRegistrySuffixValid(before: TurnEventStack, after: TurnEventStack, prefix: int)
  requires alwaysFramesRetainNotices(before)
  requires before.controllers.notices == after.controllers.notices && before.controllers.turns == after.controllers.turns
  requires before.groups == after.groups && before.turnGroups == after.turnGroups
  requires 0 <= prefix <= |before.frames| && prefix <= |after.frames|
  requires before.frames[..prefix] == after.frames[..prefix]
  requires forall i :: prefix <= i < |before.frames| ==> !before.frames[i].EventFrameKind? && !before.frames[i].CleanupFrameKind?
  requires forall i :: prefix <= i < |after.frames| ==>
    (!after.frames[i].EventFrameKind? && !after.frames[i].CleanupFrameKind? && validStackFrame(after, after.frames[i]))
  ensures alwaysFramesRetainNotices(after)
{
  forall f | f in after.frames ensures validStackFrame(after, f) {
    var i :| 0 <= i < |after.frames| && after.frames[i] == f;
    if i < prefix {
      assert before.frames[i] == f && f in before.frames && validStackFrame(before, f);
      if f.EventFrameKind? {
        TurnFrameRegistryCounts(before.frames, after.frames, prefix, (other: TurnFrame) => noticeFrameMatches(other, f.noticeId));
      } else if f.CleanupFrameKind? {
        TurnFrameRegistryCounts(before.frames, after.frames, prefix, (other: TurnFrame) => cleanupFrameMatches(other, f.turnId));
      } else if f.RoomScanKind? {
        TurnPendingOwnerMemberSequence(before, after, f.group);
      }
    }
  }
}

lemma TurnFrameFinishedGlobal(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canFinishGlobalAbort(s)
  ensures alwaysFramesRetainNotices(finishGlobalAbort(s))
{
  var after := finishGlobalAbort(s);
  TurnFrameNonRegistrySuffixValid(s, after, |after.frames|);
}

lemma TurnFrameReturnedNative(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canReturnNativeSignal(s)
  ensures alwaysFramesRetainNotices(returnNativeSignal(s))
{
  var after := returnNativeSignal(s);
  var prior := topFrame(s);
  var retained := topFrame(after);
  assert prior.RoomScanKind? && prior in s.frames && validStackFrame(s, prior);
  assert retained == RoomScanKind(prior.group, prior.room, prior.global, prior.scan.(notifying := 0));
  TurnPendingOwnerMemberSequence(s, after, prior.group);
  assert validStackFrame(after, retained);
  TurnFrameNonRegistrySuffixValid(s, after, |s.frames| - 1);
}

lemma TurnFrameReturnedRoom(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canReturnRoomAbort(s)
  ensures alwaysFramesRetainNotices(returnRoomAbort(s))
{
  var after := returnRoomAbort(s);
  var remainder := s.frames[..|s.frames| - 1];
  if after.frames == remainder {
    TurnFrameNonRegistrySuffixValid(s, after, |after.frames|);
  } else {
    var prefix := |s.frames| - 2;
    var prior := s.frames[prefix];
    var retained := after.frames[prefix];
    assert prior in s.frames && validStackFrame(s, prior) && prior.GlobalFrameKind?;
    assert retained.GlobalFrameKind? && retained.groups == prior.groups && retained.cursor == prior.cursor;
    assert validStackFrame(after, retained);
    TurnFrameNonRegistrySuffixValid(s, after, prefix);
  }
}

lemma TurnFrameAdvancedGlobal(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && alwaysGroupAllocatorValid(s) && canAdvanceGlobalAbort(s)
  ensures alwaysFramesRetainNotices(advanceGlobalAbort(s))
{
  var after := advanceGlobalAbort(s);
  var prior := topFrame(s);
  assert prior in s.frames && validStackFrame(s, prior);
  var groupId := prior.groups[prior.cursor];
  assert groupId in prior.groups;
  assert forall id :: id in prior.groups ==> (exists g :: g in s.groups && g.id == id);
  assert exists g :: g in s.groups && g.id == groupId;
  var group :| group in s.groups && group.id == groupId;
  TurnGroupAllocatorKnown(s, group);
  var byId := (g: RoomGroup) => (g.id == groupId);
  var matches := ProofLib.Filter(byId, s.groups);
  ProofLib.FilterMember(byId, s.groups, group);
  var chosen := matches[0];
  ProofLib.FilterMember(byId, s.groups, chosen);
  var retained := after.frames[|s.frames| - 1];
  var roomScan := topFrame(after);
  assert retained.GlobalFrameKind? && retained.groups == prior.groups && retained.cursor == prior.cursor + 1;
  assert roomScan.RoomScanKind? && roomScan.group == groupId && roomScan.room == chosen.room;
  assert validStackFrame(after, retained) && validStackFrame(after, roomScan);
  TurnFrameNonRegistrySuffixValid(s, after, |s.frames| - 1);
}

lemma TurnFrameActiveGroupIds(s: TurnEventStack)
  ensures forall id :: id in activeGroupIds(s) ==> (exists g :: g in s.groups && g.id == id)
{
  var active := ProofLib.Filter((g: RoomGroup) => g.active, s.groups);
  forall id | id in activeGroupIds(s) ensures (exists g :: g in s.groups && g.id == id) {
    var i :| 0 <= i < |activeGroupIds(s)| && activeGroupIds(s)[i] == id;
    var group := active[i];
    ProofLib.FilterMember((g: RoomGroup) => g.active, s.groups, group);
    assert group in s.groups && group.id == id;
  }
}

lemma TurnFrameBeganGlobalAbort(s: TurnEventStack, reason: string, close: bool)
  requires alwaysFramesRetainNotices(s)
  ensures alwaysFramesRetainNotices(beginGlobalAbort(s, reason, close))
{
  var after := beginGlobalAbort(s, reason, close);
  var added := GlobalFrameKind(activeGroupIds(s), 0, reason, []);
  TurnFrameActiveGroupIds(s);
  assert validStackFrame(after, added);
  TurnFrameNonRegistrySuffixValid(s, after, |s.frames|);
}

lemma TurnFrameRoomCapture(s: TurnEventStack, room: string)
  ensures validRoomCapture(s, liveGroup(s, room), room, false, false)
{
  var byRoom := (g: RoomGroup) => ((g.room == room) && g.active);
  var matches := ProofLib.Filter(byRoom, s.groups);
  if liveGroup(s, room) != 0 {
    assert |matches| > 0;
    var group := matches[0];
    ProofLib.FilterMember(byRoom, s.groups, group);
    assert group in s.groups && group.id == liveGroup(s, room) && group.room == room;
  }
}

lemma TurnFrameBeganRoomAbort(s: TurnEventStack, room: string, selfId: int, reason: string)
  requires alwaysFramesRetainNotices(s) && canAbortRoom(s, room, selfId, reason)
  ensures alwaysFramesRetainNotices(abortRoom(s, room, selfId, reason))
{
  var after := abortRoom(s, room, selfId, reason);
  var added := after.frames[|s.frames|];
  TurnFrameRoomCapture(s, room);
  assert validStackFrame(after, added);
  TurnFrameNonRegistrySuffixValid(s, after, |s.frames|);
}

lemma TurnFrameOtherNoticesPreserved(before: seq<core__turnControllers_TurnNotice>, after: seq<core__turnControllers_TurnNotice>, noticeId: int)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| && before[i].id != noticeId ==> after[i] == before[i]
  ensures forall n :: n in before && n.id != noticeId ==> n in after
{
  forall n | n in before && n.id != noticeId ensures n in after {
    var i :| 0 <= i < |before| && before[i] == n;
    assert after[i] == n;
  }
}

lemma TurnFrameEventIdBelowTop(s: TurnEventStack, i: int)
  requires alwaysFramesRetainNotices(s)
  requires 0 <= i < |s.frames| - 1 && s.frames[i].EventFrameKind?
  requires topFrame(s).EventFrameKind?
  ensures s.frames[i].noticeId != topFrame(s).noticeId
{
  var f := s.frames[i];
  var last := |s.frames| - 1;
  assert f in s.frames && validStackFrame(s, f);
  var byNotice := (other: TurnFrame) => noticeFrameMatches(other, f.noticeId);
  if f.noticeId == topFrame(s).noticeId {
    ProofLib.FilterTwo(byNotice, s.frames, i, last);
    assert false;
  }
}

lemma TurnFrameChangedEventPreservesLowerStack(s: TurnEventStack, after: TurnEventStack, suffix: seq<TurnFrame>)
  requires alwaysFramesRetainNotices(s) && |s.frames| > 0 && topFrame(s).EventFrameKind?
  requires |suffix| <= 1 && after.frames == s.frames[..|s.frames| - 1] + suffix
  requires forall replacement :: replacement in suffix ==>
    (replacement.EventFrameKind? && replacement.noticeId == topFrame(s).noticeId && validStackFrame(after, replacement))
  requires s.controllers.turns == after.controllers.turns && s.groups == after.groups && s.turnGroups == after.turnGroups
  requires forall n :: n in s.controllers.notices && n.id != topFrame(s).noticeId ==> n in after.controllers.notices
  ensures alwaysFramesRetainNotices(after)
{
  var prefix := s.frames[..|s.frames| - 1];
  var priorTop := topFrame(s);
  assert s.frames == prefix + [priorTop];
  forall f | f in after.frames ensures validStackFrame(after, f) {
    if f in prefix {
      var i :| 0 <= i < |prefix| && prefix[i] == f;
      assert f == s.frames[i] && f in s.frames && validStackFrame(s, f);
      if f.EventFrameKind? {
        TurnFrameEventIdBelowTop(s, i);
        var byNotice := (other: TurnFrame) => noticeFrameMatches(other, f.noticeId);
        assert !byNotice(priorTop);
        forall replacement | replacement in suffix ensures !byNotice(replacement) {
          assert replacement.EventFrameKind? && replacement.noticeId == priorTop.noticeId;
        }
        TurnFrameRegistryCounts(s.frames, after.frames, |prefix|, byNotice);
      } else if f.CleanupFrameKind? {
        var byTurn := (other: TurnFrame) => cleanupFrameMatches(other, f.turnId);
        assert !byTurn(priorTop);
        forall replacement | replacement in suffix ensures !byTurn(replacement) {
          assert replacement.EventFrameKind? && replacement.noticeId == priorTop.noticeId;
        }
        TurnFrameRegistryCounts(s.frames, after.frames, |prefix|, byTurn);
      } else if f.RoomScanKind? {
        TurnPendingOwnerMemberSequence(s, after, f.group);
      }
    } else {
      assert f in suffix;
    }
  }
}

lemma TurnFrameEventReplacementValid(s: TurnEventStack, after: TurnEventStack, replacement: TurnFrame)
  requires alwaysFramesRetainNotices(s) && |s.frames| > 0 && topFrame(s).EventFrameKind?
  requires replacement.EventFrameKind? && replacement.noticeId == topFrame(s).noticeId
  requires after.frames == s.frames[..|s.frames| - 1] + [replacement]
  requires exists n :: n in after.controllers.notices && n.id == replacement.noticeId && !n.finished
  requires replacement.invoking ==>
    (exists n :: n in after.controllers.notices && n.id == replacement.noticeId && n.cursor == replacement.listenerGeneration)
  ensures validStackFrame(after, replacement)
{
  var prior := topFrame(s);
  var prefix := s.frames[..|s.frames| - 1];
  assert prior in s.frames && validStackFrame(s, prior);
  assert s.frames == prefix + [prior];
  var byNotice := (other: TurnFrame) => noticeFrameMatches(other, replacement.noticeId);
  ProofLib.FilterAppend(byNotice, prefix, prior);
  ProofLib.FilterAppend(byNotice, prefix, replacement);
}

lemma TurnFrameFinishedEvent(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canFinishEvent(s)
  ensures alwaysFramesRetainNotices(finishEvent(s))
{
  var after := finishEvent(s);
  TurnFrameOtherNoticesPreserved(s.controllers.notices, after.controllers.notices, currentEvent(s).noticeId);
  TurnFrameChangedEventPreservesLowerStack(s, after, []);
}

lemma TurnFrameBeganListener(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canBeginListener(s)
  ensures alwaysFramesRetainNotices(beginListener(s))
{
  var after := beginListener(s);
  var beforeTop := topFrame(s);
  var replacement := topFrame(after);
  assert beforeTop.EventFrameKind? && beforeTop in s.frames && validStackFrame(s, beforeTop);
  var n :| n in s.controllers.notices && n.id == beforeTop.noticeId && !n.finished;
  var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == n;
  var retained := after.controllers.notices[i];
  assert retained in after.controllers.notices && retained.id == replacement.noticeId && !retained.finished;
  assert retained.cursor == replacement.listenerGeneration;
  TurnFrameEventReplacementValid(s, after, replacement);
  TurnFrameOtherNoticesPreserved(s.controllers.notices, after.controllers.notices, currentEvent(s).noticeId);
  TurnFrameChangedEventPreservesLowerStack(s, after, [replacement]);
}

lemma TurnFrameEndedListener(s: TurnEventStack, ok: bool)
  requires alwaysFramesRetainNotices(s) && canEndListener(s, ok)
  ensures alwaysFramesRetainNotices(endListener(s, ok))
{
  var after := endListener(s, ok);
  var beforeTop := topFrame(s);
  var replacement := topFrame(after);
  assert beforeTop.EventFrameKind? && beforeTop in s.frames && validStackFrame(s, beforeTop);
  var n :| n in s.controllers.notices && n.id == beforeTop.noticeId && !n.finished;
  var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == n;
  var retained := after.controllers.notices[i];
  assert retained in after.controllers.notices && retained.id == replacement.noticeId && !retained.finished;
  TurnFrameEventReplacementValid(s, after, replacement);
  TurnFrameOtherNoticesPreserved(s.controllers.notices, after.controllers.notices, currentEvent(s).noticeId);
  TurnFrameChangedEventPreservesLowerStack(s, after, [replacement]);
}

lemma TurnFrameAppendEvent(before: TurnEventStack, after: TurnEventStack, id: int)
  requires alwaysFramesRetainNotices(before)
  requires before.controllers.notices == after.controllers.notices && before.controllers.turns == after.controllers.turns
  requires before.groups == after.groups && before.turnGroups == after.turnGroups
  requires after.frames == before.frames + [EventFrameKind(id, false, 0)]
  requires id > 0 && (exists n :: n in after.controllers.notices && n.id == id && !n.finished)
  requires forall f :: f in before.frames ==> !noticeFrameMatches(f, id)
  ensures alwaysFramesRetainNotices(after)
{
  var added := EventFrameKind(id, false, 0);
  var byId := (other: TurnFrame) => noticeFrameMatches(other, added.noticeId);
  ProofLib.FilterNone(byId, before.frames);
  ProofLib.FilterAppend(byId, before.frames, added);
  assert validStackFrame(after, added);
  forall f | f in after.frames ensures validStackFrame(after, f) {
    if f != added {
      assert f in before.frames && validStackFrame(before, f);
      if f.EventFrameKind? {
        assert f.noticeId != id;
        ProofLib.FilterAppend((other: TurnFrame) => noticeFrameMatches(other, f.noticeId), before.frames, added);
      } else if f.CleanupFrameKind? {
        ProofLib.FilterAppend((other: TurnFrame) => cleanupFrameMatches(other, f.turnId), before.frames, added);
      } else if f.RoomScanKind? {
        TurnPendingOwnerMemberSequence(before, after, f.group);
      }
    }
  }
}

lemma TurnFrameReturnCreatesCleanup(s: TurnEventStack, after: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysControllerIdentitiesValid(s) && canReturnTurn(s, turnId, resolved, errorId)
  requires after == returnTurn(s, turnId, resolved, errorId)
  ensures exists t :: t in after.controllers.turns && t.id == turnId && t.phase.TurnReturned?
  ensures turnId > 0
{
  var byId := (t: core__turnControllers_TurnEntry) => (t.id == turnId);
  var matches := ProofLib.Filter(byId, s.controllers.turns);
  assert |matches| > 0;
  var prior := matches[0];
  ProofLib.FilterMember(byId, s.controllers.turns, prior);
  var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == prior;
  var current := after.controllers.turns[i];
  assert prior.id > 0 && current in after.controllers.turns && current.id == turnId && current.phase.TurnReturned?;
}

lemma TurnFrameReturnedTurn(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysControllerIdentitiesValid(s) && canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysFramesRetainNotices(returnTurn(s, turnId, resolved, errorId))
{
  var after := returnTurn(s, turnId, resolved, errorId);
  var cleanup := CleanupFrameKind(turnId);
  var staged := after.(frames := [cleanup]);
  TurnFrameReturnCreatesCleanup(s, after, turnId, resolved, errorId);
  ProofLib.FilterOne((other: TurnFrame) => cleanupFrameMatches(other, cleanup.turnId), staged.frames, 0);
  assert validStackFrame(staged, cleanup) && alwaysFramesRetainNotices(staged);
  var notice := after.controllers.notices[|s.controllers.notices|];
  assert notice in after.controllers.notices && notice.id == s.controllers.nextNotice && !notice.finished;
  TurnFrameAppendEvent(staged, after, notice.id);
}

lemma TurnFrameNextNoticeAvoidsExisting(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && alwaysControllerIdentitiesValid(s)
  ensures forall f :: f in s.frames ==> !noticeFrameMatches(f, s.controllers.nextNotice)
{
  forall f | f in s.frames && f.EventFrameKind? ensures !noticeFrameMatches(f, s.controllers.nextNotice) {
    assert validStackFrame(s, f);
    var n :| n in s.controllers.notices && n.id == f.noticeId && !n.finished;
    TurnControllerNoticeKnown(s.controllers, n);
  }
}

lemma TurnFrameFinishedRoomBeforeNotice(s: TurnEventStack, after: TurnEventStack, prior: TurnFrame)
  requires alwaysFramesRetainNotices(s) && canFinishRoomSignal(s)
  requires after == finishRoomSignal(s) && prior == topFrame(s) && prior.RoomScanKind?
  ensures alwaysFramesRetainNotices(after.(frames := s.frames[..|s.frames| - 1] +
    [RoomAbortReturnKind(prior.group, prior.room, prior.global, prior.scan.changed)]))
{
  var returned := RoomAbortReturnKind(prior.group, prior.room, prior.global, prior.scan.changed);
  var frames := s.frames[..|s.frames| - 1] + [returned];
  var staged := s.(frames := frames);
  var attached := after.(frames := frames);
  assert prior in s.frames && validStackFrame(s, prior);
  assert validStackFrame(staged, returned);
  TurnFrameNonRegistrySuffixValid(s, staged, |s.frames| - 1);
  TurnFrameSnapshotValid(staged, attached);
}

lemma TurnFrameFinishedRoom(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && alwaysControllerIdentitiesValid(s) && canFinishRoomSignal(s)
  ensures alwaysFramesRetainNotices(finishRoomSignal(s))
{
  var after := finishRoomSignal(s);
  var prior := topFrame(s);
  assert prior.RoomScanKind?;
  var returned := RoomAbortReturnKind(prior.group, prior.room, prior.global, prior.scan.changed);
  var frames := s.frames[..|s.frames| - 1] + [returned];
  var staged := after.(frames := frames);
  TurnFrameFinishedRoomBeforeNotice(s, after, prior);
  if after.frames != frames {
    var notice := after.controllers.notices[|s.controllers.notices|];
    assert notice in after.controllers.notices && notice.id == s.controllers.nextNotice && !notice.finished;
    TurnFrameNextNoticeAvoidsExisting(s);
    forall f | f in frames ensures !noticeFrameMatches(f, notice.id) {
      if f.EventFrameKind? {
        assert f in s.frames;
      }
    }
    TurnFrameAppendEvent(staged, after, notice.id);
  }
}

lemma TurnFrameRoomProjectionExtended(before: TurnEventStack, after: TurnEventStack, f: TurnFrame)
  requires f.RoomScanKind? && validStackFrame(before, f)
  requires forall g :: g in before.groups ==> g in after.groups
  requires |roomGroupMembers(before, f.group)| <= |roomGroupMembers(after, f.group)|
  requires roomGroupMembers(after, f.group)[..|roomGroupMembers(before, f.group)|] == roomGroupMembers(before, f.group)
  ensures validStackFrame(after, f)
{
  var room := RoomScan(f.group, f.room, f.global, f.scan);
  var prior := scanProjection(before, room);
  var current := scanProjection(after, room);
  assert prior.frames == [f.scan] && current.frames == [f.scan];
  assert |prior.turns| <= |current.turns|;
  assert current.turns[..|prior.turns|] == prior.turns by {
    forall i | 0 <= i < |prior.turns| ensures prior.turns[i] == current.turns[i] {
      assert roomGroupMembers(before, f.group)[i] == roomGroupMembers(after, f.group)[i];
    }
  }
  assert validRoomCapture(after, f.group, f.room, f.global, f.scan.changed);
  if f.scan.notifying != 0 {
    var notified :| notified in prior.turns && notified.turnId == f.scan.notifying &&
      notified.aborted && notified.reason == f.scan.reason;
    assert notified in current.turns;
  }
}

lemma TurnFrameStartedBeforeNotice(s: TurnEventStack, after: TurnEventStack, turnId: int, room: string)
  requires alwaysFramesRetainNotices(s) && alwaysTurnsRetainGroups(s) && canStartTurn(s, turnId, room)
  requires after == startTurn(s, turnId, room)
  ensures alwaysFramesRetainNotices(after.(frames := s.frames))
{
  var staged := after.(frames := s.frames);
  TurnLiveGroupsStartMembershipIsFresh(s, turnId, room);
  forall g | g in s.groups ensures g in staged.groups {}
  forall f | f in staged.frames ensures validStackFrame(staged, f) {
    assert f in s.frames && validStackFrame(s, f);
    if f.RoomScanKind? {
      TurnPendingOwnerStartedMembershipPrefix(s, after, turnId, room, f.group);
      TurnPendingOwnerMemberSequence(after, staged, f.group);
      TurnFrameRoomProjectionExtended(s, staged, f);
    }
  }
}

lemma TurnFrameStartedTurn(s: TurnEventStack, turnId: int, room: string)
  requires alwaysFramesRetainNotices(s) && alwaysControllerIdentitiesValid(s) && alwaysTurnsRetainGroups(s)
  requires canStartTurn(s, turnId, room)
  ensures alwaysFramesRetainNotices(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var staged := after.(frames := s.frames);
  TurnFrameStartedBeforeNotice(s, after, turnId, room);
  TurnFrameNextNoticeAvoidsExisting(s);
  var notice := after.controllers.notices[|s.controllers.notices|];
  assert notice in after.controllers.notices && notice.id == s.controllers.nextNotice && !notice.finished;
  TurnFrameAppendEvent(staged, after, notice.id);
}

lemma TurnFrameVisitMembership(s: TurnEventStack, after: TurnEventStack, group: int)
  requires after == visitRoomSignal(s)
  ensures |roomGroupMembers(s, group)| == |roomGroupMembers(after, group)|
  ensures forall i :: 0 <= i < |roomGroupMembers(s, group)| ==>
    (var t := roomGroupMembers(s, group)[i];
     var scan := currentRoomScan(after).scan;
     roomGroupMembers(after, group)[i] ==
       (if scan.notifying != 0 && t.id == scan.notifying && !t.aborted
        then t.(aborted := true, reason := scan.reason) else t))
{
  var beforeMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0));
  var afterMember := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0));
  var scan := currentRoomScan(after).scan;
  var sameVisit := (prior: core__turnControllers_TurnEntry, current: core__turnControllers_TurnEntry) =>
    (current == (if scan.notifying != 0 && prior.id == scan.notifying && !prior.aborted
      then prior.(aborted := true, reason := scan.reason) else prior));
  forall i | 0 <= i < |s.controllers.turns|
    ensures beforeMember(s.controllers.turns[i]) == afterMember(after.controllers.turns[i])
    ensures sameVisit(s.controllers.turns[i], after.controllers.turns[i])
  {
    var prior := s.controllers.turns[i];
    var current := after.controllers.turns[i];
    assert groupOf(s, prior.id) == groupOf(after, current.id);
  }
  ProofLib.FilterPointwise(beforeMember, afterMember, sameVisit, s.controllers.turns, after.controllers.turns);
}

lemma TurnFrameVisitPreservesOlderScan(s: TurnEventStack, after: TurnEventStack, f: TurnFrame)
  requires after == visitRoomSignal(s) && f.RoomScanKind? && validStackFrame(s, f)
  ensures validStackFrame(after, f)
{
  TurnFrameVisitMembership(s, after, f.group);
  var scan := RoomScan(f.group, f.room, f.global, f.scan);
  var prior := scanProjection(s, scan);
  var current := scanProjection(after, scan);
  assert |prior.turns| == |current.turns|;
  if f.scan.notifying != 0 {
    var notified :| notified in prior.turns && notified.turnId == f.scan.notifying &&
      notified.aborted && notified.reason == f.scan.reason;
    var i :| 0 <= i < |prior.turns| && prior.turns[i] == notified;
    assert roomGroupMembers(s, f.group)[i].aborted;
    assert roomGroupMembers(s, f.group)[i] == roomGroupMembers(after, f.group)[i];
    assert notified == current.turns[i] && notified in current.turns;
  }
}

lemma TurnFrameVisitSelectsLiveRoom(s: TurnEventStack, f: TurnFrame)
  requires f == topFrame(s) && f.RoomScanKind? && validStackFrame(s, f)
  requires canVisitRoomSignal(s)
  ensures f.group > 0
{
  if f.group <= 0 {
    var group := f.group;
    var belongs := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0));
    ProofLib.FilterNone(belongs, s.controllers.turns);
    assert |roomGroupMembers(s, group)| == 0;
    assert false;
  }
}

lemma TurnFrameVisitUpdatesTop(s: TurnEventStack, after: TurnEventStack)
  requires after == visitRoomSignal(s) && canVisitRoomSignal(s) && alwaysFramesRetainNotices(s)
  ensures validStackFrame(after, topFrame(after))
{
  var prior := topFrame(s);
  var current := topFrame(after);
  assert prior.RoomScanKind? && prior in s.frames && validStackFrame(s, prior);
  assert current.RoomScanKind? && current.group == prior.group && current.room == prior.room && current.global == prior.global;
  assert current.scan.cursor == prior.scan.cursor + 1;
  TurnFrameVisitSelectsLiveRoom(s, prior);
  TurnFrameVisitMembership(s, after, prior.group);
  assert validRoomCapture(after, current.group, current.room, current.global, current.scan.changed);
  if current.scan.notifying != 0 {
    var k := prior.scan.cursor;
    var selected := roomGroupMembers(s, prior.group)[k];
    assert selected.id == current.scan.notifying && !selected.aborted && current.scan.changed;
    var updated := roomGroupMembers(after, current.group)[k];
    assert updated.id == selected.id && updated.aborted && updated.reason == current.scan.reason;
    var projection := scanProjection(after, currentRoomScan(after));
    var delivered := projection.turns[k];
    assert delivered in projection.turns && delivered.turnId == current.scan.notifying &&
      delivered.aborted && delivered.reason == current.scan.reason;
  }
}

lemma TurnFrameVisitedRoom(s: TurnEventStack)
  requires alwaysFramesRetainNotices(s) && canVisitRoomSignal(s)
  ensures alwaysFramesRetainNotices(visitRoomSignal(s))
{
  var after := visitRoomSignal(s);
  var prior := topFrame(s);
  var updated := topFrame(after);
  var prefix := s.frames[..|s.frames| - 1];
  assert prior.RoomScanKind? && updated.RoomScanKind? && s.frames == prefix + [prior];
  assert after.frames == prefix + [updated];
  TurnFrameVisitUpdatesTop(s, after);
  forall f | f in after.frames ensures validStackFrame(after, f) {
    if f != updated {
      assert f in prefix && f in s.frames && validStackFrame(s, f);
      if f.EventFrameKind? {
        var byNotice := (other: TurnFrame) => noticeFrameMatches(other, f.noticeId);
        ProofLib.FilterAppend(byNotice, prefix, prior);
        ProofLib.FilterAppend(byNotice, prefix, updated);
      } else if f.CleanupFrameKind? {
        var byTurn := (other: TurnFrame) => cleanupFrameMatches(other, f.turnId);
        ProofLib.FilterAppend(byTurn, prefix, prior);
        ProofLib.FilterAppend(byTurn, prefix, updated);
        var t :| t in s.controllers.turns && t.id == f.turnId && t.phase.TurnReturned?;
        var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == t;
        var retained := after.controllers.turns[i];
        assert retained in after.controllers.turns && retained.id == f.turnId && retained.phase.TurnReturned?;
      } else if f.RoomScanKind? {
        TurnFrameVisitPreservesOlderScan(s, after, f);
      }
    }
  }
}

lemma TurnPendingAdvanceIncludesFreshScan(s: TurnEventStack, t: core__turnControllers_TurnEntry, f: TurnFrame)
  requires t in s.controllers.turns && !t.phase.TurnDetached?
  requires f.RoomScanKind? && f.global && f.group == groupOf(s, t.id) && f.group > 0 && f.scan.cursor == 0
  ensures frameOwnsPendingTurn(s, f, t.id, f.group)
{
  var group := f.group;
  var belongs := (t: core__turnControllers_TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0));
  ProofLib.FilterMember(belongs, s.controllers.turns, t);
  var ids := (var s_map := roomGroupMembers(s, group);
    seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
  var i :| 0 <= i < |roomGroupMembers(s, group)| && roomGroupMembers(s, group)[i] == t;
  assert ids[i] == t.id;
  TurnPendingOwnerSuffixWitness(ids, 0, t.id);
  assert groupInSuffix(ids, 0, t.id);
}

lemma TurnPendingAdvanceSelectedGroup(s: TurnEventStack, after: TurnEventStack, t: core__turnControllers_TurnEntry)
  requires after == advanceGlobalAbort(s) && canAdvanceGlobalAbort(s)
  requires t in s.controllers.turns && !t.phase.TurnDetached?
  requires validStackFrame(s, topFrame(s)) && alwaysGroupAllocatorValid(s)
  requires 0 <= topFrame(s).cursor < |topFrame(s).groups|
  requires topFrame(s).groups[topFrame(s).cursor] == groupOf(s, t.id)
  ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
{
  var owner := topFrame(s);
  var group := groupOf(s, t.id);
  assert group in owner.groups;
  assert forall id :: id in owner.groups ==> (exists g :: g in s.groups && g.id == id);
  assert exists g :: g in s.groups && g.id == group;
  var captured :| captured in s.groups && captured.id == group;
  TurnGroupAllocatorKnown(s, captured);
  var scan := topFrame(after);
  assert scan in after.frames && scan.RoomScanKind? && scan.group == group;
  TurnPendingAdvanceIncludesFreshScan(after, t, scan);
}

lemma TurnPendingAdvanceTop(s: TurnEventStack, after: TurnEventStack, t: core__turnControllers_TurnEntry)
  requires after == advanceGlobalAbort(s) && canAdvanceGlobalAbort(s)
  requires t in s.controllers.turns && !t.phase.TurnDetached?
  requires alwaysFramesRetainNotices(s) && alwaysGroupAllocatorValid(s)
  requires frameOwnsPendingTurn(s, topFrame(s), t.id, groupOf(s, t.id))
  ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
{
  var owner := topFrame(s);
  var group := groupOf(s, t.id);
  assert group == groupOf(after, t.id) && owner in s.frames && validStackFrame(s, owner);
  TurnPendingOwnerSuffixWitness(owner.groups, owner.cursor, group);
  var i :| 0 <= i < |owner.groups| && owner.cursor <= i && owner.groups[i] == group;
  if owner.cursor < i {
    var retained := after.frames[|s.frames| - 1];
    assert retained in after.frames && retained.GlobalFrameKind?;
    assert retained.groups == owner.groups && retained.cursor == owner.cursor + 1;
    TurnPendingOwnerSuffixWitness(retained.groups, retained.cursor, group);
    assert frameOwnsPendingTurn(after, retained, t.id, group);
  } else {
    assert i == owner.cursor;
    TurnPendingAdvanceSelectedGroup(s, after, t);
  }
}

lemma TurnPendingAdvanceWitness(s: TurnEventStack, after: TurnEventStack, t: core__turnControllers_TurnEntry)
  requires after == advanceGlobalAbort(s) && canAdvanceGlobalAbort(s)
  requires alwaysClosedPendingHasGlobalOwner(s) && alwaysFramesRetainNotices(s) && alwaysGroupAllocatorValid(s)
  requires after.controllers.closed && t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
  ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
{
  var group := groupOf(s, t.id);
  assert group == groupOf(after, t.id);
  var owner :| owner in s.frames && frameOwnsPendingTurn(s, owner, t.id, group);
  var i :| 0 <= i < |s.frames| && s.frames[i] == owner;
  if i == |s.frames| - 1 {
    assert owner == topFrame(s);
    TurnPendingAdvanceTop(s, after, t);
  } else {
    assert owner == after.frames[i] && owner in after.frames;
    TurnPendingOwnerEquivalentFrame(s, after, owner, owner, t.id, group);
  }
}

lemma TurnPendingAdvanceRetainsOwnership(s: TurnEventStack)
  requires alwaysClosedPendingHasGlobalOwner(s) && canAdvanceGlobalAbort(s)
  requires alwaysFramesRetainNotices(s) && alwaysGroupAllocatorValid(s)
  ensures alwaysClosedPendingHasGlobalOwner(advanceGlobalAbort(s))
{
  var after := advanceGlobalAbort(s);
  if after.controllers.closed {
    forall t | t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
      ensures (exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id)))
    {
      TurnPendingAdvanceWitness(s, after, t);
    }
  }
}

lemma TurnRetainedControllerRoom(s: TurnEventStack, turn: core__turnControllers_TurnEntry)
  requires alwaysTurnsRetainGroups(s) && turn in s.controllers.turns
  ensures (exists g :: g in s.groups && g.id == groupOf(s, turn.id) && g.room == turn.room)
{
  reveal alwaysTurnsRetainGroups();
}

lemma TurnActiveGroupAppearsInCapture(s: TurnEventStack, group: RoomGroup)
  requires group in s.groups && group.active
  ensures group.id in activeGroupIds(s)
{
  reveal activeGroupIds();
  var isActive := (g: RoomGroup) => g.active;
  var active := ProofLib.Filter(isActive, s.groups);
  ProofLib.FilterMember(isActive, s.groups, group);
  var i :| 0 <= i < |active| && active[i] == group;
  assert activeGroupIds(s)[i] == group.id;
}

lemma TurnNewGlobalFrameCoversCapturedGroup(s: TurnEventStack, frames: seq<TurnFrame>,
                                          groups: seq<int>, reason: string, turnId: int, groupId: int)
  requires groupId in groups && GlobalFrameKind(groups, 0, reason, []) in frames
  ensures (exists f :: f in frames && frameOwnsPendingTurn(s, f, turnId, groupId))
{
  var owner := GlobalFrameKind(groups, 0, reason, []);
  var i :| 0 <= i < |groups| && groups[i] == groupId;
  TurnPendingOwnerSuffixWitness(groups, 0, groupId);
  reveal frameOwnsPendingTurn();
  assert frameOwnsPendingTurn(s, owner, turnId, groupId);
}

lemma TurnRetainedRoomWitness(s: TurnEventStack, turn: core__turnControllers_TurnEntry) returns (group: RoomGroup)
  requires alwaysTurnsRetainGroups(s) && turn in s.controllers.turns
  ensures group in s.groups && group.id == groupOf(s, turn.id) && group.room == turn.room
{
  hide *;
  TurnRetainedControllerRoom(s, turn);
  group :| group in s.groups && group.id == groupOf(s, turn.id) && group.room == turn.room;
}

lemma TurnAttachedOwnerMakesGroupActive(s: TurnEventStack, group: RoomGroup, turn: core__turnControllers_TurnEntry)
  requires alwaysLiveGroupOwnsTurns(s) && group in s.groups
  requires turn in s.controllers.turns && !turn.phase.TurnDetached? && groupOf(s, turn.id) == group.id
  ensures group.active
{
  hide *;
  TurnLiveGroupKnown(s, group);
  assert (exists owned :: owned in s.controllers.turns && !owned.phase.TurnDetached? && groupOf(s, owned.id) == group.id);
}

lemma TurnAttachedGroupAppearsInCapture(s: TurnEventStack, turn: core__turnControllers_TurnEntry)
  requires alwaysTurnsRetainGroups(s) && alwaysLiveGroupOwnsTurns(s)
  requires turn in s.controllers.turns && !turn.phase.TurnDetached?
  ensures groupOf(s, turn.id) in activeGroupIds(s)
{
  hide *;
  var group := TurnRetainedRoomWitness(s, turn);
  TurnAttachedOwnerMakesGroupActive(s, group, turn);
  TurnActiveGroupAppearsInCapture(s, group);
}

lemma TurnGlobalAbortIncludesPendingTurn(s: TurnEventStack, after: TurnEventStack, reason: string,
                                        turn: core__turnControllers_TurnEntry)
  requires s.controllers.turns == after.controllers.turns && s.turnGroups == after.turnGroups
  requires turn in after.controllers.turns && !turn.phase.TurnDetached?
  requires groupOf(s, turn.id) in activeGroupIds(s)
  requires GlobalFrameKind(activeGroupIds(s), 0, reason, []) in after.frames
  ensures (exists frame :: frame in after.frames && frameOwnsPendingTurn(after, frame, turn.id, groupOf(after, turn.id)))
{
  hide *;
  TurnLiveGroupLookupProjection(s, turn.id);
  TurnLiveGroupLookupProjection(after, turn.id);
  assert groupOf(after, turn.id) == groupOf(s, turn.id);
  TurnNewGlobalFrameCoversCapturedGroup(after, after.frames, activeGroupIds(s), reason, turn.id, groupOf(after, turn.id));
}

lemma TurnGlobalAbortKeepsAllocatorAndPendingOwners(s: TurnEventStack, reason: string, close: bool)
  requires alwaysGroupAllocatorValid(s) && alwaysTurnsRetainGroups(s) && alwaysLiveGroupOwnsTurns(s)
  ensures alwaysGroupAllocatorValid(beginGlobalAbort(s, reason, close))
  ensures alwaysClosedPendingHasGlobalOwner(beginGlobalAbort(s, reason, close))
{
  hide *;
  reveal alwaysGroupAllocatorValid(), alwaysClosedPendingHasGlobalOwner();
  reveal beginGlobalAbort();
  var after := beginGlobalAbort(s, reason, close);
  assert after.groups == s.groups && after.nextGroup == s.nextGroup;
  assert after.turnGroups == s.turnGroups && after.controllers.turns == s.controllers.turns;
  var owner := GlobalFrameKind(activeGroupIds(s), 0, reason, []);
  assert after.frames == s.frames + [owner] && owner in after.frames;
  forall turn | turn in after.controllers.turns && !turn.phase.TurnDetached? && !turn.aborted
    ensures (exists frame :: frame in after.frames && frameOwnsPendingTurn(after, frame, turn.id, groupOf(after, turn.id)))
  {
    TurnAttachedGroupAppearsInCapture(s, turn);
    TurnGlobalAbortIncludesPendingTurn(s, after, reason, turn);
  }
}

lemma TurnLinkHasRetainedRoom(s: TurnEventStack, link: TurnGroup)
  requires alwaysTurnsRetainGroups(s) && link in s.turnGroups
  ensures |ProofLib.Filter((other: TurnGroup) => (other.turnId == link.turnId), s.turnGroups)| == 1
  ensures (
    exists t :: t in s.controllers.turns && t.id == link.turnId &&
      (exists g :: g in s.groups && g.id == link.group && g.room == t.room)
  )
{
  hide *;
  reveal ProofLib.Filter();
  reveal alwaysTurnsRetainGroups();
}

lemma TurnRoomWitnessMapped(before: seq<RoomGroup>, after: seq<RoomGroup>, id: int, room: string)
  requires |before| == |after|
  requires forall i {:trigger before[i]} | 0 <= i < |before| ::
    before[i].id == after[i].id && before[i].room == after[i].room
  requires (exists g :: g in before && g.id == id && g.room == room)
  ensures (exists g :: g in after && g.id == id && g.room == room)
{
  var g :| g in before && g.id == id && g.room == room;
  var i :| 0 <= i < |before| && before[i] == g;
  assert after[i] in after && after[i].id == id && after[i].room == room;
}

lemma TurnLinkRoomWitnessMapped(before: seq<core__turnControllers_TurnEntry>,
                              after: seq<core__turnControllers_TurnEntry>,
                              oldGroups: seq<RoomGroup>, newGroups: seq<RoomGroup>, link: TurnGroup)
  requires |before| == |after| && |oldGroups| == |newGroups|
  requires forall i {:trigger before[i]} | 0 <= i < |before| ::
    before[i].id == after[i].id && before[i].room == after[i].room
  requires forall i {:trigger oldGroups[i]} | 0 <= i < |oldGroups| ::
    oldGroups[i].id == newGroups[i].id && oldGroups[i].room == newGroups[i].room
  requires (
    exists t :: t in before && t.id == link.turnId &&
      (exists g :: g in oldGroups && g.id == link.group && g.room == t.room)
  )
  ensures (
    exists t :: t in after && t.id == link.turnId &&
      (exists g :: g in newGroups && g.id == link.group && g.room == t.room)
  )
{
  var t :| t in before && t.id == link.turnId &&
    (exists g :: g in oldGroups && g.id == link.group && g.room == t.room);
  var i :| 0 <= i < |before| && before[i] == t;
  assert after[i] in after && after[i].id == t.id && after[i].room == t.room;
  TurnRoomWitnessMapped(oldGroups, newGroups, link.group, t.room);
}

lemma TurnEntryHadLinkAndRoom(s: TurnEventStack, t: core__turnControllers_TurnEntry)
  requires alwaysTurnsRetainGroups(s) && t in s.controllers.turns
  ensures (exists link :: link in s.turnGroups && link.turnId == t.id)
  ensures (exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room)
{
  hide *;
  reveal alwaysTurnsRetainGroups();
}

lemma TurnLinkWitnessIndices(s: TurnEventStack, link: TurnGroup) returns (turnIndex: int, groupIndex: int)
  requires alwaysTurnsRetainGroups(s) && link in s.turnGroups
  ensures 0 <= turnIndex < |s.controllers.turns| && 0 <= groupIndex < |s.groups|
  ensures s.controllers.turns[turnIndex].id == link.turnId && s.groups[groupIndex].id == link.group
  ensures s.groups[groupIndex].room == s.controllers.turns[turnIndex].room
{
  hide *;
  TurnLinkHasRetainedRoom(s, link);
  var turn :| turn in s.controllers.turns && turn.id == link.turnId &&
    (exists group :: group in s.groups && group.id == link.group && group.room == turn.room);
  var group :| group in s.groups && group.id == link.group && group.room == turn.room;
  turnIndex :| 0 <= turnIndex < |s.controllers.turns| && s.controllers.turns[turnIndex] == turn;
  groupIndex :| 0 <= groupIndex < |s.groups| && s.groups[groupIndex] == group;
}

lemma TurnMappedLinkHasRoom(s: TurnEventStack, link: TurnGroup, turnIndex: int, groupIndex: int)
  requires 0 <= turnIndex < |s.controllers.turns| && 0 <= groupIndex < |s.groups|
  requires s.controllers.turns[turnIndex].id == link.turnId && s.groups[groupIndex].id == link.group
  requires s.groups[groupIndex].room == s.controllers.turns[turnIndex].room
  ensures (
    exists turn :: turn in s.controllers.turns && turn.id == link.turnId &&
      (exists group :: group in s.groups && group.id == link.group && group.room == turn.room)
  )
{
  hide *;
  assert s.controllers.turns[turnIndex] in s.controllers.turns;
  assert s.groups[groupIndex] in s.groups;
}

lemma TurnMappedLinkKeepsWitness(before: TurnEventStack, after: TurnEventStack, link: TurnGroup)
  requires alwaysTurnsRetainGroups(before) && link in before.turnGroups
  requires before.turnGroups == after.turnGroups
  requires |before.controllers.turns| == |after.controllers.turns| && |before.groups| == |after.groups|
  requires forall i {:trigger before.controllers.turns[i]} | 0 <= i < |before.controllers.turns| ::
    before.controllers.turns[i].id == after.controllers.turns[i].id &&
    before.controllers.turns[i].room == after.controllers.turns[i].room
  requires forall i {:trigger before.groups[i]} | 0 <= i < |before.groups| ::
    before.groups[i].id == after.groups[i].id && before.groups[i].room == after.groups[i].room
  ensures |ProofLib.Filter((g: TurnGroup) => g.turnId == link.turnId, after.turnGroups)| == 1
  ensures (
    exists turn :: turn in after.controllers.turns && turn.id == link.turnId &&
      (exists group :: group in after.groups && group.id == link.group && group.room == turn.room)
  )
{
  hide *;
  TurnLinkHasRetainedRoom(before, link);
  var i, j := TurnLinkWitnessIndices(before, link);
  assert before.controllers.turns[i].id == after.controllers.turns[i].id;
  assert before.controllers.turns[i].room == after.controllers.turns[i].room;
  assert before.groups[j].id == after.groups[j].id && before.groups[j].room == after.groups[j].room;
  TurnMappedLinkHasRoom(after, link, i, j);
}

lemma TurnMappedEntryKeepsRoom(before: TurnEventStack, after: TurnEventStack, i: int)
  requires alwaysTurnsRetainGroups(before) && 0 <= i < |before.controllers.turns|
  requires before.turnGroups == after.turnGroups &&
    |before.controllers.turns| == |after.controllers.turns| && |before.groups| == |after.groups|
  requires before.controllers.turns[i].id == after.controllers.turns[i].id &&
    before.controllers.turns[i].room == after.controllers.turns[i].room
  requires forall j {:trigger before.groups[j]} | 0 <= j < |before.groups| ::
    before.groups[j].id == after.groups[j].id && before.groups[j].room == after.groups[j].room
  ensures var turn := after.controllers.turns[i];
    (exists link :: link in after.turnGroups && link.turnId == turn.id) &&
    (exists group :: group in after.groups && group.id == groupOf(after, turn.id) && group.room == turn.room)
{
  hide *;
  var prior := before.controllers.turns[i];
  var next := after.controllers.turns[i];
  assert prior in before.controllers.turns;
  TurnEntryHadLinkAndRoom(before, prior);
  TurnLiveGroupLookupProjection(before, prior.id);
  TurnLiveGroupLookupProjection(after, next.id);
  assert groupOf(after, next.id) == groupOf(before, prior.id);
  TurnRoomWitnessMapped(before.groups, after.groups, groupOf(before, prior.id), prior.room);
}

lemma TurnMembershipRoomFieldsPreserved(before: TurnEventStack, after: TurnEventStack)
  requires alwaysTurnsRetainGroups(before)
  requires before.turnGroups == after.turnGroups &&
    |before.controllers.turns| == |after.controllers.turns| && |before.groups| == |after.groups|
  requires forall i {:trigger before.controllers.turns[i]} | 0 <= i < |before.controllers.turns| ::
    before.controllers.turns[i].id == after.controllers.turns[i].id &&
    before.controllers.turns[i].room == after.controllers.turns[i].room
  requires forall i {:trigger before.groups[i]} | 0 <= i < |before.groups| ::
    before.groups[i].id == after.groups[i].id && before.groups[i].room == after.groups[i].room
  ensures alwaysTurnsRetainGroups(after)
{
  hide *;
  reveal alwaysTurnsRetainGroups(), ProofLib.Filter();
  forall link | link in after.turnGroups
    ensures |ProofLib.Filter((g: TurnGroup) => g.turnId == link.turnId, after.turnGroups)| == 1
    ensures (
      exists turn :: turn in after.controllers.turns && turn.id == link.turnId &&
        (exists group :: group in after.groups && group.id == link.group && group.room == turn.room)
    )
  {
    TurnMappedLinkKeepsWitness(before, after, link);
  }
  forall turn | turn in after.controllers.turns
    ensures (exists link :: link in after.turnGroups && link.turnId == turn.id)
    ensures (exists group :: group in after.groups && group.id == groupOf(after, turn.id) && group.room == turn.room)
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == turn;
    TurnMappedEntryKeepsRoom(before, after, i);
  }
}

lemma TurnKeepsGroupsAfterReturn(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires alwaysTurnsRetainGroups(s)
  ensures alwaysTurnsRetainGroups(returnTurn(s, turnId, resolved, errorId))
{
  hide *;
  reveal returnTurn(), core__turnControllers_returnTurn();
  TurnMembershipRoomFieldsPreserved(s, returnTurn(s, turnId, resolved, errorId));
}

lemma TurnKeepsGroupsAfterCleanup(s: TurnEventStack, turnId: int)
  requires alwaysTurnsRetainGroups(s)
  ensures alwaysTurnsRetainGroups(cleanupTurn(s, turnId))
{
  hide *;
  reveal cleanupTurn(), core__turnControllers_cleanupTurn();
  TurnMembershipRoomFieldsPreserved(s, cleanupTurn(s, turnId));
}

lemma TurnKeepsGroupsAfterSignalVisit(s: TurnEventStack)
  requires alwaysTurnsRetainGroups(s)
  ensures alwaysTurnsRetainGroups(visitRoomSignal(s))
{
  hide *;
  reveal visitRoomSignal();
  TurnMembershipRoomFieldsPreserved(s, visitRoomSignal(s));
}

lemma TurnStartLinksHaveRooms(before: TurnEventStack, after: TurnEventStack, addedLink: TurnGroup,
                             addedTurn: core__turnControllers_TurnEntry, attached: RoomGroup)
  requires alwaysTurnsRetainGroups(before)
  requires after.turnGroups == before.turnGroups + [addedLink]
  requires after.controllers.turns == before.controllers.turns + [addedTurn]
  requires forall link :: link in before.turnGroups ==> link.turnId != addedLink.turnId
  requires forall group :: group in before.groups ==> group in after.groups
  requires attached in after.groups && attached.id == addedLink.group
  requires addedTurn.id == addedLink.turnId && attached.room == addedTurn.room
  ensures forall link | link in after.turnGroups ::
    |ProofLib.Filter((other: TurnGroup) => other.turnId == link.turnId, after.turnGroups)| == 1 &&
    (exists turn :: turn in after.controllers.turns && turn.id == link.turnId &&
      (exists group :: group in after.groups && group.id == link.group && group.room == turn.room))
{
  hide *;
  reveal ProofLib.Filter();
  forall link | link in after.turnGroups
    ensures |ProofLib.Filter((other: TurnGroup) => other.turnId == link.turnId, after.turnGroups)| == 1
    ensures (
      exists turn :: turn in after.controllers.turns && turn.id == link.turnId &&
        (exists group :: group in after.groups && group.id == link.group && group.room == turn.room)
    )
  {
    var matchesLink := (other: TurnGroup) => other.turnId == link.turnId;
    ProofLib.FilterAppend(matchesLink, before.turnGroups, addedLink);
    if link == addedLink {
      ProofLib.FilterNone(matchesLink, before.turnGroups);
      assert addedTurn in after.controllers.turns;
    } else {
      assert link in before.turnGroups && link.turnId != addedLink.turnId;
      TurnLinkHasRetainedRoom(before, link);
      var prior :| prior in before.controllers.turns && prior.id == link.turnId &&
        (exists group :: group in before.groups && group.id == link.group && group.room == prior.room);
      var group :| group in before.groups && group.id == link.group && group.room == prior.room;
      assert prior in after.controllers.turns && group in after.groups;
    }
  }
}

lemma TurnStartEntriesHaveLinks(before: TurnEventStack, after: TurnEventStack, addedLink: TurnGroup,
                                addedTurn: core__turnControllers_TurnEntry, attached: RoomGroup)
  requires alwaysTurnsRetainGroups(before)
  requires after.turnGroups == before.turnGroups + [addedLink]
  requires after.controllers.turns == before.controllers.turns + [addedTurn]
  requires forall link :: link in before.turnGroups ==> link.turnId != addedLink.turnId
  requires forall turn :: turn in before.controllers.turns ==> turn.id != addedLink.turnId
  requires forall group :: group in before.groups ==> group in after.groups
  requires attached in after.groups && attached.id == addedLink.group
  requires addedTurn.id == addedLink.turnId && attached.room == addedTurn.room
  ensures forall turn | turn in after.controllers.turns ::
    (exists link :: link in after.turnGroups && link.turnId == turn.id) &&
    (exists group :: group in after.groups && group.id == groupOf(after, turn.id) && group.room == turn.room)
{
  hide *;
  forall turn | turn in after.controllers.turns
    ensures (exists link :: link in after.turnGroups && link.turnId == turn.id)
    ensures (exists group :: group in after.groups && group.id == groupOf(after, turn.id) && group.room == turn.room)
  {
    TurnLiveGroupLookupAfterAppend(before, after, addedLink, turn.id);
    if turn == addedTurn {
      assert addedLink in after.turnGroups;
    } else {
      assert turn in before.controllers.turns && turn.id != addedLink.turnId;
      TurnEntryHadLinkAndRoom(before, turn);
      var priorLink :| priorLink in before.turnGroups && priorLink.turnId == turn.id;
      var priorGroup :| priorGroup in before.groups && priorGroup.id == groupOf(before, turn.id) && priorGroup.room == turn.room;
      assert priorLink in after.turnGroups && priorGroup in after.groups;
    }
  }
}

lemma TurnStartRoomAttachment(s: TurnEventStack, turnId: int, room: string)
    returns (link: TurnGroup, attached: RoomGroup)
  ensures startTurn(s, turnId, room).turnGroups == s.turnGroups + [link]
  ensures link.turnId == turnId && attached.id == link.group && attached.room == room
  ensures attached in startTurn(s, turnId, room).groups
  ensures forall group :: group in s.groups ==> group in startTurn(s, turnId, room).groups
{
  hide *;
  reveal startTurn(), liveGroup(), ProofLib.Filter();
  var after := startTurn(s, turnId, room);
  var existing := liveGroup(s, room);
  if existing == 0 {
    attached := RoomGroup(s.nextGroup, room, true);
  } else {
    var activeInRoom := (group: RoomGroup) => group.room == room && group.active;
    var matches := ProofLib.Filter(activeInRoom, s.groups);
    assert |matches| > 0 && matches[0].id == existing;
    attached := matches[0];
    ProofLib.FilterMember(activeInRoom, s.groups, attached);
    assert attached in s.groups;
  }
  link := TurnGroup(turnId, attached.id);
  assert attached in after.groups;
}

lemma TurnStartAppendsFreshEntry(s: TurnEventStack, turnId: int, room: string)
    returns (added: core__turnControllers_TurnEntry)
  requires canStartTurn(s, turnId, room)
  ensures startTurn(s, turnId, room).controllers.turns == s.controllers.turns + [added]
  ensures added.id == turnId && added.room == room
  ensures forall t :: t in s.controllers.turns ==> t.id != turnId
{
  hide *;
  reveal startTurn(), core__turnControllers_startTurn(), canStartTurn(), core__turnControllers_canStartTurn();
  added := startTurn(s, turnId, room).controllers.turns[|s.controllers.turns|];
}

lemma TurnStartRetainsRoomMemberships(s: TurnEventStack, turnId: int, room: string)
  requires alwaysTurnsRetainGroups(s) && canStartTurn(s, turnId, room)
  ensures alwaysTurnsRetainGroups(startTurn(s, turnId, room))
{
  hide *;
  var after := startTurn(s, turnId, room);
  TurnLiveGroupsStartMembershipIsFresh(s, turnId, room);
  var link, attached := TurnStartRoomAttachment(s, turnId, room);
  var added := TurnStartAppendsFreshEntry(s, turnId, room);
  TurnStartLinksHaveRooms(s, after, link, added, attached);
  TurnStartEntriesHaveLinks(s, after, link, added, attached);
  reveal alwaysTurnsRetainGroups(), ProofLib.Filter();
}

lemma TurnAllocatorAfterGlobalAdvance(s: TurnEventStack)
  requires alwaysGroupAllocatorValid(s)
  ensures alwaysGroupAllocatorValid(advanceGlobalAbort(s))
{
  hide *;
  reveal alwaysGroupAllocatorValid(), advanceGlobalAbort();
}

lemma TurnReturnRetainsStructuralFrame(s: TurnEventStack, turnId: int, resolved: bool, errorId: string)
  requires canReturnTurn(s, turnId, resolved, errorId) && alwaysGroupAllocatorValid(s)
  ensures alwaysCleanupFrameAtBottom(returnTurn(s, turnId, resolved, errorId))
  ensures alwaysGroupAllocatorValid(returnTurn(s, turnId, resolved, errorId))
{
  hide *;
  reveal canReturnTurn(), returnTurn(), pushNotices(), alwaysCleanupFrameAtBottom(), alwaysGroupAllocatorValid();
}

lemma TurnStartRetainsCleanupFrame(s: TurnEventStack, turnId: int, room: string)
  requires alwaysCleanupFrameAtBottom(s)
  ensures alwaysCleanupFrameAtBottom(startTurn(s, turnId, room))
{
  hide *;
  reveal startTurn(), pushNotices(), alwaysCleanupFrameAtBottom();
  var after := startTurn(s, turnId, room);
  if |s.frames| > 0 && |after.frames| > |s.frames| {
    assert after.frames[1..] == s.frames[1..] + [EventFrameKind(s.controllers.nextNotice, false, 0)];
  }
}

lemma TurnStartKeepsFirstAbortReason(s: TurnEventStack, turnId: int, room: string)
  requires canStartTurn(s, turnId, room)
  ensures stepFirstRegistryAbortReasonStays(s, startTurn(s, turnId, room))
{
  hide *;
  var after := startTurn(s, turnId, room);
  var added := TurnStartAppendsFreshEntry(s, turnId, room);
  assert forall t | t in s.controllers.turns :: t in after.controllers.turns;
  reveal stepFirstRegistryAbortReasonStays(), core__turnControllers_stepFirstAbortReasonStays();
}
