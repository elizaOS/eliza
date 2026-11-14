# Task scheduling and retirement

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/task.ts`, `services/task-scheduler.ts`, `types/task.ts`, `utils/task-scheduling.ts`, and the TaskService, TaskScheduler, TaskSchedulerQueryDrain and TaskRetirement Quint models. The aggregate machine models one task, one service registration and its current query. Existing concurrency models retain the multiple-runner and detached-generation interleavings as separate reference obligations.

## Story: Execute due work within its owning agent

As a host, I use the existing process scheduler or drive due work directly. The scheduler queries the requested agent set, verifies generation and registration identity after awaits, and dispatches each task only to its owning agent. One-shots and blocking repeats have exclusive execution across timer, daemon, runDueTasks, executeTaskById and resumeTask paths.

### A query captures its generation and registration before awaiting storage

```quint
type Phase = Idle | Querying | Selected | Executing
type Schedule = { phase: Phase, generation: int, registration: int, capturedGeneration: int, capturedRegistration: int, active: bool, closing: bool, closed: bool, pendingQuery: bool, exists: bool, repeating: bool, paused: bool, selectedPaused: bool, due: bool, wakeRevision: int, observedWake: int, wakePending: bool, failures: int, failed: bool, executions: int, consumedRuns: int, maxFailures: int, scopeValid: bool }
pure val initial: Schedule = { phase: Idle, generation: 0, registration: 0, capturedGeneration: 0, capturedRegistration: 0, active: false, closing: false, closed: false, pendingQuery: false, exists: false, repeating: false, paused: false, selectedPaused: false, due: false, wakeRevision: 0, observedWake: 0, wakePending: false, failures: 0, failed: false, executions: 0, consumedRuns: 0, maxFailures: 5, scopeValid: true }
pure def canRegister(s: Schedule): bool = not(s.active) and not(s.closing)
pure def register(s: Schedule): Schedule = { ...s, active: true, registration: s.registration + 1, generation: s.generation + 1 }
pure def canCreateTask(s: Schedule, repeating: bool, maxFailures: int): bool = s.phase == Idle and not(s.exists) and not(s.closing)
pure def createTask(s: Schedule, repeating: bool, maxFailures: int): Schedule = { ...s, exists: true, repeating: repeating, due: true, executions: 0, consumedRuns: 0, maxFailures: maxFailures, failures: 0, failed: false, paused: false, wakeRevision: 0, observedWake: 0, wakePending: false }
pure val maxFailuresValues = Set(0, 1, 5)
pure def canQuery(s: Schedule): bool = s.phase == Idle and s.active and not(s.closing) and s.exists
pure def query(s: Schedule): Schedule = { ...s, phase: Querying, pendingQuery: true, capturedGeneration: s.generation, capturedRegistration: s.registration }
pure def currentQuery(s: Schedule): bool = s.capturedGeneration == s.generation and s.capturedRegistration == s.registration and s.active and not(s.closing)
```

### Stale query results and out-of-scope tasks never become dispatchable

Discovered by the proof: a selected or executing snapshot has already passed
the scope check. An executing task still owns its row; one-shot deletion occurs
only when that execution settles. Retirement also keeps the service detached.

```quint
pure def canSettleQuery(s: Schedule, ownerMatches: bool, succeeded: bool): bool = s.phase == Querying
pure def settleQuery(s: Schedule, ownerMatches: bool, succeeded: bool): Schedule =
  if (currentQuery(s) and ownerMatches and succeeded) { ...s, phase: Selected, pendingQuery: false, selectedPaused: s.paused, observedWake: s.wakeRevision, scopeValid: true }
  else { ...s, phase: Idle, pendingQuery: false }
pure def canReplaceRegistration(s: Schedule): bool = not(s.closing)
pure def replaceRegistration(s: Schedule): Schedule = { ...s, registration: s.registration + 1, generation: s.generation + 1 }
pure def canSkipSelection(s: Schedule): bool = s.phase == Selected and (s.selectedPaused or not(s.due or s.wakePending) or not(currentQuery(s)))
pure def skipSelection(s: Schedule): Schedule = { ...s, phase: Idle }
pure def canExecute(s: Schedule): bool = s.phase == Selected and currentQuery(s) and s.exists and not(s.selectedPaused) and (s.due or s.wakePending)
pure def execute(s: Schedule): Schedule = { ...s, phase: Executing, executions: s.executions + 1 }
pure def stepDispatchUsesFreshOwnership(before: Schedule, via: str, after: Schedule): bool =
  via != "execute" or (currentQuery(before) and before.scopeValid and not(before.selectedPaused) and after.phase == Executing)
