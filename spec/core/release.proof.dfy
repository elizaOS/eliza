lemma selectCandidate_ensures(r: Release, candidate: string)
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysEvidenceIsForAKnownCandidate(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysCandidateWasSelected(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> alwaysReadyHasFreshCompleteEvidence(selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> stepChangedCandidateDropsPriorResults(r, "selectCandidate", selectCandidate(r, candidate)))
  ensures (inv(r) ==> canSelectCandidate(r, candidate) ==> stepFailureRevokesReadiness(r, "selectCandidate", selectCandidate(r, candidate)))
{
  if inv(r) && canSelectCandidate(r, candidate) {
    var added := ProofLib.Filter((set_x: string) => !(set_x in r.selected), [candidate]);
    ProofLib.FilterMember((set_x: string) => !(set_x in r.selected), [candidate], candidate);
    assert selectCandidate(r, candidate).selected == r.selected + added;
    assert candidate in selectCandidate(r, candidate).selected;
  }
}
