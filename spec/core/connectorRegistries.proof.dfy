lemma RegistriesFilters(s: ConnectorRegistries)
  ensures alwaysRegistryKeysUnique(s) == ((forall source :: source in s.sources ==> |ProofLib.Filter((other: TargetSource) => (other.platform == source.platform), s.sources)| == 1) && (forall profile :: profile in s.profiles ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == profile.id), s.profiles)| == 1))
{}

lemma RegistrySourcesDistinct(rows: seq<TargetSource>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: TargetSource) => (other.platform == row.platform), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: TargetSource) => row.platform)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: TargetSource) => (other.platform == row.platform), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].platform != rows[j].platform
    {
      ProofLib.FilterCountOneIffUnique((other: TargetSource) => (other.platform == rows[i].platform), rows, (row: TargetSource) => row.platform, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: TargetSource) => row.platform) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: TargetSource) => (other.platform == row.platform), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: TargetSource) => (other.platform == row.platform), rows, i);
    }
  }
}

lemma RegistryProfilesDistinct(rows: seq<InteractionProfile>)
  ensures (forall row :: row in rows ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == row.id), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: InteractionProfile) => row.id)
{
  if forall row :: row in rows ==> |ProofLib.Filter((other: InteractionProfile) => (other.id == row.id), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].id != rows[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: InteractionProfile) => (other.id == rows[i].id), rows, (row: InteractionProfile) => row.id, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: InteractionProfile) => row.id) {
    forall row | row in rows
      ensures |ProofLib.Filter((other: InteractionProfile) => (other.id == row.id), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == row;
      ProofLib.FilterOne((other: InteractionProfile) => (other.id == row.id), rows, i);
    }
  }
}

lemma RegistryUnregisterParts(s: ConnectorRegistries, platform: string)
  ensures unregisterSource(s, platform) == s.(sources := ProofLib.Filter((source: TargetSource) => (source.platform != platform), s.sources))
{}

lemma RegistryProfileParts(s: ConnectorRegistries, id: string, fingerprint: string, body: string)
  ensures registerProfile(s, id, fingerprint, body) ==
    (var existing := ProofLib.Filter((profile: InteractionProfile) => (profile.id == id), s.profiles);
     var collision := exists profile :: profile in existing && profile.fingerprint != fingerprint;
     s.(profiles := if |existing| == 0 then s.profiles + [InteractionProfile(id, fingerprint, body)] else s.profiles, profileCollision := collision, returnedReference := if collision then s.returnedReference else s.returnedReference + 1))
{}

lemma unregisterSource_ensures(s: ConnectorRegistries, platform: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(unregisterSource(s, platform)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, unregisterSource(s, platform)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "unregisterSource", unregisterSource(s, platform)))
{
  if inv(s) {
    var after := unregisterSource(s, platform);
    RegistriesFilters(s);
    RegistriesFilters(after);
    RegistrySourcesDistinct(s.sources);
    RegistryUnregisterParts(s, platform);
    ProofLib.FilterKeepsDistinctBy((source: TargetSource) => (source.platform != platform), s.sources, (row: TargetSource) => row.platform);
    RegistrySourcesDistinct(after.sources);
  }
}

lemma registerSource_ensures(s: ConnectorRegistries, platform: string, reference: int)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerSource(s, platform, reference)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerSource", registerSource(s, platform, reference)))
{
  if inv(s) {
    var after := registerSource(s, platform, reference);
    RegistriesFilters(s);
    RegistriesFilters(after);
    RegistrySourcesDistinct(s.sources);
    if exists source :: source in s.sources && source.platform == platform {
      assert |after.sources| == |s.sources|;
      forall i, j | 0 <= i < |after.sources| && 0 <= j < |after.sources| && i != j
        ensures after.sources[i].platform != after.sources[j].platform
      {
        assert after.sources[i].platform == s.sources[i].platform;
        assert after.sources[j].platform == s.sources[j].platform;
      }
    } else {
      ProofLib.DistinctByConcat(s.sources, [TargetSource(platform, reference)], (row: TargetSource) => row.platform);
    }
    RegistrySourcesDistinct(after.sources);
  }
}

lemma registerProfile_ensures(s: ConnectorRegistries, id: string, fingerprint: string, body: string)
  ensures (inv(s) ==> alwaysRegistryKeysUnique(registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepProfilesNeverReplace(s, registerProfile(s, id, fingerprint, body)))
  ensures (inv(s) ==> stepSourceStopLeavesProfiles(s, "registerProfile", registerProfile(s, id, fingerprint, body)))
{
  if inv(s) {
    var after := registerProfile(s, id, fingerprint, body);
    RegistriesFilters(s);
    RegistriesFilters(after);
    RegistryProfilesDistinct(s.profiles);
    RegistryProfileParts(s, id, fingerprint, body);
    var matching := ProofLib.Filter((profile: InteractionProfile) => (profile.id == id), s.profiles);
    if |matching| == 0 {
      forall profile | profile in s.profiles ensures profile.id != id {
        ProofLib.FilterMember((profile: InteractionProfile) => (profile.id == id), s.profiles, profile);
      }
      ProofLib.DistinctByConcat(s.profiles, [InteractionProfile(id, fingerprint, body)], (row: InteractionProfile) => row.id);
    }
    RegistryProfilesDistinct(after.profiles);
  }
}
