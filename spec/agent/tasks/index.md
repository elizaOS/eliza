# Interactive task host

The agent's `@elizaos/agent/tasks` module runs the owner's interactive task
in the agent process. The [core interactive task](../../core/interactiveTask.md)
owns the task's authority, observation, epoch, revision and operation
journal; this spec holds that task and adds only what the host keeps around
it: the actuator call in flight, the cleanup the actuator must confirm, the
poison a storage failure leaves, recovery after a restart and the
presentation a chat turn may show. The task's owner is the launch account;
the shell passes it as the sender of every request. Storage custody is
the task store (`store.md`); routes, views and choices are
the task wire (`wire.md`). The actuator still checks the current dispatch
itself immediately before every external effect.

## Story: Run one task operation without losing or repeating its effect

> As the owner, I let the agent act for me in a task. An action it starts is
> recorded before it happens. If I pause, cancel or revoke the task, its
> storage fails or the agent restarts, nothing stale reaches the outside
> world, and an action whose result was lost stays unknown until a trusted
> readback settles it or I accept that it stays unknown.

### Every task request comes from the launch account of a started host

The first start binds the host to the launch account; a later start, after
a restart, must name the same account. A task belongs to that account, and
nothing is served before start or while the host is poisoned.

```quint
import interactiveTask as I from "../../core/interactiveTask"
type Actuator = ActuatorIdle | Executing({ revision: int, epoch: int }) | ExecutionAborted
type Cleanup = CleanupDone | Quiescing | QuiesceFailed
type TaskHost = { task: I::Interactive, owner: I::Owner, started: bool, actuator: Actuator, cleanup: Cleanup, poisoned: bool, acknowledged: bool }
pure val noOwner: I::Owner = { agentId: "", actorId: "", connector: "" }
pure val initial: TaskHost = { task: I::initial, owner: noOwner, started: false, actuator: ActuatorIdle, cleanup: CleanupDone, poisoned: false, acknowledged: false }
pure def serves(h: TaskHost, by: I::Owner): bool = h.started and not(h.poisoned) and by == h.owner
pure def unfinished(t: I::Interactive): bool = t.status != I::Absent and not(I::ended(t))
pure def canStart(h: TaskHost, by: I::Owner): bool = not(h.started) and by.agentId != "" and by.actorId != "" and by.connector != "" and (h.owner == noOwner or h.owner == by)
pure def start(h: TaskHost, by: I::Owner): TaskHost = { ...h, started: true, owner: by, task: if (unfinished(h.task)) I::interrupt(h.task, by, h.task.revision, I::Recover) else h.task }
pure def canCreate(h: TaskHost, by: I::Owner, origins: Set[str], capabilities: Set[str], taskId: str, authorizationId: str): bool = serves(h, by) and h.actuator == ActuatorIdle and I::canCreate(h.task, by, origins, capabilities, taskId, authorizationId)
pure def create(h: TaskHost, by: I::Owner, origins: Set[str], capabilities: Set[str], taskId: str, authorizationId: str): TaskHost = { ...h, task: I::create(h.task, by, origins, capabilities, taskId, authorizationId) }
pure def alwaysTaskBelongsToTheLaunchAccount(h: TaskHost): bool = (h.started implies h.owner != noOwner) and (h.task.status == I::Absent or (h.task.owner == h.owner and h.owner != noOwner))
```

### The held task keeps every rule of the core task

```quint
pure def alwaysTaskKeepsCoreRules(h: TaskHost): bool = I::alwaysPreparedHasCurrentAuthority(h.task) and I::alwaysWaitingHasDispatchedOperation(h.task) and I::alwaysRevokedTaskDoesNotRun(h.task) and I::alwaysEndedHasNoPreparedOrDispatched(h.task) and I::alwaysJournalContainsTerminalEvidence(h.task) and I::alwaysTaskCountersAreValid(h.task)
```

### An operation is written as dispatched before the actuator runs it

One call prepares and dispatches the proposal, two durable writes, and only
then enters the actuator, bound to the revision and epoch of the dispatch.
One actuator call runs at a time.

