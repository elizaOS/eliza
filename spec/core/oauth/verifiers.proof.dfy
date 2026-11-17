lemma updateExpiry_ensures(s: OAuthSecrets, provider: string, flowId: string, expiresAt: int)
  ensures (inv(s) ==> alwaysVerifierScopeUnique(updateExpiry(s, provider, flowId, expiresAt)))
  ensures (inv(s) ==> stepRestartDropsVerifiers(s, "updateExpiry", updateExpiry(s, provider, flowId, expiresAt)))
{
  if inv(s) {
    var after := updateExpiry(s, provider, flowId, expiresAt);
    ScopeBridge(s);
    ScopeBridge(after);
    assert forall i :: 0 <= i < |s.entries| ==> (after.entries[i].provider, after.entries[i].flowId) == (s.entries[i].provider, s.entries[i].flowId);
  }
}

lemma removeVerifier_ensures(s: OAuthSecrets, provider: string, flowId: string)
  ensures (inv(s) ==> alwaysVerifierScopeUnique(removeVerifier(s, provider, flowId)))
  ensures (inv(s) ==> stepRestartDropsVerifiers(s, "removeVerifier", removeVerifier(s, provider, flowId)))
{
  if inv(s) {
    ScopeBridge(s);
    ScopeBridge(removeVerifier(s, provider, flowId));
    ProofLib.FilterKeepsDistinctBy((entry: Verifier) => ((entry.provider != provider) || (entry.flowId != flowId)), s.entries, (v: Verifier) => (v.provider, v.flowId));
  }
}

lemma storeVerifier_ensures(s: OAuthSecrets, provider: string, flowId: string, secretId: string, hasExpiry: bool, expiresAt: int)
  ensures (inv(s) ==> canStoreVerifier(s, secretId) ==> alwaysVerifierScopeUnique(storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt)))
  ensures (inv(s) ==> canStoreVerifier(s, secretId) ==> stepRestartDropsVerifiers(s, "storeVerifier", storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt)))
{
  if inv(s) && canStoreVerifier(s, secretId) {
    var keep := (entry: Verifier) => (((!(entry.hasExpiry) || (entry.expiresAt == 0)) || (entry.expiresAt > s.now)) && ((entry.provider != provider) || (entry.flowId != flowId)));
    var kept := ProofLib.Filter(keep, s.entries);
    var added := Verifier(provider, flowId, secretId, hasExpiry, expiresAt);
    ScopeBridge(s);
    ScopeBridge(storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt));
    ProofLib.FilterKeepsDistinctBy(keep, s.entries, (v: Verifier) => (v.provider, v.flowId));
    forall x | x in kept ensures (x.provider, x.flowId) != (provider, flowId) {
      ProofLib.FilterMember(keep, s.entries, x);
    }
    ProofLib.DistinctByConcat(kept, [added], (v: Verifier) => (v.provider, v.flowId));
  }
}

lemma ScopeBridge(s: OAuthSecrets)
  ensures alwaysVerifierScopeUnique(s) <==> ProofLib.DistinctBy(s.entries, (v: Verifier) => (v.provider, v.flowId))
{
  var es := s.entries;
  assert alwaysVerifierScopeUnique(s) <==> forall entry :: entry in es ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), es)| == 1;
  forall i | 0 <= i < |es|
    ensures |ProofLib.Filter((other: Verifier) => ((other.provider == es[i].provider) && (other.flowId == es[i].flowId)), es)| == 1 <==> forall j :: 0 <= j < |es| && j != i ==> (es[j].provider, es[j].flowId) != (es[i].provider, es[i].flowId)
  {
    ProofLib.FilterCountOneIffUnique((other: Verifier) => ((other.provider == es[i].provider) && (other.flowId == es[i].flowId)), es, (v: Verifier) => (v.provider, v.flowId), i);
  }
  if ProofLib.DistinctBy(es, (v: Verifier) => (v.provider, v.flowId)) {
    forall entry | entry in es ensures |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), es)| == 1 {
      var i :| 0 <= i < |es| && es[i] == entry;
    }
  }
}
