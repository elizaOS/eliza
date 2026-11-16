# Scheduled tasks

The scheduling plugin, folded into the agent, keeps scheduled tasks in its
store and runs them with its runner service. [Core scheduling](../core/scheduling.md)
owns when an occurrence is due. This spec owns one tenant-scoped recurring
task row: firing an occurrence, the owner's complete and skip verbs and
their receipts, dismissal, the binding to the task's owner, the
standalone worker that seeds rows at boot, and the owner's global pause
that holds back work while the owner is away.

## Story: Keep a recurring task exact through retries, races and restarts

> As a user, each occurrence of my recurring task fires at most once. When I
> complete or skip it, that happens once even if my request is retried, and a
> completion creates its follow-up once. Skipping an occurrence that has not
> fired yet means it never fires. Dismissing the task stops it.

### A change commits atomically against the revision it read

Every change reads the row and commits only if the row is still at the
revision it read. The task's state, its receipt and its log entry are one
transaction: a receipt is never written without its log entry, or the reverse.

```quint
type TaskState = TaskScheduled | TaskFired | TaskCompleted | TaskSkipped | TaskDismissed
type OwnerVerb = CompleteVerb | SkipVerb
type OwnerBinding = NoBinding | FallbackBinding | RegisteredBinding
type DriverPhase = DriverActive | DriverRetiring | DriverClean | DriverCleanupError
type ScheduledTask = { status: TaskState, revision: int, occurrence: int, dispatched: List[int], settledPending: List[int], completions: List[int], children: int, receipts: List[str], logs: List[str], ownerRegistered: bool, lastBinding: OwnerBinding, driver: DriverPhase, bootWrite: bool, bootRow: bool, paused: bool, pauseStart: int, pauseEnd: int, now: int, respectsPause: bool, deferredTo: int }
pure val initial: ScheduledTask = { status: TaskScheduled, revision: 0, occurrence: 1, dispatched: List(), settledPending: List(), completions: List(), children: 0, receipts: List(), logs: List(), ownerRegistered: false, lastBinding: NoBinding, driver: DriverActive, bootWrite: false, bootRow: false, paused: false, pauseStart: 0, pauseEnd: -1, now: 0, respectsPause: true, deferredTo: -1 }
pure val seenRevisionValues = Set(0, 1, 2, 3, 4, 5)
pure def alwaysReceiptAndLogCommitTogether(t: ScheduledTask): bool = t.receipts == t.logs
```

### An occurrence fires at most once, for the owner bound when it fires

The scheduler claims a scheduled row at the revision it read, moving it to
fired and recording the occurrence. A deferred owner may register after boot
and replace the fallback binding; a fire uses whichever binding is current
when it starts. Only an active worker fires, and never before the time a
pause deferred the row to.

```quint
type Rising = { last: int, rising: bool }
pure def pauseActive(t: ScheduledTask): bool = t.paused and t.now >= t.pauseStart and (t.pauseEnd == -1 or t.now < t.pauseEnd)
pure def heldByPause(t: ScheduledTask): bool = t.respectsPause and pauseActive(t)
pure def strictlyRising(xs: List[int]): bool = xs.foldl({ last: 0, rising: true }, (acc, x) => { last: x, rising: acc.rising and x > acc.last }).rising
pure def bindingFor(registered: bool): OwnerBinding = if (registered) RegisteredBinding else FallbackBinding
pure def canFire(t: ScheduledTask, seenRevision: int): bool = t.driver == DriverActive and t.status == TaskScheduled and seenRevision == t.revision and t.now >= t.deferredTo
pure def fire(t: ScheduledTask, seenRevision: int): ScheduledTask =
  if (heldByPause(t)) { ...t, deferredTo: t.pauseEnd, revision: t.revision + 1 }
  else { ...t, status: TaskFired, dispatched: t.dispatched.append(t.occurrence), revision: t.revision + 1, lastBinding: bindingFor(t.ownerRegistered), deferredTo: -1 }
pure def canRegisterOwner(t: ScheduledTask): bool = not(t.ownerRegistered)
pure def registerOwner(t: ScheduledTask): ScheduledTask = { ...t, ownerRegistered: true }
pure def alwaysEachOccurrenceFiresOnce(t: ScheduledTask): bool = strictlyRising(t.dispatched)
pure def stepFireUsesTheCurrentOwner(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  via == "fire" and after.status == TaskFired implies after.lastBinding == bindingFor(before.ownerRegistered)
pure def sometimesSecondOccurrenceFired(t: ScheduledTask): bool = t.dispatched.length() >= 2 and t.lastBinding == RegisteredBinding
```

