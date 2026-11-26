lemma WithdrawnBridge(gone: seq<PageRequest>)
  ensures withdrawn(gone) ==
    (var s_map := ProofLib.Filter((r: PageRequest) => r.kind.SitePermission?, gone); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var r := s_map[i_map]; PermissionWithdrawn(r.surface, r.id)))
{}

lemma StepWithdrawnBridge(before: PageRequests, via: string, after: PageRequests, out: seq<PageNotice>)
  ensures stepEndedPermissionsAreWithdrawnBeforeTheStart(before, via, after, out) ==
    (var local_4 := ProofLib.Filter((r: PageRequest) => ((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in before.requests && ((b.id == r.id) && active(b.status)))), after.requests);
     var local_5 := (if ((0 <= (|out| - 1)) && ((|out| - 1) < |out|)) then out[(|out| - 1)] else Asked("", 0, RequestKind.Dialog));
     ((ProofLib.Filter((n: PageNotice) => isWithdrawal(n), out) == (if (via == "androidAnswered") then [] else withdrawn(local_4))) && (!((via == "pageStarted")) || ((|out| > 0) && isStarted(local_5)))))
{}

lemma EndUnheldBridge(host: os__browser__surface__lifecycle_SurfaceHost, s: PageRequests)
  ensures endUnheld(host, s) ==
    PageChange(s.(host := host, requests := (var s_map := s.requests; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var r := s_map[i_map]; (if (endsOn(host, r) || saveStops(host, r)) then r.(status := ended(r.kind)) else r)))), withdrawn(ProofLib.Filter((r: PageRequest) => endsOn(host, r), s.requests)))
{}

lemma PageStartedBridge(s: PageRequests, id: string, href: string)
  ensures pageStarted(s, id, href) ==
    PageChange(s.(host := os__browser__surface__lifecycle_pageStarted(s.host, id, href), requests := (var s_map := s.requests; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var r := s_map[i_map]; (if onPage(s.host, id, r) then r.(status := ended(r.kind)) else r)))), (withdrawn(ProofLib.Filter((r: PageRequest) => onPage(s.host, id, r), s.requests)) + [Started(id, href)]))
{}

lemma WithdrawSitePermissionBridge(s: PageRequests, request: int)
  ensures withdrawSitePermission(s, request) ==
    PageChange(setStatus(request, s, PermissionAnswered(PermissionAnswer.Ended)), withdrawn(ProofLib.Filter((r: PageRequest) => (r.id == request), s.requests)))
{}

lemma DownloadFinishedBridge(s: PageRequests, request: int, published: bool)
  ensures downloadFinished(s, request, published) ==
    PageChange(setStatus(request, s, (if published then RequestStatus.Saved else RequestStatus.SaveFailed)), (var s_map := ProofLib.Filter((r: PageRequest) => ((r.id == request) && (exists x :: x in s.host.surfaces && ((x.id == r.surface) && (x.gen == r.gen)))), s.requests); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var r := s_map[i_map]; DownloadFinished(r.surface, r.id, published))))
{}

lemma RequestsNeverForgotten(before: PageRequests, after: PageRequests)
  requires |after.requests| >= |before.requests|
  requires forall i :: 0 <= i < |before.requests| ==> after.requests[i].id == before.requests[i].id
  ensures stepRequestsAreNeverForgotten(before, after)
{
  hide *;
  reveal stepRequestsAreNeverForgotten;
  forall b | b in before.requests
    ensures exists r :: r in after.requests && r.id == b.id
  {
    var i :| 0 <= i < |before.requests| && before.requests[i] == b;
    assert after.requests[i] in after.requests && after.requests[i].id == b.id;
  }
}

lemma AllWithdrawalsKept(ns: seq<PageNotice>)
  requires forall n :: n in ns ==> isWithdrawal(n)
  ensures ProofLib.Filter((n: PageNotice) => isWithdrawal(n), ns) == ns
  decreases |ns|
{
  var p := (n: PageNotice) => isWithdrawal(n);
  if |ns| == 0 {
    ProofLib.FilterNil(p, ns);
  } else {
    ProofLib.FilterCons(p, ns);
    assert forall n :: n in ns[1..] ==> n in ns;
    AllWithdrawalsKept(ns[1..]);
  }
}

lemma NoWithdrawals(ns: seq<PageNotice>)
  requires forall n :: n in ns ==> !isWithdrawal(n)
  ensures ProofLib.Filter((n: PageNotice) => isWithdrawal(n), ns) == []
{
  ProofLib.FilterNone((n: PageNotice) => isWithdrawal(n), ns);
}

