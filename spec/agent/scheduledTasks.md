# Scheduled tasks

The scheduling plugin, folded into the agent, keeps scheduled tasks in its
store and runs them with its runner service. [Core scheduling](../core/scheduling.md)
owns when an occurrence is due. This spec owns one tenant-scoped recurring
task row: firing an occurrence, the owner's verbs (complete, skip, snooze,
escalate, acknowledge, edit, reopen and fire now) and their receipts,
the owner's list, dismissal, the binding to the task's owner, the
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
type TaskAnswer = NoAnswer | SnoozeAnswer | EscalateAnswer | AcknowledgeAnswer | EditAnswer | ReopenAnswer
type ScheduledTask = { status: TaskState, revision: int, occurrence: int, dispatched: List[int], settledPending: List[int], completions: List[int], children: int, receipts: List[str], logs: List[str], ownerRegistered: bool, lastBinding: OwnerBinding, driver: DriverPhase, bootWrite: bool, bootRow: bool, paused: bool, pauseStart: int, pauseEnd: int, now: int, respectsPause: bool, deferredTo: int, followups: int, acknowledged: bool, edits: int, reopenUntil: int, lastAnswer: TaskAnswer }
pure val initial: ScheduledTask = { status: TaskScheduled, revision: 0, occurrence: 1, dispatched: List(), settledPending: List(), completions: List(), children: 0, receipts: List(), logs: List(), ownerRegistered: false, lastBinding: NoBinding, driver: DriverActive, bootWrite: false, bootRow: false, paused: false, pauseStart: 0, pauseEnd: -1, now: 0, respectsPause: true, deferredTo: -1, followups: 0, acknowledged: false, edits: 0, reopenUntil: 0, lastAnswer: NoAnswer }
pure val seenRevisionValues = Set(0, 1, 2, 3, 4, 5)
pure def alwaysReceiptAndLogCommitTogether(t: ScheduledTask): bool = t.receipts == t.logs
```

### An occurrence fires at most once, for the owner bound when it fires

The scheduler claims a scheduled row at the revision it read, moving it to
fired and recording the occurrence. A deferred owner may register after boot
and replace the fallback binding; a fire uses whichever binding is current
when it starts. Only an active worker fires. The scheduler fires a row
only once the time it was deferred to has come; the owner's fire now
runs the scheduled occurrence at once, whatever its due time. A firing
starts the occurrence's follow-up ladder from nothing and unacknowledged.

```quint
type Rising = { last: int, rising: bool }
pure def pauseActive(t: ScheduledTask): bool = t.paused and t.now >= t.pauseStart and (t.pauseEnd == -1 or t.now < t.pauseEnd)
pure def heldByPause(t: ScheduledTask): bool = t.respectsPause and pauseActive(t)
pure def strictlyRising(xs: List[int]): bool = xs.foldl({ last: 0, rising: true }, (acc, x) => { last: x, rising: acc.rising and x > acc.last }).rising
pure def bindingFor(registered: bool): OwnerBinding = if (registered) RegisteredBinding else FallbackBinding
pure val manualValues = Set(true, false)
pure def canFire(t: ScheduledTask, seenRevision: int, manual: bool): bool = t.driver == DriverActive and t.status == TaskScheduled and seenRevision == t.revision and (manual or t.now >= t.deferredTo)
pure def fire(t: ScheduledTask, seenRevision: int, manual: bool): ScheduledTask =
  if (heldByPause(t)) { ...t, deferredTo: t.pauseEnd, revision: t.revision + 1 }
  else { ...t, status: TaskFired, dispatched: t.dispatched.append(t.occurrence), revision: t.revision + 1, lastBinding: bindingFor(t.ownerRegistered), deferredTo: -1, followups: 0, acknowledged: false }
