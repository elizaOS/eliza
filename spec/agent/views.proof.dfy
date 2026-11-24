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
    ViewsPrepare(h, requestId, clientId, viewId);
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
    ViewsPrepare(h, requestId, clientId, (if ((0 <= 0) && (0 < |targets(h, target)|)) then targets(h, target)[0] else noView).viewId);
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
    ViewsAsk(h, requestId, clientId, viewId);
  }
}

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
    ViewsClose(h);
  }
}

// spec/agent/views.md: waiters are keyed by request id, so distinct ids never share a waiter.
lemma ViewsKey(a: string, b: string)
  ensures ("$" + a == "$" + b) == (a == b)
{
  if "$" + a == "$" + b {
    assert a == ("$" + a)[1..];
    assert b == ("$" + b)[1..];
  }
}

lemma ViewsDeclaredAtFilter(h: ViewHost, viewId: string)
  ensures declaredAt(h, viewId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((d: DeclaredView) => (d.viewId == viewId), h.views)|)) then ProofLib.Filter((d: DeclaredView) => (d.viewId == viewId), h.views)[0] else noView)
{
}

// spec/agent/views.md: a request names a view the agent declared.
lemma ViewsDeclaredAt(h: ViewHost, viewId: string)
  requires declares(h, viewId)
  ensures declaredAt(h, viewId) in h.views && declaredAt(h, viewId).viewId == viewId
{
  var p := (d: DeclaredView) => (d.viewId == viewId);
  ViewsDeclaredAtFilter(h, viewId);
  var d :| d in h.views && d.viewId == viewId;
  ProofLib.FilterMember(p, h.views, d);
  assert |ProofLib.Filter(p, h.views)| > 0;
  ProofLib.FilterMember(p, h.views, ProofLib.Filter(p, h.views)[0]);
}

// spec/agent/views.md: preparing again supersedes the client's unclaimed navigation.
lemma ViewsPrepare(h: ViewHost, requestId: string, clientId: string, viewId: string)
  requires inv(h) && canPrepareNavigation(h, requestId, clientId, viewId)
  ensures alwaysWaitersNameDeclaredViews(prepareNavigation(h, requestId, clientId, viewId))
  ensures alwaysPendingNavigationIsTheLatest(prepareNavigation(h, requestId, clientId, viewId))
  ensures stepClaimIsFinal(h, prepareNavigation(h, requestId, clientId, viewId))
  ensures stepEndedRequestStaysEnded(h, prepareNavigation(h, requestId, clientId, viewId))
{
  var prev := openNavigationOf(h, clientId);
  var w := waiterAt(h, prev);
  var retire := known(h, prev) && pending(w);
  var retired := (if retire then withWaiter(prev, w.(req := core__views_retire(w.req), outcome := WaitOutcome.Superseded), h) else h);
  var after := prepareNavigation(h, requestId, clientId, viewId);
  ViewsDeclaredAt(h, viewId);
  assert declaredAt(retired, viewId) == declaredAt(h, viewId) by {
    assert retired.views == h.views;
    ViewsDeclaredAtFilter(h, viewId);
    ViewsDeclaredAtFilter(retired, viewId);
  }
  var nw := Waiter(core__views_request(core__views_initial, requestId, clientId, declaredAt(h, viewId).installationId, viewId), WaiterKind.Navigation, Claim.Unclaimed, WaitOutcome.Waiting);
  assert after == withNewWaiter(WaiterKind.Navigation, requestId, clientId, viewId, retired).(openNavigation := h.openNavigation[("$" + clientId) := requestId]);
  assert after.requestIds == h.requestIds + [requestId];
  assert after.views == h.views;
  assert retire ==> prev != requestId;
  forall id
    ensures waiterAt(after, id) == (if id == requestId then nw else if retire && id == prev then w.(req := core__views_retire(w.req), outcome := WaitOutcome.Superseded) else waiterAt(h, id))
  {
    ViewsKey(id, requestId);
    ViewsKey(id, prev);
  }
  forall c
    ensures openNavigationOf(after, c) == (if c == clientId then requestId else openNavigationOf(h, c))
  {
    ViewsKey(c, clientId);
  }
  forall id | id in after.requestIds
    ensures namesDeclaredView(after.views, id, waiterAt(after, id))
  {
    if id == requestId {
      assert declaredAt(h, viewId) in after.views;
    } else {
      assert id in h.requestIds;
      assert namesDeclaredView(h.views, id, waiterAt(h, id));
    }
  }
  forall id | id in after.requestIds
    ensures latestIfPending(after, id)
  {
    if id != requestId && !(retire && id == prev) {
      assert id in h.requestIds;
      var w2 := waiterAt(h, id);
      if w2.kind.Navigation? && pending(w2) {
        assert latestIfPending(h, id);
        if w2.req.clientId == clientId {
          assert prev == id;
          assert known(h, prev);
        }
      }
    }
  }
  forall id | id in h.requestIds
    ensures !isClaimed(waiterAt(h, id).claim) || waiterAt(after, id).claim == waiterAt(h, id).claim
    ensures pending(waiterAt(h, id)) || waiterAt(after, id) == waiterAt(h, id)
  {
    assert id != requestId;
  }
}

