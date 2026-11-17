lemma RuntimeRefreshPending(c: RuntimeClient)
  ensures refreshRuntime(c).pendingRefreshes == c.pendingRefreshes + ProofLib.Filter((set_x: int) => !((set_x in c.pendingRefreshes)), [(c.generation + 1)])
{}

lemma RuntimeFinishPending(c: RuntimeClient, epoch: int, refreshOutcome: RefreshOutcome)
  ensures finishRefresh(c, epoch, refreshOutcome).pendingRefreshes == ProofLib.Filter((set_x: int) => !((set_x in [epoch])), c.pendingRefreshes)
{}

lemma refreshRuntime_ensures(c: RuntimeClient)
  ensures (inv(c) ==> alwaysCacheNamesAnIssuedGeneration(refreshRuntime(c)))
  ensures (inv(c) ==> alwaysGenerationsCountFromZero(refreshRuntime(c)))
  ensures (inv(c) ==> alwaysAtMostOneReplay(refreshRuntime(c)))
  ensures (inv(c) ==> alwaysAvailableBridgeOwnsRequest(refreshRuntime(c)))
  ensures (inv(c) ==> stepLateRefreshChangesNothing(c, "refreshRuntime", refreshRuntime(c)))
  ensures (inv(c) ==> stepDispatchInOwnGeneration(c, "refreshRuntime", refreshRuntime(c)))
  ensures (inv(c) ==> stepPublishInOwnGeneration(c, "refreshRuntime", refreshRuntime(c)))
{
  if inv(c) {
    var after := refreshRuntime(c);
    RuntimeRefreshPending(c);
    forall e | e in after.pendingRefreshes ensures e > 0 && e <= after.generation {
      if e !in c.pendingRefreshes { ProofLib.FilterMember((set_x: int) => !((set_x in c.pendingRefreshes)), [(c.generation + 1)], e); }
    }
  }
}

lemma finishRefresh_ensures(c: RuntimeClient, epoch: int, refreshOutcome: RefreshOutcome)
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> alwaysCacheNamesAnIssuedGeneration(finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> alwaysGenerationsCountFromZero(finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> alwaysAtMostOneReplay(finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> alwaysAvailableBridgeOwnsRequest(finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> stepLateRefreshChangesNothing(c, "finishRefresh", finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> stepDispatchInOwnGeneration(c, "finishRefresh", finishRefresh(c, epoch, refreshOutcome)))
  ensures (inv(c) ==> canFinishRefresh(c, epoch) ==> stepPublishInOwnGeneration(c, "finishRefresh", finishRefresh(c, epoch, refreshOutcome)))
{
  if inv(c) && canFinishRefresh(c, epoch) {
    var after := finishRefresh(c, epoch, refreshOutcome);
    RuntimeFinishPending(c, epoch, refreshOutcome);
    assert epoch > 0 && epoch <= c.generation;
    forall e | e in after.pendingRefreshes ensures e > 0 && e <= after.generation {
      ProofLib.FilterMember((set_x: int) => !((set_x in [epoch])), c.pendingRefreshes, e);
    }
  }
}
