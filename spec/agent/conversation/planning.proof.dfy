lemma lawOnlyAllowedRegisteredActionsAreOffered_ensures(registered: seq<string>, allowed: seq<string>, formless: seq<string>)
  ensures (lawOnlyAllowedRegisteredActionsAreOffered(registered, allowed, formless) == true)
{
  PlanOfferedFilter(registered, allowed, formless);
  var a := ProofLib.Filter((set_x: string) => (set_x in allowed), registered);
  var b := ProofLib.Filter((set_x: string) => !((set_x in messageServiceActions)), a);
  forall x | x in offered(registered, allowed, formless)
    ensures x in allowed && x in registered && x != "REPLY"
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in formless)), b, x);
    ProofLib.FilterMember((set_x: string) => !((set_x in messageServiceActions)), a, x);
    ProofLib.FilterMember((set_x: string) => (set_x in allowed), registered, x);
    assert "REPLY" in messageServiceActions;
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

lemma lawASuccessOfTheSameOperationSupersedes_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawASuccessOfTheSameOperationSupersedes(steps, earlier, later) == true)
{
  if later.outcome.Applied? && later.operation == earlier.operation {
    PlanOpenTwo(steps, earlier, later);
    if earlier == later {
      PlanSettleFilter(settleStep(openOutcomes(steps), earlier), later);
      ProofLib.FilterMember((p: PlanStep) => !(supersedes(later, p)), settleStep(openOutcomes(steps), earlier), earlier);
    } else {
      PlanSettleCloses(settleStep(openOutcomes(steps), earlier), later, earlier);
    }
  }
}

lemma lawALaterProposalOfTheSameActionClosesARefusal_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawALaterProposalOfTheSameActionClosesARefusal(steps, earlier, later) == true)
{
  if earlier.outcome.Rejected? && later.actionName == earlier.actionName && later.outcome.Proposed? {
    PlanOpenTwo(steps, earlier, later);
    PlanSettleCloses(settleStep(openOutcomes(steps), earlier), later, earlier);
  }
}

lemma lawTheLatestFailureIsReported_ensures(steps: seq<PlanStep>, earlier: PlanStep)
  ensures (lawTheLatestFailureIsReported(steps, earlier) == true)
{
  if earlier.outcome.Failed? {
    PlanOpenAppend(steps, earlier);
    PlanOpensItself(openOutcomes(steps), earlier);
    PlanFailedMember(steps + [earlier], earlier);
  }
}

lemma lawASuccessOfAnotherOperationKeepsTheFailure_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawASuccessOfAnotherOperationKeepsTheFailure(steps, earlier, later) == true)
{
  if earlier.outcome.Failed? && later.operation != earlier.operation {
    PlanOpenTwo(steps, earlier, later);
    PlanOpensItself(openOutcomes(steps), earlier);
    PlanSettleKeeps(settleStep(openOutcomes(steps), earlier), later, earlier);
    PlanFailedMember(steps + [earlier, later], earlier);
  }
}

lemma lawARefusalBeforeDispatchIsClosedByTheSameActionSucceeding_ensures(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures (lawARefusalBeforeDispatchIsClosedByTheSameActionSucceeding(steps, earlier, later) == true)
{
  if earlier.outcome.Rejected? && later.actionName == earlier.actionName && later.outcome.Applied? {
    PlanOpenTwo(steps, earlier, later);
    PlanSettleCloses(settleStep(openOutcomes(steps), earlier), later, earlier);
    PlanFailedMember(steps + [earlier, later], earlier);
  }
}

// spec/agent/conversation/planning.md: the actions offered are the allowed registered ones, without the message services and the formless.
lemma PlanOfferedFilter(registered: seq<string>, allowed: seq<string>, formless: seq<string>)
  ensures offered(registered, allowed, formless) == ProofLib.Filter((set_x: string) => !((set_x in formless)), ProofLib.Filter((set_x: string) => !((set_x in messageServiceActions)), ProofLib.Filter((set_x: string) => (set_x in allowed), registered)))
{
}

lemma PlanNarrowedFilter(params: seq<string>, narrowed: seq<string>)
  ensures turnNarrowed(params, narrowed) == ProofLib.Filter((set_x: string) => (set_x in narrowed), params)
{
}

// spec/agent/conversation/planning.md: each step settles the outcomes still open.
lemma PlanSettleFilter(held: seq<PlanStep>, entry: PlanStep)
  ensures settleStep(held, entry) == (if opens(entry.outcome) then (ProofLib.Filter((p: PlanStep) => ((p.operation != entry.operation) && !(supersedes(entry, p))), held) + [entry]) else ProofLib.Filter((p: PlanStep) => !(supersedes(entry, p)), held))
{
}

lemma PlanFailedFilter(steps: seq<PlanStep>)
  ensures failedOpen(steps) == ProofLib.Filter((p: PlanStep) => (p.outcome.Failed? || p.outcome.Rejected?), openOutcomes(steps))
{
}

lemma PlanOpenAppend(steps: seq<PlanStep>, last: PlanStep)
  ensures openOutcomes(steps + [last]) == settleStep(openOutcomes(steps), last)
{
  ProofLib.FoldLeftAppend((held: seq<PlanStep>, entry: PlanStep) => settleStep(held, entry), [], steps, last);
}

lemma PlanOpenTwo(steps: seq<PlanStep>, earlier: PlanStep, later: PlanStep)
  ensures openOutcomes(steps + [earlier, later]) == settleStep(settleStep(openOutcomes(steps), earlier), later)
{
  PlanOpenAppend(steps, earlier);
  assert steps + [earlier, later] == (steps + [earlier]) + [later];
  PlanOpenAppend(steps + [earlier], later);
}

// spec/agent/conversation/planning.md: a step that supersedes an open outcome closes it.
lemma PlanSettleCloses(held: seq<PlanStep>, entry: PlanStep, earlier: PlanStep)
  requires supersedes(entry, earlier) && earlier != entry
  ensures !(earlier in settleStep(held, entry))
{
  PlanSettleFilter(held, entry);
  if opens(entry.outcome) {
    ProofLib.FilterMember((p: PlanStep) => ((p.operation != entry.operation) && !(supersedes(entry, p))), held, earlier);
  } else {
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(entry, p)), held, earlier);
  }
}

// spec/agent/conversation/planning.md: an outcome stays open until a step of its own operation or action settles it.
lemma PlanSettleKeeps(held: seq<PlanStep>, entry: PlanStep, earlier: PlanStep)
  requires earlier in held && earlier.operation != entry.operation && !supersedes(entry, earlier)
  ensures earlier in settleStep(held, entry)
{
  PlanSettleFilter(held, entry);
  if opens(entry.outcome) {
    ProofLib.FilterMember((p: PlanStep) => ((p.operation != entry.operation) && !(supersedes(entry, p))), held, earlier);
  } else {
    ProofLib.FilterMember((p: PlanStep) => !(supersedes(entry, p)), held, earlier);
  }
}

lemma PlanOpensItself(held: seq<PlanStep>, entry: PlanStep)
  requires opens(entry.outcome)
  ensures entry in settleStep(held, entry)
{
  PlanSettleFilter(held, entry);
}

lemma PlanFailedMember(steps: seq<PlanStep>, q: PlanStep)
  ensures (q in failedOpen(steps)) == (q in openOutcomes(steps) && (q.outcome.Failed? || q.outcome.Rejected?))
{
  PlanFailedFilter(steps);
  ProofLib.FilterMember((p: PlanStep) => (p.outcome.Failed? || p.outcome.Rejected?), openOutcomes(steps), q);
}
