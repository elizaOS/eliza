lemma RanksBeforeIsAStrictOrder()
  ensures forall a: Candidate :: !ranksBefore(a, a)
  ensures forall a: Candidate, b: Candidate :: ranksBefore(a, b) ==> !ranksBefore(b, a)
  ensures forall a: Candidate, b: Candidate :: a.id != b.id ==> ranksBefore(a, b) || ranksBefore(b, a)
  ensures forall a: Candidate, b: Candidate, c: Candidate :: ranksBefore(a, b) && ranksBefore(b, c) ==> ranksBefore(a, c)
{
}

lemma InsertRankedFilter(ranked: seq<Candidate>, c: Candidate)
  ensures insertRanked(ranked, c) == ((ProofLib.Filter((other: Candidate) => ranksBefore(other, c), ranked) + [c]) + ProofLib.Filter((other: Candidate) => !(ranksBefore(other, c)), ranked))
{
}

lemma DistinctIdsFilter(candidates: seq<Candidate>)
  ensures distinctIds(candidates) == !((exists c :: c in candidates && !((|ProofLib.Filter((other: Candidate) => (other.id == c.id), candidates)| == 1))))
{
}

lemma ScopeFilter(candidates: seq<Candidate>, scopes: seq<string>, limit: int)
  ensures retrieve(candidates, scopes, limit) == (if (limit <= 0) then [] else firstOf(rank(ProofLib.Filter((c: Candidate) => (c.scope in scopes), candidates)), limit))
{
}

lemma FilterSorted(p: Candidate -> bool, s: seq<Candidate>)
  requires forall i, j :: 0 <= i < j < |s| ==> ranksBefore(s[i], s[j])
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(p, s)| ==> ranksBefore(ProofLib.Filter(p, s)[i], ProofLib.Filter(p, s)[j])
  decreases |s|
{
  if |s| == 0 {
    ProofLib.FilterNil(p, s);
  } else {
    ProofLib.FilterCons(p, s);
    FilterSorted(p, s[1..]);
    var t := ProofLib.Filter(p, s[1..]);
    forall k | 0 <= k < |t|
      ensures ranksBefore(s[0], t[k])
    {
      ProofLib.FilterMember(p, s[1..], t[k]);
      var m :| 0 <= m < |s[1..]| && s[1..][m] == t[k];
      assert s[m + 1] == t[k];
    }
    var u := ProofLib.Filter(p, s);
    forall i, j | 0 <= i < j < |u|
      ensures ranksBefore(u[i], u[j])
    {
      if p(s[0]) {
        assert u == [s[0]] + t;
        if i > 0 {
          assert u[i] == t[i - 1] && u[j] == t[j - 1];
        } else {
          assert u[j] == t[j - 1];
        }
      } else {
        assert u == t;
      }
    }
  }
}

lemma InsertMembers(ranked: seq<Candidate>, c: Candidate)
  ensures forall x :: x in insertRanked(ranked, c) <==> x in ranked || x == c
{
  InsertRankedFilter(ranked, c);
  forall x
    ensures x in insertRanked(ranked, c) <==> x in ranked || x == c
  {
    ProofLib.FilterMember((other: Candidate) => ranksBefore(other, c), ranked, x);
    ProofLib.FilterMember((other: Candidate) => !(ranksBefore(other, c)), ranked, x);
  }
}

lemma InsertSorted(ranked: seq<Candidate>, c: Candidate)
  requires forall i, j :: 0 <= i < j < |ranked| ==> ranksBefore(ranked[i], ranked[j])
  requires forall o :: o in ranked ==> o.id != c.id
  ensures forall i, j :: 0 <= i < j < |insertRanked(ranked, c)| ==> ranksBefore(insertRanked(ranked, c)[i], insertRanked(ranked, c)[j])
{
  RanksBeforeIsAStrictOrder();
  InsertRankedFilter(ranked, c);
  var a := ProofLib.Filter((other: Candidate) => ranksBefore(other, c), ranked);
  var b := ProofLib.Filter((other: Candidate) => !(ranksBefore(other, c)), ranked);
  FilterSorted((other: Candidate) => ranksBefore(other, c), ranked);
  FilterSorted((other: Candidate) => !(ranksBefore(other, c)), ranked);
  forall x | x in a
    ensures ranksBefore(x, c)
  {
    ProofLib.FilterMember((other: Candidate) => ranksBefore(other, c), ranked, x);
  }
  forall x | x in b
    ensures ranksBefore(c, x)
  {
    ProofLib.FilterMember((other: Candidate) => !(ranksBefore(other, c)), ranked, x);
  }
  var s := a + [c] + b;
  assert insertRanked(ranked, c) == s;
  forall i, j | 0 <= i < j < |s|
    ensures ranksBefore(s[i], s[j])
  {
    if j < |a| {
      assert s[i] == a[i] && s[j] == a[j];
    } else if i < |a| {
      assert s[i] in a;
      if j > |a| {
        assert s[j] == b[j - |a| - 1];
      }
    } else if i == |a| {
      assert s[j] == b[j - |a| - 1];
    } else {
      assert s[i] == b[i - |a| - 1] && s[j] == b[j - |a| - 1];
    }
  }
}

