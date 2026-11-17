lemma lawReadKeepsEveryEntry_ensures(order: seq<int>, key: int)
  ensures (lawReadKeepsEveryEntry(order, key) == true)
{
  if distinctKeys(order) && |ProofLib.Filter((k: int) => (k == key), order)| > 0 {
    DistinctKeysCountOne(order, key);
    SplitCount(order, key);
  }
}

lemma lawRewriteEvictsNothing_ensures(order: seq<int>, key: int)
  ensures (lawRewriteEvictsNothing(order, key) == true)
{
  var d := (k: int) => (k != key);
  if distinctKeys(order) && |order| <= lruCapacity && |ProofLib.Filter((k: int) => (k == key), order)| == 1 {
    SplitCount(order, key);
    var w := lruWrite(order, key);
    assert w == ProofLib.Filter(d, order) + [key];
    FoldAnd((ok: bool, k: int) => (ok && (|Std.Collections.Seq.Filter((other: int) => (other == k), order)| == 1)), true, order);
    forall i | 0 <= i < |order| ensures |ProofLib.Filter((other: int) => (other == order[i]), w)| == 1 {
      var x := order[i];
      var q := (other: int) => (other == x);
      ProofLib.FilterAppend(q, ProofLib.Filter(d, order), key);
      if x == key {
        forall j | 0 <= j < |ProofLib.Filter(d, order)| ensures !q(ProofLib.Filter(d, order)[j]) {
          ProofLib.FilterMember(d, order, ProofLib.Filter(d, order)[j]);
        }
        ProofLib.FilterNone(q, ProofLib.Filter(d, order));
      } else {
        FilterThroughWeaker(d, q, order);
      }
    }
    FoldAnd((ok: bool, k: int) => (ok && (|Std.Collections.Seq.Filter((other: int) => (other == k), lruWrite(order, key))| == 1)), true, order);
  }
}

lemma FoldAnd(f: (bool, int) -> bool, acc: bool, xs: seq<int>)
  requires forall a, k :: f(a, k) == (a && f(true, k))
  ensures Std.Collections.Seq.FoldLeft(f, acc, xs) == (acc && forall i :: 0 <= i < |xs| ==> f(true, xs[i]))
  decreases |xs|
{
  if |xs| > 0 {
    FoldAnd(f, f(acc, xs[0]), xs[1..]);
    assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma DistinctKeysCountOne(order: seq<int>, key: int)
  requires distinctKeys(order) && |ProofLib.Filter((k: int) => (k == key), order)| > 0
  ensures |ProofLib.Filter((k: int) => (k == key), order)| == 1
{
  ProofLib.FilterNone((k: int) => (k == key), order);
  var i :| 0 <= i < |order| && order[i] == key;
  FoldAnd((ok: bool, k: int) => (ok && (|Std.Collections.Seq.Filter((other: int) => (other == k), order)| == 1)), true, order);
  ProofLib.FilterSamePredicate((other: int) => (other == order[i]), (k: int) => (k == key), order);
}

lemma SplitCount(xs: seq<int>, key: int)
  ensures |ProofLib.Filter((k: int) => (k != key), xs)| + |ProofLib.Filter((k: int) => (k == key), xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((k: int) => (k != key), xs);
    ProofLib.FilterNil((k: int) => (k == key), xs);
  } else {
    ProofLib.FilterCons((k: int) => (k != key), xs);
    ProofLib.FilterCons((k: int) => (k == key), xs);
    SplitCount(xs[1..], key);
  }
}

lemma FilterThroughWeaker(d: int -> bool, q: int -> bool, xs: seq<int>)
  requires forall y :: q(y) ==> d(y)
  ensures ProofLib.Filter(q, ProofLib.Filter(d, xs)) == ProofLib.Filter(q, xs)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(d, xs);
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(q, ProofLib.Filter(d, xs));
  } else {
    var r := ProofLib.Filter(d, xs[1..]);
    ProofLib.FilterCons(d, xs);
    ProofLib.FilterCons(q, xs);
    FilterThroughWeaker(d, q, xs[1..]);
    if d(xs[0]) {
      ProofLib.FilterCons(q, [xs[0]] + r);
      assert ([xs[0]] + r)[1..] == r;
    } else {
      assert ProofLib.Filter(d, xs) == r;
    }
  }
}
