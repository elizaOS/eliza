# Task service operation and timer ownership

`services/task.ts` owns a local timer, active tick promise, pending admission promises, per-task execution counts, orphan quarantine set and scheduler drain. Per-task schedule/bookkeeping values are specified in [scheduling](./scheduling.md), and daemon query ownership in [queryDrain](./queryDrain.md). This product keeps the service's distinct concurrent operations instead of projecting all of them onto one task.

## Story: Stop admission synchronously and drain every admitted task operation

### Exclusive tasks observe every active invocation of the same task

One-shots and blocking repeats decline an overlapping invocation; nonblocking repeats may overlap and every invocation contributes to the count. An admitted operation includes preflight and storage reads, not just the worker body. A one-shot rereads its row after taking the execution slot; missing rows, failed reads or stop before that read finishes release the slot. A worker failure releases it after failure bookkeeping. Completing the outer admission is permitted only after its executions have settled.

```quint
type Operation = { id: int, completed: bool, tick: int }
type ExecutionPhase = RecheckOneShot | WorkerRunning | ExecutionDone
type Execution = { id: int, operation: int, task: str, phase: ExecutionPhase, failed: bool }
type ServiceTick = { id: int, timerDriven: bool, completed: bool, hasWake: bool, wakeAt: int }
type DueRow = { task: str, paused: bool, invalid: bool, due: int }
type StopPhase = WaitScheduler | WaitTick | WaitOperations | StopReturned
type StopCall = { id: int, drain: int, phase: StopPhase, tick: int, operations: Set[int] }

type TaskServiceOwners = { configured: bool, now: int, startedAt: int, stopped: bool, localTimer: bool, hasTimer: bool, timerAt: int, maxTick: int, activeTick: int, ticks: List[ServiceTick], wakeWaiters: Set[int], operations: List[Operation], executions: List[Execution], quarantined: Set[str], drains: List[Operation], stops: List[StopCall], rejected: int, failures: int, sharedRegistrations: int }
pure val initial: TaskServiceOwners = { configured: false, now: 0, startedAt: 0, stopped: false, localTimer: false, hasTimer: false, timerAt: 0, maxTick: 60000, activeTick: 0, ticks: List(), wakeWaiters: Set(), operations: List(), executions: List(), quarantined: Set(), drains: List(), stops: List(), rejected: 0, failures: 0, sharedRegistrations: 0 }
pure def canConfigure(s: TaskServiceOwners): bool = not(s.configured)
pure def configure(s: TaskServiceOwners, now: int): TaskServiceOwners = { ...s, configured: true, now: now, startedAt: now }
pure def setClock(s: TaskServiceOwners, now: int): TaskServiceOwners = { ...s, now: now }
pure def executionCount(s: TaskServiceOwners, task: str): int = s.executions.select(execution => execution.task == task and execution.phase != ExecutionDone).length()
pure def operationPending(s: TaskServiceOwners, id: int): bool = s.operations.some(operation => operation.id == id and not(operation.completed))
pure def canAdmitOperation(s: TaskServiceOwners, id: int, tick: int): bool = s.configured and not(s.stopped) and id > 0 and not(s.operations.some(operation => operation.id == id)) and (tick == 0 or s.ticks.some(entry => entry.id == tick and not(entry.completed)))
pure def admitOperation(s: TaskServiceOwners, id: int, tick: int): TaskServiceOwners = { ...s, operations: s.operations.append({ id: id, completed: false, tick: tick }) }
pure def canTryExecute(s: TaskServiceOwners, id: int, operation: int): bool = id > 0 and not(s.executions.some(execution => execution.id == id)) and operationPending(s, operation)
pure def tryExecute(s: TaskServiceOwners, id: int, operation: int, task: str, repeating: bool, blocking: bool, workerPresent: bool): TaskServiceOwners =
  if (s.stopped or task == "" or not(workerPresent) or ((not(repeating) or blocking) and executionCount(s, task) > 0)) { ...s, rejected: s.rejected + 1 }
  else { ...s, executions: s.executions.append({ id: id, operation: operation, task: task, phase: if (repeating) WorkerRunning else RecheckOneShot, failed: false }) }
pure def canRecheck(s: TaskServiceOwners, id: int): bool = s.executions.some(execution => execution.id == id and execution.phase == RecheckOneShot)
pure def recheckedExecution(s: TaskServiceOwners, execution: Execution, id: int, rowExists: bool, readSucceeded: bool): Execution = if (execution.id == id) { ...execution, phase: if (rowExists and readSucceeded and not(s.stopped)) WorkerRunning else ExecutionDone, failed: not(readSucceeded) } else execution
pure def recheck(s: TaskServiceOwners, id: int, rowExists: bool, readSucceeded: bool): TaskServiceOwners = { ...s, failures: s.failures + (if (readSucceeded) 0 else 1), executions: s.executions.listMap(execution => recheckedExecution(s, execution, id, rowExists, readSucceeded)) }
pure def canFinishExecution(s: TaskServiceOwners, id: int): bool = s.executions.some(execution => execution.id == id and execution.phase == WorkerRunning)
pure def finishExecution(s: TaskServiceOwners, id: int, success: bool): TaskServiceOwners = { ...s, executions: s.executions.listMap(execution => if (execution.id == id) { ...execution, phase: ExecutionDone, failed: not(success) } else execution), failures: s.failures + (if (success) 0 else 1) }
pure def canCompleteOperation(s: TaskServiceOwners, id: int): bool = operationPending(s, id) and s.executions.every(execution => execution.operation != id or execution.phase == ExecutionDone)
pure def completeOperation(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, operations: s.operations.listMap(operation => if (operation.id == id) { ...operation, completed: true } else operation) }
pure def alwaysExecutionsHavePendingOwner(s: TaskServiceOwners): bool = s.executions.every(execution => execution.phase == ExecutionDone or operationPending(s, execution.operation))
pure def sometimesNonblockingOverlap(s: TaskServiceOwners): bool = s.executions.some(execution => executionCount(s, execution.task) > 1)
```

