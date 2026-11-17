lemma dispatchHandoff_ensures(s: Navigation, id: string, handledByShell: bool, handlerNavigates: bool, pathAfterHandler: string)
  ensures (inv(s) ==> alwaysBoundedNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysUniqueNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewClaimsNumbered(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewQueueDistinct(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysAdmittedCountNeverNegative(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewQueueBounded(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewClaimResolvedOnce(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysQueuedViewRequestsWait(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysOnlyMountedListenersHoldRequests(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
{
  if inv(s) {
    var prior := pendingAt(s, id);
    var stale := id != "" && prior.id == id && (prior.epoch != s.epoch || prior.path != s.path);
    var refused := s.windowId == "" || (id != "" && id in s.handled) || stale;
    var observed := s.(lastId := id, lastEmitted := !refused);
    var delivered := if handlerNavigates && !refused then observed.(epoch := s.epoch + 1, path := pathAfterHandler) else observed;
    if stale {
      NavigationHandle(observed, id);
    } else if !refused && id != "" {
      if handledByShell { NavigationHandle(delivered, id); }
      else if prior.id == "" { NavigationRemember(delivered, PendingHandoff(id, s.epoch, s.path)); }
    }
    assert dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler).views == s.views;
  }
}

lemma NavigationHandledDistinct(ids: seq<string>)
  ensures ProofLib.DistinctBy(ids, (item: string) => item) <==> (forall id :: id in ids ==> |ProofLib.Filter((other: string) => other == id, ids)| == 1)
{
  var key := (value: string) => value;
  if ProofLib.DistinctBy(ids, key) {
    forall id | id in ids ensures |ProofLib.Filter((other: string) => other == id, ids)| == 1 {
      var i :| 0 <= i < |ids| && ids[i] == id;
      ProofLib.FilterCountOneIffUnique((other: string) => other == id, ids, key, i);
    }
  } else if forall id :: id in ids ==> |ProofLib.Filter((other: string) => other == id, ids)| == 1 {
    forall i, j | 0 <= i < |ids| && 0 <= j < |ids| && i != j ensures ids[i] != ids[j] {
      assert ids[i] in ids;
      var p := (other: string) => other == ids[i];
      assert |ProofLib.Filter(p, ids)| == 1;
      ProofLib.FilterCountOneIffUnique(p, ids, key, i);
    }
  }
}

lemma NavigationPendingDistinct(rows: seq<PendingHandoff>)
  ensures ProofLib.DistinctBy(rows, (item: PendingHandoff) => item.id) <==> (forall row :: row in rows ==> |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1)
{
  var key := (row: PendingHandoff) => row.id;
  if ProofLib.DistinctBy(rows, key) {
    forall row | row in rows ensures |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterCountOneIffUnique((other: PendingHandoff) => other.id == row.id, rows, key, i);
    }
  } else if forall row :: row in rows ==> |ProofLib.Filter((other: PendingHandoff) => other.id == row.id, rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].id != rows[j].id {
      assert rows[i] in rows;
      var p := (other: PendingHandoff) => other.id == rows[i].id;
      assert |ProofLib.Filter(p, rows)| == 1;
      ProofLib.FilterCountOneIffUnique(p, rows, key, i);
    }
  }
}

lemma NavigationHandle(s: Navigation, id: string)
  requires alwaysUniqueNavigationIndexes(s)
  ensures alwaysUniqueNavigationIndexes(rememberHandled(id, s))
{
  var after := rememberHandled(id, s);
  NavigationHandledDistinct(s.handled);
  NavigationPendingDistinct(s.pending);
  var keepHandled := (other: string) => other != id;
  var keepPending := (other: PendingHandoff) => other.id != id;
  var source := ProofLib.Filter(keepHandled, s.handled);
  ProofLib.FilterKeepsDistinctBy(keepPending, s.pending, (row: PendingHandoff) => row.id);
  ProofLib.FilterKeepsDistinctBy(keepHandled, s.handled, (value: string) => value);
  ProofLib.FilterMember(keepHandled, s.handled, id);
  ProofLib.DistinctByConcat(source, [id], (value: string) => value);
  NavigationDropOneKeepsKeys(source + [id], after.handled, (value: string) => value);
  NavigationPendingDistinct(after.pending);
  NavigationHandledDistinct(after.handled);
  forall row | row in after.pending ensures row.id !in after.handled {
    ProofLib.FilterMember(keepPending, s.pending, row);
    if row.id in after.handled {
      assert row.id in source + [id];
      ProofLib.FilterMember(keepHandled, s.handled, row.id);
    }
  }
}

lemma NavigationRemember(s: Navigation, entry: PendingHandoff)
  requires alwaysUniqueNavigationIndexes(s) && entry.id !in s.handled
  ensures alwaysUniqueNavigationIndexes(rememberPending(entry, s))
{
  var after := rememberPending(entry, s);
  NavigationPendingDistinct(s.pending);
  var keep := (prior: PendingHandoff) => prior.id != entry.id;
  var source := ProofLib.Filter(keep, s.pending);
  ProofLib.FilterKeepsDistinctBy(keep, s.pending, (row: PendingHandoff) => row.id);
  forall i | 0 <= i < |source| ensures source[i].id != entry.id {
    ProofLib.FilterMember(keep, s.pending, source[i]);
  }
  ProofLib.DistinctByConcat(source, [entry], (row: PendingHandoff) => row.id);
  NavigationDropOneKeepsKeys(source + [entry], after.pending, (row: PendingHandoff) => row.id);
  NavigationPendingDistinct(after.pending);
  forall row | row in after.pending && row != entry ensures row.id !in after.handled {
    assert row in source + [entry];
    ProofLib.FilterMember(keep, s.pending, row);
  }
}

lemma NavigationDropOneKeepsKeys<T, K>(rows: seq<T>, kept: seq<T>, key: T -> K)
  requires kept == rows || (|rows| > 0 && kept == rows[1..])
  requires ProofLib.DistinctBy(rows, key)
  ensures ProofLib.DistinctBy(kept, key)
{
  if kept != rows {
    forall i, j | 0 <= i < |kept| && 0 <= j < |kept| && i != j ensures key(kept[i]) != key(kept[j]) {
      assert kept[i] == rows[i+1] && kept[j] == rows[j+1];
    }
  }
}

lemma unmountListener_ensures(s: Navigation, listener: int)
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysBoundedNavigationIndexes(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysUniqueNavigationIndexes(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysViewClaimsNumbered(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysViewQueueDistinct(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysAdmittedCountNeverNegative(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysViewQueueBounded(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysViewClaimResolvedOnce(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysQueuedViewRequestsWait(unmountListener(s, listener)))
  ensures (inv(s) ==> canUnmountListener(s, listener) ==> alwaysOnlyMountedListenersHoldRequests(unmountListener(s, listener)))
{
  if inv(s) && canUnmountListener(s, listener) {
    var after := unmountListener(s, listener);
    assert |after.views.requests| == |s.views.requests|;
    forall i | 0 <= i < |s.views.requests|
      ensures after.views.requests[i].request == s.views.requests[i].request && waiting(after.views.requests[i]) == waiting(s.views.requests[i])
    {}
    ViewNumberedFilter(s); ViewNumberedFilter(after);
    forall c | c in after.views.requests
      ensures c.request >= 1 && c.request <= after.views.admitted && |ProofLib.Filter((other: ViewClaim) => (other.request == c.request), after.views.requests)| == 1
    {
      var i :| 0 <= i < |after.views.requests| && after.views.requests[i] == c;
      assert s.views.requests[i] in s.views.requests;
      ProofLib.FilterLengthPointwise((other: ViewClaim) => (other.request == c.request), (other: ViewClaim) => (other.request == c.request), s.views.requests, after.views.requests);
    }
    forall request | request in after.views.queue
      ensures waiting(claimAt(after.views, request))
    {
      ViewClaimsKeepWaiting(s.views, after.views, request);
    }
    ViewActiveAfterUnmount(s, listener);
    forall a | a in after.views.attempts && a.phase.Awaiting?
      ensures a.listener in after.views.active
    {
      var i :| 0 <= i < |after.views.attempts| && after.views.attempts[i] == a;
      assert s.views.attempts[i] in s.views.attempts;
      ProofLib.FilterMember((set_x: int) => !((set_x in [listener])), s.views.active, a.listener);
    }
  }
}

lemma ViewActiveAfterUnmount(s: Navigation, listener: int)
  ensures unmountListener(s, listener).views.active == ProofLib.Filter((set_x: int) => !((set_x in [listener])), s.views.active)
{}

lemma ViewNumberedFilter(s: Navigation)
  ensures alwaysViewClaimsNumbered(s) == ((forall c :: c in s.views.requests ==> c.request >= 1 && c.request <= s.views.admitted && |ProofLib.Filter((other: ViewClaim) => (other.request == c.request), s.views.requests)| == 1) && (forall request :: request in s.views.queue ==> request >= 1 && request <= s.views.admitted))
{}

lemma ViewClaimLookup(v: ViewClaims, request: int)
  ensures claimAt(v, request) == (if 0 < |ProofLib.Filter((c: ViewClaim) => (c.request == request), v.requests)| then ProofLib.Filter((c: ViewClaim) => (c.request == request), v.requests)[0] else emptyClaim)
{}

lemma ViewClaimsKeepWaiting(before: ViewClaims, after: ViewClaims, request: int)
  requires |before.requests| == |after.requests|
  requires forall i :: 0 <= i < |before.requests| ==> after.requests[i].request == before.requests[i].request && waiting(after.requests[i]) == waiting(before.requests[i])
  ensures waiting(claimAt(after, request)) == waiting(claimAt(before, request))
{
  ViewClaimLookup(before, request); ViewClaimLookup(after, request);
  ProofLib.FilterPointwise((c: ViewClaim) => (c.request == request), (c: ViewClaim) => (c.request == request), (x: ViewClaim, y: ViewClaim) => waiting(x) == waiting(y), before.requests, after.requests);
}

lemma ViewQueueFilter(s: Navigation)
  ensures alwaysViewQueueDistinct(s) == !((exists request :: request in s.views.queue && !((|ProofLib.Filter((other: int) => (other == request), s.views.queue)| == 1))))
{}

lemma ViewQueueDistinctBy(ids: seq<int>)
  ensures ProofLib.DistinctBy(ids, (item: int) => item) <==> (forall request :: request in ids ==> |ProofLib.Filter((other: int) => (other == request), ids)| == 1)
{
  var key := (item: int) => item;
  if ProofLib.DistinctBy(ids, key) {
    forall request | request in ids ensures |ProofLib.Filter((other: int) => (other == request), ids)| == 1 {
      var i :| 0 <= i < |ids| && ids[i] == request;
      ProofLib.FilterCountOneIffUnique((other: int) => (other == request), ids, key, i);
    }
  } else if forall request :: request in ids ==> |ProofLib.Filter((other: int) => (other == request), ids)| == 1 {
    forall i, j | 0 <= i < |ids| && 0 <= j < |ids| && i != j ensures ids[i] != ids[j] {
      assert ids[i] in ids;
      var p := (other: int) => (other == ids[i]);
      assert |ProofLib.Filter(p, ids)| == 1;
      ProofLib.FilterCountOneIffUnique(p, ids, key, i);
    }
  }
}

lemma ViewRequestsDistinct(rows: seq<ViewClaim>)
  ensures ProofLib.DistinctBy(rows, (item: ViewClaim) => item.request) <==> (forall c :: c in rows ==> |ProofLib.Filter((other: ViewClaim) => (other.request == c.request), rows)| == 1)
{
  var key := (item: ViewClaim) => item.request;
  if ProofLib.DistinctBy(rows, key) {
    forall c | c in rows ensures |ProofLib.Filter((other: ViewClaim) => (other.request == c.request), rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == c;
      ProofLib.FilterCountOneIffUnique((other: ViewClaim) => (other.request == c.request), rows, key, i);
    }
  } else if forall c :: c in rows ==> |ProofLib.Filter((other: ViewClaim) => (other.request == c.request), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].request != rows[j].request {
      assert rows[i] in rows;
      var p := (other: ViewClaim) => (other.request == rows[i].request);
      assert |ProofLib.Filter(p, rows)| == 1;
      ProofLib.FilterCountOneIffUnique(p, rows, key, i);
    }
  }
}

lemma ViewClaimIs(v: ViewClaims, r: int)
  ensures claimAt(v, r) == emptyClaim || (claimAt(v, r) in v.requests && claimAt(v, r).request == r)
  ensures ProofLib.DistinctBy(v.requests, (item: ViewClaim) => item.request) ==> forall i :: 0 <= i < |v.requests| && v.requests[i].request == r ==> claimAt(v, r) == v.requests[i]
{
  ViewClaimLookup(v, r);
  var found := ProofLib.Filter((c: ViewClaim) => (c.request == r), v.requests);
  if 0 < |found| { ProofLib.FilterMember((c: ViewClaim) => (c.request == r), v.requests, found[0]); }
  forall i | 0 <= i < |v.requests| && v.requests[i].request == r
    ensures 0 < |found| && found[0] in v.requests && found[0].request == r
  {
    ProofLib.FilterMember((c: ViewClaim) => (c.request == r), v.requests, v.requests[i]);
    ProofLib.FilterMember((c: ViewClaim) => (c.request == r), v.requests, found[0]);
  }
}

lemma ViewIndex(s: Navigation)
  ensures alwaysViewClaimsNumbered(s) <==> (ProofLib.DistinctBy(s.views.requests, (item: ViewClaim) => item.request) && (forall i :: 0 <= i < |s.views.requests| ==> 1 <= s.views.requests[i].request <= s.views.admitted) && (forall q :: q in s.views.queue ==> 1 <= q <= s.views.admitted))
  ensures alwaysViewQueueDistinct(s) <==> ProofLib.DistinctBy(s.views.queue, (item: int) => item)
  ensures alwaysViewClaimResolvedOnce(s) <==> forall i :: 0 <= i < |s.views.requests| ==> s.views.requests[i].resolutions == (if s.views.requests[i].resolution.ClaimPending? then 0 else 1)
  ensures ProofLib.DistinctBy(s.views.requests, (item: ViewClaim) => item.request) ==> (alwaysQueuedViewRequestsWait(s) <==> forall q :: q in s.views.queue ==> exists i :: 0 <= i < |s.views.requests| && s.views.requests[i].request == q && waiting(s.views.requests[i]))
{
  ViewNumberedFilter(s);
  ViewRequestsDistinct(s.views.requests);
  ViewQueueFilter(s);
  ViewQueueDistinctBy(s.views.queue);
  forall c | c in s.views.requests ensures exists i :: 0 <= i < |s.views.requests| && s.views.requests[i] == c {}
  forall i | 0 <= i < |s.views.requests| ensures s.views.requests[i] in s.views.requests {}
  forall q | q in s.views.queue ensures waiting(claimAt(s.views, q)) ==> exists i :: 0 <= i < |s.views.requests| && s.views.requests[i].request == q && waiting(s.views.requests[i]) {
    ViewClaimIs(s.views, q);
  }
  if ProofLib.DistinctBy(s.views.requests, (item: ViewClaim) => item.request) {
    forall q | q in s.views.queue && (exists i :: 0 <= i < |s.views.requests| && s.views.requests[i].request == q && waiting(s.views.requests[i]))
      ensures waiting(claimAt(s.views, q))
    {
      ViewClaimIs(s.views, q);
    }
  }
}

lemma ViewWithClaim(v: ViewClaims, r: int, claim: ViewClaim)
  requires ProofLib.DistinctBy(v.requests, (item: ViewClaim) => item.request)
  requires forall i :: 0 <= i < |v.requests| ==> v.requests[i].request >= 1
  requires claim.request == claimAt(v, r).request
  ensures |withClaim(v, claim).requests| == |v.requests|
  ensures forall i :: 0 <= i < |v.requests| ==> withClaim(v, claim).requests[i] == (if v.requests[i].request == r then claim else v.requests[i])
  ensures forall i :: 0 <= i < |v.requests| && v.requests[i].request == r ==> v.requests[i] == claimAt(v, r)
{
  ViewClaimIs(v, r);
}

lemma ViewStep(s: Navigation, after: Navigation, request: int, committed: bool)
  requires inv(s)
  requires after.views.admitted == s.views.admitted
  requires after.views.queue == (if committed then ProofLib.Filter((other: int) => (other != request), s.views.queue) else s.views.queue)
  requires |after.views.requests| == |s.views.requests|
  requires forall i :: 0 <= i < |s.views.requests| ==> after.views.requests[i].request == s.views.requests[i].request
  requires forall i :: 0 <= i < |s.views.requests| ==> after.views.requests[i].resolutions == (if after.views.requests[i].resolution.ClaimPending? then 0 else 1)
  requires forall i :: 0 <= i < |s.views.requests| && after.views.requests[i].request in after.views.queue ==> waiting(after.views.requests[i]) == waiting(s.views.requests[i])
  ensures alwaysViewClaimsNumbered(after) && alwaysViewQueueDistinct(after) && alwaysViewClaimResolvedOnce(after) && alwaysQueuedViewRequestsWait(after)
{
  ViewIndex(s);
  ViewIndex(after);
  forall q | q in after.views.queue ensures q in s.views.queue {
    if committed { ProofLib.FilterMember((other: int) => (other != request), s.views.queue, q); }
  }
  if committed { ProofLib.FilterKeepsDistinctBy((other: int) => (other != request), s.views.queue, (item: int) => item); }
}

lemma ViewCommit(v: ViewClaims, r: int, result: ClaimResolution)
  requires ProofLib.DistinctBy(v.requests, (item: ViewClaim) => item.request)
  requires forall i :: 0 <= i < |v.requests| ==> v.requests[i].request >= 1
  ensures commitClaim(v, r, result).queue == ProofLib.Filter((other: int) => (other != r), v.queue)
  ensures commitClaim(v, r, result).requests == withClaim(v, resolveClaim(claimAt(v, r), result).(claimed := true)).requests
  ensures r !in commitClaim(v, r, result).queue
{
  ProofLib.FilterMember((other: int) => (other != r), v.queue, r);
}

lemma returnFromListener_ensures(s: Navigation, attempt: int, verdict: ListenerOutcome)
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysBoundedNavigationIndexes(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysUniqueNavigationIndexes(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysViewClaimsNumbered(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysViewQueueDistinct(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysAdmittedCountNeverNegative(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysViewQueueBounded(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysViewClaimResolvedOnce(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysQueuedViewRequestsWait(returnFromListener(s, attempt, verdict)))
  ensures (inv(s) ==> canReturnFromListener(s, attempt) ==> alwaysOnlyMountedListenersHoldRequests(returnFromListener(s, attempt, verdict)))
{
  if inv(s) && canReturnFromListener(s, attempt) {
    ViewIndex(s);
    var a := attemptAt(s.views, attempt);
    var holding := verdict.ListenerPromised? && a.listener in s.views.active;
    var returned := withAttempt(s.views, a.(phase := (if holding then AttemptPhase.Awaiting else AttemptPhase.Settled)));
    var after := returnFromListener(s, attempt, verdict);
    if holding {
      ViewWithClaim(returned, a.request, claimAt(returned, a.request).(applying := true));
      ViewStep(s, after, a.request, false);
    } else if verdict.ListenerApplied? {
      ViewCommit(returned, a.request, ClaimResolution.ClaimApplied);
      ViewWithClaim(returned, a.request, resolveClaim(claimAt(returned, a.request), ClaimResolution.ClaimApplied).(claimed := true));
      ViewStep(s, after, a.request, true);
    } else {
      ViewStep(s, after, a.request, false);
    }
  }
}

lemma settleListener_ensures(s: Navigation, attempt: int, verdict: ListenerOutcome)
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysBoundedNavigationIndexes(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysUniqueNavigationIndexes(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysViewClaimsNumbered(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysViewQueueDistinct(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysAdmittedCountNeverNegative(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysViewQueueBounded(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysViewClaimResolvedOnce(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysQueuedViewRequestsWait(settleListener(s, attempt, verdict)))
  ensures (inv(s) ==> canSettleListener(s, attempt, verdict) ==> alwaysOnlyMountedListenersHoldRequests(settleListener(s, attempt, verdict)))
{
  if inv(s) && canSettleListener(s, attempt, verdict) {
    ViewIndex(s);
    var v := s.views;
    var a := attemptAt(v, attempt);
    var c := claimAt(v, a.request);
    var stillActive := a.listener in v.active;
    var declinedNow := stillActive && !verdict.ListenerApplied? && a.admittedAt == v.admitted;
    var claim := c.(applying := false, declined := (if declinedNow then (c.declined + Std.Collections.Seq.Filter((set_x: int) => !((set_x in c.declined)), [a.listener])) else c.declined));
    var stamped := withAttempt(v, a.(phase := AttemptPhase.Settled));
    var completed := withClaim(stamped, claim);
    ViewWithClaim(stamped, a.request, claim);
    var after := settleListener(s, attempt, verdict);
    if stillActive && verdict.ListenerApplied? {
      ViewCommit(completed, a.request, ClaimResolution.ClaimApplied);
      ViewWithClaim(completed, a.request, resolveClaim(claimAt(completed, a.request), ClaimResolution.ClaimApplied).(claimed := true));
      ViewStep(s, after, a.request, true);
    } else {
      ViewStep(s, after, a.request, false);
    }
  }
}

lemma rejectView_ensures(s: Navigation, request: int)
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysBoundedNavigationIndexes(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysUniqueNavigationIndexes(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysViewClaimsNumbered(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysViewQueueDistinct(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysAdmittedCountNeverNegative(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysViewQueueBounded(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysViewClaimResolvedOnce(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysQueuedViewRequestsWait(rejectView(s, request)))
  ensures (inv(s) ==> canRejectView(s, request) ==> alwaysOnlyMountedListenersHoldRequests(rejectView(s, request)))
{
  if inv(s) && canRejectView(s, request) {
    ViewIndex(s);
    ViewCommit(s.views, request, ClaimResolution.ClaimRejected);
    ViewWithClaim(s.views, request, resolveClaim(claimAt(s.views, request), ClaimResolution.ClaimRejected).(claimed := true));
    ViewStep(s, rejectView(s, request), request, true);
  }
}

lemma applyViewEffect_ensures(s: Navigation, attempt: int)
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysBoundedNavigationIndexes(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysUniqueNavigationIndexes(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysViewClaimsNumbered(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysViewQueueDistinct(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysAdmittedCountNeverNegative(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysViewQueueBounded(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysViewClaimResolvedOnce(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysQueuedViewRequestsWait(applyViewEffect(s, attempt)))
  ensures (inv(s) ==> canApplyViewEffect(s, attempt) ==> alwaysOnlyMountedListenersHoldRequests(applyViewEffect(s, attempt)))
{
  if inv(s) && canApplyViewEffect(s, attempt) {
    ViewIndex(s);
    var a := attemptAt(s.views, attempt);
    var c := claimAt(s.views, a.request);
    var stamped := withAttempt(s.views, a.(effected := true));
    ViewWithClaim(stamped, a.request, c.(effects := (c.effects + 1)));
    ViewStep(s, applyViewEffect(s, attempt), a.request, false);
  }
}

lemma requestView_ensures(s: Navigation)
  ensures (inv(s) ==> alwaysBoundedNavigationIndexes(requestView(s)))
  ensures (inv(s) ==> alwaysUniqueNavigationIndexes(requestView(s)))
  ensures (inv(s) ==> alwaysViewClaimsNumbered(requestView(s)))
  ensures (inv(s) ==> alwaysViewQueueDistinct(requestView(s)))
  ensures (inv(s) ==> alwaysAdmittedCountNeverNegative(requestView(s)))
  ensures (inv(s) ==> alwaysViewQueueBounded(requestView(s)))
  ensures (inv(s) ==> alwaysViewClaimResolvedOnce(requestView(s)))
  ensures (inv(s) ==> alwaysQueuedViewRequestsWait(requestView(s)))
  ensures (inv(s) ==> alwaysOnlyMountedListenersHoldRequests(requestView(s)))
{
  if inv(s) {
    ViewRequest(s);
  }
}

lemma ViewRequest(s: Navigation)
  requires inv(s)
  ensures alwaysViewClaimsNumbered(requestView(s)) && alwaysViewQueueDistinct(requestView(s)) && alwaysViewClaimResolvedOnce(requestView(s)) && alwaysQueuedViewRequestsWait(requestView(s))
{
  ViewIndex(s);
  var v := s.views;
  var request := v.admitted + 1;
  var full := |v.queue| >= viewQueueCapacity;
  var oldest := if 0 < |v.queue| then v.queue[0] else 0;
  var kept := if full then v.queue[1..] else v.queue;
  var after := requestView(s);
  var n := |v.requests|;
  ViewIndex(after);
  assert full ==> oldest != request by { if full { assert v.queue[0] in v.queue; } }
  assert |after.views.requests| == n + 1;
  assert after.views.requests[n].request == request && waiting(after.views.requests[n]) && after.views.requests[n].resolutions == 0;
  forall i | 0 <= i < n
    ensures after.views.requests[i].request == v.requests[i].request
    ensures after.views.requests[i].resolutions == (if after.views.requests[i].resolution.ClaimPending? then 0 else 1)
    ensures (!full || v.requests[i].request != oldest) ==> waiting(after.views.requests[i]) == waiting(v.requests[i])
  {}
  assert after.views.queue == kept + [request];
  NavigationDropOneKeepsKeys(v.queue, kept, (item: int) => item);
  forall q | q in kept ensures q in v.queue && 1 <= q <= v.admitted && (full ==> q != oldest) {
    if full {
      var k :| 0 <= k < |kept| && kept[k] == q;
      assert v.queue[k + 1] == q;
    }
  }
  ProofLib.DistinctByConcat(kept, [request], (item: int) => item);
  forall q | q in after.views.queue
    ensures exists i :: 0 <= i < |after.views.requests| && after.views.requests[i].request == q && waiting(after.views.requests[i])
  {
    if q != request {
      assert q in kept;
      var i :| 0 <= i < n && v.requests[i].request == q && waiting(v.requests[i]);
      assert after.views.requests[i].request == q;
    }
  }
}
