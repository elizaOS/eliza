lemma lawARootedPathIsAccepted_ensures(rest: seq<int>)
  ensures (lawARootedPathIsAccepted(rest) == true)
{
  var units := [slashUnit] + rest;
  ContextSlice(units, 0, 1);
  assert units[0..1] == [slashUnit];
  if |units| >= 2 {
    ContextSlice(units, 0, 2);
    assert units[0..2] == [slashUnit, (if ((0 <= 0) && (0 < |rest|)) then rest[0] else 0)];
  }
}

lemma lawAPathFromAnotherHostIsRefused_ensures(rest: seq<int>)
  ensures (lawAPathFromAnotherHostIsRefused(rest) == true)
{
  var units := [slashUnit, slashUnit] + rest;
  ContextSlice(units, 0, 2);
  assert units[0..2] == [slashUnit, slashUnit];
}

// spec/agent/conversation/turnContext.md: a view path is rooted when it starts with one slash.
lemma {:induction false} ContextSliceFrom(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires start <= offset <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == end {
    ContextSlicePast(xs, start, end, offset, acc);
  } else {
    var next := core__streamUnits_SliceWalk(offset + 1, acc + [xs[0]]);
    assert f(core__streamUnits_SliceWalk(offset, acc), xs[0]) == next;
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    ContextSliceFrom(xs[1..], start, end, offset + 1, acc + [xs[0]]);
    assert xs[..end - offset] == [xs[0]] + xs[1..][..end - offset - 1];
  }
}

lemma {:induction false} ContextSlicePast(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset >= end
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if |xs| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    ContextSlicePast(xs[1..], start, end, offset + 1, acc);
  }
}

lemma {:induction false} ContextSliceBefore(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset <= start <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[start - offset..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == start {
    ContextSliceFrom(xs, start, end, offset, acc);
    assert xs[start - offset..end - offset] == xs[..end - offset];
  } else {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    ContextSliceBefore(xs[1..], start, end, offset + 1, acc);
    assert xs[1..][start - offset - 1..end - offset - 1] == xs[start - offset..end - offset];
  }
}

lemma ContextSlice(units: seq<int>, start: int, end: int)
  requires 0 <= start <= end <= |units|
  ensures core__streamUnits_sliceUnits(units, start, end) == units[start..end]
{
  ContextSliceBefore(units, start, end, 0, []);
}