```quint
pure def canExecute(h: TaskHost, by: I::Owner, expectedRevision: int, proposal: I::Operation): bool = serves(h, by) and h.actuator == ActuatorIdle and I::canPrepare(h.task, by, expectedRevision, proposal) and I::canDispatch(I::prepare(h.task, by, expectedRevision, proposal), by, expectedRevision + 1)
pure def execute(h: TaskHost, by: I::Owner, expectedRevision: int, proposal: I::Operation): TaskHost = {
  val dispatched = I::dispatch(I::prepare(h.task, by, expectedRevision, proposal), by, expectedRevision + 1)
  { ...h, task: dispatched, actuator: Executing({ revision: dispatched.revision, epoch: dispatched.epoch }) }
}
pure def isExecuting(a: Actuator): bool = match a { | Executing(x) => true | _ => false }
pure def dispatchIsCurrent(h: TaskHost): bool = match h.actuator { | Executing(x) => x.revision == h.task.revision and x.epoch == h.task.epoch and h.task.status == I::Waiting and h.task.authorized and h.started and not(h.poisoned) | _ => false }
pure def alwaysRunningActuatorHoldsTheCurrentDispatch(h: TaskHost): bool = isExecuting(h.actuator) implies dispatchIsCurrent(h)
pure def alwaysDispatchedOperationHasItsActuator(h: TaskHost): bool = (h.started and not(h.poisoned) and h.task.status == I::Waiting) implies isExecuting(h.actuator)
```

### Only the current dispatch records the actuator's result, and a reply without evidence is unknown

A result reaches the task only while the actuator still holds the current
dispatch. A success or failure without evidence, or a lost reply, is
recorded as unknown, never as a success. A result that comes back after
its dispatch was fenced changes nothing.

```quint
pure def reportedOutcome(operationResult: I::OperationStatus, evidenceRef: str): I::OperationStatus = if ((operationResult == I::Succeeded or operationResult == I::Failed) and evidenceRef != "") operationResult else I::Unknown
pure def canFinishExecution(h: TaskHost): bool = h.actuator != ActuatorIdle
pure def finishExecution(h: TaskHost, operationResult: I::OperationStatus, evidenceRef: str): TaskHost = { ...h, actuator: ActuatorIdle, task: if (dispatchIsCurrent(h)) I::resolve(h.task, h.owner, h.task.revision, reportedOutcome(operationResult, evidenceRef), evidenceRef, false) else h.task }
pure def stepFencedResultChangesNothing(before: TaskHost, via: str, after: TaskHost): bool = (via == "finishExecution" and before.actuator == ExecutionAborted) implies (after.task.revision == before.task.revision and after.task.operation.status == before.task.operation.status)
pure def sometimesLostReplyIsUnknown(h: TaskHost): bool = h.task.status == I::Blocked and h.task.operation.status == I::Unknown and h.actuator == ActuatorIdle
```

### Pausing, cancelling or revoking aborts the actuator and asks it to clean up

A close is a pause. The core task advances the epoch: a dispatched
operation becomes unknown and a prepared one is cancelled. Revocation is a
trusted host decision.

```quint
type Control = PauseTask | CancelTask | RevokeTask
pure def interruption(kind: Control): I::Interruption = if (kind == PauseTask) I::Pause else if (kind == CancelTask) I::Cancel else I::Revoke
pure def abortedActuator(a: Actuator): Actuator = if (isExecuting(a)) ExecutionAborted else a
pure def canControl(h: TaskHost, by: I::Owner, expectedRevision: int, kind: Control): bool = serves(h, by) and I::canInterrupt(h.task, by, expectedRevision, interruption(kind))
pure def control(h: TaskHost, by: I::Owner, expectedRevision: int, kind: Control): TaskHost = { ...h, task: I::interrupt(h.task, by, expectedRevision, interruption(kind)), actuator: abortedActuator(h.actuator), cleanup: Quiescing }
pure def sometimesStopFencedARunningDispatch(h: TaskHost): bool = h.task.status == I::Paused and h.task.operation.status == I::Unknown and h.actuator == ExecutionAborted
```

### A storage failure poisons the host until the agent restarts

The failed write may not have advanced the epoch, so the host aborts the
actuator, asks for cleanup and serves nothing more. Only a restart clears
the poison; the restarted host recovers from what was stored.

```quint
pure def canFailStorage(h: TaskHost): bool = h.started and not(h.poisoned)
pure def failStorage(h: TaskHost): TaskHost = { ...h, poisoned: true, actuator: abortedActuator(h.actuator), cleanup: Quiescing }
pure def stepPoisonedHostChangesNoTask(before: TaskHost, after: TaskHost): bool = before.poisoned implies (after.task.revision == before.task.revision and after.task.epoch == before.task.epoch)
pure def sometimesPoisonedDuringDispatch(h: TaskHost): bool = h.poisoned and h.task.status == I::Waiting
```

