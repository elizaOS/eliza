# PII service queue and promise ownership

The source is `packages/core/src/services/pii-scrub.ts:58-61,89-134,138-198,203-317,404-452`. This aggregate owns the actual [BatchQueue](./batchQueue.md), all content/ruleset job identities, the shared committed-marker set, lazy drain-start and stop promise identities. Every job embeds [PII scrub settlement](./privacy.md) for its own marker/pseudonym/notification outcome; the component's lifecycle fields are driven only by this service. The queue's per-item processor permits two simultaneous jobs, including two initial misses for the same content key. Keys represent complete content/ruleset identity, not raw private text.

## Story: Share service startup while keeping independent scrub attempts

### Each marker lookup captures its own result before queue admission

```quint
import privacy as P from "./privacy"
import batchQueue as BQ from "./batchQueue"
import batchProcessor as B from "./batchProcessor"
import priorityQueue as Q from "./priorityQueue"
type PiiJob = { id: str, key: str, priority: Q::QueuePriority, work: P::Privacy }
type StopWaiter = { id: int, startId: int, disposalStarted: bool, done: bool, failed: bool }
type PiiQueueEvent = BeginDrain | ProbeSucceeded | ProbeFailed | StartFallback | StartAttempt | FinishBackoff | FinishExhaustion | CollectFallback | FinishWork | ObserveWork | FinishFlush | ObserveFlush | RetryDisposal | FinishRemoval
type PrivacyService = { jobs: List[PiiJob], markers: Set[str], queue: BQ::BatchQueue, queuePresent: bool, stopping: bool, handlerRegistered: bool, startId: int, startPending: bool, stopId: int, nextPromise: int, stopWaiters: List[StopWaiter], flushTicket: int }
pure val emptyJob: PiiJob = { id: "", key: "", priority: Q::Normal, work: P::initial }
pure val emptyBatchTicket: BQ::BatchItem = { ticket: 0, payload: "", phase: BQ::NeedsFallback }
pure val initial: PrivacyService = { jobs: List(), markers: Set(), queue: BQ::configureBatchQueue(BQ::initial, 10, 2, 4), queuePresent: true, stopping: false, handlerRegistered: true, startId: 0, startPending: false, stopId: 0, nextPromise: 1, stopWaiters: List(), flushTicket: 0 }
pure val idValues = Set("job1", "job2", "job3")
pure val keyValues = Set("content-and-rules-a", "content-and-rules-b")
pure val priorityValues = Set(Q::High, Q::Normal, Q::Low)
pure val ticketValues = Set(1, 2, 3)
pure val queueEventValues = Set(BeginDrain, ProbeSucceeded, ProbeFailed, StartFallback, StartAttempt, FinishBackoff, FinishExhaustion, CollectFallback, FinishWork, ObserveWork, FinishFlush, ObserveFlush, RetryDisposal, FinishRemoval)
pure def jobAt(s: PrivacyService, id: str): PiiJob = s.jobs.select(job => job.id == id).nthOr(0, emptyJob)
pure def ticketJob(s: PrivacyService, ticket: int): PiiJob = jobAt(s, s.queue.active.concat(s.queue.flush).select(active => active.ticket == ticket).nthOr(0, emptyBatchTicket).payload)
pure def replaceJob(job: PiiJob, s: PrivacyService): PrivacyService = { ...s, jobs: s.jobs.listMap(existing => if (existing.id == job.id) job else existing) }
pure def canRequest(s: PrivacyService, id: str, key: str, priority: Q::QueuePriority): bool = not(s.stopping) and s.queuePresent and id != "" and key != "" and jobAt(s, id).id == ""
pure def request(s: PrivacyService, id: str, key: str, priority: Q::QueuePriority): PrivacyService = { ...s, jobs: s.jobs.append({ id: id, key: key, priority: priority, work: P::request({ ...P::initial, startup: P::Ready, marker: s.markers.contains(key), mapPersisted: s.markers.contains(key) }) }) }
pure def canFinishAdmission(s: PrivacyService, id: str): bool = P::canFinishAdmission(jobAt(s, id).work)
pure def finishAdmission(s: PrivacyService, id: str): PrivacyService = {
  val job = jobAt(s, id)
  val work = P::finishAdmission(job.work)
  val accepted = work.accepted > job.work.accepted
  val starts = accepted and s.startId == 0 and not(s.stopping)
  val admittedQueue = if (accepted) BQ::enqueueBatchItem(s.queue, id, job.priority) else s.queue
  { ...replaceJob({ ...job, work: work }, s), queue: if (starts) BQ::startSchedule(admittedQueue) else admittedQueue, startId: if (starts) s.nextPromise else s.startId, startPending: if (starts) true else s.startPending, nextPromise: if (starts) s.nextPromise + 1 else s.nextPromise }
}
pure def canStartResult(s: PrivacyService, ok: bool): bool = s.startPending and s.startId != 0
pure def startResult(s: PrivacyService, ok: bool): PrivacyService = { ...s, queue: BQ::finishSchedule(s.queue, ok), startId: if (ok) s.startId else 0, startPending: false }
```

