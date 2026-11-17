lemma KeptRowsCameFrom(f: (seq<Row>, Row) -> seq<Row>, acc: seq<Row>, xs: seq<Row>)
  requires forall k: seq<Row>, r: Row, x: Row :: x in f(k, r) ==> x in k || x == r
  ensures forall x :: x in Std.Collections.Seq.FoldLeft(f, acc, xs) ==> x in acc || x in xs
  decreases |xs|
{
  if |xs| == 0 {
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == acc;
  } else {
    KeptRowsCameFrom(f, f(acc, xs[0]), xs[1..]);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, f(acc, xs[0]), xs[1..]);
  }
}

lemma KeptRowsStayWithin(f: (seq<Row>, Row) -> seq<Row>, acc: seq<Row>, xs: seq<Row>, bound: int)
  requires forall k: seq<Row>, r: Row :: |k| <= bound ==> |f(k, r)| <= bound
  requires |acc| <= bound
  ensures |Std.Collections.Seq.FoldLeft(f, acc, xs)| <= bound
  decreases |xs|
{
  if |xs| == 0 {
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == acc;
  } else {
    KeptRowsStayWithin(f, f(acc, xs[0]), xs[1..], bound);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, f(acc, xs[0]), xs[1..]);
  }
}

lemma KeepNewestKeepsOnlyGiven(pageSize: PageSize, k: seq<Row>, r: Row, x: Row)
  ensures x in keepNewest(pageSize, k, r) ==> x in k || x == r
{
  if |k| > 0 {
    assert k == k[..0] + k[1..];
    assert forall y :: y in k[..0] + k[1..] ==> y in k;
  }
}

lemma lawListedNoticesMatchTheFilter_ensures(notices: seq<Row>, category: string, unreadOnly: bool, pageSize: PageSize, now: int)
  ensures (lawListedNoticesMatchTheFilter(notices, category, unreadOnly, pageSize, now) == true)
{
  var p := (row: Row) => matchesList(category, unreadOnly, row, now);
  var f := (kept: seq<Row>, row: Row) => keepNewest(pageSize, kept, row);
  forall k: seq<Row>, r: Row, x: Row | x in f(k, r) ensures x in k || x == r {
    KeepNewestKeepsOnlyGiven(pageSize, k, r, x);
  }
  var m := ProofLib.Filter(p, notices);
  KeptRowsCameFrom(f, [], m);
  assert ownerRows(notices, category, unreadOnly, pageSize, now) == Std.Collections.Seq.FoldLeft(f, [], m);
  forall x | x in ownerRows(notices, category, unreadOnly, pageSize, now)
    ensures matchesList(category, unreadOnly, x, now)
  {
    ProofLib.FilterMember(p, notices, x);
  }
}

lemma lawListNeverExceedsItsLimit_ensures(notices: seq<Row>, category: string, unreadOnly: bool, rows: int, now: int)
  ensures (lawListNeverExceedsItsLimit(notices, category, unreadOnly, rows, now) == true)
{
  if rows >= 1 {
    var p := (row: Row) => matchesList(category, unreadOnly, row, now);
    var f := (kept: seq<Row>, row: Row) => keepNewest(AtMost(rows), kept, row);
    forall k: seq<Row>, r: Row | |k| <= rows ensures |f(k, r)| <= rows {
      if |k| >= rows {
        assert |k| > 0;
        assert |k[..0] + k[1..]| == |k| - 1;
      }
    }
    var m := ProofLib.Filter(p, notices);
    KeptRowsStayWithin(f, [], m, rows);
    assert ownerRows(notices, category, unreadOnly, AtMost(rows), now) == Std.Collections.Seq.FoldLeft(f, [], m);
  }
}

lemma lawFirstNativePageBeginsCoreScan_ensures(asked: ListParams, epoch: int, sequence: int)
  ensures (lawFirstNativePageBeginsCoreScan(asked, epoch, sequence) == true)
{
  var r := listRequest(asked, epoch, sequence);
  if r.NativePage? && |asked.nativeEpoch| == 0 {
    assert wellFormed(asked);
    assert |asked.throughSequence| == 0;
    assert decimalOr(asked.throughSequence, sequence) == sequence;
    assert epochOr(asked.nativeEpoch, epoch) == epoch;
    if |asked.afterSequence| > 0 {
      assert asked.afterSequence[0] in asked.afterSequence;
      assert decimalValid(asked.afterSequence[0]);
    }
    assert decimalOr(asked.afterSequence, 0) == 0;
    var q := core__notifications__cursor_begin(core__notifications__cursor_initial, [], epoch, sequence, 0, r.limit).pageQuery;
    assert q.epoch == epoch && q.after == 0 && q.through == sequence;
    assert r.query.epoch == epoch && r.query.after == 0 && r.query.through == sequence;
  }
}
