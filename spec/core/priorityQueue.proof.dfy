lemma QueueTicketsView(s: PriorityState)
  ensures alwaysQueueTicketsUnique(s) == !((exists j :: j in queuedItems(s) && !((((j.ticket > 0) && (j.ticket < s.nextTicket)) && (|ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), queuedItems(s))| == 1)))))
{
}

lemma QueueTicketsDistinct(s: PriorityState)
  requires alwaysQueueTicketsUnique(s)
  ensures ProofLib.DistinctBy(queuedItems(s), (j: QueueItem) => j.ticket)
  ensures forall j :: j in queuedItems(s) ==> 0 < j.ticket < s.nextTicket
{
  QueueTicketsView(s);
  var xs := queuedItems(s);
  forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
    ensures xs[i].ticket != xs[k].ticket
  {
    var j := xs[i];
    assert |ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), xs)| == 1;
    ProofLib.FilterCountOneIffUnique((other: QueueItem) => (other.ticket == j.ticket), xs, (j: QueueItem) => j.ticket, i);
  }
}

lemma DistinctTicketsGiveCounts(s: PriorityState)
  requires ProofLib.DistinctBy(queuedItems(s), (j: QueueItem) => j.ticket)
  requires forall j :: j in queuedItems(s) ==> 0 < j.ticket < s.nextTicket
  ensures alwaysQueueTicketsUnique(s)
{
  QueueTicketsView(s);
  var xs := queuedItems(s);
  forall j | j in xs
    ensures 0 < j.ticket < s.nextTicket && |ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == j;
    ProofLib.FilterCountOneIffUnique((other: QueueItem) => (other.ticket == j.ticket), xs, (j: QueueItem) => j.ticket, i);
  }
}

lemma FreshInserted(xs: seq<QueueItem>, at: int, job: QueueItem)
  requires 0 <= at <= |xs|
  requires ProofLib.DistinctBy(xs, (j: QueueItem) => j.ticket)
  requires forall j :: j in xs ==> j.ticket != job.ticket
  ensures ProofLib.DistinctBy(xs[..at] + [job] + xs[at..], (j: QueueItem) => j.ticket)
{
  var ys := xs[..at] + [job] + xs[at..];
  forall i, k | 0 <= i < |ys| && 0 <= k < |ys| && i != k
    ensures ys[i].ticket != ys[k].ticket
  {
    if i == at {
      assert ys[i] == job;
      if k < at { assert ys[k] == xs[k]; }
      else { assert ys[k] == xs[k - 1]; }
    } else if k == at {
      assert ys[k] == job;
      if i < at { assert ys[i] == xs[i]; }
      else { assert ys[i] == xs[i - 1]; }
    } else {
      var a := if i < at then i else i - 1;
      var b := if k < at then k else k - 1;
      assert 0 <= a < |xs| && 0 <= b < |xs| && a != b;
      assert ys[i] == xs[a] && ys[k] == xs[b];
    }
  }
}

lemma InsertPayloadKeepsQueue(s: PriorityState, payload: string, priority: QueuePriority)
  requires wellFormed(s)
  ensures wellFormed(insertPayload(payload, priority, s))
{
  QueueTicketsDistinct(s);
  var actual := if priority.InvalidPriority? then QueuePriority.Normal else priority;
  var job := QueueItem(s.nextTicket, payload, actual);
  var xs := queuedItems(s);
  var at := if actual.High? then |s.high| else if actual.Normal? then |s.high| + |s.normal| else |xs|;
  assert actual.High? || actual.Normal? || actual.Low?;
  assert xs[..at] + [job] + xs[at..] == queuedItems(insertPayload(payload, priority, s));
  FreshInserted(xs, at, job);
  var after := insertPayload(payload, priority, s);
  assert forall j :: j in queuedItems(after) ==> j == job || j in xs;
  DistinctTicketsGiveCounts(after);
}

