lemma FreshBridge(s: Turns)
  ensures alwaysOneTurnPerRoomWithFreshIds(s) == (((s.nextId >= 1) && !((exists t :: t in s.turns && !((((((t.id >= 1) && (t.id < s.nextId)) && (t.room >= 1)) && (|ProofLib.Filter((u: Turn) => (u.room == t.room), s.turns)| == 1)) && (|ProofLib.Filter((u: Turn) => (u.id == t.id), s.turns)| == 1)))))) && !((exists r :: r in s.replies && !((((r.id >= 1) && (r.id < s.nextId)) && (|ProofLib.Filter((x: Reply) => (x.id == r.id), s.replies)| == 1))))))
{
  hide *;
  reveal alwaysOneTurnPerRoomWithFreshIds, ProofLib.Filter;
}

lemma KeyedBridge(s: Turns)
  ensures alwaysKeyedTurnsHoldTheirRecord(s) == (!((exists q :: q in s.records && !(((((((q.key != "") && (q.room >= 1)) && (q.userMessage >= 1)) && (q.userMessage < s.nextId)) && (|ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records)| == 1)) && (!((runningTurn(q.phase) > 0)) || ((q.userMessage == runningTurn(q.phase)) && (exists t :: t in s.turns && (((t.id == runningTurn(q.phase)) && (t.room == q.room)) && (t.key == q.key))))))))) && !((exists t :: t in s.turns && !((!((t.key != "")) || (exists q :: q in s.records && (((q.room == t.room) && (q.key == t.key)) && (runningTurn(q.phase) == t.id))))))))
{
  hide *;
  reveal alwaysKeyedTurnsHoldTheirRecord, ProofLib.Filter;
}

lemma TurnsExtract(s: Turns)
  requires alwaysOneTurnPerRoomWithFreshIds(s)
  ensures s.nextId >= 1
  ensures forall t :: t in s.turns ==> t.id >= 1 && t.id < s.nextId && t.room >= 1
  ensures forall r :: r in s.replies ==> r.id >= 1 && r.id < s.nextId
  ensures ProofLib.DistinctBy(s.turns, (t: Turn) => t.room)
  ensures ProofLib.DistinctBy(s.turns, (t: Turn) => t.id)
  ensures ProofLib.DistinctBy(s.replies, (r: Reply) => r.id)
{
  hide *;
  reveal ProofLib.DistinctBy;
  FreshBridge(s);
  forall i, j | 0 <= i < |s.turns| && 0 <= j < |s.turns| && i != j
    ensures s.turns[i].room != s.turns[j].room && s.turns[i].id != s.turns[j].id
  {
    var t := s.turns[i];
    assert t in s.turns;
    ProofLib.FilterCountOneIffUnique((u: Turn) => (u.room == t.room), s.turns, (u: Turn) => u.room, i);
    ProofLib.FilterCountOneIffUnique((u: Turn) => (u.id == t.id), s.turns, (u: Turn) => u.id, i);
  }
  forall i, j | 0 <= i < |s.replies| && 0 <= j < |s.replies| && i != j
    ensures s.replies[i].id != s.replies[j].id
  {
    var r := s.replies[i];
    assert r in s.replies;
    ProofLib.FilterCountOneIffUnique((x: Reply) => (x.id == r.id), s.replies, (x: Reply) => x.id, i);
  }
}

