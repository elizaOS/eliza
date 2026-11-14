# Embedding service activation and pending work

The source is `packages/core/src/services/embedding.ts:36-45,133-198,216-263,270-328,575-665`. This service owns model-registration activation, event subscription lifetime and exact pending source keys. Its only queue is the composed [BatchQueue](./batchQueue.md); [embedding writes](./embeddingWrite.md) own the per-item inference/storage receipt contract. The pending key is the full memory ID, agent, room, entity, text and priority tuple. A memory without an ID is deliberately not coalesced. The pending index has set semantics; its list representation permits exact structural tuple equality in generated reducers. Each waiting request captures the exact initialization promise it awaited: a later retry cannot turn an earlier rejection into a successful enqueue.

## Story: Activate once and retain every distinct source snapshot

### Initialization has one shared promise and a failed activation can retry

Discovered by simulation: a stopped instance cannot restart and attach event handlers. Starting a service creates a fresh instance.

```quint
import batchQueue as BQ from "./batchQueue"
import batchProcessor as B from "./batchProcessor"
import priorityQueue as Q from "./priorityQueue"
type EmbeddingSource = { memoryId: str, agentId: str, roomId: str, entityId: str, text: str, priority: Q::QueuePriority }
type EmbeddingItem = { id: str, source: EmbeddingSource, hasEmbedding: bool, initializationId: int }
type QueueEvent = BeginDrain | ProbeSingle | ProbeBatch | ProbeFailure | StartFallback | StartAttempt | FinishAttempt | FinishBackoff | FinishExhaustion | CollectFallback | FinishWork | ObserveWork | BeginDisposal | FlushUrgent | FinishFlush | ObserveFlush | RetryDisposal | FinishRemoval
type EmbeddingService = { started: bool, disabled: bool, stopped: bool, modelHandler: bool, workHandlers: bool, initializationId: int, settledInitializations: Set[int], failedInitializations: Set[int], initializing: bool, fromRegistration: bool, nextPromise: int, stopPending: bool, queuePresent: bool, queue: BQ::BatchQueue, waiting: List[EmbeddingItem], items: List[EmbeddingItem], pendingKeys: List[EmbeddingSource], lastEnqueued: bool }
pure val emptyWaitingItem: EmbeddingItem = { id: "", source: { memoryId: "", agentId: "", roomId: "", entityId: "", text: "", priority: Q::Normal }, hasEmbedding: false, initializationId: 0 }
pure val initial: EmbeddingService = { started: false, disabled: false, stopped: false, modelHandler: false, workHandlers: false, initializationId: 0, settledInitializations: Set(), failedInitializations: Set(), initializing: false, fromRegistration: false, nextPromise: 1, stopPending: false, queuePresent: false, queue: BQ::initial, waiting: List(), items: List(), pendingKeys: List(), lastEnqueued: false }
pure val idValues = Set("item1", "item2", "item3")
pure val sourceValues = Set({ memoryId: "memory1", agentId: "agent1", roomId: "room1", entityId: "actor1", text: "first", priority: Q::Normal }, { memoryId: "memory1", agentId: "agent1", roomId: "room1", entityId: "actor1", text: "changed", priority: Q::Normal }, { memoryId: "", agentId: "agent1", roomId: "room1", entityId: "actor1", text: "first", priority: Q::Low })
pure val queueEventValues = Set(BeginDrain, ProbeSingle, ProbeBatch, ProbeFailure, StartFallback, StartAttempt, FinishAttempt, FinishBackoff, FinishExhaustion, CollectFallback, FinishWork, ObserveWork, BeginDisposal, FlushUrgent, FinishFlush, ObserveFlush, RetryDisposal, FinishRemoval)
pure val ticketValues = Set(1, 2, 3)
pure val successfulValues = Set(Set(), Set(1), Set(1, 2))
pure val retryableValues = Set(Set(), Set(1), Set(2), Set(1, 2))
pure def canStart(s: EmbeddingService, hasModel: bool): bool = not(s.started) and not(s.stopped)
pure def start(s: EmbeddingService, hasModel: bool): EmbeddingService = { ...s, started: true, disabled: not(hasModel), modelHandler: true }
pure def canModelRegistered(s: EmbeddingService, hasModel: bool): bool = s.started and not(s.stopped) and s.disabled and hasModel
pure def modelRegistered(s: EmbeddingService, hasModel: bool): EmbeddingService = { ...s, disabled: false, fromRegistration: true }
pure def canBeginInitialization(s: EmbeddingService): bool = s.started and not(s.stopped) and not(s.disabled) and s.initializationId == 0
pure def beginInitialization(s: EmbeddingService): EmbeddingService = { ...s, initializationId: s.nextPromise, nextPromise: s.nextPromise + 1, initializing: true, workHandlers: true, queuePresent: true, queue: BQ::startSchedule(BQ::configureBatchQueue(BQ::initial, 10, 10, 4)) }
pure def canFinishInitialization(s: EmbeddingService, ok: bool): bool = s.initializing
pure def finishInitialization(s: EmbeddingService, ok: bool): EmbeddingService = { ...s, initializing: false, settledInitializations: s.settledInitializations.union(Set(s.initializationId)), failedInitializations: if (ok) s.failedInitializations else s.failedInitializations.union(Set(s.initializationId)), initializationId: if (ok) s.initializationId else 0, disabled: if (not(ok) and s.fromRegistration) true else s.disabled, workHandlers: ok and not(s.stopped), queue: BQ::finishSchedule(s.queue, ok) }
pure def canRequest(s: EmbeddingService, id: str, source: EmbeddingSource, hasEmbedding: bool): bool = id != "" and not(s.items.some(entry => entry.id == id)) and not(s.waiting.some(entry => entry.id == id))
pure def request(s: EmbeddingService, id: str, source: EmbeddingSource, hasEmbedding: bool): EmbeddingService = if (s.stopped) { ...s, lastEnqueued: false } else { ...s, waiting: s.waiting.append({ id: id, source: source, hasEmbedding: hasEmbedding, initializationId: s.initializationId }), lastEnqueued: false }
pure def sameEmbeddingSource(left: EmbeddingSource, right: EmbeddingSource): bool = left.memoryId == right.memoryId and left.agentId == right.agentId and left.roomId == right.roomId and left.entityId == right.entityId and left.text == right.text and left.priority == right.priority
pure def canSettleRequest(s: EmbeddingService): bool = s.waiting.length() > 0 and (s.waiting.nthOr(0, emptyWaitingItem).initializationId == 0 or s.settledInitializations.contains(s.waiting.nthOr(0, emptyWaitingItem).initializationId))
pure def settleRequest(s: EmbeddingService): EmbeddingService = {
  val itemToQueue = s.waiting.nthOr(0, emptyWaitingItem)
  val accept = not(s.failedInitializations.contains(itemToQueue.initializationId)) and not(s.stopped) and not(s.disabled) and s.queuePresent and not(itemToQueue.hasEmbedding) and (itemToQueue.source.memoryId == "" or not(s.pendingKeys.some(key => sameEmbeddingSource(key, itemToQueue.source)))) and BQ::canEnqueueBatchItem(s.queue, itemToQueue.id, itemToQueue.source.priority)
  { ...s, waiting: s.waiting.removeAt(0), queue: if (accept) BQ::enqueueBatchItem(s.queue, itemToQueue.id, itemToQueue.source.priority) else s.queue, items: if (accept) s.items.append(itemToQueue) else s.items, pendingKeys: if (accept and itemToQueue.source.memoryId != "") s.pendingKeys.append(itemToQueue.source) else s.pendingKeys, lastEnqueued: accept }
}
pure def retainCaptured(s: EmbeddingService): List[EmbeddingItem] = s.items.select(entry => s.queue.active.concat(s.queue.flush).some(active => active.payload == entry.id))
pure def clearQueue(s: EmbeddingService): EmbeddingService = if (s.queuePresent and not(s.queue.disposed)) { ...s, queue: { ...s.queue, queue: Q::clearQueue(s.queue.queue) }, pendingKeys: List(), items: retainCaptured(s) } else { ...s, pendingKeys: List() }
pure def canStop(s: EmbeddingService): bool = not(s.stopped)
pure def stop(s: EmbeddingService): EmbeddingService = { ...s, stopped: true, modelHandler: false, workHandlers: false, stopPending: true }
```

