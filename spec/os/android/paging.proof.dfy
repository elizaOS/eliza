lemma TakeFoldExact(f: (PagePrefix, RowKey) -> PagePrefix, xs: seq<RowKey>, init: PagePrefix, limit: int)
  requires forall p, k :: f(p, k) == (if p.count < limit then PagePrefix(p.count + 1, p.kept + [k]) else p)
  requires init.count == |init.kept|
  ensures var res := Std.Collections.Seq.FoldLeft(f, init, xs);
    if limit <= init.count then res == init
    else if init.count + |xs| <= limit then res == PagePrefix(init.count + |xs|, init.kept + xs)
    else res == PagePrefix(limit, init.kept + xs[..(limit - init.count)])
  decreases |xs|
{
  if |xs| == 0 {
    assert init.kept + xs == init.kept;
  } else {
    var next := f(init, xs[0]);
    TakeFoldExact(f, xs[1..], next, limit);
    if limit > init.count {
      if init.count + |xs| <= limit {
        assert (init.kept + [xs[0]]) + xs[1..] == init.kept + xs;
      } else {
        var k := limit - init.count;
        assert (init.kept + [xs[0]]) + xs[1..][..(k - 1)] == init.kept + xs[..k];
      }
    }
  }
}

lemma TakePageExact(rows: seq<RowKey>, start: PageStart, limit: int)
  ensures var e := ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows);
    var t := takePage(rows, start, limit);
    if limit <= 0 then t == []
    else if |e| <= limit then t == e
    else t == e[..limit]
{
  var e := ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows);
  var f := (prefix: PagePrefix, key: RowKey) => (if (prefix.count < limit) then PagePrefix((prefix.count + 1), (prefix.kept + [key])) else prefix);
  TakeFoldExact(f, e, PagePrefix(0, []), limit);
  assert [] + e == e;
  if limit > 0 && |e| > limit {
    assert [] + e[..limit] == e[..limit];
  }
}

lemma OrderScanOrdered(f: (OrderScan, RowKey) -> OrderScan, rows: seq<RowKey>, init: OrderScan)
  requires forall scan, key :: f(scan, key) == OrderScan((scan.ordered && (!(scan.seen) || precedes(scan.previous, key))), true, key)
  ensures Std.Collections.Seq.FoldLeft(f, init, rows).ordered ==>
      init.ordered
      && (forall i :: 0 <= i < |rows| && init.seen ==> precedes(init.previous, rows[i]))
      && (forall i, j :: 0 <= i < j < |rows| ==> precedes(rows[i], rows[j]))
  decreases |rows|
{
  if |rows| > 0 {
    var next := f(init, rows[0]);
    OrderScanOrdered(f, rows[1..], next);
    if Std.Collections.Seq.FoldLeft(f, init, rows).ordered {
      assert next.ordered;
      forall i | 0 <= i < |rows| && init.seen
        ensures precedes(init.previous, rows[i])
      {
        if i > 0 {
          assert rows[1..][i - 1] == rows[i];
          assert precedes(rows[0], rows[i]);
        }
      }
      forall i, j | 0 <= i < j < |rows|
        ensures precedes(rows[i], rows[j])
      {
        if i == 0 {
          assert rows[1..][j - 1] == rows[j];
        } else {
          assert rows[1..][i - 1] == rows[i] && rows[1..][j - 1] == rows[j];
        }
      }
    }
  }
}

