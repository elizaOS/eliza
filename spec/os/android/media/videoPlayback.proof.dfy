lemma FilterLenLe<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLenLe(p, xs[1..]);
  }
}

lemma revokePlaybackSource_ensures(s: PlaybackRegistry, sourceId: int)
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> alwaysPlaybackRegistryBounded(revokePlaybackSource(s, sourceId)))
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> alwaysGrantIsWithinIssueHistory(revokePlaybackSource(s, sourceId)))
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> stepRetiredGrantCannotReturn(s, revokePlaybackSource(s, sourceId)))
{
  if inv(s) && canRevokePlaybackSource(s, sourceId) {
    var p := (g: PlaybackGrant) => (g.sourceId != sourceId);
    var after := revokePlaybackSource(s, sourceId);
    assert after.liveGrants == ProofLib.Filter(p, s.liveGrants);
    FilterLenLe(p, s.liveGrants);
    ProofLib.FilterSubset(p, s.liveGrants);
    forall g | g in after.liveGrants
      ensures g in s.liveGrants
    {
      ProofLib.FilterMember(p, s.liveGrants, g);
    }
  }
}

lemma lawRevocationOnlyNarrowsAccess_ensures(request: PlaybackRequest, registry: PlaybackRegistry, sourceId: int)
  ensures (lawRevocationOnlyNarrowsAccess(request, registry, sourceId) == true)
{
  var p := (g: PlaybackGrant) => (g.sourceId != sourceId);
  var after := revokePlaybackSource(registry, sourceId);
  assert after.liveGrants == ProofLib.Filter(p, registry.liveGrants);
  if gateRequest(request, after).OpenSource? {
    var g :| g in after.liveGrants && g.token == request.key;
    ProofLib.FilterMember(p, registry.liveGrants, g);
    assert g in registry.liveGrants && g.token == request.key;
  }
}
