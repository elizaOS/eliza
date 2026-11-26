lemma FilterLenLe<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLenLe(p, xs[1..]);
  }
}

lemma FilterAllKeep<T>(p: T -> bool, xs: seq<T>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FilterAllKeep(p, xs[1..]);
  }
}

lemma FilterDropOneLen<T>(p: T -> bool, xs: seq<T>, idx: int)
  requires 0 <= idx < |xs| && !p(xs[idx])
  requires forall j :: 0 <= j < |xs| && j != idx ==> p(xs[j])
  ensures |ProofLib.Filter(p, xs)| == |xs| - 1
  decreases |xs|
{
  ProofLib.FilterCons(p, xs);
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1] && p(xs[1..][j]);
    FilterAllKeep(p, xs[1..]);
  } else {
    assert forall j :: 0 <= j < |xs[1..]| && j != idx - 1 ==> xs[1..][j] == xs[j + 1] && p(xs[1..][j]);
    assert xs[1..][idx - 1] == xs[idx];
    FilterDropOneLen(p, xs[1..], idx - 1);
  }
}

lemma PendingSeqsDistinctIff(pending: seq<Entry>)
  ensures (forall e :: e in pending ==> |ProofLib.Filter((o: Entry) => (o.seq_ == e.seq_), pending)| == 1) <==> ProofLib.DistinctBy(pending, (e: Entry) => e.seq_)
{
  if forall e :: e in pending ==> |ProofLib.Filter((o: Entry) => (o.seq_ == e.seq_), pending)| == 1 {
    forall i, j | 0 <= i < |pending| && 0 <= j < |pending| && i != j
      ensures pending[i].seq_ != pending[j].seq_
    {
      ProofLib.FilterCountOneIffUnique((o: Entry) => (o.seq_ == pending[i].seq_), pending, (e: Entry) => e.seq_, i);
    }
  }
  if ProofLib.DistinctBy(pending, (e: Entry) => e.seq_) {
    forall e | e in pending
      ensures |ProofLib.Filter((o: Entry) => (o.seq_ == e.seq_), pending)| == 1
    {
      var i :| 0 <= i < |pending| && pending[i] == e;
      ProofLib.FilterOne((o: Entry) => (o.seq_ == e.seq_), pending, i);
    }
  }
}

lemma PendingIdsDistinctIff(pending: seq<Entry>)
  ensures (forall e :: e in pending ==> |ProofLib.Filter((o: Entry) => (o.id == e.id), pending)| == 1) <==> ProofLib.DistinctBy(pending, (e: Entry) => e.id)
{
  if forall e :: e in pending ==> |ProofLib.Filter((o: Entry) => (o.id == e.id), pending)| == 1 {
    forall i, j | 0 <= i < |pending| && 0 <= j < |pending| && i != j
      ensures pending[i].id != pending[j].id
    {
      ProofLib.FilterCountOneIffUnique((o: Entry) => (o.id == pending[i].id), pending, (e: Entry) => e.id, i);
    }
  }
  if ProofLib.DistinctBy(pending, (e: Entry) => e.id) {
    forall e | e in pending
      ensures |ProofLib.Filter((o: Entry) => (o.id == e.id), pending)| == 1
    {
      var i :| 0 <= i < |pending| && pending[i] == e;
      ProofLib.FilterOne((o: Entry) => (o.id == e.id), pending, i);
    }
  }
}

lemma EntryAtMatches(s: AgentChannel, seq_: int, e: Entry)
  requires ProofLib.DistinctBy(s.pending, (e: Entry) => e.seq_)
  requires e in s.pending && e.seq_ == seq_
  ensures entryAt(seq_, s) == e
{
  var i :| 0 <= i < |s.pending| && s.pending[i] == e;
  var f := ProofLib.Filter((x: Entry) => (x.seq_ == seq_), s.pending);
  ProofLib.FilterOne((x: Entry) => (x.seq_ == seq_), s.pending, i);
  ProofLib.FilterMember((x: Entry) => (x.seq_ == seq_), s.pending, e);
  assert e in f;
  assert f[0] == e;
}