lemma FilterOrderedSuffix(rows: seq<RowKey>, start: PageStart, k: int)
  requires forall i, j :: 0 <= i < j < |rows| ==> precedes(rows[i], rows[j])
  requires 0 <= k < |ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows)|
  ensures var e := ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows);
    ProofLib.Filter((key: RowKey) => isAfterStart(AfterRow(e[k]), key), rows) == e[(k + 1)..]
  decreases |rows|
{
  var p := (key: RowKey) => isAfterStart(start, key);
  var e := ProofLib.Filter(p, rows);
  var q := (key: RowKey) => isAfterStart(AfterRow(e[k]), key);
  ProofLib.FilterCons(p, rows);
  ProofLib.FilterCons(q, rows);
  var rest := rows[1..];
  assert forall i, j :: 0 <= i < j < |rest| ==> precedes(rest[i], rest[j]) by {
    forall i, j | 0 <= i < j < |rest| ensures precedes(rest[i], rest[j]) {
      assert rest[i] == rows[i + 1] && rest[j] == rows[j + 1];
    }
  }
  if p(rows[0]) {
    if k == 0 {
      assert e[0] == rows[0];
      assert !q(rows[0]);
      forall i | 0 <= i < |rest|
        ensures p(rest[i]) == q(rest[i])
      {
        assert rest[i] == rows[i + 1];
        assert precedes(rows[0], rest[i]);
      }
      ProofLib.FilterSamePredicate(q, p, rest);
      assert e[1..] == ProofLib.Filter(p, rest);
    } else {
      assert e[k] == ProofLib.Filter(p, rest)[k - 1];
      ProofLib.FilterMember(p, rest, e[k]);
      var idx :| 0 <= idx < |rest| && rest[idx] == e[k];
      assert rows[idx + 1] == e[k];
      assert precedes(rows[0], e[k]);
      assert !q(rows[0]);
      FilterOrderedSuffix(rest, start, k - 1);
      assert e[(k + 1)..] == ProofLib.Filter(p, rest)[k..];
    }
  } else {
    assert e == ProofLib.Filter(p, rest);
    ProofLib.FilterMember(p, rest, e[k]);
    var idx :| 0 <= idx < |rest| && rest[idx] == e[k];
    assert rows[idx + 1] == e[k];
    assert precedes(rows[0], e[k]);
    assert !q(rows[0]);
    FilterOrderedSuffix(rest, start, k);
  }
}

lemma lawPageStaysAfterItsStartWithinItsLimit_ensures(rows: seq<RowKey>, start: PageStart, limit: int)
  ensures (lawPageStaysAfterItsStartWithinItsLimit(rows, start, limit) == true)
{
  var p := (key: RowKey) => isAfterStart(start, key);
  var e := ProofLib.Filter(p, rows);
  TakePageExact(rows, start, limit);
  var t := takePage(rows, start, limit);
  forall key | key in t
    ensures isAfterStart(start, key)
  {
    assert key in e;
    ProofLib.FilterMember(p, rows, key);
  }
}

lemma lawCursorExactlyWhenRowsRemain_ensures(query: string, rows: seq<RowKey>, start: PageStart, limit: int)
  ensures (lawCursorExactlyWhenRowsRemain(query, rows, start, limit) == true)
{
  if inPageOrder(rows) && limit >= 1 {
    var ofn := (scan: OrderScan, key: RowKey) => OrderScan((scan.ordered && (!(scan.seen) || precedes(scan.previous, key))), true, key);
    OrderScanOrdered(ofn, rows, OrderScan(true, false, noRow));
    var e := ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows);
    TakePageExact(rows, start, limit);
    if |e| > limit {
      var last := e[limit - 1];
      FilterOrderedSuffix(rows, start, limit - 1);
      TakePageExact(rows, AfterRow(last), limit);
      assert |e[limit..]| >= 1;
    }
  }
}

lemma lawConsecutivePagesNeitherRepeatNorSkip_ensures(query: string, rows: seq<RowKey>, start: PageStart, limit: int)
  ensures (lawConsecutivePagesNeitherRepeatNorSkip(query, rows, start, limit) == true)
{
  if inPageOrder(rows) && limit >= 1 {
    var ofn := (scan: OrderScan, key: RowKey) => OrderScan((scan.ordered && (!(scan.seen) || precedes(scan.previous, key))), true, key);
    OrderScanOrdered(ofn, rows, OrderScan(true, false, noRow));
    var e := ProofLib.Filter((key: RowKey) => isAfterStart(start, key), rows);
    TakePageExact(rows, start, limit);
    TakePageExact(rows, start, limit * 2);
    if |e| > limit {
      var last := e[limit - 1];
      FilterOrderedSuffix(rows, start, limit - 1);
      TakePageExact(rows, AfterRow(last), limit);
      var rest := e[limit..];
      if |rest| <= limit {
        assert e[..limit] + rest == e;
      } else {
        assert e[..limit] + rest[..limit] == e[..(limit * 2)];
      }
      var nextPage := takePage(rows, AfterRow(last), limit);
      if last in nextPage {
        assert last in ProofLib.Filter((key: RowKey) => isAfterStart(AfterRow(last), key), rows);
        ProofLib.FilterMember((key: RowKey) => isAfterStart(AfterRow(last), key), rows, last);
        assert false;
      }
    }
  }
}
