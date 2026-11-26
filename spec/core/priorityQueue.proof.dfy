lemma enqueue_ensures(s: PriorityState, payload: string, priority: QueuePriority)
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysPriorityBucketsAgree(enqueue(s, payload, priority)))
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysQueueTicketsUnique(enqueue(s, payload, priority)))
  ensures (inv(s) ==> canEnqueue(s, payload, priority) ==> alwaysTicketsCountFromOne(enqueue(s, payload, priority)))
{
  if inv(s) && canEnqueue(s, payload, priority) {
    var warned := s.(overflowWarnings := (s.overflowWarnings + (if (s.hasMax && (queueSize(s) >= s.maxSize)) then 1 else 0)));
    Tickets(s);
    Tickets(enqueue(s, payload, priority));
    Tickets(warned);
    InsertKeeps(payload, priority, warned);
  }
}

lemma resolvePressure_ensures(s: PriorityState, accepted: bool)
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysPriorityBucketsAgree(resolvePressure(s, accepted)))
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysQueueTicketsUnique(resolvePressure(s, accepted)))
  ensures (inv(s) ==> canResolvePressure(s, accepted) ==> alwaysTicketsCountFromOne(resolvePressure(s, accepted)))
{
  if inv(s) && canResolvePressure(s, accepted) {
    var released := s.(pressurePending := false);
    Tickets(s);
    Tickets(resolvePressure(s, accepted));
    Tickets(released);
    InsertKeeps(s.pendingPayload, s.pendingPriority, released);
  }
}

lemma drainTickets_ensures(s: PriorityState, tickets: seq<int>)
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysPriorityBucketsAgree(drainTickets(s, tickets)))
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysQueueTicketsUnique(drainTickets(s, tickets)))
  ensures (inv(s) ==> canDrainTickets(s, tickets) ==> alwaysTicketsCountFromOne(drainTickets(s, tickets)))
{
  if inv(s) && canDrainTickets(s, tickets) {
    var after := drainTickets(s, tickets);
    var p := (j: QueueItem) => !((j.ticket in tickets));
    assert after.high == ProofLib.Filter(p, s.high) && after.normal == ProofLib.Filter(p, s.normal) && after.low == ProofLib.Filter(p, s.low);
    Tickets(s);
    Tickets(after);
    Split3(s.high, s.normal, s.low);
    ProofLib.FilterKeepsDistinctBy(p, s.high, (x: QueueItem) => x.ticket);
    ProofLib.FilterKeepsDistinctBy(p, s.normal, (x: QueueItem) => x.ticket);
    ProofLib.FilterKeepsDistinctBy(p, s.low, (x: QueueItem) => x.ticket);
    forall x ensures (x in after.high ==> x in s.high) && (x in after.normal ==> x in s.normal) && (x in after.low ==> x in s.low) {
      ProofLib.FilterMember(p, s.high, x);
      ProofLib.FilterMember(p, s.normal, x);
      ProofLib.FilterMember(p, s.low, x);
    }
    Join3(after.high, after.normal, after.low);
  }
}

lemma dequeue_ensures(s: PriorityState, count: int)
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysPriorityBucketsAgree(dequeue(s, count)))
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysQueueTicketsUnique(dequeue(s, count)))
  ensures (inv(s) ==> canDequeue(s, count) ==> alwaysTicketsCountFromOne(dequeue(s, count)))
{
  if inv(s) && canDequeue(s, count) {
    var after := dequeue(s, count);
    var kept := splitQueue(s, count).kept;
    var h := (j: QueueItem) => j.priority.High?;
    var n := (j: QueueItem) => j.priority.Normal?;
    var l := (j: QueueItem) => j.priority.Low?;
    assert after.high == ProofLib.Filter(h, kept) && after.normal == ProofLib.Filter(n, kept) && after.low == ProofLib.Filter(l, kept);
    Tickets(s);
    Tickets(after);
    assert emptyItemSplit.kept + queuedItems(s) == queuedItems(s);
    SplitKeeps(count, emptyItemSplit, queuedItems(s));
    ProofLib.FilterKeepsDistinctBy(h, kept, (x: QueueItem) => x.ticket);
    ProofLib.FilterKeepsDistinctBy(n, kept, (x: QueueItem) => x.ticket);
    ProofLib.FilterKeepsDistinctBy(l, kept, (x: QueueItem) => x.ticket);
    forall x ensures (x in after.high <==> x in kept && h(x)) && (x in after.normal <==> x in kept && n(x)) && (x in after.low <==> x in kept && l(x)) {
      ProofLib.FilterMember(h, kept, x);
      ProofLib.FilterMember(n, kept, x);
      ProofLib.FilterMember(l, kept, x);
    }
    forall x, y | x in kept && y in kept && x != y ensures x.ticket != y.ticket {
      var i :| 0 <= i < |kept| && kept[i] == x;
      var j :| 0 <= j < |kept| && kept[j] == y;
    }
    Join3(after.high, after.normal, after.low);
  }
}

