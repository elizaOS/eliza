# Eager service startup retries

`RuntimeServiceLifecycle.startServiceEagerly` in `packages/core/src/runtime/service-lifecycle.ts:42-89` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` catches startup rejection and retries after exactly 2000, 5000 and 10000 milliseconds. A fulfilled null result ends eager startup; shutdown before or after a delay prevents the next attempt. Direct acquisition retains its separate unbounded caller API.

## Story: Retry transient eager startup without restarting shutdown work

As a host I start eager services through the same shared acquisition and instance owner, with at most four eager acquisition attempts. Each failed attempt is observable; the fourth failure terminates the eager operation.

### Backoff starts only after rejection and uses the declared delay sequence

Discovered by the proof. A ready job has made fewer than four acquisition
attempts. A job awaiting the result has at least one more acquired attempt
than previously observed failures. Initial admission starts with zero attempts and only a backoff
continuation may make a previous attempt ready to retry. Unique eager job IDs keep wakeup on the one observed job and its captured deadline.

The host observes elapsed time on a monotonic clock. Every backoff has
its own deadline and can expire after any earlier clock observation.

```quint
import serviceInstances as I from "./serviceInstances"
type EagerPhase = EagerReady | EagerWaiting | EagerBackoff | EagerDone
type EagerRequest = {id: int, serviceType: str, phase: EagerPhase, attempts: int, callId: int, wakeAt: int, failures: int}
type EagerServices = {services: I::ServiceInstances, jobs: List[EagerRequest], now: int, nextCall: int}
pure val initial: EagerServices = {services: I::initial, jobs: List(), now: 0, nextCall: 1}
pure val jobIdValues = Set(1, 2)
pure val classIdValues = I::classIdValues
pure val serviceTypeValues = I::serviceTypeValues
pure val attemptIdValues = I::attemptIdValues
pure val instanceIdValues = I::instanceIdValues
pure val errorIdValues = I::errorIdValues
pure val elapsedMsValues = Set(0, 1, 1999, 2000, 5000, 10000)
pure val missingEagerJob: EagerRequest = {id: 0, serviceType: "", phase: EagerDone, attempts: 0, callId: 0, wakeAt: 0, failures: 0}
pure def eagerJob(s: EagerServices, jobId: int): EagerRequest = s.jobs.select(j => j.id == jobId).nthOr(0, missingEagerJob)
pure def retryDelay(attempts: int): int = if (attempts == 1) 2000 else if (attempts == 2) 5000 else if (attempts == 3) 10000 else 0
pure def canRegisterClass(s: EagerServices, classId: int, serviceType: str): bool = I::canRegisterClass(s.services, classId, serviceType)
pure def registerClass(s: EagerServices, classId: int, serviceType: str): EagerServices = { ...s, services: I::registerClass(s.services, classId, serviceType) }
pure def canFinishInitialization(s: EagerServices, ok: bool): bool = I::canFinishInitialization(s.services, ok)
pure def finishInitialization(s: EagerServices, ok: bool): EagerServices = { ...s, services: I::finishInitialization(s.services, ok) }
pure def canResumeAcquire(s: EagerServices, jobId: int): bool = I::canResumeAcquire(s.services, eagerJob(s, jobId).callId)
pure def resumeAcquire(s: EagerServices, jobId: int): EagerServices = { ...s, services: I::resumeAcquire(s.services, eagerJob(s, jobId).callId) }
pure def canStartEager(s: EagerServices, jobId: int, serviceType: str): bool = jobId > 0 and not(s.jobs.some(j => j.id == jobId))
pure def startEager(s: EagerServices, jobId: int, serviceType: str): EagerServices = { ...s, jobs: s.jobs.append({id: jobId, serviceType: serviceType, phase: EagerReady, attempts: 0, callId: 0, wakeAt: 0, failures: 0}) }
pure def canAcquireEager(s: EagerServices, jobId: int): bool = eagerJob(s, jobId).phase == EagerReady and I::canAcquireServices(s.services, s.nextCall, eagerJob(s, jobId).serviceType)
pure def acquireEager(s: EagerServices, jobId: int): EagerServices = {
  val j = eagerJob(s, jobId)
  { ...s, services: I::acquireServices(s.services, s.nextCall, j.serviceType), jobs: s.jobs.listMap(x => if (x.id == jobId) { ...x, phase: EagerWaiting, attempts: x.attempts + 1, callId: s.nextCall } else x), nextCall: s.nextCall + 1 }
}
pure def canReturnInstance(s: EagerServices, attemptId: int, instanceId: int): bool = I::canReturnInstance(s.services, attemptId, instanceId)
pure def returnInstance(s: EagerServices, attemptId: int, instanceId: int): EagerServices = { ...s, services: I::returnInstance(s.services, attemptId, instanceId) }
pure def canFailStart(s: EagerServices, attemptId: int, errorId: str): bool = I::canFailStart(s.services, attemptId, errorId)
pure def failStart(s: EagerServices, attemptId: int, errorId: str): EagerServices = { ...s, services: I::failStart(s.services, attemptId, errorId) }
pure def canFinishObserver(s: EagerServices, attemptId: int, ok: bool): bool = I::canFinishObserver(s.services, attemptId, ok)
pure def finishObserver(s: EagerServices, attemptId: int, ok: bool): EagerServices = { ...s, services: I::finishObserver(s.services, attemptId, ok) }
pure def canSettleEagerAggregate(s: EagerServices, jobId: int): bool = I::canSettleTypeAggregate(s.services, eagerJob(s, jobId).callId)
pure def settleEagerAggregate(s: EagerServices, jobId: int): EagerServices = { ...s, services: I::settleTypeAggregate(s.services, eagerJob(s, jobId).callId) }
pure def canClearEagerAggregate(s: EagerServices, jobId: int): bool = I::canClearTypeAggregate(s.services, eagerJob(s, jobId).callId)
pure def clearEagerAggregate(s: EagerServices, jobId: int): EagerServices = { ...s, services: I::clearTypeAggregate(s.services, eagerJob(s, jobId).callId) }
pure def canSettleAcquire(s: EagerServices, jobId: int): bool = eagerJob(s, jobId).phase == EagerWaiting and I::canSettleAcquire(s.services, eagerJob(s, jobId).callId)
pure def settleAcquire(s: EagerServices, jobId: int): EagerServices = { ...s, services: I::settleAcquire(s.services, eagerJob(s, jobId).callId) }
pure def canObserveAcquire(s: EagerServices, jobId: int): bool = eagerJob(s, jobId).phase == EagerWaiting and I::acquireCall(s.services, eagerJob(s, jobId).callId).status != I::AcquireWaiting and I::acquireCall(s.services, eagerJob(s, jobId).callId).status != I::AcquireWaitingInit
pure def observeAcquire(s: EagerServices, jobId: int): EagerServices = {
  val j = eagerJob(s, jobId)
  val failed = I::acquireCall(s.services, j.callId).status == I::AcquireFailed
  val retry = failed and j.attempts < 4 and not(s.services.stopped)
  { ...s, jobs: s.jobs.listMap(x => if (x.id == jobId) { ...x, phase: if (retry) EagerBackoff else EagerDone, wakeAt: if (retry) s.now + retryDelay(x.attempts) else 0, failures: x.failures + (if (failed) 1 else 0) } else x) }
}
pure def canWakeEager(s: EagerServices, jobId: int): bool = eagerJob(s, jobId).phase == EagerBackoff and s.now >= eagerJob(s, jobId).wakeAt
pure def wakeEager(s: EagerServices, jobId: int): EagerServices = { ...s, jobs: s.jobs.listMap(j => if (j.id == jobId) { ...j, phase: if (s.services.stopped) EagerDone else EagerReady } else j) }
pure def canAdvanceClock(s: EagerServices, elapsedMs: int): bool = elapsedMs >= 0
pure def advanceClock(s: EagerServices, elapsedMs: int): EagerServices = { ...s, now: s.now + elapsedMs }
pure def canStopRuntime(s: EagerServices): bool = I::canStopRuntime(s.services)
pure def stopRuntime(s: EagerServices): EagerServices = { ...s, services: I::stopRuntime(s.services) }
pure def canInvokeObjectStop(s: EagerServices, instanceId: int): bool = I::canInvokeObjectStop(s.services, instanceId)
pure def invokeObjectStop(s: EagerServices, instanceId: int): EagerServices = { ...s, services: I::invokeObjectStop(s.services, instanceId) }
pure def canSettleObjectStop(s: EagerServices, instanceId: int, ok: bool, errorId: str): bool = I::canSettleObjectStop(s.services, instanceId, ok, errorId)
pure def settleObjectStop(s: EagerServices, instanceId: int, ok: bool, errorId: str): EagerServices = { ...s, services: I::settleObjectStop(s.services, instanceId, ok, errorId) }
pure def canFinishLateStart(s: EagerServices, attemptId: int): bool = I::canFinishLateStart(s.services, attemptId)
pure def finishLateStart(s: EagerServices, attemptId: int): EagerServices = { ...s, services: I::finishLateStart(s.services, attemptId) }
pure def alwaysEagerAttemptLimit(s: EagerServices): bool = s.jobs.every(j => j.attempts >= 0 and j.attempts <= 4 and j.failures >= 0 and j.failures <= j.attempts and (j.phase == EagerBackoff implies j.attempts > 0 and j.attempts < 4) and (j.phase == EagerReady implies j.attempts < 4) and (j.phase == EagerWaiting implies j.failures < j.attempts))
pure def alwaysEagerJobsUnique(s: EagerServices): bool = s.jobs.every(j => j.id > 0 and s.jobs.select(other => other.id == j.id).length() == 1)
pure def alwaysSharedServiceStateValid(s: EagerServices): bool = I::alwaysTypeEntriesUnique(s.services) and I::alwaysTypeReferencesRetained(s.services) and I::alwaysAggregateAndLoadIdsUnique(s.services) and I::alwaysAcquisitionIdsUnique(s.services) and I::alwaysInitWaitingHasNoAggregate(s.services) and I::alwaysClassAndObjectIdentities(s.services) and I::alwaysPendingAttemptsOwned(s.services) and I::alwaysCapturedAttemptsExist(s.services) and I::alwaysDeclarationsMatch(s.services) and I::alwaysObjectStopOnce(s.services) and I::alwaysClassOwnsKnownObjects(s.services) and I::alwaysPublicationIdentitiesValid(s.services) and I::alwaysAttemptGeneration(s.services) and I::alwaysStoppedHasNoPublication(s.services) and I::alwaysFailedTypeHasNoPublication(s.services)
pure def stepNoEarlyWake(before: EagerServices, via: str, after: EagerServices): bool = via == "wakeEager" implies before.jobs.every(j => j.phase == EagerBackoff and before.now < j.wakeAt implies after.jobs.includes(j))
pure val weight_acquireEager = 16
pure val weight_failStart = 24
pure val weight_settleAcquire = 24
pure val weight_observeAcquire = 24
pure val weight_wakeEager = 24
pure val weight_advanceClock = 4
pure def sometimesSecondAttemptAfterDelay(s: EagerServices): bool = s.jobs.some(j => j.attempts == 2 and s.now >= 2000)
pure def sometimesStoppedDuringBackoff(s: EagerServices): bool = s.services.stopped and s.jobs.some(j => j.phase == EagerBackoff)
pure def sometimesFourFailuresTerminate(s: EagerServices): bool = s.jobs.some(j => j.phase == EagerDone and j.failures == 4)
```
