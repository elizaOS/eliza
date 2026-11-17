lemma EmbeddingQueueOwner(s: EmbeddingService)
  requires inv(s)
  ensures core__batchQueue_inv(s.queue)
{}

lemma EmbeddingClearQueueOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q) && q.configured
  ensures core__batchQueue_wellFormed(q.(queue := core__priorityQueue_clearQueue(q.queue)))
{
  core__priorityQueue_clearQueue_ensures(q.queue);
}

lemma EmbeddingDropFlushOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q)
  ensures core__batchQueue_wellFormed(q.(flush := []))
{}

lemma EmbeddingBeginDrainOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canBeginDrain(q)
  ensures core__batchQueue_wellFormed(core__batchQueue_beginDrain(q))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_beginDrain_ensures(q);
}

lemma EmbeddingFinishCapabilityProbeOwner(q: core__batchQueue_BatchQueue, ok: bool, useBatch: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishCapabilityProbe(q,ok,useBatch)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishCapabilityProbe(q,ok,useBatch))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishCapabilityProbe_ensures(q,ok,useBatch);
}

lemma EmbeddingStartFallbackOwner(q: core__batchQueue_BatchQueue, ticket: int, perItemAttempts: int)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canStartFallback(q,ticket,perItemAttempts)
  ensures core__batchQueue_wellFormed(core__batchQueue_startFallback(q,ticket,perItemAttempts))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_startFallback_ensures(q,ticket,perItemAttempts);
}

lemma EmbeddingStartFallbackAttemptOwner(q: core__batchQueue_BatchQueue, ticket: int)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canStartFallbackAttempt(q,ticket)
  ensures core__batchQueue_wellFormed(core__batchQueue_startFallbackAttempt(q,ticket))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_startFallbackAttempt_ensures(q,ticket);
}

lemma EmbeddingFinishFallbackAttemptOwner(q: core__batchQueue_BatchQueue, ticket: int, ok: bool, retry: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishFallbackAttempt(q,ticket,ok,retry)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishFallbackAttempt(q,ticket,ok,retry))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishFallbackAttempt_ensures(q,ticket,ok,retry);
}

lemma EmbeddingFinishFallbackBackoffOwner(q: core__batchQueue_BatchQueue, ticket: int)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishFallbackBackoff(q,ticket)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishFallbackBackoff(q,ticket))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishFallbackBackoff_ensures(q,ticket);
}

lemma EmbeddingFinishFallbackExhaustionOwner(q: core__batchQueue_BatchQueue, ticket: int, callbackOk: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishFallbackExhaustion(q,ticket,callbackOk)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishFallbackExhaustion(q,ticket,callbackOk))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishFallbackExhaustion_ensures(q,ticket,callbackOk);
}

lemma EmbeddingCollectFallbackOwner(q: core__batchQueue_BatchQueue, ticket: int)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canCollectFallback(q,ticket)
  ensures core__batchQueue_wellFormed(core__batchQueue_collectFallback(q,ticket))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_collectFallback_ensures(q,ticket);
}

lemma EmbeddingFinishBatchWorkOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishBatchWork(q)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishBatchWork(q))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishBatchWork_ensures(q);
}

lemma EmbeddingObserveDrainOwner(q: core__batchQueue_BatchQueue, observersOk: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canObserveDrain(q,observersOk)
  ensures core__batchQueue_wellFormed(core__batchQueue_observeDrain(q,observersOk))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_observeDrain_ensures(q,observersOk);
}

lemma EmbeddingBeginDisposeOwner(q: core__batchQueue_BatchQueue, flushHigh: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canBeginDispose(q,flushHigh)
  ensures core__batchQueue_wellFormed(core__batchQueue_beginDispose(q,flushHigh))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_beginDispose_ensures(q,flushHigh);
}

lemma EmbeddingFlushUrgentItemOwner(q: core__batchQueue_BatchQueue, ok: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFlushUrgentItem(q,ok)
  ensures core__batchQueue_wellFormed(core__batchQueue_flushUrgentItem(q,ok))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_flushUrgentItem_ensures(q,ok);
}

lemma EmbeddingFinishUrgentFlushOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishUrgentFlush(q)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishUrgentFlush(q))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishUrgentFlush_ensures(q);
}

