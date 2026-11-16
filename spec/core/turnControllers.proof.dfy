lemma setTurnClock_ensures(s: Turns, now: int)
  ensures (inv(s) ==> alwaysActiveRoomsMatch(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysClosedPendingHasGlobalOwner(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysOneLiveListener(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysTurnIdentity(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysNoticesUnique(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysGroupAllocatorValid(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysTurnsRetainGroups(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysLiveGroupOwnsTurns(setTurnClock(s, now)))
  ensures (inv(s) ==> alwaysFramesRetainNotices(setTurnClock(s, now)))
  ensures (inv(s) ==> stepCleanupPreservesPeers(s, "setTurnClock", setTurnClock(s, now)))
  ensures (inv(s) ==> stepFirstAbortReasonStays(s, setTurnClock(s, now)))
  ensures (inv(s) ==> stepCloseIsPermanent(s, setTurnClock(s, now)))
  ensures (inv(s) ==> stepTelemetryCannotChangeResult(s, "setTurnClock", setTurnClock(s, now)))
{
  if inv(s) {
    var after := setTurnClock(s, now);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after); StackFrame(s, after);
    StepsFrame(s, "setTurnClock", after);
  }
}

lemma startTurn_ensures(s: Turns, turnId: int, room: string)
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysActiveRoomsMatch(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysClosedPendingHasGlobalOwner(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysOneLiveListener(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysTurnIdentity(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysNoticesUnique(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysGroupAllocatorValid(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysTurnsRetainGroups(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysLiveGroupOwnsTurns(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysFramesRetainNotices(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepCleanupPreservesPeers(s, "startTurn", startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepFirstAbortReasonStays(s, startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepCloseIsPermanent(s, startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepTelemetryCannotChangeResult(s, "startTurn", startTurn(s, turnId, room)))
{
  if inv(s) && canStartTurn(s, turnId, room) {
    var after := startTurn(s, turnId, room);
    var added := after.controllers.turns[|s.controllers.turns|];
    assert after.controllers.turns == s.controllers.turns + [added];
    AppendTurnIdentity(s, after, added);
    NoticeIdentityAppend(s, after, freshNotice(s.controllers.nextNotice, TurnNoticeKind.TurnStarted, room, "", "", 0));
    ListenersUnchangedFilters(s, after);
    StepsFrame(s, "startTurn", after);
    AbortAppend(s, after);
    TurnRoomFilters(s); TurnRoomFilters(after);
    forall candidate | candidate in after.controllers.rooms
      ensures |ProofLib.Filter((other: string) => (other == candidate), after.controllers.rooms)| == 1 && (exists t :: t in after.controllers.turns && t.room == candidate && !t.phase.TurnDetached?)
    {
      if room !in s.controllers.rooms {
        ProofLib.FilterAppend((other: string) => (other == candidate), s.controllers.rooms, room);
        if candidate == room { ProofLib.FilterNone((other: string) => (other == candidate), s.controllers.rooms); }
      }
      if candidate == room { assert added in after.controllers.turns; }
      else {
        assert candidate in s.controllers.rooms;
        var t :| t in s.controllers.turns && t.room == candidate && !t.phase.TurnDetached?;
        assert t in after.controllers.turns;
      }
    }
  }
}

lemma returnTurn_ensures(s: Turns, turnId: int, resolved: bool, errorId: string)
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysActiveRoomsMatch(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysClosedPendingHasGlobalOwner(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysOneLiveListener(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysTurnIdentity(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysNoticesUnique(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysGroupAllocatorValid(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysTurnsRetainGroups(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysLiveGroupOwnsTurns(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysFramesRetainNotices(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCleanupPreservesPeers(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepFirstAbortReasonStays(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCloseIsPermanent(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepTelemetryCannotChangeResult(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
{
  if inv(s) && canReturnTurn(s, turnId, resolved, errorId) {
    var after := returnTurn(s, turnId, resolved, errorId);
    LookupTurns(s, turnId);
    forall i | 0 <= i < |s.controllers.turns|
      ensures after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room && (after.controllers.turns[i].phase.TurnDetached? <==> s.controllers.turns[i].phase.TurnDetached?)
    {}
    TurnIdentityMap(s, after); TurnRoomMap(s, after); AbortMap(s, after);
    NoticeIdentityAppend(s, after, after.controllers.notices[|s.controllers.notices|]);
    ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); StepsFrame(s, "returnTurn", after);
  }
}

lemma cleanupTurn_ensures(s: Turns, turnId: int)
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysActiveRoomsMatch(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysClosedPendingHasGlobalOwner(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysOneLiveListener(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysTurnIdentity(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysNoticesUnique(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysGroupAllocatorValid(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysTurnsRetainGroups(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysLiveGroupOwnsTurns(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysFramesRetainNotices(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCleanupPreservesPeers(s, "cleanupTurn", cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepFirstAbortReasonStays(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCloseIsPermanent(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepTelemetryCannotChangeResult(s, "cleanupTurn", cleanupTurn(s, turnId)))
{
  if inv(s) && canCleanupTurn(s, turnId) {
    var after := cleanupTurn(s, turnId);
    TurnIdentityMap(s, after); AbortMap(s, after);
    CleanupActiveRooms(s, turnId);
    ListenersUnchangedFilters(s, after);
    NoticesFrame(s, after); StepsCleanup(s, after);
    forall prior | prior in s.controllers.turns
      ensures exists t :: t in after.controllers.turns && t.id == prior.id && t.aborted == prior.aborted && t.reason == prior.reason
    {
      var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == prior;
      assert after.controllers.turns[i] in after.controllers.turns;
    }
  }
}

lemma abortRoom_ensures(s: Turns, room: string, selfId: int, reason: string)
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysActiveRoomsMatch(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysClosedPendingHasGlobalOwner(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysOneLiveListener(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysTurnIdentity(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysNoticesUnique(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysGroupAllocatorValid(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysTurnsRetainGroups(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysLiveGroupOwnsTurns(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysFramesRetainNotices(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepCleanupPreservesPeers(s, "abortRoom", abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepFirstAbortReasonStays(s, abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepCloseIsPermanent(s, abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> stepTelemetryCannotChangeResult(s, "abortRoom", abortRoom(s, room, selfId, reason)))
{
  if inv(s) && canAbortRoom(s, room, selfId, reason) {
    var after := abortRoom(s, room, selfId, reason);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "abortRoom", after);
  }
}

lemma beginGlobalAbort_ensures(s: Turns, reason: string, close: bool)
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysActiveRoomsMatch(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysClosedPendingHasGlobalOwner(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysOneLiveListener(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysTurnIdentity(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysNoticesUnique(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysGroupAllocatorValid(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysTurnsRetainGroups(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysLiveGroupOwnsTurns(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysFramesRetainNotices(beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepCleanupPreservesPeers(s, "beginGlobalAbort", beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepFirstAbortReasonStays(s, beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepCloseIsPermanent(s, beginGlobalAbort(s, reason, close)))
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> stepTelemetryCannotChangeResult(s, "beginGlobalAbort", beginGlobalAbort(s, reason, close)))
{
  if inv(s) && canBeginGlobalAbort(s, reason, close) {
    var after := beginGlobalAbort(s, reason, close);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "beginGlobalAbort", after);
  }
}

lemma advanceGlobalAbort_ensures(s: Turns)
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysActiveRoomsMatch(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysClosedPendingHasGlobalOwner(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysOneLiveListener(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysTurnIdentity(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysNoticesUnique(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysGroupAllocatorValid(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysTurnsRetainGroups(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysLiveGroupOwnsTurns(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysFramesRetainNotices(advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepCleanupPreservesPeers(s, "advanceGlobalAbort", advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepFirstAbortReasonStays(s, advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepCloseIsPermanent(s, advanceGlobalAbort(s)))
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> stepTelemetryCannotChangeResult(s, "advanceGlobalAbort", advanceGlobalAbort(s)))
{
  if inv(s) && canAdvanceGlobalAbort(s) {
    var after := advanceGlobalAbort(s);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "advanceGlobalAbort", after);
  }
}

lemma finishGlobalAbort_ensures(s: Turns)
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysActiveRoomsMatch(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysClosedPendingHasGlobalOwner(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysOneLiveListener(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysTurnIdentity(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysNoticesUnique(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysGroupAllocatorValid(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysTurnsRetainGroups(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysLiveGroupOwnsTurns(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysFramesRetainNotices(finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepCleanupPreservesPeers(s, "finishGlobalAbort", finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepFirstAbortReasonStays(s, finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepCloseIsPermanent(s, finishGlobalAbort(s)))
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> stepTelemetryCannotChangeResult(s, "finishGlobalAbort", finishGlobalAbort(s)))
{
  if inv(s) && canFinishGlobalAbort(s) {
    var after := finishGlobalAbort(s);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "finishGlobalAbort", after);
  }
}

lemma visitRoomSignal_ensures(s: Turns)
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysActiveRoomsMatch(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysClosedPendingHasGlobalOwner(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysOneLiveListener(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysTurnIdentity(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysNoticesUnique(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysGroupAllocatorValid(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysTurnsRetainGroups(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysLiveGroupOwnsTurns(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysFramesRetainNotices(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepCleanupPreservesPeers(s, "visitRoomSignal", visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepFirstAbortReasonStays(s, visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepCloseIsPermanent(s, visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepTelemetryCannotChangeResult(s, "visitRoomSignal", visitRoomSignal(s)))
{
  if inv(s) && canVisitRoomSignal(s) {
    var after := visitRoomSignal(s);
    var r := currentRoomScan(s);
    var target := roomGroupMembers(s, r.group)[r.scan.cursor];
    var eligible := target.id > 0 && !target.aborted && target.id != r.scan.excluded;
    MembersInTurns(s, r.group);
    assert target in s.controllers.turns;
    assert |after.controllers.turns| == |s.controllers.turns|;
    forall i | 0 <= i < |s.controllers.turns|
      ensures after.controllers.turns[i] == (if eligible && s.controllers.turns[i].id == target.id then s.controllers.turns[i].(aborted := true, reason := r.scan.reason) else s.controllers.turns[i])
    {}
    forall i | 0 <= i < |s.controllers.turns|
      ensures after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room && (after.controllers.turns[i].phase.TurnDetached? <==> s.controllers.turns[i].phase.TurnDetached?)
      ensures s.controllers.turns[i].aborted ==> after.controllers.turns[i].aborted && s.controllers.turns[i].reason == after.controllers.turns[i].reason
    {
      if s.controllers.turns[i].id == target.id {
        assert s.controllers.turns[i] in s.controllers.turns;
        SameTurnId(s, s.controllers.turns[i], target);
      }
    }
    assert after.controllers.rooms == s.controllers.rooms;
    TurnIdentityMap(s, after); TurnRoomMap(s, after); AbortMap(s, after);
    ListenersUnchangedFilters(s, after);
    assert after.controllers.notices == s.controllers.notices && after.controllers.nextNotice == s.controllers.nextNotice;
    NoticesFrame(s, after);
    assert after.groups == s.groups && after.turnGroups == s.turnGroups && after.nextGroup == s.nextGroup;
    GroupFrame(s, after);
    assert after.controllers.closed == s.controllers.closed;
    StepsVisit(s, after);
  }
}

lemma returnNativeSignal_ensures(s: Turns)
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysActiveRoomsMatch(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysClosedPendingHasGlobalOwner(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysOneLiveListener(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysTurnIdentity(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysNoticesUnique(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysGroupAllocatorValid(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysTurnsRetainGroups(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysLiveGroupOwnsTurns(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysFramesRetainNotices(returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepCleanupPreservesPeers(s, "returnNativeSignal", returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepFirstAbortReasonStays(s, returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepCloseIsPermanent(s, returnNativeSignal(s)))
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> stepTelemetryCannotChangeResult(s, "returnNativeSignal", returnNativeSignal(s)))
{
  if inv(s) && canReturnNativeSignal(s) {
    var after := returnNativeSignal(s);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "returnNativeSignal", after);
  }
}

lemma finishRoomSignal_ensures(s: Turns)
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysActiveRoomsMatch(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysClosedPendingHasGlobalOwner(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysOneLiveListener(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysTurnIdentity(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysNoticesUnique(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysGroupAllocatorValid(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysTurnsRetainGroups(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysLiveGroupOwnsTurns(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysFramesRetainNotices(finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepCleanupPreservesPeers(s, "finishRoomSignal", finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepFirstAbortReasonStays(s, finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepCloseIsPermanent(s, finishRoomSignal(s)))
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> stepTelemetryCannotChangeResult(s, "finishRoomSignal", finishRoomSignal(s)))
{
  if inv(s) && canFinishRoomSignal(s) {
    var after := finishRoomSignal(s);
    var r := currentRoomScan(s);
    if r.scan.changed {
      NoticeIdentityAppend(s, after, freshNotice(s.controllers.nextNotice, TurnNoticeKind.TurnAborted, r.room, r.scan.reason, "", 0));
    }
    ListenersUnchangedFilters(s, after);
    TurnsFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StepsFrame(s, "finishRoomSignal", after);
    if !r.scan.changed { NoticesFrame(s, after); }
  }
}

lemma returnRoomAbort_ensures(s: Turns)
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysActiveRoomsMatch(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysClosedPendingHasGlobalOwner(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysOneLiveListener(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysTurnIdentity(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysNoticesUnique(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysGroupAllocatorValid(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysTurnsRetainGroups(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysLiveGroupOwnsTurns(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysFramesRetainNotices(returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepCleanupPreservesPeers(s, "returnRoomAbort", returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepFirstAbortReasonStays(s, returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepCloseIsPermanent(s, returnRoomAbort(s)))
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> stepTelemetryCannotChangeResult(s, "returnRoomAbort", returnRoomAbort(s)))
{
  if inv(s) && canReturnRoomAbort(s) {
    var after := returnRoomAbort(s);
    TurnsFrame(s, after); NoticesFrame(s, after); ListenersUnchangedFilters(s, after);
    GroupFrame(s, after); RetainSame(s, after);
    StepsFrame(s, "returnRoomAbort", after);
  }
}

lemma subscribe_ensures(s: Turns, callback: int)
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysActiveRoomsMatch(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysClosedPendingHasGlobalOwner(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysOneLiveListener(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysTurnIdentity(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysNoticesUnique(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysGroupAllocatorValid(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysTurnsRetainGroups(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysLiveGroupOwnsTurns(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysFramesRetainNotices(subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepCleanupPreservesPeers(s, "subscribe", subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepFirstAbortReasonStays(s, subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepCloseIsPermanent(s, subscribe(s, callback)))
  ensures (inv(s) ==> canSubscribe(s, callback) ==> stepTelemetryCannotChangeResult(s, "subscribe", subscribe(s, callback)))
{
  if inv(s) && canSubscribe(s, callback) {
    var after := subscribe(s, callback);
    TurnsFrame(s, after); NoticesFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StackFrame(s, after); StepsFrame(s, "subscribe", after);
    if !(exists l :: l in s.controllers.listeners && l.callback == callback && l.present) {
      var added := TurnListener(callback, s.controllers.nextListener, true);
      TurnListenerFilters(s); TurnListenerFilters(after);
      forall l | l in after.controllers.listeners && l.present
        ensures |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), after.controllers.listeners)| == 1
      {
        ProofLib.FilterAppend((other: TurnListener) => ((other.callback == l.callback) && other.present), s.controllers.listeners, added);
        if l.callback == callback { ProofLib.FilterNone((other: TurnListener) => ((other.callback == l.callback) && other.present), s.controllers.listeners); }
        else { assert l in s.controllers.listeners; }
      }
    } else {
      ListenersUnchangedFilters(s, after);
    }
  }
}

lemma unsubscribe_ensures(s: Turns, callback: int)
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysActiveRoomsMatch(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysClosedPendingHasGlobalOwner(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysOneLiveListener(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysTurnIdentity(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysNoticesUnique(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysGroupAllocatorValid(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysTurnsRetainGroups(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysLiveGroupOwnsTurns(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysFramesRetainNotices(unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepCleanupPreservesPeers(s, "unsubscribe", unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepFirstAbortReasonStays(s, unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepCloseIsPermanent(s, unsubscribe(s, callback)))
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> stepTelemetryCannotChangeResult(s, "unsubscribe", unsubscribe(s, callback)))
{
  if inv(s) && canUnsubscribe(s, callback) {
    var after := unsubscribe(s, callback);
    TurnsFrame(s, after); NoticesFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StackFrame(s, after); StepsFrame(s, "unsubscribe", after);
    TurnListenerFilters(s); TurnListenerFilters(after);
    forall l | l in after.controllers.listeners && l.present
      ensures |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), after.controllers.listeners)| == 1
    {
      var i :| 0 <= i < |after.controllers.listeners| && after.controllers.listeners[i] == l;
      assert l.callback != callback && s.controllers.listeners[i] == l;
      assert l in s.controllers.listeners;
      ProofLib.FilterLengthPointwise((other: TurnListener) => ((other.callback == l.callback) && other.present), (other: TurnListener) => ((other.callback == l.callback) && other.present), s.controllers.listeners, after.controllers.listeners);
    }
  }
}

lemma beginListener_ensures(s: Turns)
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysActiveRoomsMatch(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysClosedPendingHasGlobalOwner(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysOneLiveListener(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysTurnIdentity(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysNoticesUnique(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysGroupAllocatorValid(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysTurnsRetainGroups(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysLiveGroupOwnsTurns(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysFramesRetainNotices(beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepCleanupPreservesPeers(s, "beginListener", beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepFirstAbortReasonStays(s, beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepCloseIsPermanent(s, beginListener(s)))
  ensures (inv(s) ==> canBeginListener(s) ==> stepTelemetryCannotChangeResult(s, "beginListener", beginListener(s)))
{
  if inv(s) && canBeginListener(s) {
    var after := beginListener(s);
    var noticeId := currentEvent(s).noticeId;
    LookupNoticeCursor(s, noticeId);
    forall i | 0 <= i < |s.controllers.notices|
      ensures forall generation :: generation in after.controllers.notices[i].delivered ==> generation <= after.controllers.notices[i].cursor
    { assert s.controllers.notices[i] in s.controllers.notices; }
    NoticeIdentityMap(s, after);
    ListenersUnchangedFilters(s, after);
    TurnsFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StepsFrame(s, "beginListener", after);
  }
}

lemma endListener_ensures(s: Turns, ok: bool)
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysActiveRoomsMatch(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysClosedPendingHasGlobalOwner(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysOneLiveListener(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysTurnIdentity(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysNoticesUnique(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysGroupAllocatorValid(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysTurnsRetainGroups(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysLiveGroupOwnsTurns(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysFramesRetainNotices(endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepCleanupPreservesPeers(s, "endListener", endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepFirstAbortReasonStays(s, endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepCloseIsPermanent(s, endListener(s, ok)))
  ensures (inv(s) ==> canEndListener(s, ok) ==> stepTelemetryCannotChangeResult(s, "endListener", endListener(s, ok)))
{
  if inv(s) && canEndListener(s, ok) {
    var after := endListener(s, ok);
    var frame := currentEvent(s);
    var top := s.frames[|s.frames| - 1];
    assert top in s.frames;
    assert validStackFrame(s, top);
    var n :| n in s.controllers.notices && n.id == frame.noticeId && n.cursor == frame.listenerGeneration;
    forall i | 0 <= i < |s.controllers.notices|
      ensures forall generation :: generation in after.controllers.notices[i].delivered ==> generation <= after.controllers.notices[i].cursor
    {
      assert s.controllers.notices[i] in s.controllers.notices;
      if s.controllers.notices[i].id == frame.noticeId { SameNoticeId(s, s.controllers.notices[i], n); }
    }
    NoticeIdentityMap(s, after);
    ListenersUnchangedFilters(s, after);
    TurnsFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StepsFrame(s, "endListener", after);
  }
}

lemma finishEvent_ensures(s: Turns)
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysActiveRoomsMatch(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysClosedPendingHasGlobalOwner(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysOneLiveListener(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysTurnIdentity(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysNoticesUnique(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysGroupAllocatorValid(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysTurnsRetainGroups(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysLiveGroupOwnsTurns(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysFramesRetainNotices(finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepCleanupPreservesPeers(s, "finishEvent", finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepFirstAbortReasonStays(s, finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepCloseIsPermanent(s, finishEvent(s)))
  ensures (inv(s) ==> canFinishEvent(s) ==> stepTelemetryCannotChangeResult(s, "finishEvent", finishEvent(s)))
{
  if inv(s) && canFinishEvent(s) {
    var after := finishEvent(s);
    forall i | 0 <= i < |s.controllers.notices|
      ensures forall generation :: generation in after.controllers.notices[i].delivered ==> generation <= after.controllers.notices[i].cursor
    { assert s.controllers.notices[i] in s.controllers.notices; }
    NoticeIdentityMap(s, after);
    ListenersUnchangedFilters(s, after);
    TurnsFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StepsFrame(s, "finishEvent", after);
  }
}

lemma TurnIdentityFilters(s: Turns)
  ensures alwaysTurnIdentity(s) == (forall t :: t in s.controllers.turns ==> t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), s.controllers.turns)| == 1)
{}

lemma TurnRoomFilters(s: Turns)
  ensures alwaysActiveRoomsMatch(s) == ((forall room :: room in s.controllers.rooms ==> |ProofLib.Filter((other: string) => (other == room), s.controllers.rooms)| == 1 && (exists t :: t in s.controllers.turns && t.room == room && !t.phase.TurnDetached?)) && (forall t :: t in s.controllers.turns && !t.phase.TurnDetached? ==> t.room in s.controllers.rooms))
{}

lemma TurnNoticeFilters(s: Turns)
  ensures alwaysNoticesUnique(s) == (s.controllers.nextNotice > 0 && (forall n :: n in s.controllers.notices ==> n.id > 0 && n.id < s.controllers.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), s.controllers.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)))
{}

lemma TurnListenerFilters(s: Turns)
  ensures alwaysOneLiveListener(s) == (forall l :: l in s.controllers.listeners && l.present ==> |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), s.controllers.listeners)| == 1)
{}

lemma TurnIdentityMap(before: Turns, after: Turns)
  requires alwaysTurnIdentity(before)
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==> before.controllers.turns[i].id == after.controllers.turns[i].id
  ensures alwaysTurnIdentity(after)
{
  TurnIdentityFilters(before); TurnIdentityFilters(after);
  forall t | t in after.controllers.turns
    ensures t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), after.controllers.turns)| == 1
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
    assert before.controllers.turns[i] in before.controllers.turns;
    ProofLib.FilterLengthPointwise((other: TurnEntry) => (other.id == t.id), (other: TurnEntry) => (other.id == t.id), before.controllers.turns, after.controllers.turns);
  }
}

lemma TurnRoomMap(before: Turns, after: Turns)
  requires alwaysActiveRoomsMatch(before)
  requires before.controllers.rooms == after.controllers.rooms
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==> before.controllers.turns[i].room == after.controllers.turns[i].room && (before.controllers.turns[i].phase.TurnDetached? <==> after.controllers.turns[i].phase.TurnDetached?)
  ensures alwaysActiveRoomsMatch(after)
{
  TurnRoomFilters(before); TurnRoomFilters(after);
  forall room | room in after.controllers.rooms
    ensures exists t :: t in after.controllers.turns && t.room == room && !t.phase.TurnDetached?
  {
    var t :| t in before.controllers.turns && t.room == room && !t.phase.TurnDetached?;
    var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
    assert after.controllers.turns[i] in after.controllers.turns;
  }
  forall t | t in after.controllers.turns && !t.phase.TurnDetached? ensures t.room in after.controllers.rooms
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
    assert before.controllers.turns[i] in before.controllers.turns;
  }
}

lemma AbortMap(before: Turns, after: Turns)
  requires |before.controllers.turns| == |after.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==> before.controllers.turns[i].id == after.controllers.turns[i].id && (before.controllers.turns[i].aborted ==> after.controllers.turns[i].aborted && before.controllers.turns[i].reason == after.controllers.turns[i].reason)
  ensures stepFirstAbortReasonStays(before, after)
{
  forall t | t in before.controllers.turns && t.aborted
    ensures exists other :: other in after.controllers.turns && other.id == t.id && other.aborted && other.reason == t.reason
  {
    var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
    assert after.controllers.turns[i] in after.controllers.turns;
  }
}

lemma NoticeIdentityAppend(before: Turns, after: Turns, added: TurnNotice)
  requires alwaysNoticesUnique(before)
  requires added.id == before.controllers.nextNotice
  requires forall generation :: generation in added.delivered ==> generation <= added.cursor
  requires after.controllers.notices == before.controllers.notices + [added] && after.controllers.nextNotice == before.controllers.nextNotice + 1
  ensures alwaysNoticesUnique(after)
{
  TurnNoticeFilters(before); TurnNoticeFilters(after);
  forall n | n in after.controllers.notices
    ensures n.id > 0 && n.id < after.controllers.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), after.controllers.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)
  {
    ProofLib.FilterAppend((other: TurnNotice) => (other.id == n.id), before.controllers.notices, added);
    if n.id == added.id { ProofLib.FilterNone((other: TurnNotice) => (other.id == n.id), before.controllers.notices); }
    else { assert n in before.controllers.notices; }
  }
}

lemma NoticeIdentityMap(before: Turns, after: Turns)
  requires alwaysNoticesUnique(before)
  requires before.controllers.nextNotice == after.controllers.nextNotice
  requires |before.controllers.notices| == |after.controllers.notices|
  requires forall i :: 0 <= i < |before.controllers.notices| ==> before.controllers.notices[i].id == after.controllers.notices[i].id && (forall generation :: generation in after.controllers.notices[i].delivered ==> generation <= after.controllers.notices[i].cursor)
  ensures alwaysNoticesUnique(after)
{
  TurnNoticeFilters(before); TurnNoticeFilters(after);
  forall n | n in after.controllers.notices
    ensures n.id > 0 && n.id < after.controllers.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), after.controllers.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)
  {
    var i :| 0 <= i < |after.controllers.notices| && after.controllers.notices[i] == n;
    assert before.controllers.notices[i] in before.controllers.notices;
    ProofLib.FilterLengthPointwise((other: TurnNotice) => (other.id == n.id), (other: TurnNotice) => (other.id == n.id), before.controllers.notices, after.controllers.notices);
  }
}

lemma TurnLookup(c: TurnControllers, turnId: int)
  ensures controller(c, turnId) == (var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), c.turns); if |matches| > 0 then matches[0] else noTurn)
{}

lemma LookupTurns(s: Turns, turnId: int)
  requires alwaysTurnIdentity(s)
  ensures controller(s.controllers, turnId).id > 0 ==> controller(s.controllers, turnId) in s.controllers.turns && controller(s.controllers, turnId).id == turnId
  ensures forall t :: t in s.controllers.turns && t.id == turnId ==> t == controller(s.controllers, turnId)
{
  TurnLookup(s.controllers, turnId); TurnIdentityFilters(s);
  var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.controllers.turns);
  if |matches| > 0 {
    var selected := matches[0];
    ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, selected);
    ProofLib.FilterSamePredicate((t: TurnEntry) => (t.id == turnId), (other: TurnEntry) => (other.id == selected.id), s.controllers.turns);
    assert |matches| == 1;
    forall t | t in s.controllers.turns && t.id == turnId ensures t == selected
    { ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, t); }
  } else {
    forall t | t in s.controllers.turns && t.id == turnId ensures t == controller(s.controllers, turnId)
    { ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, t); }
  }
}

lemma AppendTurnIdentity(s: Turns, after: Turns, added: TurnEntry)
  requires alwaysTurnIdentity(s)
  requires added.id > 0 && !(exists t :: t in s.controllers.turns && t.id == added.id)
  requires after.controllers.turns == s.controllers.turns + [added]
  ensures alwaysTurnIdentity(after)
{
  TurnIdentityFilters(s); TurnIdentityFilters(after);
  forall t | t in after.controllers.turns ensures t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), after.controllers.turns)| == 1
  {
    ProofLib.FilterAppend((other: TurnEntry) => (other.id == t.id), s.controllers.turns, added);
    if t.id == added.id { ProofLib.FilterNone((other: TurnEntry) => (other.id == t.id), s.controllers.turns); }
    else { assert t in s.controllers.turns; }
  }
}

lemma ListenersUnchangedFilters(before: Turns, after: Turns)
  requires alwaysOneLiveListener(before)
  requires after.controllers.listeners == before.controllers.listeners
  ensures alwaysOneLiveListener(after)
{
  TurnListenerFilters(before); TurnListenerFilters(after);
}

lemma CleanupRoomProjection(s: Turns, turnId: int)
  ensures cleanupTurn(s, turnId).controllers.rooms == (var room := controller(s.controllers, turnId).room; if (exists t :: t in s.controllers.turns && t.id != turnId && t.room == room && !t.phase.TurnDetached?) then s.controllers.rooms else ProofLib.Filter((r: string) => (r != room), s.controllers.rooms))
{}

lemma CleanupActiveRooms(s: Turns, turnId: int)
  requires alwaysTurnIdentity(s) && alwaysActiveRoomsMatch(s)
  ensures alwaysActiveRoomsMatch(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  var selected := controller(s.controllers, turnId);
  LookupTurns(s, turnId);
  CleanupRoomProjection(s, turnId);
  TurnRoomFilters(s); TurnRoomFilters(after);
  forall room | room in after.controllers.rooms
    ensures |ProofLib.Filter((other: string) => (other == room), after.controllers.rooms)| == 1 && (exists t :: t in after.controllers.turns && t.room == room && !t.phase.TurnDetached?)
  {
    if !(exists t :: t in s.controllers.turns && t.id != turnId && t.room == selected.room && !t.phase.TurnDetached?) {
      ProofLib.FilterMember((r: string) => (r != selected.room), s.controllers.rooms, room);
      ProofLib.FilterOfFilterShorter((r: string) => (r != selected.room), (other: string) => (other == room), s.controllers.rooms);
      ProofLib.FilterMember((other: string) => (other == room), after.controllers.rooms, room);
    }
    assert room in s.controllers.rooms;
    var t :| t in s.controllers.turns && t.id != turnId && t.room == room && !t.phase.TurnDetached?;
    var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == t;
    assert after.controllers.turns[i] in after.controllers.turns;
  }
  forall t | t in after.controllers.turns && !t.phase.TurnDetached?
    ensures t.room in after.controllers.rooms
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
    assert s.controllers.turns[i] == t && t.id != turnId && t in s.controllers.turns;
    if after.controllers.rooms != s.controllers.rooms { ProofLib.FilterMember((r: string) => (r != selected.room), s.controllers.rooms, t.room); }
  }
}

lemma MembersInTurns(s: Turns, group: int)
  ensures forall x :: x in roomGroupMembers(s, group) ==> x in s.controllers.turns && !x.phase.TurnDetached?
{
  forall x | x in roomGroupMembers(s, group)
    ensures x in s.controllers.turns && !x.phase.TurnDetached?
  {
    ProofLib.FilterMember((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0)), s.controllers.turns, x);
  }
}

lemma SameTurnId(s: Turns, a: TurnEntry, b: TurnEntry)
  requires alwaysTurnIdentity(s)
  requires a in s.controllers.turns && b in s.controllers.turns && a.id == b.id
  ensures a == b
{
  TurnIdentityFilters(s);
  var matches := ProofLib.Filter((other: TurnEntry) => (other.id == a.id), s.controllers.turns);
  ProofLib.FilterMember((other: TurnEntry) => (other.id == a.id), s.controllers.turns, a);
  ProofLib.FilterMember((other: TurnEntry) => (other.id == a.id), s.controllers.turns, b);
  assert |matches| == 1;
}

lemma SameNoticeId(s: Turns, a: TurnNotice, b: TurnNotice)
  requires alwaysNoticesUnique(s)
  requires a in s.controllers.notices && b in s.controllers.notices && a.id == b.id
  ensures a == b
{
  TurnNoticeFilters(s);
  var matches := ProofLib.Filter((other: TurnNotice) => (other.id == a.id), s.controllers.notices);
  ProofLib.FilterMember((other: TurnNotice) => (other.id == a.id), s.controllers.notices, a);
  ProofLib.FilterMember((other: TurnNotice) => (other.id == a.id), s.controllers.notices, b);
  assert |matches| == 1;
}

lemma TurnNoticeLookup(c: TurnControllers, noticeId: int)
  ensures notice(c, noticeId) == (var matches := ProofLib.Filter((n: TurnNotice) => (n.id == noticeId), c.notices); if |matches| > 0 then matches[0] else noNotice)
{}

lemma TurnListenerLookup(c: TurnControllers, noticeId: int)
  ensures nextTurnListener(c, noticeId) == (var local_41 := notice(c, noticeId); var matches := ProofLib.Filter((l: TurnListener) => (l.present && (l.generation > local_41.cursor)), c.listeners); if |matches| > 0 then matches[0] else TurnListener(0, 0, false))
{}

lemma LookupNoticeCursor(s: Turns, noticeId: int)
  requires alwaysNoticesUnique(s)
  requires nextTurnListener(s.controllers, noticeId).present
  ensures forall n :: n in s.controllers.notices && n.id == noticeId ==> nextTurnListener(s.controllers, noticeId).generation > n.cursor
{
  TurnNoticeLookup(s.controllers, noticeId); TurnListenerLookup(s.controllers, noticeId);
  var local_41 := notice(s.controllers, noticeId);
  var listeners := ProofLib.Filter((l: TurnListener) => (l.present && (l.generation > local_41.cursor)), s.controllers.listeners);
  assert |listeners| > 0;
  ProofLib.FilterMember((l: TurnListener) => (l.present && (l.generation > local_41.cursor)), s.controllers.listeners, listeners[0]);
  forall x | x in s.controllers.notices && x.id == noticeId ensures nextTurnListener(s.controllers, noticeId).generation > x.cursor
  {
    var matches := ProofLib.Filter((n: TurnNotice) => (n.id == noticeId), s.controllers.notices);
    ProofLib.FilterMember((n: TurnNotice) => (n.id == noticeId), s.controllers.notices, x);
    assert |matches| > 0;
    ProofLib.FilterMember((n: TurnNotice) => (n.id == noticeId), s.controllers.notices, matches[0]);
    SameNoticeId(s, x, matches[0]);
  }
}

lemma TurnsFrame(before: Turns, after: Turns)
  requires alwaysActiveRoomsMatch(before) && alwaysTurnIdentity(before)
  requires after.controllers.turns == before.controllers.turns && after.controllers.rooms == before.controllers.rooms
  ensures alwaysActiveRoomsMatch(after) && alwaysTurnIdentity(after) && stepFirstAbortReasonStays(before, after)
{
  TurnRoomFilters(before); TurnRoomFilters(after);
  TurnIdentityFilters(before); TurnIdentityFilters(after);
  AbortMap(before, after);
}

lemma NoticesFrame(before: Turns, after: Turns)
  requires alwaysNoticesUnique(before)
  requires after.controllers.notices == before.controllers.notices && after.controllers.nextNotice == before.controllers.nextNotice
  ensures alwaysNoticesUnique(after)
{
  TurnNoticeFilters(before); TurnNoticeFilters(after);
}

lemma StepsFrame(before: Turns, via: string, after: Turns)
  requires via != "cleanupTurn"
  requires before.controllers.closed ==> after.controllers.closed
  requires (via == "beginListener" || via == "endListener" || via == "finishEvent" || via == "subscribe" || via == "unsubscribe") ==> after.controllers.turns == before.controllers.turns
  ensures stepCleanupPreservesPeers(before, via, after) && stepCloseIsPermanent(before, after) && stepTelemetryCannotChangeResult(before, via, after)
{}

lemma GroupOfFrame(before: Turns, after: Turns)
  requires after.turnGroups == before.turnGroups
  ensures forall x :: groupOf(after, x) == groupOf(before, x)
{}

lemma GroupFrame(before: Turns, after: Turns)
  requires alwaysLiveGroupOwnsTurns(before) && alwaysGroupAllocatorValid(before)
  requires after.turnGroups == before.turnGroups && after.groups == before.groups && after.nextGroup == before.nextGroup
  requires |after.controllers.turns| == |before.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==> after.controllers.turns[i].id == before.controllers.turns[i].id && after.controllers.turns[i].room == before.controllers.turns[i].room && (after.controllers.turns[i].phase.TurnDetached? <==> before.controllers.turns[i].phase.TurnDetached?)
  ensures alwaysLiveGroupOwnsTurns(after) && alwaysGroupAllocatorValid(after)
{
  GroupOfFrame(before, after);
  GroupLiveFrame(before, after);
}

lemma RetainSame(before: Turns, after: Turns)
  requires after.controllers.turns == before.controllers.turns && after.turnGroups == before.turnGroups && after.groups == before.groups
  ensures alwaysTurnsRetainGroups(after) == alwaysTurnsRetainGroups(before)
{
  GroupOfFrame(before, after);
}

lemma GroupLiveFrame(before: Turns, after: Turns)
  requires alwaysLiveGroupOwnsTurns(before)
  requires after.groups == before.groups
  requires |after.controllers.turns| == |before.controllers.turns|
  requires forall i :: 0 <= i < |before.controllers.turns| ==> after.controllers.turns[i].id == before.controllers.turns[i].id && (after.controllers.turns[i].phase.TurnDetached? <==> before.controllers.turns[i].phase.TurnDetached?)
  requires forall x :: groupOf(after, x) == groupOf(before, x)
  ensures alwaysLiveGroupOwnsTurns(after)
{
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    if g.active {
      var t :| t in before.controllers.turns && !t.phase.TurnDetached? && groupOf(before, t.id) == g.id;
      var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
      assert after.controllers.turns[i] in after.controllers.turns;
    } else if exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id {
      var t :| t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id;
      var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
      assert before.controllers.turns[i] in before.controllers.turns;
    }
  }
}

lemma MembersAsFilter(s: Turns, group: int)
  ensures roomGroupMembers(s, group) == ProofLib.Filter((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0)), s.controllers.turns)
{}

lemma MembersFrame(before: Turns, after: Turns, group: int)
  requires after.controllers.turns == before.controllers.turns && after.turnGroups == before.turnGroups
  ensures roomGroupMembers(after, group) == roomGroupMembers(before, group)
{
  GroupOfFrame(before, after);
  MembersAsFilter(before, group); MembersAsFilter(after, group);
  ProofLib.FilterSamePredicate((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0)), (t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(before, t.id) == group)) && (group > 0)), before.controllers.turns);
}

lemma StackFrame(before: Turns, after: Turns)
  requires alwaysClosedPendingHasGlobalOwner(before) && alwaysFramesRetainNotices(before)
  requires after.controllers.turns == before.controllers.turns && after.controllers.notices == before.controllers.notices && after.controllers.closed == before.controllers.closed
  requires after.frames == before.frames && after.turnGroups == before.turnGroups
  ensures alwaysClosedPendingHasGlobalOwner(after) && alwaysFramesRetainNotices(after)
{
  GroupOfFrame(before, after);
  forall group ensures roomGroupMembers(after, group) == roomGroupMembers(before, group) { MembersFrame(before, after, group); }
  assert forall f, turnId, group :: frameOwnsPendingTurn(after, f, turnId, group) == frameOwnsPendingTurn(before, f, turnId, group);
  assert forall r :: validRoomScan(after, r) == validRoomScan(before, r);
  assert forall f :: validStackFrame(after, f) == validStackFrame(before, f);
}

lemma AbortAppend(before: Turns, after: Turns)
  requires |after.controllers.turns| == |before.controllers.turns| + 1
  requires after.controllers.turns[..|before.controllers.turns|] == before.controllers.turns
  ensures stepFirstAbortReasonStays(before, after)
{
  forall t | t in before.controllers.turns && t.aborted
    ensures exists other :: other in after.controllers.turns && other.id == t.id && other.aborted && other.reason == t.reason
  {
    var i :| 0 <= i < |before.controllers.turns| && before.controllers.turns[i] == t;
    assert after.controllers.turns[i] == t;
    assert after.controllers.turns[i] in after.controllers.turns;
  }
}

lemma StepsCleanup(before: Turns, after: Turns)
  requires after.controllers.closed == before.controllers.closed
  ensures stepCloseIsPermanent(before, after) && stepTelemetryCannotChangeResult(before, "cleanupTurn", after)
{}

lemma StepsVisit(before: Turns, after: Turns)
  requires after.controllers.closed == before.controllers.closed
  ensures stepCleanupPreservesPeers(before, "visitRoomSignal", after) && stepCloseIsPermanent(before, after) && stepTelemetryCannotChangeResult(before, "visitRoomSignal", after)
{}
