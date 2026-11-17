lemma Uniq(s: PageRequests)
  ensures alwaysRequestIdsUnique(s) <==> ProofLib.DistinctBy(s.requests, (r: PageRequest) => (r.surface, r.requestId))
{
  var key := (r: PageRequest) => (r.surface, r.requestId);
  forall i | 0 <= i < |s.requests|
    ensures |ProofLib.Filter((q: PageRequest) => ((q.surface == s.requests[i].surface) && (q.requestId == s.requests[i].requestId)), s.requests)| == 1 <==> forall j :: 0 <= j < |s.requests| && j != i ==> key(s.requests[j]) != key(s.requests[i])
  {
    ProofLib.FilterCountOneIffUnique((q: PageRequest) => ((q.surface == s.requests[i].surface) && (q.requestId == s.requests[i].requestId)), s.requests, key, i);
  }
}

lemma FirstFilter<T>(p: T -> bool, xs: seq<T>, i: int)
  requires 0 <= i < |xs| && p(xs[i])
  requires forall j :: 0 <= j < i ==> !p(xs[j])
  ensures |ProofLib.Filter(p, xs)| > 0 && ProofLib.Filter(p, xs)[0] == xs[i]
  decreases i
{
  ProofLib.FilterCons(p, xs);
  if i > 0 {
    FirstFilter(p, xs[1..], i - 1);
  }
}

lemma FilterSame<T>(p: T -> bool, xs: seq<T>, ys: seq<T>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> p(xs[i]) == p(ys[i]) && (p(xs[i]) ==> xs[i] == ys[i])
  ensures ProofLib.Filter(p, xs) == ProofLib.Filter(p, ys)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(p, ys);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(p, ys);
    FilterSame(p, xs[1..], ys[1..]);
  }
}

lemma PagesOther(s: PageRequests, t: PageRequests, surface: int)
  requires |t.pages| == |s.pages|
  requires forall i :: 0 <= i < |s.pages| ==> t.pages[i].surface == s.pages[i].surface && (s.pages[i].surface != surface ==> t.pages[i] == s.pages[i])
  ensures forall x :: x != surface ==> pageOf(t, x) == pageOf(s, x)
{
  forall x | x != surface ensures pageOf(t, x) == pageOf(s, x) {
    FilterSame((p: SurfacePage) => (p.surface == x), s.pages, t.pages);
  }
}

lemma Rewrite(s: PageRequests, t: PageRequests)
  requires alwaysRequestIdsUnique(s) && |t.requests| == |s.requests|
  requires forall i :: 0 <= i < |s.requests| ==> t.requests[i] == s.requests[i] || (t.requests[i] == s.requests[i].(verdict := t.requests[i].verdict) && !settledOutcome(s.requests[i].verdict) && (s.requests[i].verdict.Pending? || !t.requests[i].verdict.Pending?))
  ensures alwaysRequestIdsUnique(t) && stepSettledRequestNeverChanges(s, t) && stepOutcomeNeverReturnsToPending(s, t) && stepWithdrawnPermissionIsNeverGranted(s, t)
{
  var key := (r: PageRequest) => (r.surface, r.requestId);
  Uniq(s);
  assert forall i :: 0 <= i < |s.requests| ==> key(t.requests[i]) == key(s.requests[i]);
  Uniq(t);
  forall r | r in s.requests && settledOutcome(r.verdict) ensures r in t.requests {
    var i :| 0 <= i < |s.requests| && s.requests[i] == r;
    assert t.requests[i] == r;
  }
  forall r, q | r in s.requests && !r.verdict.Pending? && q in t.requests && q.surface == r.surface && q.requestId == r.requestId
    ensures !q.verdict.Pending?
  {
    var i :| 0 <= i < |s.requests| && s.requests[i] == r;
    var j :| 0 <= j < |t.requests| && t.requests[j] == q;
    assert key(s.requests[j]) == key(s.requests[i]);
  }
}