### Local timer replacement retains the earliest deadline and exact active tick

Serverless start installs no timer. Daemon start registers the service; local start validates the configured maximum sleep, then arms the first 1,000 ms wake. The local timer replaces a later deadline but keeps an earlier one. A timer that fires during an active tick waits for that exact tick and then requests a 1,000 ms wake. Empty query results disarm polling until markDirty; query failures retain the retry wake. One-shot clock adapters are responsible for waking only after their deadline; the system adapter rechecks wall time in pieces at most 1,000 ms.

```quint
pure def armed(s: TaskServiceOwners, at: int): TaskServiceOwners = if (s.stopped or not(s.localTimer) or (s.hasTimer and s.timerAt <= at)) s else { ...s, hasTimer: true, timerAt: at }
pure def startTimer(s: TaskServiceOwners, serverless: bool, daemon: bool, maximum: int): TaskServiceOwners =
  if (s.stopped or serverless) s
  else if (daemon) { ...s, sharedRegistrations: s.sharedRegistrations + 1 }
  else if (maximum < 1000 or maximum > 2147483647) { ...s, failures: s.failures + 1 }
  else armed({ ...s, localTimer: true, hasTimer: false, maxTick: maximum }, s.now + 1000)
pure def markDirty(s: TaskServiceOwners, daemon: bool): TaskServiceOwners = if (daemon) s else armed(s, s.now + 1000)
pure def canBeginHostTick(s: TaskServiceOwners, id: int): bool = s.configured and not(s.stopped) and s.activeTick == 0 and id > 0 and not(s.ticks.some(tick => tick.id == id))
pure def beginHostTick(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, activeTick: id, ticks: s.ticks.append({ id: id, timerDriven: false, completed: false, hasWake: false, wakeAt: 0 }) }
pure def canFireTimer(s: TaskServiceOwners, id: int): bool = s.hasTimer and s.now >= s.timerAt and id > 0 and not(s.ticks.some(tick => tick.id == id))
pure def fireTimer(s: TaskServiceOwners, id: int): TaskServiceOwners =
  if (s.stopped) { ...s, hasTimer: false }
  else if (s.activeTick != 0) { ...s, hasTimer: false, wakeWaiters: s.wakeWaiters.union(Set(s.activeTick)) }
  else { ...s, hasTimer: false, activeTick: id, ticks: s.ticks.append({ id: id, timerDriven: true, completed: false, hasWake: true, wakeAt: s.now + 1000 }) }
pure def canTickQueryResult(s: TaskServiceOwners, id: int): bool = s.ticks.some(tick => tick.id == id and not(tick.completed))
pure def earlierWake(now: int, deadline: int, due: int): int = if (due > now and due < deadline) due else if (due <= now and now + 1000 < deadline) now + 1000 else deadline
pure def nextWake(s: TaskServiceOwners, rows: List[DueRow]): int = rows.select(row => row.task != "" and not(row.paused) and not(row.invalid) and not(s.quarantined.contains(row.task))).foldl(s.now + s.maxTick, (deadline, row) => earlierWake(s.now, deadline, row.due))
pure def queriedTick(s: TaskServiceOwners, entry: ServiceTick, id: int, succeeded: bool, rows: List[DueRow]): ServiceTick = if (entry.id == id and entry.timerDriven and succeeded) { ...entry, hasWake: rows.length() > 0, wakeAt: nextWake(s, rows) } else entry
pure def tickQueryResult(s: TaskServiceOwners, id: int, succeeded: bool, rows: List[DueRow]): TaskServiceOwners = { ...s, ticks: s.ticks.listMap(tick => queriedTick(s, tick, id, succeeded, rows)) }
pure def canFinishTick(s: TaskServiceOwners, id: int): bool = s.ticks.some(tick => tick.id == id and not(tick.completed)) and s.operations.every(operation => operation.tick != id or operation.completed)
pure def finishTick(s: TaskServiceOwners, id: int): TaskServiceOwners = {
  val tick = s.ticks.select(entry => entry.id == id).nthOr(0, { id: 0, timerDriven: false, completed: true, hasWake: false, wakeAt: 0 })
  val finished = { ...s, activeTick: if (s.activeTick == id) 0 else s.activeTick, ticks: s.ticks.listMap(entry => if (entry.id == id) { ...entry, completed: true } else entry) }
  if (tick.timerDriven and tick.hasWake) armed(finished, tick.wakeAt) else finished
}
pure def canResumeTimerWaiter(s: TaskServiceOwners, id: int): bool = s.wakeWaiters.contains(id) and s.ticks.some(tick => tick.id == id and tick.completed)
pure def resumeTimerWaiter(s: TaskServiceOwners, id: int): TaskServiceOwners = armed({ ...s, wakeWaiters: s.wakeWaiters.exclude(Set(id)) }, s.now + 1000)
pure def alwaysActiveTickOwned(s: TaskServiceOwners): bool = s.activeTick == 0 or s.ticks.some(tick => tick.id == s.activeTick and not(tick.completed))
pure def alwaysStoppedHasNoTimer(s: TaskServiceOwners): bool = s.stopped implies not(s.localTimer) and not(s.hasTimer)
```

