lemma lawOnlyAllowedRegisteredActionsAreOffered_ensures(registered: seq<string>, allowed: seq<string>, formless: seq<string>)
  ensures (lawOnlyAllowedRegisteredActionsAreOffered(registered, allowed, formless) == true)
{
  var permitted := ProofLib.Filter((set_x: string) => (set_x in allowed), registered);
  var advertised := ProofLib.Filter((set_x: string) => !((set_x in messageServiceActions)), permitted);
  var visible := ProofLib.Filter((set_x: string) => !((set_x in formless)), advertised);
  assert visible == offered(registered, allowed, formless);
  forall entry | entry in visible
    ensures entry in allowed && entry in registered && entry !in messageServiceActions
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in formless)), advertised, entry);
    ProofLib.FilterMember((set_x: string) => !((set_x in messageServiceActions)), permitted, entry);
    ProofLib.FilterMember((set_x: string) => (set_x in allowed), registered, entry);
  }
  assert "REPLY" in messageServiceActions;
}

lemma lawNamedFieldsAreNeverUnexpected_ensures(namedFields: seq<string>, submittedFields: seq<string>, extraKeys: core__actionPlanning_ExtraKeysChoice)
  ensures (lawNamedFieldsAreNeverUnexpected(namedFields, submittedFields, extraKeys) == true)
{
  var named := ProofLib.Filter((key: string) => key in namedFields, submittedFields);
  var accepted := checkedArgumentKeys(namedFields, submittedFields, extraKeys);
  if core__actionPlanning_acceptsExtraKeys(|namedFields|, extraKeys) {
    forall key | key in named
      ensures key in accepted
    {
      ProofLib.FilterMember((key: string) => key in namedFields, submittedFields, key);
    }
  } else {
    assert named == accepted;
  }
}

lemma lawAnActionWithoutParametersUsesAdditionalKeysSetting_ensures(submittedFields: seq<string>, allowAdditionalParameters: bool)
  ensures (lawAnActionWithoutParametersUsesAdditionalKeysSetting(submittedFields, allowAdditionalParameters) == true)
{
  if !allowAdditionalParameters {
    var noFields: seq<string> := [];
    ProofLib.FilterNone((key: string) => key in noFields, submittedFields);
  }
}

lemma lawOnlyTheCueIsRemovedFromActionFields_ensures(submittedFields: seq<string>)
  ensures (lawOnlyTheCueIsRemovedFromActionFields(submittedFields) == true)
{
  var accepted := actionArgumentKeys(submittedFields);
  ProofLib.FilterMember((key: string) => key !in ["cue"], submittedFields, "cue");
  assert "cue" !in accepted;
  forall key | key in submittedFields && key != "cue"
    ensures key in accepted
  {
    ProofLib.FilterMember((key: string) => key !in ["cue"], submittedFields, key);
  }
}

lemma lawTheLatestFailureIsReported_ensures(steps: seq<PlanStep>, earlier: PlanStep)
  ensures (lawTheLatestFailureIsReported(steps, earlier) == true)
{
  if earlier.outcome.Failed? {
    PlanningFoldAppend(steps, earlier);
    assert earlier in openOutcomes(steps + [earlier]);
    PlanningFailureMembership(steps + [earlier], earlier);
  }
}

lemma lawASuccessOfTheSameOperationSupersedes_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawASuccessOfTheSameOperationSupersedes(steps, earlier, later) == true)
{
  if supersedes(later, earlier) {
    PlanningFoldAppend(steps + [earlier], later);
    assert steps + [earlier] + [later] == steps + [earlier, later];
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(later, p)), openOutcomes(steps + [earlier]), earlier);
    assert earlier !in settleStep(openOutcomes(steps + [earlier]), later);
  }
}

lemma lawASuccessOfAnotherOperationKeepsTheFailure_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawASuccessOfAnotherOperationKeepsTheFailure(steps, earlier, later) == true)
{
  if earlier.outcome.Failed? && later.identity != earlier.identity {
    PlanningKeepsOpen(steps, earlier, later);
    PlanningFailureMembership(steps + [earlier, later], earlier);
  }
}

lemma lawARefusalBeforeDispatchStaysReported_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawARefusalBeforeDispatchStaysReported(steps, earlier, later) == true)
{
  if earlier.outcome.Rejected? {
    if later.identity == earlier.identity && later.outcome.Rejected? {
      assert later == earlier;
    }
    PlanningKeepsOpen(steps, earlier, later);
    PlanningFailureMembership(steps + [earlier, later], earlier);
  }
}

lemma PlanningFoldAppend(steps: seq<PlanStep>, entry: PlanStep)
  ensures openOutcomes(steps + [entry]) == settleStep(openOutcomes(steps), entry)
{
  ProofLib.FoldLeftAppend((held: seq<PlanStep>, entry: PlanStep) => settleStep(held, entry), [], steps, entry);
}

lemma PlanningFailureMembership(steps: seq<PlanStep>, entry: PlanStep)
  ensures entry in failedOpen(steps) <==> entry in openOutcomes(steps) && (entry.outcome.Failed? || entry.outcome.Rejected?)
{
  ProofLib.FilterMember((p: PlanStep) => (p.outcome.Failed? || p.outcome.Rejected?), openOutcomes(steps), entry);
}

lemma PlanningKeepsOpen(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  requires opens(earlier.outcome)
  requires !supersedes(later, earlier)
  requires !opens(later.outcome) || earlier == later || earlier.identity != later.identity || earlier.outcome.Rejected? != later.outcome.Rejected?
  ensures earlier in openOutcomes(steps + [earlier, later])
{
  PlanningFoldAppend(steps, earlier);
  PlanningFoldAppend(steps + [earlier], later);
  assert steps + [earlier] + [later] == steps + [earlier, later];
  var held := openOutcomes(steps + [earlier]);
  assert earlier in held;
  if opens(later.outcome) {
    if earlier != later {
      ProofLib.FilterMember((p: PlanStep) => ((p.identity != later.identity) || (p.outcome.Rejected? != later.outcome.Rejected?)), held, earlier);
    }
  } else {
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(later, p)), held, earlier);
  }
}

lemma lawANarrowedSchemaForAnUnregisteredParameterIsDropped_ensures(params: seq<string>, narrowed: seq<string>)
  ensures (lawANarrowedSchemaForAnUnregisteredParameterIsDropped(params, narrowed) == true)
{
  PlanNarrowedFilter(params, narrowed);
  forall p | p in narrowed && !(p in params)
    ensures !(p in turnNarrowed(params, narrowed))
  {
    ProofLib.FilterMember((set_x: string) => (set_x in narrowed), params, p);
  }
}

lemma lawARegisteredParameterTheTurnNamesIsNarrowed_ensures(params: seq<string>, narrowed: seq<string>)
  ensures (lawARegisteredParameterTheTurnNamesIsNarrowed(params, narrowed) == true)
{
  PlanNarrowedFilter(params, narrowed);
  forall p | p in params && p in narrowed
    ensures p in turnNarrowed(params, narrowed)
  {
    ProofLib.FilterMember((set_x: string) => (set_x in narrowed), params, p);
  }
}

lemma PlanNarrowedFilter(params: seq<string>, narrowed: seq<string>)
  ensures turnNarrowed(params, narrowed) == ProofLib.Filter((set_x: string) => (set_x in narrowed), params)
{
}

