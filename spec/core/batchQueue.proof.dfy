lemma BatchComponents(s: BatchQueue)
  requires inv(s)
  ensures core__priorityQueue_inv(s.queue) && core__batchProcessor_inv(s.processor)
{}

lemma BatchFallbackSelection(s: BatchQueue,ticket: int,perItemAttempts: int)
  ensures var found := ProofLib.Filter((j: BatchItem) => j.ticket == ticket,s.active);
    startFallback(s,ticket,perItemAttempts).processor == core__batchProcessor_submitItem(s.processor,ticket,s.batchId,
      (if |found| > 0 then found[0] else emptyBatchItem).payload,perItemAttempts)
{}

lemma BatchActiveIdentityView(s: BatchQueue)
  ensures alwaysBatchItemIdentityUnique(s) == !((exists j :: j in s.active && !((|ProofLib.Filter((other: BatchItem) => (other.ticket == j.ticket), s.active)| == 1))))
{}

lemma BatchTicketOwnershipView(s: BatchQueue)
  ensures alwaysBatchTicketOwnership(s) == ((((!((exists j :: j in (s.active + s.flush) && !(((j.ticket > 0) && (j.ticket < s.queue.nextTicket))))) && !((exists j :: j in s.processor.items && !((j.id < s.queue.nextTicket))))) && !((exists j :: j in s.flush && !(((|ProofLib.Filter((other: BatchItem) => (other.ticket == j.ticket), s.flush)| == 1) && !((exists other :: other in s.processor.items && (other.id == j.ticket)))))))) && !((exists j :: j in s.active && !(!((exists other :: other in s.flush && (other.ticket == j.ticket))))))) && !((exists j :: j in core__priorityQueue_queuedItems(s.queue) && !((!((exists other :: other in (s.active + s.flush) && (other.ticket == j.ticket))) && !((exists other :: other in s.processor.items && (other.id == j.ticket))))))))
{}

lemma BatchActiveSelection(s: BatchQueue,selected: BatchItem)
  requires alwaysBatchItemIdentityUnique(s) && selected in s.active
  ensures forall j :: j in s.active && j.ticket == selected.ticket ==> j == selected
{
  BatchActiveIdentityView(s);
  var i :| 0 <= i < |s.active| && s.active[i] == selected;
  ProofLib.FilterCountOneIffUnique((other: BatchItem) => other.ticket == selected.ticket,s.active,(other: BatchItem) => other.ticket,i);
  forall j | j in s.active && j.ticket == selected.ticket ensures j == selected {
    var k :| 0 <= k < |s.active| && s.active[k] == j;
    assert i == k;
  }
}

lemma BatchTicketMapCount(xs: seq<BatchItem>,ys: seq<BatchItem>)
  requires forall item :: item in xs ==> |ProofLib.Filter((other: BatchItem) => other.ticket == item.ticket,xs)| == 1
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].ticket == ys[i].ticket
  ensures forall item :: item in ys ==> |ProofLib.Filter((other: BatchItem) => other.ticket == item.ticket,ys)| == 1
{
  forall i,j | 0 <= i < |ys| && 0 <= j < |ys| && i != j
    ensures ys[i].ticket != ys[j].ticket
  {
    var priorItem := xs[i]; assert priorItem in xs;
    ProofLib.FilterCountOneIffUnique((other: BatchItem) => other.ticket == priorItem.ticket,xs,(other: BatchItem) => other.ticket,i);
  }
  forall j | j in ys ensures |ProofLib.Filter((other: BatchItem) => other.ticket == j.ticket,ys)| == 1 {
    var i :| 0 <= i < |ys| && ys[i] == j;
    ProofLib.FilterOne((other: BatchItem) => other.ticket == j.ticket,ys,i);
  }
}


lemma BatchActiveIdentityMap(s: BatchQueue,t: BatchQueue)
  requires alwaysBatchItemIdentityUnique(s)
  requires |s.active| == |t.active|
  requires forall i :: 0 <= i < |s.active| ==> s.active[i].ticket == t.active[i].ticket
  ensures alwaysBatchItemIdentityUnique(t)
{
  BatchActiveIdentityView(s); BatchActiveIdentityView(t);
  BatchTicketMapCount(s.active,t.active);
}

lemma BatchFlushIdentityMap(s: BatchQueue,t: BatchQueue)
  requires inv(s)
  requires t.active == s.active && t.queue == s.queue && t.processor == s.processor
  requires |s.flush| == |t.flush|
  requires forall i :: 0 <= i < |s.flush| ==> s.flush[i].ticket == t.flush[i].ticket
  ensures alwaysBatchTicketOwnership(t)
{
  BatchTicketOwnershipView(s); BatchTicketOwnershipView(t);
  BatchTicketMapCount(s.flush,t.flush);
  forall item | item in t.flush
    ensures item.ticket > 0 && item.ticket < t.queue.nextTicket && !(exists proc :: proc in t.processor.items && proc.id == item.ticket)
  {
    var i :| 0 <= i < |t.flush| && t.flush[i] == item;
    assert s.flush[i] in s.flush && s.flush[i].ticket == item.ticket;
  }
  forall item | item in t.active ensures !(exists other :: other in t.flush && other.ticket == item.ticket) {
    forall other | other in t.flush ensures other.ticket != item.ticket {
      var i :| 0 <= i < |t.flush| && t.flush[i] == other;
      assert s.flush[i] in s.flush && s.flush[i].ticket == other.ticket;
    }
  }
  forall item | item in core__priorityQueue_queuedItems(t.queue)
    ensures !(exists other :: other in t.active + t.flush && other.ticket == item.ticket)
  {
    forall other | other in t.flush ensures other.ticket != item.ticket {
      var i :| 0 <= i < |t.flush| && t.flush[i] == other;
      assert s.flush[i] in s.flush && s.flush[i].ticket == other.ticket;
    }
  }
}

