lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  Bottom(initial);
}

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
  ensures (inv(s) ==> alwaysCleanupAtBottom(setTurnClock(s, now)))
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
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysCleanupAtBottom(startTurn(s, turnId, room)))
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
    StartRooms(s, turnId, room);
    StartGroups(s, turnId, room);
    StartFrames(s, turnId, room);
    StartBottom(s, turnId, room);
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
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysCleanupAtBottom(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCleanupPreservesPeers(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepFirstAbortReasonStays(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCloseIsPermanent(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepTelemetryCannotChangeResult(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
{
  if inv(s) && canReturnTurn(s, turnId, resolved, errorId) {
    var after := returnTurn(s, turnId, resolved, errorId);
    ReturnTurnMapping(s, after, turnId, resolved, errorId);
    NoticeIdentityAppend(s, after, after.controllers.notices[|s.controllers.notices|]);
    ListenersUnchangedFilters(s, after);
    StepsFrame(s, "returnTurn", after);
    ReturnStack(s, turnId, resolved, errorId);
    ReturnClosed(s, turnId, resolved, errorId);
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
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysCleanupAtBottom(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCleanupPreservesPeers(s, "cleanupTurn", cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepFirstAbortReasonStays(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCloseIsPermanent(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepTelemetryCannotChangeResult(s, "cleanupTurn", cleanupTurn(s, turnId)))
{
  if inv(s) && canCleanupTurn(s, turnId) {
    CleanupBasics(s, turnId);
    CleanupActiveRooms(s, turnId);
    CleanupSteps(s, turnId);
    CleanupClosed(s, turnId);
    CleanupAllocator(s, turnId);
    CleanupLive(s, turnId);
    CleanupStack(s, turnId);
    CleanupRetain(s, turnId);
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
  ensures (inv(s) ==> canAbortRoom(s, room, selfId, reason) ==> alwaysCleanupAtBottom(abortRoom(s, room, selfId, reason)))
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
    AbortRoomStack(s, room, selfId, reason);
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
  ensures (inv(s) ==> canBeginGlobalAbort(s, reason, close) ==> alwaysCleanupAtBottom(beginGlobalAbort(s, reason, close)))
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
    BeginGlobalStack(s, reason, close);
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
  ensures (inv(s) ==> canAdvanceGlobalAbort(s) ==> alwaysCleanupAtBottom(advanceGlobalAbort(s)))
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
    PositiveGroups(s);
    AdvanceClosed(s); AdvanceFrames(s); AdvanceBottom(s);
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
  ensures (inv(s) ==> canFinishGlobalAbort(s) ==> alwaysCleanupAtBottom(finishGlobalAbort(s)))
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
    FinishGlobalStack(s);
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
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> alwaysCleanupAtBottom(visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepCleanupPreservesPeers(s, "visitRoomSignal", visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepFirstAbortReasonStays(s, visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepCloseIsPermanent(s, visitRoomSignal(s)))
  ensures (inv(s) ==> canVisitRoomSignal(s) ==> stepTelemetryCannotChangeResult(s, "visitRoomSignal", visitRoomSignal(s)))
{
  if inv(s) && canVisitRoomSignal(s) {
    VisitBasics(s);
    VisitRetain(s);
    VisitClosed(s);
    VisitFrames(s);
    VisitBottom(s);
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
  ensures (inv(s) ==> canReturnNativeSignal(s) ==> alwaysCleanupAtBottom(returnNativeSignal(s)))
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
    NativeClosed(s); NativeFrames(s); NativeBottom(s);
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
  ensures (inv(s) ==> canFinishRoomSignal(s) ==> alwaysCleanupAtBottom(finishRoomSignal(s)))
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
    } else {
      NoticesFrame(s, after);
    }
    ListenersUnchangedFilters(s, after);
    TurnsFrame(s, after); GroupFrame(s, after); RetainSame(s, after); StepsFrame(s, "finishRoomSignal", after);
    FinishRoomClosed(s); FinishRoomFrames(s); FinishRoomBottom(s);
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
  ensures (inv(s) ==> canReturnRoomAbort(s) ==> alwaysCleanupAtBottom(returnRoomAbort(s)))
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
    ReturnRoomClosed(s); ReturnRoomFrames(s); ReturnRoomBottom(s);
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
  ensures (inv(s) ==> canSubscribe(s, callback) ==> alwaysCleanupAtBottom(subscribe(s, callback)))
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
  ensures (inv(s) ==> canUnsubscribe(s, callback) ==> alwaysCleanupAtBottom(unsubscribe(s, callback)))
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
  ensures (inv(s) ==> canBeginListener(s) ==> alwaysCleanupAtBottom(beginListener(s)))
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
    TopKind(s);
    EventPopClosed(s, after, |s.frames| - 1);
    BeginListenerFrames(s);
    EventBottom(s, after, |s.frames| - 1);
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
  ensures (inv(s) ==> canEndListener(s, ok) ==> alwaysCleanupAtBottom(endListener(s, ok)))
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
    TopKind(s);
    EventPopClosed(s, after, |s.frames| - 1);
    EndListenerFrames(s, ok);
    EventBottom(s, after, |s.frames| - 1);
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
  ensures (inv(s) ==> canFinishEvent(s) ==> alwaysCleanupAtBottom(finishEvent(s)))
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
    TopKind(s);
    EventPopClosed(s, after, |s.frames| - 1);
    FinishEventFrames(s);
    EventBottom(s, after, |s.frames| - 1);
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
  requires after.frames == before.frames && after.turnGroups == before.turnGroups && after.groups == before.groups
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

lemma SuffixFold(xs: seq<int>, r: int, b: bool, group: int)
  ensures Std.Collections.Seq.FoldLeft((point: GlobalGroupCursor, id: int) => GlobalGroupCursor((point.remaining - 1), (point.retained || ((point.remaining <= 0) && (id == group)))), GlobalGroupCursor(r, b), xs).retained <==> b || exists i :: 0 <= i < |xs| && r <= i && xs[i] == group
  decreases |xs|
{
  if |xs| > 0 {
    SuffixFold(xs[1..], r - 1, b || (r <= 0 && xs[0] == group), group);
    assert forall i :: 0 < i < |xs| ==> xs[i] == xs[1..][i - 1];
    if exists j :: 0 <= j < |xs[1..]| && r - 1 <= j && xs[1..][j] == group {
      var j :| 0 <= j < |xs[1..]| && r - 1 <= j && xs[1..][j] == group;
      assert xs[j + 1] == group;
    }
  }
}

lemma InSuffix(groups: seq<int>, cursor: int, group: int)
  ensures groupInSuffix(groups, cursor, group) <==> exists i :: 0 <= i < |groups| && cursor <= i && groups[i] == group
{
  SuffixFold(groups, cursor, false, group);
}

lemma Owns(s: Turns, f: TurnFrame, turnId: int, group: int)
  ensures frameOwnsPendingTurn(s, f, turnId, group) <==> (f.GlobalFrameKind? && exists i :: 0 <= i < |f.groups| && f.cursor <= i && f.groups[i] == group) || (f.RoomScanKind? && f.global && f.group == group && exists i :: 0 <= i < |roomGroupMembers(s, group)| && f.scan.cursor <= i && roomGroupMembers(s, group)[i].id == turnId)
{
  if f.GlobalFrameKind? {
    InSuffix(f.groups, f.cursor, group);
  }
  if f.RoomScanKind? {
    var ids := (var s_map := roomGroupMembers(s, group); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; t.id));
    InSuffix(ids, f.scan.cursor, turnId);
    assert |ids| == |roomGroupMembers(s, group)| && forall i :: 0 <= i < |ids| ==> ids[i] == roomGroupMembers(s, group)[i].id;
  }
}

lemma Bottom(s: Turns)
  ensures alwaysCleanupAtBottom(s) <==> forall i :: 0 < i < |s.frames| ==> !s.frames[i].CleanupFrameKind?
{
  AlwaysCleanupAtBottomFilter(s);
  if forall i :: 0 < i < |s.frames| ==> !s.frames[i].CleanupFrameKind? {
    if |s.frames| > 0 && s.frames[0].CleanupFrameKind? {
      ProofLib.FilterOne((f: TurnFrame) => isCleanupFrame(f), s.frames, 0);
    } else {
      ProofLib.FilterNone((f: TurnFrame) => isCleanupFrame(f), s.frames);
    }
  } else {
    var i :| 0 < i < |s.frames| && s.frames[i].CleanupFrameKind?;
    if s.frames[0].CleanupFrameKind? {
      ProofLib.FilterTwo((f: TurnFrame) => isCleanupFrame(f), s.frames, 0, i);
    } else {
      ProofLib.FilterNone((f: TurnFrame) => isCleanupFrame(f), s.frames);
    }
  }
}

lemma BottomKeep(s: Turns, after: Turns, keep: int)
  requires alwaysCleanupAtBottom(s)
  requires 0 <= keep <= |s.frames| && keep <= |after.frames| && after.frames[..keep] == s.frames[..keep]
  requires forall i :: keep <= i < |after.frames| && 0 < i ==> !after.frames[i].CleanupFrameKind?
  ensures alwaysCleanupAtBottom(after)
{
  Bottom(s);
  Bottom(after);
  forall i | 0 < i < keep ensures after.frames[i] == s.frames[i] {
    assert after.frames[..keep][i] == s.frames[..keep][i];
  }
}

lemma FramesIndexed(s: Turns)
  ensures alwaysFramesRetainNotices(s) <==> forall i :: 0 <= i < |s.frames| ==> validStackFrame(s, s.frames[i])
{
  if forall i :: 0 <= i < |s.frames| ==> validStackFrame(s, s.frames[i]) {
    forall f | f in s.frames ensures validStackFrame(s, f) {
      var i :| 0 <= i < |s.frames| && s.frames[i] == f;
    }
  }
}

lemma FrameAt(s: Turns, i: int)
  requires 0 <= i < |s.frames|
  ensures validStackFrame(s, s.frames[i]) <==> (validStackFrame(s.(frames := [s.frames[i]]), s.frames[i])
    && (s.frames[i].EventFrameKind? ==> forall j :: 0 <= j < |s.frames| && j != i && s.frames[j].EventFrameKind? ==> s.frames[j].noticeId != s.frames[i].noticeId)
    && (s.frames[i].CleanupFrameKind? ==> forall j :: 0 <= j < |s.frames| && j != i && s.frames[j].CleanupFrameKind? ==> s.frames[j].turnId != s.frames[i].turnId))
{
  var f := s.frames[i];
  var solo := s.(frames := [f]);
  ValidStackFrameFilter(s, f);
  ValidStackFrameFilter(solo, f);
  MembersFrame(s, solo, if f.RoomScanKind? then f.group else 0);
  if f.EventFrameKind? {
    ProofLib.FilterOne((other: TurnFrame) => noticeFrameMatches(other, f.noticeId), [f], 0);
    if f.noticeId > 0 {
      ProofLib.FilterCountOneIffUnique((other: TurnFrame) => noticeFrameMatches(other, f.noticeId), s.frames, (g: TurnFrame) => if g.EventFrameKind? then g.noticeId else 0, i);
    }
  }
  if f.CleanupFrameKind? {
    ProofLib.FilterOne((other: TurnFrame) => cleanupFrameMatches(other, f.turnId), [f], 0);
    if f.turnId > 0 {
      ProofLib.FilterCountOneIffUnique((other: TurnFrame) => cleanupFrameMatches(other, f.turnId), s.frames, (g: TurnFrame) => if g.CleanupFrameKind? then g.turnId else 0, i);
    }
  }
}

lemma AlwaysCleanupAtBottomFilter(s: Turns)
  ensures alwaysCleanupAtBottom(s) == (((|ProofLib.Filter((f: TurnFrame) => isCleanupFrame(f), s.frames)| == 0) || ((|ProofLib.Filter((f: TurnFrame) => isCleanupFrame(f), s.frames)| == 1) && isCleanupFrame((if ((0 <= 0) && (0 < |s.frames|)) then s.frames[0] else RoomAbortReturnKind(0, "", false, false))))))
{
}

lemma ValidStackFrameFilter(s: Turns, f: TurnFrame)
  ensures validStackFrame(s, f) == (if f.EventFrameKind? then ((((f.noticeId > 0) && (|ProofLib.Filter((other: TurnFrame) => noticeFrameMatches(other, f.noticeId), s.frames)| == 1)) && (exists n :: n in s.controllers.notices && ((n.id == f.noticeId) && !(n.finished)))) && (!(f.invoking) || (exists n :: n in s.controllers.notices && ((n.id == f.noticeId) && (n.cursor == f.listenerGeneration))))) else if f.GlobalFrameKind? then (((f.cursor >= 0) && (f.cursor <= |f.groups|)) && !((exists id :: id in f.groups && !((exists g :: g in s.groups && (g.id == id)))))) else if f.CleanupFrameKind? then (((f.turnId > 0) && (|ProofLib.Filter((other: TurnFrame) => cleanupFrameMatches(other, f.turnId), s.frames)| == 1)) && (exists t :: t in s.controllers.turns && ((t.id == f.turnId) && t.phase.TurnReturned?))) else if f.RoomScanKind? then validRoomScan(s, RoomScan(f.group, f.room, f.global, f.scan)) else validRoomCapture(s, f.group, f.abortRoom, f.fromGlobal, f.changedSignal))
{
}

lemma LiveGroupFilter(s: Turns, room: string)
  ensures liveGroup(s, room) == ((if ((0 <= 0) && (0 < |ProofLib.Filter((g: RoomGroup) => ((g.room == room) && g.active), s.groups)|)) then ProofLib.Filter((g: RoomGroup) => ((g.room == room) && g.active), s.groups)[0] else RoomGroup(0, "", false)).id)
{
}

lemma GroupOfFilter(s: Turns, turnId: int)
  ensures groupOf(s, turnId) == ((if ((0 <= 0) && (0 < |ProofLib.Filter((g: TurnGroup) => (g.turnId == turnId), s.turnGroups)|)) then ProofLib.Filter((g: TurnGroup) => (g.turnId == turnId), s.turnGroups)[0] else TurnGroup(0, 0)).group)
{
}

lemma ActiveGroupIdsFilter(s: Turns)
  ensures activeGroupIds(s) == ((var s_map := ProofLib.Filter((g: RoomGroup) => g.active, s.groups); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var g := s_map[i_map]; g.id)))
{
}

lemma AlwaysGroupAllocatorValidFilter(s: Turns)
  ensures alwaysGroupAllocatorValid(s) == (((s.nextGroup > 0) && !((exists g :: g in s.groups && !(((((g.id > 0) && (g.id < s.nextGroup)) && (|ProofLib.Filter((other: RoomGroup) => (other.id == g.id), s.groups)| == 1)) && (!(g.active) || (|ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), s.groups)| == 1))))))))
{
}

lemma AlwaysTurnsRetainGroupsFilter(s: Turns)
  ensures alwaysTurnsRetainGroups(s) == ((!((exists g :: g in s.turnGroups && !(((|ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups)| == 1) && (exists t :: t in s.controllers.turns && ((t.id == g.turnId) && (exists roomGroup :: roomGroup in s.groups && ((roomGroup.id == g.group) && (roomGroup.room == t.room))))))))) && !((exists t :: t in s.controllers.turns && !(((exists g :: g in s.turnGroups && (g.turnId == t.id)) && (exists g :: g in s.groups && ((g.id == groupOf(s, t.id)) && (g.room == t.room)))))))))
{
}

lemma SoloSame(a: Turns, b: Turns, f: TurnFrame)
  requires a.controllers.turns == b.controllers.turns && a.turnGroups == b.turnGroups
  requires forall g :: g in b.groups ==> g in a.groups
  requires forall n :: n in b.controllers.notices && f.EventFrameKind? && n.id == f.noticeId ==> n in a.controllers.notices
  ensures validStackFrame(b.(frames := [f]), f) ==> validStackFrame(a.(frames := [f]), f)
{
  if f.RoomScanKind? {
    MembersFrame(b.(frames := [f]), a.(frames := [f]), f.group);
  }
}

lemma SoloKept(s: Turns, after: Turns, keep: int, spare: int)
  requires alwaysFramesRetainNotices(s)
  requires 0 <= keep <= |s.frames| && keep <= |after.frames| && after.frames[..keep] == s.frames[..keep]
  requires after.controllers.turns == s.controllers.turns && after.turnGroups == s.turnGroups && after.groups == s.groups
  requires forall n :: n in s.controllers.notices && n.id != spare ==> n in after.controllers.notices
  requires forall i :: 0 <= i < keep && s.frames[i].EventFrameKind? ==> s.frames[i].noticeId != spare
  ensures forall i :: 0 <= i < keep ==> validStackFrame(after.(frames := [after.frames[i]]), after.frames[i])
{
  FramesIndexed(s);
  forall i | 0 <= i < keep ensures validStackFrame(after.(frames := [after.frames[i]]), after.frames[i]) {
    assert after.frames[..keep][i] == s.frames[..keep][i];
    FrameAt(s, i);
    SoloSame(after, s, s.frames[i]);
  }
}

lemma FramesKeep(s: Turns, after: Turns, keep: int)
  requires alwaysFramesRetainNotices(s)
  requires 0 <= keep <= |s.frames| && keep <= |after.frames| && after.frames[..keep] == s.frames[..keep]
  requires forall i :: 0 <= i < |after.frames| ==> validStackFrame(after.(frames := [after.frames[i]]), after.frames[i])
  requires forall i, j :: 0 <= j < |after.frames| && keep <= i < |after.frames| && i != j && after.frames[i].EventFrameKind? && after.frames[j].EventFrameKind? ==> after.frames[i].noticeId != after.frames[j].noticeId
  requires forall i, j :: 0 <= j < |after.frames| && keep <= i < |after.frames| && i != j && after.frames[i].CleanupFrameKind? && after.frames[j].CleanupFrameKind? ==> after.frames[i].turnId != after.frames[j].turnId
  ensures alwaysFramesRetainNotices(after)
{
  FramesIndexed(s);
  FramesIndexed(after);
  forall i | 0 <= i < |after.frames| ensures validStackFrame(after, after.frames[i]) {
    FrameAt(after, i);
    if i < keep {
      assert after.frames[..keep][i] == s.frames[..keep][i];
      FrameAt(s, i);
      forall j | 0 <= j < keep ensures after.frames[j] == s.frames[j] {
        assert after.frames[..keep][j] == s.frames[..keep][j];
      }
    }
  }
}

lemma ClosedKeep(s: Turns, after: Turns, keep: int)
  requires alwaysClosedPendingHasGlobalOwner(s)
  requires after.controllers.closed == s.controllers.closed && after.controllers.turns == s.controllers.turns && after.turnGroups == s.turnGroups
  requires 0 <= keep <= |s.frames| && keep <= |after.frames| && after.frames[..keep] == s.frames[..keep]
  requires forall t, i :: t in s.controllers.turns && !t.phase.TurnDetached? && !t.aborted && keep <= i < |s.frames| && frameOwnsPendingTurn(s, s.frames[i], t.id, groupOf(s, t.id)) ==> exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  GroupOfFrame(s, after);
  forall group ensures roomGroupMembers(after, group) == roomGroupMembers(s, group) {
    MembersFrame(s, after, group);
  }
  forall t | after.controllers.closed && t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
    ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
  {
    var f :| f in s.frames && frameOwnsPendingTurn(s, f, t.id, groupOf(s, t.id));
    var i :| 0 <= i < |s.frames| && s.frames[i] == f;
    if i < keep {
      assert after.frames[..keep][i] == s.frames[..keep][i];
      assert after.frames[i] in after.frames;
    }
  }
}

lemma EventIdsBelow(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s)
  ensures forall i :: 0 <= i < |s.frames| && s.frames[i].EventFrameKind? ==> 0 < s.frames[i].noticeId < s.controllers.nextNotice
{
  FramesIndexed(s);
  TurnNoticeFilters(s);
  forall i | 0 <= i < |s.frames| && s.frames[i].EventFrameKind? ensures 0 < s.frames[i].noticeId < s.controllers.nextNotice {
    FrameAt(s, i);
  }
}

lemma TopKind(s: Turns)
  requires |s.frames| > 0
  ensures topFrame(s) == s.frames[|s.frames| - 1]
  ensures s.frames == s.frames[..|s.frames| - 1] + [s.frames[|s.frames| - 1]]
{
}

lemma AbortRoomStack(s: Turns, room: string, selfId: int, reason: string)
  requires inv(s) && canAbortRoom(s, room, selfId, reason)
  ensures alwaysClosedPendingHasGlobalOwner(abortRoom(s, room, selfId, reason))
  ensures alwaysFramesRetainNotices(abortRoom(s, room, selfId, reason))
  ensures alwaysCleanupAtBottom(abortRoom(s, room, selfId, reason))
{
  var after := abortRoom(s, room, selfId, reason);
  var n := |s.frames|;
  assert after.frames[..n] == s.frames[..n];
  ClosedKeep(s, after, n);
  EventIdsBelow(s);
  SoloKept(s, after, n, 0);
  AbortRoomTop(s, room, selfId, reason);
  FramesKeep(s, after, n);
  BottomKeep(s, after, n);
}

lemma AbortRoomTop(s: Turns, room: string, selfId: int, reason: string)
  requires alwaysGroupAllocatorValid(s) && selfId >= 0
  ensures validStackFrame(abortRoom(s, room, selfId, reason).(frames := [abortRoom(s, room, selfId, reason).frames[|s.frames|]]), abortRoom(s, room, selfId, reason).frames[|s.frames|])
{
  StartLiveGroup(s, room);
}

lemma ActiveIdsKnown(s: Turns)
  ensures forall id :: id in activeGroupIds(s) ==> exists g :: g in s.groups && g.id == id
{
  ActiveGroupIdsFilter(s);
  ProofLib.FilterSubset((g: RoomGroup) => g.active, s.groups);
}

lemma BeginGlobalStack(s: Turns, reason: string, close: bool)
  requires inv(s) && canBeginGlobalAbort(s, reason, close)
  ensures alwaysClosedPendingHasGlobalOwner(beginGlobalAbort(s, reason, close))
  ensures alwaysFramesRetainNotices(beginGlobalAbort(s, reason, close))
  ensures alwaysCleanupAtBottom(beginGlobalAbort(s, reason, close))
{
  var after := beginGlobalAbort(s, reason, close);
  var n := |s.frames|;
  assert after.frames[..n] == s.frames[..n];
  EventIdsBelow(s);
  SoloKept(s, after, n, 0);
  ActiveIdsKnown(s);
  FramesKeep(s, after, n);
  BottomKeep(s, after, n);
  if close && !s.controllers.closed {
    ActiveOwners(s);
    ClosingOwned(s, after);
  } else {
    ClosedKeep(s, after, n);
  }
}

lemma ClosingOwned(s: Turns, after: Turns)
  requires forall t :: t in s.controllers.turns && !t.phase.TurnDetached? ==> exists g :: g in s.groups && g.active && g.id == groupOf(s, t.id) && g.room == t.room
  requires after.controllers.turns == s.controllers.turns && after.turnGroups == s.turnGroups && |after.frames| > 0
  requires after.frames[|after.frames| - 1].GlobalFrameKind? && after.frames[|after.frames| - 1].groups == activeGroupIds(s) && after.frames[|after.frames| - 1].cursor == 0
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  var top := after.frames[|after.frames| - 1];
  assert top in after.frames;
  GroupOfFrame(s, after);
  ActiveGroupIdsFilter(s);
  var live := ProofLib.Filter((g: RoomGroup) => g.active, s.groups);
  forall t | t in s.controllers.turns && !t.phase.TurnDetached?
    ensures frameOwnsPendingTurn(after, top, t.id, groupOf(after, t.id))
  {
    var g :| g in s.groups && g.active && g.id == groupOf(s, t.id) && g.room == t.room;
    ProofLib.FilterMember((g: RoomGroup) => g.active, s.groups, g);
    var k :| 0 <= k < |live| && live[k] == g;
    assert top.groups[k] == g.id;
    Owns(after, top, t.id, groupOf(after, t.id));
  }
}

lemma FinishGlobalStack(s: Turns)
  requires inv(s) && canFinishGlobalAbort(s)
  ensures alwaysClosedPendingHasGlobalOwner(finishGlobalAbort(s))
  ensures alwaysFramesRetainNotices(finishGlobalAbort(s))
  ensures alwaysCleanupAtBottom(finishGlobalAbort(s))
{
  var after := finishGlobalAbort(s);
  var n := |s.frames|;
  TopKind(s);
  assert after.frames == s.frames[..n - 1];
  assert after.frames[..n - 1] == s.frames[..n - 1];
  var top := s.frames[n - 1];
  forall t, g ensures !frameOwnsPendingTurn(s, top, t, g) {
    Owns(s, top, t, g);
  }
  ClosedKeep(s, after, n - 1);
  EventIdsBelow(s);
  SoloKept(s, after, n - 1, 0);
  FramesKeep(s, after, n - 1);
  BottomKeep(s, after, n - 1);
}

lemma RetainFact(s: Turns, t: TurnEntry)
  requires alwaysTurnsRetainGroups(s) && t in s.controllers.turns
  ensures exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room
{
}

lemma LiveFact(s: Turns, g: RoomGroup)
  requires alwaysLiveGroupOwnsTurns(s) && g in s.groups
  ensures g.active == exists t :: t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) == g.id
{
}

lemma ActiveOwners(s: Turns)
  requires inv(s)
  ensures forall t :: t in s.controllers.turns && !t.phase.TurnDetached? ==> exists g :: g in s.groups && g.active && g.id == groupOf(s, t.id) && g.room == t.room
{
  forall t | t in s.controllers.turns && !t.phase.TurnDetached?
    ensures exists g :: g in s.groups && g.active && g.id == groupOf(s, t.id) && g.room == t.room
  {
    RetainFact(s, t);
    var g :| g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room;
    LiveFact(s, g);
  }
}

lemma GroupPositive(s: Turns, t: TurnEntry)
  requires alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s) && t in s.controllers.turns
  ensures groupOf(s, t.id) > 0
{
  RetainFact(s, t);
}

lemma MemberAt(s: Turns, t: TurnEntry)
  requires t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) > 0
  ensures exists i :: 0 <= i < |roomGroupMembers(s, groupOf(s, t.id))| && roomGroupMembers(s, groupOf(s, t.id))[i] == t
{
  var group := groupOf(s, t.id);
  MembersAsFilter(s, group);
  ProofLib.FilterMember((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0)), s.controllers.turns, t);
}

lemma PositiveGroups(s: Turns)
  requires alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s)
  ensures forall t :: t in s.controllers.turns ==> groupOf(s, t.id) > 0
{
  forall t | t in s.controllers.turns ensures groupOf(s, t.id) > 0 {
    GroupPositive(s, t);
  }
}

lemma AdvanceClosed(s: Turns)
  requires alwaysClosedPendingHasGlobalOwner(s) && canAdvanceGlobalAbort(s)
  requires forall t :: t in s.controllers.turns ==> groupOf(s, t.id) > 0
  ensures alwaysClosedPendingHasGlobalOwner(advanceGlobalAbort(s))
{
  var after := advanceGlobalAbort(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert |after.frames| == n + 1 && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == GlobalFrameKind(top.groups, top.cursor + 1, top.reason, top.abortedRooms);
  assert after.frames[n].RoomScanKind? && after.frames[n].global && after.frames[n].scan.cursor == 0 && (0 <= top.cursor ==> after.frames[n].group == top.groups[top.cursor]);
  GroupOfFrame(s, after);
  forall t, i | t in s.controllers.turns && !t.phase.TurnDetached? && !t.aborted && n - 1 <= i < |s.frames| && frameOwnsPendingTurn(s, s.frames[i], t.id, groupOf(s, t.id))
    ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
  {
    Owns(s, top, t.id, groupOf(s, t.id));
    var k :| 0 <= k < |top.groups| && top.cursor <= k && top.groups[k] == groupOf(s, t.id);
    if k > top.cursor {
      Owns(after, after.frames[n - 1], t.id, groupOf(after, t.id));
      assert after.frames[n - 1] in after.frames;
    } else {
      MemberAt(s, t);
      MembersFrame(s, after, groupOf(s, t.id));
      Owns(after, after.frames[n], t.id, groupOf(after, t.id));
      assert after.frames[n] in after.frames;
    }
  }
  ClosedKeep(s, after, n - 1);
}

lemma AdvanceRoom(s: Turns, group: int)
  requires exists g :: g in s.groups && g.id == group
  ensures exists g :: g in s.groups && g.id == group && g.room == (if ((0 <= 0) && (0 < |ProofLib.Filter((g: RoomGroup) => (g.id == group), s.groups)|)) then ProofLib.Filter((g: RoomGroup) => (g.id == group), s.groups)[0] else RoomGroup(0, "", false)).room
{
  var w :| w in s.groups && w.id == group;
  ProofLib.FilterMember((g: RoomGroup) => (g.id == group), s.groups, w);
  var hits := ProofLib.Filter((g: RoomGroup) => (g.id == group), s.groups);
  ProofLib.FilterMember((g: RoomGroup) => (g.id == group), s.groups, hits[0]);
}

lemma AdvanceFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s) && alwaysGroupAllocatorValid(s) && canAdvanceGlobalAbort(s)
  ensures alwaysFramesRetainNotices(advanceGlobalAbort(s))
{
  var after := advanceGlobalAbort(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert |after.frames| == n + 1 && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == GlobalFrameKind(top.groups, top.cursor + 1, top.reason, top.abortedRooms);
  FramesIndexed(s);
  FrameAt(s, n - 1);
  var group := top.groups[top.cursor];
  assert group in top.groups;
  AdvanceRoom(s, group);
  assert after.frames[n] == RoomScanKind(group, after.frames[n].room, true, emptyScan.(scanId := n + 1, reason := top.reason));
  assert validStackFrame(after.(frames := [after.frames[n - 1]]), after.frames[n - 1]);
  assert validStackFrame(after.(frames := [after.frames[n]]), after.frames[n]);
  EventIdsBelow(s);
  SoloKept(s, after, n - 1, 0);
  FramesKeep(s, after, n - 1);
}

lemma AdvanceBottom(s: Turns)
  requires alwaysCleanupAtBottom(s) && canAdvanceGlobalAbort(s)
  ensures alwaysCleanupAtBottom(advanceGlobalAbort(s))
{
  var after := advanceGlobalAbort(s);
  var n := |s.frames|;
  TopKind(s);
  assert |after.frames| == n + 1 && after.frames[..n - 1] == s.frames[..n - 1];
  BottomKeep(s, after, n - 1);
}

lemma NativeClosed(s: Turns)
  requires alwaysClosedPendingHasGlobalOwner(s) && canReturnNativeSignal(s)
  ensures alwaysClosedPendingHasGlobalOwner(returnNativeSignal(s))
{
  var after := returnNativeSignal(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert |after.frames| == n && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == RoomScanKind(top.group, top.room, top.global, top.scan.(notifying := 0));
  GroupOfFrame(s, after);
  forall t, g ensures frameOwnsPendingTurn(s, top, t, g) ==> frameOwnsPendingTurn(after, after.frames[n - 1], t, g) {
    MembersFrame(s, after, g);
    Owns(s, top, t, g);
    Owns(after, after.frames[n - 1], t, g);
  }
  assert after.frames[n - 1] in after.frames;
  ClosedKeep(s, after, n - 1);
}

lemma NativeFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s) && canReturnNativeSignal(s)
  ensures alwaysFramesRetainNotices(returnNativeSignal(s))
{
  var after := returnNativeSignal(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert |after.frames| == n && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == RoomScanKind(top.group, top.room, top.global, top.scan.(notifying := 0));
  FramesIndexed(s);
  FrameAt(s, n - 1);
  MembersFrame(s.(frames := [top]), after.(frames := [after.frames[n - 1]]), top.group);
  EventIdsBelow(s);
  SoloKept(s, after, n - 1, 0);
  FramesKeep(s, after, n - 1);
}

lemma NativeBottom(s: Turns)
  requires alwaysCleanupAtBottom(s) && canReturnNativeSignal(s)
  ensures alwaysCleanupAtBottom(returnNativeSignal(s))
{
  var after := returnNativeSignal(s);
  var n := |s.frames|;
  TopKind(s);
  assert |after.frames| == n && after.frames[..n - 1] == s.frames[..n - 1];
  BottomKeep(s, after, n - 1);
}

lemma FinishRoomClosed(s: Turns)
  requires alwaysClosedPendingHasGlobalOwner(s) && canFinishRoomSignal(s)
  ensures alwaysClosedPendingHasGlobalOwner(finishRoomSignal(s))
{
  var after := finishRoomSignal(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert after.frames[..n - 1] == s.frames[..n - 1];
  forall t, g ensures !frameOwnsPendingTurn(s, top, t, g) {
    Owns(s, top, t, g);
  }
  ClosedKeep(s, after, n - 1);
}

lemma FinishRoomFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s) && canFinishRoomSignal(s)
  ensures alwaysFramesRetainNotices(finishRoomSignal(s))
{
  var after := finishRoomSignal(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  var born := freshNotice(s.controllers.nextNotice, TurnNoticeKind.TurnAborted, top.room, top.scan.reason, "", 0);
  assert after.frames[..n - 1] == s.frames[..n - 1] && after.frames[n - 1] == RoomAbortReturnKind(top.group, top.room, top.global, top.scan.changed);
  FramesIndexed(s);
  TurnNoticeFilters(s);
  EventIdsBelow(s);
  if top.scan.changed {
    assert after.controllers.notices == s.controllers.notices + [born];
    assert |after.frames| == n + 1 && after.frames[n] == EventFrameKind(s.controllers.nextNotice, false, 0);
    assert born in after.controllers.notices;
    SoloEvent(after, after.frames[n]);
  } else {
    assert after.controllers.notices == s.controllers.notices && |after.frames| == n;
  }
  SoloKept(s, after, n - 1, 0);
  FramesKeep(s, after, n - 1);
}

lemma FinishRoomBottom(s: Turns)
  requires alwaysCleanupAtBottom(s) && canFinishRoomSignal(s)
  ensures alwaysCleanupAtBottom(finishRoomSignal(s))
{
  var after := finishRoomSignal(s);
  var n := |s.frames|;
  TopKind(s);
  assert after.frames[..n - 1] == s.frames[..n - 1];
  BottomKeep(s, after, n - 1);
}

lemma ReturnRoomClosed(s: Turns)
  requires alwaysClosedPendingHasGlobalOwner(s) && canReturnRoomAbort(s)
  ensures alwaysClosedPendingHasGlobalOwner(returnRoomAbort(s))
{
  var after := returnRoomAbort(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  forall t, g ensures !frameOwnsPendingTurn(s, top, t, g) {
    Owns(s, top, t, g);
  }
  if n >= 2 && s.frames[n - 2].GlobalFrameKind? && top.fromGlobal && top.changedSignal {
    var below := s.frames[n - 2];
    assert |after.frames| == n - 1 && after.frames[..n - 2] == s.frames[..n - 2];
    assert after.frames[n - 2] == GlobalFrameKind(below.groups, below.cursor, below.reason, below.abortedRooms + [top.abortRoom]);
    forall t, g ensures frameOwnsPendingTurn(s, below, t, g) ==> frameOwnsPendingTurn(after, after.frames[n - 2], t, g) {
      Owns(s, below, t, g);
      Owns(after, after.frames[n - 2], t, g);
    }
    assert after.frames[n - 2] in after.frames;
    ClosedKeep(s, after, n - 2);
  } else {
    assert after.frames == s.frames[..n - 1] && after.frames[..n - 1] == s.frames[..n - 1];
    ClosedKeep(s, after, n - 1);
  }
}

lemma {:induction false} ReturnRoomShape(s: Turns, after: Turns) returns (keep: int)
  requires canReturnRoomAbort(s) && after == returnRoomAbort(s)
  ensures 0 <= keep <= |s.frames| && keep <= |after.frames|
  ensures after.frames[..keep] == s.frames[..keep]
  ensures |after.frames| == |s.frames| - 1
  ensures keep < |after.frames| ==> keep == |after.frames| - 1 && s.frames[keep].GlobalFrameKind? && after.frames[keep].GlobalFrameKind?
  ensures keep < |after.frames| ==> after.frames[keep].groups == s.frames[keep].groups && after.frames[keep].cursor == s.frames[keep].cursor
  ensures after.controllers.turns == s.controllers.turns && after.controllers.notices == s.controllers.notices
  ensures after.turnGroups == s.turnGroups && after.groups == s.groups
{
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  if n >= 2 && s.frames[n - 2].GlobalFrameKind? && top.fromGlobal && top.changedSignal {
    var below := s.frames[n - 2];
    keep := n - 2;
    assert after.frames == s.frames[..keep] + [GlobalFrameKind(below.groups, below.cursor, below.reason, below.abortedRooms + [top.abortRoom])];
  } else {
    keep := n - 1;
    assert after.frames == s.frames[..keep];
  }
}

lemma {:induction false} ReturnRoomFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s) && canReturnRoomAbort(s)
  ensures alwaysFramesRetainNotices(returnRoomAbort(s))
{
  var after := returnRoomAbort(s);
  var keep := ReturnRoomShape(s, after);
  EventIdsBelow(s);
  SoloKept(s, after, keep, 0);
  if keep < |after.frames| {
    var before := s.frames[keep];
    var next := after.frames[keep];
    assert validStackFrame(after.(frames := [next]), next) by {
      assert before in s.frames;
      assert validStackFrame(s, before);
    }
  }
  FramesKeep(s, after, keep);
}

lemma {:induction false} ReturnRoomBottom(s: Turns)
  requires alwaysCleanupAtBottom(s) && canReturnRoomAbort(s)
  ensures alwaysCleanupAtBottom(returnRoomAbort(s))
{
  var after := returnRoomAbort(s);
  var keep := ReturnRoomShape(s, after);
  BottomKeep(s, after, keep);
}

lemma EventTop(s: Turns)
  requires alwaysFramesRetainNotices(s) && |s.frames| > 0 && s.frames[|s.frames| - 1].EventFrameKind?
  ensures forall i :: 0 <= i < |s.frames| - 1 && s.frames[i].EventFrameKind? ==> s.frames[i].noticeId != s.frames[|s.frames| - 1].noticeId
  ensures validStackFrame(s.(frames := [s.frames[|s.frames| - 1]]), s.frames[|s.frames| - 1])
{
  FramesIndexed(s);
  FrameAt(s, |s.frames| - 1);
}

lemma EventPopClosed(s: Turns, after: Turns, keep: int)
  requires alwaysClosedPendingHasGlobalOwner(s) && |s.frames| > 0 && s.frames[|s.frames| - 1].EventFrameKind?
  requires keep == |s.frames| - 1 && keep <= |after.frames| && after.frames[..keep] == s.frames[..keep]
  requires after.controllers.closed == s.controllers.closed && after.controllers.turns == s.controllers.turns && after.turnGroups == s.turnGroups
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  forall t, g ensures !frameOwnsPendingTurn(s, s.frames[keep], t, g) {
    Owns(s, s.frames[keep], t, g);
  }
  ClosedKeep(s, after, keep);
}

lemma EndListenerFrames(s: Turns, ok: bool)
  requires alwaysFramesRetainNotices(s) && canEndListener(s, ok)
  ensures alwaysFramesRetainNotices(endListener(s, ok))
{
  var after := endListener(s, ok);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert |after.frames| == n && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == EventFrameKind(top.noticeId, false, 0);
  EventTop(s);
  forall m | m in s.controllers.notices && m.id != top.noticeId ensures m in after.controllers.notices {
    var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == m;
    assert after.controllers.notices[i] == m;
  }
  var m :| m in s.controllers.notices && m.id == top.noticeId && !m.finished;
  var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == m;
  assert after.controllers.notices[i] in after.controllers.notices;
  SoloEvent(after, after.frames[n - 1]);
  SoloKept(s, after, n - 1, top.noticeId);
  FramesKeep(s, after, n - 1);
}

lemma BeginListenerFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && canBeginListener(s)
  ensures alwaysFramesRetainNotices(beginListener(s))
{
  var after := beginListener(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  var gen := nextTurnListener(s.controllers, top.noticeId).generation;
  assert |after.frames| == n && after.frames[..n - 1] == s.frames[..n - 1];
  assert after.frames[n - 1] == EventFrameKind(top.noticeId, true, gen);
  EventTop(s);
  forall m | m in s.controllers.notices && m.id != top.noticeId ensures m in after.controllers.notices {
    var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == m;
    assert after.controllers.notices[i] == m;
  }
  var m :| m in s.controllers.notices && m.id == top.noticeId && !m.finished;
  var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == m;
  assert after.controllers.notices[i] in after.controllers.notices;
  SoloEvent(after, after.frames[n - 1]);
  SoloKept(s, after, n - 1, top.noticeId);
  FramesKeep(s, after, n - 1);
}

lemma FinishEventFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && canFinishEvent(s)
  ensures alwaysFramesRetainNotices(finishEvent(s))
{
  var after := finishEvent(s);
  var n := |s.frames|;
  TopKind(s);
  var top := s.frames[n - 1];
  assert after.frames == s.frames[..n - 1] && after.frames[..n - 1] == s.frames[..n - 1];
  EventTop(s);
  forall m | m in s.controllers.notices && m.id != top.noticeId ensures m in after.controllers.notices {
    var i :| 0 <= i < |s.controllers.notices| && s.controllers.notices[i] == m;
    assert after.controllers.notices[i] == m;
  }
  SoloKept(s, after, n - 1, top.noticeId);
  FramesKeep(s, after, n - 1);
}

lemma EventBottom(s: Turns, after: Turns, keep: int)
  requires alwaysCleanupAtBottom(s) && |s.frames| > 0 && keep == |s.frames| - 1
  requires keep <= |after.frames| <= |s.frames| && after.frames[..keep] == s.frames[..keep]
  requires |after.frames| == |s.frames| ==> after.frames[keep].EventFrameKind?
  ensures alwaysCleanupAtBottom(after)
{
  BottomKeep(s, after, keep);
}

lemma SoloEvent(s: Turns, f: TurnFrame)
  requires f.EventFrameKind? && f.noticeId > 0
  requires exists n :: n in s.controllers.notices && n.id == f.noticeId && !n.finished
  requires f.invoking ==> exists n :: n in s.controllers.notices && n.id == f.noticeId && n.cursor == f.listenerGeneration
  ensures validStackFrame(s.(frames := [f]), f)
{
  ValidStackFrameFilter(s.(frames := [f]), f);
  ProofLib.FilterOne((other: TurnFrame) => noticeFrameMatches(other, f.noticeId), [f], 0);
}

lemma {:induction false} RetainSplit(s: Turns)
  requires alwaysTurnsRetainGroups(s)
  ensures forall g :: g in s.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups)| == 1 && exists t :: t in s.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in s.groups && roomGroup.id == g.group && roomGroup.room == t.room
  ensures forall t :: t in s.controllers.turns ==> (exists g :: g in s.turnGroups && g.turnId == t.id) && exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room
{
  AlwaysTurnsRetainGroupsFilter(s);
}

lemma {:induction false} RetainJoin(s: Turns)
  requires forall g :: g in s.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups)| == 1 && exists t :: t in s.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in s.groups && roomGroup.id == g.group && roomGroup.room == t.room
  requires forall t :: t in s.controllers.turns ==> (exists g :: g in s.turnGroups && g.turnId == t.id) && exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room
  ensures alwaysTurnsRetainGroups(s)
{
  AlwaysTurnsRetainGroupsFilter(s);
}

lemma RetainMapGroups(s: Turns, after: Turns)
  requires forall g :: g in s.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups)| == 1 && exists t :: t in s.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in s.groups && roomGroup.id == g.group && roomGroup.room == t.room
  requires after.turnGroups == s.turnGroups
  requires |after.groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> after.groups[i].id == s.groups[i].id && after.groups[i].room == s.groups[i].room
  requires |after.controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room
  ensures forall g :: g in after.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), after.turnGroups)| == 1 && exists t :: t in after.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in after.groups && roomGroup.id == g.group && roomGroup.room == t.room
{
  forall tg | tg in after.turnGroups
    ensures exists t :: t in after.controllers.turns && t.id == tg.turnId && exists rg :: rg in after.groups && rg.id == tg.group && rg.room == t.room
  {
    var t :| t in s.controllers.turns && t.id == tg.turnId && exists rg :: rg in s.groups && rg.id == tg.group && rg.room == t.room;
    var rg :| rg in s.groups && rg.id == tg.group && rg.room == t.room;
    var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == t;
    var j :| 0 <= j < |s.groups| && s.groups[j] == rg;
    assert after.controllers.turns[i] in after.controllers.turns && after.groups[j] in after.groups;
  }
}

lemma RetainMapTurns(s: Turns, after: Turns)
  requires forall t :: t in s.controllers.turns ==> (exists g :: g in s.turnGroups && g.turnId == t.id) && exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room
  requires after.turnGroups == s.turnGroups
  requires |after.groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> after.groups[i].id == s.groups[i].id && after.groups[i].room == s.groups[i].room
  requires |after.controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room
  ensures forall t :: t in after.controllers.turns ==> (exists g :: g in after.turnGroups && g.turnId == t.id) && exists g :: g in after.groups && g.id == groupOf(after, t.id) && g.room == t.room
{
  GroupOfFrame(s, after);
  forall t | t in after.controllers.turns
    ensures (exists g :: g in after.turnGroups && g.turnId == t.id) && exists g :: g in after.groups && g.id == groupOf(after, t.id) && g.room == t.room
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t;
    var t0 := s.controllers.turns[i];
    assert t0 in s.controllers.turns;
    var rg :| rg in s.groups && rg.id == groupOf(s, t0.id) && rg.room == t0.room;
    var j :| 0 <= j < |s.groups| && s.groups[j] == rg;
    assert after.groups[j] in after.groups;
  }
}