lemma RecordsExtract(s: Turns)
  requires alwaysKeyedTurnsHoldTheirRecord(s)
  ensures ProofLib.DistinctBy(s.records, (q: KeyRecord) => (q.room, q.key))
  ensures forall q :: q in s.records ==> q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < s.nextId && (runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists t :: t in s.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key)
  ensures forall t :: t in s.turns ==> t.key != "" ==> exists q :: q in s.records && q.room == t.room && q.key == t.key && runningTurn(q.phase) == t.id
{
  hide *;
  reveal ProofLib.DistinctBy;
  KeyedBridge(s);
  forall i, j | 0 <= i < |s.records| && 0 <= j < |s.records| && i != j
    ensures (s.records[i].room, s.records[i].key) != (s.records[j].room, s.records[j].key)
  {
    var q := s.records[i];
    assert q in s.records;
    ProofLib.FilterCountOneIffUnique((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records, (o: KeyRecord) => (o.room, o.key), i);
  }
}

lemma TurnsProveFresh(s: Turns)
  requires s.nextId >= 1
  requires forall t :: t in s.turns ==> t.id >= 1 && t.id < s.nextId && t.room >= 1
  requires forall r :: r in s.replies ==> r.id >= 1 && r.id < s.nextId
  requires ProofLib.DistinctBy(s.turns, (t: Turn) => t.room)
  requires ProofLib.DistinctBy(s.turns, (t: Turn) => t.id)
  requires ProofLib.DistinctBy(s.replies, (r: Reply) => r.id)
  ensures alwaysOneTurnPerRoomWithFreshIds(s)
{
  hide *;
  reveal ProofLib.DistinctBy;
  FreshBridge(s);
  forall t | t in s.turns
    ensures |ProofLib.Filter((u: Turn) => (u.room == t.room), s.turns)| == 1 && |ProofLib.Filter((u: Turn) => (u.id == t.id), s.turns)| == 1
  {
    var i :| 0 <= i < |s.turns| && s.turns[i] == t;
    ProofLib.FilterOne((u: Turn) => (u.room == t.room), s.turns, i);
    ProofLib.FilterOne((u: Turn) => (u.id == t.id), s.turns, i);
  }
  forall r | r in s.replies
    ensures |ProofLib.Filter((x: Reply) => (x.id == r.id), s.replies)| == 1
  {
    var i :| 0 <= i < |s.replies| && s.replies[i] == r;
    ProofLib.FilterOne((x: Reply) => (x.id == r.id), s.replies, i);
  }
}

lemma RecordsProveKeyed(s: Turns)
  requires ProofLib.DistinctBy(s.records, (q: KeyRecord) => (q.room, q.key))
  requires forall q :: q in s.records ==> q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < s.nextId && (runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists t :: t in s.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key)
  requires forall t :: t in s.turns ==> t.key != "" ==> exists q :: q in s.records && q.room == t.room && q.key == t.key && runningTurn(q.phase) == t.id
  ensures alwaysKeyedTurnsHoldTheirRecord(s)
{
  hide *;
  reveal ProofLib.DistinctBy;
  KeyedBridge(s);
  forall q | q in s.records
    ensures |ProofLib.Filter((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records)| == 1
  {
    var i :| 0 <= i < |s.records| && s.records[i] == q;
    ProofLib.FilterOne((o: KeyRecord) => ((o.room == q.room) && (o.key == q.key)), s.records, i);
  }
}

lemma RecordAtFilter(s: Turns, room: int, key: string, p: KeyRecord -> bool)
  requires forall q :: p(q) == ((q.room == room) && (q.key == key))
  ensures recordAt(s, room, key) == (if 0 < |ProofLib.Filter(p, s.records)| then ProofLib.Filter(p, s.records)[0] else noRecord)
{
  hide *;
  reveal recordAt, ProofLib.Filter;
  ProofLib.FilterSamePredicate(p, (q: KeyRecord) => ((q.room == room) && (q.key == key)), s.records);
}

lemma RecordAtSpec(s: Turns, room: int, key: string)
  requires inv(s)
  ensures var r := recordAt(s, room, key);
    (r.room == 0 ==> forall q :: q in s.records ==> !(q.room == room && q.key == key))
    && (r.room != 0 ==> r in s.records && r.room == room && r.key == key)
{
  hide *;
  reveal inv, noRecord;
  RecordsExtract(s);
  var p := (q: KeyRecord) => ((q.room == room) && (q.key == key));
  RecordAtFilter(s, room, key, p);
  var f := ProofLib.Filter(p, s.records);
  if |f| == 0 {
    forall q | q in s.records ensures !p(q) {
      ProofLib.FilterMember(p, s.records, q);
    }
  } else {
    ProofLib.FilterMember(p, s.records, f[0]);
  }
}

lemma TurnAtFilter(s: Turns, turn: int, p: Turn -> bool)
  requires forall t :: p(t) == (t.id == turn)
  ensures turnAt(s, turn) == (if 0 < |ProofLib.Filter(p, s.turns)| then ProofLib.Filter(p, s.turns)[0] else noTurn)
{
  hide *;
  reveal turnAt, ProofLib.Filter;
  ProofLib.FilterSamePredicate(p, (t: Turn) => (t.id == turn), s.turns);
}

lemma TurnAtSpec(s: Turns, turn: int)
  requires inv(s) && turn >= 1
  ensures var t := turnAt(s, turn);
    (t.id == 0 ==> forall u :: u in s.turns ==> u.id != turn)
    && (t.id != 0 ==> t in s.turns && t.id == turn)
{
  hide *;
  reveal inv, noTurn;
  TurnsExtract(s);
  var p := (t: Turn) => (t.id == turn);
  TurnAtFilter(s, turn, p);
  var f := ProofLib.Filter(p, s.turns);
  if |f| == 0 {
    forall u | u in s.turns ensures !p(u) {
      ProofLib.FilterMember(p, s.turns, u);
    }
  } else {
    ProofLib.FilterMember(p, s.turns, f[0]);
  }
}

lemma TurnInRoomFilter(s: Turns, room: int, p: Turn -> bool)
  requires forall t :: p(t) == (t.room == room)
  ensures turnInRoom(s, room) == (if 0 < |ProofLib.Filter(p, s.turns)| then ProofLib.Filter(p, s.turns)[0] else noTurn)
{
  hide *;
  reveal turnInRoom, ProofLib.Filter;
  ProofLib.FilterSamePredicate(p, (t: Turn) => (t.room == room), s.turns);
}

lemma TurnInRoomSpec(s: Turns, room: int)
  requires inv(s) && room >= 1
  ensures var t := turnInRoom(s, room);
    (t.id == 0 ==> !roomBusy(s, room))
    && (t.id != 0 ==> t in s.turns && t.room == room)
{
  hide *;
  reveal inv, roomBusy, noTurn;
  TurnsExtract(s);
  var p := (t: Turn) => (t.room == room);
  TurnInRoomFilter(s, room, p);
  var f := ProofLib.Filter(p, s.turns);
  if |f| == 0 {
    forall u | u in s.turns ensures !p(u) {
      ProofLib.FilterMember(p, s.turns, u);
    }
  } else {
    ProofLib.FilterMember(p, s.turns, f[0]);
  }
}

lemma HeardReplyLookup(s: Turns, room: int, reply: int, report: HeardReport)
  requires inv(s) && canReportHeard(s, room, reply, report) && heardVerdict(s, room, reply, report).HeardRecorded?
  ensures exists target :: target in s.replies && target.id == reply && target.room == room && reportedUnits(report) < boundaryOf(target)
{
  hide *;
  reveal inv, canReportHeard, heardVerdict, noReply, ProofLib.Filter;
  TurnsExtract(s);
  var p := (x: Reply) => (x.id == reply);
  ProofLib.FilterSamePredicate(p, (x: Reply) => (x.id == reply), s.replies);
  var f := ProofLib.Filter(p, s.replies);
  assert |f| > 0;
  ProofLib.FilterMember(p, s.replies, f[0]);
  assert f[0] in s.replies && f[0].id == reply;
}

lemma SliceWalkPrefix(f: (core__streamUnits_SliceWalk, int) -> core__streamUnits_SliceWalk, start: int, end: int, units: seq<int>, k: int)
  requires 0 <= start <= end <= |units| && 0 <= k <= |units|
  requires forall walk, code :: f(walk, code) == core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units))
  ensures Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(0, []), units[..k]) == core__streamUnits_SliceWalk(k, if k <= start then [] else if k <= end then units[start..k] else units[start..end])
  decreases k
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  if k == 0 {
    assert units[..0] == [];
  } else {
    SliceWalkPrefix(f, start, end, units, k - 1);
    assert units[..k] == units[..k - 1] + [units[k - 1]];
    ProofLib.FoldLeftAppend(f, core__streamUnits_SliceWalk(0, []), units[..k - 1], units[k - 1]);
  }
}

