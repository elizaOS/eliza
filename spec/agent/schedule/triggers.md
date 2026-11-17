# Prompt triggers

A trigger is one saved prompt the agent sends to a conversation once, on a
cron schedule, or each time a named runtime event happens. The agent's
`@elizaos/agent/triggers` module keeps it and serves `/api/triggers…`
(create, list, read, update, delete, run history, run now). Each scheduled
occurrence runs as a core exclusive scheduled task: core scheduling
(`spec/core/scheduling.md`) owns exclusivity and stop, and the
[workflow schedule](../../workflow/schedule.md) owns the window after which a
late occurrence is missed. Workflow schedules are not triggers.

## Story: Run a trigger now or on schedule without losing my edits

> As the owner, I want a saved prompt to run when I press Run now, at its
> time or on its event, and never to run twice for one press, occurrence or
> event, so that my edits and my run history stay true.

### A new trigger is saved disabled, for an existing conversation, with a future first instant or an event name

The create body is `{kind: "prompt", displayName, instructions, triggerType,
timezone, scheduledAtIso | cronExpression | eventKind,
deliveryConversationId?, wakeMode: "inject_now", enabled: false}`; the reply
echoes `deliveryConversationId`, `displayName`, `instructions` and `enabled`.
`at` is the first instant: the `once` time, or the next cron instant that
core's `computeNextCronRunAtMs` finds from the 5-field expression and zone.
Zone, cron and room checks are boundary facts. A selected conversation that
does not exist is 409; it is never replaced by another.

```quint
import schedule as WS from "../../workflow/schedule"
type TriggerType = OnceAt | CronSchedule | OnRuntimeEvent
type Lifecycle = Unsaved | Saved | Removed
type RunSource = RunNow | Scheduled | FromEvent
type RunOutcome = Completed | Failed | Cancelled | Denied | RoomUnavailable
type Activity = Idle | Running({ source: RunSource, revision: int, room: str })
type RunRecord = Ran({ source: RunSource, turn: RunOutcome }) | Missed({ scheduledAt: int })
type Trigger = { life: Lifecycle, schedule: TriggerType, enabled: bool, revision: int, room: str, eventKind: str, nextAt: int, activity: Activity, seenEvents: Set[str], history: List[RunRecord], runCount: int, missed: int, now: int, startedAt: int, firedAt: Set[int] }
pure val initial: Trigger = { life: Unsaved, schedule: OnceAt, enabled: false, revision: 0, room: "", eventKind: "", nextAt: 0, activity: Idle, seenEvents: Set(), history: List(), runCount: 0, missed: 0, now: 0, startedAt: 0, firedAt: Set() }
pure val roomValues = Set("room1", "room2")
pure val eventKindValues = Set("message_received", "reaction_received")
pure val atValues = Set(1000, 2000)
pure def validSchedule(schedule: TriggerType, eventKind: str, at: int, now: int): bool = if (schedule == OnRuntimeEvent) eventKind != "" else at > now
pure def canCreate(t: Trigger, schedule: TriggerType, room: str, eventKind: str, at: int, roomExists: bool): bool = t.life == Unsaved and roomExists and room != "" and validSchedule(schedule, eventKind, at, t.now)
pure def create(t: Trigger, schedule: TriggerType, room: str, eventKind: str, at: int, roomExists: bool): Trigger = { ...t, life: Saved, schedule: schedule, room: room, eventKind: eventKind, nextAt: at, enabled: false, revision: 1 }
```

### Edits, enabling and removal are refused while a run holds the trigger or once the revision they read has moved on

`PUT` and `DELETE` while a run holds the trigger are 409; a body that names
the revision it read is 409 when the trigger has moved on. An edit of an
enabled timed trigger needs a future `at`; a disabled one may keep its past
time. Enabling a `once` trigger needs its time still ahead, and enabling a
cron trigger takes the next instant. Removal is final.

