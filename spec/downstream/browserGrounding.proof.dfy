lemma CandidateRank(candidates: seq<GroundedAddress>, rank: int, candidate: GroundedAddress)
  requires candidate in candidatesAtRank(rank, candidates)
  ensures candidate in candidates && candidate.qualifies
{
  ProofLib.FilterMember((entry: GroundedAddress) => entry.qualifies && entry.rank == rank, candidates, candidate);
}

lemma lawGroundingPreservesAuthoredSpelling_ensures(readable: bool, https: bool, vetoed: bool, candidates: seq<GroundedAddress>)
  ensures (lawGroundingPreservesAuthoredSpelling(readable, https, vetoed, candidates) == true)
{
  var result := groundProposedDestination(readable, https, vetoed, candidates);
  if result != "" {
    var candidate := orderedDestination(candidates);
    assert candidate.authoredHref == result;
    assert candidate != noGroundedAddress;
    var all := candidatesAtRank(1, candidates) + candidatesAtRank(2, candidates) + candidatesAtRank(3, candidates) + candidatesAtRank(4, candidates);
    assert |all| > 0 && all[0] == candidate;
    assert candidate in all;
    if candidate in candidatesAtRank(1, candidates) { CandidateRank(candidates, 1, candidate); }
    else if candidate in candidatesAtRank(2, candidates) { CandidateRank(candidates, 2, candidate); }
    else if candidate in candidatesAtRank(3, candidates) { CandidateRank(candidates, 3, candidate); }
    else { CandidateRank(candidates, 4, candidate); }
  }
}
