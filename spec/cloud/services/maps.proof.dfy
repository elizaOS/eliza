lemma PlaceIndexesFold(f: (seq<int>, int) -> seq<int>, acc: seq<int>, xs: seq<int>)
  requires forall a, p :: f(a, p) == a + [|a|]
  ensures var res := Std.Collections.Seq.FoldLeft(f, acc, xs);
    |res| == |acc| + |xs|
    && (forall k :: 0 <= k < |acc| ==> res[k] == acc[k])
    && (forall i :: |acc| <= i < |acc| + |xs| ==> res[i] == i)
  decreases |xs|
{
  if |xs| > 0 {
    var next := acc + [|acc|];
    assert f(acc, xs[0]) == next;
    PlaceIndexesFold(f, next, xs[1..]);
  }
}

lemma PlaceIndexesSpec(xs: seq<int>)
  ensures |placeIndexes(xs)| == |xs|
  ensures forall k :: 0 <= k < |xs| ==> placeIndexes(xs)[k] == k
  ensures forall x :: x in placeIndexes(xs) <==> 0 <= x < |xs|
{
  var f := (indexes: seq<int>, place: int) => (indexes + [|indexes|]);
  PlaceIndexesFold(f, [], xs);
  forall x ensures x in placeIndexes(xs) <==> 0 <= x < |xs| {
    if 0 <= x < |xs| {
      assert placeIndexes(xs)[x] == x;
    }
  }
}

lemma NearerTotalOrder(meters: seq<int>, a: int, b: int, c: int)
  ensures !nearerThan(meters, a, a)
  ensures nearerThan(meters, a, b) ==> !nearerThan(meters, b, a)
  ensures nearerThan(meters, a, b) && nearerThan(meters, b, c) ==> nearerThan(meters, a, c)
  ensures a != b ==> nearerThan(meters, a, b) || nearerThan(meters, b, a)
{
}

lemma SeqToSetCard(xs: seq<int>)
  requires ProofLib.Distinct(xs)
  ensures |set x | x in xs| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    assert (set x | x in xs) == {};
  } else {
    var tail := xs[1..];
    assert ProofLib.Distinct(tail);
    SeqToSetCard(tail);
    assert !(xs[0] in tail);
    assert (set x | x in xs) == (set x | x in tail) + {xs[0]};
  }
}

lemma FilterDistinct(p: int -> bool, xs: seq<int>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    var tail := xs[1..];
    FilterDistinct(p, tail);
    var ft := ProofLib.Filter(p, tail);
    if p(xs[0]) {
      assert ProofLib.Filter(p, xs) == [xs[0]] + ft;
      forall j | 0 <= j < |ft| ensures ft[j] != xs[0] {
        ProofLib.FilterMember(p, tail, ft[j]);
        assert ft[j] in tail;
      }
    }
  }
}

lemma RankOrder(meters: seq<int>, idxs: seq<int>, a: int, b: int)
  requires |idxs| == |meters| && (forall k :: 0 <= k < |idxs| ==> idxs[k] == k)
  requires 0 <= a < |meters| && 0 <= b < |meters| && nearerThan(meters, a, b)
  ensures |ProofLib.Filter((j: int) => nearerThan(meters, j, a), idxs)| < |ProofLib.Filter((j: int) => nearerThan(meters, j, b), idxs)|
{
  var pa := (j: int) => nearerThan(meters, j, a);
  var pb := (j: int) => nearerThan(meters, j, b);
  forall i | 0 <= i < |idxs| && pa(idxs[i]) ensures pb(idxs[i]) {
    NearerTotalOrder(meters, idxs[i], a, b);
  }
  assert 0 <= a < |idxs| && pb(idxs[a]) && !pa(idxs[a]);
  ProofLib.FilterImpLength(pa, pb, idxs);
}

