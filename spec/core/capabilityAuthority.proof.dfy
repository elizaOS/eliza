lemma AuthorityMintFilter(s: Authority, by_: AuthorityCaller, authorizationId: string)
  ensures finishAuthorization(s, by_, authorizationId).authenticObjects == (if (s.now >= s.startedAt && s.now < s.policy.expiresAt) && (!s.grantPresent || s.now < s.grant.expiresAt) then s.authenticObjects + ProofLib.Filter((set_x: int) => !((set_x in s.authenticObjects)), [s.nextObject]) else s.authenticObjects)
{}

lemma AuthorityMintedObjects(s: Authority, by_: AuthorityCaller, authorizationId: string)
  requires |s.authenticObjects| == 0
  ensures ((s.now >= s.startedAt && s.now < s.policy.expiresAt) && (!s.grantPresent || s.now < s.grant.expiresAt)) ==> finishAuthorization(s, by_, authorizationId).authenticObjects == [s.nextObject]
{
  AuthorityMintFilter(s, by_, authorizationId);
  ProofLib.FilterCons((set_x: int) => !((set_x in s.authenticObjects)), [s.nextObject]);
  ProofLib.FilterNil((set_x: int) => !((set_x in s.authenticObjects)), []);
}

lemma finishAuthorization_ensures(s: Authority, by_: AuthorityCaller, authorizationId: string)
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysObjectNumbersAreValid(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysAuthenticObjectIsOriginal(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysOnlyAuthorizedPhaseHoldsObjects(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysDispatchPhasesHaveConsumedPolicy(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysMintRequiresConsumedPolicy(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysAtMostOneAuthorizedObject(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysReceiptUsesAuthenticIdentity(finishAuthorization(s, by_, authorizationId)))
  ensures (inv(s) ==> canFinishAuthorization(s, by_, authorizationId) ==> alwaysAcceptedReceiptHasExactBindings(finishAuthorization(s, by_, authorizationId)))
{
  if inv(s) && canFinishAuthorization(s, by_, authorizationId) {
    assert s.phase.Consuming?;
    assert |s.authenticObjects| == 0;
    assert s.decisionConsumed;
    assert !s.receiptAccepted;
    AuthorityMintedObjects(s, by_, authorizationId);
  }
}
