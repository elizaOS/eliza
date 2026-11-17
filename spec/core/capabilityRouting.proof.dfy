lemma ReqUnique(s: Routing)
  ensures alwaysRequestIdentitiesUnique(s) <==> (forall i :: 0 <= i < |s.requests| ==> s.requests[i].id > 0) && ProofLib.DistinctBy(s.requests, (r: RouteRequest) => r.id)
{
  var key := (r: RouteRequest) => r.id;
  forall i | 0 <= i < |s.requests|
    ensures |ProofLib.Filter((other: RouteRequest) => (other.id == s.requests[i].id), s.requests)| == 1 <==> forall j :: 0 <= j < |s.requests| && j != i ==> key(s.requests[j]) != key(s.requests[i])
  {
    ProofLib.FilterCountOneIffUnique((other: RouteRequest) => (other.id == s.requests[i].id), s.requests, key, i);
  }
}

lemma AccUnique(s: Routing)
  ensures alwaysHeldAccountIdsAreDistinct(s) <==> (forall i :: 0 <= i < |s.accounts| ==> s.accounts[i].id != "") && ProofLib.DistinctBy(s.accounts, (a: HeldAccount) => a.id)
{
  var key := (a: HeldAccount) => a.id;
  forall i | 0 <= i < |s.accounts|
    ensures |ProofLib.Filter((x: HeldAccount) => (x.id == s.accounts[i].id), s.accounts)| == 1 <==> forall j :: 0 <= j < |s.accounts| && j != i ==> key(s.accounts[j]) != key(s.accounts[i])
  {
    ProofLib.FilterCountOneIffUnique((x: HeldAccount) => (x.id == s.accounts[i].id), s.accounts, key, i);
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

lemma RequestAt(s: Routing, id: int, i: int)
  requires alwaysRequestIdentitiesUnique(s) && 0 <= i < |s.requests| && s.requests[i].id == id
  ensures requestAt(s, id) == s.requests[i]
  ensures forall j :: 0 <= j < |s.requests| && j != i ==> s.requests[j].id != id
{
  ReqUnique(s);
  FirstFilter((r: RouteRequest) => (r.id == id), s.requests, i);
}

lemma CheapestFold(xs: seq<HeldAccount>)
  requires |xs| > 0 && forall i :: 0 <= i < |xs| ==> xs[i].id != ""
  ensures exists k :: 0 <= k < |xs| && Std.Collections.Seq.FoldLeft((best: HeldAccount, a: HeldAccount) => (if ((best.id == "") || (a.cost < best.cost)) then a else best), noAccount, xs) == xs[k] && (forall j :: 0 <= j < |xs| ==> xs[k].cost <= xs[j].cost) && (forall j :: 0 <= j < k ==> xs[j].cost > xs[k].cost)
  decreases |xs|
{
  var f := (best: HeldAccount, a: HeldAccount) => (if ((best.id == "") || (a.cost < best.cost)) then a else best);
  var ys := xs[..|xs| - 1];
  var x := xs[|xs| - 1];
  assert xs == ys + [x];
  ProofLib.FoldLeftAppend(f, noAccount, ys, x);
  if |ys| == 0 {
    assert Std.Collections.Seq.FoldLeft(f, noAccount, ys) == noAccount;
  } else {
    CheapestFold(ys);
    var k :| 0 <= k < |ys| && Std.Collections.Seq.FoldLeft(f, noAccount, ys) == ys[k] && (forall j :: 0 <= j < |ys| ==> ys[k].cost <= ys[j].cost) && (forall j :: 0 <= j < k ==> ys[j].cost > ys[k].cost);
    if x.cost < ys[k].cost {
      assert Std.Collections.Seq.FoldLeft(f, noAccount, xs) == xs[|xs| - 1];
    } else {
      assert Std.Collections.Seq.FoldLeft(f, noAccount, xs) == xs[k];
    }
  }
}

lemma CheapestChoice(s: Routing, acct: string)
  requires alwaysHeldAccountIdsAreDistinct(s) && acct == cheapest(eligible(s)) && acct != ""
  ensures isEligible(s, acct)
  ensures forall e :: e in eligible(s) ==> accountCost(s, acct) <= e.cost
  ensures |ProofLib.Filter((e: HeldAccount) => (e.cost == accountCost(s, acct)), eligible(s))| > 0
  ensures ProofLib.Filter((e: HeldAccount) => (e.cost == accountCost(s, acct)), eligible(s))[0].id == acct
{
  var es := eligible(s);
  var q := (a: HeldAccount) => (a.status in core__accountValues_connectedOnly);
  AccUnique(s);
  forall e | e in es ensures e in s.accounts {
    ProofLib.FilterMember(q, s.accounts, e);
  }
  if |es| == 0 {
    assert cheapest(es) == "";
  }
  CheapestFold(es);
  var k :| 0 <= k < |es| && Std.Collections.Seq.FoldLeft((best: HeldAccount, a: HeldAccount) => (if ((best.id == "") || (a.cost < best.cost)) then a else best), noAccount, es) == es[k] && (forall j :: 0 <= j < |es| ==> es[k].cost <= es[j].cost) && (forall j :: 0 <= j < k ==> es[j].cost > es[k].cost);
  var r := es[k];
  assert r.id == acct && r in es && r in s.accounts;
  var m :| 0 <= m < |s.accounts| && s.accounts[m] == r;
  FirstFilter((x: HeldAccount) => (x.id == acct), s.accounts, m);
  assert accountCost(s, acct) == r.cost;
  FirstFilter((e: HeldAccount) => (e.cost == accountCost(s, acct)), es, k);
}

lemma route_ensures(s: Routing, id: int, pinned: string, localAvailable: bool, remoteAvailable: bool)
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> alwaysRunningRequestHasARunner(route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> alwaysHeldAccountIdsAreDistinct(route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> alwaysPinnedAccountIsNeverSubstituted(route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> alwaysFailureIsTyped(route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> alwaysRequestIdentitiesUnique(route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> stepRunnerIsChosenOnce(s, route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> stepWorkUsesAHeldConnectedAccount(s, route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> stepUnpinnedRouteChoosesCheapest(s, "route", route(s, id, pinned, localAvailable, remoteAvailable)))
  ensures (inv(s) ==> canRoute(s, id, pinned, localAvailable, remoteAvailable) ==> stepSettledRequestKeepsItsOutcome(s, route(s, id, pinned, localAvailable, remoteAvailable)))
{
  if inv(s) && canRoute(s, id, pinned, localAvailable, remoteAvailable) {
    var after := route(s, id, pinned, localAvailable, remoteAvailable);
    var nr := after.requests[|s.requests|];
    assert after.requests == s.requests + [nr];
    assert nr.id == id;
    var acct := chosenAccount(s, pinned);
    if pinned == "" && acct != "" {
      CheapestChoice(s, acct);
    }
    ReqUnique(s);
    ProofLib.DistinctByConcat(s.requests, [nr], (r: RouteRequest) => r.id);
    ReqUnique(after);
  }
}

lemma connectAccount_ensures(s: Routing, accountId: string, cost: int)
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> alwaysRunningRequestHasARunner(connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> alwaysHeldAccountIdsAreDistinct(connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> alwaysPinnedAccountIsNeverSubstituted(connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> alwaysFailureIsTyped(connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> alwaysRequestIdentitiesUnique(connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> stepRunnerIsChosenOnce(s, connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> stepWorkUsesAHeldConnectedAccount(s, connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> stepUnpinnedRouteChoosesCheapest(s, "connectAccount", connectAccount(s, accountId, cost)))
  ensures (inv(s) ==> canConnectAccount(s, accountId, cost) ==> stepSettledRequestKeepsItsOutcome(s, connectAccount(s, accountId, cost)))
{
  if inv(s) && canConnectAccount(s, accountId, cost) {
    var after := connectAccount(s, accountId, cost);
    AccUnique(s);
    ProofLib.DistinctByConcat(s.accounts, [HeldAccount(accountId, core__accountValues_AccountStatus.AccountConnected, cost)], (a: HeldAccount) => a.id);
    AccUnique(after);
  }
}

lemma setAccountStatus_ensures(s: Routing, accountId: string, status: core__accountValues_AccountStatus)
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> alwaysRunningRequestHasARunner(setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> alwaysHeldAccountIdsAreDistinct(setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> alwaysPinnedAccountIsNeverSubstituted(setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> alwaysFailureIsTyped(setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> alwaysRequestIdentitiesUnique(setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> stepRunnerIsChosenOnce(s, setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> stepWorkUsesAHeldConnectedAccount(s, setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> stepUnpinnedRouteChoosesCheapest(s, "setAccountStatus", setAccountStatus(s, accountId, status)))
  ensures (inv(s) ==> canSetAccountStatus(s, accountId, status) ==> stepSettledRequestKeepsItsOutcome(s, setAccountStatus(s, accountId, status)))
{
  if inv(s) {
    var after := setAccountStatus(s, accountId, status);
    AccUnique(s);
    assert forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id;
    AccUnique(after);
  }
}

lemma releaseAccount_ensures(s: Routing, accountId: string)
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> alwaysRunningRequestHasARunner(releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> alwaysHeldAccountIdsAreDistinct(releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> alwaysPinnedAccountIsNeverSubstituted(releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> alwaysFailureIsTyped(releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> alwaysRequestIdentitiesUnique(releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> stepRunnerIsChosenOnce(s, releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> stepWorkUsesAHeldConnectedAccount(s, releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> stepUnpinnedRouteChoosesCheapest(s, "releaseAccount", releaseAccount(s, accountId)))
  ensures (inv(s) ==> canReleaseAccount(s, accountId) ==> stepSettledRequestKeepsItsOutcome(s, releaseAccount(s, accountId)))
{
  if inv(s) {
    var after := releaseAccount(s, accountId);
    var p := (a: HeldAccount) => (a.id != accountId);
    AccUnique(s);
    ProofLib.FilterKeepsDistinctBy(p, s.accounts, (a: HeldAccount) => a.id);
    forall a | a in after.accounts ensures a in s.accounts {
      ProofLib.FilterMember(p, s.accounts, a);
    }
    AccUnique(after);
  }
}

lemma start_ensures(s: Routing, id: int)
  ensures (inv(s) ==> canStart(s, id) ==> alwaysRunningRequestHasARunner(start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> alwaysHeldAccountIdsAreDistinct(start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> alwaysPinnedAccountIsNeverSubstituted(start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> alwaysFailureIsTyped(start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> alwaysRequestIdentitiesUnique(start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> stepRunnerIsChosenOnce(s, start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> stepWorkUsesAHeldConnectedAccount(s, start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> stepUnpinnedRouteChoosesCheapest(s, "start", start(s, id)))
  ensures (inv(s) ==> canStart(s, id) ==> stepSettledRequestKeepsItsOutcome(s, start(s, id)))
{
  if inv(s) && canStart(s, id) {
    var after := start(s, id);
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].id == id;
    RequestAt(s, id, i0);
    Rewritten(s, after, i0);
    assert after.requests[i0].phase.Running? ==> isEligible(s, after.requests[i0].account);
  }
}

lemma finish_ensures(s: Routing, id: int, ok: bool, reachable: bool)
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> alwaysRunningRequestHasARunner(finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> alwaysHeldAccountIdsAreDistinct(finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> alwaysPinnedAccountIsNeverSubstituted(finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> alwaysFailureIsTyped(finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> alwaysRequestIdentitiesUnique(finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> stepRunnerIsChosenOnce(s, finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> stepWorkUsesAHeldConnectedAccount(s, finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> stepUnpinnedRouteChoosesCheapest(s, "finish", finish(s, id, ok, reachable)))
  ensures (inv(s) ==> canFinish(s, id, ok, reachable) ==> stepSettledRequestKeepsItsOutcome(s, finish(s, id, ok, reachable)))
{
  if inv(s) && canFinish(s, id, ok, reachable) {
    var after := finish(s, id, ok, reachable);
    var i0 :| 0 <= i0 < |s.requests| && s.requests[i0].id == id;
    RequestAt(s, id, i0);
    Rewritten(s, after, i0);
  }
}

lemma Rewritten(s: Routing, after: Routing, i0: int)
  requires alwaysRequestIdentitiesUnique(s) && alwaysRunningRequestHasARunner(s)
  requires 0 <= i0 < |s.requests| && |after.requests| == |s.requests|
  requires s.requests[i0].phase.Routed? || s.requests[i0].phase.Running?
  requires forall j :: 0 <= j < |s.requests| && j != i0 ==> after.requests[j] == s.requests[j]
  requires after.requests[i0].id == s.requests[i0].id && after.requests[i0].runner == s.requests[i0].runner && after.requests[i0].account == s.requests[i0].account
  requires !after.requests[i0].phase.Routed?
  ensures alwaysRequestIdentitiesUnique(after)
  ensures alwaysRunningRequestHasARunner(after)
  ensures stepRunnerIsChosenOnce(s, after)
  ensures stepSettledRequestKeepsItsOutcome(s, after)
  ensures forall a :: a in after.requests && a != after.requests[i0] ==> a in s.requests
{
  ReqUnique(s);
  ReqUnique(after);
  forall b | b in s.requests ensures exists a :: a in after.requests && a.id == b.id && a.runner == b.runner {
    var i :| 0 <= i < |s.requests| && s.requests[i] == b;
    assert after.requests[i].id == b.id && after.requests[i].runner == b.runner;
  }
  forall b | b in s.requests && (b.phase.Succeeded? || b.phase.RouteFailed?) ensures b in after.requests {
    var i :| 0 <= i < |s.requests| && s.requests[i] == b;
    assert after.requests[i] == b;
  }
  forall a | a in after.requests && a != after.requests[i0] ensures a in s.requests {
    var i :| 0 <= i < |after.requests| && after.requests[i] == a;
    assert s.requests[i] == a;
  }
}
