lemma Union(a: seq<int>, c: seq<int>)
  ensures forall y :: y in a + ProofLib.Filter((set_x: int) => !((set_x in a)), c) <==> (y in a || y in c)
{
  forall y ensures y in ProofLib.Filter((set_x: int) => !((set_x in a)), c) <==> (y in c && !(y in a)) {
    ProofLib.FilterMember((set_x: int) => !((set_x in a)), c, y);
  }
}

lemma Dedup(w: seq<int>)
  ensures forall y :: y in Std.Collections.Seq.FoldLeft((ids: seq<int>, id: int) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [id])), [], w) ==> y in w
{
  var f := (ids: seq<int>, id: int) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [id]));
  forall a, y ensures f(a, y) == (if y in a then a else a + [y]) {
    ProofLib.FilterCons((set_x: int) => !((set_x in a)), [y]);
    ProofLib.FilterNil((set_x: int) => !((set_x in a)), [y][1..]);
  }
  forall y ensures y in Std.Collections.Seq.FoldLeft(f, [], w) ==> y in w {
    ProofLib.FoldLeftDedupMember(f, [], w, y);
  }
}

lemma Shapes(b: BrowserBinding, h: int)
  ensures connected(b, true, false).demand.fired == b.demand.fired + ProofLib.Filter((set_x: int) => !((set_x in b.demand.fired)), Std.Collections.Seq.FoldLeft((ids: seq<int>, id: int) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [id])), [], b.demand.waiting))
  ensures connected(b, true, true).demand.fired == connected(b, true, false).demand.fired
  ensures acquireHold(b, h).demand.acquired == b.demand.acquired + ProofLib.Filter((set_x: int) => !((set_x in b.demand.acquired)), [h])
  ensures !b.closed ==> acquireHold(b, h).demand.open == b.demand.open + ProofLib.Filter((set_x: int) => !((set_x in b.demand.open)), [h])
  ensures registerReady(b, h).demand.registered == b.demand.registered + ProofLib.Filter((set_x: int) => !((set_x in b.demand.registered)), [h])
  ensures registerReady(b, h).demand.fired == b.demand.fired || registerReady(b, h).demand.fired == b.demand.fired + ProofLib.Filter((set_x: int) => !((set_x in b.demand.fired)), [h])
  ensures releaseHold(b, h).demand.open == ProofLib.Filter((set_x: int) => !((set_x in [h])), b.demand.open)
  ensures releaseHold(b, h).demand.waiting == ProofLib.Filter((id: int) => (id != h), b.demand.waiting)
{
}

lemma Custody(b: BrowserBinding)
  ensures alwaysCallbackCustody(b) == ((forall x :: x in b.demand.fired ==> x in b.demand.registered) &&
    (forall x :: x in b.demand.registered ==> x in b.demand.acquired) && (forall x :: x in b.demand.open ==> x in b.demand.acquired) &&
    (forall x :: x in b.demand.waiting ==> x in b.demand.open && x in b.demand.registered && !(x in b.demand.fired)) &&
    (forall id :: id in b.demand.waiting ==> |ProofLib.Filter((other: int) => (other == id), b.demand.waiting)| == 1))
{
}

lemma Unique(w: seq<int>)
  ensures (forall id :: id in w ==> |ProofLib.Filter((other: int) => (other == id), w)| == 1) == ProofLib.Distinct(w)
{
  if forall id :: id in w ==> |ProofLib.Filter((other: int) => (other == id), w)| == 1 {
    forall i, j | 0 <= i < j < |w| ensures w[i] != w[j] {
      if w[i] == w[j] {
        assert w[i] in w;
        ProofLib.FilterTwo((other: int) => (other == w[i]), w, i, j);
      }
    }
  }
  if ProofLib.Distinct(w) {
    forall id | id in w ensures |ProofLib.Filter((other: int) => (other == id), w)| == 1 {
      ProofLib.FilterDistinctCountOne((other: int) => (other == id), w, id);
    }
  }
}

lemma Facts(b: BrowserBinding, after: BrowserBinding)
  ensures alwaysCallbackCustody(b) == ((forall x :: x in b.demand.fired ==> x in b.demand.registered) &&
    (forall x :: x in b.demand.registered ==> x in b.demand.acquired) && (forall x :: x in b.demand.open ==> x in b.demand.acquired) &&
    (forall x :: x in b.demand.waiting ==> x in b.demand.open && x in b.demand.registered && !(x in b.demand.fired)) && ProofLib.Distinct(b.demand.waiting))
  ensures alwaysCallbackCustody(after) == ((forall x :: x in after.demand.fired ==> x in after.demand.registered) &&
    (forall x :: x in after.demand.registered ==> x in after.demand.acquired) && (forall x :: x in after.demand.open ==> x in after.demand.acquired) &&
    (forall x :: x in after.demand.waiting ==> x in after.demand.open && x in after.demand.registered && !(x in after.demand.fired)) && ProofLib.Distinct(after.demand.waiting))
{
  Custody(b);
  Unique(b.demand.waiting);
  Custody(after);
  Unique(after.demand.waiting);
}

