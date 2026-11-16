lemma dispatchHandoff_ensures(s: Navigation, id: string, handledByShell: bool, handlerNavigates: bool, pathAfterHandler: string)
  ensures (inv(s) ==> alwaysBoundedNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysUniqueNavigationIndexes(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewClaimsNumbered(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
  ensures (inv(s) ==> alwaysViewQueueDistinct(dispatchHandoff(s, id, handledByShell, handlerNavigates, pathAfterHandler)))
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
