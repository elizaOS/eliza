lemma ProviderKeysView(d: Deletion)
  ensures alwaysNoProviderKeyIsUsedTwice(d) == !(exists k :: k in d.usedKeys && !(|ProofLib.Filter((j: cloud__shared__types_ProviderKey) => (j == k), d.usedKeys)| == 1))
{
}

lemma prepareCall_ensures(d: Deletion, digest: string, providerKey: cloud__shared__types_ProviderKey, staleAfter: int, expiresAt: int, billingBoundary: BillingBoundary)
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> alwaysEarlierStepsAreFinished(prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> alwaysReceiptBelongsToItsStep(prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> alwaysNoProviderKeyIsUsedTwice(prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> alwaysAttemptsWithinBudget(prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> stepEffectsOnlyAtFenceAndErasure(d, "prepareCall", prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary), []))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> stepStepsAdvanceOneAtATime(d, prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
  ensures (inv(d) ==> canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) ==> stepErasedIsFinal(d, prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary)))
{
  if inv(d) && canPrepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary) {
    var after := prepareCall(d, digest, providerKey, staleAfter, expiresAt, billingBoundary);
    var before := d.usedKeys;
    assert providerKey !in before;
    assert after.usedKeys == before + [providerKey];
    assert providerKey in after.usedKeys;
    assert callBase(d).session.phase.Absent?;
    assert cloud__shared__dispatchOnce_usesProviderKey(after.receipt, providerKey);
    assert exists key :: key in after.usedKeys && cloud__shared__dispatchOnce_usesProviderKey(after.receipt, key);
    ProviderKeysView(d);
    forall k | k in after.usedKeys
      ensures |ProofLib.Filter((j: cloud__shared__types_ProviderKey) => (j == k), after.usedKeys)| == 1
    {
      var matches := (j: cloud__shared__types_ProviderKey) => (j == k);
      if k == providerKey {
        ProofLib.FilterNone(matches, before);
      } else {
        assert k in before;
        assert |ProofLib.Filter(matches, before)| == 1;
      }
      ProofLib.FilterAppend(matches, before, providerKey);
    }
    ProviderKeysView(after);
  }
}
