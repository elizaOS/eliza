lemma TurnIdentityFilters(s: TurnControllers)
  ensures alwaysTurnIdentity(s) == (forall t :: t in s.turns ==> t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), s.turns)| == 1)
{}

lemma TurnRoomFilters(s: TurnControllers)
  ensures alwaysActiveRoomsMatch(s) == ((forall room :: room in s.rooms ==> |ProofLib.Filter((other: string) => (other == room), s.rooms)| == 1 && (exists t :: t in s.turns && t.room == room && !t.phase.TurnDetached?)) && (forall t :: t in s.turns && !t.phase.TurnDetached? ==> t.room in s.rooms))
{}

lemma TurnNoticeFilters(s: TurnControllers)
  ensures alwaysNoticesUnique(s) == (s.nextNotice > 0 && (forall n :: n in s.notices ==> n.id > 0 && n.id < s.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), s.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)))
{}

lemma TurnListenerFilters(s: TurnControllers)
  ensures alwaysOneLiveListener(s) == (forall l :: l in s.listeners && l.present ==> |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), s.listeners)| == 1)
{}

lemma TurnIdentityMap(before: TurnControllers, after: TurnControllers)
  requires alwaysTurnIdentity(before)
  requires |before.turns| == |after.turns|
  requires forall i :: 0 <= i < |before.turns| ==> before.turns[i].id == after.turns[i].id
  ensures alwaysTurnIdentity(after)
{
  TurnIdentityFilters(before); TurnIdentityFilters(after);
  forall t | t in after.turns
    ensures t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), after.turns)| == 1
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == t;
    ProofLib.FilterLengthPointwise((other: TurnEntry) => (other.id == t.id), (other: TurnEntry) => (other.id == t.id), before.turns, after.turns);
  }
}

lemma TurnRoomMap(before: TurnControllers, after: TurnControllers)
  requires alwaysActiveRoomsMatch(before)
  requires before.rooms == after.rooms
  requires |before.turns| == |after.turns|
  requires forall i :: 0 <= i < |before.turns| ==> before.turns[i].room == after.turns[i].room && (before.turns[i].phase.TurnDetached? <==> after.turns[i].phase.TurnDetached?)
  ensures alwaysActiveRoomsMatch(after)
{
  TurnRoomFilters(before); TurnRoomFilters(after);
  forall room | room in after.rooms
    ensures exists t :: t in after.turns && t.room == room && !t.phase.TurnDetached?
  {
    var t :| t in before.turns && t.room == room && !t.phase.TurnDetached?;
    var i :| 0 <= i < |before.turns| && before.turns[i] == t;
    assert after.turns[i] in after.turns;
  }
  forall t | t in after.turns && !t.phase.TurnDetached? ensures t.room in after.rooms
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == t;
    assert before.turns[i] in before.turns;
  }
}

lemma AbortMap(before: TurnControllers, after: TurnControllers)
  requires |before.turns| == |after.turns|
  requires forall i :: 0 <= i < |before.turns| ==> before.turns[i].id == after.turns[i].id && (before.turns[i].aborted ==> after.turns[i].aborted && before.turns[i].reason == after.turns[i].reason)
  ensures stepFirstAbortReasonStays(before, after)
{
  forall t | t in before.turns && t.aborted
    ensures exists other :: other in after.turns && other.id == t.id && other.aborted && other.reason == t.reason
  {
    var i :| 0 <= i < |before.turns| && before.turns[i] == t;
    assert after.turns[i] in after.turns;
  }
}

lemma NoticeIdentityAppend(before: TurnControllers, added: TurnNotice)
  requires alwaysNoticesUnique(before)
  requires added.id == before.nextNotice
  requires forall generation :: generation in added.delivered ==> generation <= added.cursor
  ensures alwaysNoticesUnique(before.(notices := before.notices + [added], nextNotice := before.nextNotice + 1))
{
  var after := before.(notices := before.notices + [added], nextNotice := before.nextNotice + 1);
  TurnNoticeFilters(before); TurnNoticeFilters(after);
  forall n | n in after.notices
    ensures n.id > 0 && n.id < after.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), after.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)
  {
    ProofLib.FilterAppend((other: TurnNotice) => (other.id == n.id), before.notices, added);
    if n.id == added.id { ProofLib.FilterNone((other: TurnNotice) => (other.id == n.id), before.notices); }
    else { assert n in before.notices; }
  }
}

