# Scheduled batch queue

Priority admission, per-item retry and scheduled draining share one queue owner. A batched provider success is never replayed when a sibling fails. Source [batch-queue.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/batch-queue.ts).

## Story: Schedule one drain at a time

As a host I register a repeat task, enqueue work and probe live batch capability before removing queued items.

### A failed capability probe leaves queued items untouched

An in-flight drain owns its removed slice. Scheduling failure releases the pending task registration so it can be retried.

```quint
import priorityQueue as Q from "./priorityQueue"
import batchProcessor as B from "./batchProcessor"
type DrainPhase = DrainIdle | ProbePending | BatchedCallPending | FallbackPending | DrainObservation
type BatchItemPhase = NeedsFallback | FallbackRunning | BatchItemSucceeded | BatchItemFailed
type BatchItem = { ticket: int, payload: str, phase: BatchItemPhase }
pure val emptyBatchItem: BatchItem = {ticket: 0, payload: "", phase: NeedsFallback}
type DisposePhase = NotDisposing | FlushPending | FlushObservation | RemovingTask | QueueDisposed | DisposeFailed
type BatchQueue = { queue: Q::PriorityState, processor: B::Processor, batchSize: int, phase: DrainPhase, active: List[BatchItem], batchId: int, configured: bool, schedulePending: bool, scheduled: bool, disposed: bool, disposePhase: DisposePhase, flush: List[BatchItem], lastProcessed: int, diagnosticFailures: int }
pure val initial: BatchQueue = { queue: Q::initial, processor: B::initial, batchSize: 1, phase: DrainIdle, active: List(), batchId: 0, configured: false, schedulePending: false, scheduled: false, disposed: false, disposePhase: NotDisposing, flush: List(), lastProcessed: 0, diagnosticFailures: 0 }
pure val batchSizeValues = Set(0, 1, 3)
pure val maxParallelValues = Set(1, 2)
pure val attemptsValues = Set(1, 3)
pure val payloadValues = Set("job-a", "job-b")
pure val ticketValues = Set(1, 2, 3)
pure val successfulValues = Set(Set(), Set(1), Set(2), Set(1, 2, 3))
pure val retryableValues = Set(Set(), Set(1), Set(2), Set(1, 2, 3))
pure val perItemAttemptsValues = Set(0, 1, 3)
pure def canConfigureBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int): bool = not(s.configured) and maxParallel > 0 and attempts > 0
pure def configureBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int): BatchQueue = { ...s, configured: true, batchSize: if (batchSize < 1) 1 else batchSize, queue: Q::configureQueue(s.queue, 0, false, false), processor: B::configureProcessor(s.processor, maxParallel, attempts, 1, false) }
pure def canEnqueueBatchItem(s: BatchQueue, payload: str, priority: Q::QueuePriority): bool = s.configured and not(s.disposed) and Q::canEnqueue(s.queue, payload, priority)
pure def enqueueBatchItem(s: BatchQueue, payload: str, priority: Q::QueuePriority): BatchQueue = { ...s, queue: Q::enqueue(s.queue, payload, priority) }
pure def canStartSchedule(s: BatchQueue): bool = s.configured and not(s.disposed) and not(s.scheduled) and not(s.schedulePending)
pure def startSchedule(s: BatchQueue): BatchQueue = { ...s, schedulePending: true }
pure def canFinishSchedule(s: BatchQueue, ok: bool): bool = s.schedulePending
pure def finishSchedule(s: BatchQueue, ok: bool): BatchQueue = { ...s, schedulePending: false, scheduled: ok and not(s.disposed) }
pure def canBeginDrain(s: BatchQueue): bool = s.configured and not(s.disposed) and s.phase == DrainIdle and Q::queueSize(s.queue) > 0
pure def beginDrain(s: BatchQueue): BatchQueue = { ...s, phase: ProbePending, lastProcessed: 0 }
pure def canFinishCapabilityProbe(s: BatchQueue, ok: bool, useBatch: bool): bool = s.phase == ProbePending
pure def finishCapabilityProbe(s: BatchQueue, ok: bool, useBatch: bool): BatchQueue = {
  val dequeued = Q::dequeue(s.queue, s.batchSize)
  if (not(ok)) { ...s, phase: DrainIdle, diagnosticFailures: s.diagnosticFailures + 1 }
  else { ...s, queue: dequeued, batchId: s.batchId + 1, active: dequeued.lastRemoved.listMap(j => {ticket: j.ticket, payload: j.payload, phase: NeedsFallback}), phase: if (useBatch) BatchedCallPending else FallbackPending }
}
pure def alwaysActiveSliceBounded(s: BatchQueue): bool = s.active.length() <= s.batchSize
pure def alwaysBatchItemIdentityUnique(s: BatchQueue): bool = s.active.every(j => s.active.select(other => other.ticket == j.ticket).length() == 1)
pure def sometimesScheduleRetriesWithoutLoss(s: BatchQueue): bool = s.configured and not(s.scheduled) and not(s.schedulePending) and Q::queueSize(s.queue) > 0
```

