# Scheduled task dispatch policy and execution lifecycle

Deterministic safety rules for deciding what to do after a connector dispatch
attempt and advancing a scheduled task through fire, acknowledgment, snooze,
escalation, and terminal settlement without duplicating uncertain sends or
mutating settled occurrences.

## Story: Dispatch scheduled tasks safely through escalation ladders without duplicating uncertain deliveries

> As the owner, I want every scheduled task dispatch to stop immediately when
> provider acceptance is unknown, advance through escalation steps only while
> steps remain, guard every state transition with revision checks, and freeze
> terminal tasks so settled occurrences cannot be replayed.

### Dispatch policy never retries or advances an unknown provider acceptance

When a connector reports success, the dispatch completes immediately. When a
connector fails with unknown provider acceptance, the runner fails the task
terminally instead of retrying or advancing the escalation ladder, because a
non-idempotent send may already have reached the recipient. Otherwise, a
retryable failure with a backoff hint retries the same step, a user-actionable
failure advances while surfacing degradation when steps remain, any other
failure advances when steps remain, and failing on the last step without a
retry hint becomes terminal.

```quint
type DispatchVerdict =
  | VerdictComplete
  | VerdictRetry
  | VerdictAdvance
  | VerdictSurfaceDegraded
  | VerdictFail

pure def decideDispatch(
  ok: bool,
  acceptanceUnknown: bool,
  userActionable: bool,
  hasRetryHint: bool,
  isLastStep: bool
): DispatchVerdict =
  if (ok) VerdictComplete
  else if (acceptanceUnknown) VerdictFail
  else if (hasRetryHint) VerdictRetry
  else if (isLastStep) VerdictFail
  else if (userActionable) VerdictSurfaceDegraded
  else VerdictAdvance

pure def lawOkAlwaysCompletes(acceptanceUnknown: bool, userActionable: bool, hasRetryHint: bool, isLastStep: bool): bool =
  decideDispatch(true, acceptanceUnknown, userActionable, hasRetryHint, isLastStep) == VerdictComplete

pure def lawUnknownAcceptanceAlwaysFails(userActionable: bool, hasRetryHint: bool, isLastStep: bool): bool =
  decideDispatch(false, true, userActionable, hasRetryHint, isLastStep) == VerdictFail

pure def lawLastStepWithoutRetryFails(userActionable: bool): bool =
  decideDispatch(false, false, userActionable, false, true) == VerdictFail
```

### Task execution guards transitions by revision and freezes terminal states

A scheduled task starts in `TaskScheduled` at revision 0 with a fixed positive
escalation ladder length (`maxSteps = 3`). Every transition checks that the
caller's `seenRevision` matches the current revision and advances `revision` by
one. Firing moves `TaskScheduled` to `TaskFired` and increments `occurrence`;
acknowledging moves `TaskFired` to `TaskAcknowledged`; snoozing returns a fired
or acknowledged task to `TaskScheduled` with `stepIndex = 0`; escalating
advances `stepIndex` within `0 .. maxSteps - 1` while fired; completing or
settling enters a terminal state (`TaskCompleted`, `TaskSkipped`, `TaskExpired`,
`TaskDismissed`, or `TaskFailed`) and increments `receiptCount`. Once terminal,
no further transition is enabled.

```quint
type TaskLifecycle =
  | TaskScheduled
  | TaskFired
  | TaskAcknowledged
  | TaskCompleted
  | TaskSkipped
  | TaskExpired
  | TaskDismissed
  | TaskFailed

type TaskExecution = {
  status: TaskLifecycle,
  revision: int,
  occurrence: int,
  stepIndex: int,
  maxSteps: int,
  receiptCount: int
}

pure val initial: TaskExecution = {
  status: TaskScheduled,
  revision: 0,
  occurrence: 0,
  stepIndex: 0,
  maxSteps: 3,
  receiptCount: 0
}

pure def isTerminalLifecycle(st: TaskLifecycle): bool =
  st == TaskCompleted or st == TaskSkipped or st == TaskExpired or st == TaskDismissed or st == TaskFailed

pure val seenRevisionValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val terminalStatusValues = Set(TaskSkipped, TaskExpired, TaskDismissed, TaskFailed)

pure def canFireTask(s: TaskExecution, seenRevision: int): bool =
  s.status == TaskScheduled and seenRevision == s.revision

pure def fireTask(s: TaskExecution, seenRevision: int): TaskExecution =
  { ...s, status: TaskFired, revision: s.revision + 1, occurrence: s.occurrence + 1, stepIndex: 0 }

pure def canAcknowledgeTask(s: TaskExecution, seenRevision: int): bool =
  s.status == TaskFired and seenRevision == s.revision

pure def acknowledgeTask(s: TaskExecution, seenRevision: int): TaskExecution =
  { ...s, status: TaskAcknowledged, revision: s.revision + 1 }

pure def canSnoozeTask(s: TaskExecution, seenRevision: int): bool =
  (s.status == TaskFired or s.status == TaskAcknowledged) and seenRevision == s.revision

pure def snoozeTask(s: TaskExecution, seenRevision: int): TaskExecution =
  { ...s, status: TaskScheduled, revision: s.revision + 1, stepIndex: 0 }

pure def canEscalateStep(s: TaskExecution, seenRevision: int): bool =
  s.status == TaskFired and seenRevision == s.revision and s.stepIndex + 1 < s.maxSteps

pure def escalateStep(s: TaskExecution, seenRevision: int): TaskExecution =
  { ...s, revision: s.revision + 1, stepIndex: s.stepIndex + 1 }

pure def canCompleteTask(s: TaskExecution, seenRevision: int): bool =
  not(isTerminalLifecycle(s.status)) and seenRevision == s.revision

pure def completeTask(s: TaskExecution, seenRevision: int): TaskExecution =
  { ...s, status: TaskCompleted, revision: s.revision + 1, receiptCount: s.receiptCount + 1 }

pure def canSettleTerminal(s: TaskExecution, seenRevision: int, terminalStatus: TaskLifecycle): bool =
  not(isTerminalLifecycle(s.status)) and seenRevision == s.revision and isTerminalLifecycle(terminalStatus) and terminalStatus != TaskCompleted

pure def settleTerminal(s: TaskExecution, seenRevision: int, terminalStatus: TaskLifecycle): TaskExecution =
  { ...s, status: terminalStatus, revision: s.revision + 1, receiptCount: s.receiptCount + 1 }

pure def alwaysBoundsHold(s: TaskExecution): bool =
  s.revision >= 0 and s.occurrence >= 0 and s.stepIndex >= 0 and s.stepIndex < s.maxSteps and s.receiptCount >= 0

pure def stepRevisionMonotonic(before: TaskExecution, after: TaskExecution): bool =
  after.revision >= before.revision

pure def stepTerminalStatesFreeze(before: TaskExecution, after: TaskExecution): bool =
  isTerminalLifecycle(before.status) implies after == before

pure def sometimesSnoozedAndCompleted(s: TaskExecution): bool =
  s.status == TaskCompleted and s.occurrence >= 2 and s.receiptCount == 1

pure val eval_witness_sometimesSnoozedAndCompleted = (
  ("fireTask", 0),
  ("snoozeTask", 1),
  ("fireTask", 2),
  ("acknowledgeTask", 3),
  ("completeTask", 4)
)
```