// spec/agent/views.md: an interaction is a new waiter on a declared view; nothing else changes.
lemma ViewsAsk(h: ViewHost, requestId: string, clientId: string, viewId: string)
  requires inv(h) && opened_(h, requestId, clientId, viewId)
  ensures alwaysWaitersNameDeclaredViews(withNewWaiter(WaiterKind.Interaction, requestId, clientId, viewId, h))
  ensures stepClaimIsFinal(h, withNewWaiter(WaiterKind.Interaction, requestId, clientId, viewId, h))
  ensures stepEndedRequestStaysEnded(h, withNewWaiter(WaiterKind.Interaction, requestId, clientId, viewId, h))
{
  var after := withNewWaiter(WaiterKind.Interaction, requestId, clientId, viewId, h);
  ViewsDeclaredAt(h, viewId);
  forall id
    ensures waiterAt(after, id) == (if id == requestId then Waiter(core__views_request(core__views_initial, requestId, clientId, declaredAt(h, viewId).installationId, viewId), WaiterKind.Interaction, Claim.Unclaimed, WaitOutcome.Waiting) else waiterAt(h, id))
  {
    ViewsKey(id, requestId);
  }
  forall id | id in after.requestIds
    ensures namesDeclaredView(after.views, id, waiterAt(after, id))
  {
    if id == requestId {
      assert declaredAt(h, viewId) in after.views;
    } else {
      assert id in h.requestIds;
      assert namesDeclaredView(h.views, id, waiterAt(h, id));
    }
  }
  forall id | id in h.requestIds
    ensures !isClaimed(waiterAt(h, id).claim) || waiterAt(after, id).claim == waiterAt(h, id).claim
    ensures pending(waiterAt(h, id)) || waiterAt(after, id) == waiterAt(h, id)
  {
    assert id != requestId;
  }
}

// spec/agent/views.md: closing stops every pending request and changes nothing else.
lemma ViewsCloseFold(start: map<string, Waiter>, ids: seq<string>)
  ensures forall k :: (k in Std.Collections.Seq.FoldLeft((m: map<string, Waiter>, id: string) => stopped(m, id), start, ids)) == (k in start)
  ensures forall k :: k in start ==> Std.Collections.Seq.FoldLeft((m: map<string, Waiter>, id: string) => stopped(m, id), start, ids)[k] == (if (exists i :: i in ids && k == "$" + i) && start[k].req.phase.Pending? then start[k].(req := core__views_retire(start[k].req), outcome := WaitOutcome.Stopped) else start[k])
  decreases |ids|
{
  var f := (m: map<string, Waiter>, id: string) => stopped(m, id);
  if |ids| > 0 {
    var m1 := stopped(start, ids[0]);
    var k0 := "$" + ids[0];
    assert Std.Collections.Seq.FoldLeft(f, start, ids) == Std.Collections.Seq.FoldLeft(f, m1, ids[1..]);
    ViewsCloseFold(m1, ids[1..]);
    var r := Std.Collections.Seq.FoldLeft(f, start, ids);
    forall k
      ensures (k in m1) == (k in start)
      ensures k in start ==> m1[k] == (if k == k0 && start[k].req.phase.Pending? then start[k].(req := core__views_retire(start[k].req), outcome := WaitOutcome.Stopped) else start[k])
    {
    }
    forall k | k in start
      ensures r[k] == (if (exists i :: i in ids && k == "$" + i) && start[k].req.phase.Pending? then start[k].(req := core__views_retire(start[k].req), outcome := WaitOutcome.Stopped) else start[k])
    {
      assert ids[0] in ids;
      if k == k0 {
        assert exists i :: i in ids && k == "$" + i;
        if start[k].req.phase.Pending? {
          assert !m1[k].req.phase.Pending?;
        }
      } else {
        assert (exists i :: i in ids && k == "$" + i) == (exists i :: i in ids[1..] && k == "$" + i) by {
          forall i | i in ids && k == "$" + i ensures i in ids[1..] {
            var j :| 0 <= j < |ids| && ids[j] == i;
            assert j != 0;
            assert ids[1..][j - 1] == i;
          }
          forall i | i in ids[1..] ensures i in ids { }
        }
      }
    }
  }
}

lemma ViewsClose(h: ViewHost)
  requires inv(h)
  ensures alwaysRequestsAreListed(closeHost(h))
  ensures alwaysWaitersNameDeclaredViews(closeHost(h))
  ensures alwaysPendingNavigationIsTheLatest(closeHost(h))
  ensures alwaysAnsweredWasClaimed(closeHost(h))
  ensures alwaysClosedHoldsNoPending(closeHost(h))
  ensures stepClaimIsFinal(h, closeHost(h))
  ensures stepEndedRequestStaysEnded(h, closeHost(h))
{
  var after := closeHost(h);
  ViewsCloseFold(h.waiters, h.requestIds);
  forall id | id in h.requestIds
    ensures ("$" + id) in after.waiters
    ensures waiterAt(after, id) == (if pending(waiterAt(h, id)) then waiterAt(h, id).(req := core__views_retire(waiterAt(h, id).req), outcome := WaitOutcome.Stopped) else waiterAt(h, id))
  {
    assert ("$" + id) in h.waiters;
  }
  forall id | id in after.requestIds
    ensures namesDeclaredView(after.views, id, waiterAt(after, id))
    ensures !pending(waiterAt(after, id))
    ensures latestIfPending(after, id)
    ensures !waiterAt(after, id).req.phase.Delivered? || isClaimed(waiterAt(after, id).claim)
  {
    assert namesDeclaredView(h.views, id, waiterAt(h, id));
    assert !waiterAt(h, id).req.phase.Delivered? || isClaimed(waiterAt(h, id).claim);
  }
}