lemma ResolveSteps(s: PageRequests, t: PageRequests, surface: int, requestId: int, i0: int, v: RequestOutcome)
  requires inv(s) && 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId
  requires !settledOutcome(s.requests[i0].verdict) && (s.requests[i0].verdict.Pending? || !v.Pending?)
  requires t.requests == resolve(surface, s, requestId, v).requests && t.pages == s.pages
  ensures requestOf(s, surface, requestId) == s.requests[i0]
  ensures alwaysRequestIdsUnique(t) && stepSettledRequestNeverChanges(s, t) && stepOutcomeNeverReturnsToPending(s, t) && stepWithdrawnPermissionIsNeverGranted(s, t)
  ensures alwaysHeldRequestIsOnItsPage(t)
  ensures (v.Granted? ==> s.requests[i0].kind.SitePermissionAsk?) ==> alwaysGrantedOnlyForSitePermission(t)
  ensures ((v.Saving? || v.Saved? || v.SaveFailed? || v.SaveCancelled? || v.SaveUnconfirmed?) ==> s.requests[i0].kind.DownloadAsk?) ==> alwaysSavingOnlyForDownloads(t)
  ensures (v.Dispatched? ==> (s.requests[i0].kind.ExternalLinkAsk? || s.requests[i0].kind.IdentityProviderAsk?) && s.requests[i0].resolvable) ==> alwaysDispatchOnlyForHandoffs(t)
  ensures (v.Saved? ==> s.requests[i0].verdict.Saving? || s.requests[i0].verdict.Saved?) ==> stepSavedFollowsSaving(s, t)
{
  var key := (r: PageRequest) => (r.surface, r.requestId);
  Uniq(s);
  FirstFilter((r: PageRequest) => ((r.surface == surface) && (r.requestId == requestId)), s.requests, i0);
  assert forall i :: 0 <= i < |s.requests| && i != i0 ==> key(s.requests[i]) != key(s.requests[i0]) && t.requests[i] == s.requests[i];
  assert t.requests[i0] == s.requests[i0].(verdict := v);
  Rewrite(s, t);
  forall r | r in t.requests ensures (r in s.requests && r != t.requests[i0]) || r == t.requests[i0] {
    var i :| 0 <= i < |t.requests| && t.requests[i] == r;
    if i != i0 {
      assert r == s.requests[i];
    }
  }
  assert forall x :: pageOf(t, x) == pageOf(s, x);
  forall r | r in t.requests && r.verdict.Saved? && (v.Saved? ==> s.requests[i0].verdict.Saving? || s.requests[i0].verdict.Saved?)
    ensures exists q :: q in s.requests && q.surface == r.surface && q.requestId == r.requestId && (q.verdict.Saving? || q.verdict.Saved?)
  {
    if r == t.requests[i0] {
      assert s.requests[i0] in s.requests;
    } else {
      assert r in s.requests;
    }
  }
}

lemma Held(s: PageRequests, surface: int, requestId: int)
  requires requestOf(s, surface, requestId).verdict.Saving?
  ensures exists i :: 0 <= i < |s.requests| && s.requests[i].surface == surface && s.requests[i].requestId == requestId && s.requests[i].verdict.Saving?
{
  var p := (r: PageRequest) => ((r.surface == surface) && (r.requestId == requestId));
  ProofLib.FilterSubset(p, s.requests);
  ProofLib.FilterMember(p, s.requests, ProofLib.Filter(p, s.requests)[0]);
}

