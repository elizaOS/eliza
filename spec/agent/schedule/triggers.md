# Prompt triggers

A trigger is one saved prompt the agent sends to a conversation once, on a
cron schedule, or each time a named runtime event happens. The agent's
`@elizaos/agent/triggers` module keeps it and serves `/api/triggers…`
(create, list, read, update, delete, run history, run now). Each scheduled
occurrence runs as a core exclusive scheduled task:
core scheduling (`spec/core/scheduling.md`) and its task service owners
(`spec/core/taskServiceOwners.md`) own exclusivity and stop, and the core [missed occurrence window](../../core/occurrenceWindow.md) is the
window after which a late occurrence is missed. Workflow schedules are not
triggers.

The summary is `{id, displayName, instructions, triggerType: once|cron|event,
timezone, scheduledAtIso?, cronExpression?, eventKind?, enabled, revision}`.
`GET /api/triggers` is `{triggers}`, `GET /api/triggers/:id` is `{trigger}`,
`POST` (201) and `PUT` reply `{trigger, deliveryConversationId?}`, `DELETE`
replies `{ok: true}`. An unknown id is 404; a body the rules below do not
allow (another `kind`, `interval`, a `wakeMode` other than `inject_now`, a
bad zone or cron, a past `once` time, an event the agent does not raise) is
400.

## Story: Run a trigger now or on schedule without losing my edits

> As the owner, I want a saved prompt to run when I press Run now, at its
> time or on its event, never twice for one occurrence or event, and I want
> my edits to stand even while it runs.

### A new trigger is saved disabled, for a conversation that can take it, with a future first instant or an event name

The create body is `{kind: "prompt", displayName, instructions, triggerType,
timezone, scheduledAtIso | cronExpression | eventKind,
deliveryConversationId?, wakeMode: "inject_now", enabled: false}`. `at` is
the first instant: the `once` time, or the next cron instant that core's
`computeNextCronRunAtMs` finds from the 5-field expression and zone. Without
`deliveryConversationId` (`requested == ""`) the room is resolved once, now,
to the owner's active or most recent conversation, created if there is none
(`defaultRoom`); a selected conversation is never replaced. A selected one
that does not exist is 409; a resolved one that cannot take a turn
(`roomExists` false) is 503. An event trigger names one of the events the
agent raises (`triggerEventNames`, below). Only the chosen type's data is kept.

```quint
import occurrenceWindow as WS from "../../core/occurrenceWindow"
type TriggerType = OnceAt | CronSchedule | OnRuntimeEvent
type Lifecycle = Unsaved | Saved | Removed
type RunSource = RunNow | Scheduled | FromEvent
type RunOutcome = Completed | Failed | Cancelled | Denied | RoomUnavailable
type Activity = Idle | Running({ source: RunSource, revision: int, room: str })
type RunRecord = Ran({ source: RunSource, turn: RunOutcome }) | Missed({ scheduledAt: int })
type Trigger = { life: Lifecycle, schedule: TriggerType, enabled: bool, revision: int, room: str, eventKind: str, nextAt: int, activity: Activity, seenEvents: List[str], history: List[RunRecord], now: int, lastFiredAt: int }
pure val initial: Trigger = { life: Unsaved, schedule: OnceAt, enabled: false, revision: 0, room: "", eventKind: "", nextAt: 0, activity: Idle, seenEvents: List(), history: List(), now: 0, lastFiredAt: 0 }
pure val requestedValues = Set("", "room1")
pure val defaultRoomValues = Set("room2")
pure val triggerEventNames = Set("MESSAGE_RECEIVED", "MESSAGE_SENT")
pure val eventKindValues = Set("MESSAGE_RECEIVED", "MESSAGE_SENT", "REACTION_RECEIVED")
pure val atValues = Set(1000, 2000)
pure def validSchedule(schedule: TriggerType, eventKind: str, at: int, now: int): bool = if (schedule == OnRuntimeEvent) triggerEventNames.contains(eventKind) else at > now
pure def chosenRoom(requested: str, fallback: str): str = if (requested == "") fallback else requested
pure def canCreate(t: Trigger, schedule: TriggerType, requested: str, defaultRoom: str, eventKind: str, at: int, roomExists: bool): bool = t.life == Unsaved and roomExists and chosenRoom(requested, defaultRoom) != "" and validSchedule(schedule, eventKind, at, t.now)
pure def create(t: Trigger, schedule: TriggerType, requested: str, defaultRoom: str, eventKind: str, at: int, roomExists: bool): Trigger = { ...t, life: Saved, schedule: schedule, room: chosenRoom(requested, defaultRoom), eventKind: if (schedule == OnRuntimeEvent) eventKind else "", nextAt: if (schedule == OnRuntimeEvent) 0 else at, enabled: false, revision: 1 }
pure def alwaysASavedTriggerHasARoomAndOnlyItsTypesData(t: Trigger): bool = t.life == Unsaved or (t.room != "" and t.revision >= 1 and (if (t.schedule == OnRuntimeEvent) (t.eventKind != "" and t.nextAt == 0) else t.eventKind == ""))
```