lemma NoticeIdentityMap(before: TurnControllers, after: TurnControllers)
  requires alwaysNoticesUnique(before)
  requires before.nextNotice == after.nextNotice
  requires |before.notices| == |after.notices|
  requires forall i :: 0 <= i < |before.notices| ==> before.notices[i].id == after.notices[i].id && (forall generation :: generation in after.notices[i].delivered ==> generation <= after.notices[i].cursor)
  ensures alwaysNoticesUnique(after)
{
  TurnNoticeFilters(before); TurnNoticeFilters(after);
  forall n | n in after.notices
    ensures n.id > 0 && n.id < after.nextNotice && |ProofLib.Filter((other: TurnNotice) => (other.id == n.id), after.notices)| == 1 && (forall generation :: generation in n.delivered ==> generation <= n.cursor)
  {
    var i :| 0 <= i < |after.notices| && after.notices[i] == n;
    ProofLib.FilterLengthPointwise((other: TurnNotice) => (other.id == n.id), (other: TurnNotice) => (other.id == n.id), before.notices, after.notices);
  }
}

lemma TurnLookup(s: TurnControllers, turnId: int)
  ensures controller(s, turnId) == (var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.turns); if |matches| > 0 then matches[0] else noTurn)
{}

lemma LookupTurns(s: TurnControllers, turnId: int)
  requires alwaysTurnIdentity(s)
  ensures controller(s, turnId).id > 0 ==> controller(s, turnId) in s.turns && controller(s, turnId).id == turnId
  ensures forall t :: t in s.turns && t.id == turnId ==> t == controller(s, turnId)
{
  TurnLookup(s, turnId); TurnIdentityFilters(s);
  var matches := ProofLib.Filter((t: TurnEntry) => (t.id == turnId), s.turns);
  if |matches| > 0 {
    var selected := matches[0];
    ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.turns, selected);
    ProofLib.FilterSamePredicate((t: TurnEntry) => (t.id == turnId), (other: TurnEntry) => (other.id == selected.id), s.turns);
    assert |matches| == 1;
    forall t | t in s.turns && t.id == turnId ensures t == selected
    { ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.turns, t); }
  } else {
    forall t | t in s.turns && t.id == turnId ensures t == controller(s, turnId)
    { ProofLib.FilterMember((t: TurnEntry) => (t.id == turnId), s.turns, t); }
  }
}

lemma AppendTurnIdentity(s: TurnControllers, after: TurnControllers, added: TurnEntry)
  requires alwaysTurnIdentity(s)
  requires added.id > 0 && !(exists t :: t in s.turns && t.id == added.id)
  requires after.turns == s.turns + [added]
  ensures alwaysTurnIdentity(after)
{
  TurnIdentityFilters(s); TurnIdentityFilters(after);
  forall t | t in after.turns ensures t.id > 0 && |ProofLib.Filter((other: TurnEntry) => (other.id == t.id), after.turns)| == 1
  {
    ProofLib.FilterAppend((other: TurnEntry) => (other.id == t.id), s.turns, added);
    if t.id == added.id { ProofLib.FilterNone((other: TurnEntry) => (other.id == t.id), s.turns); }
    else { assert t in s.turns; }
  }
}

lemma AbortNoticeBatch(s: TurnControllers, rooms: seq<string>, reason: string)
  requires alwaysNoticesUnique(s)
  ensures alwaysNoticesUnique(s.(notices := s.notices + Std.Collections.Seq.FoldLeft((events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]), emptyNotices, rooms), nextNotice := s.nextNotice + |rooms|))
  ensures |Std.Collections.Seq.FoldLeft((events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]), emptyNotices, rooms)| == |rooms|
  decreases |rooms|
{
  assert emptyNotices == [];
  if |rooms| > 0 {
    var prefix := rooms[..|rooms| - 1];
    var last := rooms[|rooms| - 1];
    assert rooms == prefix + [last];
    AbortNoticeBatch(s, prefix, reason);
    var made := Std.Collections.Seq.FoldLeft((events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]), emptyNotices, prefix);
    ProofLib.FoldLeftAppend((events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]), emptyNotices, prefix, last);
    var prior := s.(notices := s.notices + made, nextNotice := s.nextNotice + |prefix|);
    var added := freshNotice(prior.nextNotice, TurnNoticeKind.TurnAborted, last, reason, "", 0);
    NoticeIdentityAppend(prior, added);
    var foldStep := (events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]);
    assert Std.Collections.Seq.FoldLeft(foldStep, emptyNotices, rooms) == made + [added];
    assert s.notices + (made + [added]) == (s.notices + made) + [added];
    assert |rooms| == |prefix| + 1;
    assert alwaysNoticesUnique(s.(notices := (s.notices + made) + [added], nextNotice := s.nextNotice + |rooms|));
  } else {
    assert rooms == [];
    assert Std.Collections.Seq.FoldLeft((events: seq<TurnNotice>, room: string) => (events + [freshNotice((s.nextNotice + |events|), TurnNoticeKind.TurnAborted, room, reason, "", 0)]), emptyNotices, rooms) == [];
    assert s.(notices := s.notices + [], nextNotice := s.nextNotice) == s;
  }
}