lemma EmbeddingObserveUrgentFlushOwner(q: core__batchQueue_BatchQueue, ok: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canObserveUrgentFlush(q,ok)
  ensures core__batchQueue_wellFormed(core__batchQueue_observeUrgentFlush(q,ok))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_observeUrgentFlush_ensures(q,ok);
}

lemma EmbeddingRetryDisposalOwner(q: core__batchQueue_BatchQueue)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canRetryDisposal(q)
  ensures core__batchQueue_wellFormed(core__batchQueue_retryDisposal(q))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_retryDisposal_ensures(q);
}

lemma EmbeddingFinishTaskRemovalOwner(q: core__batchQueue_BatchQueue, ok: bool)
  requires core__batchQueue_wellFormed(q) && core__batchQueue_canFinishTaskRemoval(q,ok)
  ensures core__batchQueue_wellFormed(core__batchQueue_finishTaskRemoval(q,ok))
{
  assert core__batchQueue_inv(q);
  core__batchQueue_finishTaskRemoval_ensures(q,ok);
}

lemma EmbeddingDrivenQueueOwner(s: EmbeddingService,queueEvent: QueueEvent,ticket: int,ok: bool,retry: bool)
  requires inv(s) && canDriveQueue(s,queueEvent,ticket,ok,retry)
  ensures core__batchQueue_wellFormed(driveQueue(s,queueEvent,ticket,ok,retry).queue)
{
  EmbeddingQueueOwner(s);
  if queueEvent.BeginDrain? { EmbeddingBeginDrainOwner(s.queue); }
  else if queueEvent.ProbeSingle? || queueEvent.ProbeBatch? || queueEvent.ProbeFailure? {
    EmbeddingFinishCapabilityProbeOwner(s.queue,!queueEvent.ProbeFailure?,queueEvent.ProbeBatch?);
  } else if queueEvent.StartFallback? { EmbeddingStartFallbackOwner(s.queue,ticket,0); }
  else if queueEvent.StartAttempt? { EmbeddingStartFallbackAttemptOwner(s.queue,ticket); }
  else if queueEvent.FinishAttempt? { EmbeddingFinishFallbackAttemptOwner(s.queue,ticket,ok,retry); }
  else if queueEvent.FinishBackoff? { EmbeddingFinishFallbackBackoffOwner(s.queue,ticket); }
  else if queueEvent.FinishExhaustion? { EmbeddingFinishFallbackExhaustionOwner(s.queue,ticket,ok); }
  else if queueEvent.CollectFallback? { EmbeddingCollectFallbackOwner(s.queue,ticket); }
  else if queueEvent.FinishWork? { EmbeddingFinishBatchWorkOwner(s.queue); }
  else if queueEvent.ObserveWork? { EmbeddingObserveDrainOwner(s.queue,ok); }
  else if queueEvent.BeginDisposal? { EmbeddingBeginDisposeOwner(s.queue,ok); }
  else if queueEvent.FlushUrgent? { EmbeddingFlushUrgentItemOwner(s.queue,ok); }
  else if queueEvent.FinishFlush? { EmbeddingFinishUrgentFlushOwner(s.queue); }
  else if queueEvent.ObserveFlush? {
    EmbeddingObserveUrgentFlushOwner(s.queue,ok);
    EmbeddingDropFlushOwner(core__batchQueue_observeUrgentFlush(s.queue,ok));
  } else if queueEvent.RetryDisposal? { EmbeddingRetryDisposalOwner(s.queue); }
  else { EmbeddingFinishTaskRemovalOwner(s.queue,ok); }
}

lemma EmbeddingKeysBridge(s: EmbeddingService)
  ensures alwaysPendingKeysAreExactAndUnique(s) <==>
    (forall source :: source in s.pendingKeys ==> (source.memoryId != "" &&
      |ProofLib.Filter((other: EmbeddingSource) => sameEmbeddingSource(other,source),s.pendingKeys)| == 1 &&
      (exists entry :: entry in s.items && sameEmbeddingSource(entry.source,source))))
{}