lemma VisitShape(s: Turns) returns (r: RoomScan, target: TurnEntry, hit: bool)
  requires canVisitRoomSignal(s) && alwaysTurnIdentity(s)
  ensures |s.frames| > 0 && s.frames[|s.frames| - 1] == RoomScanKind(r.group, r.room, r.global, r.scan)
  ensures 0 <= r.scan.cursor < |roomGroupMembers(s, r.group)| && target == roomGroupMembers(s, r.group)[r.scan.cursor]
  ensures target in s.controllers.turns && !target.phase.TurnDetached?
  ensures hit == (target.id > 0 && !target.aborted && target.id != r.scan.excluded)
  ensures |visitRoomSignal(s).frames| == |s.frames| && visitRoomSignal(s).frames[..|s.frames| - 1] == s.frames[..|s.frames| - 1]
  ensures visitRoomSignal(s).frames[|s.frames| - 1] == RoomScanKind(r.group, r.room, r.global, r.scan.(cursor := r.scan.cursor + 1, notifying := (if hit then target.id else 0), changed := (hit || r.scan.changed)))
  ensures |visitRoomSignal(s).controllers.turns| == |s.controllers.turns|
  ensures forall i :: 0 <= i < |s.controllers.turns| ==> visitRoomSignal(s).controllers.turns[i] == (if hit && s.controllers.turns[i].id == target.id then s.controllers.turns[i].(aborted := true, reason := r.scan.reason) else s.controllers.turns[i])
  ensures forall t :: t in s.controllers.turns && t.id == target.id ==> t == target
  ensures visitRoomSignal(s).turnGroups == s.turnGroups && visitRoomSignal(s).groups == s.groups && visitRoomSignal(s).controllers.notices == s.controllers.notices && visitRoomSignal(s).controllers.closed == s.controllers.closed
{
  r := currentRoomScan(s);
  TopKind(s);
  MembersInTurns(s, r.group);
  target := roomGroupMembers(s, r.group)[r.scan.cursor];
  hit := target.id > 0 && !target.aborted && target.id != r.scan.excluded;
  forall t | t in s.controllers.turns && t.id == target.id ensures t == target {
    SameTurnId(s, t, target);
  }
}