pure def alwaysSelectedScopeValid(s: Schedule): bool = (s.phase == Selected or s.phase == Executing) implies s.scopeValid
pure def alwaysExecutingRowExists(s: Schedule): bool = s.phase == Executing implies s.exists
pure def alwaysClosingDetached(s: Schedule): bool = s.closing implies not(s.active)
```

### Pausing affects later selections while admitted work retains its outcome

A pause persisted after a snapshot has been selected may allow that selected execution to finish. Metadata patches preserve keys written by other writers. A preserving worker releases its claim without consuming the row and may be invoked again. A one-shot rechecks existence after claiming its execution slot, so deletion prevents stale snapshots from executing again.

```quint
pure def canPause(s: Schedule): bool = s.exists and not(s.closed) and not(s.paused)
pure def pause(s: Schedule): Schedule = { ...s, paused: true }
pure def canResume(s: Schedule): bool = s.exists and not(s.closing) and s.paused
pure def resume(s: Schedule): Schedule = { ...s, paused: false }
pure def canWake(s: Schedule): bool = s.exists and s.repeating and not(s.closing)
pure def wake(s: Schedule): Schedule = { ...s, wakeRevision: s.wakeRevision + 1, wakePending: true }
pure def canSucceed(s: Schedule): bool = s.phase == Executing
pure def succeed(s: Schedule): Schedule = { ...s, phase: Idle, exists: s.repeating, consumedRuns: s.consumedRuns + 1, due: false, failures: 0, failed: false, wakePending: s.wakePending and s.wakeRevision != s.observedWake }
pure def canPreserve(s: Schedule): bool = s.phase == Executing
pure def preserve(s: Schedule): Schedule = { ...s, phase: Idle }
pure def canRecordFailure(s: Schedule): bool = s.phase == Executing
pure def recordFailure(s: Schedule): Schedule = { ...s, phase: Idle, exists: s.repeating, consumedRuns: s.consumedRuns + 1, due: false, failures: s.failures + 1, failed: true, paused: s.paused or (s.repeating and s.maxFailures > 0 and s.failures + 1 >= s.maxFailures) }
pure def canElapse(s: Schedule): bool = s.exists and not(s.closing) and not(s.due)
pure def elapse(s: Schedule): Schedule = { ...s, due: true }
pure def alwaysOneShotReceiptRemovesRow(s: Schedule): bool = (not(s.repeating) and s.consumedRuns > 0) implies not(s.exists)
pure def alwaysOneShotConsumedAtMostOnce(s: Schedule): bool = s.repeating or s.consumedRuns <= 1
pure def alwaysWakeRevisionsAreMonotone(s: Schedule): bool = s.observedWake >= 0 and s.wakeRevision >= s.observedWake
pure def stepConcurrentWakeSurvivesCompletion(before: Schedule, via: str, after: Schedule): bool =
  via != "succeed" or before.wakeRevision == before.observedWake or not(before.wakePending) or after.wakePending
pure def sometimesRepeatPreservesConcurrentWake(s: Schedule): bool = s.executions > 0 and s.phase == Idle and s.wakePending and s.wakeRevision > s.observedWake
pure def sometimesFailureAutoPauses(s: Schedule): bool = s.paused and s.failures >= 5
pure def sometimesOneShotCompletes(s: Schedule): bool = not(s.repeating) and not(s.exists) and s.consumedRuns == 1
```

### Retirement fences new admission and drains actual storage ownership

Stopping detaches scheduler generation immediately. Closing waits for the query and active execution. A detached query retains storage ownership until settlement, and a replacement registration cannot be removed by the old service's disposer. These facts extend to adapter handoff through the legacy multi-query model.

```quint
pure def canStop(s: Schedule): bool = not(s.closing)
pure def stop(s: Schedule): Schedule = { ...s, active: false, closing: true, generation: s.generation + 1, phase: if (s.phase == Selected) Idle else s.phase }
pure def canClose(s: Schedule): bool = s.closing and not(s.closed) and not(s.pendingQuery) and s.phase == Idle
pure def close(s: Schedule): Schedule = { ...s, closed: true }
pure def alwaysClosedHasNoOutstandingWork(s: Schedule): bool = s.closed implies (s.closing and not(s.active) and not(s.pendingQuery) and s.phase == Idle)
pure def alwaysCountersAreValid(s: Schedule): bool = s.generation >= 0 and s.registration >= 0 and s.executions >= 0 and s.consumedRuns >= 0 and s.failures >= 0
pure def sometimesQueryDrainsAfterStop(s: Schedule): bool = s.closed and s.capturedRegistration > 0
```

## Story: Preserve concurrent operator metadata changes

As an operator, my pause and unrelated metadata survive worker bookkeeping. The adapter's key-level patch applies only explicitly set and unset fields. An adapter without atomic patch support keeps its documented fallback behavior and must declare that capability before the host relies on concurrent patch isolation.

### Worker bookkeeping changes its keys while retaining the operator pause

The `extensionPayload` represents the complete serialized extension metadata and is passed through unchanged. Wake acknowledgement clears only the revision the worker observed.

```quint
type TaskMetadata = { paused: bool, failureCount: int, interval: int, wakeRevision: int, wakePending: bool, extensionPayload: str }
pure val metadataValues = Set({ paused: true, failureCount: 1, interval: 1000, wakeRevision: 1, wakePending: true, extensionPayload: "opaque metadata" }, { paused: false, failureCount: 0, interval: 3000, wakeRevision: 2, wakePending: true, extensionPayload: "other metadata" })
pure def workerPatch(metadata: TaskMetadata, failureCount: int, interval: int, observedRevision: int): TaskMetadata = { ...metadata, failureCount: failureCount, interval: interval, wakePending: metadata.wakePending and metadata.wakeRevision != observedRevision }
pure def lawWorkerPatchPreservesOperatorFields(metadata: TaskMetadata, failureCount: int, interval: int, observedRevision: int): bool =
  workerPatch(metadata, failureCount, interval, observedRevision).paused == metadata.paused and workerPatch(metadata, failureCount, interval, observedRevision).extensionPayload == metadata.extensionPayload
pure def lawWorkerPatchPreservesNewWake(metadata: TaskMetadata, failureCount: int, interval: int, observedRevision: int): bool =
  metadata.wakePending and metadata.wakeRevision != observedRevision implies workerPatch(metadata, failureCount, interval, observedRevision).wakePending
```

### Fair query and worker settlement lets retirement finish

Every admitted adapter query and worker operation must eventually return or throw. Cleanup is weakly fair. The contract retains in-flight ownership for operations which do not settle.

```quint
pure val fair_settleQuery = "weak"
pure val fair_succeed = "weak"
pure val fair_close = "weak"
pure def leadsToRetired(s: Schedule, later: Schedule): bool = s.closing implies later.closed
```