```quint
type RevisionCheck = AnyRevision | AtRevision({ revision: int })
pure val expectedValues = Set(AnyRevision, AtRevision({ revision: 1 }), AtRevision({ revision: 2 }))
pure def revisionMatches(expected: RevisionCheck, revision: int): bool = match expected { | AtRevision(e) => e.revision == revision | AnyRevision => true }
pure def canEdit(t: Trigger, schedule: TriggerType, room: str, eventKind: str, at: int, roomExists: bool, expected: RevisionCheck): bool = t.life == Saved and t.activity == Idle and revisionMatches(expected, t.revision) and roomExists and room != "" and (validSchedule(schedule, eventKind, at, t.now) or (not(t.enabled) and schedule != OnRuntimeEvent))
pure def edit(t: Trigger, schedule: TriggerType, room: str, eventKind: str, at: int, roomExists: bool, expected: RevisionCheck): Trigger = { ...t, schedule: schedule, room: room, eventKind: eventKind, nextAt: at, revision: t.revision + 1 }
pure def canRemove(t: Trigger, expected: RevisionCheck): bool = t.life == Saved and t.activity == Idle and revisionMatches(expected, t.revision)
pure def remove(t: Trigger, expected: RevisionCheck): Trigger = { ...t, life: Removed }
pure def runSource(a: Activity): RunSource = match a { | Running(r) => r.source | Idle => RunNow }
pure def runUses(a: Activity, revision: int, room: str): bool = match a { | Running(r) => r.revision == revision and r.room == room | Idle => true }
pure def alwaysARunUsesTheSavedTrigger(t: Trigger): bool = t.activity == Idle or (t.life == Saved and runUses(t.activity, t.revision, t.room))
pure def sometimesEditedAfterARun(t: Trigger): bool = t.life == Saved and t.runCount > 0 and t.revision >= 3
```

### Enabling a trigger past 100 active triggers is refused

`activeOthers` is the number of the owner's other enabled triggers, read
from the store; the refusal is 429 and changes nothing.

```quint
pure val maxActiveTriggers: int = 100
pure val activeOthersValues = Set(0, 99, 100)
pure def canSetEnabled(t: Trigger, on: bool, at: int, activeOthers: int, expected: RevisionCheck): bool = t.life == Saved and t.activity == Idle and revisionMatches(expected, t.revision) and (not(on) or t.enabled or (activeOthers < maxActiveTriggers and (if (t.schedule == OnceAt) t.nextAt > t.now else if (t.schedule == CronSchedule) at > t.now else true)))
pure def setEnabled(t: Trigger, on: bool, at: int, activeOthers: int, expected: RevisionCheck): Trigger = { ...t, enabled: on, nextAt: if (on and not(t.enabled) and t.schedule == CronSchedule) at else t.nextAt, revision: t.revision + 1 }
pure def sometimesEnabledCron(t: Trigger): bool = t.life == Saved and t.enabled and t.schedule == CronSchedule
```

### Run now starts one run of the saved trigger, even a disabled one, after any run in progress

`POST /api/triggers/:id/execute {}` waits for a run in progress, then starts
one run; the transport never replays a request, so one press is one run. The
reply is `{ok, result: {status}}` with the status of `runStatus`.

```quint
pure def canRunNow(t: Trigger): bool = t.life == Saved and t.activity == Idle
pure def runNow(t: Trigger): Trigger = { ...t, activity: Running({ source: RunNow, revision: t.revision, room: t.room }) }
pure def sometimesRanNowWhileDisabled(t: Trigger): bool = not(t.enabled) and t.history.includes(Ran({ source: RunNow, turn: Completed }))
```

### An occurrence fires once, and one missed while the agent was not running is recorded and never run

A due occurrence of an enabled timed trigger fires once; a cron trigger
moves on to `nextInstant`, the next instant after now. When the occurrence
is past the workflow miss window and fell due before this agent process
started, it is recorded as missed: nothing runs and no run is counted; a
missed `once` trigger stays listed, disabled, so the owner can still run it
now. A stop aborts a run in progress first (core runtime shutdown), so the
agent restarts only between runs.

```quint
pure val dtValues = Set(1000, 1800001)
pure val nextInstantValues = Set(2000, 1802000, 3700000)
pure def canTick(t: Trigger, dt: int): bool = dt > 0
pure def tick(t: Trigger, dt: int): Trigger = { ...t, now: t.now + dt }
pure def canRestartAgent(t: Trigger): bool = t.activity == Idle
pure def restartAgent(t: Trigger): Trigger = { ...t, startedAt: t.now }
pure def missedWhileStopped(t: Trigger): bool = WS::missedOccurrence(t.nextAt, t.now) and t.nextAt < t.startedAt
pure def canFire(t: Trigger, nextInstant: int): bool = t.life == Saved and t.enabled and t.schedule != OnRuntimeEvent and t.activity == Idle and t.nextAt <= t.now and nextInstant > t.now
pure def fire(t: Trigger, nextInstant: int): Trigger = {
  val fired = { ...t, firedAt: t.firedAt.union(Set(t.nextAt)), nextAt: if (t.schedule == CronSchedule) nextInstant else t.nextAt }
  if (missedWhileStopped(t)) { ...fired, missed: t.missed + 1, history: recordRun(t.history, Missed({ scheduledAt: t.nextAt })), enabled: t.schedule == CronSchedule }
  else { ...fired, activity: Running({ source: Scheduled, revision: t.revision, room: t.room }) }
}
pure def runningScheduledOnce(t: Trigger): bool = t.schedule == OnceAt and t.activity != Idle and runSource(t.activity) == Scheduled
pure def alwaysFiredOccurrencesAreNotAhead(t: Trigger): bool = t.firedAt.forall(x => x <= t.now)
pure def alwaysTheNextOccurrenceHasNotFired(t: Trigger): bool = (t.life == Saved and t.enabled and t.schedule != OnRuntimeEvent and not(runningScheduledOnce(t))) implies not(t.firedAt.contains(t.nextAt))
pure def stepAFiringRunsOrIsMissed(before: Trigger, via: str, after: Trigger): bool = via == "fire" implies ((after.missed == before.missed + 1) iff after.activity == Idle)
pure def sometimesCronRanAfterAMiss(t: Trigger): bool = t.schedule == CronSchedule and t.missed > 0 and t.history.includes(Ran({ source: Scheduled, turn: Completed }))
pure def sometimesMissedOnceStaysListed(t: Trigger): bool = t.life == Saved and t.schedule == OnceAt and not(t.enabled) and t.missed > 0
pure val weight_tick = 3
pure val weight_fire = 3
```

