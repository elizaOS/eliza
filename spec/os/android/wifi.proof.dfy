lemma KeepStrongestDistinctStep(best: seq<ScanRow>, row: ScanRow, all: seq<ScanRow>, joinableOnly: bool)
  requires ProofLib.DistinctBy(best, (x: ScanRow) => x.network)
  requires forall o :: o in best ==> usableRow(o, joinableOnly) && o in all
  requires usableRow(row, joinableOnly) && row in all
  ensures ProofLib.DistinctBy(keepStrongest(best, row), (x: ScanRow) => x.network)
  ensures forall o :: o in keepStrongest(best, row) ==> usableRow(o, joinableOnly) && o in all
{
  var next := keepStrongest(best, row);
  if exists b :: b in best && b.network == row.network {
    forall i | 0 <= i < |next|
      ensures next[i].network == best[i].network && usableRow(next[i], joinableOnly) && next[i] in all
    {
      assert best[i] in best;
    }
  } else {
    assert next == best + [row];
    forall i, j | 0 <= i < |next| && 0 <= j < |next| && i != j
      ensures next[i].network != next[j].network
    {
      if i < |best| && j == |best| {
        assert best[i] in best;
      } else if j < |best| && i == |best| {
        assert best[j] in best;
      }
    }
  }
}

lemma FoldKeepStrongestDistinct(best: seq<ScanRow>, rest: seq<ScanRow>, all: seq<ScanRow>, joinableOnly: bool)
  requires ProofLib.DistinctBy(best, (x: ScanRow) => x.network)
  requires forall o :: o in best ==> usableRow(o, joinableOnly) && o in all
  requires forall r :: r in rest ==> usableRow(r, joinableOnly) && r in all
  ensures ProofLib.DistinctBy(Std.Collections.Seq.FoldLeft(keepStrongest, best, rest), (x: ScanRow) => x.network)
  ensures forall o :: o in Std.Collections.Seq.FoldLeft(keepStrongest, best, rest) ==> usableRow(o, joinableOnly) && o in all
  decreases |rest|
{
  if |rest| > 0 {
    assert rest[0] in rest;
    KeepStrongestDistinctStep(best, rest[0], all, joinableOnly);
    assert forall r :: r in rest[1..] ==> r in rest;
    FoldKeepStrongestDistinct(keepStrongest(best, rest[0]), rest[1..], all, joinableOnly);
  }
}

lemma KeepStrongestCoversRow(best: seq<ScanRow>, row: ScanRow)
  ensures exists o :: o in keepStrongest(best, row) && o.network == row.network && o.strength >= row.strength
{
  var next := keepStrongest(best, row);
  if exists b :: b in best && b.network == row.network {
    var b :| b in best && b.network == row.network;
    var j :| 0 <= j < |best| && best[j] == b;
    assert next[j] in next && next[j].network == row.network && next[j].strength >= row.strength;
  } else {
    assert row in next;
  }
}

lemma KeepStrongestPreservesOne(best: seq<ScanRow>, row: ScanRow, target: ScanRow)
  requires exists b :: b in best && b.network == target.network && b.strength >= target.strength
  ensures exists o :: o in keepStrongest(best, row) && o.network == target.network && o.strength >= target.strength
{
  var next := keepStrongest(best, row);
  var b :| b in best && b.network == target.network && b.strength >= target.strength;
  var i :| 0 <= i < |best| && best[i] == b;
  if exists x :: x in best && x.network == row.network {
    assert next[i] in next && next[i].network == target.network && next[i].strength >= target.strength;
  } else {
    assert b in next;
  }
}

lemma FoldKeepStrongestPreservesOne(best: seq<ScanRow>, rest: seq<ScanRow>, target: ScanRow)
  requires exists b :: b in best && b.network == target.network && b.strength >= target.strength
  ensures exists o :: o in Std.Collections.Seq.FoldLeft(keepStrongest, best, rest) && o.network == target.network && o.strength >= target.strength
  decreases |rest|
{
  if |rest| > 0 {
    KeepStrongestPreservesOne(best, rest[0], target);
    FoldKeepStrongestPreservesOne(keepStrongest(best, rest[0]), rest[1..], target);
  }
}

lemma FoldKeepStrongestCoversOne(best: seq<ScanRow>, rest: seq<ScanRow>, target: ScanRow)
  requires target in rest
  ensures exists o :: o in Std.Collections.Seq.FoldLeft(keepStrongest, best, rest) && o.network == target.network && o.strength >= target.strength
  decreases |rest|
{
  if rest[0] == target {
    KeepStrongestCoversRow(best, target);
    FoldKeepStrongestPreservesOne(keepStrongest(best, target), rest[1..], target);
  } else {
    assert target in rest[1..];
    FoldKeepStrongestCoversOne(keepStrongest(best, rest[0]), rest[1..], target);
  }
}

lemma OffersFilterFacts(rows: seq<ScanRow>, joinableOnly: bool)
  ensures forall r :: r in ProofLib.Filter((r: ScanRow) => usableRow(r, joinableOnly), rows) <==> r in rows && usableRow(r, joinableOnly)
{
  var p := (r: ScanRow) => usableRow(r, joinableOnly);
  forall r
    ensures r in ProofLib.Filter(p, rows) <==> r in rows && p(r)
  {
    ProofLib.FilterMember(p, rows, r);
  }
}

lemma lawOffersAreUsableDistinctAndFromTheScan_ensures(rows: seq<ScanRow>, joinableOnly: bool)
  ensures (lawOffersAreUsableDistinctAndFromTheScan(rows, joinableOnly) == true)
{
  var filtered := ProofLib.Filter((r: ScanRow) => usableRow(r, joinableOnly), rows);
  OffersFilterFacts(rows, joinableOnly);
  FoldKeepStrongestDistinct([], filtered, rows, joinableOnly);
  var offered := offeredRows(rows, joinableOnly);
  forall o | o in offered
    ensures usableRow(o, joinableOnly) && o in rows && |ProofLib.Filter((q: ScanRow) => (q.network == o.network), offered)| == 1
  {
    var i :| 0 <= i < |offered| && offered[i] == o;
    ProofLib.FilterCountOneIffUnique((q: ScanRow) => (q.network == o.network), offered, (x: ScanRow) => x.network, i);
  }
}

lemma lawEveryUsableNameIsOfferedAtItsStrongest_ensures(rows: seq<ScanRow>, joinableOnly: bool)
  ensures (lawEveryUsableNameIsOfferedAtItsStrongest(rows, joinableOnly) == true)
{
  var filtered := ProofLib.Filter((r: ScanRow) => usableRow(r, joinableOnly), rows);
  OffersFilterFacts(rows, joinableOnly);
  forall r | r in rows && usableRow(r, joinableOnly)
    ensures exists o :: o in offeredRows(rows, joinableOnly) && o.network == r.network && o.strength >= r.strength
  {
    assert r in filtered;
    FoldKeepStrongestCoversOne([], filtered, r);
  }
}
