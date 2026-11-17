lemma useCloudKey_ensures(f: FirstRun)
  ensures (inv(f) ==> canUseCloudKey(f) ==> alwaysCompletedHasBackend(useCloudKey(f)))
  ensures (inv(f) ==> canUseCloudKey(f) ==> stepFirstRunNeverGoesBack(f, useCloudKey(f)))
  ensures (inv(f) ==> canUseCloudKey(f) ==> stepCloudKeyNeedsNoRestart(f, "useCloudKey", useCloudKey(f)))
{
  if inv(f) && canUseCloudKey(f) {
    KeyOfFound(f.models.credentials, cloudProfile, 0);
  }
}

lemma provideCloudKey_ensures(f: FirstRun, key: int)
  ensures (inv(f) ==> canProvideCloudKey(f, key) ==> alwaysCompletedHasBackend(provideCloudKey(f, key)))
  ensures (inv(f) ==> canProvideCloudKey(f, key) ==> stepFirstRunNeverGoesBack(f, provideCloudKey(f, key)))
  ensures (inv(f) ==> canProvideCloudKey(f, key) ==> stepCloudKeyNeedsNoRestart(f, "provideCloudKey", provideCloudKey(f, key)))
{
  if inv(f) && canProvideCloudKey(f, key) {
    var m := f.models;
    var after := provideCloudKey(f, key).models;
    var x := agent__host__models_Credential(cloudProfile, key);
    var keep := (c: agent__host__models_Credential) => (c.profile != cloudProfile);
    var kept := ProofLib.Filter(keep, m.credentials);
    StoredCredentials(m, cloudProfile, key);
    assert after.credentials == kept + [x];
    forall c | c in kept ensures c in m.credentials && c.profile != cloudProfile {
      ProofLib.FilterMember(keep, m.credentials, c);
    }
    OnePerProfile(m);
    OnePerProfile(after);
    ProofLib.FilterKeepsDistinctBy(keep, m.credentials, (c: agent__host__models_Credential) => c.profile);
    ProofLib.DistinctByConcat(kept, [x], (c: agent__host__models_Credential) => c.profile);
    if m.backend.DirectBackend? && m.profile != cloudProfile {
      ProofLib.FilterMember(keep, m.credentials, agent__host__models_Credential(m.profile, m.activeKey));
    }
    assert x in after.credentials;
    ProofLib.FoldLeftAppend((found: int, c: agent__host__models_Credential) => (if (c.profile == cloudProfile) then c.key else found), 0, kept, x);
  }
}

lemma StoredCredentials(m: agent__host__models_HostModels, profile: string, key: int)
  ensures agent__host__models_storeCredential(m, profile, key).credentials == ProofLib.Filter((c: agent__host__models_Credential) => (c.profile != profile), m.credentials) + [agent__host__models_Credential(profile, key)]
{
}

lemma OneBridge(m: agent__host__models_HostModels)
  ensures agent__host__models_alwaysOneCredentialPerProfile(m) == !((exists c :: c in m.credentials && !(((c.key > 0) && (|ProofLib.Filter((d: agent__host__models_Credential) => (d.profile == c.profile), m.credentials)| == 1)))))
{
}

lemma OnePerProfile(m: agent__host__models_HostModels)
  ensures agent__host__models_alwaysOneCredentialPerProfile(m) <==> ((forall c :: c in m.credentials ==> c.key > 0) && ProofLib.DistinctBy(m.credentials, (c: agent__host__models_Credential) => c.profile))
{
  OneBridge(m);
  forall i | 0 <= i < |m.credentials| ensures |ProofLib.Filter((d: agent__host__models_Credential) => (d.profile == m.credentials[i].profile), m.credentials)| == 1 <==> forall j :: 0 <= j < |m.credentials| && j != i ==> m.credentials[j].profile != m.credentials[i].profile {
    ProofLib.FilterCountOneIffUnique((d: agent__host__models_Credential) => (d.profile == m.credentials[i].profile), m.credentials, (c: agent__host__models_Credential) => c.profile, i);
  }
}

lemma KeyOfFound(xs: seq<agent__host__models_Credential>, profile: string, init: int)
  ensures (forall c :: c in xs ==> c.profile != profile) ==> Std.Collections.Seq.FoldLeft((found: int, c: agent__host__models_Credential) => (if (c.profile == profile) then c.key else found), init, xs) == init
  ensures (exists c :: c in xs && c.profile == profile) ==> agent__host__models_Credential(profile, Std.Collections.Seq.FoldLeft((found: int, c: agent__host__models_Credential) => (if (c.profile == profile) then c.key else found), init, xs)) in xs
  decreases |xs|
{
  if |xs| > 0 {
    KeyOfFound(xs[1..], profile, (if (xs[0].profile == profile) then xs[0].key else init));
    assert forall c :: c in xs[1..] ==> c in xs;
    assert forall c :: c in xs ==> c == xs[0] || c in xs[1..];
  }
}
