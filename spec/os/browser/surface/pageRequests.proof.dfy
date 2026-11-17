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
  ensures alwaysHeldRequestIsOnItsVisiblePage(t)
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
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysHeldRequestIsOnItsVisiblePage(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysGrantedOnlyForSitePermission(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysSavingOnlyForDownloads(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> alwaysDispatchOnlyForHandoffs(answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepSettledRequestNeverChanges(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepOutcomeNeverReturnsToPending(s, answerDialog(s, surface, requestId, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, surface, requestId, accept) ==> stepLookingAwayNeverAccepts(s, "answerDialog", answerDialog(s, surface, requestId, accept)))
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
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysHeldRequestIsOnItsVisiblePage(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, declineRequest(s, surface, requestId)))
  ensures (inv(s) ==> canDeclineRequest(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "declineRequest", declineRequest(s, surface, requestId)))
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
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysHeldRequestIsOnItsVisiblePage(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysGrantedOnlyForSitePermission(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysSavingOnlyForDownloads(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> alwaysDispatchOnlyForHandoffs(ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSettledRequestNeverChanges(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepOutcomeNeverReturnsToPending(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepLookingAwayNeverAccepts(s, "ask", ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepWithdrawnPermissionIsNeverGranted(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSavedFollowsSaving(s, ask(s, surface, requestId, kind, resolvable, link)))
  ensures (inv(s) ==> canAsk(s, surface, requestId, kind, resolvable, link) ==> stepSpentPopupGestureNeverReturns(s, ask(s, surface, requestId, kind, resolvable, link)))
{
  if inv(s) && canAsk(s, surface, requestId, kind, resolvable, link) {
    var t := ask(s, surface, requestId, kind, resolvable, link);
    var key := (r: PageRequest) => (r.surface, r.requestId);
    var n := t.requests[|s.requests|];
    assert t.requests == s.requests + [n];
    Uniq(s);
    ProofLib.DistinctByConcat(s.requests, [n], key);
    Uniq(t);
    forall r, q | r in s.requests && !r.verdict.Pending? && q in t.requests && q.surface == r.surface && q.requestId == r.requestId
      ensures !q.verdict.Pending?
    {
      if q != n {
        var i :| 0 <= i < |s.requests| && s.requests[i] == r;
        var j :| 0 <= j < |s.requests| && s.requests[j] == q;
        assert key(s.requests[j]) == key(s.requests[i]);
      }
    }
  }
}

lemma startPage_ensures(s: PageRequests, surface: int)
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysRequestIdsUnique(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysHeldRequestIsOnItsVisiblePage(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysGrantedOnlyForSitePermission(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysSavingOnlyForDownloads(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> alwaysDispatchOnlyForHandoffs(startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepSettledRequestNeverChanges(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepOutcomeNeverReturnsToPending(s, startPage(s, surface)))
  ensures (inv(s) ==> canStartPage(s, surface) ==> stepLookingAwayNeverAccepts(s, "startPage", startPage(s, surface)))
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
  }
}

lemma setPageVisible_ensures(s: PageRequests, surface: int, visible: bool)
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysRequestIdsUnique(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysHeldRequestIsOnItsVisiblePage(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysGrantedOnlyForSitePermission(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysSavingOnlyForDownloads(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> alwaysDispatchOnlyForHandoffs(setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSettledRequestNeverChanges(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepOutcomeNeverReturnsToPending(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepLookingAwayNeverAccepts(s, "setPageVisible", setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepWithdrawnPermissionIsNeverGranted(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSavedFollowsSaving(s, setPageVisible(s, surface, visible)))
  ensures (inv(s) ==> canSetPageVisible(s, surface, visible) ==> stepSpentPopupGestureNeverReturns(s, setPageVisible(s, surface, visible)))
{
  if inv(s) && canSetPageVisible(s, surface, visible) {
    var t := setPageVisible(s, surface, visible);
    Rewrite(s, t);
    PagesOther(s, t, surface);
    forall r | r in t.requests && r.verdict.Pending? ensures r in s.requests && r.surface != surface {
      var i :| 0 <= i < |t.requests| && t.requests[i] == r;
    }
  }
}

lemma answerSitePermission_ensures(s: PageRequests, surface: int, requestId: int, grant: bool, androidAllows: bool)
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysRequestIdsUnique(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysHeldRequestIsOnItsVisiblePage(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysGrantedOnlyForSitePermission(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysSavingOnlyForDownloads(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> alwaysDispatchOnlyForHandoffs(answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepSettledRequestNeverChanges(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepOutcomeNeverReturnsToPending(s, answerSitePermission(s, surface, requestId, grant, androidAllows)))
  ensures (inv(s) ==> canAnswerSitePermission(s, surface, requestId, grant, androidAllows) ==> stepLookingAwayNeverAccepts(s, "answerSitePermission", answerSitePermission(s, surface, requestId, grant, androidAllows)))
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
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysHeldRequestIsOnItsVisiblePage(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, withdrawSitePermission(s, surface, requestId)))
  ensures (inv(s) ==> canWithdrawSitePermission(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "withdrawSitePermission", withdrawSitePermission(s, surface, requestId)))
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
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysHeldRequestIsOnItsVisiblePage(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysGrantedOnlyForSitePermission(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysSavingOnlyForDownloads(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> alwaysDispatchOnlyForHandoffs(answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepSettledRequestNeverChanges(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepOutcomeNeverReturnsToPending(s, answerFileChooser(s, surface, requestId, open, pickerBusy)))
  ensures (inv(s) ==> canAnswerFileChooser(s, surface, requestId, open, pickerBusy) ==> stepLookingAwayNeverAccepts(s, "answerFileChooser", answerFileChooser(s, surface, requestId, open, pickerBusy)))
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
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysHeldRequestIsOnItsVisiblePage(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, saveDownload(s, surface, requestId)))
  ensures (inv(s) ==> canSaveDownload(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "saveDownload", saveDownload(s, surface, requestId)))
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
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysHeldRequestIsOnItsVisiblePage(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysGrantedOnlyForSitePermission(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysSavingOnlyForDownloads(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> alwaysDispatchOnlyForHandoffs(finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepSettledRequestNeverChanges(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepOutcomeNeverReturnsToPending(s, finishDownload(s, surface, requestId, settlement)))
  ensures (inv(s) ==> canFinishDownload(s, surface, requestId, settlement) ==> stepLookingAwayNeverAccepts(s, "finishDownload", finishDownload(s, surface, requestId, settlement)))
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
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysHeldRequestIsOnItsVisiblePage(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysGrantedOnlyForSitePermission(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysSavingOnlyForDownloads(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> alwaysDispatchOnlyForHandoffs(openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepSettledRequestNeverChanges(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepOutcomeNeverReturnsToPending(s, openExternalLink(s, surface, requestId, context)))
  ensures (inv(s) ==> canOpenExternalLink(s, surface, requestId, context) ==> stepLookingAwayNeverAccepts(s, "openExternalLink", openExternalLink(s, surface, requestId, context)))
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
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysHeldRequestIsOnItsVisiblePage(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysGrantedOnlyForSitePermission(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysSavingOnlyForDownloads(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> alwaysDispatchOnlyForHandoffs(openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSettledRequestNeverChanges(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepOutcomeNeverReturnsToPending(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepLookingAwayNeverAccepts(s, "openIdentityProvider", openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepWithdrawnPermissionIsNeverGranted(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSavedFollowsSaving(s, openIdentityProvider(s, surface, requestId)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, surface, requestId) ==> stepSpentPopupGestureNeverReturns(s, openIdentityProvider(s, surface, requestId)))
{
  if inv(s) && canOpenIdentityProvider(s, surface, requestId) {
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].surface == surface && s.requests[i0].requestId == requestId && s.requests[i0].verdict.Pending? && s.requests[i0].kind.IdentityProviderAsk?;
    ResolveSteps(s, openIdentityProvider(s, surface, requestId), surface, requestId, i0, (if requestOf(s, surface, requestId).resolvable then RequestOutcome.Dispatched else RequestOutcome.BrowserUnavailable));
  }
}