lemma BatchQQueueTicketsView(s: core__priorityQueue_PriorityState)
  ensures core__priorityQueue_alwaysQueueTicketsUnique(s) == !((exists j :: j in core__priorityQueue_queuedItems(s) && !((((j.ticket > 0) && (j.ticket < s.nextTicket)) && (|ProofLib.Filter((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), core__priorityQueue_queuedItems(s))| == 1)))))
{
}

lemma BatchQQueueTicketsDistinct(s: core__priorityQueue_PriorityState)
  requires core__priorityQueue_alwaysQueueTicketsUnique(s)
  ensures ProofLib.DistinctBy(core__priorityQueue_queuedItems(s), (j: core__priorityQueue_QueueItem) => j.ticket)
  ensures forall j :: j in core__priorityQueue_queuedItems(s) ==> 0 < j.ticket < s.nextTicket
{
  BatchQQueueTicketsView(s);
  var xs := core__priorityQueue_queuedItems(s);
  forall i, k | 0 <= i < |xs| && 0 <= k < |xs| && i != k
    ensures xs[i].ticket != xs[k].ticket
  {
    var j := xs[i];
    assert |ProofLib.Filter((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), xs)| == 1;
    ProofLib.FilterCountOneIffUnique((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), xs, (j: core__priorityQueue_QueueItem) => j.ticket, i);
  }
}

lemma BatchQSplitPrefix(xs: seq<core__priorityQueue_QueueItem>, count: int)
  ensures var parts := Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), core__priorityQueue_emptyItemSplit, xs); parts.position == |xs| && parts.taken + parts.kept == xs && |parts.taken| == (if count <= 0 then 0 else if count < |xs| then count else |xs|)
  decreases |xs|
{
  if |xs| == 0 {
  } else {
    var before := xs[..|xs| - 1];
    var last := xs[|xs| - 1];
    assert xs == before + [last];
    BatchQSplitPrefix(before, count);
    ProofLib.FoldLeftAppend((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), core__priorityQueue_emptyItemSplit, before, last);
    var priorSplit := Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), core__priorityQueue_emptyItemSplit, before);
    if priorSplit.position < count { assert priorSplit.kept == []; }
  }
}

lemma BatchQDequeueBucketsView(s: core__priorityQueue_PriorityState, count: int)
  ensures var parts := core__priorityQueue_splitQueue(s, count); core__priorityQueue_dequeue(s, count) == s.(high := ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.High?, parts.kept), normal := ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.Normal?, parts.kept), low := ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.Low?, parts.kept), lastRemoved := parts.taken)
{
}

lemma BatchQDequeueReceiptView(s: core__priorityQueue_PriorityState, count: int)
  ensures core__priorityQueue_lawDequeueReceipt(s, count) == (var local_3 := core__priorityQueue_dequeue(s, count).lastRemoved; (((|local_3| <= (if (count > 0) then count else 0)) && !((exists j :: j in local_3 && !(!(!((exists other :: other in core__priorityQueue_queuedItems(s) && !((((other.ticket != j.ticket) || (other.payload != j.payload)) || (other.priority != j.priority)))))))))) && (!(core__priorityQueue_wellFormed(s)) || !((exists j :: j in local_3 && !((((j.ticket > 0) && (j.ticket < s.nextTicket)) && (|ProofLib.Filter((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), local_3)| == 1))))))))
{
}

lemma BatchQDequeueSeparation(q: core__priorityQueue_PriorityState,count: int)
  requires core__priorityQueue_wellFormed(q)
  ensures forall item :: item in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(q,count)) ==> item in core__priorityQueue_queuedItems(q)
  ensures forall removed,kept :: removed in core__priorityQueue_dequeue(q,count).lastRemoved && kept in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(q,count)) ==> removed.ticket != kept.ticket
{
  BatchQQueueTicketsDistinct(q);
  var xs := core__priorityQueue_queuedItems(q);
  BatchQSplitPrefix(xs,count);
  BatchQDequeueBucketsView(q,count);
  var parts := core__priorityQueue_splitQueue(q,count);
  forall item | item in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(q,count))
    ensures item in parts.kept && item in xs
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.High?,parts.kept,item);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Normal?,parts.kept,item);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Low?,parts.kept,item);
  }
  forall removed,kept | removed in core__priorityQueue_dequeue(q,count).lastRemoved && kept in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(q,count))
    ensures removed.ticket != kept.ticket
  {
    assert removed in parts.taken && kept in parts.kept;
    var i :| 0 <= i < |parts.taken| && parts.taken[i] == removed;
    var j :| 0 <= j < |parts.kept| && parts.kept[j] == kept;
    assert xs == parts.taken + parts.kept;
    assert xs[i] == removed && xs[|parts.taken|+j] == kept;
  }
}

