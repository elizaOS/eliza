# Orchestrator task lifecycle

This specification defines the durable 9-status task state machine, coordinator completion authority, crash-retry and auto-verification budgets, and explicit lifecycle control transitions.

## Story: Track an orchestrated coding task from creation through verified completion

> As an owner, I want each orchestrated task to follow explicit lifecycle transitions, require elected coordinator completion and verification before reaching done, and bound automatic retries so runaway sessions fail cleanly.

### A task transitions only along valid lifecycle edges and respects coordinator authority

Tasks begin in `TaskOpen` with zero retries and zero verification attempts. Only the elected coordinator session may submit a task into `TaskValidating`; contributor receipts never advance the task into validation. Terminal states (`TaskDone`, `TaskFailed`, `TaskArchived`) never resume work directly without an explicit reopen or restart transition.

```quint
type TaskStatus = TaskOpen | TaskActive | TaskWaitingOnUser | TaskBlocked | TaskValidating | TaskDone | TaskFailed | TaskArchived | TaskInterrupted
type TaskRole = CoordinatorRole | ContributorRole
type TaskLifecycle = {
  status: TaskStatus,
  paused: bool,
  archived: bool,
  hasCoordinator: bool,
  retryCount: int,
  maxRetries: int,
  autoVerifyAttempts: int,
  maxAutoVerify: int,
  validated: bool,
  generation: int
}
pure val initial: TaskLifecycle = {
  status: TaskOpen,
  paused: false,
  archived: false,
  hasCoordinator: false,
  retryCount: 0,
  maxRetries: 3,
  autoVerifyAttempts: 0,
  maxAutoVerify: 3,
  validated: false,
  generation: 1
}
pure def isTerminalTaskStatus(st: TaskStatus): bool =
  st == TaskDone or st == TaskFailed or st == TaskArchived
pure def isInFlightTaskStatus(st: TaskStatus): bool =
  st == TaskOpen or st == TaskActive or st == TaskWaitingOnUser or st == TaskBlocked or st == TaskValidating or st == TaskInterrupted
pure def canActivateTask(t: TaskLifecycle): bool =
  (t.status == TaskOpen or t.status == TaskWaitingOnUser or t.status == TaskBlocked or t.status == TaskInterrupted) and not(t.archived)
pure def activateTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskActive, paused: false, hasCoordinator: true }
pure def canBlockTask(t: TaskLifecycle): bool =
  t.status == TaskActive
pure def blockTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskBlocked }
pure def canAwaitUser(t: TaskLifecycle): bool =
  t.status == TaskActive or t.status == TaskBlocked
pure def awaitUser(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskWaitingOnUser }
pure def canPauseTask(t: TaskLifecycle): bool =
  (t.status == TaskOpen or t.status == TaskActive or t.status == TaskWaitingOnUser or t.status == TaskBlocked) and not(t.archived)
pure def pauseTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskInterrupted, paused: true }
pure def canReportCompletion(t: TaskLifecycle, role: TaskRole): bool =
  (t.status == TaskActive or t.status == TaskWaitingOnUser or t.status == TaskBlocked) and t.hasCoordinator and role == CoordinatorRole
pure def reportCompletion(t: TaskLifecycle, role: TaskRole): TaskLifecycle =
  { ...t, status: TaskValidating, paused: false }
pure def alwaysArchivedMatchesStatus(t: TaskLifecycle): bool =
  t.archived == (t.status == TaskArchived)
pure def alwaysDoneRequiresValidation(t: TaskLifecycle): bool =
  (t.status == TaskDone) implies t.validated
pure def alwaysValidatingHasCoordinator(t: TaskLifecycle): bool =
  (t.status == TaskValidating) implies t.hasCoordinator
pure def alwaysBudgetsBounded(t: TaskLifecycle): bool =
  t.retryCount >= 0 and t.retryCount <= t.maxRetries and t.maxRetries == 3 and t.autoVerifyAttempts >= 0 and t.autoVerifyAttempts <= t.maxAutoVerify and t.maxAutoVerify == 3 and t.generation >= 1
pure def alwaysPausedNotTerminal(t: TaskLifecycle): bool =
  t.paused implies not(isTerminalTaskStatus(t.status))
pure def sometimesValidating(t: TaskLifecycle): bool =
  t.status == TaskValidating
pure def sometimesInterrupted(t: TaskLifecycle): bool =
  t.status == TaskInterrupted
```

