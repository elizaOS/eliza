// The registry rule counts matches with a filter; these lemmas show it is
// the same as DistinctBy on platform and on id.

lemma SourcesCountsIffDistinct(xs: seq<TargetSource>)
  ensures (forall source :: source in xs ==> |ProofLib.Filter((other: TargetSource) => (other.platform == source.platform), xs)| == 1) <==> ProofLib.DistinctBy(xs, (t: TargetSource) => t.platform)
{
  if forall source :: source in xs ==> |ProofLib.Filter((other: TargetSource) => (other.platform == source.platform), xs)| == 1 {
    forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
      ensures xs[i].platform != xs[k].platform
    {
      var source := xs[i];
      ProofLib.FilterCountOneIffUnique((other: TargetSource) => (other.platform == source.platform), xs, (t: TargetSource) => t.platform, i);
    }
  }
  if ProofLib.DistinctBy(xs, (t: TargetSource) => t.platform) {
    forall source | source in xs
      ensures |ProofLib.Filter((other: TargetSource) => (other.platform == source.platform), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == source;
      ProofLib.FilterCountOneIffUnique((other: TargetSource) => (other.platform == source.platform), xs, (t: TargetSource) => t.platform, i);
    }
  }
}

lemma ProfilesCountsIffDistinct(xs: seq<InteractionProfile>)
  ensures (forall profile :: profile in xs ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == profile.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (t: InteractionProfile) => t.id)
{
  if forall profile :: profile in xs ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == profile.id), xs)| == 1 {
    forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
      ensures xs[i].id != xs[k].id
    {
      var profile := xs[i];
      ProofLib.FilterCountOneIffUnique((other: InteractionProfile) => (other.id == profile.id), xs, (t: InteractionProfile) => t.id, i);
    }
  }
  if ProofLib.DistinctBy(xs, (t: InteractionProfile) => t.id) {
    forall profile | profile in xs
      ensures |ProofLib.Filter((other: InteractionProfile) => (other.id == profile.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == profile;
      ProofLib.FilterCountOneIffUnique((other: InteractionProfile) => (other.id == profile.id), xs, (t: InteractionProfile) => t.id, i);
    }
  }
}

lemma KeysDistinct(s: ConnectorRegistries)
  ensures alwaysRegistryKeysUnique(s) == (ProofLib.DistinctBy(s.sources, (t: TargetSource) => t.platform) && ProofLib.DistinctBy(s.profiles, (t: InteractionProfile) => t.id))
{
  SourcesCountsIffDistinct(s.sources);
  ProfilesCountsIffDistinct(s.profiles);
}

lemma unregisterSource_ensures(s: ConnectorRegistries, platform: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(unregisterSource(s, platform)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, unregisterSource(s, platform)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "unregisterSource", unregisterSource(s, platform)))
{
  if inv(s) {
    KeysDistinct(s);
    var after := unregisterSource(s, platform);
    ProofLib.FilterKeepsDistinctBy((source: TargetSource) => (source.platform != platform), s.sources, (t: TargetSource) => t.platform);
    KeysDistinct(after);
  }
}

lemma registerSource_ensures(s: ConnectorRegistries, platform: string, reference: int)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerSource", registerSource(s, platform, reference)))
{
  if inv(s) {
    KeysDistinct(s);
    var after := registerSource(s, platform, reference);
    if !(exists source :: source in s.sources && source.platform == platform) {
      ProofLib.DistinctByConcat(s.sources, [TargetSource(platform, reference)], (t: TargetSource) => t.platform);
    }
    KeysDistinct(after);
  }
}

lemma registerProfile_ensures(s: ConnectorRegistries, id: string, fingerprint: string, body: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerProfile", registerProfile(s, id, fingerprint, body)))
{
  if inv(s) {
    KeysDistinct(s);
    var after := registerProfile(s, id, fingerprint, body);
    var p := (profile: InteractionProfile) => (profile.id == id);
    var xs := s.profiles;
    if |ProofLib.Filter(p, xs)| == 0 {
      ProofLib.DistinctByConcat(xs, [InteractionProfile(id, fingerprint, body)], (t: InteractionProfile) => t.id);
    }
    KeysDistinct(after);
  }
}
