# Workflow worker execution and wakeups

The host runs the approved workflow worker. [Admission](./admission.md)
owns reviewed-run identity and [worker provenance](./worker.md) owns
executable admission. This machine follows one persisted run, its worker
slot and its wakeup reservation.

## Story: Recover a parked workflow without creating a second execution

> As the owner, I want a workflow waiting on a timer, an event or an approval
> to resume without a second execution, and to keep its result once it has one.

### A wakeup reserves the earliest due attempt for a persisted run

The host sweeps timer events in order. A create can reopen an existing
node ID after it fires or is cancelled. Timer waits choose the earliest
open timer, or a default wait when none is recorded. Waits on events rearm
only with a reported deadline. A wakeup is never postponed past the
earliest due attempt: a reservation is replaced only by an earlier one. A
live worker of unknown outcome is checked again at once; an unknown outcome
with no live worker removes the wakeup while preserving unfinished
history.

```quint
type ExecutionPhase = NoExecution | PostedRun | RunningWorker | WaitingTimer | WaitingEvent | WaitingApproval | WorkerUncertain | ExecutionDone | ExecutionCancelled | ExecutionFailed
type WakeupRun = { runId: int, phase: ExecutionPhase, now: int, worker: bool, stopping: bool, cancelAsked: bool, wakeDue: int, wakeSerial: int, wakeId: int, starts: int }
pure val initial: WakeupRun = { runId: 0, phase: NoExecution, now: 0, worker: false, stopping: false, cancelAsked: false, wakeDue: 0, wakeSerial: 0, wakeId: 0, starts: 0 }
pure def canAdmitRun(r: WakeupRun, runId: int): bool = r.phase == NoExecution and runId > 0
pure def admitRun(r: WakeupRun, runId: int): WakeupRun = { ...r, phase: PostedRun, runId: runId }
pure def terminalRun(phase: ExecutionPhase): bool = phase == ExecutionDone or phase == ExecutionCancelled or phase == ExecutionFailed
pure def canStartWorker(r: WakeupRun): bool = r.runId > 0 and not(r.worker) and not(terminalRun(r.phase)) and not(r.stopping) and not(r.cancelAsked)
pure def startWorker(r: WakeupRun): WakeupRun = { ...r, phase: RunningWorker, worker: true, starts: r.starts + 1 }
pure val defaultTimerWaitMs: int = 60000
pure def reserveWake(target: int, r: WakeupRun): WakeupRun = {
  val due = if (target <= r.now) r.now else target
  if (r.stopping or (r.wakeId > 0 and r.wakeDue <= due)) r
  else { ...r, wakeDue: due, wakeId: r.wakeSerial + 1, wakeSerial: r.wakeSerial + 1 }
}
pure def canParkWorker(r: WakeupRun, parked: ExecutionPhase): bool = r.worker and (parked == WaitingTimer or parked == WaitingEvent or parked == WaitingApproval)
pure def parkWorker(r: WakeupRun, parked: ExecutionPhase, deadline: int, hasDeadline: bool): WakeupRun = {
  val saved = { ...r, phase: parked, worker: false }
  if (parked == WaitingTimer or (parked == WaitingEvent and hasDeadline)) reserveWake(if (hasDeadline) deadline else r.now + defaultTimerWaitMs, saved)
  else saved
}
pure def canObserveUncertain(r: WakeupRun): bool = r.worker
pure def observeUncertain(r: WakeupRun, workerKnownLive: bool): WakeupRun = {
  val saved = { ...r, phase: WorkerUncertain, worker: false }
  if (workerKnownLive) reserveWake(r.now, saved) else { ...saved, wakeDue: 0, wakeId: 0 }
}
pure def changeClock(r: WakeupRun, now: int): WakeupRun = { ...r, now: now }
pure def canObserveWake(r: WakeupRun, wakeId: int): bool = wakeId > 0 and wakeId == r.wakeId
pure def observeWake(r: WakeupRun, wakeId: int): WakeupRun = { ...r, wakeId: 0, wakeDue: 0 }
pure val runIdValues = Set(0, 1)
pure val nowValues = Set(0, 300, 1100)
pure val deadlineValues = Set(200, 1000, 70000)
pure val wakeIdValues = Set(0, 1, 2, 3)
```

### Retirement releases host reservations without rewriting the terminal result

Shutdown clears its wakeups. Cancellation may signal a worker and then
check the durable result. A captured finished result survives a later
cancel operation. With no native run row, cancellation may have won
before the worker entered. A native finished status without its terminal
receipt does not reconstruct successful output and is recorded as failure.
A wakeup reservation names the run and cannot authorize a terminal or
already-owned execution.

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

## Story: End a run whose worker stops answering

> As the owner, I want a workflow whose worker hangs or floods its channel to
> stop with a reason, so it never holds a run, a check of its code or my chat
> dossier open.

### A worker that overruns its run, its check or its line is stopped

A run's worker finishes or parks within 30 minutes of being started or
resumed, counting the model drafts it waits on; a check of workflow code
answers within 30 seconds; and no line the worker sends is longer than
1 MiB. A worker past any of these is stopped: the run fails with the limit
it overran as its error, and an overrun check refuses the code as not
checked. A run parked for a timer, an event or an approval holds no worker,
so its wait is not counted. A worker within all three keeps running.

```quint
type WorkerTurn = RunTurn | CheckTurn
pure val runTurnLimitMs: int = 1800000
pure val checkTurnLimitMs: int = 30000
pure val workerLineLimitBytes: int = 1048576
pure def workerTurnLimitMs(turn: WorkerTurn): int = if (turn == RunTurn) runTurnLimitMs else checkTurnLimitMs
pure def workerOverran(turn: WorkerTurn, elapsedMs: int, lineBytes: int): bool =
  elapsedMs > workerTurnLimitMs(turn) or lineBytes > workerLineLimitBytes
pure val elapsedMsValues = Set(0, 30000, 30001, 1800000, 1800001)
pure val lineBytesValues = Set(0, 1048576, 1048577)
pure def lawAWorkerWithinItsLimitsKeepsRunning(turn: WorkerTurn): bool =
  not(workerOverran(turn, workerTurnLimitMs(turn), workerLineLimitBytes))
pure def lawAnOverlongLineStopsAnyWorker(turn: WorkerTurn, elapsedMs: int): bool = workerOverran(turn, elapsedMs, workerLineLimitBytes + 1)
pure def lawACheckIsHeldToLessTimeThanARun(elapsedMs: int, lineBytes: int): bool =
  workerOverran(RunTurn, elapsedMs, lineBytes) implies workerOverran(CheckTurn, elapsedMs, lineBytes)
```
