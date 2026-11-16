lemma ResponseEvaluatorNameCounts(s: ResponseEvaluation)
  ensures alwaysExactNamesUnique(s) ==
    (forall entry :: entry in s.registered ==> |ProofLib.Filter((other: RegisteredEvaluator) => other.name == entry.name, s.registered)| == 1)
{}

lemma ResponseSameEvidence(s: ResponseEvaluation, after: ResponseEvaluation, via: string)
  requires s.plan.sourceContext == after.plan.sourceContext
  requires s.plan.priorReceipts == after.plan.priorReceipts
  ensures stepOriginalSourceContextSurvives(s, via, after)
{}

lemma settleEligibility_ensures(s: ResponseEvaluation, decision: Decision)
  ensures (inv(s) ==> canSettleEligibility(s) ==> alwaysExactNamesUnique(settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> alwaysAwaitOwnsCandidate(settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepRegistrationKeepsPriorNames(s, "settleEligibility", settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepRegistrationAffectsOnlyNextSnapshot(s, "settleEligibility", settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepCancellationIsTerminal(s, settleEligibility(s, decision)))
  ensures (inv(s) ==> canSettleEligibility(s) ==> stepOriginalSourceContextSurvives(s, "settleEligibility", settleEligibility(s, decision)))
{
  if inv(s) && canSettleEligibility(s) {
    var after := settleEligibility(s, decision);
    ResponseSameEvidence(s, after, "settleEligibility");
    assert after.registered == s.registered;
    ResponseEvaluatorNameCounts(s);
    ResponseEvaluatorNameCounts(after);
  }
}

lemma settleEvaluation_ensures(s: ResponseEvaluation, receipt: PatchReceipt)
  ensures (inv(s) ==> canSettleEvaluation(s) ==> alwaysExactNamesUnique(settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> alwaysAwaitOwnsCandidate(settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepRegistrationKeepsPriorNames(s, "settleEvaluation", settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepRegistrationAffectsOnlyNextSnapshot(s, "settleEvaluation", settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepCancellationIsTerminal(s, settleEvaluation(s, receipt)))
  ensures (inv(s) ==> canSettleEvaluation(s) ==> stepOriginalSourceContextSurvives(s, "settleEvaluation", settleEvaluation(s, receipt)))
{
  if inv(s) && canSettleEvaluation(s) {
    var after := settleEvaluation(s, receipt);
    ResponseSameEvidence(s, after, "settleEvaluation");
    assert after.registered == s.registered;
    ResponseEvaluatorNameCounts(s);
    ResponseEvaluatorNameCounts(after);
  }
}

lemma unregister_ensures(s: ResponseEvaluation, normalizedName: string)
  ensures (inv(s) ==> alwaysExactNamesUnique(unregister(s, normalizedName)))
  ensures (inv(s) ==> alwaysAwaitOwnsCandidate(unregister(s, normalizedName)))
  ensures (inv(s) ==> stepRegistrationKeepsPriorNames(s, "unregister", unregister(s, normalizedName)))
  ensures (inv(s) ==> stepRegistrationAffectsOnlyNextSnapshot(s, "unregister", unregister(s, normalizedName)))
  ensures (inv(s) ==> stepCancellationIsTerminal(s, unregister(s, normalizedName)))
  ensures (inv(s) ==> stepOriginalSourceContextSurvives(s, "unregister", unregister(s, normalizedName)))
{
  if inv(s) {
    var after := unregister(s, normalizedName);
    ResponseSameEvidence(s, after, "unregister");
    if normalizedName != "" {
      var keep := (entry: RegisteredEvaluator) => entry.name != normalizedName;
      assert after.registered == ProofLib.Filter(keep, s.registered);
      ResponseEvaluatorNameCounts(s);
      ResponseEvaluatorNameCounts(after);
      forall entry | entry in after.registered
        ensures |ProofLib.Filter((other: RegisteredEvaluator) => other.name == entry.name, after.registered)| == 1
      {
        var sameName := (other: RegisteredEvaluator) => other.name == entry.name;
        ProofLib.FilterMember(keep, s.registered, entry);
        ProofLib.FilterOfFilterShorter(keep, sameName, s.registered);
        ProofLib.FilterMember(sameName, after.registered, entry);
      }
    }
  }
}

lemma register_ensures(s: ResponseEvaluation, registration: RegisteredEvaluator)
  ensures (inv(s) ==> canRegister(s, registration) ==> alwaysExactNamesUnique(register(s, registration)))
  ensures (inv(s) ==> canRegister(s, registration) ==> alwaysAwaitOwnsCandidate(register(s, registration)))
  ensures (inv(s) ==> canRegister(s, registration) ==> stepRegistrationKeepsPriorNames(s, "register", register(s, registration)))
  ensures (inv(s) ==> canRegister(s, registration) ==> stepRegistrationAffectsOnlyNextSnapshot(s, "register", register(s, registration)))
  ensures (inv(s) ==> canRegister(s, registration) ==> stepCancellationIsTerminal(s, register(s, registration)))
  ensures (inv(s) ==> canRegister(s, registration) ==> stepOriginalSourceContextSurvives(s, "register", register(s, registration)))
{
  if inv(s) && canRegister(s, registration) {
    var after := register(s, registration);
    ResponseSameEvidence(s, after, "register");
    if !(exists entry :: entry in s.registered && entry.name == registration.name) {
      assert after.registered == s.registered + [registration];
      ResponseEvaluatorNameCounts(s);
      ResponseEvaluatorNameCounts(after);
      forall entry | entry in after.registered
        ensures |ProofLib.Filter((other: RegisteredEvaluator) => other.name == entry.name, after.registered)| == 1
      {
        var sameName := (other: RegisteredEvaluator) => other.name == entry.name;
        ProofLib.FilterAppend(sameName, s.registered, registration);
        if entry == registration {
          ProofLib.FilterNone(sameName, s.registered);
        } else {
          assert entry in s.registered;
          assert entry.name != registration.name;
        }
      }
    }
  }
}