### A batched call settles successful items before retrying failures

A batch-wide throw sends every item to the ordinary failure policy. An item rejected by shouldRetry becomes failed without entering the per-item processor.

```quint
pure def canSettleBatchedCall(s: BatchQueue, successful: Set[int], retryable: Set[int], threw: bool): bool = s.phase == BatchedCallPending and successful.forall(ticket => s.active.some(j => j.ticket == ticket)) and retryable.forall(ticket => s.active.some(j => j.ticket == ticket))
pure def settleBatchedCall(s: BatchQueue, successful: Set[int], retryable: Set[int], threw: bool): BatchQueue = { ...s, phase: FallbackPending, diagnosticFailures: s.diagnosticFailures + (if (threw) 1 else 0), active: s.active.listMap(j => { ...j, phase: if (not(threw) and successful.contains(j.ticket)) BatchItemSucceeded else if (retryable.contains(j.ticket)) NeedsFallback else BatchItemFailed }) }
pure def canStartFallback(s: BatchQueue, ticket: int, perItemAttempts: int): bool = s.phase == FallbackPending and s.active.some(j => j.ticket == ticket and j.phase == NeedsFallback) and B::canSubmitItem(s.processor, ticket, s.batchId, "", perItemAttempts)
pure def startFallback(s: BatchQueue, ticket: int, perItemAttempts: int): BatchQueue = {
  val payload = s.active.select(j => j.ticket == ticket).nthOr(0, emptyBatchItem).payload
  { ...s, active: s.active.listMap(j => if (j.ticket == ticket) { ...j, phase: FallbackRunning } else j), processor: B::submitItem(s.processor, ticket, s.batchId, payload, perItemAttempts) }
}
pure def canStartFallbackAttempt(s: BatchQueue, ticket: int): bool = B::canStartItem(s.processor, ticket)
pure def startFallbackAttempt(s: BatchQueue, ticket: int): BatchQueue = { ...s, processor: B::startItem(s.processor, ticket) }
pure def canFinishFallbackAttempt(s: BatchQueue, ticket: int, ok: bool, retry: bool): bool = B::canFinishItemAttempt(s.processor, ticket, ok, retry)
pure def finishFallbackAttempt(s: BatchQueue, ticket: int, ok: bool, retry: bool): BatchQueue = { ...s, processor: B::finishItemAttempt(s.processor, ticket, ok, retry) }
pure def canFinishFallbackBackoff(s: BatchQueue, ticket: int): bool = B::canFinishBackoff(s.processor, ticket)
pure def finishFallbackBackoff(s: BatchQueue, ticket: int): BatchQueue = { ...s, processor: B::finishBackoff(s.processor, ticket) }
pure def canFinishFallbackExhaustion(s: BatchQueue, ticket: int, callbackOk: bool): bool = B::canFinishExhaustion(s.processor, ticket, callbackOk)
pure def finishFallbackExhaustion(s: BatchQueue, ticket: int, callbackOk: bool): BatchQueue = { ...s, processor: B::finishExhaustion(s.processor, ticket, callbackOk) }
pure def canCollectFallback(s: BatchQueue, ticket: int): bool = s.phase == FallbackPending and s.active.some(j => j.ticket == ticket and j.phase == FallbackRunning) and s.processor.items.some(j => j.id == ticket and (j.phase == B::ItemSucceeded or j.phase == B::ItemFailed))
pure def collectFallback(s: BatchQueue, ticket: int): BatchQueue = { ...s, active: s.active.listMap(j => if (j.ticket != ticket) j else { ...j, phase: if (s.processor.items.some(done => done.id == ticket and done.phase == B::ItemSucceeded)) BatchItemSucceeded else BatchItemFailed }) }
pure def canFinishBatchWork(s: BatchQueue): bool = s.phase == FallbackPending and s.active.every(j => j.phase == BatchItemSucceeded or j.phase == BatchItemFailed)
pure def finishBatchWork(s: BatchQueue): BatchQueue = { ...s, phase: DrainObservation, lastProcessed: s.active.length() }
pure def canObserveDrain(s: BatchQueue, observersOk: bool): bool = s.phase == DrainObservation
pure def observeDrain(s: BatchQueue, observersOk: bool): BatchQueue = { ...s, phase: DrainIdle, active: List(), diagnosticFailures: s.diagnosticFailures + (if (observersOk) 0 else 1) }
pure def alwaysFallbackKeepsSuccessfulItems(s: BatchQueue): bool = s.active.every(j => j.phase == BatchItemSucceeded implies not(s.processor.items.some(p => p.id == j.ticket and p.phase != B::ItemSucceeded)))
pure def alwaysFallbackConcurrency(s: BatchQueue): bool = B::alwaysProcessorConcurrency(s.processor) and B::alwaysAttemptBudgets(s.processor)
pure def sometimesPartialBatchSuccess(s: BatchQueue): bool = s.active.some(j => j.phase == BatchItemSucceeded) and s.active.some(j => j.phase == NeedsFallback)
```

