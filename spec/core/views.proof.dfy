// Proofs for spec/core/views.md.

// Once a scan has selected a result or observed a failure, no older candidate changes it.
lemma ViewsScanStaysSettled(found: HandoffResult, rows: seq<HandoffCandidate>)
  requires !found.NoHandoff?
  ensures Std.Collections.Seq.FoldLeft((found: HandoffResult, candidate: HandoffCandidate) => continueScan(found, candidate), found, rows) == found
  decreases |rows|
{
  if |rows| > 0 {
    assert continueScan(found, rows[0]) == found;
    ViewsScanStaysSettled(found, rows[1..]);
  }
}

lemma lawNewestCandidateHasPriority_ensures(candidates: seq<HandoffCandidate>, candidate: HandoffCandidate)
  ensures (lawNewestCandidateHasPriority(candidates, candidate) == true)
{
  var prepend := (rows: seq<HandoffCandidate>, candidate: HandoffCandidate) => ([candidate] + rows);
  var scan := (found: HandoffResult, candidate: HandoffCandidate) => continueScan(found, candidate);
  var older := Std.Collections.Seq.FoldLeft(prepend, [], candidates);
  ProofLib.FoldLeftAppend(prepend, [], candidates, candidate);
  assert Std.Collections.Seq.FoldLeft(prepend, [], candidates + [candidate]) == [candidate] + older;
  var start := typed0_core__views(HandoffResult.NoHandoff);
  assert ([candidate] + older)[1..] == older;
  assert Std.Collections.Seq.FoldLeft(scan, start, [candidate] + older) == Std.Collections.Seq.FoldLeft(scan, parseCandidate(candidate), older);
  assert scanCandidates(candidates) == Std.Collections.Seq.FoldLeft(scan, start, older);
  assert scanCandidates(candidates + [candidate]) == Std.Collections.Seq.FoldLeft(scan, parseCandidate(candidate), older);
  if !parseCandidate(candidate).NoHandoff? {
    ViewsScanStaysSettled(parseCandidate(candidate), older);
  }
}
