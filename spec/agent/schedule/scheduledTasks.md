# Scheduled tasks

A scheduled task is one item the agent fires for the owner: a reminder, a
check-in, a follow-up. The agent's `@elizaos/agent/scheduled-tasks` module
keeps each task as one row. A plugin on the device creates a row with its
trigger, its owner visibility and an optional idempotency key; a repeated key
returns the row already made. The module serves `GET /api/scheduled-tasks`
(`?ownerVisibleOnly=1` lists only owner-visible rows; the route gate in
`spec/agent/access/routes.md` refuses any other value), the verbs
`POST /api/scheduled-tasks/:id/{verb}` for `snooze`, `skip`, `complete`,
`dismiss`, `escalate`, `acknowledge`, `edit` and `reopen`, each with an
optional idempotency key, and `POST /api/scheduled-tasks/:id/fire`, which has
no key: a repeated fire is refused by the revision and the due check. A plugin
calls the same verbs and fire through the module with the revision it read,
so its write is conditional on the row it saw. The scheduler tick is a core
exclusive scheduled task: core scheduling (`spec/core/scheduling.md`) and its
task service (`spec/core/taskServiceOwners.md`) own that ticks never overlap
and that unloading waits for every write in flight. The agent seeds no default
task and has no global pause. The shell writes a row, its receipt and its log
entry in one write.

On the wire a row is `{taskId, kind, ownerVisible, promptInstructions,
trigger{kind, expression?, tz?, atIso?}, metadata, state{status, firedAt,
lastDecisionLog}}`; after a snooze `state.firedAt` is the snooze instant and
`lastDecisionLog` is `snoozed until <iso> (ladder reset)`. A verb answers
`{task}`, a fire `{fire: {kind, task, reason?, nextAttemptAtIso?, error?}}`,
the list `{tasks}`, and an unknown id `notFound` (404) for verbs and fire.

This spec follows one row. Occurrences are numbered from 1. `pending` is the
occurrence the row waits for, and `due` is the instant it comes due, or
`Manual` for a row only the owner fires. Instants are milliseconds. The next
due of the row's trigger is a boundary fact the shell computes and passes in
as `following`; a one-time trigger has no next occurrence. `processStart` is
the instant this process started, the same for every event of one process.
`initial` is a row created at instant 1 waiting for its first occurrence; the
shell loads real rows through `parseState`.

## Story: Keep a recurring task exact through retries, races and restarts

> As the owner, I want each occurrence of my task delivered at most once, a
> repeated request applied once, and a skipped occurrence, or one of a
> recurring task missed while the agent was stopped, never fired, so that
> retries, two devices and a restart never double or lose a reminder.

### Every change commits against the revision it read

A verb or a fire reads the row and commits only if the row is still at that
revision, and every commit moves the revision by one, so of two callers that
read the same row only the first commits.