lemma VisitMembers(s: Turns, after: Turns, target: TurnEntry, hit: bool, reason: string, group: int)
  requires after.turnGroups == s.turnGroups && |after.controllers.turns| == |s.controllers.turns|
  requires forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i] == (if hit && s.controllers.turns[i].id == target.id then s.controllers.turns[i].(aborted := true, reason := reason) else s.controllers.turns[i])
  ensures |roomGroupMembers(after, group)| == |roomGroupMembers(s, group)|
  ensures forall k :: 0 <= k < |roomGroupMembers(s, group)| ==> roomGroupMembers(after, group)[k] == (if hit && roomGroupMembers(s, group)[k].id == target.id then roomGroupMembers(s, group)[k].(aborted := true, reason := reason) else roomGroupMembers(s, group)[k])
{
  GroupOfFrame(s, after);
  MembersAsFilter(s, group);
  MembersAsFilter(after, group);
  ProofLib.FilterPointwise((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0)), (t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0)), (x: TurnEntry, y: TurnEntry) => y == (if hit && x.id == target.id then x.(aborted := true, reason := reason) else x), s.controllers.turns, after.controllers.turns);
}

lemma VisitClosed(s: Turns)
  requires alwaysClosedPendingHasGlobalOwner(s) && alwaysFramesRetainNotices(s) && alwaysTurnIdentity(s) && canVisitRoomSignal(s)
  ensures alwaysClosedPendingHasGlobalOwner(visitRoomSignal(s))
{
  var after := visitRoomSignal(s);
  var r, target, hit := VisitShape(s);
  var n := |s.frames|;
  GroupOfFrame(s, after);
  FramesIndexed(s);
  FrameAt(s, n - 1);
  forall t2 | after.controllers.closed && t2 in after.controllers.turns && !t2.phase.TurnDetached? && !t2.aborted
    ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t2.id, groupOf(after, t2.id))
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t2;
    var t := s.controllers.turns[i];
    assert t in s.controllers.turns && t.id == t2.id && !t.aborted;
    var g := groupOf(s, t.id);
    var f :| f in s.frames && frameOwnsPendingTurn(s, f, t.id, g);
    var j :| 0 <= j < n && s.frames[j] == f;
    VisitMembers(s, after, target, hit, r.scan.reason, g);
    Owns(s, f, t.id, g);
    if j < n - 1 {
      assert after.frames[..n - 1][j] == s.frames[..n - 1][j];
      Owns(after, f, t.id, g);
      assert after.frames[j] in after.frames;
    } else {
      var k :| 0 <= k < |roomGroupMembers(s, g)| && r.scan.cursor <= k && roomGroupMembers(s, g)[k].id == t.id;
      if k == r.scan.cursor {
        assert t.id == target.id;
      }
      Owns(after, after.frames[n - 1], t.id, g);
      assert after.frames[n - 1] in after.frames;
    }
  }
}