lemma EntryAtAbsent(s: AgentChannel, seq_: int)
  requires forall e :: e in s.pending ==> e.seq_ != seq_
  ensures entryAt(seq_, s) == noEntry
{
  ProofLib.FilterNone((x: Entry) => (x.seq_ == seq_), s.pending);
}

lemma SettledSeqsSingle(item: ChannelOut)
  ensures settledSeqs([item]) == (if item.Settled? then [item.seq_] else [])
{
  assert [item] == [] + [item];
  ProofLib.FoldLeftAppend((acc: seq<int>, o: ChannelOut) => (if o.Settled? then (acc + [o.seq_]) else acc), [], [], item);
}

lemma AdmitEntryPreserves(s: AgentChannel, id: string, owner: string, mode: Mode, via: string)
  requires inv(s)
  requires via != "abort"
  requires !s.launch.NotServing?
  requires id != "" && !idPending(s, id)
  requires isWatch(mode) ==> feeds(s) < agent__access__transport_feedLimit && !(exists e :: e in s.pending && e.mode == mode)
  ensures var step := admitEntry(id, owner, mode, s);
    inv(step.state) &&
    stepRefusalOpensNothing(s, via, step.state, step.out) &&
    stepAcceptedTakesTheNextSeq(s, via, step.state, step.out) &&
    stepEveryLeavingCallSettlesOnce(s, via, step.state, step.out) &&
    stepFramesArriveInOrder(s, via, step.state, step.out) &&
    stepAbortTouchesOnlyThatCall(s, via, step.state) &&
    stepUnansweredFrameChangesNothing(s, via, step.state, step.out)
{
  var added := Entry(s.nextSeq, id, owner, mode, servingEpoch(s), 0);
  var step := admitEntry(id, owner, mode, s);
  var after := step.state;
  assert after.pending == s.pending + [added];
  PendingSeqsDistinctIff(s.pending);
  PendingIdsDistinctIff(s.pending);
  ProofLib.DistinctByConcat(s.pending, [added], (e: Entry) => e.seq_);
  ProofLib.DistinctByConcat(s.pending, [added], (e: Entry) => e.id);
  PendingSeqsDistinctIff(after.pending);
  PendingIdsDistinctIff(after.pending);
  ProofLib.FilterAppend((e: Entry) => isWatch(e.mode), s.pending, added);
  assert feeds(after) == feeds(s) + (if isWatch(mode) then 1 else 0);
  forall e | e in after.pending && isWatch(e.mode)
    ensures |ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending)| == 1
  {
    ProofLib.FilterAppend((o: Entry) => (o.mode == e.mode), s.pending, added);
    if e == added {
      ProofLib.FilterNone((o: Entry) => (o.mode == e.mode), s.pending);
    } else {
      assert e in s.pending;
      assert e.mode != added.mode;
    }
  }
  SettledSeqsSingle(Accepted(id, s.nextSeq));
  assert settledSeqs(step.out) == [];
}

