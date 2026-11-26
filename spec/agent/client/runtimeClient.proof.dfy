// Proofs of the rules of the runtime client: request numbers stay unique, and each transition changes stages position by position.

lemma UniqueView(c: RuntimeClient)
  ensures alwaysRequestNumbersAreUnique(c) == !(exists r :: r in c.requests && !(((r.id < c.nextId) && (|ProofLib.Filter((q: Request) => (q.id == r.id), c.requests)| == 1))))
{
}

lemma UniqueIndex(c: RuntimeClient)
  ensures alwaysRequestNumbersAreUnique(c) <==> ((forall i :: 0 <= i < |c.requests| ==> c.requests[i].id < c.nextId) && (forall i, j :: 0 <= i < |c.requests| && 0 <= j < |c.requests| && i != j ==> c.requests[i].id != c.requests[j].id))
{
  UniqueView(c);
  forall i | 0 <= i < |c.requests|
    ensures |ProofLib.Filter((q: Request) => (q.id == c.requests[i].id), c.requests)| == 1 <==> (forall j :: 0 <= j < |c.requests| && j != i ==> c.requests[j].id != c.requests[i].id)
  {
    ProofLib.FilterCountOneIffUnique((q: Request) => (q.id == c.requests[i].id), c.requests, (q: Request) => q.id, i);
  }
  if (forall i :: 0 <= i < |c.requests| ==> c.requests[i].id < c.nextId) && (forall i, j :: 0 <= i < |c.requests| && 0 <= j < |c.requests| && i != j ==> c.requests[i].id != c.requests[j].id) {
    forall r | r in c.requests
      ensures r.id < c.nextId && |ProofLib.Filter((q: Request) => (q.id == r.id), c.requests)| == 1
    {
      var i :| 0 <= i < |c.requests| && c.requests[i] == r;
    }
  }
  if alwaysRequestNumbersAreUnique(c) {
    forall i | 0 <= i < |c.requests|
      ensures c.requests[i].id < c.nextId && (forall j :: 0 <= j < |c.requests| && j != i ==> c.requests[j].id != c.requests[i].id)
    {
      var r := c.requests[i];
      assert r in c.requests;
    }
  }
}

lemma UniqueMembers(c: RuntimeClient)
  requires alwaysRequestNumbersAreUnique(c)
  ensures forall x, y :: x in c.requests && y in c.requests && x.id == y.id ==> x == y
  ensures forall x :: x in c.requests ==> x.id < c.nextId
{
  UniqueIndex(c);
  forall x, y | x in c.requests && y in c.requests && x.id == y.id
    ensures x == y
  {
    var i :| 0 <= i < |c.requests| && c.requests[i] == x;
    var j :| 0 <= j < |c.requests| && c.requests[j] == y;
  }
  forall x | x in c.requests
    ensures x.id < c.nextId
  {
    var i :| 0 <= i < |c.requests| && c.requests[i] == x;
  }
}

lemma IdFacts(c: RuntimeClient, id: int)
  requires alwaysRequestNumbersAreUnique(c)
  ensures own(c, id) ==> forall i :: 0 <= i < |c.requests| && c.requests[i].id == id ==> c.requests[i].gen == c.gen
  ensures forall s :: stageIs(c, id, s) ==> forall i :: 0 <= i < |c.requests| && c.requests[i].id == id ==> c.requests[i].stage == s
  ensures forall s :: stageIs(c, id, s) ==> forall r :: r in c.requests && r.id == id ==> r.stage == s
{
  UniqueMembers(c);
  if own(c, id) {
    var r :| r in c.requests && r.id == id && r.gen == c.gen;
    forall i | 0 <= i < |c.requests| && c.requests[i].id == id
      ensures c.requests[i].gen == c.gen
    {
      assert c.requests[i] in c.requests;
    }
  }
  forall s | stageIs(c, id, s)
    ensures forall i :: 0 <= i < |c.requests| && c.requests[i].id == id ==> c.requests[i].stage == s
    ensures forall r :: r in c.requests && r.id == id ==> r.stage == s
  {
    var r :| r in c.requests && r.id == id && r.stage == s;
    forall i | 0 <= i < |c.requests| && c.requests[i].id == id
      ensures c.requests[i].stage == s
    {
      assert c.requests[i] in c.requests;
    }
  }
}

// A transition that changes only stages, position by position.

