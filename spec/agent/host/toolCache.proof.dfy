lemma miss_ensures(c: ToolCache)
  ensures (inv(c) ==> canMiss(c) ==> alwaysHitIsFreshAndCurrent(miss(c)))
  ensures (inv(c) ==> canMiss(c) ==> alwaysTiersConsistent(miss(c)))
  ensures (inv(c) ==> canMiss(c) ==> alwaysOnlyRealVersionsInFlight(miss(c)))
  ensures (inv(c) ==> canMiss(c) ==> alwaysDiskEntryOnlyInDiskTier(miss(c)))
  ensures (inv(c) ==> canMiss(c) ==> stepOneExecutionPerVersionInFlight(c, "miss", miss(c)))
{
  forall v | v in miss(c).inflight ensures v in c.inflight || v == c.requested {
    ProofLib.FilterMember((set_x: int) => !((set_x in c.inflight)), [c.requested], v);
  }
}

lemma failCall_ensures(c: ToolCache, version: int)
  ensures (inv(c) ==> canFailCall(c, version) ==> alwaysHitIsFreshAndCurrent(failCall(c, version)))
  ensures (inv(c) ==> canFailCall(c, version) ==> alwaysTiersConsistent(failCall(c, version)))
  ensures (inv(c) ==> canFailCall(c, version) ==> alwaysOnlyRealVersionsInFlight(failCall(c, version)))
  ensures (inv(c) ==> canFailCall(c, version) ==> alwaysDiskEntryOnlyInDiskTier(failCall(c, version)))
  ensures (inv(c) ==> canFailCall(c, version) ==> stepOneExecutionPerVersionInFlight(c, "failCall", failCall(c, version)))
{
  forall v | v in failCall(c, version).inflight ensures v in c.inflight {
    ProofLib.FilterMember((set_x: int) => !((set_x in [version])), c.inflight, v);
  }
}

lemma complete_ensures(c: ToolCache, version: int, result: SecretToolResult)
  ensures (inv(c) ==> canComplete(c, version) ==> alwaysHitIsFreshAndCurrent(complete(c, version, result)))
  ensures (inv(c) ==> canComplete(c, version) ==> alwaysTiersConsistent(complete(c, version, result)))
  ensures (inv(c) ==> canComplete(c, version) ==> alwaysOnlyRealVersionsInFlight(complete(c, version, result)))
  ensures (inv(c) ==> canComplete(c, version) ==> alwaysDiskEntryOnlyInDiskTier(complete(c, version, result)))
  ensures (inv(c) ==> canComplete(c, version) ==> stepOneExecutionPerVersionInFlight(c, "complete", complete(c, version, result)))
{
  forall v | v in complete(c, version, result).inflight ensures v in c.inflight {
    ProofLib.FilterMember((set_x: int) => !((set_x in [version])), c.inflight, v);
  }
}