lemma BatchMappedQueueIdentities(xs: seq<core__priorityQueue_QueueItem>,ys: seq<BatchItem>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].ticket == ys[i].ticket
  requires forall item :: item in xs ==> |ProofLib.Filter((other: core__priorityQueue_QueueItem) => other.ticket == item.ticket,xs)| == 1
  ensures forall item :: item in ys ==> |ProofLib.Filter((other: BatchItem) => other.ticket == item.ticket,ys)| == 1
{
  forall item | item in ys ensures |ProofLib.Filter((other: BatchItem) => other.ticket == item.ticket,ys)| == 1 {
    var i :| 0 <= i < |ys| && ys[i] == item;
    var source := xs[i]; assert source in xs && source.ticket == item.ticket;
    ProofLib.FilterLengthPointwise((other: core__priorityQueue_QueueItem) => other.ticket == source.ticket,
      (other: BatchItem) => other.ticket == item.ticket,xs,ys);
  }
}


lemma BatchProcessorIdsView(s: core__batchProcessor_Processor)
  ensures core__batchProcessor_alwaysProcessorInvocationIds(s) <==>
    (forall j :: j in s.items ==> (j.id > 0 && j.batch > 0 &&
      |ProofLib.Filter((other: core__batchProcessor_ProcessorItem) => other.id == j.id, s.items)| == 1))
{}

lemma BatchProcessorSelection(s: core__batchProcessor_Processor, selected: core__batchProcessor_ProcessorItem)
  requires core__batchProcessor_alwaysProcessorInvocationIds(s) && selected in s.items
  ensures forall j :: j in s.items && j.id == selected.id ==> j == selected
{
  BatchProcessorIdsView(s);
  var i :| 0 <= i < |s.items| && s.items[i] == selected;
  ProofLib.FilterCountOneIffUnique((other: core__batchProcessor_ProcessorItem) => other.id == selected.id, s.items, (other: core__batchProcessor_ProcessorItem) => other.id, i);
  forall j | j in s.items && j.id == selected.id ensures j == selected {
    var k :| 0 <= k < |s.items| && s.items[k] == j;
    assert i == k;
  }
}

lemma BatchProcessorKeepsOwnership(s: BatchQueue,t: BatchQueue)
  requires inv(s)
  requires t.active == s.active && t.flush == s.flush && t.queue == s.queue && t.batchId == s.batchId
  requires |t.processor.items| == |s.processor.items|
  requires forall i :: 0 <= i < |s.processor.items| ==> (t.processor.items[i].id == s.processor.items[i].id && t.processor.items[i].batch == s.processor.items[i].batch && t.processor.items[i].payload == s.processor.items[i].payload)
  ensures alwaysBatchTicketOwnership(t) && alwaysFallbackInvocationOwnership(t)
{
  BatchTicketOwnershipView(s); BatchTicketOwnershipView(t);
  forall item | item in t.processor.items ensures item.id < t.queue.nextTicket {
    var i :| 0 <= i < |t.processor.items| && t.processor.items[i] == item;
    assert s.processor.items[i] in s.processor.items;
  }
  forall item | item in t.flush ensures !(exists proc :: proc in t.processor.items && proc.id == item.ticket) {
    forall proc | proc in t.processor.items ensures proc.id != item.ticket {
      var i :| 0 <= i < |t.processor.items| && t.processor.items[i] == proc;
      assert s.processor.items[i] in s.processor.items;
    }
  }
  forall item | item in core__priorityQueue_queuedItems(t.queue)
    ensures !(exists proc :: proc in t.processor.items && proc.id == item.ticket)
  {
    forall proc | proc in t.processor.items ensures proc.id != item.ticket {
      var i :| 0 <= i < |t.processor.items| && t.processor.items[i] == proc;
      assert s.processor.items[i] in s.processor.items;
    }
  }
  forall item | item in t.active
    ensures (item.phase.NeedsFallback? ==> !(exists proc :: proc in t.processor.items && proc.id == item.ticket)) &&
      (item.phase.FallbackRunning? ==> (exists proc :: proc in t.processor.items && proc.id == item.ticket && proc.batch == t.batchId && proc.payload == item.payload))
  {
    if item.phase.NeedsFallback? {
      forall proc | proc in t.processor.items ensures proc.id != item.ticket {
        var i :| 0 <= i < |t.processor.items| && t.processor.items[i] == proc;
        assert s.processor.items[i] in s.processor.items;
      }
    }
    if item.phase.FallbackRunning? {
      var priorItem :| priorItem in s.processor.items && priorItem.id == item.ticket && priorItem.batch == s.batchId && priorItem.payload == item.payload;
      var i :| 0 <= i < |s.processor.items| && s.processor.items[i] == priorItem;
      assert t.processor.items[i] in t.processor.items;
    }
  }
}