lemma RankInjective(meters: seq<int>, idxs: seq<int>, a: int, b: int)
  requires |idxs| == |meters| && (forall k :: 0 <= k < |idxs| ==> idxs[k] == k)
  requires 0 <= a < |meters| && 0 <= b < |meters|
  requires |ProofLib.Filter((j: int) => nearerThan(meters, j, a), idxs)| == |ProofLib.Filter((j: int) => nearerThan(meters, j, b), idxs)|
  ensures a == b
{
  if a != b {
    NearerTotalOrder(meters, a, b, a);
    if nearerThan(meters, a, b) {
      RankOrder(meters, idxs, a, b);
    } else {
      RankOrder(meters, idxs, b, a);
    }
  }
}

lemma SetHasMin(meters: seq<int>, s: set<int>) returns (m: int)
  requires |s| > 0
  ensures m in s
  ensures forall x :: x in s && x != m ==> nearerThan(meters, m, x)
  decreases |s|
{
  var y :| y in s;
  var rest := s - {y};
  assert rest + {y} == s;
  if rest == {} {
    m := y;
  } else {
    var r := SetHasMin(meters, rest);
    NearerTotalOrder(meters, y, r, y);
    m := if nearerThan(meters, y, r) then y else r;
    forall x | x in s && x != m ensures nearerThan(meters, m, x) {
      if m == y {
        if x != r {
          assert x in rest;
          assert nearerThan(meters, r, x);
          NearerTotalOrder(meters, y, r, x);
        }
      } else if x != y {
        assert x in rest;
      } else {
        assert nearerThan(meters, r, y);
      }
    }
  }
}

lemma BuildRankPrefix(meters: seq<int>, idxs: seq<int>, k: int) returns (ordered: seq<int>)
  requires |idxs| == |meters| && (forall i :: 0 <= i < |idxs| ==> idxs[i] == i)
  requires 0 <= k <= |meters|
  ensures |ordered| == k
  ensures ProofLib.Distinct(ordered)
  ensures forall p :: 0 <= p < k ==> 0 <= ordered[p] < |meters| && |ProofLib.Filter((j: int) => nearerThan(meters, j, ordered[p]), idxs)| == p
  decreases k
{
  if k == 0 {
    ordered := [];
  } else {
    var prev := BuildRankPrefix(meters, idxs, k - 1);
    var allIdx := set x | x in idxs;
    var prevSet := set x | x in prev;
    assert ProofLib.Distinct(idxs);
    SeqToSetCard(idxs);
    assert |allIdx| == |meters|;
    SeqToSetCard(prev);
    assert |prevSet| == k - 1;
    forall x | x in prevSet ensures x in allIdx {
      var p :| 0 <= p < k - 1 && prev[p] == x;
      assert idxs[x] == x;
    }
    assert prevSet <= allIdx;
    var rem := allIdx - prevSet;
    assert |rem| == |allIdx| - |prevSet|;
    assert |rem| > 0;
    var m := SetHasMin(meters, rem);
    assert m in idxs;
    var mIdx :| 0 <= mIdx < |idxs| && idxs[mIdx] == m;
    assert 0 <= m < |meters|;
    var pm := (j: int) => nearerThan(meters, j, m);
    var filt := ProofLib.Filter(pm, idxs);
    FilterDistinct(pm, idxs);
    SeqToSetCard(filt);
    forall x ensures x in (set z | z in filt) <==> x in prevSet {
      ProofLib.FilterMember(pm, idxs, x);
      if x in filt {
        assert x in idxs && nearerThan(meters, x, m);
        assert x in allIdx;
        if x in rem {
          assert x != m;
          assert nearerThan(meters, m, x);
          NearerTotalOrder(meters, x, m, x);
          assert false;
        }
        assert x in prevSet;
      }
      if x in prevSet {
        var p :| 0 <= p < k - 1 && prev[p] == x;
        assert 0 <= x < |meters|;
        assert idxs[x] == x;
        assert x in idxs;
        assert x != m;
        NearerTotalOrder(meters, x, m, x);
        if nearerThan(meters, m, x) {
          RankOrder(meters, idxs, m, x);
          var rm := |ProofLib.Filter((j: int) => nearerThan(meters, j, m), idxs)|;
          assert 0 <= rm < p < k - 1;
          RankInjective(meters, idxs, m, prev[rm]);
          assert m == prev[rm];
          assert m in prevSet;
          assert false;
        }
        assert pm(x);
      }
    }
    assert (set z | z in filt) == prevSet;
    assert |filt| == k - 1;
    ordered := prev + [m];
  }
}

