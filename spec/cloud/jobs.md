# Background jobs

The cloud runs detached jobs, such as provisioning a hosted agent, on a pool
of workers. A worker claims a due job under a fresh generation and a lease,
writes only while it holds the current lease, and settles the job, retries
it within its budget or loses it to recovery once its lease has lapsed. One
job is the state machine. The shared running limit, the clock that sets
deadlines and the fence on dependent provider writes are stated as laws.
Provider effects already sent are outside the model: cancelling a job never
retracts them. Cloud-hosted application jobs are not part of this package.

Develop sources: the cloud `JobExecutionLease`, `JobRetryBudgets`,
`JobSharedCapacity`, `job_time_authority` and `provisioning_execution`
models.

## Story: Run a job under exactly one current lease

> As an operator, I want every job run by one worker at a time, and a worker
> that lost its lease unable to change the job or its resources.

### A worker claims a due job under a new generation and lease

```quint
type JobStatus = JobPending | JobRunning | JobCompleted | JobFailed | JobCancelled
type LeaseAge = LeaseLive | LeaseLapsing | LeaseExpired
type JobOperation = AttemptFailed | AttemptTimedOut | WorkerRestarted | JobRequeued
type JobOutcome = OutcomeCompleted | OutcomeCancelled
type Job = { status: JobStatus, generation: int, leaseOwner: int, leaseAge: LeaseAge, quiesced: bool, aged: bool, due: bool, resourceFence: int, payload: int, lastWriter: int, lastWriteGeneration: int, attempts: int, interruptions: int, requeues: int, rejected: bool, retryDelay: int }
pure val initial: Job = { status: JobPending, generation: 0, leaseOwner: 0, leaseAge: LeaseLive, quiesced: false, aged: false, due: true, resourceFence: 0, payload: 0, lastWriter: 0, lastWriteGeneration: 0, attempts: 0, interruptions: 0, requeues: 0, rejected: false, retryDelay: 0 }
pure def terminal(status: JobStatus): bool = status == JobCompleted or status == JobFailed or status == JobCancelled
pure def canClaimJob(j: Job, worker: int): bool = j.status == JobPending and j.due and worker > 0
pure def claimJob(j: Job, worker: int): Job = { ...j, status: JobRunning, generation: j.generation + 1, leaseOwner: worker, leaseAge: LeaseLive, quiesced: false, aged: false }
pure val workerValues = Set(1, 2)
pure val generationValues = Set(1, 2)
pure def alwaysLeaseBelongsToARunningGeneration(j: Job): bool = j.leaseOwner != 0 implies (j.status == JobRunning and not(j.quiesced) and j.generation > 0)
pure def alwaysRunningJobHasItsOwner(j: Job): bool = j.status == JobRunning implies (j.leaseOwner != 0 and not(j.quiesced))
pure def alwaysSettledJobHasNoLease(j: Job): bool = terminal(j.status) implies j.leaseOwner == 0
pure def sometimesSecondGenerationRuns(j: Job): bool = j.status == JobRunning and j.generation == 2
```

### Only the current lease writes, and a matching owner may renew a lapsing lease

A lease is current for one worker and generation while the job is running,
not quiesced, and the lease is live. A lapsed lease passes through a takeover
period and then expires; until recovery takes the job, its owner may renew
it. The job's payload and its resource fence change only under the current
lease, and the fence never names another generation.

```quint
pure def currentLease(j: Job, worker: int, generation: int): bool =
  generation > 0 and j.status == JobRunning and not(j.quiesced) and j.generation == generation and j.leaseOwner == worker and j.leaseAge == LeaseLive
pure def canExpireLease(j: Job): bool = j.status == JobRunning and j.leaseAge == LeaseLive
pure def expireLease(j: Job): Job = { ...j, leaseAge: LeaseLapsing }
pure def canEndTakeoverWindow(j: Job): bool = j.status == JobRunning and j.leaseAge == LeaseLapsing
pure def endTakeoverWindow(j: Job): Job = { ...j, leaseAge: LeaseExpired }
pure def canAgeJob(j: Job): bool = j.status == JobRunning and not(j.aged)
pure def ageJob(j: Job): Job = { ...j, aged: true }
pure def canRenewLease(j: Job, worker: int, generation: int): bool = j.status == JobRunning and not(j.quiesced) and j.generation == generation and j.leaseOwner == worker and j.leaseAge != LeaseLive
pure def renewLease(j: Job, worker: int, generation: int): Job = { ...j, leaseAge: LeaseLive }
pure def canAcquireResource(j: Job, worker: int, generation: int): bool = currentLease(j, worker, generation) and j.resourceFence == 0
pure def acquireResource(j: Job, worker: int, generation: int): Job = { ...j, resourceFence: generation }
pure def canMutateJob(j: Job, worker: int, generation: int, value: int): bool = currentLease(j, worker, generation)
pure def mutateJob(j: Job, worker: int, generation: int, value: int): Job = { ...j, payload: value, lastWriter: worker, lastWriteGeneration: generation }
pure val valueValues = Set(0, 1)
pure def alwaysFenceNamesThisGeneration(j: Job): bool = j.resourceFence == 0 or j.resourceFence == j.generation
pure def stepOnlyTheCurrentLeaseWrites(before: Job, after: Job): bool =
  (after.lastWriter != before.lastWriter or after.lastWriteGeneration != before.lastWriteGeneration or after.payload != before.payload) implies
    currentLease(before, after.lastWriter, after.lastWriteGeneration)
pure def sometimesOldJobWritesUnderARenewedLease(j: Job): bool = j.status == JobRunning and j.leaseAge == LeaseLive and j.aged and j.lastWriter > 0
```