lemma SendFresh(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  ensures alwaysOneTurnPerRoomWithFreshIds(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, canSend, send, decide, viewOf, holdOf, timeAt, roomBusy, ProofLib.DistinctBy;
  TurnsExtract(s);
  RecordAtSpec(s, room, key);
  var tNow := timeAt(s, now);
  var view := viewOf(s, room, key, tNow);
  var adm := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  if adm.Unkeyed? || adm.Owner? {
    assert !roomBusy(s, room);
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.room);
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.id);
    TurnsProveFresh(after);
  } else if adm.Settled? && view.HeldUnanswered? {
    assert ProofLib.DistinctBy(after.replies, (r: Reply) => r.id);
    TurnsProveFresh(after);
  }
}

lemma SendKeyedNew(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires var adm := decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), (key != ""), roomBusy(s, room), fingerprint, s.nextId);
    adm.Unkeyed? || adm.Owner?
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, canSend, send, decide, viewOf, holdOf, timeAt, roomBusy, runningTurn, ProofLib.DistinctBy;
  TurnsExtract(s);
  RecordsExtract(s);
  RecordAtSpec(s, room, key);
  var tNow := timeAt(s, now);
  var view := viewOf(s, room, key, tNow);
  var adm := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  if adm.Owner? {
    assert view.NoKey? && key != "";
    assert recordAt(s, room, key).room == 0;
    assert ProofLib.DistinctBy(after.records, (q: KeyRecord) => (q.room, q.key));
  }
  RecordsProveKeyed(after);
}