lemma ask_ensures(s: AgentChannel, kind: CallerKind, owner: string, id: string, request: agent__access__routes_Request, headers: seq<agent__client__runtimeClient_RequestHeader>)
  ensures (inv(s) ==> alwaysTokenOnlyWhileServing(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> alwaysLaunchIsTheLatest(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> alwaysPendingBelongToServingLaunch(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> alwaysSeqsFreshAndDistinct(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> alwaysPlainCallsDeliverNothing(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> alwaysOneSubscriptionPerTopic(ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> stepRefusalOpensNothing(s, "ask", ask(s, kind, owner, id, request, headers).state, ask(s, kind, owner, id, request, headers).out))
  ensures (inv(s) ==> stepAcceptedTakesTheNextSeq(s, "ask", ask(s, kind, owner, id, request, headers).state, ask(s, kind, owner, id, request, headers).out))
  ensures (inv(s) ==> stepEveryLeavingCallSettlesOnce(s, "ask", ask(s, kind, owner, id, request, headers).state, ask(s, kind, owner, id, request, headers).out))
  ensures (inv(s) ==> stepFramesArriveInOrder(s, "ask", ask(s, kind, owner, id, request, headers).state, ask(s, kind, owner, id, request, headers).out))
  ensures (inv(s) ==> stepAbortTouchesOnlyThatCall(s, "ask", ask(s, kind, owner, id, request, headers).state))
  ensures (inv(s) ==> stepUnansweredFrameChangesNothing(s, "ask", ask(s, kind, owner, id, request, headers).state, ask(s, kind, owner, id, request, headers).out))
{
  if inv(s) {
    var local_1 := refusalOf(s, kind, id, request, headers);
    if |local_1| > 0 {
      var code := if 0 < |local_1| then local_1[0] else FailCode.NotReady;
      SettledSeqsSingle(ChannelOut.Refused(id, code));
    } else {
      AdmitEntryPreserves(s, id, owner, if request.delivery.Streamed? then Mode.Stream else Mode.Plain, "ask");
    }
  }
}

lemma lawAWellFormedEnrollmentKeyCrosses_ensures(headers: seq<agent__client__runtimeClient_RequestHeader>)
  ensures (lawAWellFormedEnrollmentKeyCrosses(headers) == true)
{
  if |headers| == 1 && !(exists h :: h in headers && !(h.name.EnrollmentKey? && h.printable && h.bytes <= agent__client__runtimeClient_headerBytesLimit)) {
    var h := headers[0];
    assert headers == [h];
    assert h in headers;
    ProofLib.FilterOne((o: agent__client__runtimeClient_RequestHeader) => (o.key == h.key), headers, 0);
    assert agent__client__runtimeClient_headersCross(headers);
    assert Std.Collections.Seq.FoldLeft((total: int, x: agent__client__runtimeClient_RequestHeader) => (total + x.bytes), 0, headers) == h.bytes;
    assert agent__client__runtimeClient_headersFit(headers);
  }
}

lemma ReactPreserves(s: AgentChannel, seq_: int, r: Reaction, via: string)
  requires inv(s)
  requires via == "reply" || via == "lost"
  requires r.Deliver? ==> !entryAt(seq_, s).mode.Plain?
  ensures var step := react(seq_, s, r);
    inv(step.state) &&
    stepRefusalOpensNothing(s, via, step.state, step.out) &&
    stepAcceptedTakesTheNextSeq(s, via, step.state, step.out) &&
    stepEveryLeavingCallSettlesOnce(s, via, step.state, step.out) &&
    stepFramesArriveInOrder(s, via, step.state, step.out) &&
    stepAbortTouchesOnlyThatCall(s, via, step.state) &&
    stepUnansweredFrameChangesNothing(s, via, step.state, step.out)
{
  PendingSeqsDistinctIff(s.pending);
  PendingIdsDistinctIff(s.pending);
  var step := react(seq_, s, r);
  var after := step.state;
  var local_2 := entryAt(seq_, s);
  if local_2.seq_ < 0 {
    assert step == ChannelStep(s, []);
  } else {
    var fEq := ProofLib.Filter((e: Entry) => (e.seq_ == seq_), s.pending);
    assert |fEq| > 0;
    ProofLib.FilterMember((e: Entry) => (e.seq_ == seq_), s.pending, fEq[0]);
    assert local_2 in s.pending && local_2.seq_ == seq_;
    if r.Deliver? {
      assert |after.pending| == |s.pending|;
      forall i | 0 <= i < |after.pending|
        ensures after.pending[i].seq_ == s.pending[i].seq_
        ensures after.pending[i].id == s.pending[i].id
        ensures after.pending[i].mode == s.pending[i].mode
        ensures after.pending[i].epoch == s.pending[i].epoch
      {
      }
      PendingSeqsDistinctIff(after.pending);
      PendingIdsDistinctIff(after.pending);
      ProofLib.FilterLengthPointwise((e: Entry) => isWatch(e.mode), (e: Entry) => isWatch(e.mode), s.pending, after.pending);
      forall e | e in after.pending && isWatch(e.mode)
        ensures |ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending)| == 1
      {
        var i :| 0 <= i < |after.pending| && after.pending[i] == e;
        var orig := s.pending[i];
        assert orig in s.pending && orig.mode == e.mode;
        ProofLib.FilterLengthPointwise((o: Entry) => (o.mode == e.mode), (o: Entry) => (o.mode == e.mode), s.pending, after.pending);
      }
      var idx :| 0 <= idx < |s.pending| && s.pending[idx] == local_2;
      var updated := local_2.(delivered := local_2.delivered + 1);
      assert after.pending[idx] == updated;
      EntryAtMatches(after, seq_, updated);
      SettledSeqsSingle(Delivered(local_2.id, seq_, local_2.delivered + 1));
      assert settledSeqs(step.out) == [];
      forall e | e in s.pending
        ensures exists o :: o in after.pending && o.seq_ == e.seq_
      {
        var ei :| 0 <= ei < |s.pending| && s.pending[ei] == e;
        assert after.pending[ei] in after.pending && after.pending[ei].seq_ == e.seq_;
      }
    } else if r.Settle? {
      assert after.pending == ProofLib.Filter((o: Entry) => (o.seq_ != seq_), s.pending);
      ProofLib.FilterKeepsDistinctBy((o: Entry) => (o.seq_ != seq_), s.pending, (e: Entry) => e.seq_);
      ProofLib.FilterKeepsDistinctBy((o: Entry) => (o.seq_ != seq_), s.pending, (e: Entry) => e.id);
      PendingSeqsDistinctIff(after.pending);
      PendingIdsDistinctIff(after.pending);
      forall e | e in after.pending
        ensures e in s.pending && e.seq_ != seq_
      {
        ProofLib.FilterMember((o: Entry) => (o.seq_ != seq_), s.pending, e);
      }
      ProofLib.FilterOfFilterShorter((o: Entry) => (o.seq_ != seq_), (e: Entry) => isWatch(e.mode), s.pending);
      assert feeds(after) <= feeds(s);
      forall e | e in after.pending && isWatch(e.mode)
        ensures |ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending)| == 1
      {
        ProofLib.FilterOfFilterShorter((o: Entry) => (o.seq_ != seq_), (o: Entry) => (o.mode == e.mode), s.pending);
        ProofLib.FilterMember((o: Entry) => (o.mode == e.mode), after.pending, e);
        assert e in ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending);
      }
      var outItem := settledOut(local_2, r.outcome);
      SettledSeqsSingle(outItem);
      assert settledSeqs(step.out) == [seq_];
      ProofLib.FilterOne((q: int) => (q == seq_), [seq_], 0);
      forall e | e in s.pending
        ensures (exists o :: o in after.pending && o.seq_ == e.seq_) || |ProofLib.Filter((q: int) => (q == e.seq_), settledSeqs(step.out))| == 1
      {
        if e.seq_ != seq_ {
          ProofLib.FilterMember((o: Entry) => (o.seq_ != seq_), s.pending, e);
          assert e in after.pending;
        }
      }
    }
  }
}

lemma reply_ensures(s: AgentChannel, seq_: int, frame: agent__access__transport_Frame)
  ensures (inv(s) ==> alwaysTokenOnlyWhileServing(reply(s, seq_, frame).state))
  ensures (inv(s) ==> alwaysLaunchIsTheLatest(reply(s, seq_, frame).state))
  ensures (inv(s) ==> alwaysPendingBelongToServingLaunch(reply(s, seq_, frame).state))
  ensures (inv(s) ==> alwaysSeqsFreshAndDistinct(reply(s, seq_, frame).state))
  ensures (inv(s) ==> alwaysPlainCallsDeliverNothing(reply(s, seq_, frame).state))
  ensures (inv(s) ==> alwaysOneSubscriptionPerTopic(reply(s, seq_, frame).state))
  ensures (inv(s) ==> stepRefusalOpensNothing(s, "reply", reply(s, seq_, frame).state, reply(s, seq_, frame).out))
  ensures (inv(s) ==> stepAcceptedTakesTheNextSeq(s, "reply", reply(s, seq_, frame).state, reply(s, seq_, frame).out))
  ensures (inv(s) ==> stepEveryLeavingCallSettlesOnce(s, "reply", reply(s, seq_, frame).state, reply(s, seq_, frame).out))
  ensures (inv(s) ==> stepFramesArriveInOrder(s, "reply", reply(s, seq_, frame).state, reply(s, seq_, frame).out))
  ensures (inv(s) ==> stepAbortTouchesOnlyThatCall(s, "reply", reply(s, seq_, frame).state))
  ensures (inv(s) ==> stepUnansweredFrameChangesNothing(s, "reply", reply(s, seq_, frame).state, reply(s, seq_, frame).out))
{
  if inv(s) {
    ReactPreserves(s, seq_, reactionOf(entryAt(seq_, s).mode, frame), "reply");
  }
}

lemma lost_ensures(s: AgentChannel, seq_: int)
  ensures (inv(s) ==> alwaysTokenOnlyWhileServing(lost(s, seq_).state))
  ensures (inv(s) ==> alwaysLaunchIsTheLatest(lost(s, seq_).state))
  ensures (inv(s) ==> alwaysPendingBelongToServingLaunch(lost(s, seq_).state))
  ensures (inv(s) ==> alwaysSeqsFreshAndDistinct(lost(s, seq_).state))
  ensures (inv(s) ==> alwaysPlainCallsDeliverNothing(lost(s, seq_).state))
  ensures (inv(s) ==> alwaysOneSubscriptionPerTopic(lost(s, seq_).state))
  ensures (inv(s) ==> stepRefusalOpensNothing(s, "lost", lost(s, seq_).state, lost(s, seq_).out))
  ensures (inv(s) ==> stepAcceptedTakesTheNextSeq(s, "lost", lost(s, seq_).state, lost(s, seq_).out))
  ensures (inv(s) ==> stepEveryLeavingCallSettlesOnce(s, "lost", lost(s, seq_).state, lost(s, seq_).out))
  ensures (inv(s) ==> stepFramesArriveInOrder(s, "lost", lost(s, seq_).state, lost(s, seq_).out))
  ensures (inv(s) ==> stepAbortTouchesOnlyThatCall(s, "lost", lost(s, seq_).state))
  ensures (inv(s) ==> stepUnansweredFrameChangesNothing(s, "lost", lost(s, seq_).state, lost(s, seq_).out))
{
  if inv(s) {
    ReactPreserves(s, seq_, Settle(lostOutcome(entryAt(seq_, s).mode)), "lost");
  }
}

lemma abort_ensures(s: AgentChannel, owner: string, id: string)
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysTokenOnlyWhileServing(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysLaunchIsTheLatest(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysPendingBelongToServingLaunch(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysSeqsFreshAndDistinct(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysPlainCallsDeliverNothing(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> alwaysOneSubscriptionPerTopic(abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepRefusalOpensNothing(s, "abort", abort(s, owner, id).state, abort(s, owner, id).out))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepAcceptedTakesTheNextSeq(s, "abort", abort(s, owner, id).state, abort(s, owner, id).out))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepEveryLeavingCallSettlesOnce(s, "abort", abort(s, owner, id).state, abort(s, owner, id).out))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepFramesArriveInOrder(s, "abort", abort(s, owner, id).state, abort(s, owner, id).out))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepAbortTouchesOnlyThatCall(s, "abort", abort(s, owner, id).state))
  ensures (inv(s) ==> canAbort(s, owner, id) ==> stepUnansweredFrameChangesNothing(s, "abort", abort(s, owner, id).state, abort(s, owner, id).out))
{
  hide *;
  reveal inv, canAbort, ownCall, abort, emit, settledOut, isWatch, feeds, servingEpoch, ProofLib.Filter, ProofLib.DistinctBy;
  reveal alwaysTokenOnlyWhileServing, alwaysLaunchIsTheLatest, alwaysPendingBelongToServingLaunch;
  reveal alwaysSeqsFreshAndDistinct, alwaysPlainCallsDeliverNothing, alwaysOneSubscriptionPerTopic;
  reveal stepRefusalOpensNothing, stepAcceptedTakesTheNextSeq, stepEveryLeavingCallSettlesOnce;
  reveal stepFramesArriveInOrder, stepAbortTouchesOnlyThatCall, stepUnansweredFrameChangesNothing;
  if inv(s) && canAbort(s, owner, id) {
    PendingSeqsDistinctIff(s.pending);
    PendingIdsDistinctIff(s.pending);
    var found :| found in s.pending && found.id == id && found.owner == owner;
    var wi :| 0 <= wi < |s.pending| && s.pending[wi] == found;
    var fEq := ProofLib.Filter((o: Entry) => (o.id == id), s.pending);
    ProofLib.FilterOne((o: Entry) => (o.id == id), s.pending, wi);
    ProofLib.FilterMember((o: Entry) => (o.id == id), s.pending, found);
    assert fEq[0] == found;
    var step := abort(s, owner, id);
    var after := step.state;
    assert after.pending == ProofLib.Filter((o: Entry) => (o.id != id), s.pending);
    FilterDropOneLen((o: Entry) => (o.id != id), s.pending, wi);
    ProofLib.FilterKeepsDistinctBy((o: Entry) => (o.id != id), s.pending, (e: Entry) => e.seq_);
    ProofLib.FilterKeepsDistinctBy((o: Entry) => (o.id != id), s.pending, (e: Entry) => e.id);
    PendingSeqsDistinctIff(after.pending);
    PendingIdsDistinctIff(after.pending);
    forall e | e in after.pending
      ensures e in s.pending && e.id != id && e.seq_ != found.seq_
    {
      ProofLib.FilterMember((o: Entry) => (o.id != id), s.pending, e);
      var ei :| 0 <= ei < |s.pending| && s.pending[ei] == e;
      assert ei != wi;
    }
    ProofLib.FilterOfFilterShorter((o: Entry) => (o.id != id), (e: Entry) => isWatch(e.mode), s.pending);
    assert feeds(after) <= feeds(s);
    forall e | e in after.pending && isWatch(e.mode)
      ensures |ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending)| == 1
    {
      ProofLib.FilterOfFilterShorter((o: Entry) => (o.id != id), (o: Entry) => (o.mode == e.mode), s.pending);
      ProofLib.FilterMember((o: Entry) => (o.mode == e.mode), after.pending, e);
      assert e in ProofLib.Filter((o: Entry) => (o.mode == e.mode), after.pending);
    }
    var ending := if isWatch(found.mode) then Outcome.End else Outcome.Aborted;
    SettledSeqsSingle(settledOut(found, ending));
    assert settledSeqs(step.out) == [found.seq_];
    ProofLib.FilterOne((q: int) => (q == found.seq_), [found.seq_], 0);
    forall e | e in s.pending
      ensures (exists o :: o in after.pending && o.seq_ == e.seq_) || |ProofLib.Filter((q: int) => (q == e.seq_), settledSeqs(step.out))| == 1
    {
      if e.id != id {
        ProofLib.FilterMember((o: Entry) => (o.id != id), s.pending, e);
        assert e in after.pending;
      } else {
        var ei :| 0 <= ei < |s.pending| && s.pending[ei] == e;
        assert ei == wi;
        assert e == found;
      }
    }
  }
}

lemma SettledSeqsOfRetire(xs: seq<Entry>, out: seq<ChannelOut>)
  requires |out| == |xs|
  requires forall i :: 0 <= i < |xs| ==> out[i] == settledOut(xs[i], Outcome.Failed(FailCode.Restarted))
  ensures |settledSeqs(out)| == |xs|
  ensures forall i :: 0 <= i < |xs| ==> settledSeqs(out)[i] == xs[i].seq_
  decreases |xs|
{
  if |xs| > 0 {
    var lead := xs[..|xs| - 1];
    var outLead := out[..|out| - 1];
    var outLast := out[|out| - 1];
    assert out == outLead + [outLast];
    ProofLib.FoldLeftAppend((acc: seq<int>, o: ChannelOut) => (if o.Settled? then (acc + [o.seq_]) else acc), [], outLead, outLast);
    SettledSeqsOfRetire(lead, outLead);
  }
}

lemma retire_ensures(s: AgentChannel, epoch: int)
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysTokenOnlyWhileServing(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysLaunchIsTheLatest(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysPendingBelongToServingLaunch(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysSeqsFreshAndDistinct(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysPlainCallsDeliverNothing(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> alwaysOneSubscriptionPerTopic(retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepRefusalOpensNothing(s, "retire", retire(s, epoch).state, retire(s, epoch).out))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepAcceptedTakesTheNextSeq(s, "retire", retire(s, epoch).state, retire(s, epoch).out))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepEveryLeavingCallSettlesOnce(s, "retire", retire(s, epoch).state, retire(s, epoch).out))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepFramesArriveInOrder(s, "retire", retire(s, epoch).state, retire(s, epoch).out))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepAbortTouchesOnlyThatCall(s, "retire", retire(s, epoch).state))
  ensures (inv(s) ==> canRetire(s, epoch) ==> stepUnansweredFrameChangesNothing(s, "retire", retire(s, epoch).state, retire(s, epoch).out))
{
  if inv(s) && canRetire(s, epoch) {
    var step := retire(s, epoch);
    SettledSeqsOfRetire(s.pending, step.out);
    var qs := settledSeqs(step.out);
    assert |qs| == |s.pending|;
    forall i | 0 <= i < |s.pending|
      ensures qs[i] == s.pending[i].seq_
    {
    }
    forall e | e in s.pending
      ensures |ProofLib.Filter((q: int) => (q == e.seq_), qs)| == 1
    {
      ProofLib.FilterLengthPointwise((o: Entry) => (o.seq_ == e.seq_), (q: int) => (q == e.seq_), s.pending, qs);
    }
    forall q | q in qs
      ensures (exists e :: e in s.pending && e.seq_ == q) && |ProofLib.Filter((p: int) => (p == q), qs)| == 1
    {
      var i :| 0 <= i < |qs| && qs[i] == q;
      var e := s.pending[i];
      assert e in s.pending && e.seq_ == q;
      ProofLib.FilterLengthPointwise((o: Entry) => (o.seq_ == q), (p: int) => (p == q), s.pending, qs);
    }
  }
}

lemma subscribe_ensures(s: AgentChannel, owner: string, id: string, topic: Topic)
  ensures (inv(s) ==> alwaysTokenOnlyWhileServing(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> alwaysLaunchIsTheLatest(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> alwaysPendingBelongToServingLaunch(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> alwaysSeqsFreshAndDistinct(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> alwaysPlainCallsDeliverNothing(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> alwaysOneSubscriptionPerTopic(subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> stepRefusalOpensNothing(s, "subscribe", subscribe(s, owner, id, topic).state, subscribe(s, owner, id, topic).out))
  ensures (inv(s) ==> stepAcceptedTakesTheNextSeq(s, "subscribe", subscribe(s, owner, id, topic).state, subscribe(s, owner, id, topic).out))
  ensures (inv(s) ==> stepEveryLeavingCallSettlesOnce(s, "subscribe", subscribe(s, owner, id, topic).state, subscribe(s, owner, id, topic).out))
  ensures (inv(s) ==> stepFramesArriveInOrder(s, "subscribe", subscribe(s, owner, id, topic).state, subscribe(s, owner, id, topic).out))
  ensures (inv(s) ==> stepAbortTouchesOnlyThatCall(s, "subscribe", subscribe(s, owner, id, topic).state))
  ensures (inv(s) ==> stepUnansweredFrameChangesNothing(s, "subscribe", subscribe(s, owner, id, topic).state, subscribe(s, owner, id, topic).out))
{
  if inv(s) {
    if s.launch.NotServing? {
      SettledSeqsSingle(ChannelOut.Refused(id, FailCode.NotReady));
    } else if id == "" || idPending(s, id) {
      SettledSeqsSingle(ChannelOut.Refused(id, FailCode.IdInUse));
    } else if topicOpen(s, topic) {
      SettledSeqsSingle(ChannelOut.Refused(id, FailCode.TopicInUse));
    } else if feeds(s) >= agent__access__transport_feedLimit {
      SettledSeqsSingle(ChannelOut.Refused(id, FailCode.Busy));
    } else {
      AdmitEntryPreserves(s, id, owner, Watch(topic), "subscribe");
    }
  }
}