```quint
import schedule.* from "../../workflow/schedule"
type TaskStatus = Scheduled | Fired | Acknowledged | Completed | Skipped | Failed | Dismissed
type Due = DueAt({ at: int }) | Manual | NoMoreOccurrences
type ReopenRef = NoReference | Since({ at: int })
type Verb = SnoozeUntil({ until: int }) | SnoozeFor({ minutes: int }) | Skip | Complete | Dismiss | Escalate | Acknowledge | EditInstructions({ body: str }) | EditTrigger({ body: str }) | Reopen
type Receipt = { key: str, verb: Verb }
type ScheduledTask = { status: TaskStatus, revision: int, pending: int, due: Due, lastFired: int, lastSettled: int, missed: int, retries: int, followups: int, reopenFrom: ReopenRef, reopens: int, receipts: List[Receipt], keyedApplied: int }
pure val initial: ScheduledTask = { status: Scheduled, revision: 0, pending: 1, due: DueAt({ at: 1 }), lastFired: 0, lastSettled: 0, missed: 0, retries: 0, followups: 0, reopenFrom: NoReference, reopens: 0, receipts: List(), keyedApplied: 0 }
pure def hasNext(d: Due): bool = match d { | DueAt(x) => true | _ => false }
pure def dueInstant(d: Due): int = match d { | DueAt(x) => x.at | _ => 0 }
pure def comesAfter(d: Due, instant: int): bool = match d { | DueAt(x) => x.at > instant | _ => true }
pure def isOpen(status: TaskStatus): bool = status == Scheduled or status == Fired or status == Acknowledged
pure def isSettled(status: TaskStatus): bool = status == Completed or status == Skipped or status == Failed
pure def settledRef(r: ReopenRef, now: int): ReopenRef = match r { | Since(x) => Since({ at: x.at }) | NoReference => Since({ at: now }) }
pure val seenRevisionValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val nowValues = Set(1, 3, 6, 90000000)
pure val followingValues = Set(NoMoreOccurrences, Manual, DueAt({ at: 4 }), DueAt({ at: 8 }), DueAt({ at: 60000000 }), DueAt({ at: 100000000 }))
pure def stepEveryChangeMovesTheRevision(before: ScheduledTask, after: ScheduledTask): bool = after.revision == before.revision + 1
```

### An occurrence is delivered at most once

The scheduler fires the waiting occurrence once it is due. The owner's fire
fires a scheduled row at once, a manual row included, but a row that was
fired, acknowledged or settled only when its next occurrence is due, so a
retried fire never delivers twice. A fire never applies to a dismissed row or
to a row with no next occurrence. A delivered fire moves the row to the first
occurrence after both now and the delivered occurrence's instant; nothing else
delivers, and occurrences only move forward.

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
  t.status != Dismissed and (match t.due { | DueAt(x) => now >= x.at or (manual and t.status == Scheduled) | Manual => manual and t.status == Scheduled | NoMoreOccurrences => false })
pure def canFire(t: ScheduledTask, seenRevision: int, manual: bool, now: int, processStart: int, following: Due, delivery: Delivery): bool = {
  val result = claimOutcome(t, manual, now, processStart, following, delivery)
  val dueAt = dueInstant(t.due)
  seenRevision == t.revision and fireable(t, manual, now)
    and (if (result == FireDeferred) retryInstant(delivery) > now
         else comesAfter(following, if (result == FireSkipped) processStart - 1 else if (now > dueAt) now else dueAt))
}
pure def fire(t: ScheduledTask, seenRevision: int, manual: bool, now: int, processStart: int, following: Due, delivery: Delivery): ScheduledTask = {
  val result = claimOutcome(t, manual, now, processStart, following, delivery)
  val advanced = { ...t, revision: t.revision + 1, pending: t.pending + 1, due: following, retries: 0 }
  if (result == FireDelivered) { ...advanced, status: Fired, lastFired: t.pending, followups: 0, reopenFrom: Since({ at: now }) }
  else if (result == FireDeferred) { ...t, revision: t.revision + 1, status: Scheduled, due: DueAt({ at: retryInstant(delivery) }), retries: t.retries + 1 }
  else if (result == FireSkipped) { ...advanced, status: Skipped, lastSettled: t.pending, missed: t.missed + 1, reopenFrom: settledRef(t.reopenFrom, now) }
  else { ...advanced, status: Failed, reopenFrom: settledRef(t.reopenFrom, now) }
}
pure def alwaysOccurrencesTrailThePending(t: ScheduledTask): bool = t.pending >= 1 and t.lastFired >= 0 and t.lastFired < t.pending and t.lastSettled >= 0 and t.lastSettled < t.pending
pure def stepOccurrencesOnlyMoveForward(before: ScheduledTask, after: ScheduledTask): bool = after.pending >= before.pending and after.lastFired >= before.lastFired and after.lastSettled >= before.lastSettled
pure def stepOnlyAFireDeliversTheWaitingOccurrence(before: ScheduledTask, via: str, after: ScheduledTask): bool = after.lastFired != before.lastFired implies (via == "fire" and after.lastFired == before.pending and after.pending == before.pending + 1)
pure def stepAFiredRowWasDelivered(before: ScheduledTask, via: str, after: ScheduledTask): bool = via == "fire" implies (after.status == Fired iff after.lastFired != before.lastFired)
pure def sometimesSecondOccurrenceDelivered(t: ScheduledTask): bool = t.lastFired >= 2
pure def sometimesManualRowRunByOwner(t: ScheduledTask): bool = t.due == Manual and t.status == Fired
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

