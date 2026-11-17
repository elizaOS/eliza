lemma AuditChain(rows: seq<AuditRow>)
  ensures Std.Collections.Seq.FoldLeft((acc: ChainCursor, r: AuditRow) => ChainCursor(((acc.ok && (r.prev == acc.digest)) && (r.seq_ == (acc.seq_ + 1))), digestOf(r), r.seq_), chainStart, rows).ok ==>
    (forall i :: 0 <= i < |rows| ==> rows[i].seq_ == i + 1) &&
    Std.Collections.Seq.FoldLeft((acc: ChainCursor, r: AuditRow) => ChainCursor(((acc.ok && (r.prev == acc.digest)) && (r.seq_ == (acc.seq_ + 1))), digestOf(r), r.seq_), chainStart, rows).seq_ == |rows| &&
    Std.Collections.Seq.FoldLeft((acc: ChainCursor, r: AuditRow) => ChainCursor(((acc.ok && (r.prev == acc.digest)) && (r.seq_ == (acc.seq_ + 1))), digestOf(r), r.seq_), chainStart, rows).digest == headDigest(rows)
  decreases |rows|
{
  if |rows| > 0 {
    var init := rows[..|rows| - 1];
    assert rows == init + [rows[|rows| - 1]];
    ProofLib.FoldLeftAppend((acc: ChainCursor, r: AuditRow) => ChainCursor(((acc.ok && (r.prev == acc.digest)) && (r.seq_ == (acc.seq_ + 1))), digestOf(r), r.seq_), chainStart, init, rows[|rows| - 1]);
    AuditChain(init);
  }
}

lemma AuditKeepAll(n: int, rows: seq<AuditRow>)
  requires forall i :: 0 <= i < |rows| ==> rows[i].seq_ <= n
  ensures ProofLib.Filter((r: AuditRow) => (r.seq_ <= n), rows) == rows
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil((r: AuditRow) => (r.seq_ <= n), rows);
  } else {
    ProofLib.FilterCons((r: AuditRow) => (r.seq_ <= n), rows);
    AuditKeepAll(n, rows[1..]);
  }
}

lemma AuditPrefixAppend(rows: seq<AuditRow>, x: AuditRow, n: int)
  requires x.seq_ > n
  ensures prefix(rows + [x], n) == prefix(rows, n)
{
  ProofLib.FilterAppend((r: AuditRow) => (r.seq_ <= n), rows, x);
}

lemma AuditOneAppenderFilter(s: AuditLog)
  ensures alwaysOneAppenderAtATime(s) == (!((s.appending in s.waiting)) && !((exists w :: w in s.waiting && !(((w > 0) && (|ProofLib.Filter((o: int) => (o == w), s.waiting)| == 1))))))
{
}

lemma requestAppend_ensures(s: AuditLog, writer: int)
  ensures (inv(s) ==> canRequestAppend(s, writer) ==> alwaysRowsChain(requestAppend(s, writer)))
  ensures (inv(s) ==> canRequestAppend(s, writer) ==> alwaysOneAppenderAtATime(requestAppend(s, writer)))
  ensures (inv(s) ==> canRequestAppend(s, writer) ==> alwaysCheckpointsCoverAPrefix(requestAppend(s, writer)))
  ensures (inv(s) ==> canRequestAppend(s, writer) ==> stepAppendAddsOneRowBehindTheHead(s, requestAppend(s, writer)))
{
  if inv(s) && canRequestAppend(s, writer) {
    var after := requestAppend(s, writer);
    AuditOneAppenderFilter(s);
    AuditOneAppenderFilter(after);
    forall w | w in after.waiting
      ensures w > 0 && |ProofLib.Filter((o: int) => (o == w), after.waiting)| == 1
    {
      ProofLib.FilterAppend((o: int) => (o == w), s.waiting, writer);
      if w == writer {
        ProofLib.FilterNone((o: int) => (o == w), s.waiting);
      }
    }
  }
}

lemma takeLock_ensures(s: AuditLog)
  ensures (inv(s) ==> canTakeLock(s) ==> alwaysRowsChain(takeLock(s)))
  ensures (inv(s) ==> canTakeLock(s) ==> alwaysOneAppenderAtATime(takeLock(s)))
  ensures (inv(s) ==> canTakeLock(s) ==> alwaysCheckpointsCoverAPrefix(takeLock(s)))
  ensures (inv(s) ==> canTakeLock(s) ==> stepAppendAddsOneRowBehindTheHead(s, takeLock(s)))
{
  if inv(s) && canTakeLock(s) {
    var after := takeLock(s);
    var a := s.waiting[0];
    AuditOneAppenderFilter(s);
    AuditOneAppenderFilter(after);
    assert after.waiting == s.waiting[1..];
    forall w | w in s.waiting
      ensures |ProofLib.Filter((o: int) => (o == w), s.waiting)| == (if w == a then 1 else 0) + |ProofLib.Filter((o: int) => (o == w), s.waiting[1..])|
    {
      ProofLib.FilterCons((o: int) => (o == w), s.waiting);
    }
    assert a in s.waiting;
    ProofLib.FilterNone((o: int) => (o == a), s.waiting[1..]);
    assert a !in after.waiting;
    forall w | w in after.waiting
      ensures w > 0 && |ProofLib.Filter((o: int) => (o == w), after.waiting)| == 1
    {
      assert w in s.waiting;
    }
  }
}

lemma appendRow_ensures(s: AuditLog, writer: int, content: int)
  ensures (inv(s) ==> canAppendRow(s, writer, content) ==> alwaysRowsChain(appendRow(s, writer, content)))
  ensures (inv(s) ==> canAppendRow(s, writer, content) ==> alwaysOneAppenderAtATime(appendRow(s, writer, content)))
  ensures (inv(s) ==> canAppendRow(s, writer, content) ==> alwaysCheckpointsCoverAPrefix(appendRow(s, writer, content)))
  ensures (inv(s) ==> canAppendRow(s, writer, content) ==> stepAppendAddsOneRowBehindTheHead(s, appendRow(s, writer, content)))
{
  if inv(s) && canAppendRow(s, writer, content) {
    var after := appendRow(s, writer, content);
    var x := AuditRow((|s.rows| + 1), content, headDigest(s.rows));
    assert after.rows == s.rows + [x];
    AuditChain(s.rows);
    ProofLib.FoldLeftAppend((acc: ChainCursor, r: AuditRow) => ChainCursor(((acc.ok && (r.prev == acc.digest)) && (r.seq_ == (acc.seq_ + 1))), digestOf(r), r.seq_), chainStart, s.rows, x);
    forall c | c in after.checkpoints
      ensures prefix(after.rows, c.upTo) == prefix(s.rows, c.upTo)
    {
      AuditPrefixAppend(s.rows, x, c.upTo);
    }
    AuditKeepAll(|s.rows|, s.rows);
    ProofLib.FilterAppend((r: AuditRow) => (r.seq_ <= |s.rows|), s.rows, x);
  }
}

lemma checkpoint_ensures(s: AuditLog)
  ensures (inv(s) ==> alwaysRowsChain(checkpoint(s)))
  ensures (inv(s) ==> alwaysOneAppenderAtATime(checkpoint(s)))
  ensures (inv(s) ==> alwaysCheckpointsCoverAPrefix(checkpoint(s)))
  ensures (inv(s) ==> stepAppendAddsOneRowBehindTheHead(s, checkpoint(s)))
{
  if inv(s) {
    AuditChain(s.rows);
    AuditKeepAll(|s.rows|, s.rows);
  }
}
