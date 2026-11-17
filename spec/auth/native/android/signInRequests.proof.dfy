lemma IdCountsDistinct(xs: seq<BrokerRequest>)
  ensures (forall x :: x in xs ==> |ProofLib.Filter((o: BrokerRequest) => (o.id == x.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (r: BrokerRequest) => r.id)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((o: BrokerRequest) => (o.id == xs[i].id), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].id != xs[i].id
  {
    ProofLib.FilterCountOneIffUnique((o: BrokerRequest) => (o.id == xs[i].id), xs, (r: BrokerRequest) => r.id, i);
  }
  if ProofLib.DistinctBy(xs, (r: BrokerRequest) => r.id) {
    forall x | x in xs
      ensures |ProofLib.Filter((o: BrokerRequest) => (o.id == x.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].id == xs[j].id;
    assert xs[i] in xs;
  }
}

lemma OneOpenFacts(s: SignInRequests)
  ensures alwaysOneOpenRequest(s) == ((forall r :: r in s.requests ==> (r.verdict.RequestPending? == (r.id == s.owner)) && 1 <= r.id <= s.issued) &&
    |s.requests| == s.issued && ProofLib.DistinctBy(s.requests, (r: BrokerRequest) => r.id) &&
    ((s.owner == 0 && s.ownerKey == "") || (1 <= s.owner <= s.issued && s.ownerKey != "")))
{
  IdCountsDistinct(s.requests);
}

lemma RequestAtAll(b: SignInRequests, id: int)
  requires ProofLib.DistinctBy(b.requests, (r: BrokerRequest) => r.id)
  ensures forall i :: 0 <= i < |b.requests| && b.requests[i].id == id ==> requestAt(b, id) == b.requests[i]
  ensures (forall i :: 0 <= i < |b.requests| ==> b.requests[i].id != id) ==> requestAt(b, id) == BrokerRequest(0, "", BrokerOutcome.RequestRejected, CallbackState.CallbackIdle)
{
  var p := (r: BrokerRequest) => (r.id == id);
  var f := ProofLib.Filter(p, b.requests);
  if |f| > 0 {
    assert f[0] in f;
    ProofLib.FilterMember(p, b.requests, f[0]);
  } else {
    ProofLib.FilterNone(p, b.requests);
  }
}

lemma OneOpenPointwise(s: SignInRequests, t: SignInRequests)
  requires alwaysOneOpenRequest(s)
  requires t.owner == s.owner && t.ownerKey == s.ownerKey && t.issued == s.issued && |t.requests| == |s.requests|
  requires forall i :: 0 <= i < |s.requests| ==> t.requests[i].id == s.requests[i].id && t.requests[i].verdict == s.requests[i].verdict
  ensures alwaysOneOpenRequest(t)
{
  OneOpenFacts(s);
  OneOpenFacts(t);
  forall r | r in t.requests
    ensures (r.verdict.RequestPending? == (r.id == t.owner)) && 1 <= r.id <= t.issued
  {
    var i :| 0 <= i < |t.requests| && t.requests[i] == r;
    assert s.requests[i] in s.requests;
  }
}

lemma CallbackKeeps(s: SignInRequests, id: int, cb: CallbackState)
  requires alwaysOneOpenRequest(s)
  ensures alwaysOneOpenRequest(withRequest(id, requestAt(s, id).(callback := cb), s))
  ensures forall i :: 0 <= i < |s.requests| && s.requests[i].id == id ==> withRequest(id, requestAt(s, id).(callback := cb), s).requests[i] == s.requests[i].(callback := cb)
{
  OneOpenFacts(s);
  RequestAtAll(s, id);
  OneOpenPointwise(s, withRequest(id, requestAt(s, id).(callback := cb), s));
}

lemma CloseKeeps(b: SignInRequests, id: int, v: BrokerOutcome)
  requires alwaysOneOpenRequest(b) && b.owner == id && !v.RequestPending?
  ensures alwaysOneOpenRequest(closedRequest(id, v, b))
{
  var t := closedRequest(id, v, b);
  OneOpenFacts(b);
  OneOpenFacts(t);
  RequestAtAll(b, id);
  forall r | r in t.requests
    ensures (r.verdict.RequestPending? == (r.id == t.owner)) && 1 <= r.id <= t.issued
  {
    var i :| 0 <= i < |t.requests| && t.requests[i] == r;
    assert b.requests[i] in b.requests;
  }
}

lemma openRequest_ensures(s: SignInRequests, key: string)
  ensures (inv(s) ==> canOpenRequest(s, key) ==> alwaysOneOpenRequest(openRequest(s, key)))
  ensures (inv(s) ==> canOpenRequest(s, key) ==> alwaysRetiredRequestCannotSettle(openRequest(s, key)))
  ensures (inv(s) ==> canOpenRequest(s, key) ==> alwaysReturnUsesMatchingOwner(openRequest(s, key)))
{
  if inv(s) && canOpenRequest(s, key) {
    var after := openRequest(s, key);
    OneOpenFacts(s);
    OneOpenFacts(after);
    forall i | 0 <= i < |s.requests|
      ensures s.requests[i].id <= s.issued
    {
      assert s.requests[i] in s.requests;
    }
  }
}

lemma beginActivation_ensures(s: SignInRequests, id: int)
  ensures (inv(s) ==> canBeginActivation(s, id) ==> alwaysOneOpenRequest(beginActivation(s, id)))
  ensures (inv(s) ==> canBeginActivation(s, id) ==> alwaysRetiredRequestCannotSettle(beginActivation(s, id)))
  ensures (inv(s) ==> canBeginActivation(s, id) ==> alwaysReturnUsesMatchingOwner(beginActivation(s, id)))
{
  if inv(s) && canBeginActivation(s, id) {
    CallbackKeeps(s, id, CallbackState.CallbackRunning);
  }
}

lemma cancelActivation_ensures(s: SignInRequests, id: int)
  ensures (inv(s) ==> canCancelActivation(s, id) ==> alwaysOneOpenRequest(cancelActivation(s, id)))
  ensures (inv(s) ==> canCancelActivation(s, id) ==> alwaysRetiredRequestCannotSettle(cancelActivation(s, id)))
  ensures (inv(s) ==> canCancelActivation(s, id) ==> alwaysReturnUsesMatchingOwner(cancelActivation(s, id)))
{
  if inv(s) && canCancelActivation(s, id) {
    CallbackKeeps(s, id, CallbackState.CallbackAborted);
  }
}

lemma resolve_ensures(s: SignInRequests, id: int, resolved: bool)
  ensures (inv(s) ==> canResolve(s, id, resolved) ==> alwaysOneOpenRequest(resolve(s, id, resolved)))
  ensures (inv(s) ==> canResolve(s, id, resolved) ==> alwaysRetiredRequestCannotSettle(resolve(s, id, resolved)))
  ensures (inv(s) ==> canResolve(s, id, resolved) ==> alwaysReturnUsesMatchingOwner(resolve(s, id, resolved)))
{
  if inv(s) && canResolve(s, id, resolved) {
    CloseKeeps(s, id, if resolved then BrokerOutcome.RequestResolved else BrokerOutcome.RequestRejected);
  }
}

lemma finishActivation_ensures(s: SignInRequests, id: int, accepted: bool)
  ensures (inv(s) ==> canFinishActivation(s, id) ==> alwaysOneOpenRequest(finishActivation(s, id, accepted)))
  ensures (inv(s) ==> canFinishActivation(s, id) ==> alwaysRetiredRequestCannotSettle(finishActivation(s, id, accepted)))
  ensures (inv(s) ==> canFinishActivation(s, id) ==> alwaysReturnUsesMatchingOwner(finishActivation(s, id, accepted)))
{
  if inv(s) && canFinishActivation(s, id) {
    var retired := (s.owner != id) || requestAt(s, id).callback.CallbackAborted?;
    var finished := withRequest(id, requestAt(s, id).(callback := CallbackState.CallbackIdle), s);
    OneOpenFacts(s);
    RequestAtAll(s, id);
    CallbackKeeps(s, id, CallbackState.CallbackIdle);
    if accepted && !retired {
      CloseKeeps(finished, id, BrokerOutcome.RequestResolved);
    } else {
      var i :| 0 <= i < |s.requests| && s.requests[i].id == id;
      OneOpenFacts(finished);
      RequestAtAll(finished, id);
      assert requestAt(finished, id) == finished.requests[i];
    }
  }
}