lemma CleanupRoomProjection(s: TurnControllers, turnId: int)
  ensures cleanupTurn(s, turnId).rooms == (var room := controller(s, turnId).room; if (exists t :: t in s.turns && t.id != turnId && t.room == room && !t.phase.TurnDetached?) then s.rooms else ProofLib.Filter((r: string) => (r != room), s.rooms))
{}

lemma startTurn_ensures(s: TurnControllers, turnId: int, room: string)
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysTurnIdentity(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysActiveRoomsMatch(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysClosedActiveTurnsAborted(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysOneLiveListener(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> alwaysNoticesUnique(startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepCleanupPreservesPeers(s, "startTurn", startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepFirstAbortReasonStays(s, startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepCloseIsPermanent(s, startTurn(s, turnId, room)))
  ensures (inv(s) ==> canStartTurn(s, turnId, room) ==> stepTelemetryCannotChangeResult(s, "startTurn", startTurn(s, turnId, room)))
{
  if inv(s) && canStartTurn(s, turnId, room) {
    var after := startTurn(s, turnId, room);
    var added := after.turns[|s.turns|];
    AppendTurnIdentity(s, after, added);
    NoticeIdentityAppend(s, freshNotice(s.nextNotice, TurnNoticeKind.TurnStarted, room, "", "", 0));
    TurnRoomFilters(s); TurnRoomFilters(after);
    forall candidate | candidate in after.rooms
      ensures |ProofLib.Filter((other: string) => (other == candidate), after.rooms)| == 1 && (exists t :: t in after.turns && t.room == candidate && !t.phase.TurnDetached?)
    {
      if room !in s.rooms {
        ProofLib.FilterAppend((other: string) => (other == candidate), s.rooms, room);
        if candidate == room { ProofLib.FilterNone((other: string) => (other == candidate), s.rooms); }
      }
      if candidate == room { assert added in after.turns; }
      else { assert candidate in s.rooms; }
    }
  }
}

lemma returnTurn_ensures(s: TurnControllers, turnId: int, resolved: bool, errorId: string)
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysTurnIdentity(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysActiveRoomsMatch(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysClosedActiveTurnsAborted(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysOneLiveListener(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> alwaysNoticesUnique(returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCleanupPreservesPeers(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepFirstAbortReasonStays(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepCloseIsPermanent(s, returnTurn(s, turnId, resolved, errorId)))
  ensures (inv(s) ==> canReturnTurn(s, turnId, resolved, errorId) ==> stepTelemetryCannotChangeResult(s, "returnTurn", returnTurn(s, turnId, resolved, errorId)))
{
  if inv(s) && canReturnTurn(s, turnId, resolved, errorId) {
    var after := returnTurn(s, turnId, resolved, errorId);
    var selected := controller(s, turnId);
    LookupTurns(s, turnId);
    TurnIdentityMap(s, after); TurnRoomMap(s, after); AbortMap(s, after);
    NoticeIdentityAppend(s, after.notices[|s.notices|]);
    forall t | t in after.turns && !t.phase.TurnDetached?
      ensures s.closed ==> t.aborted
    {
      var i :| 0 <= i < |after.turns| && after.turns[i] == t;
      assert s.turns[i] in s.turns;
    }
  }
}

lemma CleanupActiveRooms(s: TurnControllers, turnId: int)
  requires inv(s) && canCleanupTurn(s, turnId)
  ensures alwaysActiveRoomsMatch(cleanupTurn(s, turnId))
{
    var after := cleanupTurn(s, turnId);
    var selected := controller(s, turnId);
    LookupTurns(s, turnId);
    CleanupRoomProjection(s, turnId);
    TurnRoomFilters(s); TurnRoomFilters(after);
    forall room | room in after.rooms
      ensures |ProofLib.Filter((other: string) => (other == room), after.rooms)| == 1 && (exists t :: t in after.turns && t.room == room && !t.phase.TurnDetached?)
    {
      if ! (exists t :: t in s.turns && t.id != turnId && t.room == selected.room && !t.phase.TurnDetached?) {
        ProofLib.FilterMember((r: string) => (r != selected.room), s.rooms, room);
        ProofLib.FilterOfFilterShorter((r: string) => (r != selected.room), (other: string) => (other == room), s.rooms);
        ProofLib.FilterMember((other: string) => (other == room), after.rooms, room);
      }
      assert room in s.rooms;
      var t :| t in s.turns && t.id != turnId && t.room == room && !t.phase.TurnDetached?;
      var i :| 0 <= i < |s.turns| && s.turns[i] == t;
      assert after.turns[i] in after.turns;
    }
    forall t | t in after.turns && !t.phase.TurnDetached?
      ensures t.room in after.rooms
    {
      var i :| 0 <= i < |after.turns| && after.turns[i] == t;
      assert s.turns[i] == t && t.id != turnId && t in s.turns;
      if after.rooms != s.rooms { ProofLib.FilterMember((r: string) => (r != selected.room), s.rooms, t.room); }
    }
}

lemma cleanupTurn_ensures(s: TurnControllers, turnId: int)
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysTurnIdentity(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysActiveRoomsMatch(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysClosedActiveTurnsAborted(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysOneLiveListener(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> alwaysNoticesUnique(cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCleanupPreservesPeers(s, "cleanupTurn", cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepFirstAbortReasonStays(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepCloseIsPermanent(s, cleanupTurn(s, turnId)))
  ensures (inv(s) ==> canCleanupTurn(s, turnId) ==> stepTelemetryCannotChangeResult(s, "cleanupTurn", cleanupTurn(s, turnId)))
{
  if inv(s) && canCleanupTurn(s, turnId) {
    var after := cleanupTurn(s, turnId);
    TurnIdentityMap(s, after); AbortMap(s, after);
    CleanupActiveRooms(s, turnId);
    forall prior | prior in s.turns
      ensures exists t :: t in after.turns && t.id == prior.id && t.aborted == prior.aborted && t.reason == prior.reason
    {
      var i :| 0 <= i < |s.turns| && s.turns[i] == prior;
      assert after.turns[i] in after.turns;
    }
  }
}

lemma abortRoom_ensures(s: TurnControllers, room: string, selfId: int, reason: string)
  ensures (inv(s) ==> alwaysTurnIdentity(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> alwaysActiveRoomsMatch(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> alwaysClosedActiveTurnsAborted(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> alwaysOneLiveListener(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> alwaysNoticesUnique(abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> stepCleanupPreservesPeers(s, "abortRoom", abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> stepFirstAbortReasonStays(s, abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> stepCloseIsPermanent(s, abortRoom(s, room, selfId, reason)))
  ensures (inv(s) ==> stepTelemetryCannotChangeResult(s, "abortRoom", abortRoom(s, room, selfId, reason)))
{
  if inv(s) {
    var after := abortRoom(s, room, selfId, reason);
    TurnIdentityMap(s, after); TurnRoomMap(s, after); AbortMap(s, after);
    if hasAbortableTurn(s, room, selfId) { NoticeIdentityAppend(s, freshNotice(s.nextNotice, TurnNoticeKind.TurnAborted, room, reason, "", 0)); }
  }
}

lemma abortAll_ensures(s: TurnControllers, reason: string)
  ensures (inv(s) ==> alwaysTurnIdentity(abortAll(s, reason)))
  ensures (inv(s) ==> alwaysActiveRoomsMatch(abortAll(s, reason)))
  ensures (inv(s) ==> alwaysClosedActiveTurnsAborted(abortAll(s, reason)))
  ensures (inv(s) ==> alwaysOneLiveListener(abortAll(s, reason)))
  ensures (inv(s) ==> alwaysNoticesUnique(abortAll(s, reason)))
  ensures (inv(s) ==> stepCleanupPreservesPeers(s, "abortAll", abortAll(s, reason)))
  ensures (inv(s) ==> stepFirstAbortReasonStays(s, abortAll(s, reason)))
  ensures (inv(s) ==> stepCloseIsPermanent(s, abortAll(s, reason)))
  ensures (inv(s) ==> stepTelemetryCannotChangeResult(s, "abortAll", abortAll(s, reason)))
{
  if inv(s) {
    var after := abortAll(s, reason);
    TurnIdentityMap(s, after); TurnRoomMap(s, after); AbortMap(s, after);
    AbortNoticeBatch(s, abortableRooms(s), reason);
  }
}

lemma closeTurns_ensures(s: TurnControllers, reason: string)
  ensures (inv(s) ==> alwaysTurnIdentity(closeTurns(s, reason)))
  ensures (inv(s) ==> alwaysActiveRoomsMatch(closeTurns(s, reason)))
  ensures (inv(s) ==> alwaysClosedActiveTurnsAborted(closeTurns(s, reason)))
  ensures (inv(s) ==> alwaysOneLiveListener(closeTurns(s, reason)))
  ensures (inv(s) ==> alwaysNoticesUnique(closeTurns(s, reason)))
  ensures (inv(s) ==> stepCleanupPreservesPeers(s, "closeTurns", closeTurns(s, reason)))
  ensures (inv(s) ==> stepFirstAbortReasonStays(s, closeTurns(s, reason)))
  ensures (inv(s) ==> stepCloseIsPermanent(s, closeTurns(s, reason)))
  ensures (inv(s) ==> stepTelemetryCannotChangeResult(s, "closeTurns", closeTurns(s, reason)))
{
  if inv(s) { abortAll_ensures(s, reason); }
}

lemma subscribeTurnEvents_ensures(s: TurnControllers, callback: int)
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> alwaysTurnIdentity(subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> alwaysActiveRoomsMatch(subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> alwaysClosedActiveTurnsAborted(subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> alwaysOneLiveListener(subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> alwaysNoticesUnique(subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> stepCleanupPreservesPeers(s, "subscribeTurnEvents", subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> stepFirstAbortReasonStays(s, subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> stepCloseIsPermanent(s, subscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> canSubscribeTurnEvents(s, callback) ==> stepTelemetryCannotChangeResult(s, "subscribeTurnEvents", subscribeTurnEvents(s, callback)))
{
  if inv(s) && canSubscribeTurnEvents(s, callback) && !(exists l :: l in s.listeners && l.callback == callback && l.present) {
    var after := subscribeTurnEvents(s, callback);
    var added := TurnListener(callback, s.nextListener, true);
    TurnListenerFilters(s); TurnListenerFilters(after);
    forall l | l in after.listeners && l.present
      ensures |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), after.listeners)| == 1
    {
      ProofLib.FilterAppend((other: TurnListener) => ((other.callback == l.callback) && other.present), s.listeners, added);
      if l.callback == callback { ProofLib.FilterNone((other: TurnListener) => ((other.callback == l.callback) && other.present), s.listeners); }
      else { assert l in s.listeners; }
    }
  }
}

lemma unsubscribeTurnEvents_ensures(s: TurnControllers, callback: int)
  ensures (inv(s) ==> alwaysTurnIdentity(unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> alwaysActiveRoomsMatch(unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> alwaysClosedActiveTurnsAborted(unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> alwaysOneLiveListener(unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> alwaysNoticesUnique(unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> stepCleanupPreservesPeers(s, "unsubscribeTurnEvents", unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> stepFirstAbortReasonStays(s, unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> stepCloseIsPermanent(s, unsubscribeTurnEvents(s, callback)))
  ensures (inv(s) ==> stepTelemetryCannotChangeResult(s, "unsubscribeTurnEvents", unsubscribeTurnEvents(s, callback)))
{
  if inv(s) {
    var after := unsubscribeTurnEvents(s, callback);
    TurnListenerFilters(s); TurnListenerFilters(after);
    forall l | l in after.listeners && l.present
      ensures |ProofLib.Filter((other: TurnListener) => ((other.callback == l.callback) && other.present), after.listeners)| == 1
    {
      var i :| 0 <= i < |after.listeners| && after.listeners[i] == l;
      assert l.callback != callback && s.listeners[i] == l;
      ProofLib.FilterLengthPointwise((other: TurnListener) => ((other.callback == l.callback) && other.present), (other: TurnListener) => ((other.callback == l.callback) && other.present), s.listeners, after.listeners);
    }
  }
}

lemma finishTurnNotice_ensures(s: TurnControllers, noticeId: int)
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> alwaysTurnIdentity(finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> alwaysActiveRoomsMatch(finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> alwaysClosedActiveTurnsAborted(finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> alwaysOneLiveListener(finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> alwaysNoticesUnique(finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> stepCleanupPreservesPeers(s, "finishTurnNotice", finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> stepFirstAbortReasonStays(s, finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> stepCloseIsPermanent(s, finishTurnNotice(s, noticeId)))
  ensures (inv(s) ==> canFinishTurnNotice(s, noticeId) ==> stepTelemetryCannotChangeResult(s, "finishTurnNotice", finishTurnNotice(s, noticeId)))
{
  if inv(s) && canFinishTurnNotice(s, noticeId) { NoticeIdentityMap(s, finishTurnNotice(s, noticeId)); }
}

lemma TurnNoticeLookup(s: TurnControllers, noticeId: int)
  ensures notice(s, noticeId) == (var matches := ProofLib.Filter((n: TurnNotice) => (n.id == noticeId), s.notices); if |matches| > 0 then matches[0] else noNotice)
{}

lemma TurnListenerLookup(s: TurnControllers, noticeId: int)
  ensures nextTurnListener(s, noticeId) == (var local_6 := notice(s, noticeId); var matches := ProofLib.Filter((l: TurnListener) => (l.present && (l.generation > local_6.cursor)), s.listeners); if |matches| > 0 then matches[0] else TurnListener(0, 0, false))
{}

lemma LookupNoticeCursor(s: TurnControllers, noticeId: int)
  requires inv(s)
  requires canVisitTurnListener(s, noticeId, true)
  ensures forall n :: n in s.notices && n.id == noticeId ==> nextTurnListener(s, noticeId).generation > n.cursor
{
  TurnNoticeLookup(s, noticeId); TurnListenerLookup(s, noticeId); TurnNoticeFilters(s);
  var matches := ProofLib.Filter((n: TurnNotice) => (n.id == noticeId), s.notices);
  assert |matches| > 0;
  var selected := matches[0];
  ProofLib.FilterMember((n: TurnNotice) => (n.id == noticeId), s.notices, selected);
  ProofLib.FilterSamePredicate((n: TurnNotice) => (n.id == noticeId), (other: TurnNotice) => (other.id == selected.id), s.notices);
  assert |matches| == 1;
  var local_6 := notice(s, noticeId);
  var listeners := ProofLib.Filter((l: TurnListener) => (l.present && (l.generation > local_6.cursor)), s.listeners);
  assert |listeners| > 0;
  ProofLib.FilterMember((l: TurnListener) => (l.present && (l.generation > local_6.cursor)), s.listeners, listeners[0]);
  forall n | n in s.notices && n.id == noticeId ensures nextTurnListener(s, noticeId).generation > n.cursor
  { ProofLib.FilterMember((n: TurnNotice) => (n.id == noticeId), s.notices, n); }
}

lemma visitTurnListener_ensures(s: TurnControllers, noticeId: int, ok: bool)
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> alwaysTurnIdentity(visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> alwaysActiveRoomsMatch(visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> alwaysClosedActiveTurnsAborted(visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> alwaysOneLiveListener(visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> alwaysNoticesUnique(visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> stepCleanupPreservesPeers(s, "visitTurnListener", visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> stepFirstAbortReasonStays(s, visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> stepCloseIsPermanent(s, visitTurnListener(s, noticeId, ok)))
  ensures (inv(s) ==> canVisitTurnListener(s, noticeId, ok) ==> stepTelemetryCannotChangeResult(s, "visitTurnListener", visitTurnListener(s, noticeId, ok)))
{
  if inv(s) && canVisitTurnListener(s, noticeId, ok) {
    LookupNoticeCursor(s, noticeId);
    var after := visitTurnListener(s, noticeId, ok);
    forall i | 0 <= i < |s.notices|
      ensures forall generation :: generation in after.notices[i].delivered ==> generation <= after.notices[i].cursor
    { assert s.notices[i] in s.notices; }
    NoticeIdentityMap(s, after);
  }
}