## Story: Dispose the queue and optionally flush urgent work

As a host I reject new enqueue operations immediately, flush selected high-priority work once in serial order and remove the repeat task.

### Disposal keeps an in-flight drain independent from its serial urgent flush

The disposal flush uses one attempt per item. Failure of its observation callback remains visible and permits an explicit retry of task removal.

```quint
pure def canBeginDispose(s: BatchQueue, flushHigh: bool): bool = s.configured and s.disposePhase == NotDisposing
pure def beginDispose(s: BatchQueue, flushHigh: bool): BatchQueue = {
  val high = if (flushHigh) s.queue.high else List()
  val ids = high.foldl(Set(), (tickets, j) => tickets.union(Set(j.ticket)))
  { ...s, disposed: true, queue: Q::drainTickets(s.queue, ids), flush: high.listMap(j => {ticket: j.ticket, payload: j.payload, phase: NeedsFallback}), disposePhase: if (high.length() > 0) FlushPending else RemovingTask }
}
pure def canFlushUrgentItem(s: BatchQueue, ok: bool): bool = s.disposePhase == FlushPending and s.flush.some(j => j.phase == NeedsFallback)
pure def flushUrgentItem(s: BatchQueue, ok: bool): BatchQueue = {
  val id = s.flush.select(j => j.phase == NeedsFallback).nthOr(0, emptyBatchItem).ticket
  { ...s, flush: s.flush.listMap(j => if (j.ticket == id) { ...j, phase: if (ok) BatchItemSucceeded else BatchItemFailed } else j) }
}
pure def canFinishUrgentFlush(s: BatchQueue): bool = s.disposePhase == FlushPending and s.flush.every(j => j.phase != NeedsFallback)
pure def finishUrgentFlush(s: BatchQueue): BatchQueue = { ...s, disposePhase: FlushObservation }
pure def canObserveUrgentFlush(s: BatchQueue, ok: bool): bool = s.disposePhase == FlushObservation
pure def observeUrgentFlush(s: BatchQueue, ok: bool): BatchQueue = { ...s, disposePhase: if (ok) RemovingTask else DisposeFailed, diagnosticFailures: s.diagnosticFailures + (if (ok) 0 else 1) }
pure def canRetryDisposal(s: BatchQueue): bool = s.disposePhase == DisposeFailed
pure def retryDisposal(s: BatchQueue): BatchQueue = { ...s, disposePhase: RemovingTask }
pure def canFinishTaskRemoval(s: BatchQueue, ok: bool): bool = s.disposePhase == RemovingTask
pure def finishTaskRemoval(s: BatchQueue, ok: bool): BatchQueue = if (ok) { ...s, queue: Q::clearQueue(s.queue), scheduled: false, disposePhase: QueueDisposed } else { ...s, disposePhase: DisposeFailed }
pure def alwaysDisposedQueueRejectsEnqueue(s: BatchQueue): bool = s.disposed implies not(canEnqueueBatchItem(s, "", Q::Normal))
pure def alwaysCompletedDisposalClearsQueue(s: BatchQueue): bool = s.disposePhase == QueueDisposed implies Q::queueSize(s.queue) == 0 and not(s.scheduled)
pure def sometimesUrgentFlushRetainsDrain(s: BatchQueue): bool = s.disposed and s.disposePhase == FlushPending and s.phase != DrainIdle
```
