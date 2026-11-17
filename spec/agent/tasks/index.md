# Interactive task runtime

The runtime around a user's interactive task; the
[core interactive task](../../core/interactiveTask.md) owns its authority,
observation and operation journal. Here an operation is written durably
before it is dispatched, every interruption advances the task's epoch, a
dispatched operation whose result was lost stays unknown, and the actuator's
cleanup is acknowledged before the task is considered quiet. The native
actuator still checks authority itself before every external effect.

- [Task choices on the chat wire](./choices.md)
- [Task request and view codecs](./http.md)
- [Task gateway owner fence](./ownerFence.md)
- [Encrypted task storage custody](./storageCustody.md)
- [Legacy task migration and key replacement](./storageMigration.md)
- [Task journal records across builds](./recordRecovery.md)
- [Interaction sessions on the agent host](./interactionSessions.md)
- [Task support evidence](./taskSupportEvidence.md)

## Story: Run one task operation without losing or repeating its effect

> As a user, I let the agent act for me in a task. An action it starts is
> recorded before it happens. If I pause or revoke the task, or its storage
> fails, nothing stale reaches the outside world, and an action whose result
> was lost is shown as unknown until it is reconciled, never as a success.

### An operation is recorded before it is dispatched, and dispatch binds the current epoch

The task holds one operation at a time, using the core operation statuses.
Preparing records the next operation once the previous one is empty or
resolved, with no effect or evidence yet; dispatch moves the task to waiting
and records the epoch it was dispatched in. Every committed change advances the
task revision and appends one task event.

```quint
import interactiveTask as T from "../../core/interactiveTask"
type RunStatus = RunActive | RunWaiting | RunPaused | RunCompleted
type TaskRun = { status: RunStatus, op: T::OperationStatus, epoch: int, dispatchEpoch: int, revision: int, eventSequence: int, authority: bool, aborted: bool, poisoned: bool, cleanup: bool, effect: bool, evidence: bool }
pure def resolved(r: TaskRun): bool = r.op == T::Succeeded or r.op == T::Failed
pure val initial: TaskRun = { status: RunActive, op: T::Empty, epoch: 0, dispatchEpoch: 0, revision: 0, eventSequence: 0, authority: true, aborted: false, poisoned: false, cleanup: false, effect: false, evidence: false }
pure def canPrepare(r: TaskRun): bool = r.status == RunActive and (r.op == T::Empty or resolved(r)) and r.authority and not(r.poisoned) and not(r.cleanup)
pure def prepare(r: TaskRun): TaskRun = { ...r, op: T::Prepared, effect: false, evidence: false, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def canDispatch(r: TaskRun): bool = r.status == RunActive and r.op == T::Prepared and r.authority and not(r.poisoned)
pure def dispatch(r: TaskRun): TaskRun = { ...r, op: T::Dispatched, dispatchEpoch: r.epoch, status: RunWaiting, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def alwaysEveryRevisionHasOneEvent(r: TaskRun): bool = r.eventSequence == r.revision and r.revision >= 0
pure def alwaysWaitingHasDispatchedOperation(r: TaskRun): bool = r.status == RunWaiting implies r.op == T::Dispatched
pure def alwaysDispatchBelongsToCurrentEpoch(r: TaskRun): bool = r.op == T::Dispatched implies r.dispatchEpoch == r.epoch
```

### An external effect needs current authority and the epoch it was dispatched in

The actuator's effect lands only while the task is waiting on that operation,
still authorized, not aborted and not poisoned, and while the epoch has not
moved since dispatch. A pause, revocation or storage failure in between
fences it.

```quint
pure def canLandEffect(r: TaskRun): bool = r.op == T::Dispatched and r.status == RunWaiting and r.authority and not(r.aborted) and not(r.poisoned) and r.dispatchEpoch == r.epoch
pure def landEffect(r: TaskRun): TaskRun = { ...r, effect: true }
pure def stepEffectNeedsCurrentAuthority(before: TaskRun, after: TaskRun): bool =
  (not(before.effect) and after.effect) implies (before.authority and not(before.aborted) and not(before.poisoned) and before.dispatchEpoch == before.epoch)
```

### A result settles the operation only with evidence

A result for the dispatched operation, reported in the same epoch, resolves it
as succeeded or failed and records its evidence. A resolved operation always
has evidence.

```quint
pure def canReportResult(r: TaskRun, succeeded: bool): bool = r.op == T::Dispatched and r.status == RunWaiting and not(r.aborted) and not(r.poisoned) and r.dispatchEpoch == r.epoch
pure def reportResult(r: TaskRun, succeeded: bool): TaskRun = { ...r, op: if (succeeded) T::Succeeded else T::Failed, status: RunActive, evidence: true, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def alwaysResolvedOperationHasEvidence(r: TaskRun): bool = resolved(r) implies r.evidence
```

### Pausing or revoking advances the epoch and turns a dispatched operation into unknown

