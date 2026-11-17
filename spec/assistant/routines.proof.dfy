lemma seedRoutine_ensures(s: Routines, templateKey: string)
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysAnsweredOccurrencesWereShown(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysShowingOccurrenceWasShown(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysMutedRoutineShowsNothing(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysOneDefinitionPerKey(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysReplyIsTheSavedDefinition(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> stepSeedingAddsOneNewTemplate(s, "seedRoutine", seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> stepSettledOutcomeIsKept(s, "seedRoutine", seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> stepRepeatedKeyCreatesNothing(s, "seedRoutine", seedRoutine(s, templateKey)))
{
  if inv(s) && canSeedRoutine(s, templateKey) {
    ProofLib.FilterCons((set_x: string) => !((set_x in s.seeded)), [templateKey]);
    ProofLib.FilterNil((set_x: string) => !((set_x in s.seeded)), [templateKey][1..]);
  }
}

lemma createDefinition_ensures(s: Routines, idempotencyKey: string)
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> alwaysAnsweredOccurrencesWereShown(createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> alwaysShowingOccurrenceWasShown(createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> alwaysMutedRoutineShowsNothing(createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> alwaysOneDefinitionPerKey(createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> alwaysReplyIsTheSavedDefinition(createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> stepSeedingAddsOneNewTemplate(s, "createDefinition", createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> stepSettledOutcomeIsKept(s, "createDefinition", createDefinition(s, idempotencyKey)))
  ensures (inv(s) ==> canCreateDefinition(s, idempotencyKey) ==> stepRepeatedKeyCreatesNothing(s, "createDefinition", createDefinition(s, idempotencyKey)))
{
  if inv(s) && canCreateDefinition(s, idempotencyKey) && !(idempotencyKey in s.createKeys) {
    ProofLib.FilterCons((set_x: string) => !((set_x in s.createKeys)), [idempotencyKey]);
    ProofLib.FilterNil((set_x: string) => !((set_x in s.createKeys)), [idempotencyKey][1..]);
    assert createDefinition(s, idempotencyKey).createKeys == s.createKeys + [idempotencyKey];
    assert idempotencyKey in createDefinition(s, idempotencyKey).createKeys;
  }
}
