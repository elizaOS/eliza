lemma CursorPrefixFold(f: (Prefix, int) -> Prefix, rows: seq<int>, start: Prefix)
  requires forall prior, id :: |f(prior, id).kept| >= |prior.kept|
  requires forall prior, id, value :: value in f(prior, id).kept ==> value in prior.kept || value == id
  ensures |Std.Collections.Seq.FoldLeft(f, start, rows).kept| >= |start.kept|
  ensures forall value :: value in Std.Collections.Seq.FoldLeft(f, start, rows).kept ==> value in start.kept || value in rows
  decreases |rows|
{
  if |rows| > 0 {
    var advanced := f(start, rows[0]);
    CursorPrefixFold(f, rows[1..], advanced);
    assert Std.Collections.Seq.FoldLeft(f, start, rows) == Std.Collections.Seq.FoldLeft(f, advanced, rows[1..]);
    forall value | value in Std.Collections.Seq.FoldLeft(f, start, rows).kept
      ensures value in start.kept || value in rows
    {
      if value in advanced.kept { assert value in start.kept || value == rows[0]; }
    }
  }
}

lemma CursorPrefixRows(rows: seq<int>, limit: int)
  ensures forall value :: value in prefixRows(rows, limit) ==> value in rows
  ensures limit > 0 && |rows| > 0 ==> |prefixRows(rows, limit)| > 0
{
  var f := (prefix: Prefix, id: int) => Prefix(prefix.count + 1, if prefix.count < limit then prefix.kept + [id] else prefix.kept);
  forall prior, id ensures |f(prior, id).kept| >= |prior.kept| {}
  forall prior, id, value | value in f(prior, id).kept ensures value in prior.kept || value == id {}
  CursorPrefixFold(f, rows, Prefix(0, []));
  if limit > 0 && |rows| > 0 {
    var advanced := f(Prefix(0, []), rows[0]);
    assert |advanced.kept| == 1;
    CursorPrefixFold(f, rows[1..], advanced);
    assert prefixRows(rows, limit) == Std.Collections.Seq.FoldLeft(f, advanced, rows[1..]).kept;
  }
}

lemma CursorPageFacts(query: Cursor, s: Scan, rows: seq<int>, epoch: int, sequence: int, blocked: int, limit: int)
  ensures alwaysReturnedRowsWithinFence(pageResult(query, s, rows, epoch, sequence, blocked, limit))
  ensures alwaysIncompleteAdvances(pageResult(query, s, rows, epoch, sequence, blocked, limit))
  ensures alwaysCompleteConsumesFence(pageResult(query, s, rows, epoch, sequence, blocked, limit))
  ensures alwaysRejectedPagesAreEmpty(pageResult(query, s, rows, epoch, sequence, blocked, limit))
  ensures stepFailedReadPreservesCursor(s, pageResult(query, s, rows, epoch, sequence, blocked, limit))
{
  var eligible := ProofLib.Filter((id: int) => id > query.after && id <= query.through, rows);
  var returned := prefixRows(eligible, limit);
  CursorPrefixRows(eligible, limit);
  forall value | value in returned ensures query.after < value <= query.through {
    assert value in eligible;
    ProofLib.FilterMember((id: int) => id > query.after && id <= query.through, rows, value);
  }
  var after := pageResult(query, s, rows, epoch, sequence, blocked, limit);
  if after.status.Ok? && !after.complete {
    assert limit > 0;
    assert |eligible| > limit;
    assert |returned| > 0;
    assert returned[|returned|-1] in returned;
  }
}

lemma begin_ensures(s: Scan, rows: seq<int>, epoch: int, sequence: int, blocked: int, limit: int)
  ensures (inv(s) ==> alwaysReturnedRowsWithinFence(begin(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysIncompleteAdvances(begin(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysCompleteConsumesFence(begin(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysRejectedPagesAreEmpty(begin(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> stepFailedReadPreservesCursor(s, begin(s, rows, epoch, sequence, blocked, limit)))
{
  CursorPageFacts(Cursor(epoch, 0, sequence), s, rows, epoch, sequence, blocked, limit);
}

lemma continuePage_ensures(s: Scan, rows: seq<int>, epoch: int, sequence: int, blocked: int, limit: int)
  ensures (inv(s) ==> alwaysReturnedRowsWithinFence(continuePage(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysIncompleteAdvances(continuePage(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysCompleteConsumesFence(continuePage(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysRejectedPagesAreEmpty(continuePage(s, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> stepFailedReadPreservesCursor(s, continuePage(s, rows, epoch, sequence, blocked, limit)))
{
  CursorPageFacts(s.cursor, s, rows, epoch, sequence, blocked, limit);
}

lemma readCursor_ensures(s: Scan, query: Cursor, rows: seq<int>, epoch: int, sequence: int, blocked: int, limit: int)
  ensures (inv(s) ==> alwaysReturnedRowsWithinFence(readCursor(s, query, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysIncompleteAdvances(readCursor(s, query, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysCompleteConsumesFence(readCursor(s, query, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> alwaysRejectedPagesAreEmpty(readCursor(s, query, rows, epoch, sequence, blocked, limit)))
  ensures (inv(s) ==> stepFailedReadPreservesCursor(s, readCursor(s, query, rows, epoch, sequence, blocked, limit)))
{
  CursorPageFacts(query, s, rows, epoch, sequence, blocked, limit);
}