### Stop joins scheduler drain, current tick, and then its pending-operation snapshot

Stop closes admission synchronously. Each stop invocation retains its own scheduler drain and captures the tick at the next await boundary. After that tick settles, it snapshots all still-pending admitted operations and waits for each. Uncancellable work remains owned until actual settlement; clearing the execution count happens only after the snapshot has drained.

```quint
pure def canPrepareStop(s: TaskServiceOwners, id: int): bool = id > 0 and not(s.drains.some(drain => drain.id == id))
pure def prepareStop(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, stopped: true, localTimer: false, hasTimer: false, drains: s.drains.append({ id: id, completed: false, tick: 0 }), stops: s.stops.append({ id: id, drain: id, phase: WaitScheduler, tick: 0, operations: Set() }) }
pure def canSchedulerDrained(s: TaskServiceOwners, id: int): bool = s.drains.some(drain => drain.id == id and not(drain.completed))
pure def schedulerDrained(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, drains: s.drains.listMap(drain => if (drain.id == id) { ...drain, completed: true } else drain) }
pure def canAwaitTick(s: TaskServiceOwners, id: int): bool = s.stops.some(call => call.id == id and call.phase == WaitScheduler and s.drains.some(drain => drain.id == call.drain and drain.completed))
pure def awaitTick(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, stops: s.stops.listMap(call => if (call.id == id) { ...call, phase: WaitTick, tick: s.activeTick } else call) }
pure def canSnapshotOperations(s: TaskServiceOwners, id: int): bool = s.stops.some(call => call.id == id and call.phase == WaitTick and (call.tick == 0 or s.ticks.some(tick => tick.id == call.tick and tick.completed)))
pure def captureOperation(ids: Set[int], entry: Operation): Set[int] = ids.union(Set(entry.id))
pure def snapshottedStop(call: StopCall, id: int, operations: List[Operation]): StopCall = if (call.id == id) { ...call, phase: WaitOperations, operations: operations.select(operation => not(operation.completed)).foldl(Set(), (ids, operation) => captureOperation(ids, operation)) } else call
pure def snapshotOperations(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, stops: s.stops.listMap(call => snapshottedStop(call, id, s.operations)) }
pure def canReturnStop(s: TaskServiceOwners, id: int): bool = s.stops.some(call => call.id == id and call.phase == WaitOperations and call.operations.forall(operation => not(operationPending(s, operation))))
pure def returnStop(s: TaskServiceOwners, id: int): TaskServiceOwners = { ...s, stops: s.stops.listMap(call => if (call.id == id) { ...call, phase: StopReturned } else call) }
pure def alwaysStopReturnsAfterOperations(s: TaskServiceOwners): bool = s.stops.every(call => call.phase != StopReturned or (call.operations.forall(operation => not(operationPending(s, operation))) and s.executions.every(execution => execution.phase == ExecutionDone)))
pure def quarantineCompleted(s: TaskServiceOwners, task: str, success: bool): TaskServiceOwners = { ...s, quarantined: s.quarantined.union(Set(task)), failures: s.failures + (if (success) 0 else 1) }
pure def healCompleted(s: TaskServiceOwners, task: str, success: bool): TaskServiceOwners = { ...s, quarantined: if (success) s.quarantined.exclude(Set(task)) else s.quarantined, failures: s.failures + (if (success) 0 else 1) }
pure def workerRestored(s: TaskServiceOwners, task: str): TaskServiceOwners = { ...s, quarantined: s.quarantined.exclude(Set(task)) }
pure def orphanMayQuarantine(s: TaskServiceOwners, task: str): bool = s.now - s.startedAt >= 60000 and not(s.quarantined.contains(task))
pure val idValues = Set(1, 2, 3, 4)
pure val operationValues = Set(1, 2, 3)
pure val tickValues = Set(0, 1, 2, 3)
pure val taskValues = Set("task1", "task2")
pure val nowValues = Set(0, 1000, 60000)
pure val maximumValues = Set(1000, 60000)
pure val rowsValues = Set(List(), List({ task: "task1", paused: false, invalid: false, due: 10000 }), List({ task: "task1", paused: true, invalid: false, due: 1000 }))
pure val fair_recheck = "weak"
pure val fair_finishExecution = "weak"
pure val fair_completeOperation = "weak"
pure val fair_finishTick = "weak"
pure val fair_schedulerDrained = "weak"
pure val fair_awaitTick = "weak"
pure val fair_snapshotOperations = "weak"
pure val fair_returnStop = "weak"
pure def leadsToStopJoins(s: TaskServiceOwners, later: TaskServiceOwners): bool = s.stops.every(call => later.stops.some(done => done.id == call.id and done.phase == StopReturned))
```