lemma VisitSolo(s: Turns, after: Turns, f: TurnFrame, target: TurnEntry, hit: bool, reason: string)
  requires after.turnGroups == s.turnGroups && after.groups == s.groups && after.controllers.notices == s.controllers.notices && |after.controllers.turns| == |s.controllers.turns|
  requires forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i] == (if hit && s.controllers.turns[i].id == target.id then s.controllers.turns[i].(aborted := true, reason := reason) else s.controllers.turns[i])
  requires hit ==> !target.aborted
  requires forall t :: t in s.controllers.turns && t.id == target.id ==> t == target
  requires validStackFrame(s.(frames := [f]), f)
  ensures validStackFrame(after.(frames := [f]), f)
{
  var a := after.(frames := [f]);
  var b := s.(frames := [f]);
  if f.CleanupFrameKind? {
    var t :| t in s.controllers.turns && t.id == f.turnId && t.phase.TurnReturned?;
    var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == t;
    assert a.controllers.turns[i] in a.controllers.turns;
  }
  if f.RoomScanKind? {
    VisitMembers(b, a, target, hit, reason, f.group);
    if f.scan.notifying != 0 {
      var members := roomGroupMembers(b, f.group);
      var t :| t in members && t.id == f.scan.notifying && t.aborted && t.reason == f.scan.reason;
      var k :| 0 <= k < |members| && members[k] == t;
      MembersInTurns(b, f.group);
      assert roomGroupMembers(a, f.group)[k] in roomGroupMembers(a, f.group);
    }
  }
}