lemma BatchFallbackStartedOwnership(s: BatchQueue,ticket: int,perItemAttempts: int)
  requires inv(s) && canStartFallback(s,ticket,perItemAttempts)
  ensures alwaysBatchTicketOwnership(startFallback(s,ticket,perItemAttempts)) && alwaysFallbackInvocationOwnership(startFallback(s,ticket,perItemAttempts))
{
  var t := startFallback(s,ticket,perItemAttempts);
  var selected :| selected in s.active && selected.ticket == ticket && selected.phase.NeedsFallback?;
  BatchActiveSelection(s,selected); BatchActiveIdentityView(s);
  var found := ProofLib.Filter((j: BatchItem) => j.ticket == ticket,s.active);
  ProofLib.FilterMember((j: BatchItem) => j.ticket == ticket,s.active,selected);
  assert |found| == 1 && found[0] == selected;
  BatchFallbackSelection(s,ticket,perItemAttempts);
  assert |t.processor.items| == |s.processor.items|+1;
  var appended := t.processor.items[|s.processor.items|];
  assert appended.id == ticket && appended.batch == s.batchId && appended.payload == selected.payload;
  assert t.processor.items == s.processor.items + [appended];
  BatchTicketOwnershipView(s); BatchTicketOwnershipView(t);
  forall item | item in t.processor.items ensures item.id < t.queue.nextTicket {
    if item in s.processor.items { } else { assert item == appended; }
  }
  forall item | item in t.flush ensures !(exists proc :: proc in t.processor.items && proc.id == item.ticket) {
    assert item.ticket != ticket;
    forall proc | proc in t.processor.items ensures proc.id != item.ticket {
      if proc in s.processor.items { } else { assert proc == appended; }
    }
  }
  forall item | item in core__priorityQueue_queuedItems(t.queue)
    ensures !(exists other :: other in t.active + t.flush && other.ticket == item.ticket) &&
      !(exists proc :: proc in t.processor.items && proc.id == item.ticket)
  {
    assert item.ticket != ticket;
    forall other | other in t.active ensures other.ticket != item.ticket {
      var i :| 0 <= i < |t.active| && t.active[i] == other;
      assert s.active[i] in s.active && s.active[i].ticket == other.ticket;
    }
    forall proc | proc in t.processor.items ensures proc.id != item.ticket {
      if proc in s.processor.items { } else { assert proc == appended; }
    }
  }
  forall item | item in t.active
    ensures (item.phase.NeedsFallback? ==> !(exists proc :: proc in t.processor.items && proc.id == item.ticket)) &&
      (item.phase.FallbackRunning? ==> (exists proc :: proc in t.processor.items && proc.id == item.ticket && proc.batch == t.batchId && proc.payload == item.payload))
  {
    var i :| 0 <= i < |t.active| && t.active[i] == item;
    assert s.active[i] in s.active;
    if item.ticket == ticket {
      assert s.active[i] == selected;
      assert appended in t.processor.items;
    } else {
      assert item == s.active[i];
      if item.phase.NeedsFallback? {
        forall proc | proc in t.processor.items ensures proc.id != item.ticket {
          if proc in s.processor.items { } else { assert proc == appended; }
        }
      }
      if item.phase.FallbackRunning? {
        var priorItem :| priorItem in s.processor.items && priorItem.id == item.ticket && priorItem.batch == s.batchId && priorItem.payload == item.payload;
        assert priorItem in t.processor.items;
      }
    }
  }
}

lemma BatchQDrainTicketsView(s: core__priorityQueue_PriorityState, tickets: seq<int>)
  ensures core__priorityQueue_drainTickets(s, tickets) == s.(high := ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), s.high), normal := ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), s.normal), low := ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), s.low), lastRemoved := ProofLib.Filter((j: core__priorityQueue_QueueItem) => (j.ticket in tickets), core__priorityQueue_queuedItems(s)))
{
}


lemma BatchAddFlushTicketView(a: seq<int>,ticket: int)
  ensures addFlushTicket(a,ticket) == a + ProofLib.Filter((set_x: int) => !((set_x in a)),[ticket])
{}

lemma BatchHighIdStep(a: seq<int>,ticket: int)
  ensures addFlushTicket(a,ticket) == (if ticket in a then a else a + [ticket])
{
  BatchAddFlushTicketView(a,ticket);
  ProofLib.FilterCons((set_x: int) => !((set_x in a)),[ticket]);
  ProofLib.FilterNil((set_x: int) => !((set_x in a)),[]);
}

