# Shared scheduler timer and host process tasks

`services/task-scheduler.ts` has one process timer shared by database queue ticks and registered host tasks. Query ownership and generation fences are specified in [queryDrain](./queryDrain.md). This unit specifies the timer, active-tick promise identity and named process-task callbacks that were not part of that query model.

## Story: Reuse one timer and drain the exact disposed task

### Process task names are unique only while registered and stale disposers preserve replacements

Registration rejects an occupied name and installs an independent AbortController. Each timer callback queues at most one run per registered task. Before entering the deferred callback, the abort signal is rechecked. Disposal removes only the identical registration, aborts it, and waits for its queued/running callback. A replacement with the same name can run while the former task drains. Callback errors are logged and release the active latch for a later tick.
Discovered by the proof: disposal retains the abort/detach facts until its
callback joins, and every allocated task or tick identity remains below the
next allocation serial. Distinct task identities keep a stale disposer from
retiring another registration.

```quint
type ProcessPhase = ProcessIdle | ProcessQueued | ProcessRunning
type ProcessEntry = { id: int, name: str, present: bool, aborted: bool, phase: ProcessPhase, disposing: bool, disposed: bool, runs: int, failures: int }
type TickEntry = { id: int, generation: int, completed: bool }
type ProcessScheduler = { timer: bool, adapter: str, generation: int, serial: int, activeTick: int, tasks: List[ProcessEntry], ticks: List[TickEntry] }
pure val initial: ProcessScheduler = { timer: false, adapter: "", generation: 0, serial: 1, activeTick: 0, tasks: List(), ticks: List() }
pure val noTask: ProcessEntry = { id: 0, name: "", present: false, aborted: false, phase: ProcessIdle, disposing: false, disposed: false, runs: 0, failures: 0 }
pure def taskAt(s: ProcessScheduler, id: int): ProcessEntry = s.tasks.select(task => task.id == id).nthOr(0, noTask)
pure def canRegister(s: ProcessScheduler, name: str): bool = not(s.tasks.some(task => task.name == name and task.present))
pure def register(s: ProcessScheduler, name: str): ProcessScheduler = { ...s, timer: true, serial: s.serial + 1, tasks: s.tasks.append({ id: s.serial, name: name, present: true, aborted: false, phase: ProcessIdle, disposing: false, disposed: false, runs: 0, failures: 0 }) }
pure def canDispose(s: ProcessScheduler, id: int): bool = taskAt(s, id).id != 0
pure def dispose(s: ProcessScheduler, id: int): ProcessScheduler = { ...s, tasks: s.tasks.listMap(task => if (task.id == id) { ...task, present: false, aborted: true, disposing: true } else task), timer: s.timer and (s.adapter != "" or s.tasks.some(task => task.id != id and task.present)) }
pure def canReturnDispose(s: ProcessScheduler, id: int): bool = taskAt(s, id).disposing and taskAt(s, id).phase == ProcessIdle
pure def returnDispose(s: ProcessScheduler, id: int): ProcessScheduler = { ...s, tasks: s.tasks.listMap(task => if (task.id == id) { ...task, disposing: false, disposed: true } else task) }
pure def canTick(s: ProcessScheduler): bool = s.timer
pure def tick(s: ProcessScheduler): ProcessScheduler = {
  val startsQuery = s.adapter != "" and s.activeTick == 0
  { ...s, tasks: s.tasks.listMap(task => if (task.present and not(task.aborted) and task.phase == ProcessIdle) { ...task, phase: ProcessQueued } else task), activeTick: if (startsQuery) s.serial else s.activeTick, serial: if (startsQuery) s.serial + 1 else s.serial, ticks: if (startsQuery) s.ticks.append({ id: s.serial, generation: s.generation, completed: false }) else s.ticks }
}
pure def canEnterProcess(s: ProcessScheduler, id: int): bool = taskAt(s, id).phase == ProcessQueued
pure def enterProcess(s: ProcessScheduler, id: int): ProcessScheduler = { ...s, tasks: s.tasks.listMap(task => if (task.id == id) { ...task, phase: if (task.aborted) ProcessIdle else ProcessRunning, runs: task.runs + (if (task.aborted) 0 else 1) } else task) }
pure def canFinishProcess(s: ProcessScheduler, id: int): bool = taskAt(s, id).phase == ProcessRunning
pure def finishProcess(s: ProcessScheduler, id: int, success: bool): ProcessScheduler = { ...s, tasks: s.tasks.listMap(task => if (task.id == id) { ...task, phase: ProcessIdle, failures: task.failures + (if (success) 0 else 1) } else task) }
pure def alwaysRegisteredNamesUnique(s: ProcessScheduler): bool = s.tasks.every(task => not(task.present) or s.tasks.select(other => other.present and other.name == task.name).length() == 1)
pure def alwaysDisposedCallbacksDrained(s: ProcessScheduler): bool = s.tasks.every(task => task.disposed implies task.phase == ProcessIdle and task.aborted and not(task.present))
pure def alwaysDisposingIsDetached(s: ProcessScheduler): bool = s.tasks.every(task => task.disposing implies task.aborted and not(task.present))
pure def alwaysAllocatedIdentitiesFresh(s: ProcessScheduler): bool = s.serial >= 1 and s.tasks.every(task => task.id > 0 and task.id < s.serial and s.tasks.select(other => other.id == task.id).length() == 1) and s.ticks.every(tick => tick.id > 0 and tick.id < s.serial and s.ticks.select(other => other.id == tick.id).length() == 1)
pure def sometimesReplacementRunsWhileOldDrains(s: ProcessScheduler): bool = s.tasks.some(old => old.disposing and old.phase == ProcessRunning and s.tasks.some(replacement => replacement.name == old.name and replacement.present and replacement.phase == ProcessRunning))
pure val nameValues = Set("health", "metrics", "")
pure val idValues = Set(1, 2, 3, 4)
```