### Each processor attempt preserves its own marker and retry ownership

Source review correction: attempt failure is possible only before the marker is acknowledged. A later observer failure cannot revoke the committed marker or reopen processing.

Discovered by the proof: starting an urgent flush item and settling a processor ticket require the same queued or running job owner. A missing lookup or an already disposed local job cannot advance work. The model checks the shared marker again when a queued attempt starts. Earlier simultaneous misses may both already be active and can both finish. Terminal queue rejection records failure without inventing a committed marker. Publication becomes shared only after the exact marker acknowledgement.

Discovered by simulation: late bookkeeping belongs to collection of the detached processor result, not an independent public event. An in-flight scrub retains its work during detachment. The collector disposes only after the batch records that ticket's terminal processor outcome, the job is idle, and no further fallback owns that job. Settled counts and marker evidence remain.

```quint
pure def terminalFailure(failureCount: int, work: P::Privacy): P::Privacy = { ...work, phase: P::Idle, failed: failureCount, attempts: 0 }
pure def canScrubbed(s: PrivacyService, id: str): bool = P::canScrubbed(jobAt(s, id).work)
pure def scrubbed(s: PrivacyService, id: str): PrivacyService = replaceJob({ ...jobAt(s, id), work: P::scrubbed(jobAt(s, id).work) }, s)
pure def canPersistMap(s: PrivacyService, id: str): bool = P::canPersistMap(jobAt(s, id).work)
pure def persistMap(s: PrivacyService, id: str): PrivacyService = replaceJob({ ...jobAt(s, id), work: P::persistMap(jobAt(s, id).work) }, s)
pure def canConfirmMarker(s: PrivacyService, id: str): bool = P::canConfirmMarker(jobAt(s, id).work)
pure def confirmMarker(s: PrivacyService, id: str): PrivacyService = { ...replaceJob({ ...jobAt(s, id), work: P::confirmMarker(jobAt(s, id).work) }, s), markers: s.markers.union(Set(jobAt(s, id).key)) }
pure def canObserveCompletion(s: PrivacyService, id: str, observerSucceeded: bool): bool = P::canObserveCompletion(jobAt(s, id).work, observerSucceeded)
pure def observeCompletion(s: PrivacyService, id: str, observerSucceeded: bool): PrivacyService = replaceJob({ ...jobAt(s, id), work: P::observeCompletion(jobAt(s, id).work, observerSucceeded) }, s)
pure def canFinishAttempt(s: PrivacyService, ticket: int, ok: bool, retry: bool): bool = BQ::canFinishFallbackAttempt(s.queue, ticket, ok, retry) and ticketJob(s, ticket).id != "" and (if (ok) ticketJob(s, ticket).work.processed > 0 else P::canAttemptFailed(ticketJob(s, ticket).work))
pure def finishAttempt(s: PrivacyService, ticket: int, ok: bool, retry: bool): PrivacyService = {
  val job = ticketJob(s, ticket)
  val work = if (ok) job.work else if (retry) P::attemptFailed(job.work) else terminalFailure(job.work.failed + 1, job.work)
  { ...replaceJob({ ...job, work: work }, s), queue: BQ::finishFallbackAttempt(s.queue, ticket, ok, retry) }
}
pure def canDriveQueue(s: PrivacyService, queueEvent: PiiQueueEvent, ticket: int, ok: bool): bool =
  if (queueEvent == BeginDrain) s.queue.scheduled and BQ::canBeginDrain(s.queue)
  else if (queueEvent == ProbeSucceeded or queueEvent == ProbeFailed) BQ::canFinishCapabilityProbe(s.queue, ok, false)
  else if (queueEvent == StartFallback) BQ::canStartFallback(s.queue, ticket, 0)
  else if (queueEvent == StartAttempt) BQ::canStartFallbackAttempt(s.queue, ticket) and P::canDrain(ticketJob(s, ticket).work)
  else if (queueEvent == FinishBackoff) BQ::canFinishFallbackBackoff(s.queue, ticket)
  else if (queueEvent == FinishExhaustion) BQ::canFinishFallbackExhaustion(s.queue, ticket, ok)
  else if (queueEvent == CollectFallback) BQ::canCollectFallback(s.queue, ticket)
  else if (queueEvent == FinishWork) BQ::canFinishBatchWork(s.queue)
  else if (queueEvent == ObserveWork) ok and BQ::canObserveDrain(s.queue, ok)
  else if (queueEvent == FinishFlush) s.flushTicket == 0 and BQ::canFinishUrgentFlush(s.queue)
  else if (queueEvent == ObserveFlush) ok and BQ::canObserveUrgentFlush(s.queue, ok)
  else if (queueEvent == RetryDisposal) s.stopId != 0 and not(s.startPending) and s.stopWaiters.some(waiter => waiter.id == s.stopId and not(waiter.disposalStarted) and not(waiter.done)) and BQ::canRetryDisposal(s.queue)
  else s.stopId != 0 and BQ::canFinishTaskRemoval(s.queue, ok)
pure def lateCollectionMayDispose(job: PiiJob, queue: BQ::BatchQueue, queuePresent: bool): bool = not(queuePresent) and job.id != "" and P::canDispose(job.work) and not(queue.active.some(active => active.payload == job.id and (active.phase == BQ::NeedsFallback or active.phase == BQ::FallbackRunning)))
pure def driveQueue(s: PrivacyService, queueEvent: PiiQueueEvent, ticket: int, ok: bool): PrivacyService = {
  val job = ticketJob(s, ticket)
  val beforeWork = if (s.markers.contains(job.key)) { ...job.work, marker: true, mapPersisted: true } else job.work
  val work = if (queueEvent == StartAttempt) P::drain(beforeWork) else job.work
  val queue = if (queueEvent == BeginDrain) BQ::beginDrain(s.queue) else if (queueEvent == ProbeSucceeded or queueEvent == ProbeFailed) BQ::finishCapabilityProbe(s.queue, queueEvent == ProbeSucceeded, false) else if (queueEvent == StartFallback) BQ::startFallback(s.queue, ticket, 0) else if (queueEvent == StartAttempt) BQ::startFallbackAttempt(s.queue, ticket) else if (queueEvent == FinishBackoff) BQ::finishFallbackBackoff(s.queue, ticket) else if (queueEvent == FinishExhaustion) BQ::finishFallbackExhaustion(s.queue, ticket, ok) else if (queueEvent == CollectFallback) BQ::collectFallback(s.queue, ticket) else if (queueEvent == FinishWork) BQ::finishBatchWork(s.queue) else if (queueEvent == ObserveWork) BQ::observeDrain(s.queue, ok) else if (queueEvent == FinishFlush) BQ::finishUrgentFlush(s.queue) else if (queueEvent == ObserveFlush) BQ::observeUrgentFlush(s.queue, ok) else if (queueEvent == RetryDisposal) BQ::retryDisposal(s.queue) else BQ::finishTaskRemoval(s.queue, ok)
  val finalWork = if (queueEvent == CollectFallback and lateCollectionMayDispose(job, queue, s.queuePresent)) P::dispose(work) else work
  { ...replaceJob({ ...job, work: finalWork }, s), queue: queue, stopWaiters: if (queueEvent == RetryDisposal) markDisposalStarted(s) else s.stopWaiters }
}
pure def lawDetachedCollectionPreservesSettlement(s: PrivacyService, ticket: int, ok: bool): bool = {
  val job = ticketJob(s, ticket)
  val after = driveQueue(s, CollectFallback, ticket, ok)
  val finalWork = jobAt(after, job.id).work
  val terminalProcessor = s.queue.processor.items.some(entry => entry.id == ticket and (entry.phase == B::ItemSucceeded or entry.phase == B::ItemFailed))
  val terminalTicket = after.queue.active.some(entry => entry.ticket == ticket and (entry.phase == BQ::BatchItemSucceeded or entry.phase == BQ::BatchItemFailed))
  (alwaysJobIdsAreUnique(s) and canDriveQueue(s, CollectFallback, ticket, ok) and lateCollectionMayDispose(job, after.queue, s.queuePresent)) implies
    terminalProcessor and terminalTicket and finalWork.life == P::Stopped and finalWork.phase == P::Idle and finalWork.accepted == job.work.accepted and finalWork.processed == job.work.processed and finalWork.failed == job.work.failed and finalWork.marker == job.work.marker and after.markers.subseteq(s.markers) and s.markers.subseteq(after.markers)
}
```