### An edit, enable or removal with a stale expected revision is refused

`revision` in the summary counts saved writes. `PUT` and `DELETE` may carry
`expectedRevision`, the revision the client read; a different current one
is 409 `stale_revision`, and an absent field checks nothing. A write is
accepted while a run is in progress: the run keeps the revision and room it
started with, and its end adds only its record, so the owner's fields stand.
An edit without `deliveryConversationId` keeps the room, even one deleted
since, so the owner can still change the prompt; its next run then fails as
`RoomUnavailable`. An edit that names a conversation needs it to take a turn,
as a create does. An enabled timed
trigger needs a future `at`; a disabled one may keep its past time.

```quint
type RevisionCheck = AnyRevision | AtRevision({ revision: int })
pure val expectedValues = Set(AnyRevision, AtRevision({ revision: 1 }), AtRevision({ revision: 2 }))
pure def revisionMatches(expected: RevisionCheck, revision: int): bool = match expected { | AtRevision(e) => e.revision == revision | AnyRevision => true }
pure def canEdit(t: Trigger, schedule: TriggerType, requested: str, eventKind: str, at: int, roomExists: bool, expected: RevisionCheck): bool = t.life == Saved and revisionMatches(expected, t.revision) and (requested == "" or roomExists) and (validSchedule(schedule, eventKind, at, t.now) or (not(t.enabled) and schedule != OnRuntimeEvent))
pure def edit(t: Trigger, schedule: TriggerType, requested: str, eventKind: str, at: int, roomExists: bool, expected: RevisionCheck): Trigger = { ...t, schedule: schedule, room: chosenRoom(requested, t.room), eventKind: if (schedule == OnRuntimeEvent) eventKind else "", nextAt: if (schedule == OnRuntimeEvent) 0 else at, revision: t.revision + 1 }
pure def canRemove(t: Trigger, expected: RevisionCheck): bool = t.life == Saved and revisionMatches(expected, t.revision)
pure def remove(t: Trigger, expected: RevisionCheck): Trigger = { ...t, life: Removed }
pure def sometimesEditedWhileRunning(t: Trigger): bool = {
  val activity = t.activity
  t.life == Saved and match activity { | Running(r) => r.revision < t.revision | Idle => false }
}
pure def sometimesDeleted(t: Trigger): bool = t.life == Removed and t.schedule == CronSchedule
```

### Enabling is refused past 100 active triggers, for a passed one-time trigger, and for an unsupported event

`PUT {enabled}` toggles it. Only `activeOthers` (the owner's other enabled
triggers, read from the store) at 100 gives 429; a passed `once` time gives
400. Enabling a cron trigger takes the next instant `at`. An event kind the
agent no longer raises cannot be enabled and gives 400 `unsupported_event`.
Before the scheduler subscribes to events at startup, it disables each enabled
trigger with such a kind and advances its revision once, retaining its room,
prompt and history for the owner to edit or run manually. A refusal changes
nothing, and so does setting the state it already has.