### A start pauses the work a previous process left unfinished

A restart ends the process: the actuator call, the cleanup request and the
poison go with it, and the stored task stays. The next start recovers an
unfinished task under a new epoch, so a dispatch the old process left
behind becomes unknown and the task waits paused for the owner.

```quint
pure def canRestart(h: TaskHost): bool = h.started
pure def restart(h: TaskHost): TaskHost = { ...h, started: false, poisoned: false, actuator: ActuatorIdle, cleanup: CleanupDone }
pure def stepStartPausesUnfinishedWork(before: TaskHost, via: str, after: TaskHost): bool = (via == "start" and unfinished(before.task)) implies (after.task.status == I::Paused and after.task.epoch == before.task.epoch + 1 and after.task.operation.status != I::Dispatched and after.task.operation.status != I::Prepared)
pure def sometimesRestartLeftADispatch(h: TaskHost): bool = not(h.started) and h.task.status == I::Waiting
```

### Only a trusted readback settles an unknown outcome, and it never resumes the task

Readback runs on a stopped, authorized task under a new recovery epoch and
copies only the outcome. When the authority that readback needs is gone,
the owner may accept once that the outcome stays unknown: the task ends
cancelled and nothing claims that the effect happened or did not.

```quint
pure def canReconcile(h: TaskHost, by: I::Owner, expectedRevision: int, operationResult: I::OperationStatus, evidenceRef: str): bool = serves(h, by) and h.actuator == ActuatorIdle and h.cleanup == CleanupDone and h.task.authorized and h.task.operation.status == I::Unknown and (h.task.status == I::Paused or h.task.status == I::Blocked or h.task.status == I::Cancelled) and I::canInterrupt(h.task, by, expectedRevision, I::Recover)
pure def reconcile(h: TaskHost, by: I::Owner, expectedRevision: int, operationResult: I::OperationStatus, evidenceRef: str): TaskHost = {
  val recovered = I::interrupt(h.task, by, expectedRevision, I::Recover)
  { ...h, task: I::resolve(recovered, by, recovered.revision, reportedOutcome(operationResult, evidenceRef), evidenceRef, true), cleanup: Quiescing }
}
pure def canAcknowledgeUnknown(h: TaskHost, by: I::Owner, expectedRevision: int): bool = serves(h, by) and h.actuator == ActuatorIdle and not(h.acknowledged) and not(h.task.authorized) and h.task.operation.status == I::Unknown and I::ownedRevision(h.task, by, expectedRevision)
pure def acknowledgeUnknown(h: TaskHost, by: I::Owner, expectedRevision: int): TaskHost = { ...h, task: if (I::ended(h.task)) h.task else I::interrupt(h.task, by, expectedRevision, I::Cancel), acknowledged: true, cleanup: Quiescing }
pure def stepReadbackNeverResumes(before: TaskHost, via: str, after: TaskHost): bool = (via == "reconcile" or via == "acknowledgeUnknown") implies (after.task.status != I::Active and after.task.status != I::Waiting)
pure def alwaysAcceptedUnknownStaysClosed(h: TaskHost): bool = h.acknowledged implies (I::ended(h.task) and not(h.task.authorized) and h.task.operation.status == I::Unknown)
pure def sometimesReadbackSettledUnknown(h: TaskHost): bool = h.task.status == I::Paused and h.task.operation.status == I::Succeeded and not(h.task.observed) and h.task.epoch >= h.task.operation.epoch + 2
pure def sometimesUnknownAccepted(h: TaskHost): bool = h.acknowledged and h.task.status == I::Cancelled
```

### A stopped task resumes only with authority, confirmed cleanup, a healthy store and no unknown operation

Observing reads the page through the actuator and writes the observation;
with `resume` it also returns a paused task to active. The host extends a
task to one more origin only after its own safety check (`hostChecked`).
Wall-clock time only moves the task's clock forward.

