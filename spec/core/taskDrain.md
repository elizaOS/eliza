# Reusable repeat-task drain lifecycle

`utils/task-scheduling.ts` owns `TaskDrain.intervalMs`, `taskId`, and `disposed`. Callback/configuration references are immutable constructor inputs. A task matches only the captured agent, both queue/repeat tags, and every configured metadata key by strict value identity. The existing task query preserves its returned order; the first matching row wins and duplicate deletion uses all-settled semantics.

## Story: Reconcile a reusable drain and retire its persisted task

### Every asynchronous start retains its own storage operation and checks disposal after lookup

Concurrent starts may query or create independently, as the source has no start mutex. A lookup returning after disposal does not install a task. A create returning after disposal installs its returned ID and immediately starts disposal for it. Missing storage capabilities end that portion of startup without claiming a row was created. Worker registration precedes lookup unless explicitly skipped; a missing required callback or rejected registration fails the start.

```quint
type DrainPhase = RegisterWorker | LookupTasks | CreateTask | DeleteDuplicates | ReconcileTask | ReadInterval | WriteInterval | DeleteTask | DrainCallDone | DrainCallFailed
type DrainCall = { id: int, phase: DrainPhase, task: str, interval: int, duplicates: List[str], updateSupported: bool, deleteSupported: bool }
type TaskDrain = { configured: bool, interval: int, idleInterval: int, hasIdle: bool, skipWorker: bool, hasCallback: bool, disposed: bool, task: str, calls: List[DrainCall], workerRegistrations: int, failures: int }
pure val initial: TaskDrain = { configured: false, interval: 0, idleInterval: 0, hasIdle: false, skipWorker: false, hasCallback: false, disposed: false, task: "", calls: List(), workerRegistrations: 0, failures: 0 }
pure val noCall: DrainCall = { id: 0, phase: DrainCallDone, task: "", interval: 0, duplicates: List(), updateSupported: false, deleteSupported: false }
pure def drainCall(s: TaskDrain, id: int): DrainCall = s.calls.select(call => call.id == id).nthOr(0, noCall)
pure def canConfigure(s: TaskDrain): bool = not(s.configured)
pure def configure(s: TaskDrain, interval: int, idleInterval: int, hasIdle: bool, skipWorker: bool, hasCallback: bool): TaskDrain = { ...s, configured: true, interval: interval, idleInterval: idleInterval, hasIdle: hasIdle, skipWorker: skipWorker, hasCallback: hasCallback }
pure def canStart(s: TaskDrain, id: int): bool = s.configured and id > 0 and not(s.calls.some(call => call.id == id))
pure def start(s: TaskDrain, id: int, querySupported: bool, updateSupported: bool, deleteSupported: bool): TaskDrain = { ...s, calls: s.calls.append({ id: id, phase: if (s.disposed) DrainCallDone else if (not(s.skipWorker) and not(s.hasCallback)) DrainCallFailed else if (not(s.skipWorker)) RegisterWorker else if (querySupported) LookupTasks else DrainCallDone, task: "", interval: s.interval, duplicates: List(), updateSupported: updateSupported, deleteSupported: deleteSupported }), failures: s.failures + (if (not(s.disposed) and not(s.skipWorker) and not(s.hasCallback)) 1 else 0) }
pure def canRegistered(s: TaskDrain, id: int): bool = drainCall(s, id).phase == RegisterWorker
pure def registered(s: TaskDrain, id: int, success: bool, querySupported: bool): TaskDrain = { ...s, workerRegistrations: s.workerRegistrations + (if (success) 1 else 0), failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, phase: if (not(success)) DrainCallFailed else if (querySupported) LookupTasks else DrainCallDone } else call) }
pure def canLookupCompleted(s: TaskDrain, id: int): bool = drainCall(s, id).phase == LookupTasks
pure def lookupCompleted(s: TaskDrain, id: int, matchingIds: List[str], success: bool): TaskDrain = {
  val chosen = matchingIds.nthOr(0, "")
  { ...s, task: if (success and not(s.disposed) and chosen != "") chosen else s.task, failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, task: chosen, duplicates: (if (matchingIds.length() > 0) matchingIds.tail() else List()).select(value => value != ""), phase: if (not(success)) DrainCallFailed else if (s.disposed) DrainCallDone else if (chosen == "") CreateTask else if (call.deleteSupported and matchingIds.length() > 1) DeleteDuplicates else ReconcileTask } else call) }
}
pure def canDuplicatesCompleted(s: TaskDrain, id: int): bool = drainCall(s, id).phase == DeleteDuplicates
pure def duplicatesCompleted(s: TaskDrain, id: int): TaskDrain = { ...s, calls: s.calls.listMap(call => if (call.id == id) { ...call, duplicates: List(), phase: ReconcileTask } else call) }
pure def canCreated(s: TaskDrain, id: int): bool = drainCall(s, id).phase == CreateTask
pure def created(s: TaskDrain, id: int, task: str, success: bool): TaskDrain = { ...s, task: if (success) task else s.task, failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, task: task, phase: if (not(success)) DrainCallFailed else if (s.disposed and call.deleteSupported and task != "") DeleteTask else DrainCallDone } else call) }
pure def canReconcile(s: TaskDrain, id: int): bool = drainCall(s, id).phase == ReconcileTask
pure def reconcile(s: TaskDrain, id: int): TaskDrain = { ...s, calls: s.calls.listMap(call => if (call.id == id) { ...call, task: s.task, interval: s.interval, phase: if (s.task != "" and call.updateSupported) ReadInterval else DrainCallDone } else call) }
pure def alwaysOneCallPerIdentity(s: TaskDrain): bool = s.calls.every(call => call.id > 0 and s.calls.select(other => other.id == call.id).length() == 1)
pure def sometimesConcurrentStarts(s: TaskDrain): bool = s.calls.select(call => call.phase == LookupTasks or call.phase == CreateTask).length() > 1
```