lemma Mapped(b: RuntimeClient, a: RuntimeClient)
  requires alwaysRequestNumbersAreUnique(b)
  requires a.nextId == b.nextId && |a.requests| == |b.requests|
  requires forall i :: 0 <= i < |a.requests| ==> a.requests[i].id == b.requests[i].id && a.requests[i].gen == b.requests[i].gen && a.requests[i].delivery == b.requests[i].delivery
  ensures alwaysRequestNumbersAreUnique(a)
  ensures stepWaitingIsNeverDropped(b, a)
  ensures forall i, q :: 0 <= i < |a.requests| && q in b.requests && q.id == a.requests[i].id ==> q == b.requests[i]
  ensures forall i, q :: 0 <= i < |b.requests| && q in a.requests && q.id == b.requests[i].id ==> q == a.requests[i]
{
  UniqueIndex(b);
  UniqueIndex(a);
  forall r | r in b.requests
    ensures exists q :: q in a.requests && q.id == r.id
  {
    var i :| 0 <= i < |b.requests| && b.requests[i] == r;
    assert a.requests[i] in a.requests;
  }
  forall i, q | 0 <= i < |a.requests| && q in b.requests && q.id == a.requests[i].id
    ensures q == b.requests[i]
  {
    var k :| 0 <= k < |b.requests| && b.requests[k] == q;
  }
  forall i, q | 0 <= i < |b.requests| && q in a.requests && q.id == b.requests[i].id
    ensures q == a.requests[i]
  {
    var k :| 0 <= k < |a.requests| && a.requests[k] == q;
  }
}

lemma MappedStreamEnds(b: RuntimeClient, a: RuntimeClient)
  requires alwaysRequestNumbersAreUnique(b)
  requires a.nextId == b.nextId && |a.requests| == |b.requests|
  requires forall i :: 0 <= i < |a.requests| ==> a.requests[i].id == b.requests[i].id && a.requests[i].gen == b.requests[i].gen && a.requests[i].delivery == b.requests[i].delivery
  requires forall i :: 0 <= i < |a.requests| && b.requests[i].stage.Streaming? && !isWaiting(a.requests[i].stage) ==> (a.requests[i].gen == b.gen || a.requests[i].stage == Failed(Failure.AccountChanged))
  ensures stepStreamEndsOnlyInItsGeneration(b, a)
{
  Mapped(b, a);
  forall r | r in a.requests && !isWaiting(r.stage) && (exists q :: q in b.requests && q.id == r.id && isStreaming(q.stage))
    ensures r.gen == b.gen || r.stage == typed1_agent__client__runtimeClient(Failed(Failure.AccountChanged))
  {
    var i :| 0 <= i < |a.requests| && a.requests[i] == r;
    var q :| q in b.requests && q.id == r.id && isStreaming(q.stage);
    assert q == b.requests[i];
  }
}

lemma MappedSent(b: RuntimeClient, a: RuntimeClient, out: seq<BridgeCall>)
  requires alwaysRequestNumbersAreUnique(b)
  requires a.nextId == b.nextId && |a.requests| == |b.requests|
  requires forall i :: 0 <= i < |a.requests| ==> a.requests[i].id == b.requests[i].id && a.requests[i].gen == b.requests[i].gen && a.requests[i].delivery == b.requests[i].delivery
  requires forall i :: 0 <= i < |a.requests| && b.requests[i].stage.Sent? ==> (a.requests[i].stage == b.requests[i].stage || a.requests[i].stage.Streaming? || !isWaiting(a.requests[i].stage))
  requires forall o :: o in out ==> firstSend(b, o)
  ensures stepSentIsNeverResent(b, a, out)
{
  Mapped(b, a);
  forall r, q | r in b.requests && isSent(r.stage) && q in a.requests && q.id == r.id
    ensures (q.stage == r.stage || isStreaming(q.stage)) || !isWaiting(q.stage)
  {
    var i :| 0 <= i < |b.requests| && b.requests[i] == r;
    assert q == a.requests[i];
  }
}

lemma MappedPublish(b: RuntimeClient, a: RuntimeClient)
  requires alwaysRequestNumbersAreUnique(b)
  requires a.nextId == b.nextId && |a.requests| == |b.requests|
  requires forall i :: 0 <= i < |a.requests| ==> a.requests[i].id == b.requests[i].id && a.requests[i].gen == b.requests[i].gen && a.requests[i].delivery == b.requests[i].delivery
  requires forall i :: 0 <= i < |a.requests| && isAnswered(a.requests[i].stage) && !isAnswered(b.requests[i].stage) ==> a.requests[i].gen == b.gen
  ensures stepPublishOnlyInOwnGeneration(b, a)
{
  Mapped(b, a);
  forall r | r in a.requests && isAnswered(r.stage) && !(exists q :: q in b.requests && q.id == r.id && isAnswered(q.stage))
    ensures r.gen == b.gen
  {
    var i :| 0 <= i < |a.requests| && a.requests[i] == r;
    assert b.requests[i] in b.requests;
  }
}