lemma FilterConcat(p: QueueItem -> bool, a: seq<QueueItem>, b: seq<QueueItem>)
  ensures ProofLib.Filter(p, a + b) == ProofLib.Filter(p, a) + ProofLib.Filter(p, b)
  decreases |b|
{
  if |b| == 0 {
    assert b == [];
    assert a + b == a;
    ProofLib.FilterNil(p, b);
  }
  else {
    var rest := b[..|b| - 1];
    var last := b[|b| - 1];
    assert b == rest + [last];
    FilterConcat(p, a, rest);
    ProofLib.FilterAppend(p, a + rest, last);
    ProofLib.FilterAppend(p, rest, last);
    assert (a + rest) + [last] == a + b;
    calc {
      ProofLib.Filter(p, a + b);
      == ProofLib.Filter(p, a + rest) + (if p(last) then [last] else []);
      == (ProofLib.Filter(p, a) + ProofLib.Filter(p, rest)) + (if p(last) then [last] else []);
      == ProofLib.Filter(p, a) + (ProofLib.Filter(p, rest) + (if p(last) then [last] else []));
      == ProofLib.Filter(p, a) + ProofLib.Filter(p, b);
    }
  }
}

lemma DrainTicketsView(s: PriorityState, tickets: seq<int>)
  ensures drainTickets(s, tickets) == s.(high := ProofLib.Filter((j: QueueItem) => !((j.ticket in tickets)), s.high), normal := ProofLib.Filter((j: QueueItem) => !((j.ticket in tickets)), s.normal), low := ProofLib.Filter((j: QueueItem) => !((j.ticket in tickets)), s.low), lastRemoved := ProofLib.Filter((j: QueueItem) => (j.ticket in tickets), queuedItems(s)))
{
}

lemma dequeue_ensures(s: PriorityState, count: int)
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysPriorityBucketsAgree(dequeue(s, count)))
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysQueueTicketsUnique(dequeue(s, count)))
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysNextTicketIsPositive(dequeue(s, count)))
{
  if inv(s) && canDequeue(s, count) {
    DequeueKeepsTickets(s, count);
  }
}

lemma enqueue_ensures(s: PriorityState, payload: string, priority: QueuePriority)
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysPriorityBucketsAgree(enqueue(s, payload, priority)))
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysQueueTicketsUnique(enqueue(s, payload, priority)))
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysNextTicketIsPositive(enqueue(s, payload, priority)))
{
  if inv(s) && canEnqueue(s, payload, priority) {
    if !((s.hasMax && queueSize(s) >= s.maxSize) && s.hasPressure) {
      InsertPayloadKeepsQueue(s.(overflowWarnings := s.overflowWarnings + (if s.hasMax && queueSize(s) >= s.maxSize then 1 else 0)), payload, priority);
    }
  }
}

lemma resolvePressure_ensures(s: PriorityState, accepted: bool)
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysPriorityBucketsAgree(resolvePressure(s, accepted)))
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysQueueTicketsUnique(resolvePressure(s, accepted)))
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysNextTicketIsPositive(resolvePressure(s, accepted)))
{
  if inv(s) && canResolvePressure(s, accepted) && accepted {
    InsertPayloadKeepsQueue(s.(pressurePending := false), s.pendingPayload, s.pendingPriority);
  }
}