### Interval writes and disposal use captured IDs while retaining their source-visible races

Updating the interval changes the local value synchronously even after disposal. It captures the current task ID, reads that row, clears the current ID if the row is missing, and writes only if update/base interval differs. Disposal sets the permanent flag synchronously, captures its deletion ID, reports a delete failure and clears the current ID after that deletion settles. A storage capability that lacks delete leaves the ID intact; this does not imply a successful persistent deletion. These operations do not invent a mutex absent from the source.

```quint
pure def canUpdateInterval(s: TaskDrain, id: int): bool = s.configured and id > 0 and not(s.calls.some(call => call.id == id))
pure def updateInterval(s: TaskDrain, id: int, interval: int, updateSupported: bool): TaskDrain = { ...s, interval: interval, calls: s.calls.append({ id: id, phase: if (s.task != "" and updateSupported) ReadInterval else DrainCallDone, task: s.task, interval: interval, duplicates: List(), updateSupported: updateSupported, deleteSupported: false }) }
pure def canIntervalRead(s: TaskDrain, id: int): bool = drainCall(s, id).phase == ReadInterval
pure def intervalRead(s: TaskDrain, id: int, rowExists: bool, bothIntervalsMatch: bool, success: bool): TaskDrain = { ...s, task: if (success and not(rowExists)) "" else s.task, failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, phase: if (not(success)) DrainCallFailed else if (not(rowExists) or bothIntervalsMatch) DrainCallDone else WriteInterval } else call) }
pure def canIntervalWritten(s: TaskDrain, id: int): bool = drainCall(s, id).phase == WriteInterval
pure def intervalWritten(s: TaskDrain, id: int, success: bool): TaskDrain = { ...s, failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, phase: if (success) DrainCallDone else DrainCallFailed } else call) }
pure def canDispose(s: TaskDrain, id: int): bool = s.configured and id > 0 and not(s.calls.some(call => call.id == id))
pure def dispose(s: TaskDrain, id: int, deleteSupported: bool): TaskDrain = { ...s, disposed: true, calls: s.calls.append({ id: id, phase: if (s.task != "" and deleteSupported) DeleteTask else DrainCallDone, task: s.task, interval: s.interval, duplicates: List(), updateSupported: false, deleteSupported: deleteSupported }) }
pure def canDeleted(s: TaskDrain, id: int): bool = drainCall(s, id).phase == DeleteTask
pure def deleted(s: TaskDrain, id: int, success: bool): TaskDrain = { ...s, task: "", failures: s.failures + (if (success) 0 else 1), calls: s.calls.listMap(call => if (call.id == id) { ...call, phase: DrainCallDone } else call) }
pure def stepDisposalIsPermanent(before: TaskDrain, after: TaskDrain): bool = before.disposed implies after.disposed
pure def sometimesLateCreateNeedsDeletion(s: TaskDrain): bool = s.disposed and s.calls.some(call => call.phase == DeleteTask and call.task != "")
type DrainResult = { hasInterval: bool, interval: int }
pure def adaptiveInterval(s: TaskDrain, isNumber: bool, positive: bool): DrainResult = { hasInterval: s.hasIdle and isNumber, interval: if (positive) s.interval else s.idleInterval }
pure def lawIdleBackoffPreservesConfiguredActiveCadence(s: TaskDrain): bool = adaptiveInterval(s, true, true).interval == s.interval and adaptiveInterval(s, true, false).interval == s.idleInterval
pure val idValues = Set(1, 2, 3, 4)
pure val taskValues = Set("task1", "task2")
pure val intervalValues = Set(0, 1000, 5000)
pure val idleIntervalValues = Set(10000)
pure val matchingIdsValues = Set(List(), List("task1"), List("task1", "task2"))
pure val fair_registered = "weak"
pure val fair_lookupCompleted = "weak"
pure val fair_duplicatesCompleted = "weak"
pure val fair_created = "weak"
pure val fair_reconcile = "weak"
pure val fair_intervalRead = "weak"
pure val fair_intervalWritten = "weak"
pure val fair_deleted = "weak"
pure def leadsToCallsSettle(s: TaskDrain, later: TaskDrain): bool = s.calls.every(call => later.calls.some(done => done.id == call.id and (done.phase == DrainCallDone or done.phase == DrainCallFailed)))
```
