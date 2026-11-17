lemma seedRoutine_ensures(s: Routines, templateKey: string)
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysAnsweredOccurrencesWereShown(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysShowingOccurrenceWasShown(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> alwaysMutedRoutineShowsNothing(seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> stepSeedingAddsOneNewTemplate(s, "seedRoutine", seedRoutine(s, templateKey)))
  ensures (inv(s) ==> canSeedRoutine(s, templateKey) ==> stepSettledOutcomeIsKept(s, "seedRoutine", seedRoutine(s, templateKey)))
{
  if inv(s) && canSeedRoutine(s, templateKey) {
    ProofLib.FilterCons((set_x: string) => !((set_x in s.seeded)), [templateKey]);
    ProofLib.FilterNil((set_x: string) => !((set_x in s.seeded)), [templateKey][1..]);
  }
}
