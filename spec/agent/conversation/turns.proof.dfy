lemma lawHeardAndUnheardMakeTheReply_ensures(r: Reply)
  ensures (lawHeardAndUnheardMakeTheReply(r) == true)
{
  if 0 <= boundaryOf(r) <= |r.units| {
    SplitReplyUnits(r.units, 0, boundaryOf(r), |r.units|, [], []);
  }
}

lemma {:induction false} SplitReplyUnits(xs: seq<int>, offset: int, split: int, end: int, heard: seq<int>, unheard: seq<int>)
  requires 0 <= offset <= end
  requires 0 <= split <= end
  requires end == offset + |xs|
  requires offset < split ==> unheard == []
  ensures
    Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < split)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, heard), xs).units
      + Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= split) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, unheard), xs).units
      == heard + unheard + xs
  decreases |xs|
{
  if |xs| > 0 {
    var before := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= 0) && (walk.offset < split)) then (walk.units + [code]) else walk.units));
    var after := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= split) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
    var nextHeard := if offset < split then heard + [xs[0]] else heard;
    var nextUnheard := if offset < split then unheard else unheard + [xs[0]];
    assert before(core__streamUnits_SliceWalk(offset, heard), xs[0]) == core__streamUnits_SliceWalk(offset + 1, nextHeard);
    assert after(core__streamUnits_SliceWalk(offset, unheard), xs[0]) == core__streamUnits_SliceWalk(offset + 1, nextUnheard);
    assert Std.Collections.Seq.FoldLeft(before, core__streamUnits_SliceWalk(offset, heard), xs) ==
      Std.Collections.Seq.FoldLeft(before, core__streamUnits_SliceWalk(offset + 1, nextHeard), xs[1..]);
    assert Std.Collections.Seq.FoldLeft(after, core__streamUnits_SliceWalk(offset, unheard), xs) ==
      Std.Collections.Seq.FoldLeft(after, core__streamUnits_SliceWalk(offset + 1, nextUnheard), xs[1..]);
    SplitReplyUnits(xs[1..], offset + 1, split, end, nextHeard, nextUnheard);
    assert xs == [xs[0]] + xs[1..];
    assert nextHeard + nextUnheard + xs[1..] == heard + unheard + xs;
  }
}