lemma InsertKeeps(payload: string, priority: QueuePriority, s: PriorityState)
  requires alwaysQueueTicketsUnique(s) && alwaysTicketsCountFromOne(s)
  ensures alwaysQueueTicketsUnique(insertPayload(payload, priority, s))
{
  var after := insertPayload(payload, priority, s);
  var actual := (if priority.InvalidPriority? then QueuePriority.Normal else priority);
  var job := QueueItem(s.nextTicket, payload, actual);
  Tickets(s);
  Tickets(after);
  Split3(s.high, s.normal, s.low);
  ProofLib.DistinctByConcat(s.high, [job], (x: QueueItem) => x.ticket);
  ProofLib.DistinctByConcat(s.normal, [job], (x: QueueItem) => x.ticket);
  ProofLib.DistinctByConcat(s.low, [job], (x: QueueItem) => x.ticket);
  Join3(after.high, after.normal, after.low);
}

lemma Tickets(s: PriorityState)
  ensures alwaysQueueTicketsUnique(s) <==> ProofLib.DistinctBy(s.high + s.normal + s.low, (x: QueueItem) => x.ticket) && forall x :: x in s.high + s.normal + s.low ==> 0 < x.ticket < s.nextTicket
{
  TicketsFilter(s);
  TicketsIff(queuedItems(s), s.nextTicket);
}

lemma TicketsFilter(s: PriorityState)
  ensures alwaysQueueTicketsUnique(s) == !((exists j :: j in queuedItems(s) && !((((j.ticket > 0) && (j.ticket < s.nextTicket)) && (|ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), queuedItems(s))| == 1)))))
{
}

lemma TicketsIff(q: seq<QueueItem>, n: int)
  ensures !((exists j :: j in q && !((((j.ticket > 0) && (j.ticket < n)) && (|ProofLib.Filter((other: QueueItem) => (other.ticket == j.ticket), q)| == 1))))) <==> ProofLib.DistinctBy(q, (x: QueueItem) => x.ticket) && forall x :: x in q ==> 0 < x.ticket < n
{
  forall i | 0 <= i < |q|
    ensures |ProofLib.Filter((other: QueueItem) => (other.ticket == q[i].ticket), q)| == 1 <==> forall j :: 0 <= j < |q| && j != i ==> q[j].ticket != q[i].ticket
  {
    ProofLib.FilterCountOneIffUnique((other: QueueItem) => (other.ticket == q[i].ticket), q, (x: QueueItem) => x.ticket, i);
  }
  if ProofLib.DistinctBy(q, (x: QueueItem) => x.ticket) {
    forall e | e in q ensures |ProofLib.Filter((other: QueueItem) => (other.ticket == e.ticket), q)| == 1 {
      var i :| 0 <= i < |q| && q[i] == e;
    }
  } else {
    var i, j :| 0 <= i < |q| && 0 <= j < |q| && i != j && q[i].ticket == q[j].ticket;
    assert q[i] in q;
  }
}

