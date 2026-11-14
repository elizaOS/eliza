# Workflow worker execution and wakeups

AlphaPhone's `WorkflowEngineAdmission.qnt` and `WorkflowWakeups.qnt`
cover the pinned `EmbeddedWorkflowService` running the approved native
workflow worker. The [workflow admission contract](./workflow.md) owns
reviewed-run identity. [Worker provenance](./workflowWorker.md) owns
executable admission. This machine begins at the persisted execution
boundary and models one run, its worker slot, and wakeup reservation.

## Story: Recover a parked workflow without creating a second execution

### A wakeup reserves the earliest due attempt for a persisted run

The host sweeps timer events in order. A create can reopen an existing
node ID after it fires or is cancelled. Timer waits choose the earliest
open timer, or 60 seconds when none is recorded. Waits on events rearm
only with a reported deadline. Resume scheduling adds a 100 millisecond
pad and caps the delay at the maximum signed 32-bit timeout. The first
reservation is replaced only by an earlier due request. A live-but-unknown
worker is checked again after a second. Unknown outcome with no live
worker removes the wakeup while preserving unfinished history.

```quint
type ExecutionPhase = NoExecution | PostedRun | RunningWorker | WaitingTimer | WaitingEvent | WaitingApproval | WorkerUncertain | ExecutionDone | ExecutionCancelled | ExecutionFailed
type WakeupRun = { runId: int, phase: ExecutionPhase, now: int, worker: bool, stopping: bool, cancelAsked: bool, wakeDue: int, wakeSerial: int, wakeId: int, starts: int }
pure val initial: WakeupRun = { runId: 0, phase: NoExecution, now: 0, worker: false, stopping: false, cancelAsked: false, wakeDue: 0, wakeSerial: 0, wakeId: 0, starts: 0 }
pure def canAdmitRun(r: WakeupRun, runId: int): bool = r.phase == NoExecution and runId > 0
pure def admitRun(r: WakeupRun, runId: int): WakeupRun = { ...r, phase: PostedRun, runId: runId }
pure def terminalRun(phase: ExecutionPhase): bool = phase == ExecutionDone or phase == ExecutionCancelled or phase == ExecutionFailed
pure def canStartWorker(r: WakeupRun): bool = r.runId > 0 and not(r.worker) and not(terminalRun(r.phase)) and not(r.stopping) and not(r.cancelAsked)
pure def startWorker(r: WakeupRun): WakeupRun = { ...r, phase: RunningWorker, worker: true, starts: r.starts + 1 }
pure def boundedDelay(now: int, target: int): int = {
  val padded = if (target <= now) 100 else target - now + 100
  if (padded <= 2147483647) padded else 2147483647
}
pure def reserveWake(delay: int, r: WakeupRun): WakeupRun =
  if (r.stopping or (r.wakeId > 0 and r.wakeDue <= r.now + delay)) r
  else { ...r, wakeDue: r.now + delay, wakeId: r.wakeSerial + 1, wakeSerial: r.wakeSerial + 1 }
pure def canParkWorker(r: WakeupRun, parked: ExecutionPhase): bool = r.worker and (parked == WaitingTimer or parked == WaitingEvent or parked == WaitingApproval)
pure def parkWorker(r: WakeupRun, parked: ExecutionPhase, deadline: int, hasDeadline: bool): WakeupRun = {
  val saved = { ...r, phase: parked, worker: false }
  if (parked == WaitingTimer or (parked == WaitingEvent and hasDeadline)) reserveWake(boundedDelay(r.now, if (hasDeadline) deadline else r.now + 60000), saved)
  else saved
}
pure val uncertainWorkerPhase: ExecutionPhase = WorkerUncertain
pure def canObserveUncertain(r: WakeupRun): bool = r.worker
pure def observeUncertain(r: WakeupRun, workerKnownLive: bool): WakeupRun = {
  val saved = { ...r, phase: uncertainWorkerPhase, worker: false }
  if (workerKnownLive) reserveWake(1000, saved) else { ...saved, wakeDue: 0, wakeId: 0 }
}
pure def changeClock(r: WakeupRun, now: int): WakeupRun = { ...r, now: now }
pure def canObserveWake(r: WakeupRun, wakeId: int): bool = wakeId > 0 and wakeId == r.wakeId
pure def observeWake(r: WakeupRun, wakeId: int): WakeupRun = { ...r, wakeId: 0, wakeDue: 0 }
pure val runIdValues = Set(0, 1)
pure val nowValues = Set(0, 300, 1100, 2147483647)
pure val deadlineValues = Set(200, 1000, 2147483647)
pure val wakeIdValues = Set(0, 1, 2, 3)
```

