lemma send_ensures(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> alwaysHeardBoundaryInsideTheReply(send(s, room, key, fingerprint, now, inferenceReady).state))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> stepRefusalsAndRepeatsStoreNothing(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> stepARecordedKeyNeverRunsAgain(s, send(s, room, key, fingerprint, now, inferenceReady).state))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> stepStopAnswersAreTrue(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out))
  ensures (inv(s) ==> canSend(s, room, key, fingerprint, now, inferenceReady) ==> stepStoredRepliesStayWhole(s, send(s, room, key, fingerprint, now, inferenceReady).state))
{
  hide *;
  if inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady) {
    TurnsSend(s, room, key, fingerprint, now, inferenceReady);
    TurnsSendSteps(s, room, key, fingerprint, now, inferenceReady);
  }
}

lemma endTurn_ensures(s: Turns, turn: int, kind: ReplyKind, units: seq<int>, now: int)
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> alwaysOneTurnPerRoomWithFreshIds(endTurn(s, turn, kind, units, now).state))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> alwaysKeyedTurnsHoldTheirRecord(endTurn(s, turn, kind, units, now).state))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> alwaysAnsweredKeysNameTheirReply(endTurn(s, turn, kind, units, now).state))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> alwaysHeardBoundaryInsideTheReply(endTurn(s, turn, kind, units, now).state))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> stepRefusalsAndRepeatsStoreNothing(s, "endTurn", endTurn(s, turn, kind, units, now).state, endTurn(s, turn, kind, units, now).out))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> stepARecordedKeyNeverRunsAgain(s, endTurn(s, turn, kind, units, now).state))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> stepStopAnswersAreTrue(s, "endTurn", endTurn(s, turn, kind, units, now).state, endTurn(s, turn, kind, units, now).out))
  ensures (inv(s) ==> canEndTurn(s, turn, kind, now) ==> stepStoredRepliesStayWhole(s, endTurn(s, turn, kind, units, now).state))
{
  if inv(s) && canEndTurn(s, turn, kind, now) {
    TurnsEndTurn(s, turn, kind, units, now);
  }
}

lemma endWithoutReply_ensures(s: Turns, turn: int, now: int)
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> alwaysOneTurnPerRoomWithFreshIds(endWithoutReply(s, turn, now).state))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> alwaysKeyedTurnsHoldTheirRecord(endWithoutReply(s, turn, now).state))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> alwaysAnsweredKeysNameTheirReply(endWithoutReply(s, turn, now).state))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> alwaysHeardBoundaryInsideTheReply(endWithoutReply(s, turn, now).state))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> stepRefusalsAndRepeatsStoreNothing(s, "endWithoutReply", endWithoutReply(s, turn, now).state, endWithoutReply(s, turn, now).out))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> stepARecordedKeyNeverRunsAgain(s, endWithoutReply(s, turn, now).state))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> stepStopAnswersAreTrue(s, "endWithoutReply", endWithoutReply(s, turn, now).state, endWithoutReply(s, turn, now).out))
  ensures (inv(s) ==> canEndWithoutReply(s, turn) ==> stepStoredRepliesStayWhole(s, endWithoutReply(s, turn, now).state))
{
  if inv(s) && canEndWithoutReply(s, turn) {
    TurnsEndWithoutReply(s, turn, now);
  }
}

lemma restart_ensures(s: Turns)
  ensures (inv(s) ==> alwaysOneTurnPerRoomWithFreshIds(restart(s)))
  ensures (inv(s) ==> alwaysKeyedTurnsHoldTheirRecord(restart(s)))
  ensures (inv(s) ==> alwaysAnsweredKeysNameTheirReply(restart(s)))
  ensures (inv(s) ==> alwaysHeardBoundaryInsideTheReply(restart(s)))
  ensures (inv(s) ==> stepRefusalsAndRepeatsStoreNothing(s, "restart", restart(s), []))
  ensures (inv(s) ==> stepARecordedKeyNeverRunsAgain(s, restart(s)))
  ensures (inv(s) ==> stepStopAnswersAreTrue(s, "restart", restart(s), []))
  ensures (inv(s) ==> stepStoredRepliesStayWhole(s, restart(s)))
{
  if inv(s) {
    TurnsRestart(s);
  }
}

lemma stopDeadline_ensures(s: Turns, room: int, now: int)
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> alwaysOneTurnPerRoomWithFreshIds(stopDeadline(s, room, now).state))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> alwaysKeyedTurnsHoldTheirRecord(stopDeadline(s, room, now).state))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> alwaysAnsweredKeysNameTheirReply(stopDeadline(s, room, now).state))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> alwaysHeardBoundaryInsideTheReply(stopDeadline(s, room, now).state))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> stepRefusalsAndRepeatsStoreNothing(s, "stopDeadline", stopDeadline(s, room, now).state, stopDeadline(s, room, now).out))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> stepARecordedKeyNeverRunsAgain(s, stopDeadline(s, room, now).state))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> stepStopAnswersAreTrue(s, "stopDeadline", stopDeadline(s, room, now).state, stopDeadline(s, room, now).out))
  ensures (inv(s) ==> canStopDeadline(s, room, now) ==> stepStoredRepliesStayWhole(s, stopDeadline(s, room, now).state))
{
  if inv(s) && canStopDeadline(s, room, now) {
    TurnsStopDeadline(s, room, now);
  }
}

lemma requestStop_ensures(s: Turns, room: int, now: int)
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> alwaysOneTurnPerRoomWithFreshIds(requestStop(s, room, now).state))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> alwaysKeyedTurnsHoldTheirRecord(requestStop(s, room, now).state))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> alwaysAnsweredKeysNameTheirReply(requestStop(s, room, now).state))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> alwaysHeardBoundaryInsideTheReply(requestStop(s, room, now).state))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> stepRefusalsAndRepeatsStoreNothing(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> stepARecordedKeyNeverRunsAgain(s, requestStop(s, room, now).state))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> stepStopAnswersAreTrue(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out))
  ensures (inv(s) ==> canRequestStop(s, room, now) ==> stepStoredRepliesStayWhole(s, requestStop(s, room, now).state))
{
  hide *;
  if inv(s) && canRequestStop(s, room, now) {
    TurnsRequestStop(s, room, now);
    TurnsRequestStopSteps(s, room, now);
  }
}