### Every retained stop keeps admission closed

Discovered by the proof: a returned stop in a state that still accepts admission could acquire new work after its drain. `prepareStop` synchronously seals admission and no operation reopens it, so any retained stop invocation implies that the service is stopped.

```quint
pure def alwaysStopsKeepAdmissionClosed(s: TaskServiceOwners): bool = s.stops.length() == 0 or s.stopped
```

### An execution identity names one invocation

Discovered by the proof: colliding execution identities could let a one-shot recheck revive a different, already completed invocation whose outer operation had settled. Execution identities are fresh invocation observations, retained after settlement; an update changes only that invocation.

```quint
pure def alwaysExecutionIdentitiesUnique(s: TaskServiceOwners): bool = s.executions.every(execution => s.executions.select(other => other.id == execution.id).length() == 1)
```

### A stop identity names one invocation

Discovered by the proof: colliding stop identities could let a ready stop return an unready sibling. Each stop invocation has a fresh observed identity, and retains it throughout its await phases.

```quint
pure def alwaysStopIdentitiesUnique(s: TaskServiceOwners): bool = s.stops.every(call => s.stops.select(other => other.id == call.id).length() == 1)
```

### Every stop retains its scheduler drain identity

Discovered by the proof: stop freshness checks the retained drain history, so a stop identity absent from that history would allow a later invocation to reuse it. The model's stop and drain identities name the same invocation; they do not assert that host Promise objects are distinct. `prepareStop` records both observations together and neither history is removed.

```quint
pure def alwaysStopsNameRetainedDrains(s: TaskServiceOwners): bool = s.stops.every(call => s.drains.some(drain => drain.id == call.id))
```

### A captured stop snapshot covers every pending operation

Discovered by the proof: an incomplete snapshot could let stop return while an execution still had a pending outer owner. Once a stop reaches its operation wait or returns, its captured set contains every operation still pending. The source takes that snapshot after sealing admission and joining the captured tick; subsequent settlements can only shrink the pending set. External storage and worker effects remain host observations, and an uncancellable operation stays pending until it actually settles.

```quint
pure def alwaysStopSnapshotsCoverPending(s: TaskServiceOwners): bool = s.stops.every(call => (call.phase == WaitOperations or call.phase == StopReturned) implies s.operations.every(operation => operation.completed or call.operations.contains(operation.id)))
```