### A job settles once, under its current lease and its own fence

The current lease settles the job as completed or cancelled, or rejects it
as failed, releasing the lease and the job's own resource fence together.

```quint
pure def canSettleJob(j: Job, worker: int, generation: int, jobOutcome: JobOutcome): bool = currentLease(j, worker, generation)
pure def settleJob(j: Job, worker: int, generation: int, jobOutcome: JobOutcome): Job =
  { ...j, status: if (jobOutcome == OutcomeCompleted) JobCompleted else JobCancelled, quiesced: true, leaseOwner: 0, leaseAge: LeaseLive, resourceFence: 0 }
pure def canRejectJob(j: Job, worker: int, generation: int): bool = currentLease(j, worker, generation)
pure def rejectJob(j: Job, worker: int, generation: int): Job = { ...j, status: JobFailed, rejected: true, quiesced: true, leaseOwner: 0, leaseAge: LeaseLive, resourceFence: 0 }
pure def stepSettledJobStaysSettled(before: Job, after: Job): bool = terminal(before.status) implies after.status == before.status
pure def sometimesJobCompleted(j: Job): bool = j.status == JobCompleted and j.generation == 2
```

### Recovery takes only an old job whose lease has expired

Recovery returns a running job to pending only when the job is old and its
lease is past the takeover window, and releases the job's own fence. It cannot
take a job whose owner renewed in time.

```quint
pure def canRecoverJob(j: Job): bool = j.status == JobRunning and j.aged and j.leaseAge == LeaseExpired
pure def recoverJob(j: Job): Job = { ...j, status: JobPending, quiesced: true, leaseOwner: 0, leaseAge: LeaseLive, resourceFence: 0, due: true }
pure def stepRecoveryOnlyAfterExpiry(before: Job, after: Job): bool =
  (before.status == JobRunning and after.status == JobPending and after.attempts == before.attempts and after.interruptions == before.interruptions and after.requeues == before.requeues) implies
    (before.aged and before.leaseAge == LeaseExpired)
pure def sometimesRecoveredJobReclaimed(j: Job): bool = j.status == JobRunning and j.generation == 2 and j.attempts == 0
```

## Story: Retry a failed job within its budget

> As an operator, I want a failing job retried with growing delays, and
> given up only when its own budget for that kind of failure is spent.

### Each failure spends exactly one budget and an exhausted budget fails the job

A failed attempt or a timeout spends an attempt; a worker restart spends an
interruption; a requeue spends a requeue. A job fails when it has made three
attempts, been interrupted more than five times, or been requeued more than
five times, and only then, or when it was rejected. An attempt and a requeue
are written back by the current lease; a timeout and a restart are recovery
of an old job whose lease has expired. A retried attempt waits 30, 120 or
480 seconds; a requeue waits 120 seconds; a recovery is due at once.

