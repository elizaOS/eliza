lemma attachSink_ensures(a: Audit, sink: int)
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysNothingRecordedBeforeConfiguration(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysOutboxOnlyWithoutDurableSink(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysQueueOnlyWithAllowedSink(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysQueueInRecordOrder(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysDeliveryWalksAttachedSinks(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysOneDeliveryAtATime(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysSinkRowsFollowRecordOrder(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysRecordsNumberedInOrder(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysRowsPrecedeWaitingRecords(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> alwaysAcknowledgedMetRequirements(attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> stepConfigurationFixed(a, attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> stepCrashKeepsCommittedRows(a, "attachSink", attachSink(a, sink)))
  ensures (inv(a) ==> canAttachSink(a, sink) ==> stepSettledRecordsStaySettled(a, attachSink(a, sink)))
{
  if inv(a) && canAttachSink(a, sink) {
    AttachShape(a, sink);
    AttachOutbox(a, sink);
    AttachQueue(a, sink);
    AttachDelivering(a, sink);
    AttachRows(a, sink);
    DistinctAppend(a.attached, sink);
  }
}

lemma recordEntry_ensures(a: Audit)
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysNothingRecordedBeforeConfiguration(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysOutboxOnlyWithoutDurableSink(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysQueueOnlyWithAllowedSink(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysQueueInRecordOrder(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysDeliveryWalksAttachedSinks(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysOneDeliveryAtATime(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysSinkRowsFollowRecordOrder(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysRecordsNumberedInOrder(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysRowsPrecedeWaitingRecords(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> alwaysAcknowledgedMetRequirements(recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> stepConfigurationFixed(a, recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> stepCrashKeepsCommittedRows(a, "recordEntry", recordEntry(a)))
  ensures (inv(a) ==> canRecordEntry(a) ==> stepSettledRecordsStaySettled(a, recordEntry(a)))
{
  if inv(a) && canRecordEntry(a) {
    RecordQueue(a);
    RecordDelivering(a);
  }
}

lemma beginDelivery_ensures(a: Audit)
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysNothingRecordedBeforeConfiguration(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysOutboxOnlyWithoutDurableSink(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysQueueOnlyWithAllowedSink(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysQueueInRecordOrder(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysDeliveryWalksAttachedSinks(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysOneDeliveryAtATime(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysSinkRowsFollowRecordOrder(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysRecordsNumberedInOrder(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysRowsPrecedeWaitingRecords(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> alwaysAcknowledgedMetRequirements(beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> stepConfigurationFixed(a, beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> stepCrashKeepsCommittedRows(a, "beginDelivery", beginDelivery(a)))
  ensures (inv(a) ==> canBeginDelivery(a) ==> stepSettledRecordsStaySettled(a, beginDelivery(a)))
{
  if inv(a) && canBeginDelivery(a) {
    Facts(a);
    var b := beginDelivery(a);
    var q0 := a.queue[0];
    ProofLib.FilterCons((q: int) => (q != q0), a.queue);
    FilterKeepsAll((q: int) => (q != q0), a.queue[1..]);
    assert b.queue == a.queue[1..];
    Asc(a.queue);
    Asc(b.queue);
    EntriesOrdered(a.entries);
    EntriesOrdered(b.entries);
    assert a.queue[0] in a.queue;
    var e0 :| e0 in a.entries && e0.id == q0 && e0.stage.Queued?;
    var k :| 0 <= k < |a.entries| && a.entries[k] == e0;
    forall i | 0 <= i < |a.entries| && i != k ensures a.entries[i].id != q0 && b.entries[i] == a.entries[i] { }
    ProofLib.FilterOne((e: AuditEntry) => e.stage.Delivering?, b.entries, k);
    forall q | q in b.queue ensures exists e :: e in b.entries && e.id == q && e.stage.Queued? {
      assert q in a.queue;
      var e :| e in a.entries && e.id == q && e.stage.Queued?;
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] in b.entries;
    }
    forall e | e in a.entries && (e.stage.Acknowledged? || e.stage.Refused?) ensures e in b.entries {
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] == e;
    }
  }
}

lemma appendToSink_ensures(a: Audit, result: AppendResult)
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysNothingRecordedBeforeConfiguration(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysOutboxOnlyWithoutDurableSink(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysQueueOnlyWithAllowedSink(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysQueueInRecordOrder(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysDeliveryWalksAttachedSinks(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysOneDeliveryAtATime(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysSinkRowsFollowRecordOrder(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysRecordsNumberedInOrder(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysRowsPrecedeWaitingRecords(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> alwaysAcknowledgedMetRequirements(appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> stepConfigurationFixed(a, appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> stepCrashKeepsCommittedRows(a, "appendToSink", appendToSink(a, result)))
  ensures (inv(a) ==> canAppendToSink(a, result) ==> stepSettledRecordsStaySettled(a, appendToSink(a, result)))
{
  if inv(a) && canAppendToSink(a, result) {
    Facts(a);
    var b := appendToSink(a, result);
    var k := a.sinkOrder[a.sinkIndex];
    var d := a.inDelivery;
    var di :| 0 <= di < |a.entries| && a.entries[di].id == d && a.entries[di].stage.Delivering?;
    assert 0 < d < a.nextEntry;
    assert a.sinkOrder[a.sinkIndex] in a.sinkOrder;
    forall i | 0 <= i < a.sinkIndex ensures a.sinkOrder[i] != k {
      if a.sinkOrder[i] == k {
        ProofLib.FilterTwo((j: int) => (j == k), a.sinkOrder, i, a.sinkIndex);
      }
    }
    assert k !in appendedSinks(a);
    assert a.sinkOrder[..a.sinkIndex + 1] == a.sinkOrder[..a.sinkIndex] + [k];
    SinksWalked(b);
    assert appendedSinks(b) == appendedSinks(a) + [k];
    if k in a.durable && !result.FailedBefore? {
      var row := AuditRow(k, d);
      assert b.rows == a.rows + [row];
      assert durableAttached(a);
      RowsAppend(a.rows, row, 1);
      RowsAppend(a.rows, row, 2);
      forall r | r in a.rows && r.sink == k ensures r.entry < d { }
    }
  }
}

lemma finishDelivery_ensures(a: Audit)
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysNothingRecordedBeforeConfiguration(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysOutboxOnlyWithoutDurableSink(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysQueueOnlyWithAllowedSink(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysQueueInRecordOrder(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysDeliveryWalksAttachedSinks(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysOneDeliveryAtATime(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysSinkRowsFollowRecordOrder(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysRecordsNumberedInOrder(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysRowsPrecedeWaitingRecords(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> alwaysAcknowledgedMetRequirements(finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> stepConfigurationFixed(a, finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> stepCrashKeepsCommittedRows(a, "finishDelivery", finishDelivery(a)))
  ensures (inv(a) ==> canFinishDelivery(a) ==> stepSettledRecordsStaySettled(a, finishDelivery(a)))
{
  if inv(a) && canFinishDelivery(a) {
    Facts(a);
    var b := finishDelivery(a);
    var di :| 0 <= di < |a.entries| && a.entries[di].id == a.inDelivery && a.entries[di].stage.Delivering?;
    EntriesOrdered(a.entries);
    EntriesOrdered(b.entries);
    forall i | 0 <= i < |a.entries| && i != di ensures a.entries[i].id != a.inDelivery && b.entries[i] == a.entries[i] { }
    ProofLib.FilterNone((e: AuditEntry) => e.stage.Delivering?, b.entries);
    forall q | q in b.queue ensures exists e :: e in b.entries && e.id == q && e.stage.Queued? {
      var e :| e in a.entries && e.id == q && e.stage.Queued?;
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] in b.entries;
    }
    forall e | e in a.entries && (e.stage.Acknowledged? || e.stage.Refused?) ensures e in b.entries {
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] == e;
    }
  }
}

lemma crash_ensures(a: Audit)
  ensures (inv(a) ==> canCrash(a) ==> alwaysNothingRecordedBeforeConfiguration(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysOutboxOnlyWithoutDurableSink(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysQueueOnlyWithAllowedSink(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysQueueInRecordOrder(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysDeliveryWalksAttachedSinks(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysOneDeliveryAtATime(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysSinkRowsFollowRecordOrder(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysRecordsNumberedInOrder(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysRowsPrecedeWaitingRecords(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> alwaysAcknowledgedMetRequirements(crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> stepConfigurationFixed(a, crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> stepCrashKeepsCommittedRows(a, "crash", crash(a)))
  ensures (inv(a) ==> canCrash(a) ==> stepSettledRecordsStaySettled(a, crash(a)))
{
  if inv(a) && canCrash(a) {
    var b := crash(a);
    EntriesOrdered(a.entries);
    EntriesOrdered(b.entries);
    ProofLib.FilterNone((e: AuditEntry) => e.stage.Delivering?, b.entries);
    forall e | e in a.entries && (e.stage.Acknowledged? || e.stage.Refused?) ensures e in b.entries {
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] == e;
    }
  }
}

lemma Facts(a: Audit)
  requires inv(a)
  ensures forall i :: 0 <= i < |a.entries| ==> 0 < a.entries[i].id < a.nextEntry
  ensures forall i, j :: 0 <= i < j < |a.entries| ==> a.entries[i].id < a.entries[j].id
  ensures forall i :: 0 <= i < |a.queue| ==> a.queue[i] > 0
  ensures forall i, j :: 0 <= i < j < |a.queue| ==> a.queue[i] < a.queue[j]
  ensures a.inDelivery != 0 ==> exists i :: 0 <= i < |a.entries| && a.entries[i].id == a.inDelivery && a.entries[i].stage.Delivering?
  ensures a.inDelivery == 0 ==> forall i :: 0 <= i < |a.entries| ==> !a.entries[i].stage.Delivering?
  ensures appendedSinks(a) == a.sinkOrder[..a.sinkIndex]
{
  EntriesOrdered(a.entries);
  Asc(a.queue);
  forall i | 0 <= i < |a.entries| ensures a.entries[i].id < a.nextEntry {
    assert a.entries[i] in a.entries;
  }
  ProofLib.FilterNone((e: AuditEntry) => e.stage.Delivering?, a.entries);
  if a.inDelivery != 0 {
    var i :| 0 <= i < |a.entries| && a.entries[i].stage.Delivering?;
    assert a.entries[i] in a.entries;
  }
  SinksWalked(a);
}

lemma SinksWalked(a: Audit)
  requires 0 <= a.sinkIndex <= |a.sinkOrder|
  ensures appendedSinks(a) == a.sinkOrder[..a.sinkIndex]
{
  DoneFold((acc: SinkProgress, k: int) => (if (acc.count < a.sinkIndex) then SinkProgress((acc.count + 1), (acc.done + [k])) else acc), a.sinkIndex, 0, [], a.sinkOrder);
  assert [] + a.sinkOrder[..a.sinkIndex] == a.sinkOrder[..a.sinkIndex];
}

lemma EntriesOrdered(es: seq<AuditEntry>)
  ensures ascending((var s_map := es; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var e := s_map[i_map]; e.id))) <==> (forall i :: 0 <= i < |es| ==> es[i].id > 0) && (forall i, j :: 0 <= i < j < |es| ==> es[i].id < es[j].id)
{
  var ids := (var s_map := es; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var e := s_map[i_map]; e.id));
  assert forall i :: 0 <= i < |es| ==> ids[i] == es[i].id;
  Asc(ids);
}

lemma Asc(xs: seq<int>)
  ensures ascending(xs) <==> (forall i :: 0 <= i < |xs| ==> xs[i] > 0) && (forall i, j :: 0 <= i < j < |xs| ==> xs[i] < xs[j])
{
  AscStep((acc: RowOrder, x: int) => RowOrder(x, (acc.ordered && (x > acc.prior))), 0, true, xs);
}

lemma AscStep(f: (RowOrder, int) -> RowOrder, p: int, o: bool, xs: seq<int>)
  requires forall acc: RowOrder, x: int :: f(acc, x) == RowOrder(x, acc.ordered && x > acc.prior)
  ensures Std.Collections.Seq.FoldLeft(f, RowOrder(p, o), xs).ordered <==> o && (forall i :: 0 <= i < |xs| ==> xs[i] > p) && (forall i, j :: 0 <= i < j < |xs| ==> xs[i] < xs[j])
  decreases |xs|
{
  if |xs| > 0 {
    AscStep(f, xs[0], o && xs[0] > p, xs[1..]);
    assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma FilterOrderedIds(p: AuditEntry -> bool, es: seq<AuditEntry>)
  requires forall i :: 0 <= i < |es| ==> es[i].id > 0
  requires forall i, j :: 0 <= i < j < |es| ==> es[i].id < es[j].id
  ensures forall i :: 0 <= i < |ProofLib.Filter(p, es)| ==> ProofLib.Filter(p, es)[i].id > 0
  ensures forall i, j :: 0 <= i < j < |ProofLib.Filter(p, es)| ==> ProofLib.Filter(p, es)[i].id < ProofLib.Filter(p, es)[j].id
  decreases |es|
{
  if |es| == 0 {
    ProofLib.FilterNil(p, es);
  } else {
    ProofLib.FilterCons(p, es);
    assert forall i :: 0 <= i < |es[1..]| ==> es[1..][i] == es[i + 1];
    FilterOrderedIds(p, es[1..]);
    var rest := ProofLib.Filter(p, es[1..]);
    forall m | 0 <= m < |rest| ensures rest[m].id > es[0].id {
      ProofLib.FilterMember(p, es[1..], rest[m]);
      var n :| 0 <= n < |es[1..]| && es[1..][n] == rest[m];
    }
  }
}

lemma FilterKeepsAll(p: int -> bool, xs: seq<int>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FilterKeepsAll(p, xs[1..]);
  }
}

lemma DistinctAppend(ks: seq<int>, k: int)
  requires distinctSinks(ks) && k !in ks
  ensures distinctSinks(ks + [k])
{
  forall x | x in ks + [k] ensures |ProofLib.Filter((j: int) => (j == x), ks + [k])| == 1 {
    ProofLib.FilterAppend((j: int) => (j == x), ks, k);
    if x == k {
      ProofLib.FilterNone((j: int) => (j == x), ks);
    }
  }
}

lemma RowsAppend(rows: seq<AuditRow>, row: AuditRow, s: int)
  requires rowsInRecordOrder(rows, s)
  requires row.sink == s ==> (forall r :: r in rows && r.sink == s ==> r.entry < row.entry) && row.entry > 0
  ensures rowsInRecordOrder(rows + [row], s)
{
  var f := (acc: RowOrder, r: AuditRow) => (if (r.sink == s) then RowOrder(r.entry, (acc.ordered && (r.entry > acc.prior))) else acc);
  ProofLib.FoldLeftAppend(f, RowOrder(0, true), rows, row);
  RowPrior(f, s, RowOrder(0, true), rows);
}

lemma RowPrior(f: (RowOrder, AuditRow) -> RowOrder, s: int, init: RowOrder, rows: seq<AuditRow>)
  requires forall acc: RowOrder, r: AuditRow :: f(acc, r) == (if r.sink == s then RowOrder(r.entry, acc.ordered && r.entry > acc.prior) else acc)
  ensures Std.Collections.Seq.FoldLeft(f, init, rows).prior == init.prior || exists r :: r in rows && r.sink == s && r.entry == Std.Collections.Seq.FoldLeft(f, init, rows).prior
  decreases |rows|
{
  if |rows| > 0 {
    RowPrior(f, s, f(init, rows[0]), rows[1..]);
  }
}

lemma DoneStays(f: (SinkProgress, int) -> SinkProgress, n: int, acc: SinkProgress, xs: seq<int>)
  requires forall acc: SinkProgress, k: int :: f(acc, k) == (if acc.count < n then SinkProgress(acc.count + 1, acc.done + [k]) else acc)
  requires acc.count >= n
  ensures Std.Collections.Seq.FoldLeft(f, acc, xs) == acc
  decreases |xs|
{
  if |xs| > 0 {
    DoneStays(f, n, acc, xs[1..]);
  }
}

lemma DoneFold(f: (SinkProgress, int) -> SinkProgress, n: int, c: int, d: seq<int>, xs: seq<int>)
  requires forall acc: SinkProgress, k: int :: f(acc, k) == (if acc.count < n then SinkProgress(acc.count + 1, acc.done + [k]) else acc)
  requires c <= n <= c + |xs|
  ensures Std.Collections.Seq.FoldLeft(f, SinkProgress(c, d), xs).done == d + xs[..n - c]
  decreases |xs|
{
  if c == n {
    DoneStays(f, n, SinkProgress(c, d), xs);
  } else {
    var next := SinkProgress(c + 1, d + [xs[0]]);
    assert f(SinkProgress(c, d), xs[0]) == next;
    assert Std.Collections.Seq.FoldLeft(f, SinkProgress(c, d), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    DoneFold(f, n, c + 1, d + [xs[0]], xs[1..]);
    assert (d + [xs[0]]) + xs[1..][..n - c - 1] == d + xs[..n - c];
  }
}

lemma AttachShape(a: Audit, sink: int)
  requires inv(a) && canAttachSink(a, sink)
  ensures |attachSink(a, sink).entries| == |a.entries|
  ensures attachSink(a, sink).queue == a.queue + attachSink(a, sink).queue[|a.queue|..]
  ensures forall q :: q in attachSink(a, sink).queue[|a.queue|..] ==> exists i :: 0 <= i < |a.entries| && a.entries[i].id == q && a.entries[i].stage.InOutbox?
  ensures forall i :: 0 <= i < |a.entries| && a.entries[i].stage.InOutbox? && sink in a.durable ==> a.entries[i].id in attachSink(a, sink).queue[|a.queue|..]
  ensures forall i :: 0 <= i < |a.entries| ==> attachSink(a, sink).entries[i] == (if a.entries[i].id in attachSink(a, sink).queue[|a.queue|..] then a.entries[i].(stage := EntryStage.Queued) else a.entries[i])
  ensures forall i :: 0 <= i < |a.entries| && !a.entries[i].stage.InOutbox? ==> attachSink(a, sink).entries[i] == a.entries[i]
  ensures sink !in a.durable ==> attachSink(a, sink).queue[|a.queue|..] == []
{
  Facts(a);
  var b := attachSink(a, sink);
  var f := ProofLib.Filter((e: AuditEntry) => e.stage.InOutbox?, a.entries);
  var released := if sink in a.durable then (var s_map := f; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var e := s_map[i_map]; e.id)) else [];
  assert b.queue == a.queue + released;
  assert b.queue[|a.queue|..] == released;
  forall q | q in released ensures exists i :: 0 <= i < |a.entries| && a.entries[i].id == q && a.entries[i].stage.InOutbox? {
    var m :| 0 <= m < |f| && f[m].id == q;
    ProofLib.FilterMember((e: AuditEntry) => e.stage.InOutbox?, a.entries, f[m]);
  }
  forall i | 0 <= i < |a.entries| && a.entries[i].stage.InOutbox? && sink in a.durable ensures a.entries[i].id in released {
    ProofLib.FilterMember((e: AuditEntry) => e.stage.InOutbox?, a.entries, a.entries[i]);
    var m :| 0 <= m < |f| && f[m] == a.entries[i];
    assert released[m] == a.entries[i].id;
  }
  forall i | 0 <= i < |a.entries| && !a.entries[i].stage.InOutbox? ensures b.entries[i] == a.entries[i] {
    if a.entries[i].id in released {
      var j :| 0 <= j < |a.entries| && a.entries[j].id == a.entries[i].id && a.entries[j].stage.InOutbox?;
      assert i != j;
    }
  }
}

lemma AttachOutbox(a: Audit, sink: int)
  requires inv(a) && canAttachSink(a, sink)
  ensures alwaysOutboxOnlyWithoutDurableSink(attachSink(a, sink))
  ensures alwaysQueueOnlyWithAllowedSink(attachSink(a, sink))
{
  AttachShape(a, sink);
  var b := attachSink(a, sink);
  if sink !in a.durable {
    assert durableAttached(b) == durableAttached(a);
    assert b.queue == a.queue;
  } else {
    assert sink in b.attached;
  }
  forall e | e in b.entries && e.stage.InOutbox? ensures a.requiresDurable && !durableAttached(b) {
    var i :| 0 <= i < |b.entries| && b.entries[i] == e;
    assert a.entries[i] in a.entries;
  }
}

lemma AttachQueue(a: Audit, sink: int)
  requires inv(a) && canAttachSink(a, sink)
  ensures alwaysQueueInRecordOrder(attachSink(a, sink))
{
  Facts(a);
  AttachShape(a, sink);
  var b := attachSink(a, sink);
  var released := b.queue[|a.queue|..];
  if released != [] {
    assert released[0] in released;
    var j :| 0 <= j < |a.entries| && a.entries[j].id == released[0] && a.entries[j].stage.InOutbox?;
    assert a.entries[j] in a.entries;
    assert |a.queue| == 0 && a.inDelivery == 0;
    assert b.queue == released;
    var f := ProofLib.Filter((e: AuditEntry) => e.stage.InOutbox?, a.entries);
    FilterOrderedIds((e: AuditEntry) => e.stage.InOutbox?, a.entries);
    assert sink in a.durable;
    assert released == (var s_map := f; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var e := s_map[i_map]; e.id));
    Asc(b.queue);
    forall q | q in b.queue ensures exists e :: e in b.entries && e.id == q && e.stage.Queued? {
      var i :| 0 <= i < |a.entries| && a.entries[i].id == q && a.entries[i].stage.InOutbox?;
      assert b.entries[i] in b.entries;
    }
  } else {
    assert b.queue == a.queue;
    forall q | q in b.queue ensures exists e :: e in b.entries && e.id == q && e.stage.Queued? {
      var e :| e in a.entries && e.id == q && e.stage.Queued?;
      var i :| 0 <= i < |a.entries| && a.entries[i] == e;
      assert b.entries[i] in b.entries;
    }
  }
}

lemma AttachDelivering(a: Audit, sink: int)
  requires inv(a) && canAttachSink(a, sink)
  ensures alwaysOneDeliveryAtATime(attachSink(a, sink))
  ensures alwaysRecordsNumberedInOrder(attachSink(a, sink))
  ensures stepSettledRecordsStaySettled(a, attachSink(a, sink))
{
  Facts(a);
  AttachShape(a, sink);
  var b := attachSink(a, sink);
  EntriesOrdered(a.entries);
  EntriesOrdered(b.entries);
  ProofLib.FilterLengthPointwise((e: AuditEntry) => e.stage.Delivering?, (e: AuditEntry) => e.stage.Delivering?, a.entries, b.entries);
  forall e | e in b.entries && e.stage.Delivering? ensures e.id == a.inDelivery {
    var i :| 0 <= i < |b.entries| && b.entries[i] == e;
    assert a.entries[i] in a.entries;
  }
  forall e | e in a.entries && (e.stage.Acknowledged? || e.stage.Refused?) ensures e in b.entries {
    var i :| 0 <= i < |a.entries| && a.entries[i] == e;
    assert b.entries[i] == e;
  }
  forall e | e in b.entries ensures e.id < b.nextEntry {
    var i :| 0 <= i < |b.entries| && b.entries[i] == e;
    assert a.entries[i] in a.entries;
  }
}

lemma AttachRows(a: Audit, sink: int)
  requires inv(a) && canAttachSink(a, sink)
  ensures alwaysRowsPrecedeWaitingRecords(attachSink(a, sink))
{
  AttachShape(a, sink);
  var b := attachSink(a, sink);
  forall r, q | r in b.rows && q in b.queue ensures r.entry < q {
    if q !in a.queue {
      var i :| 0 <= i < |a.entries| && a.entries[i].id == q && a.entries[i].stage.InOutbox?;
      assert a.entries[i] in a.entries;
    }
  }
  forall r, e | r in b.rows && e in b.entries && e.stage.InOutbox? ensures r.entry < e.id {
    var i :| 0 <= i < |b.entries| && b.entries[i] == e;
    assert a.entries[i] in a.entries;
  }
}

lemma RecordQueue(a: Audit)
  requires inv(a) && canRecordEntry(a)
  ensures alwaysQueueInRecordOrder(recordEntry(a))
{
  Facts(a);
  var b := recordEntry(a);
  var n := b.entries[|a.entries|];
  assert b.entries == a.entries + [n];
  Asc(a.queue);
  Asc(b.queue);
  if a.inDelivery != 0 {
    var di :| 0 <= di < |a.entries| && a.entries[di].id == a.inDelivery && a.entries[di].stage.Delivering?;
  }
  if b.queue != a.queue {
    assert b.queue == a.queue + [a.nextEntry];
    forall i | 0 <= i < |a.queue| ensures a.queue[i] < a.nextEntry {
      assert a.queue[i] in a.queue;
      var e :| e in a.entries && e.id == a.queue[i] && e.stage.Queued?;
    }
    forall i, j | 0 <= i < j < |b.queue| ensures b.queue[i] < b.queue[j] {
      if j == |a.queue| {
        assert b.queue[i] == a.queue[i];
      } else {
        assert b.queue[i] == a.queue[i] && b.queue[j] == a.queue[j];
      }
    }
  }
  forall q | q in b.queue ensures exists e :: e in b.entries && e.id == q && e.stage.Queued? {
    if q in a.queue {
      var e :| e in a.entries && e.id == q && e.stage.Queued?;
      assert e in b.entries;
    } else {
      assert n in b.entries;
    }
  }
}

lemma RecordDelivering(a: Audit)
  requires inv(a) && canRecordEntry(a)
  ensures alwaysOneDeliveryAtATime(recordEntry(a))
  ensures alwaysRecordsNumberedInOrder(recordEntry(a))
{
  Facts(a);
  var b := recordEntry(a);
  var n := b.entries[|a.entries|];
  assert b.entries == a.entries + [n];
  ProofLib.FilterAppend((e: AuditEntry) => e.stage.Delivering?, a.entries, n);
  EntriesOrdered(a.entries);
  EntriesOrdered(b.entries);
  forall i, j | 0 <= i < j < |b.entries| ensures b.entries[i].id < b.entries[j].id {
    if j == |a.entries| {
      assert b.entries[i] == a.entries[i];
    } else {
      assert b.entries[i] == a.entries[i] && b.entries[j] == a.entries[j];
    }
  }
}