### A verb applies once per idempotency key, and completion settles once

Complete and skip carry an idempotency key. A key already in the receipts is a
replay and changes nothing. A completion records its occurrence and creates
the follow-up task exactly once.

```quint
pure val keyValues = Set("verb-1", "verb-2", "")
pure def canApplyVerb(t: ScheduledTask, seenRevision: int, key: str, verb: OwnerVerb): bool =
  key != "" and not(t.receipts.includes(key)) and (t.status == TaskScheduled or t.status == TaskFired) and seenRevision == t.revision
pure def applyVerb(t: ScheduledTask, seenRevision: int, key: str, verb: OwnerVerb): ScheduledTask =
  { ...t,
    status: if (verb == CompleteVerb) TaskCompleted else TaskSkipped,
    settledPending: if (t.status == TaskScheduled) t.settledPending.append(t.occurrence) else t.settledPending,
    completions: if (verb == CompleteVerb) t.completions.append(t.occurrence) else t.completions,
    children: if (verb == CompleteVerb) t.children + 1 else t.children,
    receipts: t.receipts.append(key), logs: t.logs.append(key), revision: t.revision + 1 }
pure def alwaysEachKeyAppliesOnce(t: ScheduledTask): bool = t.receipts.every(k => t.receipts.select(x => x == k).length() == 1)
pure def alwaysCompletionSettlesOncePerOccurrence(t: ScheduledTask): bool = strictlyRising(t.completions) and t.children == t.completions.length()
pure def sometimesCompletedWithFollowUp(t: ScheduledTask): bool = t.status == TaskCompleted and t.children == 1 and t.dispatched.length() == 1
```

### Settling the pending occurrence means it never fires, and the next one reopens the row

A verb on a scheduled row settles the occurrence it was waiting for, which
then never fires. A fired, skipped or completed row reopens for its next
occurrence.

```quint
pure def canReopen(t: ScheduledTask): bool = t.status == TaskFired or t.status == TaskSkipped or t.status == TaskCompleted
pure def reopen(t: ScheduledTask): ScheduledTask = { ...t, status: TaskScheduled, occurrence: t.occurrence + 1, revision: t.revision + 1 }
pure def alwaysSettledPendingOccurrenceNeverFires(t: ScheduledTask): bool = t.settledPending.every(o => not(t.dispatched.includes(o)))
pure def sometimesPendingOccurrenceSkipped(t: ScheduledTask): bool = t.settledPending.length() > 0 and t.dispatched.length() > 0
```

### Dismissing a task stops it for good

A scheduled or fired row can be dismissed at the revision it read. Nothing
changes a dismissed row again.

```quint
pure def canDismiss(t: ScheduledTask, seenRevision: int): bool = (t.status == TaskScheduled or t.status == TaskFired) and seenRevision == t.revision
pure def dismiss(t: ScheduledTask, seenRevision: int): ScheduledTask = { ...t, status: TaskDismissed, revision: t.revision + 1 }
pure def stepDismissedTaskNeverChanges(before: ScheduledTask, after: ScheduledTask): bool =
  before.status == TaskDismissed implies (after.status == TaskDismissed and after.dispatched == before.dispatched and after.revision == before.revision)
pure def sometimesDismissedAfterFiring(t: ScheduledTask): bool = t.status == TaskDismissed and t.dispatched.length() > 0
```

## Story: Pause scheduled work while the owner is away

> As the owner, I pause my agent's routines while I am on holiday; it stays
> quiet until I come back, except for what must not wait.

### One pause window at a time, ending strictly after it starts or left open

```quint
pure val opensAtValues = Set(0, 10)
pure val closesAtValues = Set(-1, 5, 20)
pure def canSetPause(t: ScheduledTask, opensAt: int, closesAt: int): bool = opensAt >= 0 and (closesAt == -1 or closesAt > opensAt)
pure def setPause(t: ScheduledTask, opensAt: int, closesAt: int): ScheduledTask = { ...t, paused: true, pauseStart: opensAt, pauseEnd: closesAt }
pure def canClearPause(t: ScheduledTask): bool = t.paused
pure def clearPause(t: ScheduledTask): ScheduledTask = { ...t, paused: false, pauseStart: 0, pauseEnd: -1 }
pure def alwaysPauseWindowWellFormed(t: ScheduledTask): bool = t.paused implies t.pauseStart >= 0 and (t.pauseEnd == -1 or t.pauseEnd > t.pauseStart)
```