```quint
pure val maxAttempts = 3
pure val maxInterruptions = 5
pure val maxRequeues = 5
pure def exhausted(j: Job): bool = j.attempts >= maxAttempts or j.interruptions > maxInterruptions or j.requeues > maxRequeues
pure def recoveryOperation(operation: JobOperation): bool = operation == AttemptTimedOut or operation == WorkerRestarted
pure def backoffSeconds(attempts: int): int = if (attempts <= 1) 30 else if (attempts == 2) 120 else 480
pure def spend(operation: JobOperation, j: Job): Job =
  { ...j, attempts: j.attempts + (if (operation == AttemptFailed or operation == AttemptTimedOut) 1 else 0), interruptions: j.interruptions + (if (operation == WorkerRestarted) 1 else 0), requeues: j.requeues + (if (operation == JobRequeued) 1 else 0) }
pure def canFinishAttempt(j: Job, worker: int, generation: int, operation: JobOperation): bool =
  if (recoveryOperation(operation)) (j.status == JobRunning and j.generation == generation and j.aged and j.leaseAge == LeaseExpired)
  else currentLease(j, worker, generation)
pure def finishAttempt(j: Job, worker: int, generation: int, operation: JobOperation): Job = {
  val spent = spend(operation, j)
  val failed = exhausted(spent)
  val delay = if (failed or recoveryOperation(operation)) 0 else if (operation == AttemptFailed) backoffSeconds(spent.attempts) else 120
  { ...spent, status: if (failed) JobFailed else JobPending, leaseOwner: 0, leaseAge: LeaseLive, quiesced: true, resourceFence: 0, due: delay == 0, retryDelay: delay }
}
pure def canDelayEnds(j: Job): bool = j.status == JobPending and not(j.due)
pure def delayEnds(j: Job): Job = { ...j, due: true }
pure def alwaysFailureNeedsSpentBudget(j: Job): bool = j.status == JobFailed implies (exhausted(j) or j.rejected)
pure def alwaysSpentBudgetFailsTheJob(j: Job): bool = exhausted(j) implies j.status == JobFailed
pure def alwaysBudgetsStayInRange(j: Job): bool =
  j.attempts >= 0 and j.attempts <= maxAttempts and j.interruptions >= 0 and j.interruptions <= maxInterruptions + 1 and j.requeues >= 0 and j.requeues <= maxRequeues + 1
pure def stepEachFailureSpendsOneBudget(before: Job, via: str, after: Job): bool =
  via == "finishAttempt" implies (after.attempts - before.attempts) + (after.interruptions - before.interruptions) + (after.requeues - before.requeues) == 1
pure def stepBackoffFollowsTheAttempt(before: Job, via: str, after: Job): bool =
  (via == "finishAttempt" and after.status == JobPending and after.attempts > before.attempts and after.retryDelay > 0) implies after.retryDelay == backoffSeconds(after.attempts)
pure def sometimesJobFailsOnAttempts(j: Job): bool = j.status == JobFailed and j.attempts == maxAttempts
pure def sometimesRetriedAfterBackoff(j: Job): bool = j.status == JobPending and j.due and j.attempts == 1 and j.generation == 1
pure val weight_claimJob = 4
pure val weight_finishAttempt = 4
pure val weight_delayEnds = 3
```

## Story: Share workers and clocks safely

> As an operator, I want the pool to respect its running limit, deadlines to
> come from one clock, and provider-side writes to follow the job's lease.

### A claim never starts more jobs than the shared running limit allows

A batch claim counts the running jobs of the shared types under a lock and
claims at most what is left below the limit of three, and never a negative
number.

```quint
pure val sharedRunningLimit = 3
pure def claimBudget(requested: int, running: int): int =
  if (running >= sharedRunningLimit or requested <= 0) 0 else if (requested < sharedRunningLimit - running) requested else sharedRunningLimit - running
pure def lawClaimsStayWithinTheLimit(requested: int, running: int): bool =
  claimBudget(requested, running) >= 0 and (running >= 0 implies (running + claimBudget(requested, running) <= sharedRunningLimit or claimBudget(requested, running) == 0))
```

### Deadlines come from the database clock read after the lock

A retry deadline is the database's clock plus the delay, whatever the host's
clock says. A renewal reads the clock after it holds the job's lock, so a
renewal that waited for the lock still ends in the future.

```quint
pure def retryDueAt(databaseNow: int, delay: int): int = databaseNow + delay
pure def renewedExpiry(lockedAt: int, lease: int): int = lockedAt + lease
pure def lawRetryDeadlineIgnoresTheHostClock(databaseNow: int, delay: int, hostOffset: int): bool = retryDueAt(databaseNow, delay) == databaseNow + delay
pure def lawRenewalEndsAfterTheLock(lockedAt: int, lease: int): bool = lease > 0 implies renewedExpiry(lockedAt, lease) > lockedAt
```

### A provider result is written back only while the job still owns its lease

A provider call already sent may finish after the job lost its lease.
Writing its result back locks the job, the lease and the resource, then
checks on the database clock that the same generation still owns an
unexpired lease; otherwise the write is refused.

```quint
type DependentWrite = { sameGeneration: bool, ownerMatches: bool, quiesced: bool, now: int, expiry: int }
pure def dependentWriteAdmitted(dependentWrite: DependentWrite): bool =
  dependentWrite.sameGeneration and dependentWrite.ownerMatches and not(dependentWrite.quiesced) and dependentWrite.now < dependentWrite.expiry
pure def lawExpiredLeaseCannotWriteBack(dependentWrite: DependentWrite): bool = dependentWrite.now >= dependentWrite.expiry implies not(dependentWriteAdmitted(dependentWrite))
pure def lawRecoveredJobCannotWriteBack(dependentWrite: DependentWrite): bool = (dependentWrite.quiesced or not(dependentWrite.sameGeneration)) implies not(dependentWriteAdmitted(dependentWrite))
pure val dependentWriteValues = Set(
  { sameGeneration: true, ownerMatches: true, quiesced: false, now: 1, expiry: 2 },
  { sameGeneration: true, ownerMatches: true, quiesced: false, now: 2, expiry: 2 },
  { sameGeneration: false, ownerMatches: true, quiesced: false, now: 0, expiry: 2 },
  { sameGeneration: true, ownerMatches: true, quiesced: true, now: 0, expiry: 2 })
```
