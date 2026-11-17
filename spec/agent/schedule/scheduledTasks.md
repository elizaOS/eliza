# Scheduled tasks

A scheduled task is one recurring item the agent fires for the owner: a
reminder, a check-in, a follow-up. The agent's `@elizaos/agent/scheduled-tasks`
module keeps each task as one row and serves `GET /api/scheduled-tasks`,
`GET /api/scheduled-tasks/:id` and `POST /api/scheduled-tasks/:id/{verb}` for
the verbs `snooze`, `skip`, `complete`, `dismiss`, `escalate`, `acknowledge`,
`edit`, `reopen` and `fire`. This spec follows one row. The scheduler tick that
fires due rows is a core exclusive scheduled task: core scheduling
(`spec/core/scheduling.md`) and its task service (`spec/core/taskServiceOwners.md`)
own that ticks never overlap and that unloading waits for every write in
flight, the tick's own row included. The agent seeds no default task and has
no global pause.

Occurrences are numbered from 1. `pending` is the occurrence the row waits for,
and `due` is the instant it comes due. Instants are milliseconds. The next
instant of the row's trigger is a boundary fact the shell computes and passes
in as `following`; a one-time trigger has no next occurrence.

## Story: Keep a recurring task exact through retries, races and restarts

> As the owner, I want each occurrence of my task delivered at most once, a
> repeated request applied once, and a skipped or missed occurrence never
> fired, so that retries, two devices and a restart never double or lose a
> reminder.

### Every change commits against the revision it read

A verb or a fire reads the row and commits only if the row is still at that
revision, and every commit moves the revision by one, so of two callers that
read the same row only the first commits. The row, its receipt and its log
entry are one write, so a restart never sees half of one.

```quint
import schedule.* from "../../workflow/schedule"
type TaskStatus = Scheduled | Fired | Acknowledged | Completed | Skipped | Failed | Dismissed
type Due = DueAt({ at: int }) | NoMoreOccurrences
type ScheduledTask = { status: TaskStatus, revision: int, pending: int, due: Due, lastFired: int, lastSettled: int, missed: int, retries: int, followups: int, reopenFrom: int, reopens: int, receipts: Set[str], applied: int }
pure val initial: ScheduledTask = { status: Scheduled, revision: 0, pending: 1, due: DueAt({ at: 1 }), lastFired: 0, lastSettled: 0, missed: 0, retries: 0, followups: 0, reopenFrom: 0, reopens: 0, receipts: Set(), applied: 0 }
pure def hasNext(d: Due): bool = match d { | DueAt(x) => true | NoMoreOccurrences => false }
pure def dueInstant(d: Due): int = match d { | DueAt(x) => x.at | NoMoreOccurrences => 0 }
pure def comesAfter(d: Due, instant: int): bool = match d { | DueAt(x) => x.at > instant | NoMoreOccurrences => true }
pure def isOpen(status: TaskStatus): bool = status == Scheduled or status == Fired or status == Acknowledged
pure def isSettled(status: TaskStatus): bool = status == Completed or status == Skipped or status == Failed
pure val seenRevisionValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val nowValues = Set(1, 3, 6, 90000000)
pure val followingValues = Set(NoMoreOccurrences, DueAt({ at: 4 }), DueAt({ at: 8 }), DueAt({ at: 60000000 }), DueAt({ at: 100000000 }))
pure def stepEveryChangeMovesTheRevision(before: ScheduledTask, after: ScheduledTask): bool = after.revision == before.revision + 1
```

### An occurrence is delivered at most once

The scheduler fires the waiting occurrence once it is due. The owner's fire
fires a scheduled row at once, but a row that was fired, acknowledged or
settled only when its next occurrence is due, so a retried fire never
delivers twice. A fire never applies to a dismissed row or to a row with no
next occurrence. A delivered fire moves the row to the next occurrence, the
first one after now; nothing else delivers, and occurrences only move forward.