lemma HeldUnansweredRecord(s: Turns, room: int, key: string, t: int)
  requires inv(s) && viewOf(s, room, key, t).HeldUnanswered?
  ensures key != "" && recordAt(s, room, key).room != 0 && runningTurn(recordAt(s, room, key).phase) == 0
{
  hide *;
  reveal viewOf, holdOf, runningTurn;
}

lemma SendKeyedSettled(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  requires var view := viewOf(s, room, key, timeAt(s, now));
    var adm := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
    adm.Settled? && view.HeldUnanswered?
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, send, runningTurn, ProofLib.DistinctBy;
  TurnsExtract(s);
  RecordsExtract(s);
  RecordAtSpec(s, room, key);
  HeldUnansweredRecord(s, room, key, timeAt(s, now));
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  var rec := recordAt(s, room, key);
  assert rec in s.records && rec.room == room && rec.key == key && runningTurn(rec.phase) == 0;
  assert ProofLib.DistinctBy(after.records, (q: KeyRecord) => (q.room, q.key));
  forall q | q in after.records
    ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < after.nextId && (runningTurn(q.phase) > 0 ==> q.userMessage == runningTurn(q.phase) && exists t :: t in after.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key)
  {
    var i :| 0 <= i < |s.records| && after.records[i] == q;
    assert s.records[i] in s.records;
  }
  forall t | t in after.turns && t.key != ""
    ensures exists q :: q in after.records && q.room == t.room && q.key == t.key && runningTurn(q.phase) == t.id
  {
    var orig :| orig in s.records && orig.room == t.room && orig.key == t.key && runningTurn(orig.phase) == t.id;
    var i :| 0 <= i < |s.records| && s.records[i] == orig;
    var j :| 0 <= j < |s.records| && s.records[j] == rec;
    if orig.room == room && orig.key == key {
      assert i == j && orig == rec;
      assert false;
    }
    assert after.records[i] in after.records && after.records[i] == orig;
  }
  RecordsProveKeyed(after);
}

lemma SendKeyed(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  ensures alwaysKeyedTurnsHoldTheirRecord(send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, send;
  var view := viewOf(s, room, key, timeAt(s, now));
  var adm := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  if adm.Unkeyed? || adm.Owner? {
    SendKeyedNew(s, room, key, fingerprint, now, inferenceReady);
  } else if adm.Settled? && view.HeldUnanswered? {
    SendKeyedSettled(s, room, key, fingerprint, now, inferenceReady);
  }
}

lemma SendRest(s: Turns, room: int, key: string, fingerprint: int, now: int, inferenceReady: bool)
  requires inv(s) && canSend(s, room, key, fingerprint, now, inferenceReady)
  ensures alwaysAnsweredKeysNameTheirReply(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures alwaysHeardBoundaryInsideTheReply(send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out)
  ensures stepARecordedKeyNeverRunsAgain(s, send(s, room, key, fingerprint, now, inferenceReady).state)
  ensures stepStopAnswersAreTrue(s, "send", send(s, room, key, fingerprint, now, inferenceReady).state, send(s, room, key, fingerprint, now, inferenceReady).out)
  ensures stepStoredRepliesStayWhole(s, send(s, room, key, fingerprint, now, inferenceReady).state)
{
  hide *;
  reveal inv, canSend, send, decide, viewOf, holdOf, timeAt, roomBusy, runningTurn, answeredReply, isRefusalOrReplay, boundaryOf, heardBoundary,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy;
  RecordsExtract(s);
  RecordAtSpec(s, room, key);
  var tNow := timeAt(s, now);
  var view := viewOf(s, room, key, tNow);
  var adm := decide(inferenceReady, view, (key != ""), roomBusy(s, room), fingerprint, s.nextId);
  var after := send(s, room, key, fingerprint, now, inferenceReady).state;
  if adm.Settled? && view.HeldUnanswered? {
    forall q | q in after.records && answeredReply(q.phase) > 0
      ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
    {
      var i :| 0 <= i < |s.records| && after.records[i] == q;
      var orig := s.records[i];
      if orig.room == room && orig.key == key {
        var rec := recordAt(s, room, key);
        var j :| 0 <= j < |s.records| && s.records[j] == rec;
        assert i == j && orig == rec;
        var newReply := after.replies[|s.replies|];
        assert newReply in after.replies && newReply.id == s.nextId && newReply.room == room && newReply.userMessage == rec.userMessage;
      }
    }
  }
}

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
    SendFresh(s, room, key, fingerprint, now, inferenceReady);
    SendKeyed(s, room, key, fingerprint, now, inferenceReady);
    SendRest(s, room, key, fingerprint, now, inferenceReady);
  }
}

