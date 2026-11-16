lemma selectCandidate_ensures(r: Release, candidate: ReleaseCandidate)
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysReadyHasFreshCompleteEvidence(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysEvidenceIsForAKnownCandidate(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysCandidateWasSelected(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> stepFailureRevokesReadiness(r, "selectCandidate", selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> stepChangedCandidateDropsPriorResults(r, "selectCandidate", selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> stepUsedAttemptIdsStayReserved(r, selectCandidate(r, candidate)))
{
  if inv(r) && canSelectCandidate(r, candidate) {
    var attempt := candidate.attemptId;
    var added := ProofLib.Filter((set_x: string) => !(set_x in r.selectedAttempts), [attempt]);
    ProofLib.FilterMember((set_x: string) => !(set_x in r.selectedAttempts), [attempt], attempt);
    assert selectCandidate(r, candidate).selectedAttempts == r.selectedAttempts + added;
    assert attempt in selectCandidate(r, candidate).selectedAttempts;
  }
}
