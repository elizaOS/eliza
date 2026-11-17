lemma Ids(rs: seq<HostRequest>)
  ensures (forall r :: r in rs ==> |ProofLib.Filter((q: HostRequest) => (q.id == r.id), rs)| == 1) == ProofLib.DistinctBy(rs, (x: HostRequest) => x.id)
{
  if forall r :: r in rs ==> |ProofLib.Filter((q: HostRequest) => (q.id == r.id), rs)| == 1 {
    forall i, j | 0 <= i < |rs| && 0 <= j < |rs| && i != j ensures rs[i].id != rs[j].id {
      if rs[i].id == rs[j].id {
        assert rs[i] in rs;
        ProofLib.FilterTwo((q: HostRequest) => (q.id == rs[i].id), rs, i, j);
      }
    }
  }
  if ProofLib.DistinctBy(rs, (x: HostRequest) => x.id) {
    forall r | r in rs ensures |ProofLib.Filter((q: HostRequest) => (q.id == r.id), rs)| == 1 {
      var i :| 0 <= i < |rs| && rs[i] == r;
      ProofLib.FilterOne((q: HostRequest) => (q.id == r.id), rs, i);
    }
  }
}

lemma IdsBody(s: ResidentHost)
  ensures alwaysRequestIdsUnique(s) == ProofLib.DistinctBy(s.requests, (x: HostRequest) => x.id)
{
  assert alwaysRequestIdsUnique(s) == (forall r :: r in s.requests ==> |ProofLib.Filter((q: HostRequest) => (q.id == r.id), s.requests)| == 1);
  Ids(s.requests);
}

lemma Mapped(s: ResidentHost, after: ResidentHost)
  requires inv(s) && |after.requests| == |s.requests|
  requires forall i :: 0 <= i < |s.requests| ==> after.requests[i].id == s.requests[i].id && (s.requests[i].settled ==> after.requests[i] == s.requests[i])
  requires forall i :: 0 <= i < |s.requests| && after.requests[i] != s.requests[i] ==> !after.requests[i].resolved || (after.requests[i].browser && after.requests[i].launched && after.requests[i].paused && !after.requests[i].cancelled && after.requests[i].settled)
  ensures alwaysRequestIdsUnique(after) && alwaysResolvedHandoffWasLaunchedAndPaused(after)
  ensures forall r :: r in s.requests && r.settled ==> r in after.requests
  ensures forall r :: r in s.requests ==> exists i :: 0 <= i < |s.requests| && s.requests[i] == r && after.requests[i].id == r.id
{
  IdsBody(s);
  IdsBody(after);
  forall r | r in s.requests ensures exists i :: 0 <= i < |s.requests| && s.requests[i] == r && after.requests[i].id == r.id && (r.settled ==> r in after.requests) {
    var i :| 0 <= i < |s.requests| && s.requests[i] == r;
    if r.settled { assert after.requests[i] == r; }
  }
  forall q | q in after.requests ensures !q.resolved || (q.browser && q.launched && q.paused && !q.cancelled && q.settled) {
    var i :| 0 <= i < |after.requests| && after.requests[i] == q;
    assert s.requests[i] in s.requests;
  }
}