lemma FilteredPermsMatch(p1: PageRequest -> bool, p2: PageRequest -> bool, xs: seq<PageRequest>, ys: seq<PageRequest>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> ys[i].id == xs[i].id && ys[i].surface == xs[i].surface && ys[i].kind == xs[i].kind
  requires forall i :: 0 <= i < |xs| ==> (p1(xs[i]) && xs[i].kind.SitePermission?) == (p2(ys[i]) && ys[i].kind.SitePermission?)
  ensures var isPerm := (r: PageRequest) => r.kind.SitePermission?;
    var a := ProofLib.Filter(isPerm, ProofLib.Filter(p1, xs));
    var b := ProofLib.Filter(isPerm, ProofLib.Filter(p2, ys));
    |a| == |b| && forall i :: 0 <= i < |a| ==> a[i].surface == b[i].surface && a[i].id == b[i].id
  decreases |xs|
{
  var isPerm := (r: PageRequest) => r.kind.SitePermission?;
  var f1 := ProofLib.Filter(p1, xs);
  var f2 := ProofLib.Filter(p2, ys);
  if |xs| == 0 {
    ProofLib.FilterNil(p1, xs);
    ProofLib.FilterNil(p2, ys);
    ProofLib.FilterNil(isPerm, f1);
    ProofLib.FilterNil(isPerm, f2);
  } else {
    ProofLib.FilterCons(p1, xs);
    ProofLib.FilterCons(p2, ys);
    var r1 := ProofLib.Filter(p1, xs[1..]);
    var r2 := ProofLib.Filter(p2, ys[1..]);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    FilteredPermsMatch(p1, p2, xs[1..], ys[1..]);
    if p1(xs[0]) {
      ProofLib.FilterCons(isPerm, f1);
      assert f1[0] == xs[0] && f1[1..] == r1;
    } else {
      assert f1 == r1;
    }
    if p2(ys[0]) {
      ProofLib.FilterCons(isPerm, f2);
      assert f2[0] == ys[0] && f2[1..] == r2;
    } else {
      assert f2 == r2;
    }
  }
}

lemma WithdrawnFilterSeqEq(p1: PageRequest -> bool, p2: PageRequest -> bool, xs: seq<PageRequest>, ys: seq<PageRequest>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> ys[i].id == xs[i].id && ys[i].surface == xs[i].surface && ys[i].kind == xs[i].kind
  requires forall i :: 0 <= i < |xs| ==> (p1(xs[i]) && xs[i].kind.SitePermission?) == (p2(ys[i]) && ys[i].kind.SitePermission?)
  ensures withdrawn(ProofLib.Filter(p1, xs)) == withdrawn(ProofLib.Filter(p2, ys))
{
  var f1 := ProofLib.Filter(p1, xs);
  var f2 := ProofLib.Filter(p2, ys);
  WithdrawnBridge(f1);
  WithdrawnBridge(f2);
  FilteredPermsMatch(p1, p2, xs, ys);
}

lemma NoEndedPermissions(before: PageRequests, via: string, after: PageRequests, out: seq<PageNotice>)
  requires via != "pageStarted" && via != "androidAnswered"
  requires forall n :: n in out ==> !isWithdrawal(n)
  requires forall r :: r in after.requests ==> !((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in before.requests && ((b.id == r.id) && active(b.status))))
  ensures stepEndedPermissionsAreWithdrawnBeforeTheStart(before, via, after, out)
{
  hide *;
  StepWithdrawnBridge(before, via, after, out);
  NoWithdrawals(out);
  var endedPred := (r: PageRequest) => ((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in before.requests && ((b.id == r.id) && active(b.status))));
  ProofLib.FilterNone(endedPred, after.requests);
  var empty: seq<PageRequest> := [];
  WithdrawnBridge(empty);
  ProofLib.FilterNil((r: PageRequest) => r.kind.SitePermission?, empty);
}

lemma EndUnheldWithdrawn(host: os__browser__surface__lifecycle_SurfaceHost, s: PageRequests, via: string)
  requires inv(s)
  requires via != "pageStarted" && via != "androidAnswered"
  ensures stepEndedPermissionsAreWithdrawnBeforeTheStart(s, via, endUnheld(host, s).state, endUnheld(host, s).out)
{
  hide *;
  reveal inv, alwaysRequestIdsAreIssuedOnce, active, ended, endsOn, saveStops, isWithdrawal, typed0_os__browser__surface__pageRequests;
  EndUnheldBridge(host, s);
  var after := endUnheld(host, s);
  StepWithdrawnBridge(s, via, after.state, after.out);
  WithdrawnBridge(ProofLib.Filter((r: PageRequest) => endsOn(host, r), s.requests));
  AllWithdrawalsKept(after.out);
  var p1 := (r: PageRequest) => endsOn(host, r);
  var p2 := (r: PageRequest) => ((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in s.requests && ((b.id == r.id) && active(b.status))));
  forall i | 0 <= i < |s.requests|
    ensures (p1(s.requests[i]) && s.requests[i].kind.SitePermission?) == (p2(after.state.requests[i]) && after.state.requests[i].kind.SitePermission?)
  {
    var r := s.requests[i];
    var r2 := after.state.requests[i];
    if p2(r2) && r2.kind.SitePermission? {
      var b :| b in s.requests && b.id == r2.id && active(b.status);
      assert b == r;
      assert endsOn(host, r);
    }
  }
  WithdrawnFilterSeqEq(p1, p2, s.requests, after.state.requests);
}

lemma EndUnheldPreserves(host: os__browser__surface__lifecycle_SurfaceHost, s: PageRequests, via: string)
  requires inv(s)
  requires via != "pageStarted" && via != "androidAnswered"
  ensures var after := endUnheld(host, s);
    alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(after.state) &&
    alwaysRequestIdsAreIssuedOnce(after.state) &&
    alwaysOneAtATimeKindsWaitAlone(after.state) &&
    alwaysOutcomeFitsItsKind(after.state) &&
    alwaysAnOpenPickerServesItsRequest(after.state) &&
    alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(after.state) &&
    stepOnlyAHeldRequestIsReported(s, via, after.state, after.out) &&
    stepEveryOutcomeIsItsAnswerOrAnEnding(s, via, after.state) &&
    stepRequestsAreNeverForgotten(s, after.state) &&
    stepEndedPermissionsAreWithdrawnBeforeTheStart(s, via, after.state, after.out) &&
    stepGrantFollowsMyGrantAndAndroid(s, via, after.state)
{
  hide *;
  reveal inv, active, ended, endsOn, saveStops, fitsKind, shownOnly, oneAtATime, typed0_os__browser__surface__pageRequests, typed1_os__browser__surface__pageRequests, alwaysHeldRequestsAreOnSurfacesThatMayHoldThem, alwaysRequestIdsAreIssuedOnce, alwaysOneAtATimeKindsWaitAlone, alwaysOutcomeFitsItsKind, alwaysAnOpenPickerServesItsRequest, alwaysASaveRunsOnlyWhileItsSurfaceIsOpen, stepOnlyAHeldRequestIsReported, stepEveryOutcomeIsItsAnswerOrAnEnding, stepGrantFollowsMyGrantAndAndroid;
  EndUnheldWithdrawn(host, s, via);
  EndUnheldBridge(host, s);
  var after := endUnheld(host, s);
  WithdrawnBridge(ProofLib.Filter((r: PageRequest) => endsOn(host, r), s.requests));
  RequestsNeverForgotten(s, after.state);
}

lemma PageStartedWithdrawn(s: PageRequests, id: string, href: string)
  requires inv(s) && canPageStarted(s, id, href)
  ensures stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "pageStarted", pageStarted(s, id, href).state, pageStarted(s, id, href).out)
{
  hide *;
  reveal inv, alwaysRequestIdsAreIssuedOnce, active, ended, isWithdrawal, isStarted, onPage, typed0_os__browser__surface__pageRequests;
  PageStartedBridge(s, id, href);
  var after := pageStarted(s, id, href);
  StepWithdrawnBridge(s, "pageStarted", after.state, after.out);
  var p1 := (r: PageRequest) => onPage(s.host, id, r);
  var p2 := (r: PageRequest) => ((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in s.requests && ((b.id == r.id) && active(b.status))));
  var w := withdrawn(ProofLib.Filter(p1, s.requests));
  WithdrawnBridge(ProofLib.Filter(p1, s.requests));
  ProofLib.FilterAppend((n: PageNotice) => isWithdrawal(n), w, Started(id, href));
  AllWithdrawalsKept(w);
  forall i | 0 <= i < |s.requests|
    ensures (p1(s.requests[i]) && s.requests[i].kind.SitePermission?) == (p2(after.state.requests[i]) && after.state.requests[i].kind.SitePermission?)
  {
    var r := s.requests[i];
    var r2 := after.state.requests[i];
    if p2(r2) && r2.kind.SitePermission? {
      var b :| b in s.requests && b.id == r2.id && active(b.status);
      assert b == r;
      assert onPage(s.host, id, r);
    }
  }
  WithdrawnFilterSeqEq(p1, p2, s.requests, after.state.requests);
}

lemma pageAsks_ensures(s: PageRequests, id: string, kind: RequestKind)
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysRequestIdsAreIssuedOnce(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysOneAtATimeKindsWaitAlone(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysOutcomeFitsItsKind(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysAnOpenPickerServesItsRequest(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> stepOnlyAHeldRequestIsReported(s, "pageAsks", pageAsks(s, id, kind).state, pageAsks(s, id, kind).out))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "pageAsks", pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> stepRequestsAreNeverForgotten(s, pageAsks(s, id, kind).state))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "pageAsks", pageAsks(s, id, kind).state, pageAsks(s, id, kind).out))
  ensures (inv(s) ==> canPageAsks(s, id, kind) ==> stepGrantFollowsMyGrantAndAndroid(s, "pageAsks", pageAsks(s, id, kind).state))
{
  hide *;
  reveal inv, canPageAsks, pageAsks, active, ended, allowedOn, mayHold, fitsKind, shownOnly, oneAtATime, isWithdrawal, typed0_os__browser__surface__pageRequests, typed1_os__browser__surface__pageRequests, alwaysHeldRequestsAreOnSurfacesThatMayHoldThem, alwaysRequestIdsAreIssuedOnce, alwaysOneAtATimeKindsWaitAlone, alwaysOutcomeFitsItsKind, alwaysAnOpenPickerServesItsRequest, alwaysASaveRunsOnlyWhileItsSurfaceIsOpen, stepOnlyAHeldRequestIsReported, stepEveryOutcomeIsItsAnswerOrAnEnding, stepGrantFollowsMyGrantAndAndroid;
  if inv(s) && canPageAsks(s, id, kind) {
    var after := pageAsks(s, id, kind);
    RequestsNeverForgotten(s, after.state);
    NoEndedPermissions(s, "pageAsks", after.state, after.out);
  }
}

lemma answerDialog_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int, accept: bool)
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysRequestIdsAreIssuedOnce(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysOneAtATimeKindsWaitAlone(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysOutcomeFitsItsKind(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysAnOpenPickerServesItsRequest(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> stepOnlyAHeldRequestIsReported(s, "answerDialog", answerDialog(s, realm, id, request, accept), []))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "answerDialog", answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> stepRequestsAreNeverForgotten(s, answerDialog(s, realm, id, request, accept)))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "answerDialog", answerDialog(s, realm, id, request, accept), []))
  ensures (inv(s) ==> canAnswerDialog(s, realm, id, request, accept) ==> stepGrantFollowsMyGrantAndAndroid(s, "answerDialog", answerDialog(s, realm, id, request, accept)))
{
  if inv(s) && canAnswerDialog(s, realm, id, request, accept) {
    var after := answerDialog(s, realm, id, request, accept);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "answerDialog", after, []);
  }
}

