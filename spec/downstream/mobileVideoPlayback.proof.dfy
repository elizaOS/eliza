lemma revokePlaybackSource_ensures(s: PlaybackRegistry, sourceId: int)
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> alwaysPlaybackRegistryBounded(revokePlaybackSource(s, sourceId)))
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> alwaysGrantIsWithinIssueHistory(revokePlaybackSource(s, sourceId)))
  ensures (inv(s) ==> canRevokePlaybackSource(s, sourceId) ==> stepRetiredGrantCannotReturn(s, revokePlaybackSource(s, sourceId)))
{
  if inv(s) && canRevokePlaybackSource(s, sourceId) {
    var filtered := revokePlaybackSource(s, sourceId);
    assert filtered.liveGrants == ProofLib.Filter((g: PlaybackGrant) => (g.sourceId != sourceId), s.liveGrants);
    assert filtered.newestToken == s.newestToken;
    PlaybackFilterBound((g: PlaybackGrant) => (g.sourceId != sourceId), s.liveGrants);
    forall g | g in filtered.liveGrants
      ensures g.token > 0 && g.token <= filtered.newestToken && grantPublished(s, g.token)
    {
      ProofLib.FilterMember((g: PlaybackGrant) => (g.sourceId != sourceId), s.liveGrants, g);
      assert g in s.liveGrants;
      assert exists other :: other in s.liveGrants && other.token == g.token;
    }
  }
}

lemma PlaybackFilterBound<T>(keeps: T -> bool, grants: seq<T>)
  ensures |ProofLib.Filter(keeps, grants)| <= |grants|
  decreases |grants|
{
  if |grants| == 0 {
    ProofLib.FilterNil(keeps, grants);
  } else {
    ProofLib.FilterCons(keeps, grants);
    PlaybackFilterBound(keeps, grants[1..]);
  }
}