```quint
type Delivery = Delivered | RetryAt({ retryAt: int }) | Undeliverable
type FireOutcome = FireDelivered | FireDeferred | FireFailed | FireSkipped | FireRaced
pure val maxDispatchRetries = 3
pure val deliveryValues = Set(Delivered, RetryAt({ retryAt: 7 }), RetryAt({ retryAt: 95000000 }), Undeliverable)
pure val processStartValues = Set(0, 50000000)
pure def missedWhileStopped(t: ScheduledTask, manual: bool, now: int, processStart: int, following: Due): bool =
  not(manual) and hasNext(following) and dueInstant(t.due) < processStart and missedOccurrence(dueInstant(t.due), now)
pure def claimOutcome(t: ScheduledTask, manual: bool, now: int, processStart: int, following: Due, delivery: Delivery): FireOutcome =
  if (missedWhileStopped(t, manual, now, processStart, following)) FireSkipped
  else match delivery { | Delivered => FireDelivered | RetryAt(r) => if (t.retries < maxDispatchRetries) FireDeferred else FireFailed | Undeliverable => FireFailed }
pure def retryInstant(delivery: Delivery): int = match delivery { | RetryAt(r) => r.retryAt | _ => 0 }
pure def fireable(t: ScheduledTask, manual: bool, now: int): bool =
  t.status != Dismissed and hasNext(t.due) and (now >= dueInstant(t.due) or (manual and t.status == Scheduled))
pure def canFire(t: ScheduledTask, seenRevision: int, manual: bool, now: int, processStart: int, following: Due, delivery: Delivery): bool = {
  val result = claimOutcome(t, manual, now, processStart, following, delivery)
  val dueAt = dueInstant(t.due)
  seenRevision == t.revision and fireable(t, manual, now)
    and comesAfter(following, if (result == FireSkipped) processStart - 1 else if (now > dueAt) now else dueAt)
    and (result != FireDeferred or retryInstant(delivery) > now)
}
pure def fire(t: ScheduledTask, seenRevision: int, manual: bool, now: int, processStart: int, following: Due, delivery: Delivery): ScheduledTask = {
  val result = claimOutcome(t, manual, now, processStart, following, delivery)
  val advanced = { ...t, revision: t.revision + 1, pending: t.pending + 1, due: following, retries: 0 }
  if (result == FireDelivered) { ...advanced, status: Fired, lastFired: t.pending, followups: 0, reopenFrom: now }
  else if (result == FireDeferred) { ...t, revision: t.revision + 1, status: Scheduled, due: DueAt({ at: retryInstant(delivery) }), retries: t.retries + 1 }
  else if (result == FireSkipped) { ...advanced, status: Skipped, lastSettled: t.pending, missed: t.missed + 1 }
  else { ...advanced, status: Failed }
}
pure def alwaysOccurrencesTrailThePending(t: ScheduledTask): bool = t.pending >= 1 and t.lastFired >= 0 and t.lastFired < t.pending and t.lastSettled >= 0 and t.lastSettled < t.pending
pure def stepOccurrencesOnlyMoveForward(before: ScheduledTask, after: ScheduledTask): bool = after.pending >= before.pending and after.lastFired >= before.lastFired and after.lastSettled >= before.lastSettled
pure def stepOnlyAFireDeliversTheWaitingOccurrence(before: ScheduledTask, via: str, after: ScheduledTask): bool = after.lastFired != before.lastFired implies (via == "fire" and after.lastFired == before.pending and after.pending == before.pending + 1)
pure def stepAFiredRowWasDelivered(before: ScheduledTask, via: str, after: ScheduledTask): bool = via == "fire" implies (after.status == Fired iff after.lastFired != before.lastFired)
pure def sometimesSecondOccurrenceDelivered(t: ScheduledTask): bool = t.lastFired >= 2
```

### A delivery that cannot happen now is retried at most three times, then the occurrence fails

A deferred delivery keeps the occurrence waiting and parks the row until the
retry instant, which is later than now. After three retries, or when delivery
cannot happen at all, the occurrence is used up and the row is failed.

```quint
pure def alwaysOnlyAWaitingRowRetries(t: ScheduledTask): bool = t.retries >= 0 and t.retries <= maxDispatchRetries and (t.retries > 0 implies t.status == Scheduled)
pure def sometimesDeliveryRetried(t: ScheduledTask): bool = t.retries >= 2
pure def sometimesDeliveryFailed(t: ScheduledTask): bool = t.status == Failed and t.lastFired == 0
```

### An occurrence that came due before the agent started is recorded once as missed and never runs

When the scheduler finds a recurring row's waiting occurrence due before the
process started and late by more than the workflow miss window, it records
that occurrence as missed, skips the row and moves it to the first occurrence
at or after the start. The owner's fire still runs a missed occurrence.

```quint
pure def stepAMissedOccurrenceIsRecordedOnceAndNotDelivered(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  after.missed != before.missed implies (via == "fire" and after.missed == before.missed + 1 and after.lastSettled == before.pending and after.lastFired == before.lastFired)
pure def sometimesDeliveredAfterAMiss(t: ScheduledTask): bool = t.missed >= 1 and t.lastFired > t.lastSettled
```

### Settling the waiting occurrence means it never fires

Skip or complete on a scheduled row settles the occurrence it waits for and
moves the row to the occurrence after it, as a missed occurrence does. Every
later delivery is of a later occurrence, so the settled one never fires.