lemma pageStarted_ensures(s: PageRequests, id: string, href: string)
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysRequestIdsAreIssuedOnce(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysOneAtATimeKindsWaitAlone(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysOutcomeFitsItsKind(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysAnOpenPickerServesItsRequest(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> stepOnlyAHeldRequestIsReported(s, "pageStarted", pageStarted(s, id, href).state, pageStarted(s, id, href).out))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "pageStarted", pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> stepRequestsAreNeverForgotten(s, pageStarted(s, id, href).state))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "pageStarted", pageStarted(s, id, href).state, pageStarted(s, id, href).out))
  ensures (inv(s) ==> canPageStarted(s, id, href) ==> stepGrantFollowsMyGrantAndAndroid(s, "pageStarted", pageStarted(s, id, href).state))
{
  hide *;
  reveal inv, canPageStarted, os__browser__surface__lifecycle_pageStarted, active, ended, allowedOn, mayHold, onPage, fitsKind, shownOnly, oneAtATime, typed0_os__browser__surface__pageRequests, typed1_os__browser__surface__pageRequests, alwaysHeldRequestsAreOnSurfacesThatMayHoldThem, alwaysRequestIdsAreIssuedOnce, alwaysOneAtATimeKindsWaitAlone, alwaysOutcomeFitsItsKind, alwaysAnOpenPickerServesItsRequest, alwaysASaveRunsOnlyWhileItsSurfaceIsOpen, stepOnlyAHeldRequestIsReported, stepEveryOutcomeIsItsAnswerOrAnEnding, stepGrantFollowsMyGrantAndAndroid;
  if inv(s) && canPageStarted(s, id, href) {
    PageStartedWithdrawn(s, id, href);
    PageStartedBridge(s, id, href);
    var after := pageStarted(s, id, href);
    RequestsNeverForgotten(s, after.state);
    WithdrawnBridge(ProofLib.Filter((r: PageRequest) => onPage(s.host, id, r), s.requests));
    forall x | x in s.host.surfaces
      ensures exists y :: y in after.state.host.surfaces && y.id == x.id && y.gen == x.gen && y.policy == x.policy && y.presented == x.presented && y.paused == x.paused
    {
      var i :| 0 <= i < |s.host.surfaces| && s.host.surfaces[i] == x;
      assert after.state.host.surfaces[i] in after.state.host.surfaces;
    }
  }
}

