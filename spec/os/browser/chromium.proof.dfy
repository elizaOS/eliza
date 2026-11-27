lemma CustodyFilterView(b: BrowserBinding)
  ensures alwaysCallbackCustody(b) ==
    ((((b.nextHold >= 1) && !((exists id :: id in b.waiting && !((((id in b.openHolds) && !((id in b.fired))) && (|ProofLib.Filter((other: int) => (other == id), b.waiting)| == 1)))))) && !((exists id :: id in b.openHolds && !(((id >= 1) && (id < b.nextHold)))))) && !((exists id :: id in b.fired && !(((id >= 1) && (id < b.nextHold))))))
{}

lemma StepReadyBridge(before: BrowserBinding, via: string, after: BrowserBinding, out: seq<int>)
  ensures stepReadyCallbackFiresOnce(before, via, after, out) ==
    (!((exists set_x :: set_x in before.fired && !((set_x in after.fired)))) && !((exists id :: id in out && !((((((after.link.Ready? && (id in before.openHolds)) && !((id in before.fired))) && (id in after.fired)) && (|ProofLib.Filter((other: int) => (other == id), out)| == 1)) && ((id in before.waiting) || (via == "registerReady")))))))
{}

lemma ConnectedBridge(b: BrowserBinding)
  ensures connected(b, true).state.fired ==
    b.fired + ProofLib.Filter((set_x: int) => !((set_x in b.fired)), Std.Collections.Seq.FoldLeft((ids: seq<int>, id: int) => (ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [id])), [], b.waiting))
{
  var f1 := (ids: seq<int>, id: int) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [id]));
  var f2 := (ids: seq<int>, id: int) => (ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [id]));
  ProofLib.FoldLeftPointwise(f1, f2, [], b.waiting, b.waiting);
}

lemma AcquireHoldBridge(b: BrowserBinding, result: BindResult)
  ensures acquireHold(b, result) ==
    bindWith(result, b.(nextHold := (b.nextHold + 1), openHolds := (b.openHolds + ProofLib.Filter((set_x: int) => !((set_x in b.openHolds)), [b.nextHold])), idlePending := false))
{}

lemma ReleaseHoldBridge(b: BrowserBinding, holdId: int)
  ensures releaseHold(b, holdId) ==
    (var local_0 := ProofLib.Filter((set_x: int) => !((set_x in [holdId])), b.openHolds);
     b.(openHolds := local_0, waiting := ProofLib.Filter((id: int) => (id != holdId), b.waiting), idlePending := (!(b.pinned) && (|local_0| == 0))))
{}

lemma DedupStepEq(ids: seq<int>, id: int)
  ensures ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [id]) == (if id in ids then ids else ids + [id])
{
  var p := (set_x: int) => !((set_x in ids));
  ProofLib.FilterCons(p, [id]);
  assert [id][1..] == [];
  ProofLib.FilterNil(p, []);
}

lemma DedupFoldMembers(f: (seq<int>, int) -> seq<int>, acc: seq<int>, ws: seq<int>)
  requires forall ids, id :: f(ids, id) == (if id in ids then ids else ids + [id])
  ensures forall x :: x in Std.Collections.Seq.FoldLeft(f, acc, ws) <==> x in acc || x in ws
  decreases |ws|
{
  if |ws| > 0 {
    DedupFoldMembers(f, f(acc, ws[0]), ws[1..]);
    assert ws == [ws[0]] + ws[1..];
  }
}