lemma VisitFrames(s: Turns)
  requires alwaysFramesRetainNotices(s) && alwaysTurnIdentity(s) && canVisitRoomSignal(s)
  ensures alwaysFramesRetainNotices(visitRoomSignal(s))
{
  var after := visitRoomSignal(s);
  var r, target, hit := VisitShape(s);
  var n := |s.frames|;
  FramesIndexed(s);
  forall i | 0 <= i < n - 1 ensures validStackFrame(after.(frames := [after.frames[i]]), after.frames[i]) {
    assert after.frames[..n - 1][i] == s.frames[..n - 1][i];
    FrameAt(s, i);
    VisitSolo(s, after, s.frames[i], target, hit, r.scan.reason);
  }
  FrameAt(s, n - 1);
  var top := after.frames[n - 1];
  var a := after.(frames := [top]);
  VisitMembers(s.(frames := [top]), a, target, hit, r.scan.reason, r.group);
  MembersFrame(s, s.(frames := [top]), r.group);
  if hit {
    var k := r.scan.cursor;
    assert roomGroupMembers(a, r.group)[k] in roomGroupMembers(a, r.group);
  }
  assert validStackFrame(a, top);
  FramesKeep(s, after, n - 1);
}

lemma VisitBottom(s: Turns)
  requires alwaysCleanupAtBottom(s) && alwaysTurnIdentity(s) && canVisitRoomSignal(s)
  ensures alwaysCleanupAtBottom(visitRoomSignal(s))
{
  var r, target, hit := VisitShape(s);
  BottomKeep(s, visitRoomSignal(s), |s.frames| - 1);
}