An interruption aborts the actuator, requests cleanup and advances the epoch.
A prepared operation is dropped without effect. A dispatched one becomes
unknown, because its effect may already have happened. Revocation also removes
the task's authority; a revoked task is never running, and a completed task
stays completed.

```quint
pure def interruptedOperation(op: T::OperationStatus): T::OperationStatus = if (op == T::Dispatched) T::Unknown else if (op == T::Prepared) T::Empty else op
pure def canPause(r: TaskRun): bool = r.status == RunActive or r.status == RunWaiting
pure def pause(r: TaskRun): TaskRun = { ...r, op: interruptedOperation(r.op), epoch: r.epoch + 1, aborted: true, cleanup: true, status: RunPaused, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def canRevoke(r: TaskRun): bool = r.authority
pure def revoke(r: TaskRun): TaskRun = { ...r, op: interruptedOperation(r.op), epoch: r.epoch + 1, aborted: true, cleanup: true, authority: false, status: if (r.status == RunCompleted) RunCompleted else RunPaused, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def alwaysRevokedTaskDoesNotRun(r: TaskRun): bool = not(r.authority) implies (r.status == RunPaused or r.status == RunCompleted)
pure def stepLostDispatchIsUnknownNeverSuccess(before: TaskRun, via: str, after: TaskRun): bool =
  ((via == "pause" or via == "revoke") and before.op == T::Dispatched) implies after.op == T::Unknown
pure def sometimesInterruptedAfterEffect(r: TaskRun): bool = r.op == T::Unknown and r.effect and r.status == RunPaused
```

### A storage failure poisons the task before any further effect

When the task store cannot write, the runtime marks the task poisoned, aborts
the actuator and requests cleanup. A poisoned task prepares, dispatches,
resolves and reconciles nothing.

```quint
pure def canFailStorage(r: TaskRun): bool = not(r.poisoned)
pure def failStorage(r: TaskRun): TaskRun = { ...r, poisoned: true, aborted: true, cleanup: true }
pure def alwaysPoisonedTaskIsAborted(r: TaskRun): bool = r.poisoned implies r.aborted
pure def sometimesStorageFailureBeforeEffect(r: TaskRun): bool = r.poisoned and r.op == T::Dispatched and not(r.effect)
```

### An unknown operation is reconciled before the task resumes

Only a paused, unpoisoned task reconciles an unknown operation, and only with
evidence of what happened. The task resumes only after cleanup is acknowledged,
with its authority intact and no operation left unknown.

```quint
pure def canReconcile(r: TaskRun, succeeded: bool): bool = r.op == T::Unknown and r.status == RunPaused and not(r.poisoned)
pure def reconcile(r: TaskRun, succeeded: bool): TaskRun = { ...r, op: if (succeeded) T::Succeeded else T::Failed, evidence: true, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def canResume(r: TaskRun): bool = r.status == RunPaused and r.authority and not(r.cleanup) and not(r.poisoned) and r.op != T::Unknown
pure def resume(r: TaskRun): TaskRun = { ...r, status: RunActive, aborted: false, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def sometimesUnknownReconciled(r: TaskRun): bool = r.status == RunPaused and resolved(r) and r.epoch > 0 and not(r.cleanup)
pure def sometimesSecondOperationAfterResume(r: TaskRun): bool = r.op == T::Prepared and r.epoch > 0 and r.revision > 4
```

## Story: Finish a task and wait for its actuator to let go

> As a user, when my task completes I know the actuator has stopped touching
> the outside world, or I see that its cleanup has not been confirmed yet.

### Completion needs no open operation and requests cleanup

A task completes only when it is active and authorized and its operation is
empty or resolved. Completion aborts the actuator and requests cleanup.

```quint
pure def canComplete(r: TaskRun): bool = r.status == RunActive and (r.op == T::Empty or resolved(r)) and r.authority and not(r.poisoned)
pure def complete(r: TaskRun): TaskRun = { ...r, status: RunCompleted, aborted: true, cleanup: true, revision: r.revision + 1, eventSequence: r.eventSequence + 1 }
pure def alwaysCompletedHasNoOpenOperation(r: TaskRun): bool = r.status == RunCompleted implies (r.op == T::Empty or resolved(r))
```

### Cleanup ends only when the actuator acknowledges it

A failed cleanup leaves the request outstanding; only an acknowledgement
clears it.

```quint
pure def canAcknowledgeCleanup(r: TaskRun): bool = r.cleanup
pure def acknowledgeCleanup(r: TaskRun): TaskRun = { ...r, cleanup: false }
pure def stepCleanupClearsOnlyByAcknowledgement(before: TaskRun, via: str, after: TaskRun): bool =
  (before.cleanup and not(after.cleanup)) implies via == "acknowledgeCleanup"
pure def sometimesCompletedWithEvidenceAndQuiet(r: TaskRun): bool = r.status == RunCompleted and r.op == T::Succeeded and not(r.cleanup)
pure def sometimesCompletedAwaitingCleanup(r: TaskRun): bool = r.status == RunCompleted and r.cleanup
```