### Adapter detachment keeps the timer only for registered process work

Starting the same adapter while the timer exists is idempotent. A new adapter or restarted timer increments generation and detaches the active-tick pointer, allowing its old uncancellable query to finish separately. A late tick finally clears the active pointer only if that pointer still names itself. Stopping the database scheduler keeps the timer when process tasks remain.

Discovered by simulation: disposal progress must select a retained task identity
from state. A later registration can have an identity outside the simulator's
integer samples. The fair disposer settles the oldest outstanding disposal;
when the selected callback is running this assumes its external work returns
or throws, and never asserts success.

```quint
pure def startAdapter(s: ProcessScheduler, adapter: str): ProcessScheduler = if (s.timer and s.adapter == adapter) s else { ...s, timer: true, adapter: adapter, generation: s.generation + 1, activeTick: 0 }
pure def detachAdapter(s: ProcessScheduler): ProcessScheduler = { ...s, adapter: "", generation: s.generation + 1, activeTick: 0, timer: s.timer and s.tasks.some(task => task.present) }
pure def canFinishTick(s: ProcessScheduler, id: int): bool = s.ticks.some(entry => entry.id == id and not(entry.completed))
pure def finishTick(s: ProcessScheduler, id: int): ProcessScheduler = { ...s, ticks: s.ticks.listMap(entry => if (entry.id == id) { ...entry, completed: true } else entry), activeTick: if (s.activeTick == id) 0 else s.activeTick }
pure def alwaysActiveTickIsOwned(s: ProcessScheduler): bool = s.activeTick == 0 or s.ticks.some(entry => entry.id == s.activeTick and not(entry.completed) and entry.generation == s.generation)
pure def alwaysTimerIsRequired(s: ProcessScheduler): bool = s.adapter != "" or s.tasks.some(task => task.present) implies s.timer
pure def sometimesTaskTimerSurvivesDetach(s: ProcessScheduler): bool = s.adapter == "" and s.timer and s.tasks.some(task => task.present)
pure val adapterValues = Set("adapter1", "adapter2")
pure def nextDisposingTask(s: ProcessScheduler): ProcessEntry = s.tasks.select(task => task.disposing and not(task.disposed)).nthOr(0, noTask)
pure def canAdvanceDisposal(s: ProcessScheduler): bool = nextDisposingTask(s).id != 0
pure def advanceDisposal(s: ProcessScheduler, success: bool): ProcessScheduler = {
  val task = nextDisposingTask(s)
  if (task.phase == ProcessQueued) enterProcess(s, task.id)
  else if (task.phase == ProcessRunning) finishProcess(s, task.id, success)
  else returnDispose(s, task.id)
}
pure val fair_advanceDisposal = "weak"
pure def leadsToDisposerReturns(s: ProcessScheduler, later: ProcessScheduler): bool = s.tasks.every(task => task.disposing implies later.tasks.some(done => done.id == task.id and done.disposed))
```