```quint
pure val wallNowValues = Set(1, 3)
pure def tick(h: TaskHost, wallNow: int): TaskHost = { ...h, task: I::updateClock(h.task, wallNow) }
pure def canObserve(h: TaskHost, by: I::Owner, expectedRevision: int, observation: I::ObservationInput): bool = serves(h, by) and h.actuator == ActuatorIdle and h.cleanup == CleanupDone and (observation.resume or h.task.status == I::Active) and I::canObserve(h.task, by, expectedRevision, observation)
pure def observe(h: TaskHost, by: I::Owner, expectedRevision: int, observation: I::ObservationInput): TaskHost = { ...h, task: I::observe(h.task, by, expectedRevision, observation) }
pure def canExtendOrigin(h: TaskHost, by: I::Owner, expectedRevision: int, origin: str, hostChecked: bool): bool = serves(h, by) and h.actuator == ActuatorIdle and h.cleanup == CleanupDone and I::canExtendOrigin(h.task, by, expectedRevision, origin, hostChecked)
pure def extendOrigin(h: TaskHost, by: I::Owner, expectedRevision: int, origin: str, hostChecked: bool): TaskHost = { ...h, task: I::extendOrigin(h.task, by, expectedRevision, origin, hostChecked) }
pure def alwaysRunningTaskIsQuiet(h: TaskHost): bool = ((h.task.status == I::Active or h.task.status == I::Waiting) and not(h.poisoned)) implies h.cleanup == CleanupDone
pure def sometimesResumedAfterStop(h: TaskHost): bool = h.task.status == I::Active and h.task.epoch > 0 and h.task.observed and h.task.grantCount == 0
```

### A chat turn is shown a task only while it is active at the epoch it named

`presentationForConversation({taskId, expectedEpoch, actorId})` serves the
task's id, epoch and revision only to the launch account, for an active,
authorized task at that epoch on a healthy host; otherwise it refuses.
Stopping the task, poisoning the host or restarting retires a presentation
taken before.

```quint
type Presentation = PresentationRefused | Presented({ taskId: str, epoch: int, revision: int })
pure def presentationForConversation(h: TaskHost, taskId: str, expectedEpoch: int, actorId: str): Presentation = if (h.started and not(h.poisoned) and actorId == h.owner.actorId and taskId != "" and taskId == h.task.taskId and expectedEpoch == h.task.epoch and h.task.status == I::Active and h.task.authorized) Presented({ taskId: taskId, epoch: expectedEpoch, revision: h.task.revision }) else PresentationRefused
pure def stepStopRetiresPresentation(before: TaskHost, via: str, after: TaskHost): bool = (via == "control" or via == "failStorage" or via == "restart") implies presentationForConversation(after, before.task.taskId, before.task.epoch, before.owner.actorId) == PresentationRefused
pure def sometimesPresented(h: TaskHost): bool = presentationForConversation(h, h.task.taskId, h.task.epoch, h.owner.actorId) != PresentationRefused
```

## Story: Finish a task and wait for its actuator to let go

> As the owner, when my task completes I know the actuator has stopped
> touching the outside world, or I see that its cleanup is not confirmed yet.

### A task completes only while active, authorized and with no open operation

The trusted host verifies and saves the requested result first; completion
records the task's state, not proof that the goal was achieved.

```quint
pure def canComplete(h: TaskHost, by: I::Owner, expectedRevision: int): bool = serves(h, by) and h.actuator == ActuatorIdle and h.task.status == I::Active and h.task.authorized and I::canComplete(h.task, by, expectedRevision)
pure def complete(h: TaskHost, by: I::Owner, expectedRevision: int): TaskHost = { ...h, task: I::complete(h.task, by, expectedRevision), cleanup: Quiescing }
pure def sometimesCompletedAndQuiet(h: TaskHost): bool = I::sometimesSuccessfulTask(h.task) and h.cleanup == CleanupDone
```

### Cleanup ends only when the actuator confirms it

A failed cleanup stays unconfirmed and is retried; only the actuator's
confirmation, or a restart that ends the actuator, clears it.

```quint
pure def canConfirmCleanup(h: TaskHost): bool = h.cleanup == Quiescing
pure def confirmCleanup(h: TaskHost): TaskHost = { ...h, cleanup: CleanupDone }
pure def canFailCleanup(h: TaskHost): bool = h.cleanup == Quiescing
pure def failCleanup(h: TaskHost): TaskHost = { ...h, cleanup: QuiesceFailed }
pure def canRetryCleanup(h: TaskHost): bool = h.cleanup == QuiesceFailed
pure def retryCleanup(h: TaskHost): TaskHost = { ...h, cleanup: Quiescing }
pure def stepCleanupClearsOnlyByConfirmation(before: TaskHost, via: str, after: TaskHost): bool = (before.cleanup != CleanupDone and after.cleanup == CleanupDone) implies (via == "confirmCleanup" or via == "restart")
pure def sometimesCompletedCleanupUnconfirmed(h: TaskHost): bool = h.task.status == I::Completed and h.cleanup == QuiesceFailed
```
