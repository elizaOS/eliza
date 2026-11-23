lemma lawOnlyAllowedRegisteredActionsAreOffered_ensures(registered: seq<string>, allowed: seq<string>, formless: seq<string>)
  ensures (lawOnlyAllowedRegisteredActionsAreOffered(registered, allowed, formless) == true)
{
  var permitted := ProofLib.Filter((set_x: string) => (set_x in allowed), registered);
  var visible := ProofLib.Filter((set_x: string) => !((set_x in messageServiceActions)), permitted);
  var formed := ProofLib.Filter((set_x: string) => !((set_x in formless)), visible);
  assert formed == offered(registered, allowed, formless);
  forall entry | entry in formed
    ensures entry in allowed && entry in registered && entry !in messageServiceActions
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in formless)), visible, entry);
    ProofLib.FilterMember((set_x: string) => !((set_x in messageServiceActions)), permitted, entry);
    ProofLib.FilterMember((set_x: string) => (set_x in allowed), registered, entry);
  }
  assert "REPLY" in messageServiceActions;
}

lemma lawANarrowedSchemaForAnUnregisteredParameterIsDropped_ensures(params: seq<string>, narrowed: seq<string>)
  ensures (lawANarrowedSchemaForAnUnregisteredParameterIsDropped(params, narrowed) == true)
{
  forall p | p in narrowed && p !in params
    ensures p !in turnNarrowed(params, narrowed)
  {
    ProofLib.FilterMember((set_x: string) => (set_x in narrowed), params, p);
  }
}

lemma lawARegisteredParameterTheTurnNamesIsNarrowed_ensures(params: seq<string>, narrowed: seq<string>)
  ensures (lawARegisteredParameterTheTurnNamesIsNarrowed(params, narrowed) == true)
{
  forall p | p in params && p in narrowed
    ensures p in turnNarrowed(params, narrowed)
  {
    ProofLib.FilterMember((set_x: string) => (set_x in narrowed), params, p);
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
  if later.outcome.Applied? && later.operation == earlier.operation {
    PlanningSupersededCloses(steps, earlier, later);
  }
}

lemma lawASuccessOfAnotherOperationKeepsTheFailure_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawASuccessOfAnotherOperationKeepsTheFailure(steps, earlier, later) == true)
{
  if earlier.outcome.Failed? && later.operation != earlier.operation {
    PlanningKeepsOpen(steps, earlier, later);
    PlanningFailureMembership(steps + [earlier, later], earlier);
  }
}

lemma lawARefusalBeforeDispatchIsClosedByTheSameActionSucceeding_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawARefusalBeforeDispatchIsClosedByTheSameActionSucceeding(steps, earlier, later) == true)
{
  if earlier.outcome.Rejected? && later.actionName == earlier.actionName && later.outcome.Applied? {
    PlanningSupersededCloses(steps, earlier, later);
    PlanningFailureMembership(steps + [earlier, later], earlier);
  }
}

lemma lawALaterProposalOfTheSameActionClosesARefusal_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawALaterProposalOfTheSameActionClosesARefusal(steps, earlier, later) == true)
{
  if earlier.outcome.Rejected? && later.actionName == earlier.actionName && later.outcome.Proposed? {
    PlanningSupersededCloses(steps, earlier, later);
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

lemma PlanningSupersededCloses(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  requires supersedes(later, earlier)
  ensures earlier !in openOutcomes(steps + [earlier, later])
{
  PlanningFoldAppend(steps + [earlier], later);
  assert steps + [earlier] + [later] == steps + [earlier, later];
  var held := openOutcomes(steps + [earlier]);
  if opens(later.outcome) {
    assert later.outcome.Proposed? && earlier.outcome.Rejected?;
    ProofLib.FilterMember((p: PlanStep) => ((p.operation != later.operation) && !(supersedes(later, p))), held, earlier);
  } else {
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(later, p)), held, earlier);
  }
}

lemma PlanningKeepsOpen(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  requires opens(earlier.outcome)
  requires !supersedes(later, earlier)
  requires !opens(later.outcome) || earlier.operation != later.operation
  ensures earlier in openOutcomes(steps + [earlier, later])
{
  PlanningFoldAppend(steps, earlier);
  PlanningFoldAppend(steps + [earlier], later);
  assert steps + [earlier] + [later] == steps + [earlier, later];
  var held := openOutcomes(steps + [earlier]);
  assert earlier in held;
  if opens(later.outcome) {
    ProofLib.FilterMember((p: PlanStep) => ((p.operation != later.operation) && !(supersedes(later, p))), held, earlier);
  } else {
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(later, p)), held, earlier);
  }
}