```quint
pure val maxActiveTriggers: int = 100
pure val activeOthersValues = Set(0, 99, 100)
pure def eventSupported(t: Trigger): bool = t.schedule != OnRuntimeEvent or triggerEventNames.contains(t.eventKind)
pure def canSetEnabled(t: Trigger, on: bool, at: int, activeOthers: int, expected: RevisionCheck): bool = t.life == Saved and revisionMatches(expected, t.revision) and (not(on) or (eventSupported(t) and (t.enabled or (activeOthers < maxActiveTriggers and (if (t.schedule == OnceAt) t.nextAt > t.now else if (t.schedule == CronSchedule) at > t.now else true)))))
pure def setEnabled(t: Trigger, on: bool, at: int, activeOthers: int, expected: RevisionCheck): Trigger = { ...t, enabled: on, nextAt: if (on and not(t.enabled) and t.schedule == CronSchedule) at else t.nextAt, revision: if (on == t.enabled) t.revision else t.revision + 1 }
pure def sometimesEnabledCron(t: Trigger): bool = t.life == Saved and t.enabled and t.schedule == CronSchedule
```

### Run now starts one run of the saved trigger, even a disabled one, after any run in progress

`POST /api/triggers/:id/execute {}` waits for a run in progress, then starts
one run; it carries no key, and transport (`spec/agent/access/transport.md`) never
replays a request. The reply is `{ok: true, result: {status, error?}}` with
the status and error of the run's record.

```quint
pure def canRunNow(t: Trigger): bool = t.life == Saved and t.activity == Idle
pure def runNow(t: Trigger): Trigger = { ...t, activity: Running({ source: RunNow, revision: t.revision, room: t.room }) }
pure def sometimesRanNowWhileDisabled(t: Trigger): bool = not(t.enabled) and t.history.includes(Ran({ source: RunNow, turn: Completed }))
```

### An occurrence fires once, and one missed while the agent was not running is recorded and never run

A due occurrence of an enabled timed trigger fires once; a cron trigger
moves on to `nextInstant`, the next instant after now. The agent calls
core `isMissedScheduledOccurrence` (its window is `WS::missedWindowMs`) with
`processStartedAt`, the agent process's start: an occurrence past the window
that fell due before the process started is recorded as missed and nothing
runs. Misses are always recorded; `ELIZA_MISSED_SCHEDULED_OCCURRENCES` is not
read. A missed `once` trigger stays listed, disabled, so the owner can still
run it now. A stop aborts a run in progress first (core scheduling).

```quint
pure val dtValues = Set(500, 1000, 1800001, 1801001)
pure val nextInstantValues = Set(2000, 1802000, 3700000, 5500000)
pure val processStartedAtValues = Set(0, 1001, 1801001)
pure def canTick(t: Trigger, dt: int): bool = dt > 0
pure val eval_refuse_canTick = { dt: 0 }
pure def tick(t: Trigger, dt: int): Trigger = { ...t, now: t.now + dt }
pure def missedWhileStopped(t: Trigger, processStartedAt: int): bool = WS::missedOccurrence(t.nextAt, t.now) and t.nextAt < processStartedAt
pure def canFire(t: Trigger, nextInstant: int, processStartedAt: int): bool = t.life == Saved and t.enabled and t.schedule != OnRuntimeEvent and t.activity == Idle and t.nextAt <= t.now and processStartedAt <= t.now and (t.schedule == OnceAt or nextInstant > t.now)
pure def fire(t: Trigger, nextInstant: int, processStartedAt: int): Trigger = {
  val fired = { ...t, lastFiredAt: t.nextAt, nextAt: if (t.schedule == CronSchedule) nextInstant else t.nextAt }
  if (missedWhileStopped(t, processStartedAt)) { ...fired, history: recordRun(t.history, Missed({ scheduledAt: t.nextAt })), enabled: t.schedule == CronSchedule }
  else { ...fired, activity: Running({ source: Scheduled, revision: t.revision, room: t.room }) }
}
pure def runningScheduledOnce(t: Trigger): bool = {
  val activity = t.activity
  t.schedule == OnceAt and match activity { | Running(r) => r.source == Scheduled and r.revision == t.revision | Idle => false }
}
pure def alwaysFiredOccurrencesAreNotAhead(t: Trigger): bool = t.lastFiredAt <= t.now
pure def alwaysTheNextOccurrenceHasNotFired(t: Trigger): bool = (t.life == Saved and t.enabled and t.schedule != OnRuntimeEvent and not(runningScheduledOnce(t))) implies t.nextAt > t.lastFiredAt
pure def stepAFiringRunsOrIsMissed(before: Trigger, via: str, after: Trigger): bool = via == "fire" implies (if (after.activity == Idle) after.history.nthOr(after.history.length() - 1, Ran({ source: RunNow, turn: Completed })) == Missed({ scheduledAt: before.nextAt }) else after.history == before.history)
pure def sometimesCronRanAfterAMiss(t: Trigger): bool = t.schedule == CronSchedule and t.history.includes(Missed({ scheduledAt: 1000 })) and t.history.includes(Ran({ source: Scheduled, turn: Completed }))
pure def sometimesMissedOnceStaysListed(t: Trigger): bool = t.life == Saved and t.schedule == OnceAt and not(t.enabled) and t.history.includes(Missed({ scheduledAt: 1000 }))
pure val weight_create = 20
pure val weight_setEnabled = 6
pure val weight_finishRun = 12
pure val weight_tick = 8
pure val weight_fire = 12
```