lemma withdrawSitePermission_ensures(s: PageRequests, request: int)
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysRequestIdsAreIssuedOnce(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysOneAtATimeKindsWaitAlone(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysOutcomeFitsItsKind(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysAnOpenPickerServesItsRequest(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> stepOnlyAHeldRequestIsReported(s, "withdrawSitePermission", withdrawSitePermission(s, request).state, withdrawSitePermission(s, request).out))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "withdrawSitePermission", withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> stepRequestsAreNeverForgotten(s, withdrawSitePermission(s, request).state))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "withdrawSitePermission", withdrawSitePermission(s, request).state, withdrawSitePermission(s, request).out))
  ensures (inv(s) ==> canWithdrawSitePermission(s, request) ==> stepGrantFollowsMyGrantAndAndroid(s, "withdrawSitePermission", withdrawSitePermission(s, request).state))
{
  if inv(s) && canWithdrawSitePermission(s, request) {
    WithdrawSitePermissionBridge(s, request);
    var after := withdrawSitePermission(s, request);
    RequestsNeverForgotten(s, after.state);
    StepWithdrawnBridge(s, "withdrawSitePermission", after.state, after.out);
    var p1 := (r: PageRequest) => (r.id == request);
    var p2 := (r: PageRequest) => ((r.status == typed0_os__browser__surface__pageRequests(PermissionAnswered(PermissionAnswer.Ended))) && (exists b :: b in s.requests && ((b.id == r.id) && active(b.status))));
    WithdrawnBridge(ProofLib.Filter(p1, s.requests));
    AllWithdrawalsKept(after.out);
    forall i | 0 <= i < |s.requests|
      ensures (p1(s.requests[i]) && s.requests[i].kind.SitePermission?) == (p2(after.state.requests[i]) && after.state.requests[i].kind.SitePermission?)
    {
      var r := s.requests[i];
      var r2 := after.state.requests[i];
      if p2(r2) && r2.kind.SitePermission? {
        var b :| b in s.requests && b.id == r2.id && active(b.status);
        assert b == r;
        assert r.id == request;
      }
      if r.id == request {
        var target :| target in s.requests && target.id == request && target.kind.SitePermission? && active(target.status);
        assert r == target;
      }
    }
    WithdrawnFilterSeqEq(p1, p2, s.requests, after.state.requests);
  }
}