lemma connected_ensures(b: BrowserBinding, identityMatches: bool, acceptedWarmup: bool)
  ensures (inv(b) ==> canConnected(b) ==> alwaysBrowserClosedReleases(connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> alwaysBrowserReadinessHasBinding(connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> alwaysRetryDelayBounded(connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> alwaysCallbackCustody(connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> alwaysClosedBindingHasNoWaiters(connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> stepClosedBindingStaysClosed(b, connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> stepCallbackFiresOnce(b, connected(b, identityMatches, acceptedWarmup)))
  ensures (inv(b) ==> canConnected(b) ==> stepIdleReleaseUnbindsUnwanted(b, "connected", connected(b, identityMatches, acceptedWarmup)))
{
  if inv(b) && canConnected(b) {
    var after := connected(b, identityMatches, acceptedWarmup);
    Facts(b, after);
    if identityMatches {
      Shapes(b, 0);
      Dedup(b.demand.waiting);
      Union(b.demand.fired, Std.Collections.Seq.FoldLeft((ids: seq<int>, id: int) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [id])), [], b.demand.waiting));
    } else {
      closeBinding_ensures(b);
    }
  }
}

lemma acquireHold_ensures(b: BrowserBinding, holdId: int)
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> alwaysBrowserClosedReleases(acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> alwaysBrowserReadinessHasBinding(acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> alwaysRetryDelayBounded(acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> alwaysCallbackCustody(acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> alwaysClosedBindingHasNoWaiters(acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> stepClosedBindingStaysClosed(b, acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> stepCallbackFiresOnce(b, acquireHold(b, holdId)))
  ensures (inv(b) ==> canAcquireHold(b, holdId) ==> stepIdleReleaseUnbindsUnwanted(b, "acquireHold", acquireHold(b, holdId)))
{
  if inv(b) && canAcquireHold(b, holdId) {
    Facts(b, acquireHold(b, holdId));
    Shapes(b, holdId);
    Union(b.demand.acquired, [holdId]);
    Union(b.demand.open, [holdId]);
  }
}

lemma registerReady_ensures(b: BrowserBinding, holdId: int)
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysBrowserClosedReleases(registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysBrowserReadinessHasBinding(registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysRetryDelayBounded(registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysCallbackCustody(registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> alwaysClosedBindingHasNoWaiters(registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepClosedBindingStaysClosed(b, registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepCallbackFiresOnce(b, registerReady(b, holdId)))
  ensures (inv(b) ==> canRegisterReady(b, holdId) ==> stepIdleReleaseUnbindsUnwanted(b, "registerReady", registerReady(b, holdId)))
{
  if inv(b) && canRegisterReady(b, holdId) {
    Facts(b, registerReady(b, holdId));
    Shapes(b, holdId);
    Union(b.demand.registered, [holdId]);
    Union(b.demand.fired, [holdId]);
    assert !(holdId in b.demand.waiting);
  }
}

lemma releaseHold_ensures(b: BrowserBinding, holdId: int)
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysBrowserClosedReleases(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysBrowserReadinessHasBinding(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysRetryDelayBounded(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysCallbackCustody(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> alwaysClosedBindingHasNoWaiters(releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepClosedBindingStaysClosed(b, releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepCallbackFiresOnce(b, releaseHold(b, holdId)))
  ensures (inv(b) ==> canReleaseHold(b, holdId) ==> stepIdleReleaseUnbindsUnwanted(b, "releaseHold", releaseHold(b, holdId)))
{
  if inv(b) && canReleaseHold(b, holdId) {
    Facts(b, releaseHold(b, holdId));
    Shapes(b, holdId);
    forall y ensures y in releaseHold(b, holdId).demand.open <==> y in b.demand.open && y != holdId {
      ProofLib.FilterMember((set_x: int) => !((set_x in [holdId])), b.demand.open, y);
    }
    forall y ensures y in releaseHold(b, holdId).demand.waiting <==> y in b.demand.waiting && y != holdId {
      ProofLib.FilterMember((id: int) => (id != holdId), b.demand.waiting, y);
    }
    ProofLib.FilterKeepsDistinctBy((id: int) => (id != holdId), b.demand.waiting, (x: int) => x);
  }
}