### Verification and crash retries are strictly bounded and archive or reopen preserve generation monotonicity

Validation passes move a `TaskValidating` task to `TaskDone`. Validation failure either returns the task to `TaskActive` while under `maxAutoVerify` or transitions to `TaskFailed` once the budget is exhausted. A human override with evidence may pass or fail validation explicitly. Crash retries increment `retryCount` up to `maxRetries` before transitioning to `TaskFailed`. Archiving moves any non-archived task to `TaskArchived`; reopening or restarting increments the task generation and clears terminal validation so stale evidence cannot apply.

```quint
pure def canPassValidation(t: TaskLifecycle): bool =
  t.status == TaskValidating
pure def passValidation(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskDone, validated: true, paused: false }
pure def canFailValidation(t: TaskLifecycle): bool =
  t.status == TaskValidating
pure def failValidation(t: TaskLifecycle): TaskLifecycle =
  if (t.autoVerifyAttempts < t.maxAutoVerify)
    { ...t, status: TaskActive, autoVerifyAttempts: t.autoVerifyAttempts + 1, validated: false, paused: false }
  else
    { ...t, status: TaskFailed, validated: false, paused: false }
pure def canHumanOverrideValidation(t: TaskLifecycle, passed: bool, hasEvidence: bool): bool =
  t.status == TaskValidating and hasEvidence
pure def humanOverrideValidation(t: TaskLifecycle, passed: bool, hasEvidence: bool): TaskLifecycle =
  if (passed) { ...t, status: TaskDone, validated: true, paused: false }
  else { ...t, status: TaskFailed, validated: false, paused: false }
pure def canRecordCrashRetry(t: TaskLifecycle): bool =
  t.status == TaskActive or t.status == TaskBlocked or t.status == TaskInterrupted
pure def recordCrashRetry(t: TaskLifecycle): TaskLifecycle =
  if (t.retryCount < t.maxRetries)
    { ...t, status: TaskActive, retryCount: t.retryCount + 1, paused: false, hasCoordinator: true }
  else
    { ...t, status: TaskFailed, paused: false }
pure def canArchiveTask(t: TaskLifecycle): bool =
  not(t.archived)
pure def archiveTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskArchived, archived: true, paused: false }
pure def canReopenTask(t: TaskLifecycle): bool =
  isTerminalTaskStatus(t.status)
pure def reopenTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskOpen, archived: false, paused: false, validated: false, retryCount: 0, autoVerifyAttempts: 0, generation: t.generation + 1 }
pure def canRestartTask(t: TaskLifecycle): bool =
  t.status != TaskArchived
pure def restartTask(t: TaskLifecycle): TaskLifecycle =
  { ...t, status: TaskActive, archived: false, paused: false, validated: false, retryCount: 0, autoVerifyAttempts: 0, hasCoordinator: true, generation: t.generation + 1 }
pure def stepGenerationNeverDecreases(before: TaskLifecycle, after: TaskLifecycle): bool =
  after.generation >= before.generation
pure def lawContributorNeverEntersValidation(t: TaskLifecycle): bool =
  not(canReportCompletion(t, ContributorRole))
pure def lawHumanOverrideRequiresEvidence(t: TaskLifecycle, passed: bool): bool =
  not(canHumanOverrideValidation(t, passed, false))
pure def sometimesTaskDone(t: TaskLifecycle): bool =
  t.status == TaskDone
pure def sometimesTaskFailed(t: TaskLifecycle): bool =
  t.status == TaskFailed
pure def sometimesTaskArchived(t: TaskLifecycle): bool =
  t.status == TaskArchived
pure def sometimesTaskReopened(t: TaskLifecycle): bool =
  t.status == TaskOpen and t.generation > 1
```