lemma CleanupShape(s: Turns, turnId: int) returns (target: TurnEntry)
  requires alwaysTurnIdentity(s) && alwaysCleanupAtBottom(s) && canCleanupTurn(s, turnId)
  ensures s.frames == [CleanupFrameKind(turnId)] && cleanupTurn(s, turnId).frames == []
  ensures target in s.controllers.turns && target.id == turnId && target.phase.TurnReturned? && turnId > 0
  ensures forall t :: t in s.controllers.turns && t.id == turnId ==> t == target
  ensures |cleanupTurn(s, turnId).controllers.turns| == |s.controllers.turns|
  ensures forall i :: 0 <= i < |s.controllers.turns| ==> cleanupTurn(s, turnId).controllers.turns[i] == (if s.controllers.turns[i].id == turnId then s.controllers.turns[i].(phase := TurnPhase.TurnDetached) else s.controllers.turns[i])
  ensures cleanupTurn(s, turnId).turnGroups == s.turnGroups && cleanupTurn(s, turnId).nextGroup == s.nextGroup && cleanupTurn(s, turnId).controllers.closed == s.controllers.closed
  ensures |cleanupTurn(s, turnId).groups| == |s.groups|
  ensures forall i :: 0 <= i < |s.groups| ==> cleanupTurn(s, turnId).groups[i] == (if s.groups[i].id == groupOf(s, turnId) && !(exists t :: t in s.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(s, t.id) == groupOf(s, turnId)) then s.groups[i].(active := false) else s.groups[i])
{
  target := controller(s.controllers, turnId);
  TurnLookup(s.controllers, turnId);
  var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.controllers.turns);
  assert |matches| > 0;
  ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, matches[0]);
  LookupTurns(s, turnId);
  TurnIdentityFilters(s);
  Bottom(s);
  var n := |s.frames|;
  assert n > 0;
  TopKind(s);
  assert s.frames[n - 1].CleanupFrameKind?;
  assert n == 1;
  assert s.frames == [CleanupFrameKind(turnId)];
}

lemma CleanupClosed(s: Turns, turnId: int)
  requires alwaysClosedPendingHasGlobalOwner(s) && alwaysTurnIdentity(s) && alwaysCleanupAtBottom(s) && canCleanupTurn(s, turnId)
  ensures alwaysClosedPendingHasGlobalOwner(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  var target := CleanupShape(s, turnId);
  forall t2 | after.controllers.closed && t2 in after.controllers.turns && !t2.phase.TurnDetached? && !t2.aborted
    ensures false
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t2;
    var t := s.controllers.turns[i];
    assert t in s.controllers.turns;
    var f :| f in s.frames && frameOwnsPendingTurn(s, f, t.id, groupOf(s, t.id));
    Owns(s, f, t.id, groupOf(s, t.id));
  }
}

lemma CleanupAllocator(s: Turns, turnId: int)
  requires alwaysGroupAllocatorValid(s) && alwaysTurnIdentity(s) && alwaysCleanupAtBottom(s) && canCleanupTurn(s, turnId)
  ensures alwaysGroupAllocatorValid(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  var target := CleanupShape(s, turnId);
  var lead := groupOf(s, turnId);
  var shared := exists t :: t in s.controllers.turns && t.id != turnId && !t.phase.TurnDetached? && groupOf(s, t.id) == lead;
  AlwaysGroupAllocatorValidFilter(s);
  AlwaysGroupAllocatorValidFilter(after);
  forall g | g in after.groups
    ensures g.id > 0 && g.id < after.nextGroup && |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), after.groups)| == 1
    ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups)| == 1
  {
    var i :| 0 <= i < |after.groups| && after.groups[i] == g;
    var g0 := s.groups[i];
    assert g0 in s.groups;
    ProofLib.FilterLengthPointwise((other: RoomGroup) => (other.id == g.id), (other: RoomGroup) => (other.id == g.id), after.groups, s.groups);
    if g.active {
      assert g == g0;
      var q := (other: RoomGroup) => other.active && other.room == g.room && !(other.id == lead && !shared);
      ProofLib.FilterLengthPointwise((other: RoomGroup) => (other.active && (other.room == g.room)), q, after.groups, s.groups);
      ProofLib.FilterImpLength(q, (other: RoomGroup) => (other.active && (other.room == g.room)), s.groups);
      ProofLib.FilterMember((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups, g);
    }
  }
}

lemma CleanupLive(s: Turns, turnId: int)
  requires alwaysLiveGroupOwnsTurns(s) && alwaysTurnIdentity(s) && alwaysCleanupAtBottom(s) && canCleanupTurn(s, turnId)
  ensures alwaysLiveGroupOwnsTurns(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  var target := CleanupShape(s, turnId);
  var lead := groupOf(s, turnId);
  GroupOfFrame(s, after);
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    var i :| 0 <= i < |after.groups| && after.groups[i] == g;
    var g0 := s.groups[i];
    LiveFact(s, g0);
    if exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id {
      var t :| t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id;
      var j :| 0 <= j < |after.controllers.turns| && after.controllers.turns[j] == t;
      assert s.controllers.turns[j] == t && t.id != turnId;
      assert t in s.controllers.turns;
    }
    if g.active {
      var t :| t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) == g0.id;
      if t.id == turnId {
        var t2 :| t2 in s.controllers.turns && t2.id != turnId && !t2.phase.TurnDetached? && groupOf(s, t2.id) == lead;
        var j :| 0 <= j < |s.controllers.turns| && s.controllers.turns[j] == t2;
        assert after.controllers.turns[j] in after.controllers.turns;
      } else {
        var j :| 0 <= j < |s.controllers.turns| && s.controllers.turns[j] == t;
        assert after.controllers.turns[j] in after.controllers.turns;
      }
    }
  }
}

lemma CleanupStack(s: Turns, turnId: int)
  requires alwaysTurnIdentity(s) && alwaysCleanupAtBottom(s) && canCleanupTurn(s, turnId)
  ensures alwaysFramesRetainNotices(cleanupTurn(s, turnId)) && alwaysCleanupAtBottom(cleanupTurn(s, turnId))
{
  var target := CleanupShape(s, turnId);
  FramesIndexed(cleanupTurn(s, turnId));
  Bottom(cleanupTurn(s, turnId));
}

lemma CleanupMapped(s: Turns, turnId: int)
  ensures |cleanupTurn(s, turnId).groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> cleanupTurn(s, turnId).groups[i].id == s.groups[i].id && cleanupTurn(s, turnId).groups[i].room == s.groups[i].room
  ensures |cleanupTurn(s, turnId).controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> cleanupTurn(s, turnId).controllers.turns[i] == (if s.controllers.turns[i].id == turnId then s.controllers.turns[i].(phase := TurnPhase.TurnDetached) else s.controllers.turns[i])
  ensures cleanupTurn(s, turnId).turnGroups == s.turnGroups
{
}

lemma CleanupRetain(s: Turns, turnId: int)
  requires alwaysTurnsRetainGroups(s)
  ensures alwaysTurnsRetainGroups(cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  CleanupIds(s, turnId, after);
  RetainFull(s, after);
}

lemma CleanupIds(s: Turns, turnId: int, after: Turns)
  requires after == cleanupTurn(s, turnId)
  ensures after.turnGroups == s.turnGroups
  ensures |after.groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> after.groups[i].id == s.groups[i].id && after.groups[i].room == s.groups[i].room
  ensures |after.controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room
{
}

lemma {:induction false} RetainFull(s: Turns, after: Turns)
  requires alwaysTurnsRetainGroups(s)
  requires after.turnGroups == s.turnGroups
  requires |after.groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> after.groups[i].id == s.groups[i].id && after.groups[i].room == s.groups[i].room
  requires |after.controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room
  ensures alwaysTurnsRetainGroups(after)
{
  RetainSplit(s);
  RetainMapGroups(s, after);
  RetainMapTurns(s, after);
  RetainJoin(after);
}

lemma CleanupBasics(s: Turns, turnId: int)
  requires alwaysTurnIdentity(s) && alwaysNoticesUnique(s) && alwaysOneLiveListener(s)
  ensures alwaysTurnIdentity(cleanupTurn(s, turnId)) && alwaysNoticesUnique(cleanupTurn(s, turnId)) && alwaysOneLiveListener(cleanupTurn(s, turnId))
  ensures stepFirstAbortReasonStays(s, cleanupTurn(s, turnId)) && stepCleanupPreservesPeers(s, "cleanupTurn", cleanupTurn(s, turnId))
{
  var after := cleanupTurn(s, turnId);
  CleanupMapped(s, turnId);
  TurnIdentityMap(s, after);
  AbortMap(s, after);
  ListenersUnchangedFilters(s, after);
  NoticesFrame(s, after);
  forall prior | prior in s.controllers.turns
    ensures exists t :: t in after.controllers.turns && t.id == prior.id && t.aborted == prior.aborted && t.reason == prior.reason
  {
    var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == prior;
    assert after.controllers.turns[i] in after.controllers.turns;
  }
}

lemma SoloCleanup(s: Turns, f: TurnFrame)
  requires f.CleanupFrameKind? && f.turnId > 0
  requires exists t :: t in s.controllers.turns && t.id == f.turnId && t.phase.TurnReturned?
  ensures validStackFrame(s.(frames := [f]), f)
{
  ValidStackFrameFilter(s.(frames := [f]), f);
  ProofLib.FilterOne((other: TurnFrame) => cleanupFrameMatches(other, f.turnId), [f], 0);
}

lemma ReturnStack(s: Turns, turnId: int, resolved: bool, errorId: string)
  requires alwaysTurnIdentity(s) && alwaysFramesRetainNotices(s) && alwaysCleanupAtBottom(s) && alwaysNoticesUnique(s) && canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysFramesRetainNotices(returnTurn(s, turnId, resolved, errorId)) && alwaysCleanupAtBottom(returnTurn(s, turnId, resolved, errorId))
{
  var after := returnTurn(s, turnId, resolved, errorId);
  TurnLookup(s.controllers, turnId);
  var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.controllers.turns);
  assert |matches| > 0;
  ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, matches[0]);
  LookupTurns(s, turnId);
  var t := controller(s.controllers, turnId);
  assert t in s.controllers.turns;
  var i :| 0 <= i < |s.controllers.turns| && s.controllers.turns[i] == t;
  assert after.controllers.turns[i] in after.controllers.turns && after.controllers.turns[i].id == turnId && after.controllers.turns[i].phase.TurnReturned?;
  TurnIdentityFilters(s);
  TurnNoticeFilters(s);
  var born := after.controllers.notices[|s.controllers.notices|];
  assert born in after.controllers.notices && born.id == s.controllers.nextNotice && !born.finished;
  assert after.frames == [CleanupFrameKind(turnId), EventFrameKind(s.controllers.nextNotice, false, 0)];
  SoloCleanup(after, after.frames[0]);
  SoloEvent(after, after.frames[1]);
  FramesKeep(s, after, 0);
  BottomKeep(s, after, 0);
}

