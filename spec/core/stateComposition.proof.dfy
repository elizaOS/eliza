lemma RankFold(prior: int, v: bool, xs: seq<ProviderDecl>)
  ensures Std.Collections.Seq.FoldLeft((check: RankCheck, p: ProviderDecl) => RankCheck(p.rank, (check.valid && (p.rank > check.prior))), RankCheck(prior, v), xs).valid
    == (v && (forall i :: 0 <= i < |xs| ==> xs[i].rank > prior) && (forall i, j :: 0 <= i < j < |xs| ==> xs[i].rank < xs[j].rank))
  decreases |xs|
{
  if |xs| > 0 {
    RankFold(xs[0].rank, v && xs[0].rank > prior, xs[1..]);
    assert forall i :: 0 < i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma RankedFilter(f: ProviderDecl -> bool, xs: seq<ProviderDecl>)
  requires forall i, j :: 0 <= i < j < |xs| ==> xs[i].rank < xs[j].rank
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(f, xs)| ==> ProofLib.Filter(f, xs)[i].rank < ProofLib.Filter(f, xs)[j].rank
{
  if |xs| > 0 {
    ProofLib.FilterCons(f, xs);
    assert forall i, j :: 0 <= i < j < |xs[1..]| ==> xs[1..][i].rank < xs[1..][j].rank;
    RankedFilter(f, xs[1..]);
    var rest := ProofLib.Filter(f, xs[1..]);
    ProofLib.FilterSubset(f, xs[1..]);
    assert forall k :: 0 <= k < |rest| ==> rest[k].rank > xs[0].rank;
  }
}

lemma registerProvider_ensures(s: Composition, provider: ProviderDecl)
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> alwaysRegistryInDeclaredOrder(registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> alwaysSegmentsInDeclaredOrder(registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> alwaysSegmentsAdmitTheCaller(registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> alwaysCacheReusedIffUnchanged(registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> alwaysDispatchDiagnosticsDescribeTheSegments(registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> stepComposeIncludesEveryAdmittedProvider(s, "registerProvider", registerProvider(s, provider)))
  ensures (inv(s) ==> canRegisterProvider(s, provider) ==> stepDispatchNeverTruncates(s, "registerProvider", registerProvider(s, provider)))
{
  if inv(s) && canRegisterProvider(s, provider) {
    var after := registerProvider(s, provider);
    var lt := (p: ProviderDecl) => (p.rank < provider.rank);
    var gt := (p: ProviderDecl) => (p.rank > provider.rank);
    var a := ProofLib.Filter(lt, s.providers);
    var b := ProofLib.Filter(gt, s.providers);
    assert after.providers == a + [provider] + b;
    RankFold(-1, true, s.providers);
    RankedFilter(lt, s.providers);
    RankedFilter(gt, s.providers);
    ProofLib.FilterSubset(lt, s.providers);
    ProofLib.FilterSubset(gt, s.providers);
    forall k | 0 <= k < |a| ensures a[k].rank < provider.rank && a[k].rank >= 0 { ProofLib.FilterMember(lt, s.providers, a[k]); }
    forall k | 0 <= k < |b| ensures b[k].rank > provider.rank { ProofLib.FilterMember(gt, s.providers, b[k]); }
    var c := after.providers;
    assert forall i :: 0 <= i < |c| ==> c[i].rank > -1;
    assert forall i, j :: 0 <= i < j < |c| ==> c[i].rank < c[j].rank;
    RankFold(-1, true, c);
    assert forall p :: p in c ==> p.rank >= 0;
  }
}

lemma compose_ensures(s: Composition, role: int)
  ensures (inv(s) ==> canCompose(s, role) ==> alwaysRegistryInDeclaredOrder(compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> alwaysSegmentsInDeclaredOrder(compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> alwaysSegmentsAdmitTheCaller(compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> alwaysCacheReusedIffUnchanged(compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> alwaysDispatchDiagnosticsDescribeTheSegments(compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> stepComposeIncludesEveryAdmittedProvider(s, "compose", compose(s, role)))
  ensures (inv(s) ==> canCompose(s, role) ==> stepDispatchNeverTruncates(s, "compose", compose(s, role)))
{
  if inv(s) && canCompose(s, role) {
    var after := compose(s, role);
    var f := (p: ProviderDecl) => (p.minRole <= role);
    var c := ProofLib.Filter(f, s.providers);
    assert after.segments == c;
    RankFold(-1, true, s.providers);
    RankedFilter(f, s.providers);
    ProofLib.FilterSubset(f, s.providers);
    assert forall i :: 0 <= i < |c| ==> c[i].rank > -1;
    RankFold(-1, true, c);
  }
}