lemma drainTickets_ensures(s: PriorityState, tickets: seq<int>)
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysPriorityBucketsAgree(drainTickets(s, tickets)))
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysQueueTicketsUnique(drainTickets(s, tickets)))
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysNextTicketIsPositive(drainTickets(s, tickets)))
{
  if inv(s) && canDrainTickets(s, tickets) {
    QueueTicketsDistinct(s);
    DrainTicketsView(s, tickets);
    var p := (j: QueueItem) => !((j.ticket in tickets));
    var xs := queuedItems(s);
    var after := drainTickets(s, tickets);
    FilterConcat(p, s.high, s.normal);
    FilterConcat(p, s.high + s.normal, s.low);
    assert queuedItems(after) == ProofLib.Filter(p, xs);
    ProofLib.FilterKeepsDistinctBy(p, xs, (j: QueueItem) => j.ticket);
    forall j | j in queuedItems(after) ensures 0 < j.ticket < after.nextTicket {
      ProofLib.FilterMember(p, xs, j);
    }
    forall j | j in after.high ensures j.priority.High? {
      ProofLib.FilterMember(p, s.high, j);
    }
    forall j | j in after.normal ensures j.priority.Normal? {
      ProofLib.FilterMember(p, s.normal, j);
    }
    forall j | j in after.low ensures j.priority.Low? {
      ProofLib.FilterMember(p, s.low, j);
    }
    DistinctTicketsGiveCounts(after);
  }
}

lemma SplitPrefix(xs: seq<QueueItem>, count: int)
  ensures var parts := Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), emptyItemSplit, xs); parts.position == |xs| && parts.taken + parts.kept == xs && |parts.taken| == (if count <= 0 then 0 else if count < |xs| then count else |xs|)
  decreases |xs|
{
  if |xs| == 0 {
  } else {
    var before := xs[..|xs| - 1];
    var last := xs[|xs| - 1];
    assert xs == before + [last];
    SplitPrefix(before, count);
    ProofLib.FoldLeftAppend((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), emptyItemSplit, before, last);
    var priorSplit := Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), emptyItemSplit, before);
    if priorSplit.position < count { assert priorSplit.kept == []; }
  }
}

lemma DequeueBucketsView(s: PriorityState, count: int)
  ensures var parts := splitQueue(s, count); dequeue(s, count) == s.(high := ProofLib.Filter((j: QueueItem) => j.priority.High?, parts.kept), normal := ProofLib.Filter((j: QueueItem) => j.priority.Normal?, parts.kept), low := ProofLib.Filter((j: QueueItem) => j.priority.Low?, parts.kept), lastRemoved := parts.taken)
{
}

lemma PriorityProjection(xs: seq<QueueItem>)
  requires ProofLib.DistinctBy(xs, (j: QueueItem) => j.ticket)
  ensures var hi := ProofLib.Filter((j: QueueItem) => j.priority.High?, xs); var normal := ProofLib.Filter((j: QueueItem) => j.priority.Normal?, xs); var low := ProofLib.Filter((j: QueueItem) => j.priority.Low?, xs); ProofLib.DistinctBy(hi + normal + low, (j: QueueItem) => j.ticket)
{
  var hi := ProofLib.Filter((j: QueueItem) => j.priority.High?, xs);
  var normal := ProofLib.Filter((j: QueueItem) => j.priority.Normal?, xs);
  var low := ProofLib.Filter((j: QueueItem) => j.priority.Low?, xs);
  ProofLib.FilterKeepsDistinctBy((j: QueueItem) => j.priority.High?, xs, (j: QueueItem) => j.ticket);
  ProofLib.FilterKeepsDistinctBy((j: QueueItem) => j.priority.Normal?, xs, (j: QueueItem) => j.ticket);
  ProofLib.FilterKeepsDistinctBy((j: QueueItem) => j.priority.Low?, xs, (j: QueueItem) => j.ticket);
  forall a, b | a in hi && b in normal
    ensures a.ticket != b.ticket
  {
    ProofLib.FilterMember((j: QueueItem) => j.priority.High?, xs, a);
    ProofLib.FilterMember((j: QueueItem) => j.priority.Normal?, xs, b);
    var i :| 0 <= i < |xs| && xs[i] == a;
    var k :| 0 <= k < |xs| && xs[k] == b;
  }
  ProofLib.DistinctByConcat(hi, normal, (j: QueueItem) => j.ticket);
  forall a, b | a in hi + normal && b in low
    ensures a.ticket != b.ticket
  {
    ProofLib.FilterMember((j: QueueItem) => j.priority.High?, xs, a);
    ProofLib.FilterMember((j: QueueItem) => j.priority.Normal?, xs, a);
    ProofLib.FilterMember((j: QueueItem) => j.priority.Low?, xs, b);
    var i :| 0 <= i < |xs| && xs[i] == a;
    var k :| 0 <= k < |xs| && xs[k] == b;
  }
  ProofLib.DistinctByConcat(hi + normal, low, (j: QueueItem) => j.ticket);
}