lemma connected_ensures(b: BrowserBinding, identityMatches: bool)
  ensures (inv(b) ==> canConnected(b) ==> alwaysClosedHoldsNothing(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> alwaysBackoffDoublesToThirtySeconds(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> alwaysCallbackCustody(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> alwaysReadyHasNoWaiters(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> alwaysIdleReleaseOnlyWhenUnwanted(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> alwaysUnwantedLiveBindingIsReleasing(connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> stepClosedStaysClosed(b, connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> stepUnavailableWaitsForNewDemand(b, "connected", connected(b, identityMatches).state))
  ensures (inv(b) ==> canConnected(b) ==> stepReadyCallbackFiresOnce(b, "connected", connected(b, identityMatches).state, connected(b, identityMatches).out))
{
  if inv(b) && canConnected(b) && identityMatches {
    var after := connected(b, identityMatches);
    ConnectedBridge(b);
    CustodyFilterView(b);
    CustodyFilterView(after.state);
    StepReadyBridge(b, "connected", after.state, after.out);
    var f := (ids: seq<int>, id: int) => (ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [id]));
    forall ids, id
      ensures f(ids, id) == (if id in ids then ids else ids + [id])
    {
      DedupStepEq(ids, id);
    }
    DedupFoldMembers(f, [], b.waiting);
    var deduped := Std.Collections.Seq.FoldLeft(f, [], b.waiting);
    var addP := (set_x: int) => !((set_x in b.fired));
    forall x
      ensures x in after.state.fired <==> x in b.fired || x in b.waiting
    {
      ProofLib.FilterMember(addP, deduped, x);
    }
  }
}

lemma acquireHold_ensures(b: BrowserBinding, result: BindResult)
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysClosedHoldsNothing(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysBackoffDoublesToThirtySeconds(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysCallbackCustody(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysReadyHasNoWaiters(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysIdleReleaseOnlyWhenUnwanted(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> alwaysUnwantedLiveBindingIsReleasing(acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> stepClosedStaysClosed(b, acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> stepUnavailableWaitsForNewDemand(b, "acquireHold", acquireHold(b, result)))
  ensures (inv(b) ==> canAcquireHold(b) ==> stepReadyCallbackFiresOnce(b, "acquireHold", acquireHold(b, result), []))
{
  if inv(b) && canAcquireHold(b) {
    AcquireHoldBridge(b, result);
    var p := (set_x: int) => !((set_x in b.openHolds));
    ProofLib.FilterCons(p, [b.nextHold]);
    assert [b.nextHold][1..] == [];
    ProofLib.FilterNil(p, []);
    var nextHolds := b.openHolds + ProofLib.Filter(p, [b.nextHold]);
    assert b.nextHold in nextHolds;
    assert |nextHolds| > 0;
  }
}

lemma registerReady_ensures(b: BrowserBinding, holdId: int)
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysClosedHoldsNothing(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysBackoffDoublesToThirtySeconds(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysCallbackCustody(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysReadyHasNoWaiters(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysIdleReleaseOnlyWhenUnwanted(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysUnwantedLiveBindingIsReleasing(registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepClosedStaysClosed(b, registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepUnavailableWaitsForNewDemand(b, "registerReady", registerReady(b, holdId).state))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepReadyCallbackFiresOnce(b, "registerReady", registerReady(b, holdId).state, registerReady(b, holdId).out))
{
  if inv(b) && canRegisterReady(b, holdId) {
    var after := registerReady(b, holdId);
    if b.link.Ready? {
      reveal Std.Collections.Seq.Filter();
      assert [holdId][1..] == [];
    } else {
      CustodyFilterView(b);
      CustodyFilterView(after.state);
      forall id | id in after.state.waiting
        ensures |ProofLib.Filter((other: int) => (other == id), after.state.waiting)| == 1
      {
        var p := (other: int) => (other == id);
        ProofLib.FilterAppend(p, b.waiting, holdId);
        if id == holdId {
          ProofLib.FilterNone(p, b.waiting);
        }
      }
    }
  }
}

lemma releaseHold_ensures(b: BrowserBinding, holdId: int)
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysClosedHoldsNothing(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysBackoffDoublesToThirtySeconds(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysCallbackCustody(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysReadyHasNoWaiters(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysIdleReleaseOnlyWhenUnwanted(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysUnwantedLiveBindingIsReleasing(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepClosedStaysClosed(b, releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepUnavailableWaitsForNewDemand(b, "releaseHold", releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepReadyCallbackFiresOnce(b, "releaseHold", releaseHold(b, holdId), []))
{
  if inv(b) && canReleaseHold(b, holdId) {
    var after := releaseHold(b, holdId);
    ReleaseHoldBridge(b, holdId);
    CustodyFilterView(b);
    CustodyFilterView(after);
    var keepH := (set_x: int) => !((set_x in [holdId]));
    var keepW := (id: int) => (id != holdId);
    forall x
      ensures x in after.openHolds <==> x in b.openHolds && x != holdId
    {
      ProofLib.FilterMember(keepH, b.openHolds, x);
    }
    forall id | id in after.waiting
      ensures id in after.openHolds && !(id in after.fired) && |ProofLib.Filter((other: int) => (other == id), after.waiting)| == 1
    {
      ProofLib.FilterMember(keepW, b.waiting, id);
      var eq := (other: int) => (other == id);
      ProofLib.FilterOfFilterLength(keepW, eq, eq, b.waiting);
      ProofLib.FilterMember(eq, after.waiting, id);
    }
  }
}
