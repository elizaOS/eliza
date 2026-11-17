lemma ResourcesBridge(g: Gateway)
  ensures alwaysReleasedOnceInReverse(g) <==> ((forall r :: r in g.life.released ==> r in g.life.acquired) && (forall r :: r in g.life.acquired ==> 0 <= r < g.life.nextResource) && 0 <= g.life.nextResource <= 4 && ((!g.life.phase.GwCleanup? && !g.life.phase.GwClosed?) ==> (g.life.lastReleased == 4 && |g.life.released| == 0)) && (forall r :: r in g.life.released ==> r >= g.life.lastReleased) && (forall r :: r in g.life.acquired ==> (r in g.life.released || r < g.life.lastReleased)) && (g.life.phase.GwReady? ==> g.life.listening) && (g.life.phase.GwClosed? ==> (forall r :: r in g.life.acquired ==> r in g.life.released)) && (g.life.cleanupOwner == (g.life.phase.GwCleanup? || g.life.phase.GwClosed?)))
{}

lemma AddedOne(xs: seq<int>, p: int -> bool, x: int)
  requires forall y :: p(y) == !(y in xs)
  ensures forall y :: y in xs + ProofLib.Filter(p, [x]) <==> (y in xs || y == x)
{
  ProofLib.FilterCons(p, [x]);
  ProofLib.FilterNil(p, [x][1..]);
}

lemma AcquireBridge(g: Gateway, present: bool)
  ensures acquireResource(g, present).life.acquired == (if present then (g.life.acquired + ProofLib.Filter((set_x: int) => !((set_x in g.life.acquired)), [g.life.nextResource])) else g.life.acquired)
{}

lemma DisposeBridge(g: Gateway, resource: int, failed: bool)
  ensures disposeResource(g, resource, failed).life.released == (g.life.released + ProofLib.Filter((set_x: int) => !((set_x in g.life.released)), [resource]))
{}

lemma acquireResource_ensures(g: Gateway, present: bool)
  ensures (inv(g) ==> canAcquireResource(g) ==> alwaysReleasedOnceInReverse(acquireResource(g, present)))
  ensures (inv(g) ==> canAcquireResource(g) ==> alwaysCleanupFollowsHttpClose(acquireResource(g, present)))
  ensures (inv(g) ==> canAcquireResource(g) ==> alwaysReplyGoesToItsOwner(acquireResource(g, present)))
  ensures (inv(g) ==> canAcquireResource(g) ==> stepResetDropsInferenceOwnerRead(g, "acquireResource", acquireResource(g, present)))
  ensures (inv(g) ==> canAcquireResource(g) ==> stepTurnMovesOnlyUnderCurrentAuthority(g, "acquireResource", acquireResource(g, present)))
{
  if inv(g) && canAcquireResource(g) {
    var after := acquireResource(g, present);
    ResourcesBridge(g);
    ResourcesBridge(after);
    AcquireBridge(g, present);
    AddedOne(g.life.acquired, (set_x: int) => !((set_x in g.life.acquired)), g.life.nextResource);
  }
}

lemma disposeResource_ensures(g: Gateway, resource: int, failed: bool)
  ensures (inv(g) ==> canDisposeResource(g, resource) ==> alwaysReleasedOnceInReverse(disposeResource(g, resource, failed)))
  ensures (inv(g) ==> canDisposeResource(g, resource) ==> alwaysCleanupFollowsHttpClose(disposeResource(g, resource, failed)))
  ensures (inv(g) ==> canDisposeResource(g, resource) ==> alwaysReplyGoesToItsOwner(disposeResource(g, resource, failed)))
  ensures (inv(g) ==> canDisposeResource(g, resource) ==> stepResetDropsInferenceOwnerRead(g, "disposeResource", disposeResource(g, resource, failed)))
  ensures (inv(g) ==> canDisposeResource(g, resource) ==> stepTurnMovesOnlyUnderCurrentAuthority(g, "disposeResource", disposeResource(g, resource, failed)))
{
  if inv(g) && canDisposeResource(g, resource) {
    var after := disposeResource(g, resource, failed);
    ResourcesBridge(g);
    ResourcesBridge(after);
    DisposeBridge(g, resource, failed);
    AddedOne(g.life.released, (set_x: int) => !((set_x in g.life.released)), resource);
    assert resource < g.life.lastReleased;
  }
}