lemma RankFilterSingleton(meters: seq<int>, idxs: seq<int>, pred: int -> bool, r: int, elem: int)
  requires |idxs| == |meters| && (forall i :: 0 <= i < |idxs| ==> idxs[i] == i)
  requires forall i :: pred(i) == (|ProofLib.Filter((j: int) => nearerThan(meters, j, i), idxs)| == r)
  requires 0 <= elem < |meters| && |ProofLib.Filter((j: int) => nearerThan(meters, j, elem), idxs)| == r
  ensures ProofLib.Filter(pred, idxs) == [elem]
{
  forall k | 0 <= k < |idxs| && k != elem ensures !pred(idxs[k]) {
    if pred(idxs[k]) {
      RankInjective(meters, idxs, idxs[k], elem);
    }
  }
  ProofLib.FilterOne(pred, idxs, elem);
  ProofLib.FilterMember(pred, idxs, elem);
  assert elem in ProofLib.Filter(pred, idxs);
}

lemma ClosestFirstFold(meters: seq<int>, idxs: seq<int>, ordered: seq<int>, step: (seq<int>, int) -> seq<int>, limit: int, k: int)
  requires |idxs| == |meters| && (forall i :: 0 <= i < |idxs| ==> idxs[i] == i)
  requires |ordered| == |meters|
  requires forall p :: 0 <= p < |meters| ==> 0 <= ordered[p] < |meters| && |ProofLib.Filter((j: int) => nearerThan(meters, j, ordered[p]), idxs)| == p
  requires forall kept, rank :: 0 <= rank < |meters| ==> step(kept, rank) == (if |kept| < limit then kept + [ordered[rank]] else kept)
  requires 0 <= k <= |meters|
  ensures var res := Std.Collections.Seq.FoldLeft(step, [], idxs[..k]);
    var target := if limit < 0 then 0 else if limit < k then limit else k;
    res == ordered[..target]
  decreases k
{
  if k == 0 {
    assert idxs[..0] == [];
  } else {
    ClosestFirstFold(meters, idxs, ordered, step, limit, k - 1);
    assert idxs[..k] == idxs[..k - 1] + [idxs[k - 1]];
    ProofLib.FoldLeftAppend(step, [], idxs[..k - 1], idxs[k - 1]);
    var prev := Std.Collections.Seq.FoldLeft(step, [], idxs[..k - 1]);
    assert idxs[k - 1] == k - 1;
    if |prev| < limit {
      assert step(prev, k - 1) == prev + [ordered[k - 1]];
      assert prev + [ordered[k - 1]] == ordered[..k];
    }
  }
}