### Stop captures lazy startup, flushes eligible work and finalizes its own promise

Stop closes admission before awaiting the current lazy-start promise. A failed start still permits disposal. Normal stop flushes urgent queued items with one attempt each; fast stop discards queued work explicitly. Already active processor calls retain their job owner until settlement. Concurrent stop calls share the current promise; its finalizer clears the slot even on failure, so a later call may retry disposal.

Discovered by simulation: retrying a failed removal while its original stop promise was still pending admitted a loop in which that promise never settled. The source awaits one disposal call per stop identity. A failed removal settles that promise with failure; a fresh stop identity may then retry.

```quint
pure def stop(s: PrivacyService): PrivacyService = {
  val identity = if (s.stopId == 0) s.nextPromise else s.stopId
  { ...s, stopping: true, handlerRegistered: false, stopId: identity, nextPromise: if (s.stopId == 0) s.nextPromise + 1 else s.nextPromise, stopWaiters: if (s.stopId == 0) s.stopWaiters.append({ id: identity, startId: s.startId, disposalStarted: false, done: false, failed: false }) else s.stopWaiters, jobs: s.jobs.listMap(job => if (job.work.life == P::Open) { ...job, work: P::stop(job.work) } else job) }
}
pure def markDisposalStarted(s: PrivacyService): List[StopWaiter] = s.stopWaiters.listMap(waiter => if (waiter.id == s.stopId) { ...waiter, disposalStarted: true } else waiter)
pure def canBeginDisposal(s: PrivacyService, fast: bool): bool = s.stopId != 0 and not(s.startPending) and s.queuePresent and s.stopWaiters.some(waiter => waiter.id == s.stopId and not(waiter.disposalStarted) and not(waiter.done)) and BQ::canBeginDispose(s.queue, not(fast))
pure def beginDisposal(s: PrivacyService, fast: bool): PrivacyService = { ...s, queue: BQ::beginDispose(if (fast) { ...s.queue, queue: Q::clearQueue(s.queue.queue) } else s.queue, not(fast)), stopWaiters: markDisposalStarted(s) }
pure def urgentTicket(s: PrivacyService): int = s.queue.flush.select(entry => entry.phase == BQ::NeedsFallback).nthOr(0, emptyBatchTicket).ticket
pure def canBeginUrgentItem(s: PrivacyService): bool = s.flushTicket == 0 and s.queue.disposePhase == BQ::FlushPending and s.queue.flush.some(entry => entry.phase == BQ::NeedsFallback) and P::canDrain(ticketJob(s, urgentTicket(s)).work)
pure def beginUrgentItem(s: PrivacyService): PrivacyService = {
  val ticket = urgentTicket(s)
  val job = ticketJob(s, ticket)
  val work = if (s.markers.contains(job.key)) { ...job.work, marker: true, mapPersisted: true } else job.work
  { ...replaceJob({ ...job, work: P::drain(work) }, s), flushTicket: ticket }
}
pure def canFinishUrgentItem(s: PrivacyService, ok: bool): bool = s.flushTicket != 0 and BQ::canFlushUrgentItem(s.queue, ok) and (if (ok) ticketJob(s, s.flushTicket).work.processed > 0 else P::canAttemptFailed(ticketJob(s, s.flushTicket).work))
pure def finishUrgentItem(s: PrivacyService, ok: bool): PrivacyService = { ...replaceJob({ ...ticketJob(s, s.flushTicket), work: if (ok) ticketJob(s, s.flushTicket).work else terminalFailure(ticketJob(s, s.flushTicket).work.failed + 1, ticketJob(s, s.flushTicket).work) }, s), queue: BQ::flushUrgentItem(s.queue, ok), flushTicket: 0 }
pure def canCompleteStop(s: PrivacyService): bool = s.stopId != 0 and not(s.stopWaiters.some(waiter => waiter.id == s.stopId and waiter.done)) and not(s.startPending) and (not(s.queuePresent) or s.queue.disposePhase == BQ::QueueDisposed or (s.queue.disposePhase == BQ::DisposeFailed and s.stopWaiters.some(waiter => waiter.id == s.stopId and waiter.disposalStarted)))
pure def completeStop(s: PrivacyService): PrivacyService = {
  val failed = s.queuePresent and s.queue.disposePhase == BQ::DisposeFailed
  { ...s, queuePresent: if (failed) s.queuePresent else false, startId: if (failed) s.startId else 0, stopWaiters: s.stopWaiters.listMap(waiter => if (waiter.id == s.stopId) { ...waiter, done: true, failed: failed } else waiter), jobs: s.jobs.listMap(job => if (not(failed) and P::canDispose(job.work) and not(s.queue.active.some(active => active.payload == job.id and (active.phase == BQ::NeedsFallback or active.phase == BQ::FallbackRunning)))) { ...job, work: P::dispose(job.work) } else job) }
}
pure def canFinalizeStop(s: PrivacyService): bool = s.stopId != 0 and s.stopWaiters.some(waiter => waiter.id == s.stopId and waiter.done)
pure def finalizeStop(s: PrivacyService): PrivacyService = { ...s, stopId: 0 }
pure def alwaysPromiseIdentitiesAreValid(s: PrivacyService): bool = s.nextPromise > 0 and s.startId >= 0 and s.startId < s.nextPromise and s.stopId >= 0 and s.stopId < s.nextPromise and (s.startPending implies s.startId > 0) and s.stopWaiters.every(waiter => waiter.id > 0 and waiter.id < s.nextPromise and s.stopWaiters.select(other => other.id == waiter.id).length() == 1)
pure def alwaysEveryJobRetainsSettlement(s: PrivacyService): bool = s.jobs.every(job => P::alwaysAcceptedWorkIsAccounted(job.work) and P::alwaysCompletionRequiresPersistentMarker(job.work) and P::alwaysCountsAreNonnegative(job.work))
pure def alwaysQueueReferencesKnownJobs(s: PrivacyService): bool = Q::queuedItems(s.queue.queue).every(entry => jobAt(s, entry.payload).id != "") and s.queue.active.concat(s.queue.flush).every(entry => jobAt(s, entry.payload).id != "")
pure def alwaysCommittedJobHasSharedMarker(s: PrivacyService): bool = s.jobs.every(job => job.work.marker implies s.markers.contains(job.key))
pure def alwaysJobIdsAreUnique(s: PrivacyService): bool = s.jobs.every(job => job.id != "" and s.jobs.select(other => other.id == job.id).length() == 1)
pure def stepJoiningStopKeepsIdentity(before: PrivacyService, via: str, after: PrivacyService): bool = via != "stop" or before.stopId == 0 or after.stopId == before.stopId
pure def sometimesDuplicateInitialMisses(s: PrivacyService): bool = s.jobs.some(job => job.work.accepted > 0 and s.jobs.some(other => other.id != job.id and other.key == job.key and other.work.accepted > 0))
pure def sometimesLaterStopRetriesAfterFailure(s: PrivacyService): bool = s.stopWaiters.some(waiter => waiter.id == s.stopId and waiter.disposalStarted and not(waiter.done)) and s.stopWaiters.some(waiter => waiter.id < s.stopId and waiter.done and waiter.failed)
pure def sometimesTwoScrubsOverlap(s: PrivacyService): bool = s.jobs.select(job => P::active(job.work) > 0).length() > 1
pure val fair_startResult = "weak"
pure val fair_beginDisposal = "weak"
pure val fair_beginUrgentItem = "weak"
pure val fair_scrubbed = "weak"
pure val fair_persistMap = "weak"
pure val fair_confirmMarker = "weak"
pure val fair_observeCompletion = "weak"
pure val fair_finishAttempt = "weak"
pure val fair_finishUrgentItem = "weak"
pure val fair_driveQueue = "weak"
pure val fair_completeStop = "weak"
pure val fair_finalizeStop = "weak"
pure def leadsToStopAttemptSettles(s: PrivacyService, later: PrivacyService): bool = s.stopId != 0 implies later.stopWaiters.some(waiter => waiter.id == s.stopId and waiter.done)
```
