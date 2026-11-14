// General lemmas for proof files (spec/<path>.proof.dfy, src/<path>.proof.dfy).
// The tools add this module to every proof unit that has a proof file, with
// only the declarations the proof file calls and those they use (`libraryFor`
// in vibestack/prove.ts), and verify it there; call its lemmas as ProofLib.<Name>(...).
//
// How proof files use it: .claude/skills/prove/SKILL.md, "Proof files".
//
// Dafny makes the module's import visible as ProofLib.Seq; proof files may not
// use it (vibestack/prove.ts refuses any ProofLib.<name> this file does not declare),
// since the standard library holds axioms.
module ProofLib {
  import Std.Collections.Seq

  /** Std.Collections.Seq.Filter without a reads clause. */
  ghost function Filter<T>(p: T -> bool, xs: seq<T>): seq<T> { Seq.Filter(p, xs) }

  /** No two positions hold the same value. */
  ghost predicate Distinct<T>(xs: seq<T>) { forall i, j :: 0 <= i < j < |xs| ==> xs[i] != xs[j] }

  /** No two positions hold the same key. */
  ghost predicate DistinctBy<T, K>(xs: seq<T>, key: T -> K) {
    forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> key(xs[i]) != key(xs[j])
  }

  // --- Filter ---------------------------------------------------------------

  lemma FilterNil<T>(p: T -> bool, xs: seq<T>)
    requires |xs| == 0
    ensures Filter(p, xs) == []
  {
    reveal Seq.Filter();
  }

  lemma FilterCons<T>(p: T -> bool, xs: seq<T>)
    requires |xs| > 0
    ensures Filter(p, xs) == (if p(xs[0]) then [xs[0]] else []) + Filter(p, xs[1..])
  {
    reveal Seq.Filter();
  }

  /** Filtering a list with one more element at the end. */
  lemma FilterAppend<T>(p: T -> bool, xs: seq<T>, x: T)
    ensures Filter(p, xs + [x]) == Filter(p, xs) + (if p(x) then [x] else [])
    decreases |xs|
  {
    if |xs| == 0 {
      assert xs + [x] == [x];
      FilterCons(p, [x]);
      FilterNil(p, [x][1..]);
      FilterNil(p, xs);
    } else {
      FilterCons(p, xs + [x]);
      FilterCons(p, xs);
      assert (xs + [x])[1..] == xs[1..] + [x];
      FilterAppend(p, xs[1..], x);
    }
  }