lemma learnSupport_ensures(s: PageRequests, isolatedRenderer: bool, multiProfile: bool)
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysRequestIdsAreIssuedOnce(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysOneAtATimeKindsWaitAlone(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysOutcomeFitsItsKind(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysAnOpenPickerServesItsRequest(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepOnlyAHeldRequestIsReported(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile).state, learnSupport(s, isolatedRenderer, multiProfile).out))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepRequestsAreNeverForgotten(s, learnSupport(s, isolatedRenderer, multiProfile).state))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile).state, learnSupport(s, isolatedRenderer, multiProfile).out))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepGrantFollowsMyGrantAndAndroid(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile).state))
{
  if inv(s) && canLearnSupport(s) {
    EndUnheldPreserves(os__browser__surface__lifecycle_learnSupport(s.host, isolatedRenderer, multiProfile), s, "learnSupport");
  }
}

lemma reconcileOwner_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, desiredIds: seq<string>)
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysRequestIdsAreIssuedOnce(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysOneAtATimeKindsWaitAlone(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysOutcomeFitsItsKind(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysAnOpenPickerServesItsRequest(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepOnlyAHeldRequestIsReported(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds).state, reconcileOwner(s, realm, desiredIds).out))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepRequestsAreNeverForgotten(s, reconcileOwner(s, realm, desiredIds).state))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds).state, reconcileOwner(s, realm, desiredIds).out))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepGrantFollowsMyGrantAndAndroid(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds).state))
{
  if inv(s) && canReconcileOwner(s, realm, desiredIds) {
    EndUnheldPreserves(os__browser__surface__lifecycle_reconcileOwner(s.host, realm, desiredIds), s, "reconcileOwner");
  }
}