### An occurrence of a recurring task that came due before the agent started is recorded once as missed and never runs

When the scheduler finds a recurring row's waiting occurrence due before the
process started and late by more than the workflow miss window, it records
that occurrence as missed, skips the row and moves it to the first occurrence
at or after the start. A one-time task and the owner's fire still run it.

```quint
pure def stepAMissedOccurrenceIsRecordedOnceAndNotDelivered(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  after.missed != before.missed implies (via == "fire" and after.missed == before.missed + 1 and after.lastSettled == before.pending and after.lastFired == before.lastFired)
pure def sometimesDeliveredAfterAMiss(t: ScheduledTask): bool = t.missed >= 1 and t.lastFired > t.lastSettled
```

### Settling the waiting occurrence means it never fires

Skip or complete on a scheduled row with a next occurrence settles the
occurrence it waits for and moves the row to the occurrence after it, as a
missed occurrence does. Every later delivery is of a later occurrence, so the
settled one never fires.

```quint
pure def settlesWaiting(t: ScheduledTask): bool = t.status == Scheduled and hasNext(t.due)
pure def settleOccurrence(result: TaskStatus, t: ScheduledTask, now: int, following: Due): ScheduledTask = {
  val closed = { ...t, status: result, retries: 0, reopenFrom: settledRef(t.reopenFrom, now) }
  if (settlesWaiting(t)) { ...closed, lastSettled: t.pending, pending: t.pending + 1, due: following } else closed
}
pure def stepSettlingRetiresTheWaitingOccurrence(before: ScheduledTask, via: str, after: ScheduledTask): bool =
  after.lastSettled != before.lastSettled implies (((via == "applyVerb" and before.status == Scheduled) or via == "fire") and after.lastSettled == before.pending and after.pending == before.pending + 1)
pure def sometimesSettledOccurrencePassedOver(t: ScheduledTask): bool = t.lastSettled >= 1 and t.missed == 0 and t.lastFired > t.lastSettled
```

### A keyed verb applies once per key

A verb may carry an idempotency key. The row keeps one receipt for each keyed
verb it applied: the key with the verb and its body. The same key with the
same verb and body is a replay: it changes nothing and answers with the
committed row. The same key with another verb or body is refused (409). A verb
without a key applies once against the revision read, with no replay.

