lemma HostKeysDiffer(a: string, b: string)
  requires a != b
  ensures ("$" + a) != ("$" + b)
{
  assert ("$" + a)[1..] == a && ("$" + b)[1..] == b;
}

lemma HostCredentialFilters(m: HostModels)
  ensures alwaysOneCredentialPerProfile(m) == (forall c :: c in m.credentials ==> c.key > 0 && |ProofLib.Filter((d: Credential) => (d.profile == c.profile), m.credentials)| == 1)
{}

lemma HostCredentialsDistinct(xs: seq<Credential>)
  ensures (forall c :: c in xs ==> |ProofLib.Filter((d: Credential) => (d.profile == c.profile), xs)| == 1) <==> ProofLib.DistinctBy(xs, (c: Credential) => c.profile)
{
  if forall c :: c in xs ==> |ProofLib.Filter((d: Credential) => (d.profile == c.profile), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].profile != xs[j].profile
    {
      ProofLib.FilterCountOneIffUnique((d: Credential) => (d.profile == xs[i].profile), xs, (c: Credential) => c.profile, i);
    }
  } else if ProofLib.DistinctBy(xs, (c: Credential) => c.profile) {
    forall c | c in xs
      ensures |ProofLib.Filter((d: Credential) => (d.profile == c.profile), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == c;
      ProofLib.FilterOne((d: Credential) => (d.profile == c.profile), xs, i);
    }
  }
}

lemma HostCredentialsKept(m: HostModels, profile: string)
  requires alwaysOneCredentialPerProfile(m)
  ensures alwaysOneCredentialPerProfile(m.(credentials := ProofLib.Filter((c: Credential) => (c.profile != profile), m.credentials)))
  ensures forall c :: c in ProofLib.Filter((c: Credential) => (c.profile != profile), m.credentials) <==> c in m.credentials && c.profile != profile
{
  var kept := ProofLib.Filter((c: Credential) => (c.profile != profile), m.credentials);
  HostCredentialFilters(m);
  HostCredentialsDistinct(m.credentials);
  ProofLib.FilterKeepsDistinctBy((c: Credential) => (c.profile != profile), m.credentials, (c: Credential) => c.profile);
  HostCredentialsDistinct(kept);
  forall c ensures c in kept <==> c in m.credentials && c.profile != profile {
    ProofLib.FilterMember((c: Credential) => (c.profile != profile), m.credentials, c);
  }
  HostCredentialFilters(m.(credentials := kept));
}

lemma HostKeyOf(xs: seq<Credential>, profile: string, init: int)
  ensures (exists c :: c in xs && c.profile == profile) ==> Credential(profile, Std.Collections.Seq.FoldLeft((found: int, c: Credential) => (if (c.profile == profile) then c.key else found), init, xs)) in xs
  ensures !(exists c :: c in xs && c.profile == profile) ==> Std.Collections.Seq.FoldLeft((found: int, c: Credential) => (if (c.profile == profile) then c.key else found), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    HostKeyOf(xs[1..], profile, if (xs[0].profile == profile) then xs[0].key else init);
    assert xs == [xs[0]] + xs[1..];
    if xs[0].profile == profile && !(exists c :: c in xs[1..] && c.profile == profile) {
      assert Credential(profile, xs[0].key) == xs[0];
    }
  }
}

lemma removeModel_ensures(m: HostModels, modelId: string)
  ensures (inv(m) ==> canRemoveModel(m, modelId) ==> alwaysActiveLocalIsInstalled(removeModel(m, modelId)))
  ensures (inv(m) ==> canRemoveModel(m, modelId) ==> alwaysOneCredentialPerProfile(removeModel(m, modelId)))
  ensures (inv(m) ==> canRemoveModel(m, modelId) ==> alwaysDirectProviderHasCredential(removeModel(m, modelId)))
{
  if inv(m) && canRemoveModel(m, modelId) {
    var after := removeModel(m, modelId);
    if after.local.active != "" {
      assert m.local.active != modelId;
      HostKeysDiffer(m.local.active, modelId);
      assert localInference__models_modelOf(after.local, m.local.active) == localInference__models_modelOf(m.local, m.local.active);
    }
  }
}

lemma storeCredential_ensures(m: HostModels, profile: string, key: int)
  ensures (inv(m) ==> canStoreCredential(m, profile, key) ==> alwaysActiveLocalIsInstalled(storeCredential(m, profile, key)))
  ensures (inv(m) ==> canStoreCredential(m, profile, key) ==> alwaysOneCredentialPerProfile(storeCredential(m, profile, key)))
  ensures (inv(m) ==> canStoreCredential(m, profile, key) ==> alwaysDirectProviderHasCredential(storeCredential(m, profile, key)))
{
  if inv(m) && canStoreCredential(m, profile, key) {
    var after := storeCredential(m, profile, key);
    var kept := ProofLib.Filter((c: Credential) => (c.profile != profile), m.credentials);
    assert after.credentials == kept + [Credential(profile, key)];
    HostCredentialsKept(m, profile);
    HostCredentialFilters(m.(credentials := kept));
    HostCredentialsDistinct(kept);
    ProofLib.DistinctByConcat(kept, [Credential(profile, key)], (c: Credential) => c.profile);
    HostCredentialsDistinct(after.credentials);
    HostCredentialFilters(after);
  }
}

lemma revokeCredential_ensures(m: HostModels, profile: string)
  ensures (inv(m) ==> canRevokeCredential(m, profile) ==> alwaysActiveLocalIsInstalled(revokeCredential(m, profile)))
  ensures (inv(m) ==> canRevokeCredential(m, profile) ==> alwaysOneCredentialPerProfile(revokeCredential(m, profile)))
  ensures (inv(m) ==> canRevokeCredential(m, profile) ==> alwaysDirectProviderHasCredential(revokeCredential(m, profile)))
{
  if inv(m) && canRevokeCredential(m, profile) {
    var after := revokeCredential(m, profile);
    assert after.credentials == ProofLib.Filter((c: Credential) => (c.profile != profile), m.credentials);
    HostCredentialsKept(m, profile);
    HostCredentialFilters(after);
    HostCredentialFilters(m.(credentials := after.credentials));
  }
}

lemma useDirectProvider_ensures(m: HostModels, profile: string)
  ensures (inv(m) ==> canUseDirectProvider(m, profile) ==> alwaysActiveLocalIsInstalled(useDirectProvider(m, profile)))
  ensures (inv(m) ==> canUseDirectProvider(m, profile) ==> alwaysOneCredentialPerProfile(useDirectProvider(m, profile)))
  ensures (inv(m) ==> canUseDirectProvider(m, profile) ==> alwaysDirectProviderHasCredential(useDirectProvider(m, profile)))
{
  if inv(m) && canUseDirectProvider(m, profile) {
    HostKeyOf(m.credentials, profile, 0);
  }
}