lemma createSurface_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, policy: os__browser__surface__lifecycle_SurfacePolicy, url: string)
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysRequestIdsAreIssuedOnce(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysOneAtATimeKindsWaitAlone(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysOutcomeFitsItsKind(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysAnOpenPickerServesItsRequest(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> stepOnlyAHeldRequestIsReported(s, "createSurface", createSurface(s, realm, id, policy, url).state, createSurface(s, realm, id, policy, url).out))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "createSurface", createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> stepRequestsAreNeverForgotten(s, createSurface(s, realm, id, policy, url).state))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "createSurface", createSurface(s, realm, id, policy, url).state, createSurface(s, realm, id, policy, url).out))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url) ==> stepGrantFollowsMyGrantAndAndroid(s, "createSurface", createSurface(s, realm, id, policy, url).state))
{
  if inv(s) && canCreateSurface(s, realm, id, policy, url) {
    EndUnheldPreserves(os__browser__surface__lifecycle_createSurface(s.host, realm, id, policy, url), s, "createSurface");
  }
}

lemma presentSurface_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysRequestIdsAreIssuedOnce(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysOneAtATimeKindsWaitAlone(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysOutcomeFitsItsKind(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysAnOpenPickerServesItsRequest(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepOnlyAHeldRequestIsReported(s, "presentSurface", presentSurface(s, realm, id).state, presentSurface(s, realm, id).out))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "presentSurface", presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepRequestsAreNeverForgotten(s, presentSurface(s, realm, id).state))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "presentSurface", presentSurface(s, realm, id).state, presentSurface(s, realm, id).out))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepGrantFollowsMyGrantAndAndroid(s, "presentSurface", presentSurface(s, realm, id).state))
{
  if inv(s) && canPresentSurface(s, realm, id) {
    EndUnheldPreserves(os__browser__surface__lifecycle_presentSurface(s.host, realm, id), s, "presentSurface");
  }
}

lemma pauseSurface_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysRequestIdsAreIssuedOnce(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysOneAtATimeKindsWaitAlone(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysOutcomeFitsItsKind(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysAnOpenPickerServesItsRequest(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepOnlyAHeldRequestIsReported(s, "pauseSurface", pauseSurface(s, realm, id).state, pauseSurface(s, realm, id).out))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "pauseSurface", pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepRequestsAreNeverForgotten(s, pauseSurface(s, realm, id).state))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "pauseSurface", pauseSurface(s, realm, id).state, pauseSurface(s, realm, id).out))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepGrantFollowsMyGrantAndAndroid(s, "pauseSurface", pauseSurface(s, realm, id).state))
{
  if inv(s) && canPauseSurface(s, realm, id) {
    EndUnheldPreserves(os__browser__surface__lifecycle_pauseSurface(s.host, realm, id), s, "pauseSurface");
  }
}

lemma resumeSurface_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysRequestIdsAreIssuedOnce(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysOneAtATimeKindsWaitAlone(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysOutcomeFitsItsKind(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysAnOpenPickerServesItsRequest(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepOnlyAHeldRequestIsReported(s, "resumeSurface", resumeSurface(s, realm, id).state, resumeSurface(s, realm, id).out))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "resumeSurface", resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepRequestsAreNeverForgotten(s, resumeSurface(s, realm, id).state))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "resumeSurface", resumeSurface(s, realm, id).state, resumeSurface(s, realm, id).out))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepGrantFollowsMyGrantAndAndroid(s, "resumeSurface", resumeSurface(s, realm, id).state))
{
  if inv(s) && canResumeSurface(s, realm, id) {
    EndUnheldPreserves(os__browser__surface__lifecycle_resumeSurface(s.host, realm, id), s, "resumeSurface");
  }
}

lemma destroySurface_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysRequestIdsAreIssuedOnce(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysOneAtATimeKindsWaitAlone(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysOutcomeFitsItsKind(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysAnOpenPickerServesItsRequest(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepOnlyAHeldRequestIsReported(s, "destroySurface", destroySurface(s, realm, id).state, destroySurface(s, realm, id).out))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "destroySurface", destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepRequestsAreNeverForgotten(s, destroySurface(s, realm, id).state))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "destroySurface", destroySurface(s, realm, id).state, destroySurface(s, realm, id).out))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepGrantFollowsMyGrantAndAndroid(s, "destroySurface", destroySurface(s, realm, id).state))
{
  if inv(s) && canDestroySurface(s, realm, id) {
    EndUnheldPreserves(os__browser__surface__lifecycle_destroySurface(s.host, realm, id), s, "destroySurface");
  }
}