### Retirement releases host reservations without rewriting the terminal result

Shutdown clears its wakeups. Cancellation may signal a worker and then
check the durable result. A captured finished result survives a later
cancel operation. With no native run row, cancellation may have won
before the worker entered. A native finished status without its terminal
receipt does not reconstruct successful output and is recorded as failure.
A wakeup reservation names the run and cannot authorize a terminal or
already-owned execution. Process liveness and the monotonic host timer's
expiry are boundary observations.

```quint
type CancelObservation = NativeRunAbsent | NativeRunCancelled | NativeResultMissing
pure def stopWorkerService(r: WakeupRun): WakeupRun = { ...r, stopping: true, wakeDue: 0, wakeId: 0 }
pure def restartWorkerService(r: WakeupRun): WakeupRun = { ...r, stopping: false }
pure def canAskCancellation(r: WakeupRun): bool = r.runId > 0 and not(terminalRun(r.phase)) and not(r.cancelAsked)
pure def askCancellation(r: WakeupRun): WakeupRun = { ...r, cancelAsked: true }
pure def canFinishWork(r: WakeupRun): bool = r.worker
pure def finishWork(r: WakeupRun, succeeded: bool): WakeupRun = { ...r, phase: if (succeeded) ExecutionDone else if (r.cancelAsked) ExecutionCancelled else ExecutionFailed, worker: false }
pure def canConfirmCancellation(r: WakeupRun): bool = r.cancelAsked and not(r.worker)
pure def confirmCancellation(r: WakeupRun, native: CancelObservation): WakeupRun =
  if (terminalRun(r.phase)) r
  else { ...r, phase: if (native == NativeResultMissing) ExecutionFailed else ExecutionCancelled }
pure def alwaysWorkerHasExecution(r: WakeupRun): bool = r.starts >= 0 and r.runId >= 0 and (r.phase == NoExecution) == (r.runId == 0) and r.worker == (r.phase == RunningWorker) and (r.starts > 0 or r.cancelAsked implies r.runId > 0)
pure def alwaysReservedWakeHasExecution(r: WakeupRun): bool = r.wakeSerial >= 0 and r.wakeId >= 0 and r.wakeId <= r.wakeSerial and (r.wakeId > 0 implies r.runId > 0 and not(r.stopping)) and (r.wakeId == 0 implies r.wakeDue == 0)
pure def stepTerminalRunRetainsOutcome(before: WakeupRun, after: WakeupRun): bool = terminalRun(before.phase) implies after.phase == before.phase
pure def stepExistingWakeIsNotPostponed(before: WakeupRun, via: str, after: WakeupRun): bool = (via == "parkWorker" and before.wakeId > 0) implies after.wakeId > 0 and after.wakeDue <= before.wakeDue
pure def sometimesTimerReservation(r: WakeupRun): bool = r.phase == WaitingTimer and r.wakeId > 0
pure def sometimesWorkerUncertain(r: WakeupRun): bool = r.phase == WorkerUncertain and r.wakeId == 0
pure def sometimesCancelledPersistedRun(r: WakeupRun): bool = r.phase == ExecutionCancelled
```