```quint
pure def settlesWaiting(t: ScheduledTask): bool = t.status == Scheduled and hasNext(t.due)
pure def settleOccurrence(result: TaskStatus, t: ScheduledTask, now: int, following: Due): ScheduledTask = {
  val closed = { ...t, status: result, retries: 0, reopenFrom: if (t.reopenFrom == 0) now else t.reopenFrom }
  if (settlesWaiting(t)) { ...closed, lastSettled: t.pending, pending: t.pending + 1, due: following } else closed
}
pure def stepSettlingRetiresTheWaitingOccurrence(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  after.lastSettled != before.lastSettled implies (((via == "applyVerb" and before.status == Scheduled) or via == "fire") and after.lastSettled == before.pending and after.pending == before.pending + 1)
pure def sometimesSettledOccurrencePassedOver(t: ScheduledTask): bool = t.lastSettled >= 1 and t.missed == 0 and t.lastFired > t.lastSettled
```

### A verb applies once per key

Every verb carries an idempotency key, used once per row. A key already in
the row's receipts is a replay: it changes nothing and answers with the
committed row. Each applied verb writes exactly one receipt.

```quint
pure val keyValues = Set("k1", "k2", "k3", "k4", "k5", "k6")
pure def alwaysOneReceiptPerAppliedVerb(t: ScheduledTask): bool = t.receipts.size() == t.applied
```

### Dismissal is final

A dismissed row never fires and no verb changes it again, reopen included.

```quint
pure def stepDismissalIsFinal(before: ScheduledTask, after: ScheduledTask): bool = before.status == Dismissed implies after.status == Dismissed
pure def sometimesDismissedAfterDelivery(t: ScheduledTask): bool = t.status == Dismissed and t.lastFired >= 1
```

## Story: Answer a scheduled task from my list

> As the owner, I want to see my scheduled tasks and snooze, skip, complete,
> dismiss, escalate, acknowledge, edit, reopen or fire one, so that each
> answer does what I chose and the reply tells me what happened.

### Each verb does only what it names, and only to a row it applies to

Snooze applies to an open row, until a later instant or for a positive number
of minutes; minutes count from the waiting instant when a scheduled row waits
for a later one, else from now. The row then waits again, with a fresh
follow-up ladder, and fires at that instant. Skip and complete settle an open
row. Escalate moves a fired row one step up its follow-up ladder; acknowledge
marks a fired row seen without settling it. Edit changes the instructions or
the trigger of a row that is not dismissed, and `following` is then the
waiting instant under that trigger. Reopen brings a completed, skipped or
failed row back to the schedule within 24 hours of its last follow-up, else
its last delivery, else its settling. Dismiss applies to any row not yet
dismissed.

```quint
type Verb = SnoozeUntil({ until: int }) | SnoozeFor({ minutes: int }) | Skip | Complete | Dismiss | Escalate | Acknowledge | Edit | Reopen
pure val reopenWindowMs = 86400000
pure val minuteMs = 60000
pure val verbValues = Set(SnoozeUntil({ until: 5 }), SnoozeUntil({ until: 99000000 }), SnoozeFor({ minutes: 60 }), Skip, Complete, Dismiss, Escalate, Acknowledge, Edit, Reopen)
pure def snoozeBase(now: int, t: ScheduledTask): int = if (settlesWaiting(t) and dueInstant(t.due) > now) dueInstant(t.due) else now
pure def verbApplies(t: ScheduledTask, verb: Verb, now: int, following: Due): bool = match verb {
  | SnoozeUntil(s) => isOpen(t.status) and s.until > now
  | SnoozeFor(s) => isOpen(t.status) and s.minutes > 0
  | Skip => isOpen(t.status) and (not(settlesWaiting(t)) or comesAfter(following, dueInstant(t.due)))
  | Complete => isOpen(t.status) and (not(settlesWaiting(t)) or comesAfter(following, dueInstant(t.due)))
  | Dismiss => t.status != Dismissed
  | Escalate => t.status == Fired
  | Acknowledge => t.status == Fired
  | Edit => t.status != Dismissed
  | Reopen => isSettled(t.status) and now <= t.reopenFrom + reopenWindowMs
}
pure def canApplyVerb(t: ScheduledTask, seenRevision: int, key: str, verb: Verb, now: int, following: Due): bool = seenRevision == t.revision and key != "" and not(t.receipts.contains(key)) and verbApplies(t, verb, now, following)
pure def applyVerb(t: ScheduledTask, seenRevision: int, key: str, verb: Verb, now: int, following: Due): ScheduledTask = {
  val done = { ...t, revision: t.revision + 1, receipts: t.receipts.union(Set(key)), applied: t.applied + 1 }
  match verb {
    | SnoozeUntil(s) => { ...done, status: Scheduled, due: DueAt({ at: s.until }), retries: 0, followups: 0 }
    | SnoozeFor(s) => { ...done, status: Scheduled, due: DueAt({ at: snoozeBase(now, t) + s.minutes * minuteMs }), retries: 0, followups: 0 }
    | Skip => settleOccurrence(Skipped, done, now, following)
    | Complete => settleOccurrence(Completed, done, now, following)
    | Dismiss => { ...done, status: Dismissed, retries: 0 }
    | Escalate => { ...done, followups: t.followups + 1, reopenFrom: now }
    | Acknowledge => { ...done, status: Acknowledged }
    | Edit => { ...done, due: following }
    | Reopen => { ...done, status: Scheduled, followups: 0, reopens: t.reopens + 1 }
  }
}
pure def sometimesEscalatedThenAcknowledged(t: ScheduledTask): bool = t.status == Acknowledged and t.followups >= 1
pure def sometimesSettledRowBackOnSchedule(t: ScheduledTask): bool = t.status == Scheduled and t.reopens >= 1
```

