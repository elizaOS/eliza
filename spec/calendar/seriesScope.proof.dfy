lemma FoldLeftAllTrue(p: int -> bool, xs: seq<int>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures Std.Collections.Seq.FoldLeft((ok: bool, x: int) => (ok && p(x)), true, xs)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FoldLeftAllTrue(p, xs[1..]);
  }
}

lemma PartitionLengthSum(p: int -> bool, q: int -> bool, starts: seq<int>)
  requires forall x :: q(x) == !p(x)
  ensures |ProofLib.Filter(p, starts)| + |ProofLib.Filter(q, starts)| == |starts|
  decreases |starts|
{
  if |starts| == 0 {
    ProofLib.FilterNil(p, starts);
    ProofLib.FilterNil(q, starts);
  } else {
    ProofLib.FilterCons(p, starts);
    ProofLib.FilterCons(q, starts);
    PartitionLengthSum(p, q, starts[1..]);
  }
}

lemma lawSplitKeepsEveryStartOnce_ensures(starts: seq<int>, splitAt: int)
  ensures (lawSplitKeepsEveryStartOnce(starts, splitAt) == true)
{
  var split := splitStarts(starts, splitAt);
  var p := (start: int) => keptBeforeSplit(start, splitAt);
  var q := (start: int) => !(keptBeforeSplit(start, splitAt));
  assert split.kept == ProofLib.Filter(p, starts);
  assert split.moved == ProofLib.Filter(q, starts);
  PartitionLengthSum(p, q, starts);
  forall i | 0 <= i < |split.kept|
    ensures split.kept[i] < splitAt
  {
    ProofLib.FilterMember(p, starts, split.kept[i]);
  }
  forall i | 0 <= i < |split.moved|
    ensures split.moved[i] >= splitAt
  {
    ProofLib.FilterMember(q, starts, split.moved[i]);
  }
  var fl := (start: int) => (start < splitAt);
  var fg := (start: int) => (start >= splitAt);
  FoldLeftAllTrue(fl, split.kept);
  FoldLeftAllTrue(fg, split.moved);
  ProofLib.FoldLeftPointwise((ok: bool, x: int) => (ok && fl(x)), (ok: bool, start: int) => (ok && (start < splitAt)), true, split.kept, split.kept);
  ProofLib.FoldLeftPointwise((ok: bool, x: int) => (ok && fg(x)), (ok: bool, start: int) => (ok && (start >= splitAt)), true, split.moved, split.moved);
}