lemma {:induction false} ReturnTurnMapping(s: Turns, after: Turns, turnId: int, resolved: bool, errorId: string)
  requires inv(s) && canReturnTurn(s, turnId, resolved, errorId)
  requires after == returnTurn(s, turnId, resolved, errorId)
  ensures alwaysTurnIdentity(after) && alwaysActiveRoomsMatch(after) && stepFirstAbortReasonStays(s, after)
  ensures alwaysLiveGroupOwnsTurns(after) && alwaysGroupAllocatorValid(after) && alwaysTurnsRetainGroups(after)
{
  LookupTurns(s, turnId);
  forall i | 0 <= i < |s.controllers.turns|
    ensures after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room && (after.controllers.turns[i].phase.TurnDetached? <==> s.controllers.turns[i].phase.TurnDetached?)
  {}
  TurnIdentityMap(s, after);
  TurnRoomMap(s, after);
  AbortMap(s, after);
  GroupFrame(s, after);
  RetainFull(s, after);
}

lemma CleanupSteps(s: Turns, turnId: int)
  ensures stepCloseIsPermanent(s, cleanupTurn(s, turnId)) && stepTelemetryCannotChangeResult(s, "cleanupTurn", cleanupTurn(s, turnId))
{
  StepsCleanup(s, cleanupTurn(s, turnId));
}

lemma ReturnClosed(s: Turns, turnId: int, resolved: bool, errorId: string)
  requires alwaysClosedPendingHasGlobalOwner(s) && alwaysTurnIdentity(s) && canReturnTurn(s, turnId, resolved, errorId)
  ensures alwaysClosedPendingHasGlobalOwner(returnTurn(s, turnId, resolved, errorId))
{
  var after := returnTurn(s, turnId, resolved, errorId);
  TurnLookup(s.controllers, turnId);
  var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.controllers.turns);
  assert |matches| > 0;
  ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.controllers.turns, matches[0]);
  LookupTurns(s, turnId);
  forall t2 | after.controllers.closed && t2 in after.controllers.turns && !t2.phase.TurnDetached? && !t2.aborted
    ensures false
  {
    var i :| 0 <= i < |after.controllers.turns| && after.controllers.turns[i] == t2;
    assert s.controllers.turns[i] in s.controllers.turns;
  }
}

lemma {:induction false} StartGroups(s: Turns, turnId: int, room: string)
  requires inv(s) && canStartTurn(s, turnId, room)
  ensures alwaysGroupAllocatorValid(startTurn(s, turnId, room))
  ensures alwaysLiveGroupOwnsTurns(startTurn(s, turnId, room))
  ensures alwaysTurnsRetainGroups(startTurn(s, turnId, room))
  ensures alwaysClosedPendingHasGlobalOwner(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var gid, added := StartShape(s, turnId, room, after);
  StartAllocator(s, turnId, room);
  StartLive(s, after, added, gid, room);
  StartRetain(s, after, added, gid);
  StartClosed(s, after, added);
}

lemma StartShape(s: Turns, turnId: int, room: string, after: Turns) returns (gid: int, added: TurnEntry)
  requires alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s) && canStartTurn(s, turnId, room)
  requires after == startTurn(s, turnId, room)
  ensures added.id == turnId && added.room == room && added.phase.RunningTurn? && added.aborted == s.controllers.closed
  ensures after.controllers.turns == s.controllers.turns + [added]
  ensures after.turnGroups == s.turnGroups + [TurnGroup(turnId, gid)]
  ensures forall t :: t in s.controllers.turns ==> t.id != turnId
  ensures forall g :: g in s.turnGroups ==> g.turnId != turnId
  ensures forall x :: x != turnId ==> groupOf(after, x) == groupOf(s, x)
  ensures groupOf(after, turnId) == gid
  ensures liveGroup(s, room) == 0 ==> gid == s.nextGroup && after.groups == s.groups + [RoomGroup(s.nextGroup, room, true)] && after.nextGroup == s.nextGroup + 1 && forall g :: g in s.groups ==> !(g.active && g.room == room)
  ensures liveGroup(s, room) != 0 ==> gid == liveGroup(s, room) && after.groups == s.groups && after.nextGroup == s.nextGroup && exists g :: g in s.groups && g.id == gid && g.active && g.room == room
  ensures after.frames == s.frames + [EventFrameKind(s.controllers.nextNotice, false, 0)]
  ensures after.controllers.notices == s.controllers.notices + [freshNotice(s.controllers.nextNotice, TurnNoticeKind.TurnStarted, room, "", "", 0)]
  ensures after.controllers.closed == s.controllers.closed
{
  gid, added := StartForm(s, turnId, room, after);
  StartNoGroup(s, turnId, room);
  StartGroupOf(s, after, turnId, gid);
  StartLiveGroup(s, room);
}

lemma StartForm(s: Turns, turnId: int, room: string, after: Turns) returns (gid: int, added: TurnEntry)
  requires after == startTurn(s, turnId, room)
  ensures added.id == turnId && added.room == room && added.phase.RunningTurn? && added.aborted == s.controllers.closed
  ensures after.controllers.turns == s.controllers.turns + [added]
  ensures after.turnGroups == s.turnGroups + [TurnGroup(turnId, gid)]
  ensures liveGroup(s, room) == 0 ==> gid == s.nextGroup && after.groups == s.groups + [RoomGroup(s.nextGroup, room, true)] && after.nextGroup == s.nextGroup + 1
  ensures liveGroup(s, room) != 0 ==> gid == liveGroup(s, room) && after.groups == s.groups && after.nextGroup == s.nextGroup
  ensures after.frames == s.frames + [EventFrameKind(s.controllers.nextNotice, false, 0)]
  ensures after.controllers.notices == s.controllers.notices + [freshNotice(s.controllers.nextNotice, TurnNoticeKind.TurnStarted, room, "", "", 0)]
  ensures after.controllers.closed == s.controllers.closed
{
  gid := if liveGroup(s, room) == 0 then s.nextGroup else liveGroup(s, room);
  added := after.controllers.turns[|s.controllers.turns|];
}

lemma StartNoGroup(s: Turns, turnId: int, room: string)
  requires alwaysTurnsRetainGroups(s) && canStartTurn(s, turnId, room)
  ensures forall t :: t in s.controllers.turns ==> t.id != turnId
  ensures forall g :: g in s.turnGroups ==> g.turnId != turnId
{
  RetainSplit(s);
}

lemma StartGroupOf(s: Turns, after: Turns, turnId: int, gid: int)
  requires after.turnGroups == s.turnGroups + [TurnGroup(turnId, gid)]
  requires forall g :: g in s.turnGroups ==> g.turnId != turnId
  ensures forall x :: x != turnId ==> groupOf(after, x) == groupOf(s, x)
  ensures groupOf(after, turnId) == gid
{
  forall x ensures groupOf(after, x) == (if x == turnId then gid else groupOf(s, x)) {
    GroupOfFilter(s, x);
    GroupOfFilter(after, x);
    ProofLib.FilterAppend((g: TurnGroup) => (g.turnId == x), s.turnGroups, TurnGroup(turnId, gid));
    if x == turnId {
      ProofLib.FilterNone((g: TurnGroup) => (g.turnId == x), s.turnGroups);
    }
  }
}

lemma StartLiveGroup(s: Turns, room: string)
  requires alwaysGroupAllocatorValid(s)
  ensures liveGroup(s, room) == 0 ==> forall g :: g in s.groups ==> !(g.active && g.room == room)
  ensures liveGroup(s, room) != 0 ==> exists g :: g in s.groups && g.id == liveGroup(s, room) && g.active && g.room == room
{
  LiveGroupFilter(s, room);
  AlwaysGroupAllocatorValidFilter(s);
  var actives := ProofLib.Filter((g: RoomGroup) => ((g.room == room) && g.active), s.groups);
  if |actives| > 0 {
    assert actives[0] in actives;
    ProofLib.FilterMember((g: RoomGroup) => ((g.room == room) && g.active), s.groups, actives[0]);
  } else {
    forall g | g in s.groups ensures !(g.active && g.room == room) {
      ProofLib.FilterMember((g: RoomGroup) => ((g.room == room) && g.active), s.groups, g);
    }
  }
}

lemma MembersGrow(s: Turns, after: Turns, added: TurnEntry, group: int)
  requires after.controllers.turns == s.controllers.turns + [added]
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  ensures |roomGroupMembers(after, group)| >= |roomGroupMembers(s, group)|
  ensures forall k :: 0 <= k < |roomGroupMembers(s, group)| ==> roomGroupMembers(after, group)[k] == roomGroupMembers(s, group)[k]
{
  MembersAsFilter(s, group);
  MembersAsFilter(after, group);
  ProofLib.FilterSamePredicate((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0)), (t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(s, t.id) == group)) && (group > 0)), s.controllers.turns);
  ProofLib.FilterAppend((t: TurnEntry) => (((!t.phase.TurnDetached?) && (groupOf(after, t.id) == group)) && (group > 0)), s.controllers.turns, added);
}

lemma StartAllocator(s: Turns, turnId: int, room: string)
  requires alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s) && canStartTurn(s, turnId, room)
  ensures alwaysGroupAllocatorValid(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var gid, added := StartShape(s, turnId, room, after);
  if liveGroup(s, room) == 0 {
    var nw := RoomGroup(s.nextGroup, room, true);
    AlwaysGroupAllocatorValidFilter(s);
    AlwaysGroupAllocatorValidFilter(after);
    forall g | g in after.groups
      ensures g.id > 0 && g.id < after.nextGroup && |ProofLib.Filter((other: RoomGroup) => (other.id == g.id), after.groups)| == 1
      ensures g.active ==> |ProofLib.Filter((other: RoomGroup) => (other.active && (other.room == g.room)), after.groups)| == 1
    {
      ProofLib.FilterAppend((other: RoomGroup) => (other.id == g.id), s.groups, nw);
      ProofLib.FilterAppend((other: RoomGroup) => (other.active && (other.room == g.room)), s.groups, nw);
      if g == nw {
        ProofLib.FilterNone((other: RoomGroup) => (other.id == g.id), s.groups);
        ProofLib.FilterNone((other: RoomGroup) => (other.active && (other.room == g.room)), s.groups);
      }
    }
  }
}