### A verb's reply says whether it was applied, refused, or reached no task

A malformed body is refused before the row is read: an unknown verb, a missing
key, a snooze with neither a positive number of minutes nor a future time, an
edit with no field (400). A missing row is `notFound` (404). A replayed key is
`applied` with the committed row. A stale revision, a verb that does not apply
to the row and an edit of a server-managed field (`taskId`, `state`) are
refused (409) and change nothing. Only `applied` carries the row.

```quint
type RefusalReason = Malformed | Stale | NotApplicable
type VerbReply = Applied | Refused({ reason: RefusalReason }) | NotFound
pure def verbReply(wellFormed: bool, found: bool, replay: bool, fresh: bool, applies: bool): VerbReply =
  if (not(wellFormed)) Refused({ reason: Malformed }) else if (not(found)) NotFound else if (replay) Applied else if (not(fresh)) Refused({ reason: Stale }) else if (not(applies)) Refused({ reason: NotApplicable }) else Applied
pure def lawOnlyAFreshApplicableVerbOrAReplayIsApplied(wellFormed: bool, found: bool, replay: bool, fresh: bool, applies: bool): bool =
  verbReply(wellFormed, found, replay, fresh, applies) == Applied iff (wellFormed and found and (replay or (fresh and applies)))
```

### Fire now reports fired, skipped, deferred, failed or raced

The owner's fire answers `raced`, with no row, when the row moved since it
was read or its occurrence is not yet due because another fire took it.
It answers `skipped` for a dismissed row and a row with no next occurrence,
else the result of its delivery: `fired`, `dispatch_deferred` with the retry
instant, or `dispatch_failed`. Only `fired` means the occurrence was delivered.

```quint
pure val claimedValues = Set(FireDelivered, FireDeferred, FireFailed, FireSkipped)
pure def fireReply(fresh: bool, ended: bool, dueNow: bool, claimed: FireOutcome): FireOutcome =
  if (not(fresh)) FireRaced else if (ended) FireSkipped else if (not(dueNow)) FireRaced else claimed
pure def lawOnlyAFreshDueDeliveryIsFired(fresh: bool, ended: bool, dueNow: bool, claimed: FireOutcome): bool =
  fireReply(fresh, ended, dueNow, claimed) == FireDelivered iff (fresh and not(ended) and dueNow and claimed == FireDelivered)
```

### With ownerVisibleOnly=1 the list shows every owner-visible row and no other

The filter is given at most once and only as `1`, else the list is refused
(400). Without it, every row is listed.

```quint
type ListedTask = { taskId: str, ownerVisible: bool }
pure def ownerList(rows: List[ListedTask], ownerVisibleOnly: bool): List[ListedTask] = if (ownerVisibleOnly) rows.select(r => r.ownerVisible) else rows
pure val rowsValues = Set(List(), List({ taskId: "a", ownerVisible: true }), List({ taskId: "a", ownerVisible: false }, { taskId: "b", ownerVisible: true }), List({ taskId: "a", ownerVisible: true }, { taskId: "b", ownerVisible: false }, { taskId: "c", ownerVisible: true }))
pure def lawOwnerListShowsOnlyOwnerVisibleRows(rows: List[ListedTask]): bool = ownerList(rows, true).every(r => r.ownerVisible)
pure def lawOwnerListKeepsEveryOwnerVisibleRow(rows: List[ListedTask]): bool = rows.every(r => not(r.ownerVisible) or ownerList(rows, true).includes(r))
```