lemma DequeueKeepsTickets(s: PriorityState, count: int)
  requires wellFormed(s)
  ensures wellFormed(dequeue(s, count))
{
  QueueTicketsDistinct(s);
  SplitPrefix(queuedItems(s), count);
  var parts := splitQueue(s, count);
  assert ProofLib.DistinctBy(parts.kept, (j: QueueItem) => j.ticket) by {
    forall i, k | 0 <= i < |parts.kept| && 0 <= k < |parts.kept| && i != k
      ensures parts.kept[i].ticket != parts.kept[k].ticket
    {
      assert parts.kept[i] == queuedItems(s)[|parts.taken| + i];
      assert parts.kept[k] == queuedItems(s)[|parts.taken| + k];
    }
  }
  PriorityProjection(parts.kept);
  DequeueBucketsView(s, count);
  var after := dequeue(s, count);
  forall j | j in queuedItems(after)
    ensures 0 < j.ticket < after.nextTicket
  {
    ProofLib.FilterMember((j: QueueItem) => j.priority.High?, parts.kept, j);
    ProofLib.FilterMember((j: QueueItem) => j.priority.Normal?, parts.kept, j);
    ProofLib.FilterMember((j: QueueItem) => j.priority.Low?, parts.kept, j);
  }
  forall j | j in after.high ensures j.priority.High? {
    ProofLib.FilterMember((j: QueueItem) => j.priority.High?, parts.kept, j);
  }
  forall j | j in after.normal ensures j.priority.Normal? {
    ProofLib.FilterMember((j: QueueItem) => j.priority.Normal?, parts.kept, j);
  }
  forall j | j in after.low ensures j.priority.Low? {
    ProofLib.FilterMember((j: QueueItem) => j.priority.Low?, parts.kept, j);
  }
  DistinctTicketsGiveCounts(after);
}

lemma DequeueReceiptView(s: PriorityState, count: int)
  ensures lawDequeueReceipt(s, count) == (var local_3 := dequeue(s, count).lastRemoved; (((|local_3| <= (if (count > 0) then count else 0)) && !((exists j :: j in local_3 && !(!(!((exists other :: other in queuedItems(s) && !((((other.ticket != j.ticket) || (other.payload != j.payload)) || (other.priority != j.priority)))))))))) && (!(wellFormed(s)) || !((exists j :: j in local_3 && !((((j.ticket > 0) && (j.ticket < s.nextTicket)) && (|ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), local_3)| == 1))))))))
{
}

lemma lawDequeueReceipt_ensures(s: PriorityState, count: int)
  ensures (lawDequeueReceipt(s, count) == true)
{
  SplitPrefix(queuedItems(s), count);
  var removed := dequeue(s, count).lastRemoved;
  DequeueReceiptView(s, count);
  if wellFormed(s) {
    QueueTicketsDistinct(s);
    assert ProofLib.DistinctBy(removed, (j: QueueItem) => j.ticket) by {
      forall i, k | 0 <= i < |removed| && 0 <= k < |removed| && i != k
        ensures removed[i].ticket != removed[k].ticket
      {
        assert removed[i] == queuedItems(s)[i] && removed[k] == queuedItems(s)[k];
      }
    }
    forall j | j in removed
      ensures 0 < j.ticket < s.nextTicket && |ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), removed)| == 1
    {
      var i :| 0 <= i < |removed| && removed[i] == j;
      ProofLib.FilterCountOneIffUnique((other: QueueItem) => (other.ticket == j.ticket), removed, (j: QueueItem) => j.ticket, i);
    }
  }
}