lemma EmbeddingKeysAppend(s: EmbeddingService,t: EmbeddingService,source: EmbeddingSource)
  requires alwaysPendingKeysAreExactAndUnique(s)
  requires !(exists key :: key in s.pendingKeys && sameEmbeddingSource(key,source)) && source.memoryId != ""
  requires t.pendingKeys == s.pendingKeys + [source]
  requires forall entry :: entry in s.items ==> entry in t.items
  requires exists entry :: entry in t.items && sameEmbeddingSource(entry.source,source)
  ensures alwaysPendingKeysAreExactAndUnique(t)
{
  EmbeddingKeysBridge(s); EmbeddingKeysBridge(t);
  forall key | key in t.pendingKeys ensures key.memoryId != "" &&
    |ProofLib.Filter((other: EmbeddingSource) => sameEmbeddingSource(other,key),t.pendingKeys)| == 1 &&
    (exists entry :: entry in t.items && sameEmbeddingSource(entry.source,key))
  {
    if key == source { ProofLib.FilterOne((other: EmbeddingSource) => sameEmbeddingSource(other,key),t.pendingKeys,|s.pendingKeys|); }
    else {
      assert key in s.pendingKeys;
      ProofLib.FilterAppend((other: EmbeddingSource) => sameEmbeddingSource(other,key),s.pendingKeys,source);
      var savedItem :| savedItem in s.items && sameEmbeddingSource(savedItem.source,key);
    }
  }
}

lemma EmbeddingKeysRetained(s: EmbeddingService,t: EmbeddingService)
  requires alwaysPendingKeysAreExactAndUnique(s) && t.pendingKeys == s.pendingKeys
  requires forall entry :: entry in s.items ==> entry in t.items
  ensures alwaysPendingKeysAreExactAndUnique(t)
{
  EmbeddingKeysBridge(s); EmbeddingKeysBridge(t);
  forall key | key in t.pendingKeys ensures exists entry :: entry in t.items && sameEmbeddingSource(entry.source,key) {
    var w :| w in s.items && sameEmbeddingSource(w.source,key);
  }
}

lemma EmbeddingKeepCaptured(s: EmbeddingService,t: EmbeddingService)
  requires alwaysQueueHasKnownSnapshots(s)
  requires t.queue.active == s.queue.active && t.queue.flush == s.queue.flush
  requires |core__priorityQueue_queuedItems(t.queue.queue)| == 0
  requires t.items == ProofLib.Filter((entry: EmbeddingItem) => (exists active :: active in s.queue.active+s.queue.flush && active.payload == entry.id),s.items)
  ensures alwaysQueueHasKnownSnapshots(t)
{
  forall q | q in t.queue.active+t.queue.flush ensures exists entry :: entry in t.items && entry.id == q.payload {
    var w :| w in s.items && w.id == q.payload;
    ProofLib.FilterMember((entry: EmbeddingItem) => (exists active :: active in s.queue.active+s.queue.flush && active.payload == entry.id),s.items,w);
  }
}

lemma EmbeddingKeepKeysAfterObservation(s: EmbeddingService,t: EmbeddingService,completed: seq<EmbeddingItem>)
  requires alwaysPendingKeysAreExactAndUnique(s)
  requires t.pendingKeys == ProofLib.Filter((source: EmbeddingSource) => !(exists entry :: entry in completed && sameEmbeddingSource(entry.source,source)),s.pendingKeys)
  requires t.items == retainAfterObservation(t.queue,completed,s.items)
  ensures alwaysPendingKeysAreExactAndUnique(t)
{
  EmbeddingKeysBridge(s); EmbeddingKeysBridge(t);
  var keep := (source: EmbeddingSource) => !(exists entry :: entry in completed && sameEmbeddingSource(entry.source,source));
  forall i,j | 0 <= i < |s.pendingKeys| && 0 <= j < |s.pendingKeys| && i != j
    ensures s.pendingKeys[i] != s.pendingKeys[j]
  {
    var source := s.pendingKeys[i];
    assert source in s.pendingKeys;
    ProofLib.FilterCountOneIffUnique((other: EmbeddingSource) => sameEmbeddingSource(other,source),s.pendingKeys,(other: EmbeddingSource) => other,i);
  }
  assert ProofLib.DistinctBy(s.pendingKeys,(source: EmbeddingSource) => source);
  ProofLib.FilterKeepsDistinctBy(keep,s.pendingKeys,(source: EmbeddingSource) => source);
  forall source | source in t.pendingKeys
    ensures source.memoryId != "" && |ProofLib.Filter((other: EmbeddingSource) => sameEmbeddingSource(other,source),t.pendingKeys)| == 1 &&
      (exists entry :: entry in t.items && sameEmbeddingSource(entry.source,source))
  {
    ProofLib.FilterMember(keep,s.pendingKeys,source);
    var i :| 0 <= i < |t.pendingKeys| && t.pendingKeys[i] == source;
    ProofLib.FilterOne((other: EmbeddingSource) => sameEmbeddingSource(other,source),t.pendingKeys,i);
    var row :| row in s.items && sameEmbeddingSource(row.source,source);
    assert !(exists done :: done in completed && done.id == row.id && sameEmbeddingSource(done.source,row.source));
    ProofLib.FilterMember((entry: EmbeddingItem) => !(exists done :: done in completed && (done.id == entry.id && sameEmbeddingSource(done.source,entry.source))) || queueReferences(t.queue,entry.id),s.items,row);
  }
}

