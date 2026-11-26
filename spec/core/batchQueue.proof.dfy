lemma BatchIdentity(s: BatchQueue)
  ensures alwaysBatchItemIdentityUnique(s) == (forall j :: j in s.active ==> |ProofLib.Filter((other: BatchItem) => (other.ticket == j.ticket), s.active)| == 1)
{}

lemma BatchQueueTickets(q: core__priorityQueue_PriorityState)
  ensures core__priorityQueue_alwaysQueueTicketsUnique(q) == (forall j :: j in core__priorityQueue_queuedItems(q) ==> j.ticket > 0 && j.ticket < q.nextTicket && |ProofLib.Filter((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), core__priorityQueue_queuedItems(q))| == 1)
{}

lemma BatchProcessorIds(p: core__batchProcessor_Processor)
  ensures core__batchProcessor_alwaysItemIdsUnique(p) == (forall j :: j in p.items ==> |ProofLib.Filter((other: core__batchProcessor_ProcessorItem) => (other.id == j.id), p.items)| == 1)
{}

lemma BatchSameTickets(s: BatchQueue, u: BatchQueue)
  requires alwaysBatchItemIdentityUnique(s)
  requires |u.active| == |s.active| && forall i :: 0 <= i < |s.active| ==> u.active[i].ticket == s.active[i].ticket
  ensures alwaysBatchItemIdentityUnique(u)
{
  BatchIdentity(s); BatchIdentity(u);
  forall j | j in u.active ensures |ProofLib.Filter((other: BatchItem) => (other.ticket == j.ticket), u.active)| == 1 {
    var i :| 0 <= i < |u.active| && u.active[i] == j;
    var k := s.active[i];
    assert k in s.active;
    ProofLib.FilterSamePredicate((other: BatchItem) => (other.ticket == j.ticket), (other: BatchItem) => (other.ticket == k.ticket), s.active);
    ProofLib.FilterLengthPointwise((other: BatchItem) => (other.ticket == j.ticket), (other: BatchItem) => (other.ticket == j.ticket), s.active, u.active);
  }
}

lemma BatchSameProcessorItem(p: core__batchProcessor_Processor, a: core__batchProcessor_ProcessorItem, b: core__batchProcessor_ProcessorItem)
  requires core__batchProcessor_alwaysItemIdsUnique(p)
  requires a in p.items && b in p.items && a.id == b.id
  ensures a == b
{
  BatchProcessorIds(p);
  ProofLib.FilterMember((other: core__batchProcessor_ProcessorItem) => (other.id == a.id), p.items, a);
  ProofLib.FilterMember((other: core__batchProcessor_ProcessorItem) => (other.id == a.id), p.items, b);
}

lemma BatchFilterConcat<T>(p: T -> bool, a: seq<T>, b: seq<T>)
  ensures |ProofLib.Filter(p, a + b)| == |ProofLib.Filter(p, a)| + |ProofLib.Filter(p, b)|
  decreases |a|
{
  if |a| == 0 {
    assert a + b == b;
    ProofLib.FilterNil(p, a);
  } else {
    assert (a + b)[1..] == a[1..] + b;
    ProofLib.FilterCons(p, a + b);
    ProofLib.FilterCons(p, a);
    BatchFilterConcat(p, a[1..], b);
  }
}

lemma BatchSplitFold(count: int, a: core__priorityQueue_ItemSplit, xs: seq<core__priorityQueue_QueueItem>)
  requires count >= 0 && |a.taken| <= a.position && |a.taken| <= count
  requires |a.kept| > 0 ==> a.position >= count
  ensures Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), a, xs).taken + Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), a, xs).kept == a.taken + a.kept + xs
  ensures |Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), a, xs).taken| <= count
  decreases |xs|
{
  if |xs| == 0 {
    assert a.taken + a.kept + xs == a.taken + a.kept;
  } else {
    var next := core__priorityQueue_splitItem(count, a, xs[0]);
    assert Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), a, xs) == Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(count, acc, job), next, xs[1..]);
    BatchSplitFold(count, next, xs[1..]);
    assert next.taken + next.kept + xs[1..] == a.taken + a.kept + xs;
  }
}

