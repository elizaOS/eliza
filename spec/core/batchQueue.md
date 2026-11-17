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
pure val maxSizeValues = Set(0, 1, 3)
pure def canConfigureBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int): bool = canConfigureSizedBatchQueue(s, batchSize, maxParallel, attempts, 0, false, false)
pure def configureBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int): BatchQueue = configureSizedBatchQueue(s, batchSize, maxParallel, attempts, 0, false, false)
pure def canEnqueueBatchItem(s: BatchQueue, payload: str, priority: Q::QueuePriority): bool = s.configured and not(s.disposed) and Q::canEnqueue(s.queue, payload, priority)
pure def enqueueBatchItem(s: BatchQueue, payload: str, priority: Q::QueuePriority): BatchQueue = { ...s, queue: Q::enqueue(s.queue, payload, priority) }
pure def canStartSchedule(s: BatchQueue): bool = s.configured and not(s.disposed) and not(s.scheduled) and not(s.schedulePending)
pure def startSchedule(s: BatchQueue): BatchQueue = { ...s, schedulePending: true }
pure def canFinishSchedule(s: BatchQueue, ok: bool): bool = s.schedulePending
pure def finishSchedule(s: BatchQueue, ok: bool): BatchQueue = { ...s, schedulePending: false, scheduled: ok and not(s.disposed) }
pure def canBeginDrain(s: BatchQueue): bool = s.configured and not(s.disposed) and s.phase == DrainIdle and Q::queueSize(s.queue) > 0 and not(s.queue.pressurePending)
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

### Size pressure settles one enqueue before a new drain or disposal starts

Construction passes the size threshold, the pressure callback and the overflow warning to the priority queue. Construction without these options, as the embedding and privacy services do, is the same as construction with no threshold and no callback. An enqueue at or above the threshold waits for the pressure callback when there is one; without one, the item is added and the queue grows past the threshold with a warning. The callback can remove any queued items and then accepts or refuses the waiting item. The callback runs synchronously inside enqueue, so no new drain or disposal starts while its decision is pending. A refused enqueue and a queue above its threshold can both occur.

```quint
pure val droppedValues = Set(Set(), Set(1), Set(1, 2, 3))
pure def canConfigureSizedBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int, maxSize: int, hasMax: bool, hasPressure: bool): bool = not(s.configured) and maxParallel > 0 and attempts > 0 and Q::canConfigureQueue(s.queue, maxSize, hasMax, hasPressure)
pure def configureSizedBatchQueue(s: BatchQueue, batchSize: int, maxParallel: int, attempts: int, maxSize: int, hasMax: bool, hasPressure: bool): BatchQueue = { ...s, configured: true, batchSize: if (batchSize < 1) 1 else batchSize, queue: Q::configureQueue(s.queue, maxSize, hasMax, hasPressure), processor: B::configureProcessor(s.processor, maxParallel, attempts, 1, false) }
pure def canResolveBatchPressure(s: BatchQueue, accepted: bool, dropped: Set[int]): bool = Q::canResolvePressure(s.queue, accepted)
pure def resolveBatchPressure(s: BatchQueue, accepted: bool, dropped: Set[int]): BatchQueue = { ...s, queue: Q::resolvePressure(Q::drainTickets(s.queue, dropped), accepted) }
pure def sometimesPressureRefusesEnqueue(s: BatchQueue): bool = s.configured and s.queue.hasPressure and not(s.queue.pressurePending) and not(s.queue.lastAccepted) and s.queue.nextTicket > 1
pure def sometimesQueueAboveThreshold(s: BatchQueue): bool = s.configured and s.queue.hasMax and not(s.queue.hasPressure) and Q::queueSize(s.queue) > s.queue.maxSize
```

### The composed queue and processor each keep their own owner's rules

The priority queue satisfies every rule of the priority-queue spec, and the per-item processor satisfies every rule of the batch-processor spec.

Discovered by the proof: the composed queue and processor retain their complete owner contracts. Without them, a step of the batch queue could not use any fact about the queue or the processor that it holds.

```quint
pure def alwaysBatchComponentsWellFormed(s: BatchQueue): bool = Q::wellFormed(s.queue) and B::wellFormed(s.processor)
```

### Only construction is unconfigured, pressure waits only on a live queue with a threshold and a callback, disposal keeps the queue retired, and a removed slice is numbered, held only past the probe and unsettled during the batched call

Before configuration the batch queue is exactly its initial state. Once configured, its queue and processor are configured, its batch size is at least one, and a pending pressure decision exists only on a queue with a size threshold and a pressure callback that is not disposed. The batch counter is never negative, and a non-empty removed slice has a positive batch number. The idle and probe phases hold no removed slice. While the batched call is pending, every removed item still waits for its outcome. Once disposal has begun, the batch queue stays marked disposed.

