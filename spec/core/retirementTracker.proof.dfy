lemma FailureFilters(s: RetirementTracker)
  ensures alwaysFailureIdentity(s) == (forall failure :: failure in s.failures ==> |ProofLib.Filter((other: RetirementFailure) => (other.id == failure.id), s.failures)| == 1)
{}

lemma recordFailure_ensures(s: RetirementTracker, failureId: int, scope: string, cause: string, beforeClose: bool)
  ensures (inv(s) ==> canRecordFailure(s, failureId, scope, cause, beforeClose) ==> alwaysGenerationCountsAdmissions(recordFailure(s, failureId, scope, cause, beforeClose)))
  ensures (inv(s) ==> canRecordFailure(s, failureId, scope, cause, beforeClose) ==> alwaysFailureIdentity(recordFailure(s, failureId, scope, cause, beforeClose)))
  ensures (inv(s) ==> canRecordFailure(s, failureId, scope, cause, beforeClose) ==> alwaysDrainedFailuresMatchScope(recordFailure(s, failureId, scope, cause, beforeClose)))
  ensures (inv(s) ==> canRecordFailure(s, failureId, scope, cause, beforeClose) ==> stepFailureHistoryPreserved(s, recordFailure(s, failureId, scope, cause, beforeClose)))
{
  if inv(s) && canRecordFailure(s, failureId, scope, cause, beforeClose) {
    var after := recordFailure(s, failureId, scope, cause, beforeClose);
    var added := RetirementFailure(failureId, scope, cause, beforeClose);
    FailureFilters(s); FailureFilters(after);
    forall failure | failure in after.failures
      ensures |ProofLib.Filter((other: RetirementFailure) => (other.id == failure.id), after.failures)| == 1
    {
      ProofLib.FilterAppend((other: RetirementFailure) => (other.id == failure.id), s.failures, added);
      if failure.id == failureId {
        ProofLib.FilterNone((other: RetirementFailure) => (other.id == failure.id), s.failures);
      } else {
        assert failure in s.failures;
      }
    }
  }
}