lemma reportHeard_ensures(s: Turns, room: int, reply: int, report: HeardReport)
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> alwaysOneTurnPerRoomWithFreshIds(reportHeard(s, room, reply, report).state))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> alwaysKeyedTurnsHoldTheirRecord(reportHeard(s, room, reply, report).state))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> alwaysAnsweredKeysNameTheirReply(reportHeard(s, room, reply, report).state))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> alwaysHeardBoundaryInsideTheReply(reportHeard(s, room, reply, report).state))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> stepRefusalsAndRepeatsStoreNothing(s, "reportHeard", reportHeard(s, room, reply, report).state, reportHeard(s, room, reply, report).out))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> stepARecordedKeyNeverRunsAgain(s, reportHeard(s, room, reply, report).state))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> stepStopAnswersAreTrue(s, "reportHeard", reportHeard(s, room, reply, report).state, reportHeard(s, room, reply, report).out))
  ensures (inv(s) ==> canReportHeard(s, room, reply, report) ==> stepStoredRepliesStayWhole(s, reportHeard(s, room, reply, report).state))
{
  if inv(s) && canReportHeard(s, room, reply, report) {
    TurnsReportHeard(s, room, reply, report);
  }
}

lemma lawHeardAndUnheardMakeTheReply_ensures(r: Reply)
  ensures (lawHeardAndUnheardMakeTheReply(r) == true)
{
  var b := boundaryOf(r);
  if 0 <= b <= |r.units| {
    TurnsSlice(r.units, 0, b);
    TurnsSlice(r.units, b, |r.units|);
    assert r.units == r.units[0..b] + r.units[b..|r.units|];
  }
}

// spec/agent/conversation/turns.md: the rules of turns, read with the filters of the proof library.
lemma TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s: Turns)
  ensures alwaysOneTurnPerRoomWithFreshIds(s) == ((((s.nextId >= 1) && !((exists t :: t in s.turns && !((((((t.id >= 1) && (t.id < s.nextId)) && (t.room >= 1)) && (|ProofLib.Filter((u: Turn) => (u.room == t.room), s.turns)| == 1)) && (|ProofLib.Filter((u: Turn) => (u.id == t.id), s.turns)| == 1)))))) && !((exists r :: r in s.replies && !((((r.id >= 1) && (r.id < s.nextId)) && (|ProofLib.Filter((x: Reply) => (x.id == r.id), s.replies)| == 1)))))))
{
}

lemma TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s: Turns)
  ensures alwaysKeyedTurnsHoldTheirRecord(s) == ((!((exists q :: q in s.records && !(((((((q.key != "") && (q.room >= 1)) && (q.userMessage >= 1)) && (q.userMessage < s.nextId)) && (|ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records)| == 1)) && (!((runningTurn(q.phase) > 0)) || ((q.userMessage == runningTurn(q.phase)) && (exists t :: t in s.turns && (((t.id == runningTurn(q.phase)) && (t.room == q.room)) && (t.key == q.key))))))))) && !((exists t :: t in s.turns && !((!((t.key != "")) || (exists q :: q in s.records && (((q.room == t.room) && (q.key == t.key)) && (runningTurn(q.phase) == t.id)))))))))
{
}

lemma TurnsRecordAtFilter(s: Turns, room: int, key: string)
  ensures recordAt(s, room, key) == (if ((0 <= 0) && (0 < |ProofLib.Filter((q: KeyRecord) => ((q.room == room) && (q.key == key)), s.records)|)) then
    ProofLib.Filter((q: KeyRecord) => ((q.room == room) && (q.key == key)), s.records)[0]
  else
    noRecord)
{
}

lemma TurnsTurnAtFilter(s: Turns, turn: int)
  ensures turnAt(s, turn) == (if ((0 <= 0) && (0 < |ProofLib.Filter((t: Turn) => (t.id == turn), s.turns)|)) then
    ProofLib.Filter((t: Turn) => (t.id == turn), s.turns)[0]
  else
    noTurn)
{
}

lemma TurnsTurnInRoomFilter(s: Turns, room: int)
  ensures turnInRoom(s, room) == (if ((0 <= 0) && (0 < |ProofLib.Filter((t: Turn) => (t.room == room), s.turns)|)) then
    ProofLib.Filter((t: Turn) => (t.room == room), s.turns)[0]
  else
    noTurn)
{
}

