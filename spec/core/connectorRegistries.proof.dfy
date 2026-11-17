lemma RegistryKeysFilters(s: ConnectorRegistries)
  ensures alwaysRegistryKeysUnique(s) == ((forall source :: source in s.sources ==> |ProofLib.Filter((other: TargetSource) => (other.platform == source.platform), s.sources)| == 1) && (forall profile :: profile in s.profiles ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == profile.id), s.profiles)| == 1))
{}

lemma RegisterProfileParts(s: ConnectorRegistries, id: string, fingerprint: string, body: string)
  ensures registerProfile(s, id, fingerprint, body).profiles == (if |ProofLib.Filter((profile: InteractionProfile) => (profile.id == id), s.profiles)| == 0 then s.profiles + [InteractionProfile(id, fingerprint, body)] else s.profiles)
{}

lemma unregisterSource_ensures(s: ConnectorRegistries, platform: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(unregisterSource(s, platform)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, unregisterSource(s, platform)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "unregisterSource", unregisterSource(s, platform)))
{
  if inv(s) {
    var after := unregisterSource(s, platform);
    var keep := (source: TargetSource) => (source.platform != platform);
    assert after.sources == ProofLib.Filter(keep, s.sources);
    RegistryKeysFilters(s); RegistryKeysFilters(after);
    forall o | o in after.sources
      ensures |ProofLib.Filter((other: TargetSource) => (other.platform == o.platform), after.sources)| == 1
    {
      var same := (other: TargetSource) => (other.platform == o.platform);
      ProofLib.FilterMember(keep, s.sources, o);
      ProofLib.FilterOfFilterShorter(keep, same, s.sources);
      ProofLib.FilterMember(same, after.sources, o);
    }
  }
}

lemma registerSource_ensures(s: ConnectorRegistries, platform: string, reference: int)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerSource", registerSource(s, platform, reference)))
{
  if inv(s) {
    var after := registerSource(s, platform, reference);
    RegistryKeysFilters(s); RegistryKeysFilters(after);
    if exists source :: source in s.sources && source.platform == platform {
      forall o | o in after.sources
        ensures |ProofLib.Filter((other: TargetSource) => (other.platform == o.platform), after.sources)| == 1
      {
        var i :| 0 <= i < |after.sources| && after.sources[i] == o;
        assert s.sources[i].platform == o.platform;
        ProofLib.FilterLengthPointwise((other: TargetSource) => (other.platform == o.platform), (other: TargetSource) => (other.platform == o.platform), s.sources, after.sources);
        ProofLib.FilterSamePredicate((other: TargetSource) => (other.platform == o.platform), (other: TargetSource) => (other.platform == s.sources[i].platform), s.sources);
      }
    } else {
      var added := TargetSource(platform, reference);
      forall o | o in after.sources
        ensures |ProofLib.Filter((other: TargetSource) => (other.platform == o.platform), after.sources)| == 1
      {
        ProofLib.FilterAppend((other: TargetSource) => (other.platform == o.platform), s.sources, added);
        if o.platform == platform { ProofLib.FilterNone((other: TargetSource) => (other.platform == o.platform), s.sources); }
        else { assert o in s.sources; }
      }
    }
  }
}

lemma registerProfile_ensures(s: ConnectorRegistries, id: string, fingerprint: string, body: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerProfile", registerProfile(s, id, fingerprint, body)))
{
  if inv(s) {
    var after := registerProfile(s, id, fingerprint, body);
    RegistryKeysFilters(s); RegistryKeysFilters(after); RegisterProfileParts(s, id, fingerprint, body);
    if |ProofLib.Filter((profile: InteractionProfile) => (profile.id == id), s.profiles)| == 0 {
      var added := InteractionProfile(id, fingerprint, body);
      ProofLib.FilterNone((profile: InteractionProfile) => (profile.id == id), s.profiles);
      forall o | o in after.profiles
        ensures |ProofLib.Filter((other: InteractionProfile) => (other.id == o.id), after.profiles)| == 1
      {
        ProofLib.FilterAppend((other: InteractionProfile) => (other.id == o.id), s.profiles, added);
        if o.id == id { ProofLib.FilterNone((other: InteractionProfile) => (other.id == o.id), s.profiles); }
        else { assert o in s.profiles; }
      }
    }
  }
}