lemma RankAppend(xs: seq<Candidate>)
  requires |xs| > 0
  ensures rank(xs) == insertRanked(rank(xs[..|xs| - 1]), xs[|xs| - 1])
{
  assert xs == xs[..|xs| - 1] + [xs[|xs| - 1]];
  ProofLib.FoldLeftAppend((ranked: seq<Candidate>, c: Candidate) => insertRanked(ranked, c), [], xs[..|xs| - 1], xs[|xs| - 1]);
}

lemma RankMembers(xs: seq<Candidate>)
  ensures forall x :: x in rank(xs) <==> x in xs
  decreases |xs|
{
  if |xs| > 0 {
    RankAppend(xs);
    RankMembers(xs[..|xs| - 1]);
    InsertMembers(rank(xs[..|xs| - 1]), xs[|xs| - 1]);
    assert forall x :: x in xs <==> x in xs[..|xs| - 1] || x == xs[|xs| - 1];
  }
}

lemma RankSorted(xs: seq<Candidate>)
  requires forall x, y :: x in xs && y in xs && x.id == y.id ==> x == y
  requires ProofLib.Distinct(xs)
  ensures forall i, j :: 0 <= i < j < |rank(xs)| ==> ranksBefore(rank(xs)[i], rank(xs)[j])
  ensures forall x :: x in rank(xs) <==> x in xs
  decreases |xs|
{
  RankMembers(xs);
  if |xs| > 0 {
    var init := xs[..|xs| - 1];
    var last := xs[|xs| - 1];
    RankAppend(xs);
    assert forall x :: x in init ==> x in xs;
    RankSorted(init);
    assert last !in init;
    InsertSorted(rank(init), last);
  }
}

lemma DistinctIdsApart(xs: seq<Candidate>)
  requires distinctIds(xs)
  ensures forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> xs[i].id != xs[j].id
  ensures ProofLib.Distinct(xs)
  ensures forall x, y :: x in xs && y in xs && x.id == y.id ==> x == y
{
  DistinctIdsFilter(xs);
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures xs[i].id != xs[j].id
  {
    if xs[i].id == xs[j].id {
      ProofLib.FilterTwo((other: Candidate) => (other.id == xs[i].id), xs, i, j);
      assert xs[i] in xs;
    }
  }
}

lemma SeqSetCard(s: seq<Candidate>)
  ensures |(set x | x in s)| <= |s|
  ensures ProofLib.Distinct(s) ==> |(set x | x in s)| == |s|
  ensures !ProofLib.Distinct(s) ==> |(set x | x in s)| < |s|
  decreases |s|
{
  if |s| > 0 {
    SeqSetCard(s[1..]);
    var t := set x | x in s[1..];
    assert (set x | x in s) == t + {s[0]};
    assert forall i :: 0 <= i < |s[1..]| ==> s[1..][i] == s[i + 1];
    if s[0] in s[1..] {
      assert t + {s[0]} == t;
    } else {
      assert ProofLib.Distinct(s[1..]) ==> ProofLib.Distinct(s);
      if !ProofLib.Distinct(s) {
        var i, j :| 0 <= i < j < |s| && s[i] == s[j];
        assert i > 0;
        assert s[1..][i - 1] == s[1..][j - 1];
      }
    }
  }
}

lemma SortedUnique(a: seq<Candidate>, b: seq<Candidate>)
  requires forall i, j :: 0 <= i < j < |a| ==> ranksBefore(a[i], a[j])
  requires forall i, j :: 0 <= i < j < |b| ==> ranksBefore(b[i], b[j])
  requires forall x :: x in a <==> x in b
  ensures a == b
  decreases |a|
{
  RanksBeforeIsAStrictOrder();
  if |a| == 0 {
    if |b| > 0 {
      assert b[0] in a;
    }
  } else {
    assert a[0] in b;
    assert b[0] in a;
    if a[0] != b[0] {
      var k :| 0 <= k < |b| && b[k] == a[0];
      var m :| 0 <= m < |a| && a[m] == b[0];
      assert ranksBefore(b[0], b[k]);
      assert ranksBefore(a[0], a[m]);
    }
    forall x
      ensures x in a[1..] <==> x in b[1..]
    {
      if x in a[1..] {
        var i :| 0 <= i < |a[1..]| && a[1..][i] == x;
        assert ranksBefore(a[0], a[i + 1]);
      }
      if x in b[1..] {
        var i :| 0 <= i < |b[1..]| && b[1..][i] == x;
        assert ranksBefore(b[0], b[i + 1]);
      }
      assert x in a <==> x == a[0] || x in a[1..];
      assert x in b <==> x == b[0] || x in b[1..];
    }
    SortedUnique(a[1..], b[1..]);
    assert a == [a[0]] + a[1..];
    assert b == [b[0]] + b[1..];
  }
}