pure def canRegisterOwner(t: ScheduledTask): bool = not(t.ownerRegistered)
pure def registerOwner(t: ScheduledTask): ScheduledTask = { ...t, ownerRegistered: true }
pure def alwaysEachOccurrenceFiresOnce(t: ScheduledTask): bool = strictlyRising(t.dispatched)
pure def stepFireUsesTheCurrentOwner(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  via == "fire" and after.status == TaskFired implies (after.lastBinding == bindingFor(before.ownerRegistered) and after.followups == 0 and not(after.acknowledged))
pure def sometimesSecondOccurrenceFired(t: ScheduledTask): bool = t.dispatched.length() >= 2 and t.lastBinding == RegisteredBinding
```

### A verb applies once per idempotency key, and completion settles once

Complete and skip carry an idempotency key. A key already in the receipts is a
replay and changes nothing. A completion records its occurrence and creates
the follow-up task exactly once. Completing or skipping opens the owner's
reopen window, which closes twenty time units later.

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
    receipts: t.receipts.append(key), logs: t.logs.append(key), revision: t.revision + 1, reopenUntil: t.now + 20 }
pure def alwaysEachKeyAppliesOnce(t: ScheduledTask): bool = t.receipts.every(k => t.receipts.select(x => x == k).length() == 1)
pure def alwaysCompletionSettlesOncePerOccurrence(t: ScheduledTask): bool = strictlyRising(t.completions) and t.children == t.completions.length()
pure def sometimesCompletedWithFollowUp(t: ScheduledTask): bool = t.status == TaskCompleted and t.children == 1 and t.dispatched.length() == 1
```

### Settling the pending occurrence means it never fires, and the next one reopens the row

A verb on a scheduled row settles the occurrence it was waiting for, which
then never fires. A fired, skipped or completed row reopens for its next
occurrence, with a fresh follow-up ladder. Occurrences count from one, and no occurrence the row fired,
settled or completed is later than its current one; a scheduled row has
not yet fired, settled or completed its current occurrence, and a fired row
has not completed it.

```quint
pure def canReopen(t: ScheduledTask): bool = t.status == TaskFired or t.status == TaskSkipped or t.status == TaskCompleted
pure def reopen(t: ScheduledTask): ScheduledTask = { ...t, status: TaskScheduled, occurrence: t.occurrence + 1, revision: t.revision + 1, followups: 0, acknowledged: false }
pure def alwaysSettledPendingOccurrenceNeverFires(t: ScheduledTask): bool = t.settledPending.every(o => not(t.dispatched.includes(o)))
pure def alwaysOccurrencesTrailTheRow(t: ScheduledTask): bool =
  t.occurrence >= 1 and
  t.dispatched.every(o => o < t.occurrence or (o == t.occurrence and t.status != TaskScheduled)) and
  t.settledPending.every(o => o < t.occurrence or (o == t.occurrence and t.status != TaskScheduled)) and
  t.completions.every(o => o < t.occurrence or (o == t.occurrence and t.status != TaskScheduled and t.status != TaskFired))
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

## Story: Answer a scheduled task from my list

> As the owner, I see my own scheduled tasks and can snooze, escalate,
> acknowledge, edit, reopen or run one now. Each answer happens once even if
> my request is retried, and the reply tells me exactly what was committed.

### Every owner answer is keyed, committed against the revision it read, and logged once

Snooze, escalate, acknowledge, edit and reopen carry an idempotency key and
the revision the owner read, exactly as complete and skip do: a key already
in the receipts is a replay and changes nothing, and each answer writes its
receipt and log entry with the change. Snooze applies to a scheduled or
fired row and needs a time later than now: it defers the row to that time
and restarts the follow-up ladder, and snoozing a fired row starts its next
occurrence. Escalate moves a fired, unacknowledged row one step up its
follow-up ladder. Acknowledge marks a fired row seen without settling it, so
it can still be completed, and stops its escalation. Edit changes what the
task says or when it recurs, never its state or occurrences. Reopen brings a
completed or skipped row back for its next occurrence, only while its reopen
window is open; a dismissed row is never reopened.

```quint
pure val answerValues = Set(SnoozeAnswer, EscalateAnswer, AcknowledgeAnswer, EditAnswer, ReopenAnswer)
pure val untilValues = Set(0, 15, 40)
pure def answerApplies(t: ScheduledTask, answer: TaskAnswer, until: int): bool =
  if (answer == SnoozeAnswer) (t.status == TaskScheduled or t.status == TaskFired) and until > t.now
  else if (answer == EscalateAnswer) t.status == TaskFired and not(t.acknowledged)
  else if (answer == AcknowledgeAnswer) t.status == TaskFired
  else if (answer == EditAnswer) t.status == TaskScheduled or t.status == TaskFired
  else if (answer == ReopenAnswer) (t.status == TaskCompleted or t.status == TaskSkipped) and t.now < t.reopenUntil
  else false
pure def canAnswerTask(t: ScheduledTask, seenRevision: int, key: str, answer: TaskAnswer, until: int): bool =
  key != "" and not(t.receipts.includes(key)) and seenRevision == t.revision and answerApplies(t, answer, until)
pure def answeredWith(answer: TaskAnswer, until: int, t: ScheduledTask): ScheduledTask =
  if (answer == SnoozeAnswer)
    (if (t.status == TaskFired) { ...t, status: TaskScheduled, occurrence: t.occurrence + 1, deferredTo: until, followups: 0, acknowledged: false }
     else { ...t, deferredTo: until, followups: 0 })
  else if (answer == EscalateAnswer) { ...t, followups: t.followups + 1 }
  else if (answer == AcknowledgeAnswer) { ...t, acknowledged: true }
  else if (answer == EditAnswer) { ...t, edits: t.edits + 1 }
  else { ...t, status: TaskScheduled, occurrence: t.occurrence + 1, followups: 0, acknowledged: false, deferredTo: -1 }
pure def answerTask(t: ScheduledTask, seenRevision: int, key: str, answer: TaskAnswer, until: int): ScheduledTask =
  { ...answeredWith(answer, until, t), receipts: t.receipts.append(key), logs: t.logs.append(key), revision: t.revision + 1, lastAnswer: answer }
pure def stepOwnerAnswersDoWhatTheySay(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  via == "answerTask" implies
    (after.revision == before.revision + 1 and after.dispatched == before.dispatched and after.completions == before.completions and
     (after.lastAnswer == SnoozeAnswer implies (after.status == TaskScheduled and after.deferredTo > before.now and after.followups == 0)) and
     (after.lastAnswer == EscalateAnswer implies (before.status == TaskFired and not(before.acknowledged) and after.followups == before.followups + 1)) and
     (after.lastAnswer == AcknowledgeAnswer implies (after.status == TaskFired and after.acknowledged)) and
     (after.lastAnswer == EditAnswer implies (after.status == before.status and after.occurrence == before.occurrence and after.edits == before.edits + 1)) and
     (after.lastAnswer == ReopenAnswer implies ((before.status == TaskCompleted or before.status == TaskSkipped) and before.now < before.reopenUntil and after.status == TaskScheduled)))
pure def alwaysAcknowledgedRowHasFired(t: ScheduledTask): bool = t.acknowledged implies t.status != TaskScheduled
pure def sometimesSnoozedFiredRowFiresAgain(t: ScheduledTask): bool = t.lastAnswer == SnoozeAnswer and t.dispatched.length() >= 2 and t.status == TaskFired
pure def sometimesAcknowledgedThenCompleted(t: ScheduledTask): bool = t.status == TaskCompleted and t.acknowledged
pure def sometimesReopenedByOwner(t: ScheduledTask): bool = t.lastAnswer == ReopenAnswer and t.completions.length() > 0
pure def sometimesEscalated(t: ScheduledTask): bool = t.followups > 0 and t.status == TaskFired
```

### A verb's reply says whether it was applied, refused, or never reached a task

A verb on a task that does not exist is not found. A malformed body is
refused before the task is read: a snooze with neither a positive number of
minutes nor a time, an edit with no field, and an unknown verb. A verb that
does not apply to the task's current state, or an edit of a read-only field,
is a conflict and changes nothing. Only an applied verb answers with the
committed task, whose fields are the ones the owner asked for.

```quint
type VerbReply = VerbApplied | VerbMalformed | VerbNotFound | VerbConflict
pure def verbReply(found: bool, wellFormed: bool, applies: bool): VerbReply =
  if (not(wellFormed)) VerbMalformed else if (not(found)) VerbNotFound else if (not(applies)) VerbConflict else VerbApplied
pure def lawOnlyAnApplicableVerbIsApplied(found: bool, wellFormed: bool, applies: bool): bool =
  verbReply(found, wellFormed, applies) == VerbApplied iff (found and wellFormed and applies)
```

### Fire now reports whether it ran, was deferred, failed, was skipped, or lost a race

The owner's fire now answers fired when the occurrence ran and was
delivered; dispatch deferred or dispatch failed when it ran but its delivery
was postponed or failed; skipped, with its reason, when an active pause held
it or the row is not one the worker can fire, such as a settled row; and
raced when the row changed since the owner read it. Every answer but raced
carries the task as it now is. Only a fired answer means the occurrence was
delivered.

```quint
type FireDelivery = FireDelivered | FireDeferred | FireFailed
type FireReply = FireRan | FireDispatchDeferred | FireDispatchFailed | FireSkipped | FireRaced
pure def fireReply(t: ScheduledTask, seenRevision: int, delivery: FireDelivery): FireReply =
  if (seenRevision != t.revision) FireRaced
  else if (not(canFire(t, seenRevision, true)) or heldByPause(t)) FireSkipped
  else if (delivery == FireDeferred) FireDispatchDeferred
  else if (delivery == FireFailed) FireDispatchFailed
  else FireRan
pure def fireReplyCarriesTask(reply: FireReply): bool = reply != FireRaced
pure val deliveryValues = Set(FireDelivered, FireDeferred, FireFailed)
pure val taskValues = Set(initial, { ...initial, paused: true, pauseEnd: 10 }, { ...initial, status: TaskFired, revision: 1, dispatched: List(1) }, { ...initial, revision: 2, deferredTo: 30 })
pure def lawFireRanDispatchesTheOccurrence(task: ScheduledTask, seenRevision: int, delivery: FireDelivery): bool =
  fireReply(task, seenRevision, delivery) == FireRan implies (delivery == FireDelivered and fire(task, seenRevision, true).dispatched == task.dispatched.append(task.occurrence))
pure def lawRacedFireChangesNothing(task: ScheduledTask, seenRevision: int, delivery: FireDelivery): bool =
  fireReply(task, seenRevision, delivery) == FireRaced implies not(canFire(task, seenRevision, true))
pure def lawOnlyARaceOmitsTheTask(task: ScheduledTask, seenRevision: int, delivery: FireDelivery): bool =
  fireReplyCarriesTask(fireReply(task, seenRevision, delivery)) == (seenRevision == task.revision)
pure def lawUndeliveredFireIsNotRan(task: ScheduledTask, seenRevision: int, delivery: FireDelivery): bool =
  delivery != FireDelivered implies fireReply(task, seenRevision, delivery) != FireRan
```

### The owner's list shows only rows marked for the owner

The list may be asked for owner-visible rows only, by giving that filter at
most once and only as one. A repeated or other value is refused. With the
filter, a row that is not marked owner-visible is never listed; without it,
every row of the tenant is.

```quint
pure def ownerFilterAccepted(given: int, isOne: bool): bool = given == 0 or (given == 1 and isOne)
pure def listsRow(ownerVisibleOnly: bool, rowOwnerVisible: bool): bool = not(ownerVisibleOnly) or rowOwnerVisible
pure val givenValues = Set(0, 1, 2)
pure def lawOwnerListHidesUnmarkedRows(rowOwnerVisible: bool): bool = not(rowOwnerVisible) implies not(listsRow(true, rowOwnerVisible))
pure def lawRepeatedFilterIsRefused(given: int, isOne: bool): bool = given > 1 implies not(ownerFilterAccepted(given, isOne))
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
