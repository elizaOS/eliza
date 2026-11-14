lemma ExactOtherReceiptSurvivesFold(rows: seq<PriorRow>, walk: PriorWalk)
  requires walk.index >= 0 && walk.exactOther >= -1
  ensures (walk.exactOther >= 0 || (exists row :: row in rows && exactOtherPriorRow(walk.query, row))) ==>
    Std.Collections.Seq.FoldLeft(takePriorRow, walk, rows).exactOther >= 0
  decreases |rows|
{
  if |rows| > 0 {
    var row := rows[|rows| - 1];
    var before := rows[..|rows| - 1];
    assert rows == before + [row];
    ExactOtherReceiptSurvivesFold(before, walk);
    ProofLib.FoldLeftAppend(takePriorRow, walk, before, row);
    var prior := Std.Collections.Seq.FoldLeft(takePriorRow, walk, before);
    ReceiptWalkPreservesQueryAndBounds(before, walk);
    if walk.exactOther >= 0 || (exists candidate :: candidate in before && exactOtherPriorRow(walk.query, candidate)) {
      assert prior.exactOther >= 0;
    } else if exists candidate :: candidate in rows && exactOtherPriorRow(walk.query, candidate) {
      var candidate :| candidate in rows && exactOtherPriorRow(walk.query, candidate);
      assert candidate == row || candidate in before;
      assert candidate == row;
      assert exactOtherPriorRow(prior.query, row);
      assert prior.exactOther >= 0 || prior.exactOther == -1;
      assert takePriorRow(prior, row).exactOther >= 0;
    }
  } else {
    assert rows == [];
  }
}

lemma ReceiptWalkPreservesQueryAndBounds(rows: seq<PriorRow>, walk: PriorWalk)
  requires walk.index >= 0 && walk.exactOther >= -1
  ensures Std.Collections.Seq.FoldLeft(takePriorRow, walk, rows).query == walk.query
  ensures Std.Collections.Seq.FoldLeft(takePriorRow, walk, rows).index >= 0
  ensures Std.Collections.Seq.FoldLeft(takePriorRow, walk, rows).exactOther >= -1
  decreases |rows|
{
  if |rows| > 0 {
    var row := rows[|rows| - 1];
    var before := rows[..|rows| - 1];
    assert rows == before + [row];
    ReceiptWalkPreservesQueryAndBounds(before, walk);
    ProofLib.FoldLeftAppend(takePriorRow, walk, before, row);
  } else {
    assert rows == [];
  }
}

lemma lawExactOtherWinsAcrossAllCandidates_ensures(rows: seq<PriorRow>, q: PriorQuery)
  ensures (lawExactOtherWinsAcrossAllCandidates(rows, q) == true)
{
  var walk := PriorWalk(0, -1, -1, -1, q);
  if exists row :: row in rows && exactOtherPriorRow(q, row) {
    ExactOtherReceiptSurvivesFold(rows, walk);
    var observed := Std.Collections.Seq.FoldLeft(takePriorRow, walk, rows);
    assert observed.exactOther >= 0;
    assert chooseGenericPrior(rows, q) == selectPriorObservation(observed);
  }
}