### An event trigger runs once for each emitted event of its name

Only an enabled event trigger runs, only for a runtime event whose name is
its `eventKind`, and an event id it has seen never runs it again. An event
that arrives while a run holds the trigger waits for it.

```quint
pure val eventIdValues = Set("e1", "e2", "")
pure val nameValues = Set("message_received", "reaction_received")
pure def canReceiveEvent(t: Trigger, eventId: str, name: str): bool = t.life == Saved and t.enabled and t.schedule == OnRuntimeEvent and name == t.eventKind and eventId != "" and not(t.seenEvents.contains(eventId)) and t.activity == Idle
pure def receiveEvent(t: Trigger, eventId: str, name: str): Trigger = { ...t, seenEvents: t.seenEvents.union(Set(eventId)), activity: Running({ source: FromEvent, revision: t.revision, room: t.room }) }
pure def stepAnEventIdRunsOnce(before: Trigger, via: str, after: Trigger): bool = via == "receiveEvent" implies after.seenEvents.size() == before.seenEvents.size() + 1
pure def sometimesEventRan(t: Trigger): bool = t.history.includes(Ran({ source: FromEvent, turn: Completed }))
```

### The run history keeps the last 100 records, and a one-time trigger is removed after its scheduled run

Every finished run and every missed occurrence is one record; the oldest
falls off past 100. Run now on a `once` trigger is an extra run and keeps
the scheduled one.

```quint
pure val maxRunHistory: int = 100
pure def recordRun(history: List[RunRecord], entry: RunRecord): List[RunRecord] = {
  val longer = history.append(entry)
  if (longer.length() > maxRunHistory) longer.tail() else longer
}
pure def alwaysHistoryIsBounded(t: Trigger): bool = t.history.length() <= maxRunHistory and t.runCount >= 0 and t.missed >= 0
pure def sometimesOnceRemovedAfterItsRun(t: Trigger): bool = t.life == Removed and t.schedule == OnceAt and t.runCount > 0
```

## Story: Deliver a prompt only to the conversation I chose

> As the owner, I want a trigger's prompt to reach only the conversation I
> chose, and to be told it failed when that conversation is gone or the
> turn did not complete.

### A run delivers only to the trigger's conversation and succeeds only when its turn completed

The prompt is one turn in the conversation the run started with, which no
edit can change while it runs. If that conversation is gone when the turn is
delivered (`roomExists`, a boundary fact), the run fails with
`RoomUnavailable` and is never delivered elsewhere. A turn that failed, was cancelled or denied is an error even
when part of a reply was delivered; a missed occurrence is `skipped`.

```quint
type RunStatus = RunSuccess | RunError | RunSkipped
pure def runStatus(entry: RunRecord): RunStatus = match entry { | Ran(r) => if (r.turn == Completed) RunSuccess else RunError | Missed(m) => RunSkipped }
pure def canFinishRun(t: Trigger, roomExists: bool, turn: RunOutcome): bool = t.activity != Idle and turn != RoomUnavailable
pure def finishRun(t: Trigger, roomExists: bool, turn: RunOutcome): Trigger = {
  val source = runSource(t.activity)
  { ...t, activity: Idle, runCount: t.runCount + 1, history: recordRun(t.history, Ran({ source: source, turn: if (roomExists) turn else RoomUnavailable })), life: if (source == Scheduled and t.schedule == OnceAt) Removed else t.life }
}
pure def sometimesGoneConversationFailedTheRun(t: Trigger): bool = t.history.includes(Ran({ source: RunNow, turn: RoomUnavailable }))
```