### An event trigger runs once for each event of its name a conversation turn raises, never for a trigger run's events

When a conversation turn has released its room, it raises core `EventType`
`MESSAGE_RECEIVED` for the message it answered and `MESSAGE_SENT` for each
reply it stored; these two are the events the agent raises and subscribes to. The event id is
the message memory id; an event without one is dropped. Only an enabled
event trigger whose `eventKind` is the event's name runs, and an event of a
trigger's run (`byTrigger`: the memory carries a trigger id) never starts
one, so triggers never start each other. The last 100 event ids it ran for
are kept, and none of them runs it again. An event that arrives while a run
holds the trigger waits for it.

```quint
pure val maxSeenEvents: int = 100
pure val eventIdValues = Set("e1", "e2", "")
pure val nameValues = Set("MESSAGE_RECEIVED", "MESSAGE_SENT")
pure def rememberEvent(seen: List[str], eventId: str): List[str] = {
  val longer = seen.append(eventId)
  if (longer.length() > maxSeenEvents) longer.tail() else longer
}
pure def canReceiveEvent(t: Trigger, eventId: str, name: str, byTrigger: bool): bool = t.life == Saved and t.enabled and t.schedule == OnRuntimeEvent and name == t.eventKind and eventId != "" and not(byTrigger) and not(t.seenEvents.includes(eventId)) and t.activity == Idle
pure def receiveEvent(t: Trigger, eventId: str, name: str, byTrigger: bool): Trigger = { ...t, seenEvents: rememberEvent(t.seenEvents, eventId), activity: Running({ source: FromEvent, revision: t.revision, room: t.room }) }
pure def alwaysSeenEventsAreBounded(t: Trigger): bool = t.seenEvents.length() <= maxSeenEvents
pure def sometimesEventRan(t: Trigger): bool = t.history.includes(Ran({ source: FromEvent, turn: Completed }))
```

### The run history keeps the last 100 records

`GET /api/triggers/:id/runs` is `{runs: [{startedAt, finishedAt, status,
error?, source, missedOccurrenceAt?}]}`. Every finished run of a trigger
still saved and every missed occurrence is one record; the oldest falls off
past 100.

```quint
pure val maxRunHistory: int = 100
pure def recordRun(history: List[RunRecord], entry: RunRecord): List[RunRecord] = {
  val longer = history.append(entry)
  if (longer.length() > maxRunHistory) longer.tail() else longer
}
pure def alwaysHistoryIsBounded(t: Trigger): bool = t.history.length() <= maxRunHistory
```

## Story: Deliver a prompt only to the conversation I chose

> As the owner, I want a trigger's prompt to reach only the conversation I
> chose, and to be told it failed when that conversation is gone or the
> turn did not complete.

### A run delivers only to the room it started with and succeeds only when its turn completed

The prompt is one turn in the room the run started with, from a saved
revision. If that room is gone when the turn is delivered (`roomExists`, a
boundary fact) the run fails with `RoomUnavailable` and is never delivered
elsewhere. A turn that failed, was cancelled or denied is an error even when
part of a reply was delivered; a missed occurrence is `skipped`. The record's
`error` comes from its outcome: core `MISSED_SCHEDULED_OCCURRENCE_TEXT` for
a miss, `Prompt automation delivery conversation is unavailable` for
`RoomUnavailable`, `Prompt automation <failed|cancelled|denied>: <reason>`
for the other turns, and `Trigger reply was not fully delivered: <reason>`
when a completed turn's reply was cut short. A scheduled run of a `once`
trigger removes it unless the owner saved a write during the run; Run now
keeps it. A run of a removed trigger records nothing.