```quint
type RequestKey = Unkeyed | Keyed({ key: str })
pure val keyValues = Set(Unkeyed, Keyed({ key: "k1" }), Keyed({ key: "k2" }), Keyed({ key: "k3" }))
pure def isReplay(t: ScheduledTask, key: RequestKey, verb: Verb): bool = match key { | Keyed(k) => t.receipts.includes({ key: k.key, verb: verb }) | Unkeyed => false }
pure def keyUsed(t: ScheduledTask, key: RequestKey): bool = match key { | Keyed(k) => t.receipts.some(r => r.key == k.key) | Unkeyed => false }
pure def receiptsAfter(receipts: List[Receipt], key: RequestKey, verb: Verb): List[Receipt] = match key { | Keyed(k) => receipts.append({ key: k.key, verb: verb }) | Unkeyed => receipts }
pure def alwaysOneReceiptPerAppliedVerb(t: ScheduledTask): bool = t.receipts.length() == t.keyedApplied
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
marks a fired row seen without settling it. Edit changes a row that is not
dismissed: an instructions-only edit keeps the waiting instant, a snooze and a
pending retry; a trigger edit waits for `following`, the next due under the
new trigger, with no retry. Reopen brings a completed, skipped or failed row
back to the schedule within 24 hours of its last follow-up or delivery since
it was last reopened, else of its settling. Dismiss applies to any row not yet
dismissed.

```quint
pure val reopenWindowMs = 86400000
pure val minuteMs = 60000
pure val verbValues = Set(SnoozeUntil({ until: 5 }), SnoozeUntil({ until: 99000000 }), SnoozeFor({ minutes: 60 }), SnoozeFor({ minutes: 0 }), Skip, Complete, Dismiss, Escalate, Acknowledge, EditInstructions({ body: "a" }), EditTrigger({ body: "b" }), Reopen)
pure def wellFormedVerb(verb: Verb): bool = match verb { | SnoozeFor(s) => s.minutes > 0 | _ => true }
pure def snoozeBase(now: int, t: ScheduledTask): int = if (settlesWaiting(t) and dueInstant(t.due) > now) dueInstant(t.due) else now
pure def verbApplies(t: ScheduledTask, verb: Verb, now: int, following: Due): bool = match verb {
  | SnoozeUntil(s) => isOpen(t.status) and s.until > now
  | SnoozeFor(s) => isOpen(t.status)
  | Skip => isOpen(t.status) and (not(settlesWaiting(t)) or comesAfter(following, dueInstant(t.due)))
  | Complete => isOpen(t.status) and (not(settlesWaiting(t)) or comesAfter(following, dueInstant(t.due)))
  | Dismiss => t.status != Dismissed
  | Escalate => t.status == Fired
  | Acknowledge => t.status == Fired
  | EditInstructions(e) => t.status != Dismissed
  | EditTrigger(e) => t.status != Dismissed
  | Reopen => isSettled(t.status) and (match t.reopenFrom { | Since(r) => now <= r.at + reopenWindowMs | NoReference => true })
}
pure def canApplyVerb(t: ScheduledTask, seenRevision: int, key: RequestKey, verb: Verb, now: int, following: Due): bool =
  wellFormedVerb(verb) and seenRevision == t.revision and not(keyUsed(t, key)) and verbApplies(t, verb, now, following)
pure def applyVerb(t: ScheduledTask, seenRevision: int, key: RequestKey, verb: Verb, now: int, following: Due): ScheduledTask = {
  val done = { ...t, revision: t.revision + 1, receipts: receiptsAfter(t.receipts, key, verb), keyedApplied: t.keyedApplied + (if (key == Unkeyed) 0 else 1) }
  match verb {
    | SnoozeUntil(s) => { ...done, status: Scheduled, due: DueAt({ at: s.until }), retries: 0, followups: 0 }
    | SnoozeFor(s) => { ...done, status: Scheduled, due: DueAt({ at: snoozeBase(now, t) + s.minutes * minuteMs }), retries: 0, followups: 0 }
    | Skip => settleOccurrence(Skipped, done, now, following)
    | Complete => settleOccurrence(Completed, done, now, following)
    | Dismiss => { ...done, status: Dismissed, retries: 0 }
    | Escalate => { ...done, followups: t.followups + 1, reopenFrom: Since({ at: now }) }
    | Acknowledge => { ...done, status: Acknowledged }
    | EditInstructions(e) => done
    | EditTrigger(e) => { ...done, due: following, retries: 0 }
    | Reopen => { ...done, status: Scheduled, followups: 0, reopens: t.reopens + 1, reopenFrom: NoReference }
  }
}
pure def sometimesEscalatedThenAcknowledged(t: ScheduledTask): bool = t.status == Acknowledged and t.followups >= 1
pure def sometimesSettledRowBackOnSchedule(t: ScheduledTask): bool = t.status == Scheduled and t.reopens >= 1
pure def sometimesFailedRowReopened(t: ScheduledTask): bool = t.status == Scheduled and t.reopens >= 1 and t.lastFired == 0 and t.lastSettled == 0
pure def sometimesCompletedAfterDelivery(t: ScheduledTask): bool = t.status == Completed and t.lastFired >= 1
pure def sometimesSnoozedAfterDelivery(t: ScheduledTask): bool = t.status == Scheduled and t.lastFired >= 1 and dueInstant(t.due) == 99000000
```

### A verb's reply says whether it was applied, refused, or reached no task

A body that is not one of these verbs is malformed (400): a snooze with
neither a positive number of minutes nor a time, or an edit naming no field or
a server-managed one (`taskId`, `state`). A replay is `applied` with the
committed row. A key reused for another request, a stale revision, and a verb
that does not apply to the row, a snooze time not after now included, are
refused (409) and change nothing. Only `applied` carries the row.

```quint
type RefusalReason = Malformed | KeyReused | Stale | NotApplicable
type VerbReply = Applied | Refused({ reason: RefusalReason }) | NotFound
pure def verbReply(t: ScheduledTask, seenRevision: int, key: RequestKey, verb: Verb, now: int, following: Due): VerbReply =
  if (not(wellFormedVerb(verb))) Refused({ reason: Malformed })
  else if (isReplay(t, key, verb)) Applied
  else if (keyUsed(t, key)) Refused({ reason: KeyReused })
  else if (seenRevision != t.revision) Refused({ reason: Stale })
  else if (not(verbApplies(t, verb, now, following))) Refused({ reason: NotApplicable })
  else Applied