lemma answerSitePermission_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int, grant: bool)
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysRequestIdsAreIssuedOnce(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysOneAtATimeKindsWaitAlone(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysOutcomeFitsItsKind(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysAnOpenPickerServesItsRequest(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> stepOnlyAHeldRequestIsReported(s, "answerSitePermission", answerSitePermission(s, realm, id, request, grant), []))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "answerSitePermission", answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> stepRequestsAreNeverForgotten(s, answerSitePermission(s, realm, id, request, grant)))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "answerSitePermission", answerSitePermission(s, realm, id, request, grant), []))
  ensures (inv(s) ==> canAnswerSitePermission(s, realm, id, request, grant) ==> stepGrantFollowsMyGrantAndAndroid(s, "answerSitePermission", answerSitePermission(s, realm, id, request, grant)))
{
  if inv(s) && canAnswerSitePermission(s, realm, id, request, grant) {
    var after := answerSitePermission(s, realm, id, request, grant);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "answerSitePermission", after, []);
  }
}

lemma androidAnswered_ensures(s: PageRequests, request: int, reply: AndroidReply)
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysRequestIdsAreIssuedOnce(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysOneAtATimeKindsWaitAlone(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysOutcomeFitsItsKind(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysAnOpenPickerServesItsRequest(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> stepOnlyAHeldRequestIsReported(s, "androidAnswered", androidAnswered(s, request, reply), []))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "androidAnswered", androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> stepRequestsAreNeverForgotten(s, androidAnswered(s, request, reply)))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "androidAnswered", androidAnswered(s, request, reply), []))
  ensures (inv(s) ==> canAndroidAnswered(s, request) ==> stepGrantFollowsMyGrantAndAndroid(s, "androidAnswered", androidAnswered(s, request, reply)))
{
  if inv(s) && canAndroidAnswered(s, request) {
    var after := androidAnswered(s, request, reply);
    RequestsNeverForgotten(s, after);
    StepWithdrawnBridge(s, "androidAnswered", after, []);
    NoWithdrawals([]);
  }
}

lemma answerFileChooser_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int, open: bool)
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysRequestIdsAreIssuedOnce(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysOneAtATimeKindsWaitAlone(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysOutcomeFitsItsKind(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysAnOpenPickerServesItsRequest(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> stepOnlyAHeldRequestIsReported(s, "answerFileChooser", answerFileChooser(s, realm, id, request, open), []))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "answerFileChooser", answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> stepRequestsAreNeverForgotten(s, answerFileChooser(s, realm, id, request, open)))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "answerFileChooser", answerFileChooser(s, realm, id, request, open), []))
  ensures (inv(s) ==> canAnswerFileChooser(s, realm, id, request, open) ==> stepGrantFollowsMyGrantAndAndroid(s, "answerFileChooser", answerFileChooser(s, realm, id, request, open)))
{
  if inv(s) && canAnswerFileChooser(s, realm, id, request, open) {
    var after := answerFileChooser(s, realm, id, request, open);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "answerFileChooser", after, []);
  }
}

lemma pickerReturned_ensures(s: PageRequests, picked: bool)
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysRequestIdsAreIssuedOnce(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysOneAtATimeKindsWaitAlone(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysOutcomeFitsItsKind(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysAnOpenPickerServesItsRequest(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> stepOnlyAHeldRequestIsReported(s, "pickerReturned", pickerReturned(s, picked), []))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "pickerReturned", pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> stepRequestsAreNeverForgotten(s, pickerReturned(s, picked)))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "pickerReturned", pickerReturned(s, picked), []))
  ensures (inv(s) ==> canPickerReturned(s, picked) ==> stepGrantFollowsMyGrantAndAndroid(s, "pickerReturned", pickerReturned(s, picked)))
{
  hide *;
  reveal inv, canPickerReturned, pickerReturned, pickerRequest, active, answerStep, fitsKind, shownOnly, oneAtATime, isWithdrawal, typed0_os__browser__surface__pageRequests, typed1_os__browser__surface__pageRequests, alwaysHeldRequestsAreOnSurfacesThatMayHoldThem, alwaysRequestIdsAreIssuedOnce, alwaysOneAtATimeKindsWaitAlone, alwaysOutcomeFitsItsKind, alwaysAnOpenPickerServesItsRequest, alwaysASaveRunsOnlyWhileItsSurfaceIsOpen, stepOnlyAHeldRequestIsReported, stepEveryOutcomeIsItsAnswerOrAnEnding, stepGrantFollowsMyGrantAndAndroid;
  if inv(s) && canPickerReturned(s, picked) {
    var after := pickerReturned(s, picked);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "pickerReturned", after, []);
  }
}

lemma saveDownload_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int)
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysRequestIdsAreIssuedOnce(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysOneAtATimeKindsWaitAlone(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysOutcomeFitsItsKind(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysAnOpenPickerServesItsRequest(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> stepOnlyAHeldRequestIsReported(s, "saveDownload", saveDownload(s, realm, id, request), []))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "saveDownload", saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> stepRequestsAreNeverForgotten(s, saveDownload(s, realm, id, request)))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "saveDownload", saveDownload(s, realm, id, request), []))
  ensures (inv(s) ==> canSaveDownload(s, realm, id, request) ==> stepGrantFollowsMyGrantAndAndroid(s, "saveDownload", saveDownload(s, realm, id, request)))
{
  if inv(s) && canSaveDownload(s, realm, id, request) {
    var after := saveDownload(s, realm, id, request);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "saveDownload", after, []);
  }
}

