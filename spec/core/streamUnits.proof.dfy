lemma SlicePastEnd(xs: seq<int>, offset: int, end: int, acc: seq<int>)
  requires offset >= end
  ensures Std.Collections.Seq.FoldLeft((walk: SliceWalk, code: int) => SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), SliceWalk(offset, acc), xs).units == acc
  decreases |xs|
{
  if |xs| > 0 {
    SlicePastEnd(xs[1..], offset + 1, end, acc);
  }
}

lemma {:induction false} SlicePrefixFold(xs: seq<int>, offset: int, end: int, acc: seq<int>)
  requires 0 <= offset <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: SliceWalk, code: int) => SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), SliceWalk(offset, acc), xs).units == acc + xs[..end - offset]
  decreases |xs|
{
  if offset == end {
    SlicePastEnd(xs, offset, end, acc);
  } else {
    assert 0 < end - offset <= |xs|;
    var f := (walk: SliceWalk, code: int) => SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
    var next := SliceWalk(offset + 1, acc + [xs[0]]);
    assert f(SliceWalk(offset, acc), xs[0]) == next;
    assert Std.Collections.Seq.FoldLeft(f, SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    SlicePrefixFold(xs[1..], offset + 1, end, acc + [xs[0]]);
    assert xs[..end - offset] == [xs[0]] + xs[1..][..end - offset - 1];
    calc {
      Std.Collections.Seq.FoldLeft(f, SliceWalk(offset, acc), xs).units;
      == Std.Collections.Seq.FoldLeft(f, next, xs[1..]).units;
      == (acc + [xs[0]]) + xs[1..][..end - offset - 1];
      == acc + xs[..end - offset];
    }
  }
}

lemma lawWholeSlicePreservesUnits_ensures(units: seq<int>)
  ensures (lawWholeSlicePreservesUnits(units) == true)
{
  SlicePrefixFold(units, 0, |units|, []);
}

lemma lawPrefixSliceLength_ensures(units: seq<int>, end: int)
  ensures (lawPrefixSliceLength(units, end) == true)
{
  if 0 <= end <= |units| {
    SlicePrefixFold(units, 0, end, []);
  }
}

lemma WellFormedFoldLength(xs: seq<int>, walk: WellFormedWalk)
  ensures |Std.Collections.Seq.FoldLeft((walk: WellFormedWalk, code: int) => sanitizeUnit(walk, code), walk, xs).units| + (if Std.Collections.Seq.FoldLeft((walk: WellFormedWalk, code: int) => sanitizeUnit(walk, code), walk, xs).pending >= 0 then 1 else 0) == |walk.units| + (if walk.pending >= 0 then 1 else 0) + |xs|
  decreases |xs|
{
  if |xs| > 0 {
    var after := sanitizeUnit(walk, xs[0]);
    assert |after.units| + (if after.pending >= 0 then 1 else 0) == |walk.units| + (if walk.pending >= 0 then 1 else 0) + 1;
    WellFormedFoldLength(xs[1..], after);
  }
}

lemma lawWellFormedLengthPreserved_ensures(units: seq<int>)
  ensures (lawWellFormedLengthPreserved(units) == true)
{
  WellFormedFoldLength(units, WellFormedWalk(-1, []));
}

lemma lawPairPreserved_ensures(highUnit: int, lowUnit: int)
  ensures (lawPairPreserved(highUnit, lowUnit) == true)
{
  if high(highUnit) && low(lowUnit) {
    var f := (walk: WellFormedWalk, code: int) => sanitizeUnit(walk, code);
    ProofLib.FoldLeftAppend(f, WellFormedWalk(-1, []), [], highUnit);
    ProofLib.FoldLeftAppend(f, WellFormedWalk(-1, []), [highUnit], lowUnit);
    assert sanitizeUnit(WellFormedWalk(-1, []), highUnit) == WellFormedWalk(highUnit, []);
    assert sanitizeUnit(WellFormedWalk(highUnit, []), lowUnit) == WellFormedWalk(-1, [highUnit, lowUnit]);
    assert Std.Collections.Seq.FoldLeft((walk: WellFormedWalk, code: int) => sanitizeUnit(walk, code), WellFormedWalk(-1, []), [highUnit, lowUnit]) == WellFormedWalk(-1, [highUnit, lowUnit]);
  }
}

lemma lawOrdinaryStringBoundary_ensures(code: int)
  ensures (lawOrdinaryStringBoundary(code) == true)
{
  if code != 34 && code != 92 {
    var units := [34, code, 34];
    var a := JsonScan(0, 1, -1, true, true, []);
    var b := scanJsonUnit(a, units, 34, false);
    var c := scanJsonUnit(b, units, code, false);
    var d := scanJsonUnit(c, units, 34, false);
    var f := (scanState: JsonScan, code: int) => scanJsonUnit(scanState, units, code, false);
    ProofLib.FoldLeftAppend(f, a, [], 34);
    ProofLib.FoldLeftAppend(f, a, [34], code);
    ProofLib.FoldLeftAppend(f, a, [34, code], 34);
    assert b == JsonScan(1, 1, -1, true, true, []);
    assert c == JsonScan(2, 1, -1, true, true, []);
    assert d == JsonScan(3, 1, 3, true, false, []);
    assert Std.Collections.Seq.FoldLeft((scanState: JsonScan, code: int) => scanJsonUnit(scanState, units, code, false), a, units) == d;
  }
}