lemma EmbeddingQueueRefsFromPrior(s: EmbeddingService,t: EmbeddingService)
  requires alwaysQueueHasKnownSnapshots(s)
  requires forall id :: queueReferences(t.queue,id) ==> queueReferences(s.queue,id)
  requires forall entry :: entry in s.items && queueReferences(t.queue,entry.id) ==> entry in t.items
  ensures alwaysQueueHasKnownSnapshots(t)
{
  forall row | row in core__priorityQueue_queuedItems(t.queue.queue)
    ensures exists entry :: entry in t.items && entry.id == row.payload
  {
    assert queueReferences(t.queue,row.payload) && queueReferences(s.queue,row.payload);
    var entry :| entry in s.items && entry.id == row.payload;
    assert entry in t.items;
  }
  forall row | row in t.queue.active + t.queue.flush
    ensures exists entry :: entry in t.items && entry.id == row.payload
  {
    assert queueReferences(t.queue,row.payload) && queueReferences(s.queue,row.payload);
    var entry :| entry in s.items && entry.id == row.payload;
    assert entry in t.items;
  }
}

lemma EmbeddingAfterObservation(s: EmbeddingService,t: EmbeddingService,completed: seq<EmbeddingItem>)
  requires inv(s)
  requires t.pendingKeys == ProofLib.Filter((source: EmbeddingSource) => !(exists entry :: entry in completed && sameEmbeddingSource(entry.source,source)),s.pendingKeys)
  requires t.items == retainAfterObservation(t.queue,completed,s.items)
  requires forall id :: queueReferences(t.queue,id) ==> queueReferences(s.queue,id)
  ensures alwaysPendingKeysAreExactAndUnique(t) && alwaysQueueHasKnownSnapshots(t)
{
  EmbeddingKeepKeysAfterObservation(s,t,completed);
  forall entry | entry in s.items && queueReferences(t.queue,entry.id)
    ensures entry in t.items
  {
    ProofLib.FilterMember((item: EmbeddingItem) => !(exists done :: done in completed && (done.id == item.id && sameEmbeddingSource(done.source,item.source))) || queueReferences(t.queue,item.id),s.items,entry);
  }
  EmbeddingQueueRefsFromPrior(s,t);
}

lemma EmbeddingQueueRefsChangePhase(
  before: core__batchQueue_BatchQueue, after: core__batchQueue_BatchQueue)
  requires after.queue == before.queue
  requires |after.active| == |before.active| && |after.flush| == |before.flush|
  requires forall i :: 0 <= i < |before.active| ==> before.active[i].payload == after.active[i].payload
  requires forall i :: 0 <= i < |before.flush| ==> before.flush[i].payload == after.flush[i].payload
  ensures forall id :: queueReferences(after,id) ==> queueReferences(before,id)
{
  forall id | queueReferences(after,id)
    ensures queueReferences(before,id)
  {
    if exists row :: row in after.active && row.payload == id {
      var i :| 0 <= i < |after.active| && after.active[i].payload == id;
      assert before.active[i] in before.active;
    } else if exists row :: row in after.flush && row.payload == id {
      var i :| 0 <= i < |after.flush| && after.flush[i].payload == id;
      assert before.flush[i] in before.flush;
    }
  }
}