lemma downloadFinished_ensures(s: PageRequests, request: int, published: bool)
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysRequestIdsAreIssuedOnce(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysOneAtATimeKindsWaitAlone(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysOutcomeFitsItsKind(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysAnOpenPickerServesItsRequest(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> stepOnlyAHeldRequestIsReported(s, "downloadFinished", downloadFinished(s, request, published).state, downloadFinished(s, request, published).out))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "downloadFinished", downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> stepRequestsAreNeverForgotten(s, downloadFinished(s, request, published).state))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "downloadFinished", downloadFinished(s, request, published).state, downloadFinished(s, request, published).out))
  ensures (inv(s) ==> canDownloadFinished(s, request, published) ==> stepGrantFollowsMyGrantAndAndroid(s, "downloadFinished", downloadFinished(s, request, published).state))
{
  hide *;
  reveal inv, canDownloadFinished, setStatus, active, answerStep, fitsKind, shownOnly, oneAtATime, isWithdrawal, typed0_os__browser__surface__pageRequests, typed1_os__browser__surface__pageRequests, alwaysHeldRequestsAreOnSurfacesThatMayHoldThem, alwaysRequestIdsAreIssuedOnce, alwaysOneAtATimeKindsWaitAlone, alwaysOutcomeFitsItsKind, alwaysAnOpenPickerServesItsRequest, alwaysASaveRunsOnlyWhileItsSurfaceIsOpen, stepOnlyAHeldRequestIsReported, stepEveryOutcomeIsItsAnswerOrAnEnding, stepGrantFollowsMyGrantAndAndroid;
  if inv(s) && canDownloadFinished(s, request, published) {
    DownloadFinishedBridge(s, request, published);
    var after := downloadFinished(s, request, published);
    RequestsNeverForgotten(s, after.state);
    NoEndedPermissions(s, "downloadFinished", after.state, after.out);
  }
}

lemma openExternalLink_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int, found: bool)
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysRequestIdsAreIssuedOnce(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysOneAtATimeKindsWaitAlone(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysOutcomeFitsItsKind(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysAnOpenPickerServesItsRequest(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> stepOnlyAHeldRequestIsReported(s, "openExternalLink", openExternalLink(s, realm, id, request, found), []))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "openExternalLink", openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> stepRequestsAreNeverForgotten(s, openExternalLink(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "openExternalLink", openExternalLink(s, realm, id, request, found), []))
  ensures (inv(s) ==> canOpenExternalLink(s, realm, id, request, found) ==> stepGrantFollowsMyGrantAndAndroid(s, "openExternalLink", openExternalLink(s, realm, id, request, found)))
{
  if inv(s) && canOpenExternalLink(s, realm, id, request, found) {
    var after := openExternalLink(s, realm, id, request, found);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "openExternalLink", after, []);
  }
}

lemma openIdentityProvider_ensures(s: PageRequests, realm: os__browser__surface__lifecycle_Realm, id: string, request: int, found: bool)
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysRequestIdsAreIssuedOnce(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysOneAtATimeKindsWaitAlone(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysOutcomeFitsItsKind(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysAnOpenPickerServesItsRequest(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> alwaysASaveRunsOnlyWhileItsSurfaceIsOpen(openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> stepOnlyAHeldRequestIsReported(s, "openIdentityProvider", openIdentityProvider(s, realm, id, request, found), []))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> stepEveryOutcomeIsItsAnswerOrAnEnding(s, "openIdentityProvider", openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> stepRequestsAreNeverForgotten(s, openIdentityProvider(s, realm, id, request, found)))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> stepEndedPermissionsAreWithdrawnBeforeTheStart(s, "openIdentityProvider", openIdentityProvider(s, realm, id, request, found), []))
  ensures (inv(s) ==> canOpenIdentityProvider(s, realm, id, request, found) ==> stepGrantFollowsMyGrantAndAndroid(s, "openIdentityProvider", openIdentityProvider(s, realm, id, request, found)))
{
  if inv(s) && canOpenIdentityProvider(s, realm, id, request, found) {
    var after := openIdentityProvider(s, realm, id, request, found);
    RequestsNeverForgotten(s, after);
    NoEndedPermissions(s, "openIdentityProvider", after, []);
  }
}