### Work that respects the pause is skipped while a window is active and rescheduled for its end; other work runs

Whether a task respects the pause is set while the pause does not hold
it. While a window is active, firing a task that respects the pause skips
it for the pause and reschedules it for the window's end, or leaves it
held until an open window is cleared. Work that does not respect it, such
as an emergency, fires anyway.

```quint
pure val respectsPauseValues = Set(true, false)
pure def passTime(t: ScheduledTask): ScheduledTask = { ...t, now: t.now + 10 }
pure def canClassifyTask(t: ScheduledTask, respectsPause: bool): bool = t.status == TaskScheduled and not(heldByPause(t))
pure def classifyTask(t: ScheduledTask, respectsPause: bool): ScheduledTask = { ...t, respectsPause: respectsPause }
pure def stepPauseDecidesFiring(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  (via == "fire" implies
    (if (heldByPause(before)) after.status == TaskScheduled and after.dispatched == before.dispatched and after.deferredTo == before.pauseEnd
     else after.status == TaskFired)) and
  (via == "classifyTask" implies not(heldByPause(before)))
pure def sometimesSkippedForPause(t: ScheduledTask): bool = t.status == TaskScheduled and t.deferredTo > 0 and heldByPause(t)
pure def sometimesEmergencyRanDuringPause(t: ScheduledTask): bool = t.status == TaskFired and not(t.respectsPause) and pauseActive(t)
```

## Story: Unload the scheduler without losing or leaking its boot write

> As a user, when the agent restarts or the scheduling worker is unloaded, a
> write the worker started at boot is finished or refused before its rows are
> cleaned up, and nothing fires while the worker is unloading.

### Unloading waits for the in-flight boot write before cleaning up

An active worker may start one boot write. Unloading withdraws the worker
first; cleanup runs only after the boot write settled, whether it committed,
lost its acknowledgement or was rejected. A clean unload leaves no boot row; a
failed cleanup says so. A retired worker can be loaded again.

```quint
pure def canStartBootWrite(t: ScheduledTask): bool = t.driver == DriverActive and not(t.bootWrite)
pure def startBootWrite(t: ScheduledTask): ScheduledTask = { ...t, bootWrite: true }
pure def canSettleBootWrite(t: ScheduledTask, rowWritten: bool): bool = t.bootWrite
pure def settleBootWrite(t: ScheduledTask, rowWritten: bool): ScheduledTask = { ...t, bootWrite: false, bootRow: t.bootRow or rowWritten }
pure def canUnloadDriver(t: ScheduledTask): bool = t.driver == DriverActive
pure def unloadDriver(t: ScheduledTask): ScheduledTask = { ...t, driver: DriverRetiring }
pure def canFinishCleanup(t: ScheduledTask, ok: bool): bool = t.driver == DriverRetiring and not(t.bootWrite)
pure def finishCleanup(t: ScheduledTask, ok: bool): ScheduledTask = { ...t, driver: if (ok) DriverClean else DriverCleanupError, bootRow: t.bootRow and not(ok) }
pure def canReloadDriver(t: ScheduledTask): bool = t.driver == DriverClean or t.driver == DriverCleanupError
pure def reloadDriver(t: ScheduledTask): ScheduledTask = { ...t, driver: DriverActive }
pure def alwaysRetiredWorkerHasNoWriteInFlight(t: ScheduledTask): bool = (t.driver == DriverClean or t.driver == DriverCleanupError) implies not(t.bootWrite)
pure def alwaysCleanUnloadLeavesNoBootRow(t: ScheduledTask): bool = t.driver == DriverClean implies not(t.bootRow)
pure def stepOnlyAnActiveWorkerFires(before: ScheduledTask, via: str, after: ScheduledTask): bool = via == "fire" implies before.driver == DriverActive
pure def sometimesFailedCleanupKeepsTheBootRow(t: ScheduledTask): bool = t.driver == DriverCleanupError and t.bootRow
```

### Default tasks are seeded only when the plugin profile asks for them

The worker seeds its default tasks only when the active plugin profile
requests defaults, and only once.

```quint
pure def seedsDefaults(profileRequestsDefaults: bool, alreadySeeded: bool): bool = profileRequestsDefaults and not(alreadySeeded)
pure def lawNoSeedingUnlessTheProfileAsks(profileRequestsDefaults: bool, alreadySeeded: bool): bool =
  not(profileRequestsDefaults) implies not(seedsDefaults(profileRequestsDefaults, alreadySeeded))
```