lemma EmbeddingBeginDisposeRefs(q: core__batchQueue_BatchQueue, flushHigh: bool)
  ensures forall id :: queueReferences(core__batchQueue_beginDispose(q,flushHigh),id) ==> queueReferences(q,id)
{
  var after := core__batchQueue_beginDispose(q,flushHigh);
  var selected := if flushHigh then q.queue.high else [];
  forall id | queueReferences(after,id)
    ensures queueReferences(q,id)
  {
    if exists row :: row in after.flush && row.payload == id {
      var i :| 0 <= i < |after.flush| && after.flush[i].payload == id;
      assert selected[i] in q.queue.high && selected[i].payload == id;
    } else if !queueReferences(q,id) {
      var row :| row in core__priorityQueue_queuedItems(after.queue) && row.payload == id;
      var ids := Std.Collections.Seq.FoldLeft((tickets: seq<int>, j: core__priorityQueue_QueueItem) => core__batchQueue_addFlushTicket(tickets,j.ticket), [], selected);
      if row in after.queue.high {
        ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in ids),q.queue.high,row);
      } else if row in after.queue.normal {
        ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in ids),q.queue.normal,row);
      } else {
        ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in ids),q.queue.low,row);
      }
    }
  }
}

lemma EmbeddingSplit(xs: seq<core__priorityQueue_QueueItem>, base: core__priorityQueue_ItemSplit, limit: int)
  ensures forall job :: job in Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job), base, xs).taken ==> (job in xs || job in base.taken)
  ensures forall job :: job in Std.Collections.Seq.FoldLeft((acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job), base, xs).kept ==> (job in xs || job in base.kept)
  decreases |xs|
{
  reveal Std.Collections.Seq.FoldLeft();
  var apply := (acc: core__priorityQueue_ItemSplit, job: core__priorityQueue_QueueItem) => core__priorityQueue_splitItem(limit, acc, job);
  var combined := Std.Collections.Seq.FoldLeft(apply,base,xs);
  if |xs| == 0 {
    assert combined == base;
  } else {
    var first := xs[0];
    var tail := xs[1..];
    var refined := core__priorityQueue_splitItem(limit,base,first);
    assert combined == Std.Collections.Seq.FoldLeft(apply,refined,tail);
    EmbeddingSplit(tail,refined,limit);
    forall job | job in combined.taken
      ensures job in xs || job in base.taken
    {
      assert job in tail || job in refined.taken;
      if job in tail { assert job in xs; }
      else { assert refined.taken == base.taken || refined.taken == base.taken + [first]; }
    }
    forall job | job in combined.kept
      ensures job in xs || job in base.kept
    {
      assert job in tail || job in refined.kept;
      if job in tail { assert job in xs; }
      else { assert refined.kept == base.kept || refined.kept == base.kept + [first]; }
    }
  }
}

lemma EmbeddingDequeueSubset(s: core__priorityQueue_PriorityState, limit: int, tickets: seq<int>)
  ensures forall job :: job in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(s,limit)) ==> job in core__priorityQueue_queuedItems(s)
  ensures forall job :: job in core__priorityQueue_dequeue(s,limit).lastRemoved ==> job in core__priorityQueue_queuedItems(s)
  ensures forall job :: job in core__priorityQueue_queuedItems(core__priorityQueue_drainTickets(s,tickets)) ==> job in core__priorityQueue_queuedItems(s)
{
  EmbeddingSplit(core__priorityQueue_queuedItems(s),core__priorityQueue_emptyItemSplit,limit);
  var split := core__priorityQueue_splitQueue(s,limit);
  forall job | job in core__priorityQueue_queuedItems(core__priorityQueue_dequeue(s,limit))
    ensures job in core__priorityQueue_queuedItems(s)
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.High?,split.kept,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Normal?,split.kept,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => j.priority.Low?,split.kept,job);
  }
  forall job | job in core__priorityQueue_queuedItems(core__priorityQueue_drainTickets(s,tickets))
    ensures job in core__priorityQueue_queuedItems(s)
  {
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.high,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.normal,job);
    ProofLib.FilterMember((j: core__priorityQueue_QueueItem) => !(j.ticket in tickets),s.low,job);
  }
}

lemma EmbeddingProbeRefs(q: core__batchQueue_BatchQueue, ok: bool, useBatch: bool)
  ensures forall id :: queueReferences(core__batchQueue_finishCapabilityProbe(q,ok,useBatch),id) ==> queueReferences(q,id)
{
  if ok {
    EmbeddingDequeueSubset(q.queue,q.batchSize,[]);
    var updated := core__batchQueue_finishCapabilityProbe(q,ok,useBatch);
    var removed := updated.queue.lastRemoved;
    forall id | queueReferences(updated,id)
      ensures queueReferences(q,id)
    {
      if exists row :: row in updated.active && row.payload == id {
        var i :| 0 <= i < |updated.active| && updated.active[i].payload == id;
        assert removed[i] in removed && removed[i].payload == id;
      }
    }
  }
}

