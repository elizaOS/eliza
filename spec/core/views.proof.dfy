lemma NewestScanAbsorbs(candidates: seq<HandoffCandidate>, found: HandoffResult)
  requires !found.NoHandoff?
  ensures Std.Collections.Seq.FoldLeft((found: HandoffResult, candidate: HandoffCandidate) => continueScan(found, candidate), found, candidates) == found
  decreases |candidates|
{
  if |candidates| > 0 {
    NewestScanAbsorbs(candidates[1..], found);
  }
}

lemma lawNewestCandidateHasPriority_ensures(candidates: seq<HandoffCandidate>, candidate: HandoffCandidate)
  ensures (lawNewestCandidateHasPriority(candidates, candidate) == true)
{
  var reverseStep := (rows: seq<HandoffCandidate>, candidate: HandoffCandidate) => ([candidate] + rows);
  var scanStep := (found: HandoffResult, candidate: HandoffCandidate) => continueScan(found, candidate);
  var previous := Std.Collections.Seq.FoldLeft(reverseStep, [], candidates);
  var parsed := parseCandidate(candidate);
  ProofLib.FoldLeftAppend(reverseStep, [], candidates, candidate);
  assert Std.Collections.Seq.FoldLeft(reverseStep, [], candidates + [candidate]) == [candidate] + previous;
  assert ([candidate] + previous)[1..] == previous;
  assert Std.Collections.Seq.FoldLeft(scanStep, NoHandoff, [candidate] + previous) == Std.Collections.Seq.FoldLeft(scanStep, parsed, previous);
  if !parsed.NoHandoff? {
    NewestScanAbsorbs(previous, parsed);
  }
}