lemma OrderedFold(check: OrderCheck, s: seq<Candidate>)
  requires check.valid
  requires forall i, j :: 0 <= i < j < |s| ==> ranksBefore(s[i], s[j])
  requires check.started && |s| > 0 ==> ranksBefore(check.previous, s[0])
  ensures Std.Collections.Seq.FoldLeft((check: OrderCheck, c: Candidate) => OrderCheck(c, true, (check.valid && (!(check.started) || ranksBefore(check.previous, c)))), check, s).valid
  decreases |s|
{
  if |s| > 0 {
    if |s| > 1 {
      assert ranksBefore(s[0], s[1]);
    }
    OrderedFold(OrderCheck(s[0], true, true), s[1..]);
  }
}

lemma lawRankIsOrdered_ensures(candidates: seq<Candidate>)
  ensures (lawRankIsOrdered(candidates) == true)
{
  if distinctIds(candidates) {
    DistinctIdsApart(candidates);
    RankSorted(candidates);
    OrderedFold(OrderCheck(noCandidate, false, true), rank(candidates));
  }
}

lemma lawRankIgnoresAnyStoreOrder_ensures(candidates: seq<Candidate>, shuffled: seq<Candidate>)
  ensures (lawRankIgnoresAnyStoreOrder(candidates, shuffled) == true)
{
  if distinctIds(candidates) && sameMembers(candidates, shuffled) {
    DistinctIdsApart(candidates);
    SeqSetCard(candidates);
    SeqSetCard(shuffled);
    assert (set x | x in candidates) == (set x | x in shuffled);
    RankSorted(candidates);
    RankSorted(shuffled);
    SortedUnique(rank(candidates), rank(shuffled));
  }
}

lemma ReversedFold(acc: seq<Candidate>, xs: seq<Candidate>)
  ensures |Std.Collections.Seq.FoldLeft((acc: seq<Candidate>, c: Candidate) => ([c] + acc), acc, xs)| == |acc| + |xs|
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((acc: seq<Candidate>, c: Candidate) => ([c] + acc), acc, xs) <==> x in acc || x in xs
  decreases |xs|
{
  if |xs| > 0 {
    ReversedFold([xs[0]] + acc, xs[1..]);
    assert forall x :: x in xs <==> x == xs[0] || x in xs[1..];
  }
}

lemma lawRankIgnoresStoreOrder_ensures(candidates: seq<Candidate>)
  ensures (lawRankIgnoresStoreOrder(candidates) == true)
{
  ReversedFold([], candidates);
  lawRankIgnoresAnyStoreOrder_ensures(candidates, reversed(candidates));
}

lemma FirstOfFold(page: seq<Candidate>, ranked: seq<Candidate>, limit: int)
  requires |page| <= limit
  ensures |Std.Collections.Seq.FoldLeft((page: seq<Candidate>, c: Candidate) => (if (|page| < limit) then (page + [c]) else page), page, ranked)| <= limit
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((page: seq<Candidate>, c: Candidate) => (if (|page| < limit) then (page + [c]) else page), page, ranked) ==> x in page || x in ranked
  decreases |ranked|
{
  if |ranked| > 0 {
    assert forall x :: x in ranked[1..] ==> x in ranked;
    FirstOfFold(if (|page| < limit) then (page + [ranked[0]]) else page, ranked[1..], limit);
  }
}

lemma lawPageHoldsAtMostTheLimit_ensures(candidates: seq<Candidate>, scopes: seq<string>, limit: int)
  ensures (lawPageHoldsAtMostTheLimit(candidates, scopes, limit) == true)
{
  ScopeFilter(candidates, scopes, limit);
  if limit > 0 {
    var ranked := rank(ProofLib.Filter((c: Candidate) => (c.scope in scopes), candidates));
    assert firstOf(ranked, limit) == Std.Collections.Seq.FoldLeft((page: seq<Candidate>, c: Candidate) => (if (|page| < limit) then (page + [c]) else page), [], ranked);
    FirstOfFold([], ranked, limit);
  }
}

lemma lawResultsStayInScope_ensures(candidates: seq<Candidate>, scopes: seq<string>, limit: int)
  ensures (lawResultsStayInScope(candidates, scopes, limit) == true)
{
  ScopeFilter(candidates, scopes, limit);
  if limit > 0 {
    var kept := ProofLib.Filter((c: Candidate) => (c.scope in scopes), candidates);
    assert firstOf(rank(kept), limit) == Std.Collections.Seq.FoldLeft((page: seq<Candidate>, c: Candidate) => (if (|page| < limit) then (page + [c]) else page), [], rank(kept));
    FirstOfFold([], rank(kept), limit);
    RankMembers(kept);
    forall x | x in kept
      ensures x.scope in scopes
    {
      ProofLib.FilterMember((c: Candidate) => (c.scope in scopes), candidates, x);
    }
  }
}
