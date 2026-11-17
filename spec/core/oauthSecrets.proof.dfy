lemma SecretFiltered(xs: seq<Verifier>, keeps: Verifier -> bool)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs)| == 1
  ensures forall entry :: entry in ProofLib.Filter(keeps, xs) ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), ProofLib.Filter(keeps, xs))| == 1
{
  forall entry | entry in ProofLib.Filter(keeps, xs) ensures |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), ProofLib.Filter(keeps, xs))| == 1 {
    ProofLib.FilterMember(keeps, xs, entry);
    ProofLib.FilterOfFilterLength(keeps, (other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), (other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs);
    ProofLib.FilterMember((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), ProofLib.Filter(keeps, xs), entry);
  }
}

lemma SecretAppend(xs: seq<Verifier>, added: Verifier)
  requires forall entry :: entry in xs ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs)| == 1
  requires forall entry :: entry in xs ==> !((entry.provider == added.provider) && (entry.flowId == added.flowId))
  ensures forall entry :: entry in xs + [added] ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs + [added])| == 1
{
  forall entry | entry in xs + [added] ensures |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs + [added])| == 1 {
    ProofLib.FilterAppend((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs, added);
    if entry == added { ProofLib.FilterNone((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), xs); } else { assert entry in xs; }
  }
}

lemma SecretMapped(before: seq<Verifier>, after: seq<Verifier>)
  requires forall entry :: entry in before ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), before)| == 1
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].provider == after[i].provider && before[i].flowId == after[i].flowId
  ensures forall entry :: entry in after ==> |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), after)| == 1
{
  forall entry | entry in after ensures |ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), after)| == 1 {
    var i :| 0 <= i < |after| && after[i] == entry;
    var prior := before[i];
    assert |ProofLib.Filter((other: Verifier) => ((other.provider == prior.provider) && (other.flowId == prior.flowId)), before)| == 1;
    ProofLib.FilterLengthPointwise((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), (other: Verifier) => ((other.provider == prior.provider) && (other.flowId == prior.flowId)), after, before);
  }
}

lemma SecretAlwaysVerifierScopeUniqueView(s: OAuthSecrets)
  ensures alwaysVerifierScopeUnique(s) == (!((exists entry :: entry in s.entries && !((|ProofLib.Filter((other: Verifier) => ((other.provider == entry.provider) && (other.flowId == entry.flowId)), s.entries)| == 1)))))
{
}

lemma SecretRemoveVerifierView(s: OAuthSecrets, provider: string, flowId: string)
  ensures removeVerifier(s, provider, flowId) == (s.(entries := ProofLib.Filter((entry: Verifier) => ((entry.provider != provider) || (entry.flowId != flowId)), s.entries)))
{
}

lemma SecretStoreVerifierView(s: OAuthSecrets, provider: string, flowId: string, secretId: string, hasExpiry: bool, expiresAt: int)
  ensures storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt) == (s.(entries := (ProofLib.Filter((entry: Verifier) => (((!(entry.hasExpiry) || (entry.expiresAt == 0)) || (entry.expiresAt > s.now)) && ((entry.provider != provider) || (entry.flowId != flowId))), s.entries) + [Verifier(provider, flowId, secretId, hasExpiry, expiresAt)])))
{
}

lemma updateExpiry_ensures(s: OAuthSecrets, provider: string, flowId: string, expiresAt: int)
  ensures (inv(s) ==> alwaysVerifierScopeUnique(updateExpiry(s, provider, flowId, expiresAt)))
  ensures (inv(s) ==> stepRestartDropsVerifiers(s, "updateExpiry", updateExpiry(s, provider, flowId, expiresAt)))
{
  if inv(s) {
    SecretAlwaysVerifierScopeUniqueView(s);
    SecretAlwaysVerifierScopeUniqueView(updateExpiry(s, provider, flowId, expiresAt));
    SecretMapped(s.entries, updateExpiry(s, provider, flowId, expiresAt).entries);
  }
}

lemma removeVerifier_ensures(s: OAuthSecrets, provider: string, flowId: string)
  ensures (inv(s) ==> alwaysVerifierScopeUnique(removeVerifier(s, provider, flowId)))
  ensures (inv(s) ==> stepRestartDropsVerifiers(s, "removeVerifier", removeVerifier(s, provider, flowId)))
{
  if inv(s) {
    SecretRemoveVerifierView(s, provider, flowId);
    SecretAlwaysVerifierScopeUniqueView(s);
    SecretAlwaysVerifierScopeUniqueView(removeVerifier(s, provider, flowId));
    SecretFiltered(s.entries, (entry: Verifier) => ((entry.provider != provider) || (entry.flowId != flowId)));
  }
}

lemma storeVerifier_ensures(s: OAuthSecrets, provider: string, flowId: string, secretId: string, hasExpiry: bool, expiresAt: int)
  ensures (inv(s) ==> canStoreVerifier(s, secretId) ==> alwaysVerifierScopeUnique(storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt)))
  ensures (inv(s) ==> canStoreVerifier(s, secretId) ==> stepRestartDropsVerifiers(s, "storeVerifier", storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt)))
{
  if inv(s) && canStoreVerifier(s, secretId) {
    SecretStoreVerifierView(s, provider, flowId, secretId, hasExpiry, expiresAt);
    SecretAlwaysVerifierScopeUniqueView(s);
    SecretAlwaysVerifierScopeUniqueView(storeVerifier(s, provider, flowId, secretId, hasExpiry, expiresAt));
    var kept := ProofLib.Filter((entry: Verifier) => (((!(entry.hasExpiry) || (entry.expiresAt == 0)) || (entry.expiresAt > s.now)) && ((entry.provider != provider) || (entry.flowId != flowId))), s.entries);
    SecretFiltered(s.entries, (entry: Verifier) => (((!(entry.hasExpiry) || (entry.expiresAt == 0)) || (entry.expiresAt > s.now)) && ((entry.provider != provider) || (entry.flowId != flowId))));
    forall entry | entry in kept ensures entry.provider != provider || entry.flowId != flowId {
      ProofLib.FilterMember((entry: Verifier) => (((!(entry.hasExpiry) || (entry.expiresAt == 0)) || (entry.expiresAt > s.now)) && ((entry.provider != provider) || (entry.flowId != flowId))), s.entries, entry);
    }
    SecretAppend(kept, Verifier(provider, flowId, secretId, hasExpiry, expiresAt));
  }
}