```quint
type RunStatus = RunSuccess | RunError | RunSkipped
pure def runStatus(entry: RunRecord): RunStatus = match entry { | Ran(r) => if (r.turn == Completed) RunSuccess else RunError | Missed(m) => RunSkipped }
pure def runSource(a: Activity): RunSource = match a { | Running(r) => r.source | Idle => RunNow }
pure def alwaysARunUsesTheSavedTrigger(t: Trigger): bool = {
  val activity = t.activity
  match activity { | Running(r) => t.life != Unsaved and r.room != "" and r.revision >= 1 and r.revision <= t.revision | Idle => true }
}
pure def canFinishRun(t: Trigger, roomExists: bool, turn: RunOutcome): bool = t.activity != Idle and turn != RoomUnavailable
pure def finishRun(t: Trigger, roomExists: bool, turn: RunOutcome): Trigger = {
  val record = Ran({ source: runSource(t.activity), turn: if (roomExists) turn else RoomUnavailable })
  if (t.life != Saved) { ...t, activity: Idle }
  else { ...t, activity: Idle, history: recordRun(t.history, record), life: if (runningScheduledOnce(t)) Removed else t.life }
}
pure def sometimesOnceRemovedAfterItsRun(t: Trigger): bool = t.life == Removed and t.schedule == OnceAt and t.history.includes(Ran({ source: Scheduled, turn: Completed }))
pure def sometimesOnceRanNowThenOnSchedule(t: Trigger): bool = t.life == Removed and t.schedule == OnceAt and t.history.includes(Ran({ source: RunNow, turn: Completed })) and t.history.includes(Ran({ source: Scheduled, turn: Completed }))
pure def sometimesFailedTurnIsAnError(t: Trigger): bool = t.history.includes(Ran({ source: RunNow, turn: Failed }))
pure def sometimesGoneConversationFailedTheRun(t: Trigger): bool = t.history.includes(Ran({ source: RunNow, turn: RoomUnavailable }))
```

### A run's prompt is told to the model as the trigger that fired, and the history never shows it as the owner's message

The run stores its prompt as the message its turn answers, worded
`Scheduled trigger "<displayName>" fired. Do this now: <instructions>`,
with the source `trigger-prompt` and the trigger's id, so the model reads
it as a saved prompt that fired, never as something the owner just said,
in this turn and in the history of later ones. It is stored for the owner,
so the turn keeps the owner's authority. The conversation's history pages,
jumps and search leave it out: the owner sees the reply the run stored,
shown as any reply is, and never a message they did not write.

```quint
type TurnInput = SaidByOwner | FiredByTrigger
pure def historyShows(fromAgent: bool, origin: TurnInput): bool = fromAgent or origin == SaidByOwner
pure def lawAFiredPromptIsNeverShownAsTheOwners(fromAgent: bool): bool = historyShows(fromAgent, FiredByTrigger) iff fromAgent
pure def lawWhatTheOwnerSaidIsShown(fromAgent: bool): bool = historyShows(fromAgent, SaidByOwner)
```

### A delivered run tells the open screen its conversation changed and sends each reply it stored, and a run without its room tells nothing

A run's prompt and reply arrive with no request from the screen, so the
run publishes them on the `conversation` feed
([events](../conversation/events.md)): `conversation-updated`
`{conversationId, roomId}` once its turn has ended, then one
`proactive-message` `{conversationId, roomId, message}` for each reply the
turn stored, `message` being that reply's history row
([conversations](../conversation/conversations.md)), its failure kind
included. A turn that stored no reply sends no `proactive-message`, and a
run whose room was gone publishes nothing. Publishing never changes the
run's outcome.

```quint
pure def announcedReplies(roomExists: bool, storedReplies: int): int = if (roomExists and storedReplies > 0) storedReplies else 0
pure val storedRepliesValues = Set(0, 1, 2)
pure def lawARunWithoutItsRoomSendsNoReply(storedReplies: int): bool = announcedReplies(false, storedReplies) == 0
pure def lawEachStoredReplyIsSentOnce(storedReplies: int): bool = storedReplies >= 0 implies announcedReplies(true, storedReplies) == storedReplies
```