lemma BatchHighIdMembers(xs: seq<core__priorityQueue_QueueItem>,init: seq<int>)
  ensures forall item :: item in xs ==> item.ticket in Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),init,xs)
  decreases |xs|
{
  if |xs| > 0 {
    var prefix := xs[..|xs|-1];
    var last := xs[|xs|-1];
    assert xs == prefix + [last];
    BatchHighIdMembers(prefix,init);
    ProofLib.FoldLeftAppend((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),init,prefix,last);
    BatchHighIdStep(Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),init,prefix),last.ticket);
    var before := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),init,prefix);
    forall item | item in xs ensures item.ticket in Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),init,xs) {
      if item in prefix { assert item.ticket in before; }
      else { assert item == last; }
    }
  }
}

lemma BatchDisposalTicketOwnership(s: BatchQueue,flushHigh: bool)
  requires inv(s) && canBeginDispose(s,flushHigh)
  ensures alwaysBatchTicketOwnership(beginDispose(s,flushHigh))
{
  var high := if flushHigh then s.queue.high else [];
  var ids := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket),[],high);
  var t := beginDispose(s,flushHigh);
  BatchTicketOwnershipView(s); BatchTicketOwnershipView(t);
  BatchQQueueTicketsDistinct(s.queue);
  BatchQDrainTicketsView(s.queue,ids);
  BatchHighIdMembers(high,[]);
  var xs := core__priorityQueue_queuedItems(s.queue);
  assert high == [] || high == s.queue.high;
  forall item | item in high
    ensures |ProofLib.Filter((other: core__priorityQueue_QueueItem) => other.ticket == item.ticket,high)| == 1
  {
    var i :| 0 <= i < |high| && high[i] == item;
    forall k | 0 <= k < |high| && k != i ensures high[k].ticket != item.ticket {
      assert xs[k] == high[k] && xs[i] == item;
    }
    ProofLib.FilterOne((other: core__priorityQueue_QueueItem) => other.ticket == item.ticket,high,i);
  }
  BatchMappedQueueIdentities(high,t.flush);
  forall item | item in t.flush
    ensures item.ticket > 0 && item.ticket < t.queue.nextTicket && item.ticket in ids &&
      !(exists proc :: proc in t.processor.items && proc.id == item.ticket)
  {
    var i :| 0 <= i < |t.flush| && t.flush[i] == item;
    assert high[i] in xs && high[i].ticket == item.ticket;
  }
  forall item | item in t.active ensures !(exists other :: other in t.flush && other.ticket == item.ticket) {
    forall other | other in t.flush ensures other.ticket != item.ticket {
      var i :| 0 <= i < |t.flush| && t.flush[i] == other;
      assert high[i] in xs && high[i].ticket == other.ticket;
    }
  }
  forall item | item in core__priorityQueue_queuedItems(t.queue)
    ensures item in xs && !(item.ticket in ids) &&
      !(exists other :: other in t.active + t.flush && other.ticket == item.ticket) &&
      !(exists proc :: proc in t.processor.items && proc.id == item.ticket)
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in ids)),s.queue.high,item);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in ids)),s.queue.normal,item);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in ids)),s.queue.low,item);
  }
}