pure def lawOnlyAFreshApplicableVerbOrAReplayIsApplied(t: ScheduledTask, seenRevision: int, key: RequestKey, verb: Verb, now: int, following: Due): bool =
  verbReply(t, seenRevision, key, verb, now, following) == Applied iff (canApplyVerb(t, seenRevision, key, verb, now, following) or (wellFormedVerb(verb) and isReplay(t, key, verb)))
pure def lawAReplayChangesNothing(t: ScheduledTask, seenRevision: int, key: RequestKey, verb: Verb, now: int, following: Due): bool =
  isReplay(t, key, verb) implies not(canApplyVerb(t, seenRevision, key, verb, now, following))
```

### Fire now reports fired, skipped, deferred, failed or raced

The owner's fire answers `raced`, with no row, when the row moved since it was
read or its occurrence is not yet due because another fire took it. It answers
`skipped` for a dismissed row, a row with no next occurrence and a manual row
that is not waiting, else the result of its delivery: `fired`,
`dispatch_deferred` with the retry instant, or `dispatch_failed`. Every reply
but `raced` carries the row as it now is. Only `fired` means the occurrence
was delivered.

```quint
pure def ownerFireEnded(t: ScheduledTask): bool =
  t.status == Dismissed or (match t.due { | DueAt(x) => false | Manual => t.status != Scheduled | NoMoreOccurrences => true })
pure def fireReply(t: ScheduledTask, seenRevision: int, now: int, processStart: int, following: Due, delivery: Delivery): FireOutcome =
  if (seenRevision != t.revision) FireRaced
  else if (ownerFireEnded(t)) FireSkipped
  else if (not(canFire(t, seenRevision, true, now, processStart, following, delivery))) FireRaced
  else claimOutcome(t, true, now, processStart, following, delivery)
pure def fireReplyCarriesTheRow(outcome: FireOutcome): bool = outcome != FireRaced
pure def lawOnlyAFreshDueDeliveryIsFired(t: ScheduledTask, seenRevision: int, now: int, processStart: int, following: Due, delivery: Delivery): bool =
  fireReply(t, seenRevision, now, processStart, following, delivery) == FireDelivered implies (canFire(t, seenRevision, true, now, processStart, following, delivery) and fire(t, seenRevision, true, now, processStart, following, delivery).lastFired == t.pending)
```
