lemma GuardedPartition(chars: seq<int>, cut: int, base: Partition)
  requires base.seen >= cut || |base.suffix| == 0
  ensures var out := Std.Collections.Seq.FoldLeft((p: Partition, c: int) => splitChar(cut,p,c),base,chars);
    out.prefix + out.suffix == base.prefix + base.suffix + chars
  ensures var out := Std.Collections.Seq.FoldLeft((p: Partition, c: int) => splitChar(cut,p,c),base,chars);
    out.seen == base.seen + |chars| &&
    |out.prefix| == |base.prefix| + (if cut <= base.seen then 0 else if cut-base.seen <= |chars| then cut-base.seen else |chars|)
  decreases |chars|
{
  reveal Std.Collections.Seq.FoldLeft();
  var apply := (p: Partition,c: int) => splitChar(cut,p,c);
  var out := Std.Collections.Seq.FoldLeft(apply,base,chars);
  if |chars| == 0 {
    assert out == base;
  } else {
    var head := chars[0];
    var tail := chars[1..];
    var after := splitChar(cut,base,head);
    assert chars == [head] + tail;
    assert out == Std.Collections.Seq.FoldLeft(apply,after,tail);
    GuardedPartition(tail,cut,after);
  }
}

lemma GuardedReleaseSpans(s: StreamBuffer, t: StreamBuffer, cut: int)
  requires inv(s) && canRelease(s,cut)
  requires t == release(s,cut)
  requires |splitChars(s.pending,cut).prefix| == cut
  requires (splitChars(s.pending,cut).prefix + splitChars(s.pending,cut).suffix) == s.pending
  ensures alwaysSpansWithinBuffer(t)
{
  var kept := ProofLib.Filter((span: SensitiveSpan) => span.end > cut,s.spans);
  forall span | span in t.spans
    ensures span.start >= 0 && span.end >= span.start && span.end <= |t.pending|
  {
    var i :| 0 <= i < |t.spans| && t.spans[i] == span;
    var prior := kept[i];
    assert prior in kept;
    ProofLib.FilterMember((p: SensitiveSpan) => p.end > cut,s.spans,prior);
    assert prior in s.spans && prior.end > cut;
    assert cut <= prior.start;
  }
}

lemma release_ensures(s: StreamBuffer, cut: int)
  ensures (inv(s) ==> canRelease(s, cut) ==> alwaysEveryCharacterRetained(release(s, cut)))
  ensures (inv(s) ==> canRelease(s, cut) ==> alwaysTokenWindowIsValid(release(s, cut)))
  ensures (inv(s) ==> canRelease(s, cut) ==> alwaysSpansWithinBuffer(release(s, cut)))
  ensures (inv(s) ==> canRelease(s, cut) ==> alwaysCancelledBufferEmpty(release(s, cut)))
  ensures (inv(s) ==> canRelease(s, cut) ==> alwaysDiscardRequiresCancellation(release(s, cut)))
{
  if inv(s) && canRelease(s,cut) {
    GuardedPartition(s.pending,cut,emptyPartition);
    var t := release(s,cut);
    assert cut <= |s.pending|;
    GuardedReleaseSpans(s,t,cut);
  }
}