lemma configureBatchQueue_ensures(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int)
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysActiveSliceBounded(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysBatchItemIdentityUnique(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysBatchComponentsWellFormed(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysBatchConstructionAndPhases(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysFallbackKeepsSuccessfulItems(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysFallbackConcurrency(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysBatchTicketOwnership(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysFallbackInvocationOwnership(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysCompletedDisposalClearsQueue(configureBatchQueue(s, batchSize, maxParallel, attempts)))
  ensures (inv(s) ==> canConfigureBatchQueue(s, batchSize, maxParallel, attempts) ==> alwaysDisposedQueueRejectsEnqueue(configureBatchQueue(s, batchSize, maxParallel, attempts)))
{
  if inv(s) && canConfigureBatchQueue(s,batchSize,maxParallel,attempts) {
    BatchComponents(s);
    assert s == initial;
    core__priorityQueue_configureQueue_ensures(s.queue,0,false,false);
    core__batchProcessor_configureProcessor_ensures(s.processor,maxParallel,attempts,1,false);
  }
}

lemma enqueueBatchItem_ensures(s: BatchQueue, payload: string, priority: core__priorityQueue_QueuePriority)
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysActiveSliceBounded(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchItemIdentityUnique(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchComponentsWellFormed(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchConstructionAndPhases(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackKeepsSuccessfulItems(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackConcurrency(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchTicketOwnership(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackInvocationOwnership(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysCompletedDisposalClearsQueue(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysDisposedQueueRejectsEnqueue(enqueueBatchItem(s, payload, priority)))
{
  if inv(s) && canEnqueueBatchItem(s,payload,priority) {
    BatchComponents(s);
    core__priorityQueue_enqueue_ensures(s.queue,payload,priority);
  }
}

lemma startSchedule_ensures(s: BatchQueue)
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysActiveSliceBounded(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysBatchItemIdentityUnique(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysBatchComponentsWellFormed(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysBatchConstructionAndPhases(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysFallbackKeepsSuccessfulItems(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysFallbackConcurrency(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysBatchTicketOwnership(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysFallbackInvocationOwnership(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysCompletedDisposalClearsQueue(startSchedule(s)))
  ensures (inv(s) ==> canStartSchedule(s) ==> alwaysDisposedQueueRejectsEnqueue(startSchedule(s)))
{
  if inv(s) && canStartSchedule(s) {
    BatchComponents(s);

  }
}

lemma finishSchedule_ensures(s: BatchQueue, ok: bool)
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysActiveSliceBounded(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysBatchItemIdentityUnique(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysBatchComponentsWellFormed(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysBatchConstructionAndPhases(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysFallbackKeepsSuccessfulItems(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysFallbackConcurrency(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysBatchTicketOwnership(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysFallbackInvocationOwnership(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysCompletedDisposalClearsQueue(finishSchedule(s, ok)))
  ensures (inv(s) ==> canFinishSchedule(s, ok) ==> alwaysDisposedQueueRejectsEnqueue(finishSchedule(s, ok)))
{
  if inv(s) && canFinishSchedule(s,ok) {
    BatchComponents(s);

  }
}

lemma beginDrain_ensures(s: BatchQueue)
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysActiveSliceBounded(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysBatchItemIdentityUnique(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysBatchComponentsWellFormed(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysBatchConstructionAndPhases(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysFallbackKeepsSuccessfulItems(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysFallbackConcurrency(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysBatchTicketOwnership(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysFallbackInvocationOwnership(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysCompletedDisposalClearsQueue(beginDrain(s)))
  ensures (inv(s) ==> canBeginDrain(s) ==> alwaysDisposedQueueRejectsEnqueue(beginDrain(s)))
{
  if inv(s) && canBeginDrain(s) {
    BatchComponents(s);

  }
}

lemma finishCapabilityProbe_ensures(s: BatchQueue, ok: bool, useBatch: bool)
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysActiveSliceBounded(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchItemIdentityUnique(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchComponentsWellFormed(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchConstructionAndPhases(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackKeepsSuccessfulItems(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackConcurrency(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchTicketOwnership(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackInvocationOwnership(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysCompletedDisposalClearsQueue(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysDisposedQueueRejectsEnqueue(finishCapabilityProbe(s, ok, useBatch)))
{
  if inv(s) && canFinishCapabilityProbe(s,ok,useBatch) {
    BatchComponents(s);
    if ok {
      core__priorityQueue_dequeue_ensures(s.queue,s.batchSize);
      core__priorityQueue_lawDequeueReceipt_ensures(s.queue,s.batchSize);
      BatchQDequeueReceiptView(s.queue,s.batchSize);
      BatchQDequeueSeparation(s.queue,s.batchSize);
      var t := finishCapabilityProbe(s,ok,useBatch);
      var removed := core__priorityQueue_dequeue(s.queue,s.batchSize).lastRemoved;
      BatchMappedQueueIdentities(removed,t.active);
      BatchActiveIdentityView(t);
    }
  }
}

lemma finishFallbackExhaustion_ensures(s: BatchQueue, ticket: int, callbackOk: bool)
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysActiveSliceBounded(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchItemIdentityUnique(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchComponentsWellFormed(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchConstructionAndPhases(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackConcurrency(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchTicketOwnership(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackInvocationOwnership(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysCompletedDisposalClearsQueue(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackExhaustion(s, ticket, callbackOk)))
{
  if inv(s) && canFinishFallbackExhaustion(s,ticket,callbackOk) {
    BatchComponents(s);
    core__batchProcessor_finishExhaustion_ensures(s.processor,ticket,callbackOk);
    BatchProcessorKeepsOwnership(s,finishFallbackExhaustion(s,ticket,callbackOk));
  }
}

lemma collectFallback_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysActiveSliceBounded(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchItemIdentityUnique(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchComponentsWellFormed(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchConstructionAndPhases(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackConcurrency(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchTicketOwnership(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackInvocationOwnership(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysCompletedDisposalClearsQueue(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(collectFallback(s, ticket)))
{
  if inv(s) && canCollectFallback(s,ticket) {
    BatchComponents(s);
    BatchActiveIdentityMap(s,collectFallback(s,ticket));
    var t := collectFallback(s,ticket);
    var selected :| selected in s.active && selected.ticket == ticket && selected.phase.FallbackRunning?;
    BatchActiveSelection(s,selected);
    var proc :| proc in s.processor.items && proc.id == ticket && (proc.phase.ItemSucceeded? || proc.phase.ItemFailed?);
    BatchProcessorSelection(s.processor,proc);
    forall item | item in t.active && item.phase.BatchItemSucceeded?
      ensures !(exists other :: other in t.processor.items && other.id == item.ticket && !other.phase.ItemSucceeded?)
    {
      var i :| 0 <= i < |t.active| && t.active[i] == item;
      assert s.active[i] in s.active;
      if item.ticket == ticket {
        assert s.active[i] == selected;
        var success :| success in s.processor.items && success.id == ticket && success.phase.ItemSucceeded?;
        assert success == proc;
        forall other | other in t.processor.items && other.id == item.ticket ensures other.phase.ItemSucceeded? {
          assert other == proc;
        }
      } else { assert t.active[i] == s.active[i]; }
    }


  }
}

lemma finishBatchWork_ensures(s: BatchQueue)
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysActiveSliceBounded(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysBatchItemIdentityUnique(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysBatchComponentsWellFormed(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysBatchConstructionAndPhases(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysFallbackKeepsSuccessfulItems(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysFallbackConcurrency(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysBatchTicketOwnership(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysFallbackInvocationOwnership(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysCompletedDisposalClearsQueue(finishBatchWork(s)))
  ensures (inv(s) ==> canFinishBatchWork(s) ==> alwaysDisposedQueueRejectsEnqueue(finishBatchWork(s)))
{
  if inv(s) && canFinishBatchWork(s) {
    BatchComponents(s);

  }
}

lemma observeDrain_ensures(s: BatchQueue, observersOk: bool)
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysActiveSliceBounded(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysBatchItemIdentityUnique(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysBatchComponentsWellFormed(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysBatchConstructionAndPhases(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysFallbackKeepsSuccessfulItems(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysFallbackConcurrency(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysBatchTicketOwnership(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysFallbackInvocationOwnership(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysCompletedDisposalClearsQueue(observeDrain(s, observersOk)))
  ensures (inv(s) ==> canObserveDrain(s, observersOk) ==> alwaysDisposedQueueRejectsEnqueue(observeDrain(s, observersOk)))
{
  if inv(s) && canObserveDrain(s,observersOk) {
    BatchComponents(s);

  }
}

lemma settleBatchedCall_ensures(s: BatchQueue, successful: seq<int>, retryable: seq<int>, threw: bool)
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysActiveSliceBounded(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchItemIdentityUnique(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchComponentsWellFormed(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchConstructionAndPhases(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackKeepsSuccessfulItems(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackConcurrency(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchTicketOwnership(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackInvocationOwnership(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysCompletedDisposalClearsQueue(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysDisposedQueueRejectsEnqueue(settleBatchedCall(s, successful, retryable, threw)))
{
  if inv(s) && canSettleBatchedCall(s,successful,retryable,threw) {
    BatchComponents(s);
    BatchActiveIdentityMap(s,settleBatchedCall(s,successful,retryable,threw));

  }
}

lemma startFallbackAttempt_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysActiveSliceBounded(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchItemIdentityUnique(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchComponentsWellFormed(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchConstructionAndPhases(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackConcurrency(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchTicketOwnership(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackInvocationOwnership(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysCompletedDisposalClearsQueue(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(startFallbackAttempt(s, ticket)))
{
  if inv(s) && canStartFallbackAttempt(s,ticket) {
    BatchComponents(s);
    core__batchProcessor_startItem_ensures(s.processor,ticket);
    BatchProcessorKeepsOwnership(s,startFallbackAttempt(s,ticket));
  }
}

lemma finishFallbackAttempt_ensures(s: BatchQueue, ticket: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysActiveSliceBounded(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchItemIdentityUnique(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchComponentsWellFormed(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchConstructionAndPhases(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackConcurrency(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchTicketOwnership(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackInvocationOwnership(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysCompletedDisposalClearsQueue(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackAttempt(s, ticket, ok, retry)))
{
  if inv(s) && canFinishFallbackAttempt(s,ticket,ok,retry) {
    BatchComponents(s);
    core__batchProcessor_finishItemAttempt_ensures(s.processor,ticket,ok,retry);
    BatchProcessorKeepsOwnership(s,finishFallbackAttempt(s,ticket,ok,retry));
  }
}

lemma finishFallbackBackoff_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysActiveSliceBounded(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchItemIdentityUnique(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchComponentsWellFormed(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchConstructionAndPhases(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackConcurrency(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchTicketOwnership(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackInvocationOwnership(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysCompletedDisposalClearsQueue(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackBackoff(s, ticket)))
{
  if inv(s) && canFinishFallbackBackoff(s,ticket) {
    BatchComponents(s);
    core__batchProcessor_finishBackoff_ensures(s.processor,ticket);
    BatchProcessorKeepsOwnership(s,finishFallbackBackoff(s,ticket));
  }
}

lemma startFallback_ensures(s: BatchQueue, ticket: int, perItemAttempts: int)
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysActiveSliceBounded(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchItemIdentityUnique(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchComponentsWellFormed(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchConstructionAndPhases(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackKeepsSuccessfulItems(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackConcurrency(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchTicketOwnership(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackInvocationOwnership(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysCompletedDisposalClearsQueue(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysDisposedQueueRejectsEnqueue(startFallback(s, ticket, perItemAttempts)))
{
  if inv(s) && canStartFallback(s,ticket,perItemAttempts) {
    BatchComponents(s);
    BatchActiveIdentityMap(s,startFallback(s,ticket,perItemAttempts));
    BatchFallbackSelection(s,ticket,perItemAttempts);
    var found := ProofLib.Filter((j: BatchItem) => j.ticket == ticket,s.active);
    var payload := (if |found| > 0 then found[0] else emptyBatchItem).payload;
    core__batchProcessor_submitItem_ensures(s.processor,ticket,s.batchId,payload,perItemAttempts);
    BatchFallbackStartedOwnership(s,ticket,perItemAttempts);
  }
}

lemma beginDispose_ensures(s: BatchQueue, flushHigh: bool)
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysActiveSliceBounded(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchItemIdentityUnique(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchComponentsWellFormed(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchConstructionAndPhases(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackKeepsSuccessfulItems(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackConcurrency(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchTicketOwnership(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackInvocationOwnership(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysCompletedDisposalClearsQueue(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysDisposedQueueRejectsEnqueue(beginDispose(s, flushHigh)))
{
  if inv(s) && canBeginDispose(s,flushHigh) {
    BatchComponents(s);
    var high := if flushHigh then s.queue.high else [];
    var ids := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => addFlushTicket(tickets,j.ticket), [], high);
    core__priorityQueue_drainTickets_ensures(s.queue,ids);
    BatchDisposalTicketOwnership(s,flushHigh);
  }
}

lemma finishUrgentFlush_ensures(s: BatchQueue)
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysActiveSliceBounded(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysBatchItemIdentityUnique(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysBatchComponentsWellFormed(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysBatchConstructionAndPhases(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysFallbackKeepsSuccessfulItems(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysFallbackConcurrency(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysBatchTicketOwnership(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysFallbackInvocationOwnership(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysCompletedDisposalClearsQueue(finishUrgentFlush(s)))
  ensures (inv(s) ==> canFinishUrgentFlush(s) ==> alwaysDisposedQueueRejectsEnqueue(finishUrgentFlush(s)))
{
  if inv(s) && canFinishUrgentFlush(s) {
    BatchComponents(s);

  }
}

lemma observeUrgentFlush_ensures(s: BatchQueue, ok: bool)
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysActiveSliceBounded(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysBatchItemIdentityUnique(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysBatchComponentsWellFormed(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysBatchConstructionAndPhases(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysFallbackKeepsSuccessfulItems(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysFallbackConcurrency(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysBatchTicketOwnership(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysFallbackInvocationOwnership(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysCompletedDisposalClearsQueue(observeUrgentFlush(s, ok)))
  ensures (inv(s) ==> canObserveUrgentFlush(s, ok) ==> alwaysDisposedQueueRejectsEnqueue(observeUrgentFlush(s, ok)))
{
  if inv(s) && canObserveUrgentFlush(s,ok) {
    BatchComponents(s);

  }
}

lemma retryDisposal_ensures(s: BatchQueue)
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysActiveSliceBounded(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysBatchItemIdentityUnique(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysBatchComponentsWellFormed(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysBatchConstructionAndPhases(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysFallbackKeepsSuccessfulItems(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysFallbackConcurrency(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysBatchTicketOwnership(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysFallbackInvocationOwnership(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysCompletedDisposalClearsQueue(retryDisposal(s)))
  ensures (inv(s) ==> canRetryDisposal(s) ==> alwaysDisposedQueueRejectsEnqueue(retryDisposal(s)))
{
  if inv(s) && canRetryDisposal(s) {
    BatchComponents(s);

  }
}

lemma finishTaskRemoval_ensures(s: BatchQueue, ok: bool)
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysActiveSliceBounded(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysBatchItemIdentityUnique(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysBatchComponentsWellFormed(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysBatchConstructionAndPhases(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysFallbackKeepsSuccessfulItems(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysFallbackConcurrency(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysBatchTicketOwnership(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysFallbackInvocationOwnership(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysCompletedDisposalClearsQueue(finishTaskRemoval(s, ok)))
  ensures (inv(s) ==> canFinishTaskRemoval(s, ok) ==> alwaysDisposedQueueRejectsEnqueue(finishTaskRemoval(s, ok)))
{
  if inv(s) && canFinishTaskRemoval(s,ok) {
    BatchComponents(s);
    if ok { core__priorityQueue_clearQueue_ensures(s.queue); }
  }
}

lemma flushUrgentItem_ensures(s: BatchQueue, ok: bool)
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysActiveSliceBounded(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysBatchItemIdentityUnique(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysBatchComponentsWellFormed(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysBatchConstructionAndPhases(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysFallbackKeepsSuccessfulItems(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysFallbackConcurrency(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysBatchTicketOwnership(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysFallbackInvocationOwnership(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysCompletedDisposalClearsQueue(flushUrgentItem(s, ok)))
  ensures (inv(s) ==> canFlushUrgentItem(s, ok) ==> alwaysDisposedQueueRejectsEnqueue(flushUrgentItem(s, ok)))
{
  if inv(s) && canFlushUrgentItem(s,ok) {
    BatchComponents(s);
    BatchFlushIdentityMap(s,flushUrgentItem(s,ok));

  }
}
