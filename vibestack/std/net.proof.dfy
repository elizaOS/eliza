lemma TakeBelow(xs: seq<int>, i: int, c: Cut, n: int)
  requires below(xs, n) && below(c.kept, n)
  ensures below(Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), c, xs).kept, n)
  decreases |xs|
{
  if |xs| > 0 {
    var f := (c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1));
    var next := f(c, xs[0]);
    assert below(xs[1..], n) by {
      forall id | id in xs[1..] ensures 0 <= id < n {
        assert id in xs;
      }
    }
    assert below(next.kept, n) by {
      forall id | id in next.kept ensures 0 <= id < n {
        if !(id in c.kept) {
          assert id == xs[0];
          assert id in xs;
        }
      }
    }
    TakeBelow(xs[1..], i, next, n);
  }
}

lemma TakeLength(xs: seq<int>, i: int, c: Cut)
  ensures |Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), c, xs).kept| == |c.kept| + |xs| - (if c.k <= i < c.k + |xs| then 1 else 0)
  decreases |xs|
{
  if |xs| > 0 {
    var f := (c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1));
    TakeLength(xs[1..], i, f(c, xs[0]));
  }
}

lemma lawTakingStaysBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawTakingStaysBelow(flight, i, n) == true)
{
  if below(flight, n) { TakeBelow(flight, i, Cut([], 0), n); }
}

lemma lawRepeatingStaysBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawRepeatingStaysBelow(flight, i, n) == true)
{
  if below(flight, n) {
    if has(flight, i) { assert flight[i] in flight; }
    assert below(repeat(flight, i), n) by {
      forall id | id in repeat(flight, i) ensures 0 <= id < n {
        if !(id in flight) {
          assert has(flight, i) && id == flight[i];
          assert id in flight;
        }
      }
    }
  }
}

lemma lawWhatIsAtAPositionIsBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawWhatIsAtAPositionIsBelow(flight, i, n) == true)
{
  if below(flight, n) && has(flight, i) {
    assert flight[i] in flight;
  }
}

lemma lawTakingRemovesOne_ensures(flight: seq<int>, i: int)
  ensures (lawTakingRemovesOne(flight, i) == true)
{
  TakeLength(flight, i, Cut([], 0));
}