lemma ClosestFirstSpec(meters: seq<int>, limit: int) returns (ordered: seq<int>)
  ensures |ordered| == |meters|
  ensures forall p :: 0 <= p < |meters| ==> 0 <= ordered[p] < |meters| && |ProofLib.Filter((j: int) => nearerThan(meters, j, ordered[p]), placeIndexes(meters))| == p
  ensures closestFirst(meters, limit) == ordered[..(if limit < 0 then 0 else if limit < |meters| then limit else |meters|)]
{
  var idxs := placeIndexes(meters);
  PlaceIndexesSpec(meters);
  ordered := BuildRankPrefix(meters, idxs, |meters|);
  var step := (kept: seq<int>, rank: int) => (if (|kept| < limit) then (kept + Std.Collections.Seq.Filter((i: int) => (|Std.Collections.Seq.Filter((j: int) => nearerThan(meters, j, i), idxs)| == rank), idxs)) else kept);
  forall kept: seq<int>, rank: int | 0 <= rank < |meters|
    ensures step(kept, rank) == (if |kept| < limit then kept + [ordered[rank]] else kept)
  {
    if |kept| < limit {
      var pred := (i: int) => (|Std.Collections.Seq.Filter((j: int) => nearerThan(meters, j, i), idxs)| == rank);
      forall i ensures pred(i) == (|ProofLib.Filter((j: int) => nearerThan(meters, j, i), idxs)| == rank) {
        ProofLib.FilterSamePredicate((j: int) => nearerThan(meters, j, i), (j: int) => nearerThan(meters, j, i), idxs);
      }
      RankFilterSingleton(meters, idxs, pred, rank, ordered[rank]);
      assert ProofLib.Filter(pred, idxs) == [ordered[rank]];
      ProofLib.FilterSamePredicate((i: int) => (|Std.Collections.Seq.Filter((j: int) => nearerThan(meters, j, i), idxs)| == rank), pred, idxs);
    }
  }
  ClosestFirstFold(meters, idxs, ordered, step, limit, |meters|);
  assert idxs[..|meters|] == idxs;
}

lemma lawTheAnswerHoldsTheLimitOrTheWholePage_ensures(meters: seq<int>, limit: int)
  ensures (lawTheAnswerHoldsTheLimitOrTheWholePage(meters, limit) == true)
{
  var ordered := ClosestFirstSpec(meters, limit);
}

lemma lawTheAnswerIsNearestFirst_ensures(meters: seq<int>, limit: int)
  ensures (lawTheAnswerIsNearestFirst(meters, limit) == true)
{
  var idxs := placeIndexes(meters);
  PlaceIndexesSpec(meters);
  var ordered := ClosestFirstSpec(meters, limit);
  var res := closestFirst(meters, limit);
  PlaceIndexesSpec(res);
  forall at | at in placeIndexes(res) && at != 0
    ensures nearerThan(meters, res[at - 1], res[at])
  {
    assert 0 < at < |res|;
    var a := res[at - 1];
    var b := res[at];
    NearerTotalOrder(meters, a, b, a);
    if a == b {
      assert |ProofLib.Filter((j: int) => nearerThan(meters, j, a), idxs)| == at - 1;
      assert |ProofLib.Filter((j: int) => nearerThan(meters, j, b), idxs)| == at;
      assert false;
    } else if nearerThan(meters, b, a) {
      RankOrder(meters, idxs, b, a);
      assert false;
    }
  }
}

lemma lawNoPlaceLeftOutIsNearer_ensures(meters: seq<int>, limit: int)
  ensures (lawNoPlaceLeftOutIsNearer(meters, limit) == true)
{
  var idxs := placeIndexes(meters);
  PlaceIndexesSpec(meters);
  var ordered := ClosestFirstSpec(meters, limit);
  var res := closestFirst(meters, limit);
  forall left | left in idxs && !(left in res)
    ensures forall taken :: taken in res ==> nearerThan(meters, taken, left)
  {
    var rLeft := |ProofLib.Filter((j: int) => nearerThan(meters, j, left), idxs)|;
    if rLeft < |res| {
      RankInjective(meters, idxs, left, res[rLeft]);
      assert left == res[rLeft];
      assert left in res;
    }
    forall taken | taken in res ensures nearerThan(meters, taken, left) {
      var p :| 0 <= p < |res| && res[p] == taken;
      assert taken != left;
      NearerTotalOrder(meters, taken, left, taken);
      if nearerThan(meters, left, taken) {
        RankOrder(meters, idxs, left, taken);
        assert false;
      }
    }
  }
}