lemma EmbeddingAdmitQueueReference(s: EmbeddingService,t: EmbeddingService,item: EmbeddingItem)
  requires alwaysQueueHasKnownSnapshots(s)
  requires t.queue == core__batchQueue_enqueueBatchItem(s.queue,item.id,item.source.priority)
  requires t.items == s.items + [item]
  ensures alwaysQueueHasKnownSnapshots(t)
{
  forall q | q in core__priorityQueue_queuedItems(t.queue.queue)
    ensures exists entry :: entry in t.items && entry.id == q.payload
  {
    if q.payload != item.id {
      assert q in core__priorityQueue_queuedItems(s.queue.queue);
      var w :| w in s.items && w.id == q.payload;
      assert w in t.items;
    }
  }
  forall q | q in t.queue.active + t.queue.flush
    ensures exists entry :: entry in t.items && entry.id == q.payload
  {
    var w :| w in s.items && w.id == q.payload;
    assert w in t.items;
  }
}

lemma clearQueue_ensures(s: EmbeddingService)
  ensures (inv(s) ==> alwaysInitializationOwnsQueueStartup(clearQueue(s)))
  ensures (inv(s) ==> alwaysActivationHasIdentity(clearQueue(s)))
  ensures (inv(s) ==> alwaysQueueOwnerWellFormed(clearQueue(s)))
  ensures (inv(s) ==> alwaysPendingKeysAreExactAndUnique(clearQueue(s)))
  ensures (inv(s) ==> alwaysQueueHasKnownSnapshots(clearQueue(s)))
  ensures (inv(s) ==> alwaysDisposalDetachesQueuedSnapshots(clearQueue(s)))
  ensures (inv(s) ==> alwaysDisposalPhaseHasClosedAdmission(clearQueue(s)))
  ensures (inv(s) ==> alwaysStoppedHandlersAreDetached(clearQueue(s)))
{
  if inv(s) && s.queuePresent && !s.queue.disposed {
    EmbeddingQueueOwner(s);
    EmbeddingClearQueueOwner(s.queue);
    var t := clearQueue(s);
    EmbeddingKeepCaptured(s,t);
  }
}

