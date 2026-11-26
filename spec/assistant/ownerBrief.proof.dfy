lemma SafeRanksEmptyFold(ownerId: string, seen: seq<string>, proposals: seq<string>)
  requires |seen| == 0
  ensures |Std.Collections.Seq.FoldLeft((acc: seq<string>, proposedId: string) => (if (rankableIdentity([], ownerId, proposedId) && !((proposedId in acc))) then (acc + [proposedId]) else acc), seen, proposals)| == 0
  decreases |proposals|
{
  if |proposals| > 0 {
    var p := (row: RankCandidate) => ((row.rankOwner == ownerId) && (row.rankId == proposals[0]));
    ProofLib.FilterNil(p, []);
    assert !rankableIdentity([], ownerId, proposals[0]);
    SafeRanksEmptyFold(ownerId, seen, proposals[1..]);
  }
}

lemma lawNoUnknownIdentityFitsEmptyRank_ensures(ownerId: string, proposals: seq<string>)
  ensures (lawNoUnknownIdentityFitsEmptyRank(ownerId, proposals) == true)
{
  SafeRanksEmptyFold(ownerId, [], proposals);
}