lemma Split3(a: seq<QueueItem>, b: seq<QueueItem>, c: seq<QueueItem>)
  requires ProofLib.DistinctBy(a + b + c, (x: QueueItem) => x.ticket)
  ensures ProofLib.DistinctBy(a, (x: QueueItem) => x.ticket) && ProofLib.DistinctBy(b, (x: QueueItem) => x.ticket) && ProofLib.DistinctBy(c, (x: QueueItem) => x.ticket)
  ensures forall x, y :: (x in a && y in b) || (x in a && y in c) || (x in b && y in c) ==> x.ticket != y.ticket
{
  var q := a + b + c;
  assert forall i :: 0 <= i < |a| ==> q[i] == a[i];
  assert forall i :: 0 <= i < |b| ==> q[|a| + i] == b[i];
  assert forall i :: 0 <= i < |c| ==> q[|a| + |b| + i] == c[i];
  forall x, y | (x in a && y in b) || (x in a && y in c) || (x in b && y in c) ensures x.ticket != y.ticket {
    if x in a && y in b {
      var i :| 0 <= i < |a| && a[i] == x;
      var j :| 0 <= j < |b| && b[j] == y;
      assert q[i] == x && q[|a| + j] == y;
    } else if x in a {
      var i :| 0 <= i < |a| && a[i] == x;
      var j :| 0 <= j < |c| && c[j] == y;
      assert q[i] == x && q[|a| + |b| + j] == y;
    } else {
      var i :| 0 <= i < |b| && b[i] == x;
      var j :| 0 <= j < |c| && c[j] == y;
      assert q[|a| + i] == x && q[|a| + |b| + j] == y;
    }
  }
}

lemma Join3(a: seq<QueueItem>, b: seq<QueueItem>, c: seq<QueueItem>)
  requires ProofLib.DistinctBy(a, (x: QueueItem) => x.ticket) && ProofLib.DistinctBy(b, (x: QueueItem) => x.ticket) && ProofLib.DistinctBy(c, (x: QueueItem) => x.ticket)
  requires forall x, y :: (x in a && y in b) || (x in a && y in c) || (x in b && y in c) ==> x.ticket != y.ticket
  ensures ProofLib.DistinctBy(a + b + c, (x: QueueItem) => x.ticket)
{
  ProofLib.DistinctByConcat(a, b, (x: QueueItem) => x.ticket);
  ProofLib.DistinctByConcat(a + b, c, (x: QueueItem) => x.ticket);
}

lemma SplitKeeps(count: int, acc: ItemSplit, xs: seq<QueueItem>)
  requires ProofLib.DistinctBy(acc.kept + xs, (x: QueueItem) => x.ticket)
  ensures ProofLib.DistinctBy(Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), acc, xs).kept, (x: QueueItem) => x.ticket)
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), acc, xs).kept ==> x in acc.kept || x in xs
  decreases |xs|
{
  if |xs| > 0 {
    var next := splitItem(count, acc, xs[0]);
    assert acc.kept + xs == acc.kept + [xs[0]] + xs[1..];
    if acc.position < count {
      DropOne(acc.kept, xs[0], xs[1..]);
    } else {
      assert next.kept + xs[1..] == acc.kept + xs;
    }
    SplitKeeps(count, next, xs[1..]);
    assert forall x :: x in next.kept ==> x in acc.kept || x == xs[0];
    assert forall x :: x in xs[1..] ==> x in xs;
    assert Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), acc, xs) == Std.Collections.Seq.FoldLeft((acc: ItemSplit, job: QueueItem) => splitItem(count, acc, job), next, xs[1..]);
  } else {
    assert acc.kept + xs == acc.kept;
  }
}

lemma DropOne(a: seq<QueueItem>, x: QueueItem, b: seq<QueueItem>)
  requires ProofLib.DistinctBy(a + [x] + b, (x: QueueItem) => x.ticket)
  ensures ProofLib.DistinctBy(a + b, (x: QueueItem) => x.ticket)
{
  var full := a + [x] + b;
  var short := a + b;
  forall i | 0 <= i < |short| ensures short[i] == full[if i < |a| then i else i + 1] { }
}