lemma EndTurnFreshAndKeyed(s: Turns, turn: int, kind: ReplyKind, units: seq<int>, now: int)
  requires inv(s) && canEndTurn(s, turn, kind, now)
  ensures alwaysOneTurnPerRoomWithFreshIds(endTurn(s, turn, kind, units, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(endTurn(s, turn, kind, units, now).state)
{
  hide *;
  reveal inv, canEndTurn, endTurn, settleKey, runningTurn, ProofLib.DistinctBy, ProofLib.Filter;
  TurnsExtract(s);
  RecordsExtract(s);
  TurnAtSpec(s, turn);
  var cur := turnAt(s, turn);
  var after := endTurn(s, turn, kind, units, now).state;
  var neq := (x: Turn) => (x.id != turn);
  ProofLib.FilterKeepsDistinctBy(neq, s.turns, (t: Turn) => t.room);
  ProofLib.FilterKeepsDistinctBy(neq, s.turns, (t: Turn) => t.id);
  forall t | t in after.turns ensures t in s.turns && t.id != turn {
    ProofLib.FilterMember(neq, s.turns, t);
  }
  assert ProofLib.DistinctBy(after.replies, (r: Reply) => r.id);
  TurnsProveFresh(after);
  assert ProofLib.DistinctBy(after.records, (q: KeyRecord) => (q.room, q.key));
  forall t | t in after.turns && t.key != ""
    ensures exists q :: q in after.records && q.room == t.room && q.key == t.key && runningTurn(q.phase) == t.id
  {
    var orig :| orig in s.records && orig.room == t.room && orig.key == t.key && runningTurn(orig.phase) == t.id;
    var i :| 0 <= i < |s.records| && s.records[i] == orig;
    assert after.records[i] in after.records && after.records[i] == orig;
  }
  forall q | q in after.records && runningTurn(q.phase) > 0
    ensures q.userMessage == runningTurn(q.phase) && exists t :: t in after.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key
  {
    var i :| 0 <= i < |s.records| && after.records[i] == q;
    var orig := s.records[i];
    assert runningTurn(orig.phase) != turn && q == orig;
    var t :| t in s.turns && t.id == runningTurn(orig.phase) && t.room == orig.room && t.key == orig.key;
    ProofLib.FilterMember(neq, s.turns, t);
  }
  RecordsProveKeyed(after);
}

lemma EndTurnRest(s: Turns, turn: int, kind: ReplyKind, units: seq<int>, now: int)
  requires inv(s) && canEndTurn(s, turn, kind, now)
  ensures alwaysAnsweredKeysNameTheirReply(endTurn(s, turn, kind, units, now).state)
  ensures alwaysHeardBoundaryInsideTheReply(endTurn(s, turn, kind, units, now).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "endTurn", endTurn(s, turn, kind, units, now).state, endTurn(s, turn, kind, units, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, endTurn(s, turn, kind, units, now).state)
  ensures stepStopAnswersAreTrue(s, "endTurn", endTurn(s, turn, kind, units, now).state, endTurn(s, turn, kind, units, now).out)
  ensures stepStoredRepliesStayWhole(s, endTurn(s, turn, kind, units, now).state)
{
  hide *;
  reveal inv, canEndTurn, endTurn, settleKey, stopAnswerOnEnd, stopPending, stopWindowOpen, timeAt, roomBusy, runningTurn, answeredReply, boundaryOf, heardBoundary,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy, ProofLib.Filter;
  TurnsExtract(s);
  RecordsExtract(s);
  TurnAtSpec(s, turn);
  var cur := turnAt(s, turn);
  var after := endTurn(s, turn, kind, units, now).state;
  var neq := (x: Turn) => (x.id != turn);
  forall t | t in after.turns ensures t in s.turns && t.id != turn && t.room != cur.room {
    ProofLib.FilterMember(neq, s.turns, t);
    var i :| 0 <= i < |s.turns| && s.turns[i] == t;
    var j :| 0 <= j < |s.turns| && s.turns[j] == cur;
    assert i != j;
  }
  forall q | q in after.records && answeredReply(q.phase) > 0
    ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
  {
    var i :| 0 <= i < |s.records| && after.records[i] == q;
    var orig := s.records[i];
    if runningTurn(orig.phase) == turn {
      var t :| t in s.turns && t.id == turn && t.room == orig.room && t.key == orig.key;
      var a :| 0 <= a < |s.turns| && s.turns[a] == t;
      var b :| 0 <= b < |s.turns| && s.turns[b] == cur;
      assert a == b && t == cur;
      var newReply := after.replies[|s.replies|];
      assert newReply in after.replies && newReply.id == s.nextId && newReply.room == cur.room && newReply.userMessage == turn;
    }
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
  hide *;
  if inv(s) && canEndTurn(s, turn, kind, now) {
    EndTurnFreshAndKeyed(s, turn, kind, units, now);
    EndTurnRest(s, turn, kind, units, now);
  }
}

lemma EndWithoutReplyFreshAndKeyed(s: Turns, turn: int, now: int)
  requires inv(s) && canEndWithoutReply(s, turn)
  ensures alwaysOneTurnPerRoomWithFreshIds(endWithoutReply(s, turn, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(endWithoutReply(s, turn, now).state)
{
  hide *;
  reveal inv, canEndWithoutReply, endWithoutReply, settleKey, runningTurn, ProofLib.DistinctBy, ProofLib.Filter;
  TurnsExtract(s);
  RecordsExtract(s);
  TurnAtSpec(s, turn);
  var after := endWithoutReply(s, turn, now).state;
  var neq := (x: Turn) => (x.id != turn);
  ProofLib.FilterKeepsDistinctBy(neq, s.turns, (t: Turn) => t.room);
  ProofLib.FilterKeepsDistinctBy(neq, s.turns, (t: Turn) => t.id);
  forall t | t in after.turns ensures t in s.turns && t.id != turn {
    ProofLib.FilterMember(neq, s.turns, t);
  }
  TurnsProveFresh(after);
  assert ProofLib.DistinctBy(after.records, (q: KeyRecord) => (q.room, q.key));
  forall t | t in after.turns && t.key != ""
    ensures exists q :: q in after.records && q.room == t.room && q.key == t.key && runningTurn(q.phase) == t.id
  {
    var orig :| orig in s.records && orig.room == t.room && orig.key == t.key && runningTurn(orig.phase) == t.id;
    var i :| 0 <= i < |s.records| && s.records[i] == orig;
    assert after.records[i] in after.records && after.records[i] == orig;
  }
  forall q | q in after.records && runningTurn(q.phase) > 0
    ensures q.userMessage == runningTurn(q.phase) && exists t :: t in after.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key
  {
    var i :| 0 <= i < |s.records| && after.records[i] == q;
    var orig := s.records[i];
    assert runningTurn(orig.phase) != turn && q == orig;
    var t :| t in s.turns && t.id == runningTurn(orig.phase) && t.room == orig.room && t.key == orig.key;
    ProofLib.FilterMember(neq, s.turns, t);
  }
  RecordsProveKeyed(after);
}

lemma EndWithoutReplyRest(s: Turns, turn: int, now: int)
  requires inv(s) && canEndWithoutReply(s, turn)
  ensures alwaysAnsweredKeysNameTheirReply(endWithoutReply(s, turn, now).state)
  ensures alwaysHeardBoundaryInsideTheReply(endWithoutReply(s, turn, now).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "endWithoutReply", endWithoutReply(s, turn, now).state, endWithoutReply(s, turn, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, endWithoutReply(s, turn, now).state)
  ensures stepStopAnswersAreTrue(s, "endWithoutReply", endWithoutReply(s, turn, now).state, endWithoutReply(s, turn, now).out)
  ensures stepStoredRepliesStayWhole(s, endWithoutReply(s, turn, now).state)
{
  hide *;
  reveal inv, canEndWithoutReply, endWithoutReply, settleKey, stopAnswerOnEnd, stopPending, stopWindowOpen, timeAt, roomBusy, runningTurn, answeredReply, boundaryOf, heardBoundary,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy, ProofLib.Filter;
  TurnsExtract(s);
  TurnAtSpec(s, turn);
  var cur := turnAt(s, turn);
  var after := endWithoutReply(s, turn, now).state;
  var neq := (x: Turn) => (x.id != turn);
  forall t | t in after.turns ensures t in s.turns && t.id != turn && t.room != cur.room {
    ProofLib.FilterMember(neq, s.turns, t);
    var i :| 0 <= i < |s.turns| && s.turns[i] == t;
    var j :| 0 <= j < |s.turns| && s.turns[j] == cur;
    assert i != j;
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
  hide *;
  if inv(s) && canEndWithoutReply(s, turn) {
    EndWithoutReplyFreshAndKeyed(s, turn, now);
    EndWithoutReplyRest(s, turn, now);
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
  hide *;
  reveal inv, restart, runningTurn, answeredReply,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy;
  if inv(s) {
    TurnsExtract(s);
    RecordsExtract(s);
    var after := restart(s);
    TurnsProveFresh(after);
    assert ProofLib.DistinctBy(after.records, (q: KeyRecord) => (q.room, q.key));
    forall q | q in after.records ensures q.key != "" && q.room >= 1 && q.userMessage >= 1 && q.userMessage < after.nextId && runningTurn(q.phase) <= 0 {
      var i :| 0 <= i < |s.records| && after.records[i] == q;
      assert s.records[i] in s.records;
    }
    RecordsProveKeyed(after);
  }
}

lemma RequestStopFreshAndKeyed(s: Turns, room: int, now: int)
  requires inv(s) && canRequestStop(s, room, now)
  ensures alwaysOneTurnPerRoomWithFreshIds(requestStop(s, room, now).state)
  ensures alwaysKeyedTurnsHoldTheirRecord(requestStop(s, room, now).state)
{
  hide *;
  reveal inv, canRequestStop, requestStop, stopPending, runningTurn, ProofLib.DistinctBy;
  TurnsExtract(s);
  RecordsExtract(s);
  TurnInRoomSpec(s, room);
  var cur := turnInRoom(s, room);
  var after := requestStop(s, room, now).state;
  if cur.id != 0 && !stopPending(cur.phase) {
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.room);
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.id);
    TurnsProveFresh(after);
    forall q | q in after.records && runningTurn(q.phase) > 0
      ensures exists t :: t in after.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key
    {
      var orig :| orig in s.turns && orig.id == runningTurn(q.phase) && orig.room == q.room && orig.key == q.key;
      var i :| 0 <= i < |s.turns| && s.turns[i] == orig;
      assert after.turns[i] in after.turns;
    }
    RecordsProveKeyed(after);
  }
}

lemma RequestStopRest(s: Turns, room: int, now: int)
  requires inv(s) && canRequestStop(s, room, now)
  ensures alwaysAnsweredKeysNameTheirReply(requestStop(s, room, now).state)
  ensures alwaysHeardBoundaryInsideTheReply(requestStop(s, room, now).state)
  ensures stepRefusalsAndRepeatsStoreNothing(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out)
  ensures stepARecordedKeyNeverRunsAgain(s, requestStop(s, room, now).state)
  ensures stepStopAnswersAreTrue(s, "requestStop", requestStop(s, room, now).state, requestStop(s, room, now).out)
  ensures stepStoredRepliesStayWhole(s, requestStop(s, room, now).state)
{
  hide *;
  reveal inv, canRequestStop, requestStop, stopPending, roomBusy,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole;
  TurnInRoomSpec(s, room);
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
    RequestStopFreshAndKeyed(s, room, now);
    RequestStopRest(s, room, now);
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
  hide *;
  reveal inv, canStopDeadline, stopDeadline, stopPending, stopWindowOpen, timeAt, roomBusy, runningTurn, answeredReply, noTurn,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy;
  if inv(s) && canStopDeadline(s, room, now) {
    TurnsExtract(s);
    RecordsExtract(s);
    var p := (t: Turn) => (t.room == room);
    TurnInRoomFilter(s, room, p);
    var f := ProofLib.Filter(p, s.turns);
    assert |f| > 0;
    ProofLib.FilterMember(p, s.turns, f[0]);
    var after := stopDeadline(s, room, now).state;
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.room);
    assert ProofLib.DistinctBy(after.turns, (t: Turn) => t.id);
    TurnsProveFresh(after);
    forall q | q in after.records && runningTurn(q.phase) > 0
      ensures exists t :: t in after.turns && t.id == runningTurn(q.phase) && t.room == q.room && t.key == q.key
    {
      var orig :| orig in s.turns && orig.id == runningTurn(q.phase) && orig.room == q.room && orig.key == q.key;
      var i :| 0 <= i < |s.turns| && s.turns[i] == orig;
      assert after.turns[i] in after.turns;
    }
    RecordsProveKeyed(after);
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
  hide *;
  reveal inv, canReportHeard, reportHeard, reportedUnits, boundaryOf, heardBoundary, answeredReply,
    alwaysAnsweredKeysNameTheirReply, alwaysHeardBoundaryInsideTheReply,
    stepRefusalsAndRepeatsStoreNothing, stepARecordedKeyNeverRunsAgain, stepStopAnswersAreTrue, stepStoredRepliesStayWhole,
    ProofLib.DistinctBy;
  if inv(s) && canReportHeard(s, room, reply, report) {
    TurnsExtract(s);
    RecordsExtract(s);
    var v := heardVerdict(s, room, reply, report);
    if v.HeardRecorded? {
      HeardReplyLookup(s, room, reply, report);
      var target :| target in s.replies && target.id == reply && target.room == room && reportedUnits(report) < boundaryOf(target);
      var tIdx :| 0 <= tIdx < |s.replies| && s.replies[tIdx] == target;
      var after := reportHeard(s, room, reply, report).state;
      assert ProofLib.DistinctBy(after.replies, (r: Reply) => r.id);
      TurnsProveFresh(after);
      RecordsProveKeyed(after);
      forall r | r in s.replies
        ensures exists x :: x in after.replies && x.id == r.id && x.room == r.room && x.userMessage == r.userMessage && x.units == r.units && x.kind == r.kind && boundaryOf(x) <= boundaryOf(r)
      {
        var i :| 0 <= i < |s.replies| && s.replies[i] == r;
        var x := after.replies[i];
        assert x in after.replies;
        if r.id == reply {
          assert i == tIdx && r == target;
          assert boundaryOf(x) == reportedUnits(report) < boundaryOf(r);
        }
      }
      forall r | r in after.replies ensures 0 <= boundaryOf(r) <= |r.units| {
        var i :| 0 <= i < |s.replies| && after.replies[i] == r;
        var orig := s.replies[i];
        if orig.id == reply {
          assert i == tIdx && orig == target;
        }
      }
      forall q | q in after.records && answeredReply(q.phase) > 0
        ensures exists r :: r in after.replies && r.id == answeredReply(q.phase) && r.room == q.room && r.userMessage == q.userMessage
      {
        var orig :| orig in s.replies && orig.id == answeredReply(q.phase) && orig.room == q.room && orig.userMessage == q.userMessage;
        var i :| 0 <= i < |s.replies| && s.replies[i] == orig;
        assert after.replies[i] in after.replies;
      }
    }
  }
}

lemma lawHeardAndUnheardMakeTheReply_ensures(r: Reply)
  ensures (lawHeardAndUnheardMakeTheReply(r) == true)
{
  hide *;
  reveal lawHeardAndUnheardMakeTheReply, heardPart, unheardPart, core__streamUnits_sliceUnits;
  var b := boundaryOf(r);
  if 0 <= b <= |r.units| {
    var f1 := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < b)) then (walk.units + [code]) else walk.units));
    var f2 := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= b) && (walk.offset < |r.units|)) then (walk.units + [code]) else walk.units));
    SliceWalkPrefix(f1, 0, b, r.units, |r.units|);
    SliceWalkPrefix(f2, b, |r.units|, r.units, |r.units|);
    assert r.units[..|r.units|] == r.units;
    assert heardPart(r) == r.units[0..b];
    assert unheardPart(r) == r.units[b..|r.units|];
  }
}