lemma StartFrames(s: Turns, turnId: int, room: string)
  requires alwaysTurnsRetainGroups(s) && alwaysGroupAllocatorValid(s) && alwaysFramesRetainNotices(s) && alwaysNoticesUnique(s) && canStartTurn(s, turnId, room)
  ensures alwaysFramesRetainNotices(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var gid, added := StartShape(s, turnId, room, after);
  var n := |s.frames|;
  assert after.frames[..n] == s.frames[..n];
  FramesIndexed(s);
  EventIdsBelow(s);
  TurnNoticeFilters(s);
  forall i | 0 <= i < n ensures validStackFrame(after.(frames := [after.frames[i]]), after.frames[i]) {
    var f := s.frames[i];
    assert after.frames[i] == f;
    FrameAt(s, i);
    StartSolo(s, after, added, f);
  }
  var born := after.controllers.notices[|s.controllers.notices|];
  assert born in after.controllers.notices;
  SoloEvent(after, after.frames[n]);
  FramesKeep(s, after, n);
}

lemma StartSolo(s: Turns, after: Turns, added: TurnEntry, f: TurnFrame)
  requires after.controllers.turns == s.controllers.turns + [added]
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  requires forall n :: n in s.controllers.notices ==> n in after.controllers.notices
  requires forall g :: g in s.groups ==> g in after.groups
  requires validStackFrame(s.(frames := [f]), f)
  ensures validStackFrame(after.(frames := [f]), f)
{
  var a := after.(frames := [f]);
  var b := s.(frames := [f]);
  GroupOfFrame(after, a);
  GroupOfFrame(s, b);
  if f.RoomScanKind? {
    MembersGrow(b, a, added, f.group);
    if f.scan.notifying != 0 {
      var t :| t in roomGroupMembers(b, f.group) && t.id == f.scan.notifying && t.aborted && t.reason == f.scan.reason;
      var k :| 0 <= k < |roomGroupMembers(b, f.group)| && roomGroupMembers(b, f.group)[k] == t;
      assert roomGroupMembers(a, f.group)[k] in roomGroupMembers(a, f.group);
    }
  }
}

lemma StartBottom(s: Turns, turnId: int, room: string)
  requires alwaysCleanupAtBottom(s)
  ensures alwaysCleanupAtBottom(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var n := |s.frames|;
  assert after.frames[..n] == s.frames[..n];
  BottomKeep(s, after, n);
}

lemma StartLive(s: Turns, after: Turns, added: TurnEntry, gid: int, room: string)
  requires alwaysLiveGroupOwnsTurns(s) && alwaysGroupAllocatorValid(s)
  requires after.controllers.turns == s.controllers.turns + [added] && !added.phase.TurnDetached?
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  requires groupOf(after, added.id) == gid
  requires (gid == s.nextGroup && after.groups == s.groups + [RoomGroup(gid, room, true)]) || (after.groups == s.groups && exists g :: g in s.groups && g.id == gid && g.active)
  ensures alwaysLiveGroupOwnsTurns(after)
{
  assert added in after.controllers.turns;
  AlwaysGroupAllocatorValidFilter(s);
  forall g | g in after.groups
    ensures g.active == (exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id)
  {
    if g in s.groups {
      LiveFact(s, g);
      if g.id != gid {
        if exists t :: t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id {
          var t :| t in after.controllers.turns && !t.phase.TurnDetached? && groupOf(after, t.id) == g.id;
          assert t != added && t in s.controllers.turns;
        }
        if g.active {
          var t :| t in s.controllers.turns && !t.phase.TurnDetached? && groupOf(s, t.id) == g.id;
          assert t in after.controllers.turns;
        }
      } else if gid == s.nextGroup && after.groups == s.groups + [RoomGroup(gid, room, true)] {
        assert g.id < s.nextGroup;
      } else {
        var h :| h in s.groups && h.id == gid && h.active;
        var i :| 0 <= i < |s.groups| && s.groups[i] == g;
        var j :| 0 <= j < |s.groups| && s.groups[j] == h;
        if i != j {
          ProofLib.FilterTwo((other: RoomGroup) => (other.id == g.id), s.groups, i, j);
        }
      }
    }
  }
}

lemma {:induction false} StartRetain(s: Turns, after: Turns, added: TurnEntry, gid: int)
  requires alwaysTurnsRetainGroups(s)
  requires after.controllers.turns == s.controllers.turns + [added]
  requires after.turnGroups == s.turnGroups + [TurnGroup(added.id, gid)]
  requires forall g :: g in s.turnGroups ==> g.turnId != added.id
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  requires groupOf(after, added.id) == gid
  requires forall g :: g in s.groups ==> g in after.groups
  requires exists g :: g in after.groups && g.id == gid && g.room == added.room
  ensures alwaysTurnsRetainGroups(after)
{
  RetainSplit(s);
  StartRetainGroups(s, after, added, gid);
  StartRetainTurns(s, after, added, gid);
  RetainJoin(after);
}

lemma StartRetainGroups(s: Turns, after: Turns, added: TurnEntry, gid: int)
  requires forall g :: g in s.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups)| == 1 && exists t :: t in s.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in s.groups && roomGroup.id == g.group && roomGroup.room == t.room
  requires after.controllers.turns == s.controllers.turns + [added]
  requires after.turnGroups == s.turnGroups + [TurnGroup(added.id, gid)]
  requires forall g :: g in s.turnGroups ==> g.turnId != added.id
  requires forall g :: g in s.groups ==> g in after.groups
  requires exists g :: g in after.groups && g.id == gid && g.room == added.room
  ensures forall g :: g in after.turnGroups ==> |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), after.turnGroups)| == 1 && exists t :: t in after.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in after.groups && roomGroup.id == g.group && roomGroup.room == t.room
{
  var tg := TurnGroup(added.id, gid);
  assert added in after.controllers.turns;
  forall g | g in after.turnGroups
    ensures |ProofLib.Filter((other: TurnGroup) => (other.turnId == g.turnId), after.turnGroups)| == 1
    ensures exists t :: t in after.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in after.groups && roomGroup.id == g.group && roomGroup.room == t.room
  {
    ProofLib.FilterAppend((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups, tg);
    if g == tg {
      ProofLib.FilterNone((other: TurnGroup) => (other.turnId == g.turnId), s.turnGroups);
    } else {
      assert g in s.turnGroups;
      var t :| t in s.controllers.turns && t.id == g.turnId && exists roomGroup :: roomGroup in s.groups && roomGroup.id == g.group && roomGroup.room == t.room;
      assert t in after.controllers.turns;
    }
  }
}

lemma StartRetainTurns(s: Turns, after: Turns, added: TurnEntry, gid: int)
  requires forall t :: t in s.controllers.turns ==> (exists g :: g in s.turnGroups && g.turnId == t.id) && exists g :: g in s.groups && g.id == groupOf(s, t.id) && g.room == t.room
  requires after.controllers.turns == s.controllers.turns + [added]
  requires after.turnGroups == s.turnGroups + [TurnGroup(added.id, gid)]
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  requires groupOf(after, added.id) == gid
  requires forall g :: g in s.groups ==> g in after.groups
  requires exists g :: g in after.groups && g.id == gid && g.room == added.room
  ensures forall t :: t in after.controllers.turns ==> (exists g :: g in after.turnGroups && g.turnId == t.id) && exists g :: g in after.groups && g.id == groupOf(after, t.id) && g.room == t.room
{
  assert TurnGroup(added.id, gid) in after.turnGroups;
  forall t | t in after.controllers.turns
    ensures (exists g :: g in after.turnGroups && g.turnId == t.id) && exists g :: g in after.groups && g.id == groupOf(after, t.id) && g.room == t.room
  {
    if t != added {
      assert t in s.controllers.turns;
      var g :| g in s.turnGroups && g.turnId == t.id;
      assert g in after.turnGroups;
      var h :| h in s.groups && h.id == groupOf(s, t.id) && h.room == t.room;
      assert h in after.groups;
    }
  }
}

lemma StartClosed(s: Turns, after: Turns, added: TurnEntry)
  requires alwaysClosedPendingHasGlobalOwner(s)
  requires after.controllers.turns == s.controllers.turns + [added] && added.aborted == s.controllers.closed
  requires forall t :: t in s.controllers.turns ==> t.id != added.id
  requires forall x :: x != added.id ==> groupOf(after, x) == groupOf(s, x)
  requires after.controllers.closed == s.controllers.closed
  requires forall f :: f in s.frames ==> f in after.frames
  ensures alwaysClosedPendingHasGlobalOwner(after)
{
  forall t | after.controllers.closed && t in after.controllers.turns && !t.phase.TurnDetached? && !t.aborted
    ensures exists f :: f in after.frames && frameOwnsPendingTurn(after, f, t.id, groupOf(after, t.id))
  {
    assert t != added && t in s.controllers.turns;
    var g := groupOf(s, t.id);
    var f :| f in s.frames && frameOwnsPendingTurn(s, f, t.id, g);
    MembersGrow(s, after, added, g);
    Owns(s, f, t.id, g);
    Owns(after, f, t.id, g);
  }
}

lemma StartRooms(s: Turns, turnId: int, room: string)
  requires alwaysActiveRoomsMatch(s) && canStartTurn(s, turnId, room)
  ensures alwaysActiveRoomsMatch(startTurn(s, turnId, room))
{
  var after := startTurn(s, turnId, room);
  var added := after.controllers.turns[|s.controllers.turns|];
  assert after.controllers.turns == s.controllers.turns + [added];
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

lemma VisitBasics(s: Turns)
  requires inv(s) && canVisitRoomSignal(s)
  ensures alwaysActiveRoomsMatch(visitRoomSignal(s)) && alwaysOneLiveListener(visitRoomSignal(s)) && alwaysTurnIdentity(visitRoomSignal(s)) && alwaysNoticesUnique(visitRoomSignal(s))
  ensures alwaysGroupAllocatorValid(visitRoomSignal(s)) && alwaysLiveGroupOwnsTurns(visitRoomSignal(s))
  ensures stepCleanupPreservesPeers(s, "visitRoomSignal", visitRoomSignal(s)) && stepFirstAbortReasonStays(s, visitRoomSignal(s)) && stepCloseIsPermanent(s, visitRoomSignal(s)) && stepTelemetryCannotChangeResult(s, "visitRoomSignal", visitRoomSignal(s))
{
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
  RetainFull(s, after);
  VisitClosed(s); VisitFrames(s); VisitBottom(s);
}

lemma VisitRetain(s: Turns)
  requires alwaysTurnsRetainGroups(s)
  ensures alwaysTurnsRetainGroups(visitRoomSignal(s))
{
  var after := visitRoomSignal(s);
  VisitIds(s, after);
  RetainFull(s, after);
}

lemma VisitIds(s: Turns, after: Turns)
  requires after == visitRoomSignal(s)
  ensures after.turnGroups == s.turnGroups
  ensures |after.groups| == |s.groups| && forall i :: 0 <= i < |s.groups| ==> after.groups[i].id == s.groups[i].id && after.groups[i].room == s.groups[i].room
  ensures |after.controllers.turns| == |s.controllers.turns| && forall i :: 0 <= i < |s.controllers.turns| ==> after.controllers.turns[i].id == s.controllers.turns[i].id && after.controllers.turns[i].room == s.controllers.turns[i].room
{
}