lemma BatchDequeue(q: core__priorityQueue_PriorityState, count: int)
  requires count >= 1
  ensures core__priorityQueue_dequeue(q, count).lastRemoved + core__priorityQueue_splitQueue(q, count).kept == core__priorityQueue_queuedItems(q)
  ensures |core__priorityQueue_dequeue(q, count).lastRemoved| <= count
  ensures core__priorityQueue_dequeue(q, count).nextTicket == q.nextTicket
  ensures forall x :: x in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(q, count)) ==> x in core__priorityQueue_splitQueue(q, count).kept
{
  BatchSplitFold(count, core__priorityQueue_emptyItemSplit, core__priorityQueue_queuedItems(q));
  var kept := core__priorityQueue_splitQueue(q, count).kept;
  var after := core__priorityQueue_dequeue(q, count);
  assert after.high == ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.High?, kept);
  assert after.normal == ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.Normal?, kept);
  assert after.low == ProofLib.Filter((j: core__priorityQueue_QueueItem) => j.priority.Low?, kept);
  forall x | x in core__priorityQueue_queuedItems(after) ensures x in kept {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.High?, kept, x);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Normal?, kept, x);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Low?, kept, x);
  }
}

lemma BatchDrain(q: core__priorityQueue_PriorityState, tickets: seq<int>)
  ensures core__priorityQueue_drainTickets(q, tickets).nextTicket == q.nextTicket
  ensures forall x :: x in core__priorityQueue_queuedItems(core__priorityQueue_drainTickets(q, tickets)) ==> x in core__priorityQueue_queuedItems(q)
{
  var after := core__priorityQueue_drainTickets(q, tickets);
  assert after.high == ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.high);
  assert after.normal == ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.normal);
  assert after.low == ProofLib.Filter((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.low);
  forall x | x in core__priorityQueue_queuedItems(after) ensures x in core__priorityQueue_queuedItems(q) {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.high, x);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.normal, x);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !((j.ticket in tickets)), q.low, x);
  }
}