lemma settleRequest_ensures(s: EmbeddingService)
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysInitializationOwnsQueueStartup(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysActivationHasIdentity(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysQueueOwnerWellFormed(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysPendingKeysAreExactAndUnique(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysQueueHasKnownSnapshots(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysDisposalDetachesQueuedSnapshots(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysDisposalPhaseHasClosedAdmission(settleRequest(s)))
  ensures (inv(s) ==> canSettleRequest(s) ==> alwaysStoppedHandlersAreDetached(settleRequest(s)))
{
  if inv(s) && canSettleRequest(s) {
    var t := settleRequest(s);
    if t.lastEnqueued {
      EmbeddingQueueOwner(s);
      var item := s.waiting[0];
      core__batchQueue_enqueueBatchItem_ensures(s.queue,item.id,item.source.priority);
      EmbeddingAdmitQueueReference(s,t,item);
      if item.source.memoryId != "" {
        EmbeddingKeysAppend(s,t,item.source);
      } else {
        EmbeddingKeysRetained(s,t);
      }
    }
  }
}

lemma driveQueue_ensures(s: EmbeddingService, queueEvent: QueueEvent, ticket: int, ok: bool, retry: bool)
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysInitializationOwnsQueueStartup(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysActivationHasIdentity(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysQueueOwnerWellFormed(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysPendingKeysAreExactAndUnique(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysQueueHasKnownSnapshots(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysDisposalDetachesQueuedSnapshots(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysDisposalPhaseHasClosedAdmission(driveQueue(s, queueEvent, ticket, ok, retry)))
  ensures (inv(s) ==> canDriveQueue(s, queueEvent, ticket, ok, retry) ==> alwaysStoppedHandlersAreDetached(driveQueue(s, queueEvent, ticket, ok, retry)))
{
  if inv(s) && canDriveQueue(s,queueEvent,ticket,ok,retry) {
    EmbeddingDrivenQueueOwner(s,queueEvent,ticket,ok,retry);
    var t := driveQueue(s,queueEvent,ticket,ok,retry);
    if queueEvent.ObserveWork? || queueEvent.ObserveFlush? {
      EmbeddingAfterObservation(s,t,completedEmbeddingItems(s,queueEvent.ObserveFlush?));
    } else {
      if queueEvent.BeginDisposal? {
        EmbeddingBeginDisposeRefs(s.queue,ok);
      } else if queueEvent.ProbeSingle? || queueEvent.ProbeBatch? || queueEvent.ProbeFailure? {
        EmbeddingProbeRefs(s.queue,!queueEvent.ProbeFailure?,queueEvent.ProbeBatch?);
      } else if !queueEvent.FinishRemoval? {
        EmbeddingQueueRefsChangePhase(s.queue,t.queue);
      }
      EmbeddingQueueRefsFromPrior(s,t);
    }
  }
}

lemma settleBatch_ensures(s: EmbeddingService, successful: seq<int>, retryable: seq<int>, threw: bool)
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysInitializationOwnsQueueStartup(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysActivationHasIdentity(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysQueueOwnerWellFormed(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysPendingKeysAreExactAndUnique(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysQueueHasKnownSnapshots(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysDisposalDetachesQueuedSnapshots(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysDisposalPhaseHasClosedAdmission(settleBatch(s, successful, retryable, threw)))
  ensures (inv(s) ==> canSettleBatch(s, successful, retryable, threw) ==> alwaysStoppedHandlersAreDetached(settleBatch(s, successful, retryable, threw)))
{
  if inv(s) && canSettleBatch(s,successful,retryable,threw) {
    EmbeddingQueueOwner(s);
    core__batchQueue_settleBatchedCall_ensures(s.queue,successful,retryable,threw);
    var t := settleBatch(s,successful,retryable,threw);
    EmbeddingQueueRefsChangePhase(s.queue,t.queue);
    EmbeddingQueueRefsFromPrior(s,t);
  }
}

lemma finishStop_ensures(s: EmbeddingService)
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysInitializationOwnsQueueStartup(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysActivationHasIdentity(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysQueueOwnerWellFormed(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysPendingKeysAreExactAndUnique(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysQueueHasKnownSnapshots(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysDisposalDetachesQueuedSnapshots(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysDisposalPhaseHasClosedAdmission(finishStop(s)))
  ensures (inv(s) ==> canFinishStop(s) ==> alwaysStoppedHandlersAreDetached(finishStop(s)))
{
  if inv(s) && canFinishStop(s) && !s.disabled && s.queuePresent {
    EmbeddingKeepCaptured(s,finishStop(s));
  }
}

lemma beginInitialization_ensures(s: EmbeddingService)
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysInitializationOwnsQueueStartup(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysActivationHasIdentity(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysQueueOwnerWellFormed(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysPendingKeysAreExactAndUnique(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysQueueHasKnownSnapshots(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysDisposalDetachesQueuedSnapshots(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysDisposalPhaseHasClosedAdmission(beginInitialization(s)))
  ensures (inv(s) ==> canBeginInitialization(s) ==> alwaysStoppedHandlersAreDetached(beginInitialization(s)))
{
  if inv(s) && canBeginInitialization(s) {
    core__batchQueue_initialHolds_ensures();
    core__batchQueue_configureBatchQueue_ensures(core__batchQueue_initial,10,10,4);
    var q := core__batchQueue_configureBatchQueue(core__batchQueue_initial,10,10,4);
    core__batchQueue_startSchedule_ensures(q);
  }
}

lemma finishInitialization_ensures(s: EmbeddingService, ok: bool)
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysInitializationOwnsQueueStartup(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysActivationHasIdentity(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysQueueOwnerWellFormed(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysPendingKeysAreExactAndUnique(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysQueueHasKnownSnapshots(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysDisposalDetachesQueuedSnapshots(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysDisposalPhaseHasClosedAdmission(finishInitialization(s, ok)))
  ensures (inv(s) ==> canFinishInitialization(s, ok) ==> alwaysStoppedHandlersAreDetached(finishInitialization(s, ok)))
{
  if inv(s) && canFinishInitialization(s,ok) {
    EmbeddingQueueOwner(s);
    core__batchQueue_finishSchedule_ensures(s.queue,ok);
  }
}