### Queue outcomes release exact pending keys and shutdown waits for activation

Clearing a queue clears pending keys even for work already in flight, matching the source. Consequently an old completion may remove the same key re-added by a later request; it must not be modeled as an item-ID-specific deletion. Queue item identities continue to distinguish the work itself. Discovered by the proof: after task removal completes or the queue detaches, no queued work remains. A clear keeps snapshots for items already captured by a drain or an urgent flush. If disposal has begun, BatchQueue.clear is a no-op: unflushed queued work survives until task removal, though the service still clears its pending keys. Completing urgent observation releases the flush snapshot; a normal drain retains its independent snapshot.

```quint
pure def canDriveQueue(s: EmbeddingService, queueEvent: QueueEvent, ticket: int, ok: bool, retry: bool): bool = (s.queuePresent or s.queue.phase != BQ::DrainIdle) and (
  if (queueEvent == BeginDrain) s.queuePresent and BQ::canBeginDrain(s.queue)
  else if (queueEvent == ProbeSingle or queueEvent == ProbeBatch or queueEvent == ProbeFailure) BQ::canFinishCapabilityProbe(s.queue, ok, false)
  else if (queueEvent == StartFallback) BQ::canStartFallback(s.queue, ticket, 0)
  else if (queueEvent == StartAttempt) BQ::canStartFallbackAttempt(s.queue, ticket)
  else if (queueEvent == FinishAttempt) BQ::canFinishFallbackAttempt(s.queue, ticket, ok, retry)
  else if (queueEvent == FinishBackoff) BQ::canFinishFallbackBackoff(s.queue, ticket)
  else if (queueEvent == FinishExhaustion) BQ::canFinishFallbackExhaustion(s.queue, ticket, ok)
  else if (queueEvent == CollectFallback) BQ::canCollectFallback(s.queue, ticket)
  else if (queueEvent == FinishWork) BQ::canFinishBatchWork(s.queue)
  else if (queueEvent == ObserveWork) ok and BQ::canObserveDrain(s.queue, ok)
  else if (queueEvent == BeginDisposal) s.stopped and not(s.initializing) and BQ::canBeginDispose(s.queue, ok)
  else if (queueEvent == FlushUrgent) BQ::canFlushUrgentItem(s.queue, ok)
  else if (queueEvent == FinishFlush) BQ::canFinishUrgentFlush(s.queue)
  else if (queueEvent == ObserveFlush) ok and BQ::canObserveUrgentFlush(s.queue, ok)
  else if (queueEvent == RetryDisposal) BQ::canRetryDisposal(s.queue)
  else BQ::canFinishTaskRemoval(s.queue, ok))
pure def queueReferences(queue: BQ::BatchQueue, id: str): bool = Q::queuedItems(queue.queue).some(job => job.payload == id) or queue.active.concat(queue.flush).some(job => job.payload == id)
pure def completedEmbeddingItems(s: EmbeddingService, flush: bool): List[EmbeddingItem] = {
  val captured = if (flush) s.queue.flush else s.queue.active
  s.items.select(entry => captured.some(active => active.payload == entry.id))
}
pure def retainAfterObservation(queue: BQ::BatchQueue, completed: List[EmbeddingItem], items: List[EmbeddingItem]): List[EmbeddingItem] = items.select(entry => not(completed.some(done => done.id == entry.id and sameEmbeddingSource(done.source, entry.source))) or queueReferences(queue, entry.id))
pure def driveQueue(s: EmbeddingService, queueEvent: QueueEvent, ticket: int, ok: bool, retry: bool): EmbeddingService = {
  val nextState = if (queueEvent == BeginDrain) BQ::beginDrain(s.queue) else if (queueEvent == ProbeSingle or queueEvent == ProbeBatch or queueEvent == ProbeFailure) BQ::finishCapabilityProbe(s.queue, queueEvent != ProbeFailure, queueEvent == ProbeBatch) else if (queueEvent == StartFallback) BQ::startFallback(s.queue, ticket, 0) else if (queueEvent == StartAttempt) BQ::startFallbackAttempt(s.queue, ticket) else if (queueEvent == FinishAttempt) BQ::finishFallbackAttempt(s.queue, ticket, ok, retry) else if (queueEvent == FinishBackoff) BQ::finishFallbackBackoff(s.queue, ticket) else if (queueEvent == FinishExhaustion) BQ::finishFallbackExhaustion(s.queue, ticket, ok) else if (queueEvent == CollectFallback) BQ::collectFallback(s.queue, ticket) else if (queueEvent == FinishWork) BQ::finishBatchWork(s.queue) else if (queueEvent == ObserveWork) BQ::observeDrain(s.queue, ok) else if (queueEvent == BeginDisposal) BQ::beginDispose(s.queue, ok) else if (queueEvent == FlushUrgent) BQ::flushUrgentItem(s.queue, ok) else if (queueEvent == FinishFlush) BQ::finishUrgentFlush(s.queue) else if (queueEvent == ObserveFlush) { ...BQ::observeUrgentFlush(s.queue, ok), flush: List() } else if (queueEvent == RetryDisposal) BQ::retryDisposal(s.queue) else BQ::finishTaskRemoval(s.queue, ok)
  val completed = completedEmbeddingItems(s, queueEvent == ObserveFlush)
  { ...s, queue: nextState, pendingKeys: if (queueEvent == ObserveWork or queueEvent == ObserveFlush) s.pendingKeys.select(source => not(completed.some(entry => sameEmbeddingSource(entry.source, source)))) else s.pendingKeys, items: if (queueEvent == ObserveWork or queueEvent == ObserveFlush) retainAfterObservation(nextState, completed, s.items) else s.items }
}
pure def canSettleBatch(s: EmbeddingService, successful: Set[int], retryable: Set[int], threw: bool): bool = BQ::canSettleBatchedCall(s.queue, successful, retryable, threw)
pure def settleBatch(s: EmbeddingService, successful: Set[int], retryable: Set[int], threw: bool): EmbeddingService = { ...s, queue: BQ::settleBatchedCall(s.queue, successful, retryable, threw) }
pure def canFinishStop(s: EmbeddingService): bool = s.stopPending and not(s.initializing) and (s.disabled or not(s.queuePresent) or s.queue.disposePhase == BQ::QueueDisposed)
pure def finishStop(s: EmbeddingService): EmbeddingService = if (s.disabled or not(s.queuePresent)) { ...s, stopPending: false } else { ...s, stopPending: false, queuePresent: false, pendingKeys: List(), items: retainCaptured(s) }
pure def alwaysActivationHasIdentity(s: EmbeddingService): bool = s.nextPromise > 0 and s.initializationId >= 0 and s.initializationId < s.nextPromise and (s.initializing implies s.initializationId > 0 and s.queuePresent)
pure def alwaysPendingKeysAreExactAndUnique(s: EmbeddingService): bool = s.pendingKeys.every(source => source.memoryId != "" and s.pendingKeys.select(other => sameEmbeddingSource(other, source)).length() == 1 and s.items.some(entry => sameEmbeddingSource(entry.source, source)))
pure def alwaysQueueHasKnownSnapshots(s: EmbeddingService): bool = Q::queuedItems(s.queue.queue).every(job => s.items.some(entry => entry.id == job.payload)) and s.queue.active.concat(s.queue.flush).every(job => s.items.some(entry => entry.id == job.payload))
pure def alwaysDisposalDetachesQueuedSnapshots(s: EmbeddingService): bool = (not(s.queuePresent) or s.queue.disposePhase == BQ::QueueDisposed) implies Q::queuedItems(s.queue.queue).length() == 0
pure def alwaysDisposalPhaseHasClosedAdmission(s: EmbeddingService): bool = s.queue.disposePhase != BQ::NotDisposing implies s.queue.disposed
pure def alwaysStoppedHandlersAreDetached(s: EmbeddingService): bool = s.stopped implies not(s.modelHandler) and not(s.workHandlers)
pure def sometimesDistinctSnapshotsCoexist(s: EmbeddingService): bool = s.items.some(entry => s.items.some(other => entry.id != other.id and entry.source.memoryId == other.source.memoryId and not(sameEmbeddingSource(entry.source, other.source))))
pure def sometimesWaitsForModel(s: EmbeddingService): bool = s.started and s.disabled and s.modelHandler
```