  /** What a filter keeps is exactly what is in the list and passes. */
  lemma FilterMember<T>(p: T -> bool, xs: seq<T>, x: T)
    ensures x in Filter(p, xs) <==> x in xs && p(x)
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(p, xs);
    } else {
      FilterCons(p, xs);
      FilterMember(p, xs[1..], x);
      assert xs == [xs[0]] + xs[1..];
    }
  }

  /** Every element of a filter came from the list. */
  lemma FilterSubset<T>(p: T -> bool, xs: seq<T>)
    ensures forall i :: 0 <= i < |Filter(p, xs)| ==> Filter(p, xs)[i] in xs
  {
    forall i | 0 <= i < |Filter(p, xs)| { FilterMember(p, xs, Filter(p, xs)[i]); }
  }

  /** A filter is empty exactly when nothing passes. */
  lemma FilterNone<T>(p: T -> bool, xs: seq<T>)
    ensures |Filter(p, xs)| == 0 <==> forall i :: 0 <= i < |xs| ==> !p(xs[i])
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(p, xs);
    } else {
      FilterCons(p, xs);
      FilterNone(p, xs[1..]);
      assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
    }
  }

  /** Only position i passes: the filter has one element. */
  lemma FilterOne<T>(p: T -> bool, xs: seq<T>, i: int)
    requires 0 <= i < |xs| && p(xs[i])
    requires forall j :: 0 <= j < |xs| && j != i ==> !p(xs[j])
    ensures |Filter(p, xs)| == 1
    decreases |xs|
  {
    FilterCons(p, xs);
    if i == 0 {
      assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
      FilterNone(p, xs[1..]);
    } else {
      assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
      FilterOne(p, xs[1..], i - 1);
    }
  }

  /** Two positions pass: the filter has at least two elements. */
  lemma FilterTwo<T>(p: T -> bool, xs: seq<T>, i: int, j: int)
    requires 0 <= i < |xs| && 0 <= j < |xs| && i != j && p(xs[i]) && p(xs[j])
    ensures |Filter(p, xs)| >= 2
    decreases |xs|
  {
    FilterCons(p, xs);
    if i == 0 || j == 0 {
      var k := if i == 0 then j else i;
      assert xs[k] == xs[1..][k - 1];
      FilterMember(p, xs[1..], xs[k]);
    } else {
      FilterTwo(p, xs[1..], i - 1, j - 1);
    }
  }

  /** When p means "has the key of xs[i]", one match means no other element has that key. */
  lemma FilterCountOneIffUnique<T, K>(p: T -> bool, xs: seq<T>, key: T -> K, i: int)
    requires 0 <= i < |xs|
    requires forall j :: 0 <= j < |xs| ==> p(xs[j]) == (key(xs[j]) == key(xs[i]))
    ensures |Filter(p, xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> key(xs[j]) != key(xs[i])
  {
    if forall j :: 0 <= j < |xs| && j != i ==> key(xs[j]) != key(xs[i]) {
      FilterOne(p, xs, i);
    } else {
      var j :| 0 <= j < |xs| && j != i && key(xs[j]) == key(xs[i]);
      FilterTwo(p, xs, i, j);
    }
  }

  /** In a list without repeats, the filter for one of its values has one element. */
  lemma FilterDistinctCountOne<T>(p: T -> bool, xs: seq<T>, o: T)
    requires forall x :: p(x) == (x == o)
    requires Distinct(xs) && o in xs
    ensures |Filter(p, xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == o;
    FilterOne(p, xs, i);
  }

  /** Filtering keeps keys distinct. */
  lemma FilterKeepsDistinctBy<T, K>(p: T -> bool, xs: seq<T>, key: T -> K)
    requires DistinctBy(xs, key)
    ensures DistinctBy(Filter(p, xs), key)
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(p, xs);
    } else {
      FilterCons(p, xs);
      var rest := Filter(p, xs[1..]);
      assert DistinctBy(xs[1..], key) by {
        forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j ensures key(xs[1..][i]) != key(xs[1..][j]) {
          assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
        }
      }
      FilterKeepsDistinctBy(p, xs[1..], key);
      forall m | 0 <= m < |rest| ensures key(rest[m]) != key(xs[0]) {
        FilterMember(p, xs[1..], rest[m]);
        var n :| 0 <= n < |xs[1..]| && xs[1..][n] == rest[m];
        assert xs[n + 1] == rest[m];
      }
    }
  }

  /** Two lists of the same length whose elements pass alike, position by position, keep as many. */
  lemma FilterLengthPointwise<T, U>(p: T -> bool, q: U -> bool, xs: seq<T>, ys: seq<U>)
    requires |xs| == |ys|
    requires forall i :: 0 <= i < |xs| ==> p(xs[i]) == q(ys[i])
    ensures |Filter(p, xs)| == |Filter(q, ys)|
  {
    FilterPointwise(p, q, (x: T, y: U) => true, xs, ys);
  }

  /** As FilterLengthPointwise, and what is kept stays related by r, position by position. */
  lemma FilterPointwise<T, U>(p: T -> bool, q: U -> bool, r: (T, U) -> bool, xs: seq<T>, ys: seq<U>)
    requires |xs| == |ys|
    requires forall i :: 0 <= i < |xs| ==> p(xs[i]) == q(ys[i]) && r(xs[i], ys[i])
    ensures |Filter(p, xs)| == |Filter(q, ys)|
    ensures forall i :: 0 <= i < |Filter(p, xs)| ==> r(Filter(p, xs)[i], Filter(q, ys)[i])
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(p, xs);
      FilterNil(q, ys);
    } else {
      FilterCons(p, xs);
      FilterCons(q, ys);
      assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
      FilterPointwise(p, q, r, xs[1..], ys[1..]);
    }
  }

  /** Two predicates that agree on every element filter alike. */
  lemma FilterSamePredicate<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
    requires forall i :: 0 <= i < |xs| ==> p(xs[i]) == q(xs[i])
    ensures Filter(p, xs) == Filter(q, xs)
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(p, xs);
      FilterNil(q, xs);
    } else {
      FilterCons(p, xs);
      FilterCons(q, xs);
      assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
      FilterSamePredicate(p, q, xs[1..]);
    }
  }

  /** A predicate that passes less often keeps no more, and fewer if it fails somewhere the other passes. */
  lemma FilterImpLength<T>(f: T -> bool, g: T -> bool, xs: seq<T>)
    requires forall i :: 0 <= i < |xs| && f(xs[i]) ==> g(xs[i])
    ensures |Filter(f, xs)| <= |Filter(g, xs)|
    ensures (exists i :: 0 <= i < |xs| && g(xs[i]) && !f(xs[i])) ==> |Filter(f, xs)| < |Filter(g, xs)|
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(f, xs);
      FilterNil(g, xs);
    } else {
      FilterCons(f, xs);
      FilterCons(g, xs);
      assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
      FilterImpLength(f, g, xs[1..]);
      if exists i :: 0 <= i < |xs| && g(xs[i]) && !f(xs[i]) {
        var i :| 0 <= i < |xs| && g(xs[i]) && !f(xs[i]);
        if i > 0 {
          assert xs[1..][i - 1] == xs[i];
        }
      }
    }
  }

  /** As FilterImpLength, after first keeping only what d passes. */
  lemma FilterOfFilterLength<T>(d: T -> bool, f: T -> bool, g: T -> bool, xs: seq<T>)
    requires forall i :: 0 <= i < |xs| && d(xs[i]) && f(xs[i]) ==> g(xs[i])
    ensures |Filter(f, Filter(d, xs))| <= |Filter(g, xs)|
    ensures (exists i :: 0 <= i < |xs| && g(xs[i]) && !(d(xs[i]) && f(xs[i]))) ==> |Filter(f, Filter(d, xs))| < |Filter(g, xs)|
    decreases |xs|
  {
    if |xs| == 0 {
      FilterNil(d, xs);
      FilterNil(f, Filter(d, xs));
      FilterNil(g, xs);
    } else {
      var r := Filter(d, xs[1..]);
      FilterCons(d, xs);
      FilterCons(g, xs);
      assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
      FilterOfFilterLength(d, f, g, xs[1..]);
      if d(xs[0]) {
        FilterCons(f, [xs[0]] + r);
        assert ([xs[0]] + r)[1..] == r;
      } else {
        assert Filter(d, xs) == r;
      }
      if exists i :: 0 <= i < |xs| && g(xs[i]) && !(d(xs[i]) && f(xs[i])) {
        var i :| 0 <= i < |xs| && g(xs[i]) && !(d(xs[i]) && f(xs[i]));
        if i > 0 {
          assert xs[1..][i - 1] == xs[i];
        }
      }
    }
  }

  /** Filtering first can only lower a count. */
  lemma FilterOfFilterShorter<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
    ensures |Filter(q, Filter(p, xs))| <= |Filter(q, xs)|
  {
    FilterOfFilterLength(p, q, q, xs);
  }

  // --- DistinctBy -----------------------------------------------------------

  /** Two lists without repeated keys, and no key in both: their concatenation repeats no key. */
  lemma DistinctByConcat<T, K>(a: seq<T>, b: seq<T>, key: T -> K)
    requires DistinctBy(a, key) && DistinctBy(b, key)
    requires forall x, y :: x in a && y in b ==> key(x) != key(y)
    ensures DistinctBy(a + b, key)
  {
    var c := a + b;
    forall i, j | 0 <= i < |c| && 0 <= j < |c| && i != j
      ensures key(c[i]) != key(c[j])
    {
      if i < |a| && j >= |a| {
        assert c[i] == a[i] && c[j] == b[j - |a|];
      } else if i >= |a| && j < |a| {
        assert c[j] == a[j] && c[i] == b[i - |a|];
      } else if i >= |a| && j >= |a| {
        assert c[i] == b[i - |a|] && c[j] == b[j - |a|];
      }
    }
  }

  // --- FoldLeft -------------------------------------------------------------

  /** Appending one element takes one more fold step. */
  lemma FoldLeftAppend<A, T>(f: (A, T) -> A, init: A, xs: seq<T>, last: T)
    ensures Seq.FoldLeft(f, init, xs + [last]) == f(Seq.FoldLeft(f, init, xs), last)
    decreases |xs|
  {
    if |xs| > 0 {
      assert (xs + [last])[1..] == xs[1..] + [last];
      FoldLeftAppend(f, f(init, xs[0]), xs[1..], last);
    }
  }

  /** A fold whose step never lowers the accumulator ends at or above where it started. */
  lemma FoldLeftInflationary<T>(f: (int, T) -> int, init: int, xs: seq<T>)
    requires forall a, x :: f(a, x) >= a
    ensures Seq.FoldLeft(f, init, xs) >= init
    decreases |xs|
  {
    if |xs| > 0 {
      FoldLeftInflationary(f, f(init, xs[0]), xs[1..]);
    }
  }

  /** A fold whose step never lowers the accumulator and never ends below key(x) ends at or above every key. */
  lemma FoldLeftAboveEach<T>(f: (int, T) -> int, key: T -> int, init: int, xs: seq<T>)
    requires forall a, x :: f(a, x) >= a && f(a, x) >= key(x)
    ensures forall i :: 0 <= i < |xs| ==> Seq.FoldLeft(f, init, xs) >= key(xs[i])
    decreases |xs|
  {
    if |xs| > 0 {
      FoldLeftAboveEach(f, key, f(init, xs[0]), xs[1..]);
      FoldLeftInflationary(f, f(init, xs[0]), xs[1..]);
      assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
    }
  }

  /** A running maximum is at least its start and every element. */
  lemma FoldLeftMax(f: (int, int) -> int, init: int, xs: seq<int>)
    requires forall a, x :: f(a, x) == (if x > a then x else a)
    ensures Seq.FoldLeft(f, init, xs) >= init
    ensures forall i :: 0 <= i < |xs| ==> Seq.FoldLeft(f, init, xs) >= xs[i]
  {
    FoldLeftInflationary(f, init, xs);
    FoldLeftAboveEach(f, (x: int) => x, init, xs);
  }

  /** Two folds whose steps agree position by position give the same result. */
  lemma FoldLeftPointwise<A, T, U>(f: (A, T) -> A, g: (A, U) -> A, init: A, xs: seq<T>, ys: seq<U>)
    requires |xs| == |ys|
    requires forall a, i :: 0 <= i < |xs| ==> f(a, xs[i]) == g(a, ys[i])
    ensures Seq.FoldLeft(f, init, xs) == Seq.FoldLeft(g, init, ys)
    decreases |xs|
  {
    if |xs| > 0 {
      assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
      FoldLeftPointwise(f, g, f(init, xs[0]), xs[1..], ys[1..]);
    }
  }

  /** A fold that appends h(x) for each x is empty exactly when the start and every piece are. */
  lemma FoldLeftConcatEmpty<A, T>(f: (seq<A>, T) -> seq<A>, h: T -> seq<A>, init: seq<A>, xs: seq<T>)
    requires forall a, x :: f(a, x) == a + h(x)
    ensures |Seq.FoldLeft(f, init, xs)| == 0 <==> (|init| == 0 && forall i :: 0 <= i < |xs| ==> |h(xs[i])| == 0)
    decreases |xs|
  {
    if |xs| > 0 {
      assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
      FoldLeftConcatEmpty(f, h, f(init, xs[0]), xs[1..]);
    }
  }

  /** A fold that appends h(x) for each x holds what it started with and what the pieces hold. */
  lemma FoldLeftConcatMember<A, T>(f: (seq<A>, T) -> seq<A>, h: T -> seq<A>, init: seq<A>, xs: seq<T>, x: A)
    requires forall a, y :: f(a, y) == a + h(y)
    ensures x in Seq.FoldLeft(f, init, xs) <==> (x in init || exists i :: 0 <= i < |xs| && x in h(xs[i]))
    decreases |xs|
  {
    if |xs| > 0 {
      FoldLeftConcatMember(f, h, f(init, xs[0]), xs[1..], x);
      assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
      if x in Seq.FoldLeft(f, init, xs) && !(x in init) && !(x in h(xs[0])) {
        var i :| 0 <= i < |xs[1..]| && x in h(xs[1..][i]);
        assert x in h(xs[i + 1]);
      }
    }
  }

  /** A fold that appends h(x) for each x repeats no key when no piece does and no two pieces share one. */
  lemma FoldLeftConcatDistinctBy<T, U, K>(f: (seq<T>, U) -> seq<T>, h: U -> seq<T>, key: T -> K, init: seq<T>, xs: seq<U>)
    requires forall a, y :: f(a, y) == a + h(y)
    requires DistinctBy(init, key)
    requires forall i :: 0 <= i < |xs| ==> DistinctBy(h(xs[i]), key)
    requires forall i, x, y :: 0 <= i < |xs| && x in init && y in h(xs[i]) ==> key(x) != key(y)
    requires forall i, j, x, y :: 0 <= i < j < |xs| && x in h(xs[i]) && y in h(xs[j]) ==> key(x) != key(y)
    ensures DistinctBy(Seq.FoldLeft(f, init, xs), key)
    decreases |xs|
  {
    if |xs| > 0 {
      DistinctByConcat(init, h(xs[0]), key);
      assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
      forall i, x, y | 0 <= i < |xs[1..]| && x in f(init, xs[0]) && y in h(xs[1..][i])
        ensures key(x) != key(y)
      {
        assert xs[1..][i] == xs[i + 1];
      }
      FoldLeftConcatDistinctBy(f, h, key, f(init, xs[0]), xs[1..]);
    }
  }

  /** A fold that adds each element only if it is not there yet holds only what it started with and what it read. */
  lemma FoldLeftDedupMember<T>(f: (seq<T>, T) -> seq<T>, acc: seq<T>, xs: seq<T>, x: T)
    requires forall a, y :: f(a, y) == (if y in a then a else a + [y])
    ensures x in Seq.FoldLeft(f, acc, xs) ==> x in acc || x in xs
    decreases |xs|
  {
    if |xs| > 0 {
      FoldLeftDedupMember(f, f(acc, xs[0]), xs[1..], x);
    }
  }

  /** A fold that adds each element only if it is not there yet builds a list without repeats. */
  lemma FoldLeftDedupDistinct<T>(f: (seq<T>, T) -> seq<T>, acc: seq<T>, xs: seq<T>)
    requires forall a, x :: f(a, x) == (if x in a then a else a + [x])
    requires Distinct(acc)
    ensures Distinct(Seq.FoldLeft(f, acc, xs))
    decreases |xs|
  {
    if |xs| > 0 {
      FoldLeftDedupDistinct(f, f(acc, xs[0]), xs[1..]);
    }
  }

  // --- Sets -----------------------------------------------------------------

  /** A subset is no larger. */
  lemma SubsetCard<T>(a: set<T>, b: set<T>)
    requires a <= b
    ensures |a| <= |b|
    decreases |a|
  {
    if a != {} {
      var x :| x in a;
      SubsetCard(a - {x}, b - {x});
    }
  }
}