// spec/agent/conversation/turns.md: a key, a turn id and a room each name one entry.
lemma TurnsOnly<T>(p: T -> bool, xs: seq<T>, x: T)
  requires |ProofLib.Filter(p, xs)| == 1 && x in xs && p(x)
  ensures ProofLib.Filter(p, xs) == [x]
  ensures forall y :: y in xs && p(y) ==> y == x
{
  ProofLib.FilterMember(p, xs, x);
  assert ProofLib.Filter(p, xs)[0] == x;
  forall y | y in xs && p(y)
    ensures y == x
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma TurnsFirst<T>(p: T -> bool, xs: seq<T>)
  requires |ProofLib.Filter(p, xs)| > 0
  ensures ProofLib.Filter(p, xs)[0] in xs && p(ProofLib.Filter(p, xs)[0])
{
  ProofLib.FilterMember(p, xs, ProofLib.Filter(p, xs)[0]);
}

lemma TurnsNone<T>(p: T -> bool, xs: seq<T>)
  requires forall y :: y in xs ==> !p(y)
  ensures |ProofLib.Filter(p, xs)| == 0
{
  ProofLib.FilterNone(p, xs);
}

lemma TurnsAppend<T>(p: T -> bool, xs: seq<T>, n: T)
  ensures |ProofLib.Filter(p, xs + [n])| == |ProofLib.Filter(p, xs)| + (if p(n) then 1 else 0)
{
  ProofLib.FilterAppend(p, xs, n);
}

lemma TurnsKept<T>(items: seq<T>, kept: T -> bool, same: T -> bool, x: T)
  requires x in items && kept(x) && same(x)
  requires |ProofLib.Filter(same, items)| == 1
  ensures |ProofLib.Filter(same, ProofLib.Filter(kept, items))| == 1
{
  var filtered := ProofLib.Filter(kept, items);
  ProofLib.FilterMember(kept, items, x);
  ProofLib.FilterMember(same, filtered, x);
  ProofLib.FilterOfFilterLength(kept, same, same, items);
}

// spec/agent/conversation/turns.md: a key's durable record is found by its room and key.
lemma TurnsRecordFacts(s: Turns, room: int, key: string)
  requires alwaysKeyedTurnsHoldTheirRecord(s)
  ensures recordAt(s, room, key).room == 0 ==> forall q :: q in s.records ==> !(q.room == room && q.key == key)
  ensures recordAt(s, room, key).room != 0 ==> recordAt(s, room, key) in s.records && recordAt(s, room, key).room == room && recordAt(s, room, key).key == key
  ensures recordAt(s, room, key).room != 0 ==> forall q :: q in s.records && q.room == room && q.key == key ==> q == recordAt(s, room, key)
{
  TurnsRecordAtFilter(s, room, key);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  var p := (q: KeyRecord) => ((q.room == room) && (q.key == key));
  if |ProofLib.Filter(p, s.records)| > 0 {
    TurnsFirst(p, s.records);
    var r := ProofLib.Filter(p, s.records)[0];
    var same := (o: KeyRecord) => ((o.room == r.room) && (o.key == r.key));
    assert |ProofLib.Filter(same, s.records)| == 1;
    ProofLib.FilterSamePredicate(p, same, s.records);
    TurnsOnly(p, s.records, r);
  } else {
    forall q | q in s.records
      ensures !(q.room == room && q.key == key)
    {
      ProofLib.FilterMember(p, s.records, q);
    }
  }
}

// spec/agent/conversation/turns.md: a turn is found by its id, and holds its room alone.
lemma TurnsTurnFacts(s: Turns, turn: int)
  requires alwaysOneTurnPerRoomWithFreshIds(s)
  requires turn >= 1 && turnAt(s, turn).id == turn
  ensures turnAt(s, turn) in s.turns
  ensures forall x :: x in s.turns && x.id == turn ==> x == turnAt(s, turn)
  ensures forall x :: x in s.turns && x.room == turnAt(s, turn).room ==> x == turnAt(s, turn)
{
  TurnsTurnAtFilter(s, turn);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  var p := (t: Turn) => (t.id == turn);
  assert |ProofLib.Filter(p, s.turns)| > 0;
  TurnsFirst(p, s.turns);
  var tr := ProofLib.Filter(p, s.turns)[0];
  ProofLib.FilterSamePredicate(p, (u: Turn) => (u.id == tr.id), s.turns);
  TurnsOnly(p, s.turns, tr);
  TurnsOnly((u: Turn) => (u.room == tr.room), s.turns, tr);
}

lemma TurnsRoomFacts(s: Turns, room: int)
  requires alwaysOneTurnPerRoomWithFreshIds(s)
  ensures turnInRoom(s, room) == noTurn || (turnInRoom(s, room) in s.turns && turnInRoom(s, room).room == room && turnInRoom(s, room).id >= 1)
  ensures turnInRoom(s, room) == noTurn ==> !roomBusy(s, room)
  ensures turnInRoom(s, room) != noTurn ==> forall x :: x in s.turns && x.id == turnInRoom(s, room).id ==> x == turnInRoom(s, room)
{
  TurnsTurnInRoomFilter(s, room);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  var p := (t: Turn) => (t.room == room);
  if |ProofLib.Filter(p, s.turns)| > 0 {
    TurnsFirst(p, s.turns);
    var tr := ProofLib.Filter(p, s.turns)[0];
    TurnsOnly((u: Turn) => (u.id == tr.id), s.turns, tr);
  } else {
    forall x | x in s.turns
      ensures x.room != room
    {
      ProofLib.FilterMember(p, s.turns, x);
    }
  }
}

// spec/agent/conversation/turns.md: only an admitted or recovered message changes anything.
lemma TurnsSendStarts(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  TurnsSendStartsFresh(s, room, key, fingerprint, now, inferenceReady);
  TurnsSendStartsKeys(s, room, key, fingerprint, now, inferenceReady);
  TurnsSendStartsAnswered(s, room, key, fingerprint, now, inferenceReady);
}

// spec/agent/conversation/turns.md: a stored key whose turn left no reply is answered with an empty reply of kind aborted.
lemma TurnsSendSettles(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled?
  requires viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  TurnsSendSettlesFresh(s, room, key, fingerprint, now, inferenceReady);
  TurnsSendSettlesKeys(s, room, key, fingerprint, now, inferenceReady);
  TurnsSendSettlesAnswered(s, room, key, fingerprint, now, inferenceReady);
}

lemma TurnsSend(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  var view := viewOf(s, room, key, timeAt(s, now));
  var a := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  if a.Unkeyed? || a.Owner? {
    TurnsSendStarts(s, room, key, fingerprint, now, inferenceReady);
  } else if a.Settled? && view.HeldUnanswered? {
    TurnsSendSettles(s, room, key, fingerprint, now, inferenceReady);
  } else {
    TurnsSendNoChange(s, room, key, fingerprint, now, inferenceReady);
    assert inv(s);
    hide *;
    reveal inv;
  }
}

lemma TurnsEndFacts(s: Turns, turn: int, settled: KeyPhase, turns2: seq<Turn>, records2: seq<KeyRecord>, nextId2: int)
  requires inv(s) && turn >= 1 && turnAt(s, turn).id == turn
  requires runningTurn(settled) == 0 && nextId2 >= s.nextId
  requires turns2 == ProofLib.Filter((x: Turn) => (x.id != turn), s.turns)
  requires records2 == settleKey(s.records, turn, settled)
  ensures forall x :: x in turns2 <==> x in s.turns && x.id != turn
  ensures forall x :: x in turns2 ==> x.room != turnAt(s, turn).room
  ensures forall x :: x in turns2 ==> x.id >= 1 && x.id < nextId2 && x.room >= 1
  ensures forall x :: x in turns2 ==> |ProofLib.Filter((u: Turn) => (u.room == x.room), turns2)| == 1 && |ProofLib.Filter((u: Turn) => (u.id == x.id), turns2)| == 1
  ensures |records2| == |s.records|
  ensures forall i :: 0 <= i < |s.records| ==> records2[i] == (if runningTurn(s.records[i].phase) == turn then s.records[i].(phase := settled) else s.records[i])
  ensures forall q :: q in records2 ==> q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < nextId2
  ensures forall q :: q in records2 ==> |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), records2)| == 1
  ensures forall q :: q in records2 && runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists x :: x in turns2 && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
  ensures forall x :: x in turns2 && x.key != "" ==> exists q :: q in records2 && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
  ensures forall q :: q in s.records && runningTurn(q.phase) == turn ==> q.userMessage == turn && q.room == turnAt(s, turn).room
{
  hide *;
  reveal inv;
  var tr := turnAt(s, turn);
  var kept := (x: Turn) => (x.id != turn);
  TurnsTurnFacts(s, turn);
  TurnsSettleKeyShape(s.records, turn, settled);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  assert alwaysOneTurnPerRoomWithFreshIds(s) && alwaysKeyedTurnsHoldTheirRecord(s);
  assert turns2 == ProofLib.Filter(kept, s.turns);
  forall x
    ensures x in turns2 <==> x in s.turns && x.id != turn
  {
    ProofLib.FilterMember(kept, s.turns, x);
  }
  forall x | x in turns2
    ensures |ProofLib.Filter((u: Turn) => (u.room == x.room), turns2)| == 1 && |ProofLib.Filter((u: Turn) => (u.id == x.id), turns2)| == 1
  {
    TurnsKept(s.turns, kept, (u: Turn) => (u.room == x.room), x);
    TurnsKept(s.turns, kept, (u: Turn) => (u.id == x.id), x);
  }
  forall q | q in s.records && runningTurn(q.phase) == turn
    ensures q.userMessage == turn && q.room == tr.room
  {
    var x :| x in s.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key;
  }
  forall q | q in records2
    ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < nextId2
    ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), records2)| == 1
    ensures runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists x :: x in turns2 && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
  {
    var i :| 0 <= i < |records2| && records2[i] == q;
    var o := s.records[i];
    assert o in s.records;
    ProofLib.FilterLengthPointwise((y: KeyRecord) => ((y.room == q.room) && (y.key == q.key)), (y: KeyRecord) => ((y.room == o.room) && (y.key == o.key)), records2, s.records);
    if runningTurn(q.phase) > 0 {
      assert q == o && runningTurn(o.phase) != turn;
      var x :| x in s.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key;
      assert x in turns2;
    }
  }
  forall x | x in turns2 && x.key != ""
    ensures exists q :: q in records2 && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
  {
    var q :| q in s.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id;
    var i :| 0 <= i < |s.records| && s.records[i] == q;
    assert records2[i] == q;
  }
}