// What a settled startup sends, and what a release keeps.

lemma SettleOut(ok: bool, c: RuntimeClient)
  ensures forall o :: o in settleStartup(ok, c).out ==> ok && exists i :: 0 <= i < |c.requests| && awaitsStartup(c, c.requests[i]) && o == Send(c.requests[i].id, Route.Bridge)
{
  forall acc: seq<BridgeCall>, r: Request
    ensures (if (ok && awaitsStartup(c, r)) then (acc + [Send(r.id, Route.Bridge)]) else acc) == acc + (if (ok && awaitsStartup(c, r)) then [Send(r.id, Route.Bridge)] else [])
  {
    assert acc + [] == acc;
  }
  forall o | o in settleStartup(ok, c).out
    ensures ok && exists i :: 0 <= i < |c.requests| && awaitsStartup(c, c.requests[i]) && o == Send(c.requests[i].id, Route.Bridge)
  {
    ProofLib.FoldLeftConcatMember((acc: seq<BridgeCall>, r: Request) => (if (ok && awaitsStartup(c, r)) then (acc + [Send(r.id, Route.Bridge)]) else acc), (r: Request) => (if (ok && awaitsStartup(c, r)) then [Send(r.id, Route.Bridge)] else []), [], c.requests, o);
  }
}

lemma ReleaseView(c: RuntimeClient, id: int)
  ensures release(c, id).requests == ProofLib.Filter((r: Request) => (r.id != id), c.requests)
{
}

lemma ReleaseMembers(c: RuntimeClient, id: int)
  ensures forall x :: x in release(c, id).requests <==> x in c.requests && x.id != id
{
  ReleaseView(c, id);
  forall x: Request
    ensures x in release(c, id).requests <==> x in c.requests && x.id != id
  {
    ProofLib.FilterMember((r: Request) => (r.id != id), c.requests, x);
  }
}

lemma SettleSteps(ok: bool, c: RuntimeClient)
  requires inv(c)
  ensures alwaysRequestNumbersAreUnique(settleStartup(ok, c).state)
  ensures stepWaitingIsNeverDropped(c, settleStartup(ok, c).state)
  ensures stepStreamEndsOnlyInItsGeneration(c, settleStartup(ok, c).state)
  ensures stepSentIsNeverResent(c, settleStartup(ok, c).state, settleStartup(ok, c).out)
  ensures forall o :: o in settleStartup(ok, c).out ==> o.Send? && o.over.Bridge? && sentIn(settleStartup(ok, c).state, o) && streamSentOnce(c, settleStartup(ok, c).state, o)
{
  var st := settleStartup(ok, c);
  var a := st.state;
  SettleOut(ok, c);
  UniqueMembers(c);
  Mapped(c, a);
  forall o | o in st.out
    ensures o.Send? && o.over.Bridge? && firstSend(c, o) && sentIn(a, o) && streamSentOnce(c, a, o)
  {
    var i :| 0 <= i < |c.requests| && awaitsStartup(c, c.requests[i]) && o == Send(c.requests[i].id, Route.Bridge);
    assert a.requests[i] in a.requests;
    assert c.requests[i] in c.requests;
  }
  MappedStreamEnds(c, a);
  MappedSent(c, a, st.out);
}

lemma StatusOut(c: RuntimeClient, id: int, report: StatusReport, fallback: Fallback)
  requires inv(c) && canRequestStatus(c, id)
  ensures forall o :: o in requestStatus(c, id, report, fallback).out ==> firstSend(c, o) && sentIn(requestStatus(c, id, report, fallback).state, o) && streamSentOnce(c, requestStatus(c, id, report, fallback).state, o)
{
  var st := requestStatus(c, id, report, fallback);
  var a := st.state;
  IdFacts(c, id);
  UniqueMembers(c);
  var r0 :| r0 in c.requests && r0.id == id && r0.gen == c.gen;
  var k :| 0 <= k < |c.requests| && c.requests[k] == r0;
  assert a.requests[k] in a.requests;
}

