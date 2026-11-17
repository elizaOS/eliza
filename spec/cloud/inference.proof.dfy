lemma FoldLeftConcat<A, T>(f: (A, T) -> A, a: A, xs: seq<T>, ys: seq<T>)
  ensures Std.Collections.Seq.FoldLeft(f, a, xs + ys) == Std.Collections.Seq.FoldLeft(f, Std.Collections.Seq.FoldLeft(f, a, xs), ys)
  decreases |xs|
{
  if |xs| == 0 {
    assert xs + ys == ys;
  } else {
    assert (xs + ys)[1..] == xs[1..] + ys;
    FoldLeftConcat(f, f(a, xs[0]), xs[1..], ys);
  }
}

lemma lawChunkBoundariesDoNotChangeEvents_ensures(first: seq<int>, second: seq<int>)
  ensures (lawChunkBoundariesDoNotChangeEvents(first, second) == true)
{
  FoldLeftConcat((q: SseParser, c: int) => readSymbol(q, c), emptyParser, first, second);
}
