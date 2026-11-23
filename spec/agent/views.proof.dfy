lemma closeHost_ensures(h: ViewHost)
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysViewsDistinct(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysRequestsAreListed(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysWaitersNameDeclaredViews(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysPendingNavigationIsTheLatest(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysAnsweredWasClaimed(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysShownViewsAreDeclaredGraphical(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> alwaysClosedHoldsNoPending(closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> stepViewsFixedAfterBoot(h, closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> stepClaimIsFinal(h, closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> stepShownChangesOnlyOnConfirmedSwitch(h, "closeHost", closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> stepEndedRequestStaysEnded(h, closeHost(h)))
  ensures (inv(h) ==> canCloseHost(h) ==> stepNothingChangesAfterClose(h, closeHost(h)))
{
  if inv(h) && canCloseHost(h) {
    var closed := closeHost(h);
    forall id | id in h.requestIds
      ensures "$" + id in closed.waiters
      ensures !pending(waiterAt(closed, id))
      ensures namesDeclaredView(closed.views, id, waiterAt(closed, id))
      ensures waiterAt(closed, id).claim == waiterAt(h, id).claim
      ensures !pending(waiterAt(h, id)) ==> waiterAt(closed, id) == waiterAt(h, id)
      ensures waiterAt(closed, id).req.phase.Delivered? ==> isClaimed(waiterAt(closed, id).claim)
    {
      var key := "$" + id;
      assert key in h.waiters;
      StopFoldAt(h.waiters, h.requestIds, id);
      assert waiterAt(closed, id) == stopped(h.waiters, id)[key];
      var before := waiterAt(h, id);
      var after := waiterAt(closed, id);
      assert namesDeclaredView(h.views, id, before);
      if pending(before) {
        assert after == before.(req := core__views_retire(before.req), outcome := WaitOutcome.Stopped);
        assert !after.req.phase.Pending? && !after.req.phase.Available? && !after.req.phase.Delivered?;
      } else {
        assert after == before;
      }
    }
  }
}

lemma StopFoldAt(initial: map<string, Waiter>, ids: seq<string>, id: string)
  ensures ("$" + id in Std.Collections.Seq.FoldLeft((m: map<string, Waiter>, next: string) => stopped(m, next), initial, ids)) == ("$" + id in initial)
  ensures "$" + id in initial ==> (
    Std.Collections.Seq.FoldLeft((m: map<string, Waiter>, next: string) => stopped(m, next), initial, ids)["$" + id] ==
    (if id in ids then stopped(initial, id)["$" + id] else initial["$" + id]))
  decreases |ids|
{
  if |ids| > 0 {
    var prefix := ids[..|ids|-1];
    var last := ids[|ids|-1];
    var f := (m: map<string, Waiter>, next: string) => stopped(m, next);
    assert ids == prefix + [last];
    StopFoldAt(initial, prefix, id);
    ProofLib.FoldLeftAppend(f, initial, prefix, last);
    var prior := Std.Collections.Seq.FoldLeft(f, initial, prefix);
    var key := "$" + id;
    assert (key in prior) == (key in initial);
    if last != id {
      assert ("$" + last)[1..] == last;
      assert key[1..] == id;
      assert "$" + last != key;
      assert (key in stopped(prior, last)) == (key in prior);
      if key in prior {
        assert stopped(prior, last)[key] == prior[key];
      }
    } else if key in initial {
      if id in prefix {
        assert prior[key] == stopped(initial, id)[key];
        assert !pending(prior[key]);
      } else {
        assert prior[key] == initial[key];
      }
    }
  }
}

lemma askView_ensures(h: ViewHost, requestId: string, clientId: string, viewId: string, capability: string, grant: CapabilityGrant, subscribed: bool)
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysViewsDistinct(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysRequestsAreListed(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysWaitersNameDeclaredViews(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysPendingNavigationIsTheLatest(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysAnsweredWasClaimed(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysShownViewsAreDeclaredGraphical(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> alwaysClosedHoldsNoPending(askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> stepViewsFixedAfterBoot(h, askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> stepClaimIsFinal(h, askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> stepShownChangesOnlyOnConfirmedSwitch(h, "askView", askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> stepEndedRequestStaysEnded(h, askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
  ensures (inv(h) ==> canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) ==> stepNothingChangesAfterClose(h, askView(h, requestId, clientId, viewId, capability, grant, subscribed)))
{
  if inv(h) && canAskView(h, requestId, clientId, viewId, capability, grant, subscribed) {
    DeclaredAtWitness(h, viewId);
    var after := askView(h, requestId, clientId, viewId, capability, grant, subscribed);
    assert namesDeclaredView(after.views, requestId, waiterAt(after, requestId));
    forall id | id in h.requestIds
      ensures waiterAt(after, id) == waiterAt(h, id)
      ensures namesDeclaredView(after.views, id, waiterAt(after, id))
    {
      assert id != requestId;
      DistinctRequestKeys(id, requestId);
      assert namesDeclaredView(h.views, id, waiterAt(h, id));
    }
    assert forall id :: id in after.requestIds ==> id == requestId || id in h.requestIds;
  }
}

lemma prepareNavigation_ensures(h: ViewHost, requestId: string, clientId: string, viewId: string)
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysViewsDistinct(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysRequestsAreListed(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysWaitersNameDeclaredViews(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysPendingNavigationIsTheLatest(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysAnsweredWasClaimed(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysShownViewsAreDeclaredGraphical(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> alwaysClosedHoldsNoPending(prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> stepViewsFixedAfterBoot(h, prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> stepClaimIsFinal(h, prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> stepShownChangesOnlyOnConfirmedSwitch(h, "prepareNavigation", prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> stepEndedRequestStaysEnded(h, prepareNavigation(h, requestId, clientId, viewId)))
  ensures (inv(h) ==> canPrepareNavigation(h, requestId, clientId, viewId) ==> stepNothingChangesAfterClose(h, prepareNavigation(h, requestId, clientId, viewId)))
{
  if inv(h) && canPrepareNavigation(h, requestId, clientId, viewId) {
    DeclaredAtWitness(h, viewId);
    var after := prepareNavigation(h, requestId, clientId, viewId);
    var previous := openNavigationOf(h, clientId);
    assert namesDeclaredView(after.views, requestId, waiterAt(after, requestId));
    assert latestIfPending(after, requestId);
    forall id | id in h.requestIds
      ensures waiterAt(after, id).claim == waiterAt(h, id).claim
      ensures !pending(waiterAt(h, id)) ==> waiterAt(after, id) == waiterAt(h, id)
      ensures namesDeclaredView(after.views, id, waiterAt(after, id))
      ensures latestIfPending(after, id)
    {
      assert id != requestId;
      DistinctRequestKeys(id, requestId);
      var before := waiterAt(h, id);
      var current := waiterAt(after, id);
      assert "$" + id in h.waiters;
      assert namesDeclaredView(h.views, id, before);
      if id == previous && pending(before) {
        assert current == before.(req := core__views_retire(before.req), outcome := WaitOutcome.Superseded);
        assert !pending(current) && !current.req.phase.Available? && !current.req.phase.Delivered?;
      } else {
        if id != previous {
          DistinctRequestKeys(id, previous);
        }
        assert current == before;
      }
      if current.kind.Navigation? && pending(current) {
        assert current == before;
        assert latestIfPending(h, id);
        assert openNavigationOf(h, current.req.clientId) == id;
        assert current.req.clientId != clientId;
        DistinctRequestKeys(current.req.clientId, clientId);
        assert openNavigationOf(after, current.req.clientId) == id;
      }
    }
    assert forall id :: id in after.requestIds ==> id == requestId || id in h.requestIds;
  }
}

lemma showView_ensures(h: ViewHost, requestId: string, clientId: string, target: string)
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysViewsDistinct(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysRequestsAreListed(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysWaitersNameDeclaredViews(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysPendingNavigationIsTheLatest(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysAnsweredWasClaimed(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysShownViewsAreDeclaredGraphical(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> alwaysClosedHoldsNoPending(showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> stepViewsFixedAfterBoot(h, showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> stepClaimIsFinal(h, showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> stepShownChangesOnlyOnConfirmedSwitch(h, "showView", showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> stepEndedRequestStaysEnded(h, showView(h, requestId, clientId, target)))
  ensures (inv(h) ==> canShowView(h, requestId, clientId, target) ==> stepNothingChangesAfterClose(h, showView(h, requestId, clientId, target)))
{
  if inv(h) && canShowView(h, requestId, clientId, target) {
    var viewId := targets(h, target)[0].viewId;
    prepareNavigation_ensures(h, requestId, clientId, viewId);
  }
}

lemma DeclaredAtWitness(h: ViewHost, viewId: string)
  requires declares(h, viewId)
  ensures declaredAt(h, viewId) in h.views && declaredAt(h, viewId).viewId == viewId
{
  var matches := (d: DeclaredView) => d.viewId == viewId;
  var candidate :| candidate in h.views && matches(candidate);
  ProofLib.FilterMember(matches, h.views, candidate);
  var xs := ProofLib.Filter(matches, h.views);
  assert |xs| > 0;
  ProofLib.FilterMember(matches, h.views, xs[0]);
  assert declaredAt(h, viewId) == xs[0];
}

lemma DistinctRequestKeys(left: string, right: string)
  requires left != right
  ensures "$" + left != "$" + right
{
  assert ("$" + left)[1..] == left;
  assert ("$" + right)[1..] == right;
}