lemma answerDialog_ensures(s: PageRequests, surface: int, requestId: int, accept: bool)
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysRequestIdsUnique(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysOneHeldRequestPerSlot(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysHeldRequestIsOnItsPage(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysHistoryIsCounted(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysGrantedOnlyForSitePermission(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysSavingOnlyForDownloads(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysDispatchOnlyForHandoffs(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepSettledRequestNeverChanges(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepOutcomeNeverReturnsToPending(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepLookingAwayNeverAccepts(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepGrantOnlyByItsOwnAnswer(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepHistoryMovesOnlyAtPageStart(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepStopEndsNothingAndReports(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepPageStartReportsWithdrawalsFirst(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepWithdrawnPermissionIsNeverGranted(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepSavedFollowsSaving(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepSpentPopupGestureNeverReturns(s, answerDialog(s, surface, requestId, accept)))
{
  if inv(s) && canAnswerDialog(s, surface, requestId, accept) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending?;
    ResolveSteps(s, answerDialog(s, surface, requestId, accept), surface, requestId, i0, (if accept then RequestOutcome.Accepted else RequestOutcome.Declined));
  }
}

lemma declineRequest_ensures(s: PageRequests, surface: int, requestId: int)
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysRequestIdsUnique(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysOneHeldRequestPerSlot(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysHeldRequestIsOnItsPage(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysHistoryIsCounted(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "declineRequest", declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepGrantOnlyByItsOwnAnswer(s, "declineRequest", declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepHistoryMovesOnlyAtPageStart(s, "declineRequest", declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepStopEndsNothingAndReports(s, "declineRequest", declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepPageStartReportsWithdrawalsFirst(s, "declineRequest", declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepWithdrawnPermissionIsNeverGranted(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepSavedFollowsSaving(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepSpentPopupGestureNeverReturns(s, declineRequest(s, surface, requestId)))
{
  if inv(s) && canDeclineRequest(s, surface, requestId) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending?;
    ResolveSteps(s, declineRequest(s, surface, requestId), surface, requestId, i0, RequestOutcome.Declined);
  }
}

lemma ask_ensures(s: PageRequests, surface: int, requestId: int, kind: RequestKind, resolvable: bool, link: LinkKind)
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysRequestIdsUnique(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysOneHeldRequestPerSlot(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysHeldRequestIsOnItsPage(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysHistoryIsCounted(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysGrantedOnlyForSitePermission(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysSavingOnlyForDownloads(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysDispatchOnlyForHandoffs(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSettledRequestNeverChanges(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepOutcomeNeverReturnsToPending(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepLookingAwayNeverAccepts(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepGrantOnlyByItsOwnAnswer(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepHistoryMovesOnlyAtPageStart(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepStopEndsNothingAndReports(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepPageStartReportsWithdrawalsFirst(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepWithdrawnPermissionIsNeverGranted(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSavedFollowsSaving(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSpentPopupGestureNeverReturns(s, ask(s, surface, requestId, kind, resolvable, link)))
{
  if inv(s) && canAsk(s, surface, requestId, kind, resolvable, link) {
    var t := ask(s, surface, requestId, kind, resolvable, link);
    var key := (r: PageRequest) => (r.surface, r.requestId);
    var p := pageOf(s, surface);
    var m := s.(requests := t.requests[..|s.requests|], lastEvents := []);
    var n := t.requests[|s.requests|];
    assert t.requests == m.requests + [n];
    assert forall i :: 0 <= i < |s.requests| ==> m.requests[i] == (if ((singleSlot(kind) && (s.requests[i].surface == surface)) && (s.requests[i].kind == kind)) && s.requests[i].verdict.Pending? then s.requests[i].(verdict := RequestOutcome.Ended) else s.requests[i]);
    Rewrite(s, m);
    forall r | r in m.requests ensures (r in s.requests || r.verdict.Ended?) && !(r.verdict.Pending? && singleSlot(kind) && r.surface == surface && r.kind == kind) {
      var i :| 0 <= i < |m.requests| && m.requests[i] == r;
    }
    assert forall i :: 0 <= i < |m.requests| ==> key(m.requests[i]) == key(s.requests[i]);
    Uniq(m);
    forall x, y | x in m.requests && y in [n] ensures key(x) != key(y) {
      var i :| 0 <= i < |m.requests| && m.requests[i] == x;
      assert s.requests[i] in s.requests;
    }
    ProofLib.DistinctByConcat(m.requests, [n], key);
    Uniq(t);
    forall r, q | r in s.requests && !r.verdict.Pending? && q in t.requests && q.surface == r.surface && q.requestId == r.requestId
      ensures !q.verdict.Pending?
    {
      if q != n {
        assert q in m.requests;
      } else {
        assert r.surface == surface && r.requestId == requestId;
      }
    }
    forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
      if r != n {
        assert r in m.requests;
        assert r in s.requests;
      }
    }
  }
}

lemma startPage_ensures(s: PageRequests, surface: int)
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysRequestIdsUnique(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysOneHeldRequestPerSlot(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysHeldRequestIsOnItsPage(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysHistoryIsCounted(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysGrantedOnlyForSitePermission(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysSavingOnlyForDownloads(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysDispatchOnlyForHandoffs(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepSettledRequestNeverChanges(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepOutcomeNeverReturnsToPending(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepLookingAwayNeverAccepts(s, "startPage", startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepGrantOnlyByItsOwnAnswer(s, "startPage", startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepHistoryMovesOnlyAtPageStart(s, "startPage", startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepStopEndsNothingAndReports(s, "startPage", startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepPageStartReportsWithdrawalsFirst(s, "startPage", startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepWithdrawnPermissionIsNeverGranted(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepSavedFollowsSaving(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepSpentPopupGestureNeverReturns(s, startPage(s, surface)))
{
  if inv(s) && canStartPage(s, surface) {
    var t := startPage(s, surface);
    Rewrite(s, t);
    PagesOther(s, t, surface);
    forall r | r in t.requests && r.verdict.Pending? ensures r in s.requests && r.surface != surface {
      var i :| 0 <= i < |t.requests| && t.requests[i] == r;
    }
    var ev := PageEvent(PageEventKind.StartedEvent, surface, 0);
    assert t.lastEvents == withdrawals(s, surface) + [ev];
    assert t.lastEvents[|t.lastEvents| - 1] == ev;
    forall r | r in s.requests && (((r.surface == surface) && r.kind.SitePermissionAsk?) && r.verdict.Pending?) ensures withdrawnOf(r) in t.lastEvents {
      ProofLib.FilterMember((r: PageRequest) => (((r.surface == surface) && r.kind.SitePermissionAsk?) && r.verdict.Pending?), s.requests, r);
      var k :| 0 <= k < |ProofLib.Filter((r: PageRequest) => (((r.surface == surface) && r.kind.SitePermissionAsk?) && r.verdict.Pending?), s.requests)| && ProofLib.Filter((r: PageRequest) => (((r.surface == surface) && r.kind.SitePermissionAsk?) && r.verdict.Pending?), s.requests)[k] == r;
      assert withdrawals(s, surface)[k] == withdrawnOf(r);
      assert t.lastEvents[k] == withdrawnOf(r);
    }
  }
}

lemma setPageVisible_ensures(s: PageRequests, surface: int, visible: bool)
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysRequestIdsUnique(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysOneHeldRequestPerSlot(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysHeldRequestIsOnItsPage(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysHistoryIsCounted(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysGrantedOnlyForSitePermission(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysSavingOnlyForDownloads(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysDispatchOnlyForHandoffs(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSettledRequestNeverChanges(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepOutcomeNeverReturnsToPending(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepLookingAwayNeverAccepts(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepGrantOnlyByItsOwnAnswer(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepHistoryMovesOnlyAtPageStart(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepStopEndsNothingAndReports(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepPageStartReportsWithdrawalsFirst(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepWithdrawnPermissionIsNeverGranted(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSavedFollowsSaving(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSpentPopupGestureNeverReturns(s, setPageVisible(s, surface, visible)))
{
  if inv(s) && canSetPageVisible(s, surface, visible) {
    var t := setPageVisible(s, surface, visible);
    Mapped(s, t, surface, (p: SurfacePage) => p.(visible := visible));
    if visible {
      Same(s, t);
    } else {
      Ending(s, t, surface, EndScope.EndUnseen);
    }
    forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
      assert r in s.requests;
      assert heldAllowed(pageOf(s, r.surface), r);
    }
  }
}

lemma answerSitePermission_ensures(s: PageRequests, surface: int, requestId: int, grant: bool, androidAllows: bool)
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysRequestIdsUnique(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysOneHeldRequestPerSlot(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysHeldRequestIsOnItsPage(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysHistoryIsCounted(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysGrantedOnlyForSitePermission(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysSavingOnlyForDownloads(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysDispatchOnlyForHandoffs(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepSettledRequestNeverChanges(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepOutcomeNeverReturnsToPending(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepLookingAwayNeverAccepts(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepGrantOnlyByItsOwnAnswer(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepHistoryMovesOnlyAtPageStart(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepStopEndsNothingAndReports(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepPageStartReportsWithdrawalsFirst(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepWithdrawnPermissionIsNeverGranted(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepSavedFollowsSaving(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepSpentPopupGestureNeverReturns(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
{
  if inv(s) && canAnswerSitePermission(s, surface, requestId, grant, androidAllows) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending? && s.requests[i0].kind.SitePermissionAsk?;
    ResolveSteps(s, answerSitePermission(s, surface, requestId, grant, androidAllows), surface, requestId, i0, permissionOutcome(grant, androidAllows));
  }
}

lemma withdrawSitePermission_ensures(s: PageRequests, surface: int, requestId: int)
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysRequestIdsUnique(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysOneHeldRequestPerSlot(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysHeldRequestIsOnItsPage(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysHistoryIsCounted(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepGrantOnlyByItsOwnAnswer(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepHistoryMovesOnlyAtPageStart(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepStopEndsNothingAndReports(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepPageStartReportsWithdrawalsFirst(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepWithdrawnPermissionIsNeverGranted(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepSavedFollowsSaving(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepSpentPopupGestureNeverReturns(s, withdrawSitePermission(s, surface, requestId)))
{
  if inv(s) && canWithdrawSitePermission(s, surface, requestId) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending?;
    ResolveSteps(s, withdrawSitePermission(s, surface, requestId), surface, requestId, i0, RequestOutcome.PermissionWithdrawn);
  }
}

lemma answerFileChooser_ensures(s: PageRequests, surface: int, requestId: int, open: bool, pickerBusy: bool)
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysRequestIdsUnique(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysOneHeldRequestPerSlot(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysHeldRequestIsOnItsPage(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysHistoryIsCounted(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysGrantedOnlyForSitePermission(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysSavingOnlyForDownloads(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysDispatchOnlyForHandoffs(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepSettledRequestNeverChanges(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepOutcomeNeverReturnsToPending(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepLookingAwayNeverAccepts(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepGrantOnlyByItsOwnAnswer(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepHistoryMovesOnlyAtPageStart(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepStopEndsNothingAndReports(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepPageStartReportsWithdrawalsFirst(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepWithdrawnPermissionIsNeverGranted(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepSavedFollowsSaving(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepSpentPopupGestureNeverReturns(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
{
  if inv(s) && canAnswerFileChooser(s, surface, requestId, open, pickerBusy) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending?;
    ResolveSteps(s, answerFileChooser(s, surface, requestId, open, pickerBusy), surface, requestId, i0, fileChooserOutcome(open, pickerBusy));
  }
}

lemma saveDownload_ensures(s: PageRequests, surface: int, requestId: int)
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysRequestIdsUnique(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysOneHeldRequestPerSlot(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysHeldRequestIsOnItsPage(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysHistoryIsCounted(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "saveDownload", saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepGrantOnlyByItsOwnAnswer(s, "saveDownload", saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepHistoryMovesOnlyAtPageStart(s, "saveDownload", saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepStopEndsNothingAndReports(s, "saveDownload", saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepPageStartReportsWithdrawalsFirst(s, "saveDownload", saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepWithdrawnPermissionIsNeverGranted(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepSavedFollowsSaving(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepSpentPopupGestureNeverReturns(s, saveDownload(s, surface, requestId)))
{
  if inv(s) && canSaveDownload(s, surface, requestId) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending? && s.requests[i0].kind.DownloadAsk?;
    ResolveSteps(s, saveDownload(s, surface, requestId), surface, requestId, i0, RequestOutcome.Saving);
  }
}

lemma finishDownload_ensures(s: PageRequests, surface: int, requestId: int, settlement: DownloadSettlement)
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysRequestIdsUnique(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysOneHeldRequestPerSlot(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysHeldRequestIsOnItsPage(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysHistoryIsCounted(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysGrantedOnlyForSitePermission(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysSavingOnlyForDownloads(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysDispatchOnlyForHandoffs(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepSettledRequestNeverChanges(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepOutcomeNeverReturnsToPending(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepLookingAwayNeverAccepts(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepGrantOnlyByItsOwnAnswer(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepHistoryMovesOnlyAtPageStart(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepStopEndsNothingAndReports(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepPageStartReportsWithdrawalsFirst(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepWithdrawnPermissionIsNeverGranted(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepSavedFollowsSaving(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepSpentPopupGestureNeverReturns(s, finishDownload(s, surface, requestId, settlement)))
{
  if inv(s) && canFinishDownload(s, surface, requestId, settlement) {
    Held(s, surface, requestId);
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Saving?;
    ResolveSteps(s, finishDownload(s, surface, requestId, settlement), surface, requestId, i0, (if settlement.PublishedWithReceipt? then RequestOutcome.Saved else (if settlement.PublicationFailed? then RequestOutcome.SaveFailed else (if settlement.EntryRemovedBeforeClaim? then RequestOutcome.SaveCancelled else RequestOutcome.SaveUnconfirmed))));
  }
}

lemma openExternalLink_ensures(s: PageRequests, surface: int, requestId: int, context: TabHostLinkContext)
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysRequestIdsUnique(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysOneHeldRequestPerSlot(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysHeldRequestIsOnItsPage(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysHistoryIsCounted(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysGrantedOnlyForSitePermission(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysSavingOnlyForDownloads(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysDispatchOnlyForHandoffs(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepSettledRequestNeverChanges(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepOutcomeNeverReturnsToPending(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepLookingAwayNeverAccepts(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepGrantOnlyByItsOwnAnswer(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepHistoryMovesOnlyAtPageStart(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepStopEndsNothingAndReports(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepPageStartReportsWithdrawalsFirst(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepWithdrawnPermissionIsNeverGranted(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepSavedFollowsSaving(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepSpentPopupGestureNeverReturns(s, openExternalLink(s, surface, requestId, context)))
{
  if inv(s) && canOpenExternalLink(s, surface, requestId, context) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending? && s.requests[i0].kind.ExternalLinkAsk?;
    ResolveSteps(s, openExternalLink(s, surface, requestId, context), surface, requestId, i0, (if requestOf(s, surface, requestId).resolvable then RequestOutcome.Dispatched else RequestOutcome.ExternalAppUnavailable));
  }
}

lemma openIdentityProvider_ensures(s: PageRequests, surface: int, requestId: int)
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysRequestIdsUnique(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysOneHeldRequestPerSlot(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysHeldRequestIsOnItsPage(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysHistoryIsCounted(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepGrantOnlyByItsOwnAnswer(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepHistoryMovesOnlyAtPageStart(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepStopEndsNothingAndReports(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepPageStartReportsWithdrawalsFirst(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepWithdrawnPermissionIsNeverGranted(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSavedFollowsSaving(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSpentPopupGestureNeverReturns(s, openIdentityProvider(s, surface, requestId)))
{
  if inv(s) && canOpenIdentityProvider(s, surface, requestId) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending? && s.requests[i0].kind.IdentityProviderAsk?;
    ResolveSteps(s, openIdentityProvider(s, surface, requestId), surface, requestId, i0, (if requestOf(s, surface, requestId).resolvable then RequestOutcome.Dispatched else RequestOutcome.BrowserUnavailable));
  }
}

lemma Mapped(s: PageRequests, t: PageRequests, surface: int, g: SurfacePage -> SurfacePage)
  requires inv(s) && pageOf(s, surface) != noPage && |t.pages| == |s.pages|
  requires forall i :: 0 <= i < |s.pages| ==> t.pages[i] == (if s.pages[i].surface == surface then g(s.pages[i]) else s.pages[i])
  requires forall p: SurfacePage :: g(p).surface == p.surface && g(p).back == p.back && g(p).forward == p.forward
  requires forall p: SurfacePage :: ((p.pending.LoadBack? ==> p.back > 0) && (p.pending.LoadForward? ==> p.forward > 0)) ==> ((g(p).pending.LoadBack? ==> g(p).back > 0) && (g(p).pending.LoadForward? ==> g(p).forward > 0))
  ensures pageOf(t, surface) == g(pageOf(s, surface))
  ensures forall x :: x != surface ==> pageOf(t, x) == pageOf(s, x)
  ensures alwaysHistoryIsCounted(t)
  ensures forall via :: stepHistoryMovesOnlyAtPageStart(s, via, t)
{
  PagesOther(s, t, surface);
  ProofLib.FilterPointwise((p: SurfacePage) => (p.surface == surface), (p: SurfacePage) => (p.surface == surface),
    (a: SurfacePage, b: SurfacePage) => b == (if a.surface == surface then g(a) else a), s.pages, t.pages);
  if |ProofLib.Filter((p: SurfacePage) => (p.surface == surface), s.pages)| > 0 {
    ProofLib.FilterMember((p: SurfacePage) => (p.surface == surface), s.pages, ProofLib.Filter((p: SurfacePage) => (p.surface == surface), s.pages)[0]);
  }
  forall p | p in t.pages
    ensures (exists q :: q in s.pages && q.surface == p.surface && q.back == p.back && q.forward == p.forward)
    ensures p.back >= 0 && p.forward >= 0 && (p.pending.LoadBack? ==> p.back > 0) && (p.pending.LoadForward? ==> p.forward > 0)
  {
    var i :| 0 <= i < |t.pages| && t.pages[i] == p;
    assert s.pages[i] in s.pages;
  }
}

lemma Ending(s: PageRequests, t: PageRequests, surface: int, scope: EndScope)
  requires inv(s) && t.requests == endHeld(s, surface, scope)
  ensures alwaysRequestIdsUnique(t) && stepSettledRequestNeverChanges(s, t) && stepOutcomeNeverReturnsToPending(s, t) && stepWithdrawnPermissionIsNeverGranted(s, t)
  ensures forall r :: r in t.requests && r.verdict.Pending? ==> r in s.requests && (r.surface == surface ==> !ends(scope, r.kind))
  ensures forall r :: r in t.requests ==> r in s.requests || r.verdict.Ended?
  ensures alwaysOneHeldRequestPerSlot(t)
{
  Rewrite(s, t);
  forall r | r in t.requests ensures (r in s.requests || r.verdict.Ended?) && (r.verdict.Pending? ==> r in s.requests && (r.surface == surface ==> !ends(scope, r.kind))) {
    var i :| 0 <= i < |t.requests| && t.requests[i] == r;
  }
}

lemma Same(s: PageRequests, t: PageRequests)
  requires inv(s) && t.requests == s.requests
  ensures alwaysRequestIdsUnique(t) && stepSettledRequestNeverChanges(s, t) && stepOutcomeNeverReturnsToPending(s, t) && stepWithdrawnPermissionIsNeverGranted(s, t)
{
  Rewrite(s, t);
}

lemma setPagePaused_ensures(s: PageRequests, surface: int, paused: bool)
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysRequestIdsUnique(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysOneHeldRequestPerSlot(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysHeldRequestIsOnItsPage(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysHistoryIsCounted(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysGrantedOnlyForSitePermission(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysSavingOnlyForDownloads(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> alwaysDispatchOnlyForHandoffs(setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepSettledRequestNeverChanges(s, setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepOutcomeNeverReturnsToPending(s, setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepLookingAwayNeverAccepts(s, "setPagePaused", setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepGrantOnlyByItsOwnAnswer(s, "setPagePaused", setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepHistoryMovesOnlyAtPageStart(s, "setPagePaused", setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepStopEndsNothingAndReports(s, "setPagePaused", setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepPageStartReportsWithdrawalsFirst(s, "setPagePaused", setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepWithdrawnPermissionIsNeverGranted(s, setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepSavedFollowsSaving(s, setPagePaused(s, surface, paused)))
  ensures (inv(s) ==> canSetPagePaused(s, surface, paused) ==> stepSpentPopupGestureNeverReturns(s, setPagePaused(s, surface, paused)))
{
  if inv(s) && canSetPagePaused(s, surface, paused) {
    var t := setPagePaused(s, surface, paused);
    Mapped(s, t, surface, (p: SurfacePage) => p.(paused := paused));
    if paused {
      Ending(s, t, surface, EndScope.EndDialogs);
    } else {
      Same(s, t);
    }
    forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
      assert r in s.requests;
      assert heldAllowed(pageOf(s, r.surface), r);
    }
  }
}

lemma stopLoading_ensures(s: PageRequests, surface: int)
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysRequestIdsUnique(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysOneHeldRequestPerSlot(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysHeldRequestIsOnItsPage(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysHistoryIsCounted(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysGrantedOnlyForSitePermission(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysSavingOnlyForDownloads(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> alwaysDispatchOnlyForHandoffs(stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepSettledRequestNeverChanges(s, stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepOutcomeNeverReturnsToPending(s, stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepLookingAwayNeverAccepts(s, "stopLoading", stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepGrantOnlyByItsOwnAnswer(s, "stopLoading", stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepHistoryMovesOnlyAtPageStart(s, "stopLoading", stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepStopEndsNothingAndReports(s, "stopLoading", stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepPageStartReportsWithdrawalsFirst(s, "stopLoading", stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepWithdrawnPermissionIsNeverGranted(s, stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepSavedFollowsSaving(s, stopLoading(s, surface)))
  ensures (inv(s) ==> canStopLoading(s, surface) ==> stepSpentPopupGestureNeverReturns(s, stopLoading(s, surface)))
{
  if inv(s) && canStopLoading(s, surface) {
    var t := stopLoading(s, surface);
    Mapped(s, t, surface, (p: SurfacePage) => p.(pending := LoadKind.NoLoad, loading := false));
    Same(s, t);
    forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
      assert heldAllowed(pageOf(s, r.surface), r);
    }
  }
}

lemma finishLoad_ensures(s: PageRequests, surface: int)
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysRequestIdsUnique(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysOneHeldRequestPerSlot(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysHeldRequestIsOnItsPage(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysHistoryIsCounted(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysGrantedOnlyForSitePermission(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysSavingOnlyForDownloads(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> alwaysDispatchOnlyForHandoffs(finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepSettledRequestNeverChanges(s, finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepOutcomeNeverReturnsToPending(s, finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepLookingAwayNeverAccepts(s, "finishLoad", finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepGrantOnlyByItsOwnAnswer(s, "finishLoad", finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepHistoryMovesOnlyAtPageStart(s, "finishLoad", finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepStopEndsNothingAndReports(s, "finishLoad", finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepPageStartReportsWithdrawalsFirst(s, "finishLoad", finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepWithdrawnPermissionIsNeverGranted(s, finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepSavedFollowsSaving(s, finishLoad(s, surface)))
  ensures (inv(s) ==> canFinishLoad(s, surface) ==> stepSpentPopupGestureNeverReturns(s, finishLoad(s, surface)))
{
  if inv(s) && canFinishLoad(s, surface) {
    var t := finishLoad(s, surface);
    Mapped(s, t, surface, (p: SurfacePage) => p.(loading := false));
    Same(s, t);
    forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
      assert heldAllowed(pageOf(s, r.surface), r);
    }
  }
}

lemma requestLoad_ensures(s: PageRequests, surface: int, load: LoadKind)
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysRequestIdsUnique(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysOneHeldRequestPerSlot(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysHeldRequestIsOnItsPage(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysHistoryIsCounted(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysGrantedOnlyForSitePermission(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysSavingOnlyForDownloads(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> alwaysDispatchOnlyForHandoffs(requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepSettledRequestNeverChanges(s, requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepOutcomeNeverReturnsToPending(s, requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepLookingAwayNeverAccepts(s, "requestLoad", requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepGrantOnlyByItsOwnAnswer(s, "requestLoad", requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepHistoryMovesOnlyAtPageStart(s, "requestLoad", requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepStopEndsNothingAndReports(s, "requestLoad", requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepPageStartReportsWithdrawalsFirst(s, "requestLoad", requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepWithdrawnPermissionIsNeverGranted(s, requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepSavedFollowsSaving(s, requestLoad(s, surface, load)))
  ensures (inv(s) ==> canRequestLoad(s, surface, load) ==> stepSpentPopupGestureNeverReturns(s, requestLoad(s, surface, load)))
{
  if inv(s) && canRequestLoad(s, surface, load) {
    var t := requestLoad(s, surface, load);
    if !loadAccepted(pageOf(s, surface), load) {
      assert t == s.(lastEvents := []);
      Same(s, t);
    } else {
      Mapped(s, t, surface, (p: SurfacePage) => if loadAccepted(p, load) then p.(pending := load, loading := true) else p);
      Ending(s, t, surface, EndScope.EndUnseen);
      forall r | r in t.requests && r.verdict.Pending? ensures heldAllowed(pageOf(t, r.surface), r) {
        assert r in s.requests;
        assert heldAllowed(pageOf(s, r.surface), r);
      }
    }
  }
}

lemma lawUndeclaredKindNeverOffered_ensures(requested: seq<SitePermissionKind>, declared: seq<SitePermissionKind>)
  ensures (lawUndeclaredKindNeverOffered(requested, declared) == true)
{
  forall x: SitePermissionKind ensures x in offeredKinds(requested, declared) <==> x in requested && x in declared {
    ProofLib.FilterMember((set_x: SitePermissionKind) => (set_x in declared), requested, x);
  }
}