lemma enqueueBatchItem_ensures(s: BatchQueue, payload: string, priority: core__priorityQueue_QueuePriority)
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysActiveSliceBounded(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchItemIdentityUnique(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysConfiguredTogether(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysQueueKeepsItsRules(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackKeepsSuccessfulItems(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackConcurrency(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysFallbackProcessorKeepsItsRules(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysRemovedTicketsLeftTheQueue(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysBatchedCallItemsAreUnsubmitted(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysDisposedQueueRejectsEnqueue(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysCompletedDisposalClearsQueue(enqueueBatchItem(s, payload, priority)))
  ensures (inv(s) ==> canEnqueueBatchItem(s, payload, priority) ==> alwaysDisposalKeepsTheQueueDisposed(enqueueBatchItem(s, payload, priority)))
{
  if inv(s) && canEnqueueBatchItem(s, payload, priority) {
    core__priorityQueue_enqueue_ensures(s.queue, payload, priority);
  }
}

lemma finishCapabilityProbe_ensures(s: BatchQueue, ok: bool, useBatch: bool)
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysActiveSliceBounded(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchItemIdentityUnique(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysConfiguredTogether(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysQueueKeepsItsRules(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackKeepsSuccessfulItems(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackConcurrency(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysFallbackProcessorKeepsItsRules(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysRemovedTicketsLeftTheQueue(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysBatchedCallItemsAreUnsubmitted(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysDisposedQueueRejectsEnqueue(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysCompletedDisposalClearsQueue(finishCapabilityProbe(s, ok, useBatch)))
  ensures (inv(s) ==> canFinishCapabilityProbe(s, ok, useBatch) ==> alwaysDisposalKeepsTheQueueDisposed(finishCapabilityProbe(s, ok, useBatch)))
{
  if inv(s) && canFinishCapabilityProbe(s, ok, useBatch) {
    if ok {
      var after := finishCapabilityProbe(s, ok, useBatch);
      var taken := after.queue.lastRemoved;
      var kept := core__priorityQueue_splitQueue(s.queue, s.batchSize).kept;
      var queued := core__priorityQueue_queuedItems(s.queue);
      core__priorityQueue_dequeue_ensures(s.queue, s.batchSize);
      BatchDequeue(s.queue, s.batchSize);
      BatchQueueTickets(s.queue);
      assert |after.active| == |taken|;
      forall i | 0 <= i < |taken| ensures taken[i] in queued && after.active[i].ticket == taken[i].ticket { assert queued[i] == taken[i]; }
      forall i | 0 <= i < |taken| ensures |ProofLib.Filter((other: core__priorityQueue_QueueItem) => (other.ticket == taken[i].ticket), taken)| == 1 && forall k :: k in kept ==> k.ticket != taken[i].ticket {
        var t := taken[i];
        BatchFilterConcat((other: core__priorityQueue_QueueItem) => (other.ticket == t.ticket), taken, kept);
        ProofLib.FilterMember((other: core__priorityQueue_QueueItem) => (other.ticket == t.ticket), taken, t);
        forall k | k in kept ensures k.ticket != t.ticket {
          ProofLib.FilterMember((other: core__priorityQueue_QueueItem) => (other.ticket == t.ticket), kept, k);
        }
      }
      BatchIdentity(after);
      forall j | j in after.active ensures |ProofLib.Filter((other: BatchItem) => (other.ticket == j.ticket), after.active)| == 1 {
        var i :| 0 <= i < |after.active| && after.active[i] == j;
        var t := taken[i];
        ProofLib.FilterSamePredicate((other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), (other: core__priorityQueue_QueueItem) => (other.ticket == t.ticket), taken);
        ProofLib.FilterLengthPointwise((other: BatchItem) => (other.ticket == j.ticket), (other: core__priorityQueue_QueueItem) => (other.ticket == j.ticket), after.active, taken);
      }
      forall j | j in after.active ensures j.ticket < after.queue.nextTicket && !(exists q :: q in core__priorityQueue_queuedItems(after.queue) && q.ticket == j.ticket) && !(exists p :: p in after.processor.items && p.id == j.ticket) {
        var i :| 0 <= i < |after.active| && after.active[i] == j;
      }
    }
  }
}

lemma collectFallback_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysActiveSliceBounded(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchItemIdentityUnique(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysConfiguredTogether(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysQueueKeepsItsRules(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackConcurrency(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysFallbackProcessorKeepsItsRules(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysRemovedTicketsLeftTheQueue(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysBatchedCallItemsAreUnsubmitted(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysCompletedDisposalClearsQueue(collectFallback(s, ticket)))
  ensures (inv(s) ==> canCollectFallback(s, ticket) ==> alwaysDisposalKeepsTheQueueDisposed(collectFallback(s, ticket)))
{
  if inv(s) && canCollectFallback(s, ticket) {
    var after := collectFallback(s, ticket);
    BatchSameTickets(s, after);
    forall j | j in after.active && j.phase.BatchItemSucceeded? ensures !(exists p :: p in after.processor.items && p.id == j.ticket && !p.phase.ItemSucceeded?) {
      var i :| 0 <= i < |after.active| && after.active[i] == j;
      assert s.active[i] in s.active;
      if j.ticket == ticket {
        var done :| done in s.processor.items && ((done.id == ticket) && done.phase.ItemSucceeded?);
        forall p | p in s.processor.items && p.id == ticket ensures p.phase.ItemSucceeded? { BatchSameProcessorItem(s.processor, p, done); }
      }
    }
  }
}

lemma settleBatchedCall_ensures(s: BatchQueue, successful: seq<int>, retryable: seq<int>, threw: bool)
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysActiveSliceBounded(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchItemIdentityUnique(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysConfiguredTogether(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysQueueKeepsItsRules(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackKeepsSuccessfulItems(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackConcurrency(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysFallbackProcessorKeepsItsRules(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysRemovedTicketsLeftTheQueue(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysBatchedCallItemsAreUnsubmitted(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysDisposedQueueRejectsEnqueue(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysCompletedDisposalClearsQueue(settleBatchedCall(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatchedCall(s, successful, retryable, threw) ==> alwaysDisposalKeepsTheQueueDisposed(settleBatchedCall(s, successful, retryable, threw)))
{
  if inv(s) && canSettleBatchedCall(s, successful, retryable, threw) {
    BatchSameTickets(s, settleBatchedCall(s, successful, retryable, threw));
  }
}

lemma startFallbackAttempt_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysActiveSliceBounded(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchItemIdentityUnique(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysConfiguredTogether(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysQueueKeepsItsRules(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackConcurrency(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysFallbackProcessorKeepsItsRules(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysRemovedTicketsLeftTheQueue(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysBatchedCallItemsAreUnsubmitted(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysCompletedDisposalClearsQueue(startFallbackAttempt(s, ticket)))
  ensures (inv(s) ==> canStartFallbackAttempt(s, ticket) ==> alwaysDisposalKeepsTheQueueDisposed(startFallbackAttempt(s, ticket)))
{
  if inv(s) && canStartFallbackAttempt(s, ticket) {
    core__batchProcessor_startItem_ensures(s.processor, ticket);
  }
}

lemma finishFallbackAttempt_ensures(s: BatchQueue, ticket: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysActiveSliceBounded(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchItemIdentityUnique(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysConfiguredTogether(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysQueueKeepsItsRules(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackConcurrency(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysFallbackProcessorKeepsItsRules(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysRemovedTicketsLeftTheQueue(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysBatchedCallItemsAreUnsubmitted(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysCompletedDisposalClearsQueue(finishFallbackAttempt(s, ticket, ok, retry)))
  ensures (inv(s) ==> canFinishFallbackAttempt(s, ticket, ok, retry) ==> alwaysDisposalKeepsTheQueueDisposed(finishFallbackAttempt(s, ticket, ok, retry)))
{
  if inv(s) && canFinishFallbackAttempt(s, ticket, ok, retry) {
    core__batchProcessor_finishItemAttempt_ensures(s.processor, ticket, ok, retry);
  }
}

lemma finishFallbackBackoff_ensures(s: BatchQueue, ticket: int)
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysActiveSliceBounded(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchItemIdentityUnique(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysConfiguredTogether(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysQueueKeepsItsRules(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackConcurrency(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysFallbackProcessorKeepsItsRules(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysRemovedTicketsLeftTheQueue(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysBatchedCallItemsAreUnsubmitted(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysCompletedDisposalClearsQueue(finishFallbackBackoff(s, ticket)))
  ensures (inv(s) ==> canFinishFallbackBackoff(s, ticket) ==> alwaysDisposalKeepsTheQueueDisposed(finishFallbackBackoff(s, ticket)))
{
  if inv(s) && canFinishFallbackBackoff(s, ticket) {
    core__batchProcessor_finishBackoff_ensures(s.processor, ticket);
  }
}

lemma finishFallbackExhaustion_ensures(s: BatchQueue, ticket: int, callbackOk: bool)
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysActiveSliceBounded(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchItemIdentityUnique(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysConfiguredTogether(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysQueueKeepsItsRules(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackKeepsSuccessfulItems(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackConcurrency(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysFallbackProcessorKeepsItsRules(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysRemovedTicketsLeftTheQueue(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysBatchedCallItemsAreUnsubmitted(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysDisposedQueueRejectsEnqueue(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysCompletedDisposalClearsQueue(finishFallbackExhaustion(s, ticket, callbackOk)))
  ensures (inv(s) ==> canFinishFallbackExhaustion(s, ticket, callbackOk) ==> alwaysDisposalKeepsTheQueueDisposed(finishFallbackExhaustion(s, ticket, callbackOk)))
{
  if inv(s) && canFinishFallbackExhaustion(s, ticket, callbackOk) {
    core__batchProcessor_finishExhaustion_ensures(s.processor, ticket, callbackOk);
  }
}

lemma startFallback_ensures(s: BatchQueue, ticket: int, perItemAttempts: int)
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysActiveSliceBounded(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchItemIdentityUnique(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysConfiguredTogether(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysQueueKeepsItsRules(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackKeepsSuccessfulItems(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackConcurrency(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysFallbackProcessorKeepsItsRules(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysRemovedTicketsLeftTheQueue(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysBatchedCallItemsAreUnsubmitted(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysDisposedQueueRejectsEnqueue(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysCompletedDisposalClearsQueue(startFallback(s, ticket, perItemAttempts)))
  ensures (inv(s) ==> canStartFallback(s, ticket, perItemAttempts) ==> alwaysDisposalKeepsTheQueueDisposed(startFallback(s, ticket, perItemAttempts)))
{
  if inv(s) && canStartFallback(s, ticket, perItemAttempts) {
    var after := startFallback(s, ticket, perItemAttempts);
    BatchSameTickets(s, after);
    var payload := after.processor.items[|s.processor.items|].payload;
    assert after.processor == core__batchProcessor_submitItem(s.processor, ticket, s.batchId, payload, perItemAttempts);
    core__batchProcessor_submitItem_ensures(s.processor, ticket, s.batchId, payload, perItemAttempts);
  }
}

lemma beginDispose_ensures(s: BatchQueue, flushHigh: bool)
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysActiveSliceBounded(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchItemIdentityUnique(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysConfiguredTogether(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysQueueKeepsItsRules(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackKeepsSuccessfulItems(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackConcurrency(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysFallbackProcessorKeepsItsRules(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysRemovedTicketsLeftTheQueue(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysBatchedCallItemsAreUnsubmitted(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysDisposedQueueRejectsEnqueue(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysCompletedDisposalClearsQueue(beginDispose(s, flushHigh)))
  ensures (inv(s) ==> canBeginDispose(s, flushHigh) ==> alwaysDisposalKeepsTheQueueDisposed(beginDispose(s, flushHigh)))
{
  if inv(s) && canBeginDispose(s, flushHigh) {
    var after := beginDispose(s, flushHigh);
    var high := (if flushHigh then s.queue.high else []);
    var tickets := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => (tickets + Std.Collections.Seq.Filter((set_x: int) => !((set_x in tickets)), [j.ticket])), [], high);
    assert after.queue == core__priorityQueue_drainTickets(s.queue, tickets);
    core__priorityQueue_drainTickets_ensures(s.queue, tickets);
    BatchDrain(s.queue, tickets);
  }
}