// spec/agent/conversation/turns.md: a Stop is confirmed only when its turn ends within five seconds.
lemma TurnsEndStops(s: Turns, turn: int, t: int, turns2: seq<Turn>, out: seq<TurnAnswer>, head: TurnAnswer, after: Turns)
  requires inv(s) && turn >= 1 && turnAt(s, turn).id == turn
  requires forall x :: x in turns2 ==> x.room != turnAt(s, turn).room
  requires after.turns == turns2 && after.clock == t
  requires out == [head] + stopAnswerOnEnd(turnAt(s, turn).room, turnAt(s, turn).phase, t) && !head.StopAnswered?
  ensures stepStopAnswersAreTrue(s, "endTurn", after, out)
  ensures stepStopAnswersAreTrue(s, "endWithoutReply", after, out)
{
  TurnsTurnFacts(s, turn);
}

lemma TurnsEndTurn(s: Turns, turn: int, kind: ReplyKind, units: seq<int>, now: int)
  requires inv(s) && canEndTurn(s, turn, kind, now)
  ensures alwaysOneTurnPerRoomWithFreshIds(endTurn(s, turn, kind, units, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(endTurn(s, turn, kind, units, now).state)
  ensures alwaysAnsweredKeysNameTheirReply(endTurn(s, turn, kind, units, now).state)
  ensures stepStopAnswersAreTrue(s, "endTurn", endTurn(s, turn, kind, units, now).state, endTurn(s, turn, kind, units, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, endTurn(s, turn, kind, units, now).state)
{
  var tr := turnAt(s, turn);
  var t := timeAt(s, now);
  var step := endTurn(s, turn, kind, units, now);
  var after := step.state;
  var rep := Reply(s.nextId, tr.room, turn, units, kind, Heard.NotReported);
  TurnsEndFacts(s, turn, KeyAnswered(s.nextId, t, s.boot), after.turns, after.records, after.nextId);
  TurnsEndStops(s, turn, t, after.turns, step.out, ReplyReady(turn, s.nextId), after);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
  assert after.replies == s.replies + [rep];
  forall r | r in after.replies
    ensures r.id >= 1 && r.id < after.nextId
    ensures |ProofLib.Filter((x: Reply) => (x.id == r.id), after.replies)| == 1
  {
    TurnsAppend((x: Reply) => (x.id == r.id), s.replies, rep);
    if r != rep {
      assert r in s.replies;
    } else {
      forall y | y in s.replies ensures y.id != r.id { }
      TurnsNone((x: Reply) => (x.id == r.id), s.replies);
    }
  }
  forall q | q in after.records && answeredReply(q.phase) > 0
    ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
  {
    var i :| 0 <= i < |after.records| && after.records[i] == q;
    var o := s.records[i];
    assert o in s.records;
    if runningTurn(o.phase) == turn {
      assert rep in after.replies;
    } else {
      var r :| r in s.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage;
      assert r in after.replies;
    }
  }
}

lemma TurnsEndWithoutReply(s: Turns, turn: int, now: int)
  requires inv(s) && canEndWithoutReply(s, turn)
  ensures alwaysOneTurnPerRoomWithFreshIds(endWithoutReply(s, turn, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(endWithoutReply(s, turn, now).state)
  ensures stepStopAnswersAreTrue(s, "endWithoutReply", endWithoutReply(s, turn, now).state, endWithoutReply(s, turn, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, endWithoutReply(s, turn, now).state)
{
  var t := timeAt(s, now);
  var step := endWithoutReply(s, turn, now);
  var after := step.state;
  TurnsEndFacts(s, turn, KeyPhase.KeyUnanswered, after.turns, after.records, after.nextId);
  TurnsEndStops(s, turn, t, after.turns, step.out, ReplyUnavailable(turn), after);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
}

lemma TurnsRestart(s: Turns)
  requires inv(s)
  ensures alwaysKeyedTurnsHoldTheirRecord(restart(s))
{
  hide *;
  reveal inv;
  var after := restart(s);
  TurnsRestartShape(s);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
  forall q | q in after.records
    ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < after.nextId && runningTurn(q.phase) <= 0
    ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), after.records)| == 1
  {
    var i :| 0 <= i < |after.records| && after.records[i] == q;
    TurnsRestartRecord(s, after, i);
  }
  assert after.turns == [];
}

// spec/agent/conversation/turns.md: after a restart each record keeps its room, key and message, and no record names a running turn.
lemma TurnsRestartRecord(s: Turns, after: Turns, i: int)
  requires alwaysKeyedTurnsHoldTheirRecord(s) && after == restart(s) && 0 <= i < |s.records|
  ensures |after.records| == |s.records| && after.nextId == s.nextId
  ensures after.records[i].key != "" && after.records[i].room >= 1 && after.records[i].userMessage >= 1 && after.records[i].userMessage < after.nextId && runningTurn(after.records[i].phase) <= 0
  ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == after.records[i].room) && (o.key == after.records[i].key)), after.records)| == 1
{
  hide *;
  TurnsRestartShape(s);
  TurnsPhaseValues(0, 0, 0, 0);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  var o := s.records[i];
  assert o in s.records;
  TurnsSameKeysCount(s.records, after.records, i);
}

// spec/agent/conversation/turns.md: marking a turn's Stop keeps its id, room and key.
lemma TurnsPhaseOnly(s: Turns, turns2: seq<Turn>, after: Turns)
  requires inv(s)
  requires |turns2| == |s.turns| && forall i :: 0 <= i < |s.turns| ==> turns2[i].id == s.turns[i].id && turns2[i].room == s.turns[i].room && turns2[i].key == s.turns[i].key
  requires after == s.(turns := turns2, clock := after.clock)
  ensures alwaysOneTurnPerRoomWithFreshIds(after)
  ensures alwaysKeyedTurnsHoldTheirRecord(after)
{
  TurnsPhaseOnlyTurns(s, turns2, after);
  TurnsPhaseOnlyKeys(s, turns2, after);
}

lemma TurnsStopDeadline(s: Turns, room: int, now: int)
  requires inv(s) && canStopDeadline(s, room, now)
  ensures alwaysOneTurnPerRoomWithFreshIds(stopDeadline(s, room, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(stopDeadline(s, room, now).state)
  ensures stepStopAnswersAreTrue(s, "stopDeadline", stopDeadline(s, room, now).state, stopDeadline(s, room, now).out)
{
  var step := stopDeadline(s, room, now);
  TurnsPhaseOnly(s, step.state.turns, step.state);
  TurnsRoomFacts(s, room);
  assert turnInRoom(s, room) != noTurn;
  assert turnInRoom(s, room) in s.turns && stopPending(turnInRoom(s, room).phase);
}

lemma TurnsRequestStop(s: Turns, room: int, now: int)
  requires inv(s) && canRequestStop(s, room, now)
  ensures alwaysOneTurnPerRoomWithFreshIds(requestStop(s, room, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(requestStop(s, room, now).state)
  ensures stepStopAnswersAreTrue(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out)
{
  var step := requestStop(s, room, now);
  var tr := turnInRoom(s, room);
  TurnsRoomFacts(s, room);
  if tr == noTurn || stopPending(tr.phase) {
    assert step.state == s;
  } else {
    TurnsPhaseOnly(s, step.state.turns, step.state);
  }
}

// spec/agent/conversation/turns.md: a heard report only moves the heard boundary of an agent reply back.
lemma TurnsReportHeard(s: Turns, room: int, reply: int, report: HeardReport)
  requires inv(s) && canReportHeard(s, room, reply, report)
  ensures alwaysOneTurnPerRoomWithFreshIds(reportHeard(s, room, reply, report).state)
  ensures alwaysAnsweredKeysNameTheirReply(reportHeard(s, room, reply, report).state)
  ensures alwaysHeardBoundaryInsideTheReply(reportHeard(s, room, reply, report).state)
  ensures stepStoredRepliesStayWhole(s, reportHeard(s, room, reply, report).state)
{
  var after := reportHeard(s, room, reply, report).state;
  var verdict := heardVerdict(s, room, reply, report);
  var p := (x: Reply) => (x.id == reply);
  var n := reportedUnits(report);
  if !verdict.HeardRecorded? {
    assert after == s;
    forall r | r in s.replies
      ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
    {
    }
  } else {
    TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
    TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
    TurnsVerdictFilter(s, room, reply, report);
    assert |ProofLib.Filter(p, s.replies)| > 0;
    TurnsFirst(p, s.replies);
    var r0 := ProofLib.Filter(p, s.replies)[0];
    ProofLib.FilterSamePredicate(p, (x: Reply) => (x.id == r0.id), s.replies);
    TurnsOnly(p, s.replies, r0);
    assert n < boundaryOf(r0) && n >= 0;
    assert |after.replies| == |s.replies|;
    forall i | 0 <= i < |s.replies|
      ensures after.replies[i] == (if s.replies[i].id == reply then s.replies[i].(heard := HeardUpTo(n)) else s.replies[i])
      ensures s.replies[i].id == reply ==> s.replies[i] == r0
    {
      assert s.replies[i] in s.replies;
    }
    forall r | r in after.replies
      ensures r.id >= 1 && r.id < after.nextId
      ensures |ProofLib.Filter((x: Reply) => (x.id == r.id), after.replies)| == 1
      ensures boundaryOf(r) >= 0 && boundaryOf(r) <= |r.units|
    {
      var i :| 0 <= i < |after.replies| && after.replies[i] == r;
      var o := s.replies[i];
      assert o in s.replies;
      ProofLib.FilterLengthPointwise((x: Reply) => (x.id == r.id), (x: Reply) => (x.id == o.id), after.replies, s.replies);
    }
    forall q | q in after.records && answeredReply(q.phase) > 0
      ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
    {
      var r :| r in s.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage;
      var i :| 0 <= i < |s.replies| && s.replies[i] == r;
      assert after.replies[i] in after.replies;
    }
    forall r | r in s.replies
      ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
    {
      var i :| 0 <= i < |s.replies| && s.replies[i] == r;
      assert after.replies[i] in after.replies;
    }
  }
}

lemma TurnsVerdictFilter(s: Turns, room: int, reply: int, report: HeardReport)
  ensures heardVerdict(s, room, reply, report).HeardRecorded? ==> (0 < |ProofLib.Filter((x: Reply) => (x.id == reply), s.replies)| && reportedUnits(report) < boundaryOf(ProofLib.Filter((x: Reply) => (x.id == reply), s.replies)[0]))
{
}

// spec/agent/conversation/turns.md: the heard part and the unheard remainder together are the whole reply.
lemma {:induction false} TurnsSliceFrom(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires start <= offset <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == end {
    TurnsSlicePast(xs, start, end, offset, acc);
  } else {
    var next := core__streamUnits_SliceWalk(offset + 1, acc + [xs[0]]);
    assert f(core__streamUnits_SliceWalk(offset, acc), xs[0]) == next;
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    TurnsSliceFrom(xs[1..], start, end, offset + 1, acc + [xs[0]]);
    assert xs[..end - offset] == [xs[0]] + xs[1..][..end - offset - 1];
  }
}

lemma {:induction false} TurnsSlicePast(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset >= end
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if |xs| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    TurnsSlicePast(xs[1..], start, end, offset + 1, acc);
  }
}

lemma {:induction false} TurnsSliceBefore(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset <= start <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[start - offset..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == start {
    TurnsSliceFrom(xs, start, end, offset, acc);
    assert xs[start - offset..end - offset] == xs[..end - offset];
  } else {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    TurnsSliceBefore(xs[1..], start, end, offset + 1, acc);
    assert xs[1..][start - offset - 1..end - offset - 1] == xs[start - offset..end - offset];
  }
}

lemma TurnsSlice(units: seq<int>, start: int, end: int)
  requires 0 <= start <= end <= |units|
  ensures core__streamUnits_sliceUnits(units, start, end) == units[start..end]
{
  TurnsSliceBefore(units, start, end, 0, []);
}

// spec/agent/conversation/turns.md: what send stores and answers, for each admission.
lemma TurnsSendOut(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  ensures send(s, room, key, fingerprint, now, inferenceReady).out == [SendAnswered(decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId))]
{
}

lemma TurnsSendStartShape(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?
  ensures !roomBusy(s, room)
  ensures decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner? <==> key != ""
  ensures key != "" ==> recordAt(s, room, key).room == 0
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.turns == s.turns + [Turn(s.nextId, room, key, timeAt(s, now), TurnPhase.Running)]
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.nextId == s.nextId + 1
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.replies == s.replies
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.records == (if key != "" then s.records + [KeyRecord(room, key, fingerprint, s.nextId, KeyRunning(s.nextId))] else s.records)
{
}

lemma TurnsSendSettleShape(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled?
  requires viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?
  ensures key != "" && recordAt(s, room, key).room != 0 && recordAt(s, room, key).phase.KeyUnanswered?
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.turns == s.turns
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.nextId == s.nextId + 1
  ensures send(s, room, key, fingerprint, now, inferenceReady).state.replies == s.replies + [Reply(s.nextId, room, recordAt(s, room, key).userMessage, [], ReplyKind.Unfinished, Heard.NotReported)]
  ensures |send(s, room, key, fingerprint, now, inferenceReady).state.records| == |s.records|
  ensures forall i :: 0 <= i < |s.records| ==> send(s, room, key, fingerprint, now, inferenceReady).state.records[i] == (if s.records[i].room == room && s.records[i].key == key then s.records[i].(phase := KeyAnswered(s.nextId, timeAt(s, now), s.boot)) else s.records[i])
{
}

lemma TurnsSendNoChange(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires !(decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?)
  requires !(decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled? && viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?)
  ensures send(s, room, key, fingerprint, now, inferenceReady).state == s
{
}

// spec/agent/conversation/turns.md: a send stores nothing for a refusal or a repeat, never runs a recorded key again, and keeps every stored reply.
lemma TurnsSendSteps(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  ensures alwaysHeardBoundaryInsideTheReply(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out)
  ensures stepARecordedKeyNeverRunsAgain(s, send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures stepStopAnswersAreTrue(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out)
  ensures stepStoredRepliesStayWhole(s, send(s, room, key, fingerprint, now, inferenceReady).state)
{
  var view := viewOf(s, room, key, timeAt(s, now));
  var a := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  var step := send(s, room, key, fingerprint, now, inferenceReady);
  var after := step.state;
  TurnsSendOut(s, room, key, fingerprint, now, inferenceReady);
  assert alwaysHeardBoundaryInsideTheReply(s) && alwaysKeyedTurnsHoldTheirRecord(s);
  TurnsRecordFacts(s, room, key);
  hide *;
  reveal alwaysHeardBoundaryInsideTheReply, stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole, isRefusalOrReplay, boundaryOf, heardBoundary;
  assert step.out == [SendAnswered(a)];
  if a.Unkeyed? || a.Owner? {
    TurnsSendStartShape(s, room, key, fingerprint, now, inferenceReady);
    assert after.replies == s.replies;
    forall x | x in after.turns
      ensures (exists b :: b in s.turns && b.id == x.id) || x.key == "" || !(exists q :: q in s.records && q.room == x.room && q.key == x.key)
    {
      if !(x in s.turns) {
        assert x.room == room && x.key == key;
      }
    }
    forall r | r in s.replies
      ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
    {
    }
  } else if a.Settled? && view.HeldUnanswered? {
    TurnsSendSettleShape(s, room, key, fingerprint, now, inferenceReady);
    var cut := Reply(s.nextId, room, recordAt(s, room, key).userMessage, [], ReplyKind.Unfinished, Heard.NotReported);
    assert after.replies == s.replies + [cut] && boundaryOf(cut) == 0;
    forall r | r in after.replies
      ensures boundaryOf(r) >= 0 && boundaryOf(r) <= |r.units|
    {
      if r != cut { assert r in s.replies; }
    }
    forall x | x in after.turns
      ensures exists b :: b in s.turns && b.id == x.id
    {
    }
    forall r | r in s.replies
      ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
    {
      assert r in after.replies;
    }
  } else {
    TurnsSendNoChange(s, room, key, fingerprint, now, inferenceReady);
    forall x | x in after.turns
      ensures exists b :: b in s.turns && b.id == x.id
    {
    }
    forall r | r in s.replies
      ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
    {
    }
  }
}

// spec/agent/conversation/turns.md: a turn that ends leaves its room, and its key keeps the reply it stored or none.
lemma TurnsSettleKeyShape(records: seq<KeyRecord>, turn: int, p: KeyPhase)
  ensures |settleKey(records, turn, p)| == |records|
  ensures forall i :: 0 <= i < |records| ==> settleKey(records, turn, p)[i] == (if runningTurn(records[i].phase) == turn then records[i].(phase := p) else records[i])
{
}

// spec/agent/conversation/turns.md: a restart loses every running turn, and a record whose turn was running keeps no reply.
lemma TurnsRestartShape(s: Turns)
  ensures restart(s).turns == [] && restart(s).nextId == s.nextId && |restart(s).records| == |s.records|
  ensures forall i :: 0 <= i < |s.records| ==> restart(s).records[i] == (if runningTurn(s.records[i].phase) > 0 then s.records[i].(phase := KeyPhase.KeyUnanswered) else s.records[i])
  ensures forall i :: 0 <= i < |s.records| ==> restart(s).records[i].room == s.records[i].room && restart(s).records[i].key == s.records[i].key && restart(s).records[i].userMessage == s.records[i].userMessage
{
}

// spec/agent/conversation/turns.md: a Stop request changes only a turn's phase and the clock.
lemma TurnsRequestStopShape(s: Turns, room: int, now: int)
  ensures requestStop(s, room, now).state.records == s.records && requestStop(s, room, now).state.replies == s.replies && requestStop(s, room, now).state.nextId == s.nextId
  ensures |requestStop(s, room, now).state.turns| == |s.turns|
  ensures forall i :: 0 <= i < |s.turns| ==> requestStop(s, room, now).state.turns[i].id == s.turns[i].id && requestStop(s, room, now).state.turns[i].room == s.turns[i].room && requestStop(s, room, now).state.turns[i].key == s.turns[i].key
  ensures forall a :: a in requestStop(s, room, now).out ==> a.StopAnswered?
{
}

lemma TurnsRequestStopSteps(s: Turns, room: int, now: int)
  requires inv(s)
  ensures alwaysAnsweredKeysNameTheirReply(requestStop(s, room, now).state)
  ensures alwaysHeardBoundaryInsideTheReply(requestStop(s, room, now).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, requestStop(s, room, now).state)
  ensures stepStoredRepliesStayWhole(s, requestStop(s, room, now).state)
{
  var after := requestStop(s, room, now).state;
  TurnsRequestStopShape(s, room, now);
  assert alwaysAnsweredKeysNameTheirReply(s) && alwaysHeardBoundaryInsideTheReply(s);
  hide *;
  reveal alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply, stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStoredRepliesStayWhole;
  forall x | x in after.turns
    ensures exists b :: b in s.turns && b.id == x.id
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == x;
    assert s.turns[i] in s.turns;
  }
  forall r | r in s.replies
    ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
  {
  }
}

// spec/agent/conversation/turns.md: a running key names its turn, an answered key its reply, and an unanswered key neither.
lemma TurnsPhaseValues(t: int, r: int, at: int, boot: int)
  ensures runningTurn(KeyRunning(t)) == t && answeredReply(KeyRunning(t)) == 0
  ensures runningTurn(KeyPhase.KeyUnanswered) == 0 && answeredReply(KeyPhase.KeyUnanswered) == 0
  ensures runningTurn(KeyAnswered(r, at, boot)) == 0 && answeredReply(KeyAnswered(r, at, boot)) == r
{
}

lemma TurnsSendStartsFresh(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, roomBusy, canSend;
  var t := timeAt(s, now);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var n := Turn(s.nextId, room, key, t, TurnPhase.Running);
  TurnsSendStartShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
  forall x | x in s.turns
    ensures x.room != room && x.id < s.nextId
  {
  }
  forall x | x in after.turns
    ensures x.id >= 1 && x.id < after.nextId && x.room >= 1
    ensures |ProofLib.Filter((u: Turn) => (u.room == x.room), after.turns)| == 1
    ensures |ProofLib.Filter((u: Turn) => (u.id == x.id), after.turns)| == 1
  {
    TurnsAppend((u: Turn) => (u.room == x.room), s.turns, n);
    TurnsAppend((u: Turn) => (u.id == x.id), s.turns, n);
    if x != n {
      assert x in s.turns;
    } else {
      TurnsNone((u: Turn) => (u.room == x.room), s.turns);
      TurnsNone((u: Turn) => (u.id == x.id), s.turns);
    }
  }
  forall r | r in after.replies
    ensures r.id >= 1 && r.id < after.nextId && |ProofLib.Filter((x: Reply) => (x.id == r.id), after.replies)| == 1
  {
    assert r in s.replies;
  }
}

lemma TurnsSendStartsKeys(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, canSend;
  var t := timeAt(s, now);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var n := Turn(s.nextId, room, key, t, TurnPhase.Running);
  var nr := KeyRecord(room, key, fingerprint, s.nextId, KeyRunning(s.nextId));
  TurnsSendStartShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsRecordFacts(s, room, key);
  TurnsPhaseValues(s.nextId, 0, 0, 0);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
  if key != "" {
    assert after.records == s.records + [nr];
    forall q | q in after.records
      ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < after.nextId
      ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), after.records)| == 1
      ensures runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists x :: x in after.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
    {
      TurnsAppend((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records, nr);
      if q != nr {
        assert q in s.records;
        if runningTurn(q.phase) > 0 {
          var x :| x in s.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key;
          assert x in after.turns;
        }
      } else {
        TurnsNone((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records);
        assert n in after.turns;
      }
    }
    forall x | x in after.turns && x.key != ""
      ensures exists q :: q in after.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
    {
      if x == n {
        assert nr in after.records;
      } else {
        assert x in s.turns;
        var q :| q in s.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id;
        assert q in after.records;
      }
    }
  } else {
    assert after.records == s.records;
    forall q | q in after.records
      ensures q.userMessage < after.nextId
      ensures runningTurn(q.phase) > 0 ==> exists x :: x in after.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
    {
      if runningTurn(q.phase) > 0 {
        var x :| x in s.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key;
        assert x in after.turns;
      }
    }
    forall x | x in after.turns && x.key != ""
      ensures exists q :: q in after.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
    {
      assert x in s.turns;
    }
  }
}

lemma TurnsSendStartsAnswered(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Unkeyed? || decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Owner?
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, alwaysAnsweredKeysNameTheirReply;
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var nr := KeyRecord(room, key, fingerprint, s.nextId, KeyRunning(s.nextId));
  TurnsSendStartShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsPhaseValues(s.nextId, 0, 0, 0);
  forall q | q in after.records && answeredReply(q.phase) > 0
    ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
  {
    assert q in s.records;
  }
}

lemma TurnsSendSettlesFresh(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled?
  requires viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv;
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var cut := Reply(s.nextId, room, recordAt(s, room, key).userMessage, [], ReplyKind.Unfinished, Heard.NotReported);
  TurnsSendSettleShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
  forall x | x in after.turns
    ensures x.id >= 1 && x.id < after.nextId && x.room >= 1
    ensures |ProofLib.Filter((u: Turn) => (u.room == x.room), after.turns)| == 1
    ensures |ProofLib.Filter((u: Turn) => (u.id == x.id), after.turns)| == 1
  {
    assert x in s.turns;
  }
  forall r | r in after.replies
    ensures r.id >= 1 && r.id < after.nextId
    ensures |ProofLib.Filter((x: Reply) => (x.id == r.id), after.replies)| == 1
  {
    TurnsAppend((x: Reply) => (x.id == r.id), s.replies, cut);
    if r != cut {
      assert r in s.replies;
    } else {
      forall y | y in s.replies ensures y.id != r.id { }
      TurnsNone((x: Reply) => (x.id == r.id), s.replies);
    }
  }
}

lemma TurnsSendSettlesKeys(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled?
  requires viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv;
  var t := timeAt(s, now);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var rec := recordAt(s, room, key);
  TurnsSendSettleShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsRecordFacts(s, room, key);
  TurnsPhaseValues(s.nextId, s.nextId, t, s.boot);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
  forall i | 0 <= i < |s.records|
    ensures after.records[i].room == s.records[i].room && after.records[i].key == s.records[i].key
    ensures after.records[i].userMessage == s.records[i].userMessage
  {
  }
  forall q | q in after.records
    ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < after.nextId
    ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), after.records)| == 1
    ensures runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists x :: x in after.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
  {
    var i :| 0 <= i < |after.records| && after.records[i] == q;
    var o := s.records[i];
    assert o in s.records;
    ProofLib.FilterLengthPointwise((y: KeyRecord) => ((y.room == q.room) && (y.key == q.key)), (y: KeyRecord) => ((y.room == o.room) && (y.key == o.key)), after.records, s.records);
    if !(o.room == room && o.key == key) {
      assert q == o;
    }
  }
  forall x | x in after.turns && x.key != ""
    ensures exists q :: q in after.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
  {
    var q :| q in s.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id;
    var i :| 0 <= i < |s.records| && s.records[i] == q;
    assert x.id >= 1;
    if q.room == room && q.key == key {
      assert q == rec;
    }
    assert after.records[i] == q;
  }
}

lemma TurnsSendSettlesAnswered(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s)
  requires decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId).Settled?
  requires viewOf(s, room, key, timeAt(s, now)).HeldUnanswered?
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, alwaysAnsweredKeysNameTheirReply;
  var t := timeAt(s, now);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var rec := recordAt(s, room, key);
  var cut := Reply(s.nextId, room, rec.userMessage, [], ReplyKind.Unfinished, Heard.NotReported);
  TurnsSendSettleShape(s, room, key, fingerprint, now, inferenceReady);
  TurnsRecordFacts(s, room, key);
  TurnsPhaseValues(s.nextId, s.nextId, t, s.boot);
  forall q | q in after.records && answeredReply(q.phase) > 0
    ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
  {
    var i :| 0 <= i < |after.records| && after.records[i] == q;
    var o := s.records[i];
    assert o in s.records;
    if o.room == room && o.key == key {
      assert o == rec;
      assert cut in after.replies;
    } else {
      assert q == o;
      var r :| r in s.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage;
      assert r in after.replies;
    }
  }
}

// spec/agent/conversation/turns.md: records that keep their room and key keep each key to one record.
lemma TurnsSameKeysCount(before: seq<KeyRecord>, after: seq<KeyRecord>, i: int)
  requires |after| == |before| && 0 <= i < |before|
  requires forall j :: 0 <= j < |before| ==> after[j].room == before[j].room && after[j].key == before[j].key
  ensures |ProofLib.Filter((y: KeyRecord) => ((y.room == after[i].room) && (y.key == after[i].key)), after)| == |ProofLib.Filter((y: KeyRecord) => ((y.room == before[i].room) && (y.key == before[i].key)), before)|
{
  ProofLib.FilterLengthPointwise((y: KeyRecord) => ((y.room == after[i].room) && (y.key == after[i].key)), (y: KeyRecord) => ((y.room == before[i].room) && (y.key == before[i].key)), after, before);
}

lemma TurnsPhaseOnlyTurns(s: Turns, turns2: seq<Turn>, after: Turns)
  requires inv(s)
  requires |turns2| == |s.turns| && forall i :: 0 <= i < |s.turns| ==> turns2[i].id == s.turns[i].id && turns2[i].room == s.turns[i].room && turns2[i].key == s.turns[i].key
  requires after == s.(turns := turns2, clock := after.clock)
  ensures alwaysOneTurnPerRoomWithFreshIds(after)
{
  hide *;
  reveal inv;
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(s);
  TurnsAlwaysOneTurnPerRoomWithFreshIdsFilter(after);
  assert after.replies == s.replies && after.nextId == s.nextId && after.turns == turns2;
  forall x | x in after.turns
    ensures x.id >= 1 && x.id < after.nextId && x.room >= 1
    ensures |ProofLib.Filter((u: Turn) => (u.room == x.room), after.turns)| == 1
    ensures |ProofLib.Filter((u: Turn) => (u.id == x.id), after.turns)| == 1
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == x;
    var o := s.turns[i];
    assert o in s.turns;
    ProofLib.FilterLengthPointwise((u: Turn) => (u.room == x.room), (u: Turn) => (u.room == o.room), after.turns, s.turns);
    ProofLib.FilterLengthPointwise((u: Turn) => (u.id == x.id), (u: Turn) => (u.id == o.id), after.turns, s.turns);
  }
}

lemma TurnsPhaseOnlyKeys(s: Turns, turns2: seq<Turn>, after: Turns)
  requires inv(s)
  requires |turns2| == |s.turns| && forall i :: 0 <= i < |s.turns| ==> turns2[i].id == s.turns[i].id && turns2[i].room == s.turns[i].room && turns2[i].key == s.turns[i].key
  requires after == s.(turns := turns2, clock := after.clock)
  ensures alwaysKeyedTurnsHoldTheirRecord(after)
{
  hide *;
  reveal inv;
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(s);
  TurnsAlwaysKeyedTurnsHoldTheirRecordFilter(after);
  assert after.records == s.records && after.nextId == s.nextId && after.turns == turns2;
  forall x | x in after.turns && x.key != ""
    ensures exists q :: q in after.records && q.room == x.room && q.key == x.key && runningTurn(q.phase) == x.id
  {
    var i :| 0 <= i < |after.turns| && after.turns[i] == x;
    assert s.turns[i] in s.turns;
  }
  forall q | q in after.records && runningTurn(q.phase) > 0
    ensures exists x :: x in after.turns && x.id == runningTurn(q.phase) && x.room == q.room && x.key == q.key
  {
    var o :| o in s.turns && o.id == runningTurn(q.phase) && o.room == q.room && o.key == q.key;
    var i :| 0 <= i < |s.turns| && s.turns[i] == o;
    assert after.turns[i] in after.turns;
  }
}