lemma StatusState(c: RuntimeClient, id: int, report: StatusReport, fallback: Fallback)
  requires inv(c) && canRequestStatus(c, id)
  ensures alwaysRequestNumbersAreUnique(requestStatus(c, id, report, fallback).state)
  ensures alwaysWaitersHaveAStartup(requestStatus(c, id, report, fallback).state)
  ensures stepWaitingIsNeverDropped(c, requestStatus(c, id, report, fallback).state)
  ensures stepStreamEndsOnlyInItsGeneration(c, requestStatus(c, id, report, fallback).state)
  ensures stepSentIsNeverResent(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out)
{
  var a := requestStatus(c, id, report, fallback).state;
  StatusOut(c, id, report, fallback);
  IdFacts(c, id);
  Mapped(c, a);
  if !probeOutcome(report, fallback).MustStart? {
    forall r | r in a.requests && awaitsStartup(a, r)
      ensures c.startup.StartingUp?
    {
      var i :| 0 <= i < |a.requests| && a.requests[i] == r;
      assert c.requests[i] in c.requests;
    }
  }
  MappedStreamEnds(c, a);
  MappedSent(c, a, requestStatus(c, id, report, fallback).out);
}

lemma refreshAccount_ensures(c: RuntimeClient)
  ensures (inv(c) ==> alwaysRequestNumbersAreUnique(refreshAccount(c)))
  ensures (inv(c) ==> alwaysGenerationsAreIssued(refreshAccount(c)))
  ensures (inv(c) ==> alwaysWaitersHaveAStartup(refreshAccount(c)))
  ensures (inv(c) ==> alwaysRefusalAdviceOnlyOn429(refreshAccount(c)))
  ensures (inv(c) ==> stepGenerationsAdvanceOnlyByRefresh(c, "refreshAccount", refreshAccount(c)))
  ensures (inv(c) ==> stepOnlyARefreshRestarts(c, refreshAccount(c), []))
  ensures (inv(c) ==> stepProbeOnlyAfterACurrentRefresh(c, refreshAccount(c)))
  ensures (inv(c) ==> stepSendOnlyInOwnGeneration(c, refreshAccount(c), []))
  ensures (inv(c) ==> stepPublishOnlyInOwnGeneration(c, refreshAccount(c)))
  ensures (inv(c) ==> stepStreamSentOnceInItsGeneration(c, refreshAccount(c), []))
  ensures (inv(c) ==> stepStreamEndsOnlyInItsGeneration(c, refreshAccount(c)))
  ensures (inv(c) ==> stepWaitingIsNeverDropped(c, refreshAccount(c)))
  ensures (inv(c) ==> stepStartOnlyWithoutStartup(c, refreshAccount(c), []))
  ensures (inv(c) ==> stepHttpOnlyWithoutBridge(c, refreshAccount(c), []))
  ensures (inv(c) ==> stepSentIsNeverResent(c, refreshAccount(c), []))
{
  if inv(c) {
    var a := refreshAccount(c);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma refreshError_ensures(c: RuntimeClient, ofGen: int)
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> alwaysRequestNumbersAreUnique(refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> alwaysGenerationsAreIssued(refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> alwaysWaitersHaveAStartup(refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> alwaysRefusalAdviceOnlyOn429(refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepGenerationsAdvanceOnlyByRefresh(c, "refreshError", refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepOnlyARefreshRestarts(c, refreshError(c, ofGen), []))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepProbeOnlyAfterACurrentRefresh(c, refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepSendOnlyInOwnGeneration(c, refreshError(c, ofGen), []))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepPublishOnlyInOwnGeneration(c, refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepStreamSentOnceInItsGeneration(c, refreshError(c, ofGen), []))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepStreamEndsOnlyInItsGeneration(c, refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepWaitingIsNeverDropped(c, refreshError(c, ofGen)))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepStartOnlyWithoutStartup(c, refreshError(c, ofGen), []))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepHttpOnlyWithoutBridge(c, refreshError(c, ofGen), []))
  ensures (inv(c) ==> canRefreshError(c, ofGen) ==> stepSentIsNeverResent(c, refreshError(c, ofGen), []))
{
  if inv(c) && canRefreshError(c, ofGen) {
    var a := refreshError(c, ofGen);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma refreshStatus_ensures(c: RuntimeClient, ofGen: int, report: StatusReport)
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> alwaysRequestNumbersAreUnique(refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> alwaysGenerationsAreIssued(refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> alwaysWaitersHaveAStartup(refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> alwaysRefusalAdviceOnlyOn429(refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepGenerationsAdvanceOnlyByRefresh(c, "refreshStatus", refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepOnlyARefreshRestarts(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepProbeOnlyAfterACurrentRefresh(c, refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepSendOnlyInOwnGeneration(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepPublishOnlyInOwnGeneration(c, refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepStreamSentOnceInItsGeneration(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepStreamEndsOnlyInItsGeneration(c, refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepWaitingIsNeverDropped(c, refreshStatus(c, ofGen, report).state))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepStartOnlyWithoutStartup(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepHttpOnlyWithoutBridge(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
  ensures (inv(c) ==> canRefreshStatus(c, ofGen) ==> stepSentIsNeverResent(c, refreshStatus(c, ofGen, report).state, refreshStatus(c, ofGen, report).out))
{
  if inv(c) && canRefreshStatus(c, ofGen) {
    var st := refreshStatus(c, ofGen, report);
    MappedStreamEnds(c, st.state);
    MappedSent(c, st.state, st.out);
  }
}

lemma restarted_ensures(c: RuntimeClient, ofGen: int, phase: RuntimePhase)
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> alwaysRequestNumbersAreUnique(restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> alwaysGenerationsAreIssued(restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> alwaysWaitersHaveAStartup(restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> alwaysRefusalAdviceOnlyOn429(restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepGenerationsAdvanceOnlyByRefresh(c, "restarted", restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepOnlyARefreshRestarts(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepProbeOnlyAfterACurrentRefresh(c, restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepSendOnlyInOwnGeneration(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepPublishOnlyInOwnGeneration(c, restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepStreamSentOnceInItsGeneration(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepStreamEndsOnlyInItsGeneration(c, restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepWaitingIsNeverDropped(c, restarted(c, ofGen, phase).state))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepStartOnlyWithoutStartup(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepHttpOnlyWithoutBridge(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
  ensures (inv(c) ==> canRestarted(c, ofGen) ==> stepSentIsNeverResent(c, restarted(c, ofGen, phase).state, restarted(c, ofGen, phase).out))
{
  if inv(c) && canRestarted(c, ofGen) {
    var st := restarted(c, ofGen, phase);
    MappedStreamEnds(c, st.state);
    MappedSent(c, st.state, st.out);
  }
}

lemma submit_ensures(c: RuntimeClient, path: PathShape, delivery: Delivery)
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> alwaysRequestNumbersAreUnique(submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> alwaysGenerationsAreIssued(submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> alwaysWaitersHaveAStartup(submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> alwaysRefusalAdviceOnlyOn429(submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepGenerationsAdvanceOnlyByRefresh(c, "submit", submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepOnlyARefreshRestarts(c, submit(c, path, delivery), []))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepProbeOnlyAfterACurrentRefresh(c, submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepSendOnlyInOwnGeneration(c, submit(c, path, delivery), []))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepPublishOnlyInOwnGeneration(c, submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepStreamSentOnceInItsGeneration(c, submit(c, path, delivery), []))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepStreamEndsOnlyInItsGeneration(c, submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepWaitingIsNeverDropped(c, submit(c, path, delivery)))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepStartOnlyWithoutStartup(c, submit(c, path, delivery), []))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepHttpOnlyWithoutBridge(c, submit(c, path, delivery), []))
  ensures (inv(c) ==> canSubmit(c, path, delivery) ==> stepSentIsNeverResent(c, submit(c, path, delivery), []))
{
  if inv(c) && canSubmit(c, path, delivery) {
    var a := submit(c, path, delivery);
    UniqueIndex(c);
    UniqueMembers(c);
    assert forall i :: 0 <= i < |c.requests| ==> a.requests[i] == c.requests[i];
    UniqueIndex(a);
    forall r | r in a.requests
      ensures r in c.requests || r == a.requests[|c.requests|]
    {
    }
  }
}

lemma resume_ensures(c: RuntimeClient)
  ensures (inv(c) ==> canResume(c) ==> alwaysRequestNumbersAreUnique(resume(c)))
  ensures (inv(c) ==> canResume(c) ==> alwaysGenerationsAreIssued(resume(c)))
  ensures (inv(c) ==> canResume(c) ==> alwaysWaitersHaveAStartup(resume(c)))
  ensures (inv(c) ==> canResume(c) ==> alwaysRefusalAdviceOnlyOn429(resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepGenerationsAdvanceOnlyByRefresh(c, "resume", resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepOnlyARefreshRestarts(c, resume(c), []))
  ensures (inv(c) ==> canResume(c) ==> stepProbeOnlyAfterACurrentRefresh(c, resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepSendOnlyInOwnGeneration(c, resume(c), []))
  ensures (inv(c) ==> canResume(c) ==> stepPublishOnlyInOwnGeneration(c, resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepStreamSentOnceInItsGeneration(c, resume(c), []))
  ensures (inv(c) ==> canResume(c) ==> stepStreamEndsOnlyInItsGeneration(c, resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepWaitingIsNeverDropped(c, resume(c)))
  ensures (inv(c) ==> canResume(c) ==> stepStartOnlyWithoutStartup(c, resume(c), []))
  ensures (inv(c) ==> canResume(c) ==> stepHttpOnlyWithoutBridge(c, resume(c), []))
  ensures (inv(c) ==> canResume(c) ==> stepSentIsNeverResent(c, resume(c), []))
{
  if inv(c) && canResume(c) {
    var a := resume(c);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma abandon_ensures(c: RuntimeClient)
  ensures (inv(c) ==> canAbandon(c) ==> alwaysRequestNumbersAreUnique(abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> alwaysGenerationsAreIssued(abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> alwaysWaitersHaveAStartup(abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> alwaysRefusalAdviceOnlyOn429(abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepGenerationsAdvanceOnlyByRefresh(c, "abandon", abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepOnlyARefreshRestarts(c, abandon(c), []))
  ensures (inv(c) ==> canAbandon(c) ==> stepProbeOnlyAfterACurrentRefresh(c, abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepSendOnlyInOwnGeneration(c, abandon(c), []))
  ensures (inv(c) ==> canAbandon(c) ==> stepPublishOnlyInOwnGeneration(c, abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepStreamSentOnceInItsGeneration(c, abandon(c), []))
  ensures (inv(c) ==> canAbandon(c) ==> stepStreamEndsOnlyInItsGeneration(c, abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepWaitingIsNeverDropped(c, abandon(c)))
  ensures (inv(c) ==> canAbandon(c) ==> stepStartOnlyWithoutStartup(c, abandon(c), []))
  ensures (inv(c) ==> canAbandon(c) ==> stepHttpOnlyWithoutBridge(c, abandon(c), []))
  ensures (inv(c) ==> canAbandon(c) ==> stepSentIsNeverResent(c, abandon(c), []))
{
  if inv(c) && canAbandon(c) {
    var a := abandon(c);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma streamEnded_ensures(c: RuntimeClient, id: int)
  ensures (inv(c) ==> canStreamEnded(c, id) ==> alwaysRequestNumbersAreUnique(streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> alwaysGenerationsAreIssued(streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> alwaysWaitersHaveAStartup(streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> alwaysRefusalAdviceOnlyOn429(streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "streamEnded", streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepOnlyARefreshRestarts(c, streamEnded(c, id), []))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepSendOnlyInOwnGeneration(c, streamEnded(c, id), []))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepPublishOnlyInOwnGeneration(c, streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepStreamSentOnceInItsGeneration(c, streamEnded(c, id), []))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepWaitingIsNeverDropped(c, streamEnded(c, id)))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepStartOnlyWithoutStartup(c, streamEnded(c, id), []))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepHttpOnlyWithoutBridge(c, streamEnded(c, id), []))
  ensures (inv(c) ==> canStreamEnded(c, id) ==> stepSentIsNeverResent(c, streamEnded(c, id), []))
{
  if inv(c) && canStreamEnded(c, id) {
    var a := streamEnded(c, id);
    IdFacts(c, id);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma cancel_ensures(c: RuntimeClient, id: int)
  ensures (inv(c) ==> canCancel(c, id) ==> alwaysRequestNumbersAreUnique(cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> alwaysGenerationsAreIssued(cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> alwaysWaitersHaveAStartup(cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> alwaysRefusalAdviceOnlyOn429(cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "cancel", cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepOnlyARefreshRestarts(c, cancel(c, id), []))
  ensures (inv(c) ==> canCancel(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepSendOnlyInOwnGeneration(c, cancel(c, id), []))
  ensures (inv(c) ==> canCancel(c, id) ==> stepPublishOnlyInOwnGeneration(c, cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepStreamSentOnceInItsGeneration(c, cancel(c, id), []))
  ensures (inv(c) ==> canCancel(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepWaitingIsNeverDropped(c, cancel(c, id)))
  ensures (inv(c) ==> canCancel(c, id) ==> stepStartOnlyWithoutStartup(c, cancel(c, id), []))
  ensures (inv(c) ==> canCancel(c, id) ==> stepHttpOnlyWithoutBridge(c, cancel(c, id), []))
  ensures (inv(c) ==> canCancel(c, id) ==> stepSentIsNeverResent(c, cancel(c, id), []))
{
  if inv(c) && canCancel(c, id) {
    var a := cancel(c, id);
    IdFacts(c, id);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma transportFailed_ensures(c: RuntimeClient, id: int)
  ensures (inv(c) ==> canTransportFailed(c, id) ==> alwaysRequestNumbersAreUnique(transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> alwaysGenerationsAreIssued(transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> alwaysWaitersHaveAStartup(transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> alwaysRefusalAdviceOnlyOn429(transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "transportFailed", transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepOnlyARefreshRestarts(c, transportFailed(c, id), []))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepSendOnlyInOwnGeneration(c, transportFailed(c, id), []))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepPublishOnlyInOwnGeneration(c, transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepStreamSentOnceInItsGeneration(c, transportFailed(c, id), []))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepWaitingIsNeverDropped(c, transportFailed(c, id)))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepStartOnlyWithoutStartup(c, transportFailed(c, id), []))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepHttpOnlyWithoutBridge(c, transportFailed(c, id), []))
  ensures (inv(c) ==> canTransportFailed(c, id) ==> stepSentIsNeverResent(c, transportFailed(c, id), []))
{
  if inv(c) && canTransportFailed(c, id) {
    var a := transportFailed(c, id);
    IdFacts(c, id);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
  }
}

lemma reply_ensures(c: RuntimeClient, id: int, httpStatus: int, retry: RetryAdvice)
  ensures (inv(c) ==> canReply(c, id) ==> alwaysRequestNumbersAreUnique(reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> alwaysGenerationsAreIssued(reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> alwaysWaitersHaveAStartup(reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> alwaysRefusalAdviceOnlyOn429(reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "reply", reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepOnlyARefreshRestarts(c, reply(c, id, httpStatus, retry), []))
  ensures (inv(c) ==> canReply(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepSendOnlyInOwnGeneration(c, reply(c, id, httpStatus, retry), []))
  ensures (inv(c) ==> canReply(c, id) ==> stepPublishOnlyInOwnGeneration(c, reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepStreamSentOnceInItsGeneration(c, reply(c, id, httpStatus, retry), []))
  ensures (inv(c) ==> canReply(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepWaitingIsNeverDropped(c, reply(c, id, httpStatus, retry)))
  ensures (inv(c) ==> canReply(c, id) ==> stepStartOnlyWithoutStartup(c, reply(c, id, httpStatus, retry), []))
  ensures (inv(c) ==> canReply(c, id) ==> stepHttpOnlyWithoutBridge(c, reply(c, id, httpStatus, retry), []))
  ensures (inv(c) ==> canReply(c, id) ==> stepSentIsNeverResent(c, reply(c, id, httpStatus, retry), []))
{
  if inv(c) && canReply(c, id) {
    var a := reply(c, id, httpStatus, retry);
    IdFacts(c, id);
    Mapped(c, a);
    MappedStreamEnds(c, a);
    MappedSent(c, a, []);
    MappedPublish(c, a);
  }
}

lemma release_ensures(c: RuntimeClient, id: int)
  ensures (inv(c) ==> canRelease(c, id) ==> alwaysRequestNumbersAreUnique(release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> alwaysGenerationsAreIssued(release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> alwaysWaitersHaveAStartup(release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> alwaysRefusalAdviceOnlyOn429(release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "release", release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepOnlyARefreshRestarts(c, release(c, id), []))
  ensures (inv(c) ==> canRelease(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepSendOnlyInOwnGeneration(c, release(c, id), []))
  ensures (inv(c) ==> canRelease(c, id) ==> stepPublishOnlyInOwnGeneration(c, release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepStreamSentOnceInItsGeneration(c, release(c, id), []))
  ensures (inv(c) ==> canRelease(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepWaitingIsNeverDropped(c, release(c, id)))
  ensures (inv(c) ==> canRelease(c, id) ==> stepStartOnlyWithoutStartup(c, release(c, id), []))
  ensures (inv(c) ==> canRelease(c, id) ==> stepHttpOnlyWithoutBridge(c, release(c, id), []))
  ensures (inv(c) ==> canRelease(c, id) ==> stepSentIsNeverResent(c, release(c, id), []))
{
  if inv(c) && canRelease(c, id) {
    var a := release(c, id);
    ReleaseMembers(c, id);
    ReleaseView(c, id);
    UniqueIndex(c);
    UniqueMembers(c);
    assert ProofLib.DistinctBy(c.requests, (q: Request) => q.id);
    ProofLib.FilterKeepsDistinctBy((r: Request) => (r.id != id), c.requests, (q: Request) => q.id);
    forall i | 0 <= i < |a.requests|
      ensures a.requests[i].id < a.nextId
    {
      assert a.requests[i] in a.requests;
    }
    UniqueIndex(a);
    var r0 :| r0 in c.requests && r0.id == id && !isWaiting(r0.stage);
    forall r | r in c.requests && isWaiting(r.stage)
      ensures r in a.requests
    {
      assert r.id != id;
    }
  }
}

lemma requestStatus_ensures(c: RuntimeClient, id: int, report: StatusReport, fallback: Fallback)
  ensures (inv(c) ==> canRequestStatus(c, id) ==> alwaysRequestNumbersAreUnique(requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> alwaysGenerationsAreIssued(requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> alwaysWaitersHaveAStartup(requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> alwaysRefusalAdviceOnlyOn429(requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepGenerationsAdvanceOnlyByRefresh(c, "requestStatus", requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepOnlyARefreshRestarts(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepProbeOnlyAfterACurrentRefresh(c, requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepSendOnlyInOwnGeneration(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepPublishOnlyInOwnGeneration(c, requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepStreamSentOnceInItsGeneration(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepStreamEndsOnlyInItsGeneration(c, requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepWaitingIsNeverDropped(c, requestStatus(c, id, report, fallback).state))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepStartOnlyWithoutStartup(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepHttpOnlyWithoutBridge(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
  ensures (inv(c) ==> canRequestStatus(c, id) ==> stepSentIsNeverResent(c, requestStatus(c, id, report, fallback).state, requestStatus(c, id, report, fallback).out))
{
  if inv(c) && canRequestStatus(c, id) {
    StatusOut(c, id, report, fallback);
    StatusState(c, id, report, fallback);
  }
}

lemma startupRan_ensures(c: RuntimeClient, ofGen: int)
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> alwaysRequestNumbersAreUnique(startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> alwaysGenerationsAreIssued(startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> alwaysWaitersHaveAStartup(startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> alwaysRefusalAdviceOnlyOn429(startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepGenerationsAdvanceOnlyByRefresh(c, "startupRan", startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepOnlyARefreshRestarts(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepProbeOnlyAfterACurrentRefresh(c, startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepSendOnlyInOwnGeneration(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepPublishOnlyInOwnGeneration(c, startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepStreamSentOnceInItsGeneration(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepStreamEndsOnlyInItsGeneration(c, startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepWaitingIsNeverDropped(c, startupRan(c, ofGen).state))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepStartOnlyWithoutStartup(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepHttpOnlyWithoutBridge(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
  ensures (inv(c) ==> canStartupRan(c, ofGen) ==> stepSentIsNeverResent(c, startupRan(c, ofGen).state, startupRan(c, ofGen).out))
{
  if inv(c) && canStartupRan(c, ofGen) {
    SettleSteps(true, c);
  }
}

lemma startupFailed_ensures(c: RuntimeClient, ofGen: int)
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> alwaysRequestNumbersAreUnique(startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> alwaysGenerationsAreIssued(startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> alwaysWaitersHaveAStartup(startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> alwaysRefusalAdviceOnlyOn429(startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepGenerationsAdvanceOnlyByRefresh(c, "startupFailed", startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepOnlyARefreshRestarts(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepProbeOnlyAfterACurrentRefresh(c, startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepSendOnlyInOwnGeneration(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepPublishOnlyInOwnGeneration(c, startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepStreamSentOnceInItsGeneration(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepStreamEndsOnlyInItsGeneration(c, startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepWaitingIsNeverDropped(c, startupFailed(c, ofGen).state))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepStartOnlyWithoutStartup(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepHttpOnlyWithoutBridge(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
  ensures (inv(c) ==> canStartupFailed(c, ofGen) ==> stepSentIsNeverResent(c, startupFailed(c, ofGen).state, startupFailed(c, ofGen).out))
{
  if inv(c) && canStartupFailed(c, ofGen) {
    SettleSteps(false, c);
  }
}