Discovered by the proof: construction is the only unconfigured state, and a configured aggregate owns configured components. A fabricated pre-construction active slice cannot survive a smaller configured batch bound. Idle and probe phases own no previously removed slice. The batch counter identifies completed removals, not payload values. Without the pressure fact, a decision pending on a disposed queue could insert an item after task removal had cleared the queue. Without the retirement fact, a fabricated completed disposal with an open admission bit could accept a new enqueue or a late scheduling receipt.

```quint
pure def alwaysBatchConstructionAndPhases(s: BatchQueue): bool =
  (if (s.configured) s.queue.configured and s.processor.configured and s.batchSize >= 1 and
    (s.queue.pressurePending implies (s.queue.hasMax and s.queue.hasPressure and not(s.disposed))) else s == initial) and
  s.batchId >= 0 and (s.active.length() > 0 implies s.batchId > 0) and
  ((s.phase == DrainIdle or s.phase == ProbePending) implies s.active.length() == 0) and
  (s.phase == BatchedCallPending implies s.active.every(j => j.phase == NeedsFallback)) and
  (s.disposePhase != NotDisposing implies s.disposed)
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

### Every removed, flushed or processed ticket is older than the next queue ticket and has one owner

Every item in the removed slice or the urgent flush has a positive ticket below the queue's next ticket, and every per-item processor record has an id below it. A flushed ticket appears once in the flush and never in the processor. No ticket in the removed slice is also in the flush. No queued ticket appears in the removed slice, the flush or the processor. A new enqueue therefore never reuses the ticket of an earlier item.

Discovered by the proof: fresh queue tickets cannot overlap a historical processor invocation, an active slice or the urgent flush. All retained occurrence IDs remain below the queue's next ticket. Without these facts, a fabricated current provider success could share a historical failed ID, unless equal payload values were deduplicated or history was cleared.

```quint
pure def alwaysBatchTicketOwnership(s: BatchQueue): bool =
  s.active.concat(s.flush).every(j => j.ticket > 0 and j.ticket < s.queue.nextTicket) and
  s.processor.items.every(j => j.id < s.queue.nextTicket) and
  s.flush.every(j => s.flush.select(other => other.ticket == j.ticket).length() == 1 and
    not(s.processor.items.some(other => other.id == j.ticket))) and
  s.active.every(j => not(s.flush.some(other => other.ticket == j.ticket))) and
  Q::queuedItems(s.queue).every(j => not(s.active.concat(s.flush).some(other => other.ticket == j.ticket)) and
    not(s.processor.items.some(other => other.id == j.ticket)))
```

### An item waiting for fallback has no processor record, and a running fallback has one for its batch and payload

An item in the removed slice that still needs the per-item path has no per-item processor record with its ticket. An item whose fallback is running has a processor record with its ticket, the current batch number and its own payload.

Discovered by the proof: a provider success may have no processor item, while a collected fallback success retains only a successful processor item, and historical processor outcomes stay retained. Without the record of a running fallback, its collected outcome could come from another batch or payload.

```quint
pure def alwaysFallbackInvocationOwnership(s: BatchQueue): bool = s.active.every(j =>
  (j.phase == NeedsFallback implies not(s.processor.items.some(other => other.id == j.ticket))) and
  (j.phase == FallbackRunning implies s.processor.items.some(other => other.id == j.ticket and other.batch == s.batchId and other.payload == j.payload)))
```

## Story: Dispose the queue and optionally flush urgent work

As a host I reject new enqueue operations immediately, flush selected high-priority work once in serial order and remove the repeat task.

### Disposal keeps an in-flight drain independent from its serial urgent flush

The disposal flush uses one attempt per item. Failure of its observation callback remains visible and permits an explicit retry of task removal.

Discovered by the proof: direct service holders compose the complete `wellFormed` queue contract, which is every `always` rule of this spec together. Without it, a service that holds a batch queue could not keep the queue's own rules true.

```quint
pure def canBeginDispose(s: BatchQueue, flushHigh: bool): bool = s.configured and s.disposePhase == NotDisposing and not(s.queue.pressurePending)
pure def addFlushTicket(tickets: Set[int], ticket: int): Set[int] = tickets.union(Set(ticket))
pure def beginDispose(s: BatchQueue, flushHigh: bool): BatchQueue = {
  val high = if (flushHigh) s.queue.high else List()
  val ids = high.foldl(Set(), (tickets, j) => addFlushTicket(tickets, j.ticket))
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
pure def wellFormed(s: BatchQueue): bool =
  alwaysActiveSliceBounded(s) and alwaysBatchItemIdentityUnique(s) and alwaysFallbackKeepsSuccessfulItems(s) and
  alwaysFallbackConcurrency(s) and alwaysDisposedQueueRejectsEnqueue(s) and alwaysCompletedDisposalClearsQueue(s) and
  alwaysBatchComponentsWellFormed(s) and alwaysBatchConstructionAndPhases(s) and
  alwaysBatchTicketOwnership(s) and alwaysFallbackInvocationOwnership(s)
pure def sometimesUrgentFlushRetainsDrain(s: BatchQueue): bool = s.disposed and s.disposePhase == FlushPending and s.phase != DrainIdle
```