lemma registerRequest_ensures(s: ResidentHost, id: int, browser: bool)
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> alwaysRuntimeNeverRunsUnderPendingStop(registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> alwaysRequestIdsUnique(registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> alwaysResolvedHandoffWasLaunchedAndPaused(registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> stepNoStartWhileStopPending(s, registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> stepProviderChangesOnlyStopped(s, "registerRequest", registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> stepSettledStaysSettled(s, "registerRequest", registerRequest(s, id, browser)))
  ensures (inv(s) ==> canRegisterRequest(s, id, browser) ==> stepPauseKeepsPendingRequests(s, "registerRequest", registerRequest(s, id, browser)))
{
  if inv(s) && canRegisterRequest(s, id, browser) {
    var after := registerRequest(s, id, browser);
    var f := ProofLib.Filter((r: HostRequest) => (r.id != id), s.requests);
    var n := HostRequest(id, browser, false, false, false, false, false);
    assert after.requests == f + [n];
    IdsBody(s);
    IdsBody(after);
    ProofLib.FilterKeepsDistinctBy((r: HostRequest) => (r.id != id), s.requests, (x: HostRequest) => x.id);
    forall q | q in f ensures q in s.requests && q.id != id {
      ProofLib.FilterMember((r: HostRequest) => (r.id != id), s.requests, q);
    }
    assert forall i :: 0 <= i < |f| ==> f[i] in f;
  }
}

lemma launchBrowser_ensures(s: ResidentHost, id: int)
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> alwaysRuntimeNeverRunsUnderPendingStop(launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> alwaysRequestIdsUnique(launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> alwaysResolvedHandoffWasLaunchedAndPaused(launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> stepNoStartWhileStopPending(s, launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> stepProviderChangesOnlyStopped(s, "launchBrowser", launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> stepSettledStaysSettled(s, "launchBrowser", launchBrowser(s, id)))
  ensures (inv(s) ==> canLaunchBrowser(s, id) ==> stepPauseKeepsPendingRequests(s, "launchBrowser", launchBrowser(s, id)))
{
  if inv(s) && canLaunchBrowser(s, id) {
    var after := launchBrowser(s, id);
    IdsBody(s);
    var r :| r in s.requests && r.id == id && r.browser && !r.launched && !r.settled;
    var k :| 0 <= k < |s.requests| && s.requests[k] == r;
    assert forall i :: 0 <= i < |s.requests| && s.requests[i].settled ==> i != k && s.requests[i].id != id;
    Mapped(s, after);
  }
}

lemma pauseApp_ensures(s: ResidentHost)
  ensures (inv(s) ==> alwaysRuntimeNeverRunsUnderPendingStop(pauseApp(s)))
  ensures (inv(s) ==> alwaysRequestIdsUnique(pauseApp(s)))
  ensures (inv(s) ==> alwaysResolvedHandoffWasLaunchedAndPaused(pauseApp(s)))
  ensures (inv(s) ==> stepNoStartWhileStopPending(s, pauseApp(s)))
  ensures (inv(s) ==> stepProviderChangesOnlyStopped(s, "pauseApp", pauseApp(s)))
  ensures (inv(s) ==> stepSettledStaysSettled(s, "pauseApp", pauseApp(s)))
  ensures (inv(s) ==> stepPauseKeepsPendingRequests(s, "pauseApp", pauseApp(s)))
{
  if inv(s) {
    var after := pauseApp(s);
    Mapped(s, after);
    assert forall i :: 0 <= i < |s.requests| ==> after.requests[i].settled == s.requests[i].settled;
  }
}

lemma returnToApp_ensures(s: ResidentHost)
  ensures (inv(s) ==> alwaysRuntimeNeverRunsUnderPendingStop(returnToApp(s)))
  ensures (inv(s) ==> alwaysRequestIdsUnique(returnToApp(s)))
  ensures (inv(s) ==> alwaysResolvedHandoffWasLaunchedAndPaused(returnToApp(s)))
  ensures (inv(s) ==> stepNoStartWhileStopPending(s, returnToApp(s)))
  ensures (inv(s) ==> stepProviderChangesOnlyStopped(s, "returnToApp", returnToApp(s)))
  ensures (inv(s) ==> stepSettledStaysSettled(s, "returnToApp", returnToApp(s)))
  ensures (inv(s) ==> stepPauseKeepsPendingRequests(s, "returnToApp", returnToApp(s)))
{
  if inv(s) {
    Mapped(s, returnToApp(s));
  }
}

lemma cancelRequest_ensures(s: ResidentHost, id: int)
  ensures (inv(s) ==> canCancelRequest(s, id) ==> alwaysRuntimeNeverRunsUnderPendingStop(cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> alwaysRequestIdsUnique(cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> alwaysResolvedHandoffWasLaunchedAndPaused(cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> stepNoStartWhileStopPending(s, cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> stepProviderChangesOnlyStopped(s, "cancelRequest", cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> stepSettledStaysSettled(s, "cancelRequest", cancelRequest(s, id)))
  ensures (inv(s) ==> canCancelRequest(s, id) ==> stepPauseKeepsPendingRequests(s, "cancelRequest", cancelRequest(s, id)))
{
  if inv(s) && canCancelRequest(s, id) {
    var after := cancelRequest(s, id);
    forall i | 0 <= i < |s.requests| && !s.requests[i].settled ensures !s.requests[i].resolved {
      assert s.requests[i] in s.requests;
    }
    Mapped(s, after);
  }
}
