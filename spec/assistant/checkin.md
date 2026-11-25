# Check-in summaries

A scheduled check-in (in the morning, for instance) collects what changed
for the owner, renders a summary with the configured model, and stores the
summary as the day's report. A summary is stored only when the model
returned real text for the right day; any failure leaves storage as it
was. This machine follows one check-in.

What the collectors gather and how good the model's text is are outside
this model; so are scheduling, delivery and cancellation at the scheduler.

## Story: Summarize my day only from a real answer

> As an owner, I want the check-in to store a summary only when the model
> actually wrote one for today, and to store nothing rather than an empty
> or wrong-day report.

### A summary is stored only after the model returns text for the reported day

Rendering may find no model, have the model refuse, return blank text, or
return text that declares a report day other than the current one. Only a
valid answer goes on to storage, and storage may still refuse the write.
The model is asked with no output limit, so a summary is never cut short.

```quint
type CheckinPhase = CheckinIdle | Collected | Rendered | SummaryStored | CheckinFailed
type RenderResult = ValidSummary | BlankSummary | NoModel | GenerationRefused | WrongDaySummary
type Checkin = { checkinPhase: CheckinPhase, modelCalled: bool, rendered: RenderResult, writes: int }
pure val initial: Checkin = { checkinPhase: CheckinIdle, modelCalled: false, rendered: NoModel, writes: 0 }
pure def canCollectCheckin(s: Checkin): bool = s.checkinPhase == CheckinIdle
pure def collectCheckin(s: Checkin): Checkin = { ...s, checkinPhase: Collected }
pure def canRenderCheckin(s: Checkin, result: RenderResult): bool = s.checkinPhase == Collected
pure def renderCheckin(s: Checkin, result: RenderResult): Checkin =
  { ...s, checkinPhase: if (result == ValidSummary) Rendered else CheckinFailed, modelCalled: result != NoModel, rendered: result }
pure def canPersistCheckin(s: Checkin, written: bool): bool = s.checkinPhase == Rendered
pure def persistCheckin(s: Checkin, written: bool): Checkin =
  { ...s, checkinPhase: if (written) SummaryStored else CheckinFailed, writes: if (written) 1 else 0 }
pure def alwaysOnlyAValidSummaryIsStored(s: Checkin): bool =
  s.writes > 0 implies (s.rendered == ValidSummary and s.modelCalled and s.checkinPhase == SummaryStored)
pure def alwaysOnlyAValidAnswerGoesOnToStorage(s: Checkin): bool =
  s.checkinPhase == Rendered implies (s.rendered == ValidSummary and s.modelCalled)
```

### A failed check-in leaves storage unchanged, and a summary is stored at most once

```quint
pure def alwaysFailureStoresNothing(s: Checkin): bool = s.checkinPhase == CheckinFailed implies s.writes == 0
pure def alwaysStoredOnce(s: Checkin): bool = s.writes >= 0 and s.writes <= 1
```

### A check-in can store its summary, refuse a wrong-day answer, or lose its write

```quint
pure def sometimesStored(s: Checkin): bool = s.checkinPhase == SummaryStored
pure def sometimesWrongDayRefused(s: Checkin): bool = s.checkinPhase == CheckinFailed and s.rendered == WrongDaySummary
pure def sometimesWriteRefused(s: Checkin): bool = s.checkinPhase == CheckinFailed and s.rendered == ValidSummary
```

## Story: Mention only calendar events that changed recently

> As an owner reading my check-in, I want "changed today" to mean the
> provider changed the event recently, not that my device refreshed its
> copy.

### A recent check-in keeps an event that is today or whose provider change is recent

A synced event's change time is [the calendar's event change
time](../calendar/managedFeed.md); refreshing the local copy never counts
as a change. Malformed metadata or an unreadable time leaves the change
time unknown and reports partial coverage. A locally written event uses
its writer's clock. The check-in keeps an event that happens today or
whose known change time is recent.

```quint
import managedFeed as MF from "../calendar/managedFeed"
type EventClocks = { synced: bool, malformed: bool, editedClock: MF::ChangeClock, createdClock: MF::ChangeClock, copyClock: MF::ChangeClock, today: bool }
type ChangeProjection = { changeClock: MF::ChangeClock, included: bool, partial: bool }
pure def projectChange(e: EventClocks): ChangeProjection = {
  val unreadable = e.synced and (e.malformed or MF::providerClock(e.editedClock, e.createdClock) == MF::ClockInvalid)
  val clock = if (not(e.synced)) e.copyClock else if (unreadable) MF::ClockAbsent else MF::eventChangeTime(e.editedClock, e.createdClock)
  { changeClock: clock, included: e.today or clock == MF::ClockRecent, partial: unreadable }
}
pure val oldSynced: EventClocks = { synced: true, malformed: false, editedClock: MF::ClockOld, createdClock: MF::ClockAbsent, copyClock: MF::ClockRecent, today: false }
pure val eValues: Set[EventClocks] = List(
  oldSynced, { ...oldSynced, editedClock: MF::ClockAbsent, today: true }, { ...oldSynced, editedClock: MF::ClockInvalid, createdClock: MF::ClockRecent },
  { ...oldSynced, editedClock: MF::ClockAbsent, createdClock: MF::ClockRecent }, { ...oldSynced, synced: false, malformed: true },
  { ...oldSynced, malformed: true, editedClock: MF::ClockRecent }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
pure def lawRefreshIsNotAChange(e: EventClocks): bool =
  (e.synced and MF::eventChangeTime(e.editedClock, e.createdClock) != MF::ClockRecent) implies (projectChange(e).included == e.today)
pure def lawInvalidMetadataStaysUnknown(e: EventClocks): bool =
  (e.synced and (e.malformed or MF::providerClock(e.editedClock, e.createdClock) == MF::ClockInvalid)) implies (projectChange(e).changeClock == MF::ClockAbsent and projectChange(e).partial)
pure def lawTodayOrRecentIsKept(e: EventClocks): bool =
  projectChange(e).included == (e.today or projectChange(e).changeClock == MF::ClockRecent)
```

## Story: Check in on me at the times I chose

> As an owner, I want my morning check-in, and a night check-in if I ask
> for one, at the times I set on my own clock, and none that I turned off.

### A check-in comes at the time the owner chose, the morning one at eight until they choose, and the night one only once chosen

The owner sets the morning or the night check-in to an hour and minute
of the day on their clock, or turns either off, from the conversation or
from their own client. Until they choose, the morning check-in comes at
08:00 and no night check-in comes. A new time replaces the check-in
already scheduled for that slot, so it comes once a day at the new time
and never at the old one too, and the owner hears it was changed only when
the scheduler applied the change. A check-in the owner dismissed from
their scheduled tasks is off until they choose a time for it again, so a
restart never brings it back. Every check-in follows the owner's clock:
when the owner states a new zone, the daily check-ins, goal check-ins,
routines and repeating reminders are rescheduled on it at once.

```quint
type CheckinSlot = MorningCheckin | NightCheckin
type CheckinSetting = CheckinUnset | CheckinOff | CheckinAt({ minute: int })
pure val defaultMorningMinute = 480
pure def checkinMinuteValid(minute: int): bool = minute >= 0 and minute < 1440
pure def checkinSchedule(slot: CheckinSlot, setting: CheckinSetting): CheckinSetting =
  if (setting == CheckinUnset) (if (slot == MorningCheckin) CheckinAt({ minute: defaultMorningMinute }) else CheckinOff) else setting
pure val settingValues: Set[CheckinSetting] = List(CheckinUnset, CheckinOff, CheckinAt({ minute: 450 }), CheckinAt({ minute: 1290 }))
  .foldl(Set(), (acc, s) => acc.union(Set(s)))
pure def lawTheMorningCheckinComesAtEightUntilChosen(slot: CheckinSlot): bool =
  slot == MorningCheckin implies checkinSchedule(slot, CheckinUnset) == CheckinAt({ minute: defaultMorningMinute })
pure def lawNoNightCheckinComesUntilChosen(slot: CheckinSlot): bool =
  slot == NightCheckin implies checkinSchedule(slot, CheckinUnset) == CheckinOff
pure def lawAChosenCheckinIsKept(slot: CheckinSlot, setting: CheckinSetting): bool =
  setting != CheckinUnset implies checkinSchedule(slot, setting) == setting
pure def checkinAfterDismissal(chosenAgain: bool, setting: CheckinSetting): CheckinSetting = if (chosenAgain) setting else CheckinOff
pure def lawADismissedCheckinStaysOffUntilChosen(slot: CheckinSlot, setting: CheckinSetting): bool =
  checkinSchedule(slot, checkinAfterDismissal(false, setting)) == CheckinOff
```

## Story: Brief me on my morning, evening or week when I ask

> As an owner, I want a brief of my morning, my evening or my week when I
> ask for one, told only from what my calendar, to-dos, goals, routines
> and reminders hold, and told plainly when one of them could not be read.

### A brief is the kind the owner named, else the morning one before five in the evening and the evening one from then

A morning or evening brief covers today and a weekly brief the seven days
from today, unless the owner names today, tomorrow or this week. The kind
and the days are what the owner's own message names: the planner's choice
counts only when the message says it too, a weekly brief or a week's span
is never read from a passing mention of the week, and a brief that names
no kind is the morning brief before 17:00 on the owner's clock and the
evening brief from then. The brief holds every calendar event that
overlaps its days, with its end and place when known, the open to-dos,
the active goals with how they are going, the active routines with when
they come, and the reminders due in its days; only the evening brief
recaps the day, with the to-dos, routines and reminders the owner
finished today and the goal check-ins they answered. Each source is read
on its own: one that could not be read is said to be unchecked and the
rest are still told. A section the owner asked to leave out of their
briefs stays out until they ask for it back. The model writes the brief
from the whole fact sheet, with no output limit, and the owner hears what
it wrote whole; a brief the model's own maximum cut off fails the request
with that error.

```quint
type BriefKind = MorningBrief | EveningBrief | WeeklyBrief
type BriefAsked = AskedMorning | AskedEvening | AskedWeekly | AskedNoKind
type BriefPeriod = PeriodToday | PeriodTomorrow | PeriodThisWeek | PeriodUnstated
pure val eveningStartMinute = 1020
pure val minuteOfDayValues = Set(0, 600, 1019, 1020, 1439)
pure def briefKind(asked: BriefAsked, minuteOfDay: int): BriefKind =
  if (asked == AskedMorning) MorningBrief
  else if (asked == AskedEvening) EveningBrief
  else if (asked == AskedWeekly) WeeklyBrief
  else if (minuteOfDay >= eveningStartMinute) EveningBrief
  else MorningBrief
pure def briefPeriod(kind: BriefKind, asked: BriefPeriod): BriefPeriod =
  if (asked != PeriodUnstated) asked else if (kind == WeeklyBrief) PeriodThisWeek else PeriodToday
pure def recapsTheDay(kind: BriefKind): bool = kind == EveningBrief
pure def lawANamedBriefKeepsItsKind(minuteOfDay: int): bool =
  briefKind(AskedMorning, minuteOfDay) == MorningBrief and briefKind(AskedEvening, minuteOfDay) == EveningBrief and briefKind(AskedWeekly, minuteOfDay) == WeeklyBrief
pure def lawAnUnnamedBriefFollowsTheClock(minuteOfDay: int): bool =
  briefKind(AskedNoKind, minuteOfDay) == (if (minuteOfDay >= eveningStartMinute) EveningBrief else MorningBrief)
pure def lawAStatedPeriodIsKept(kind: BriefKind, asked: BriefPeriod): bool = asked != PeriodUnstated implies briefPeriod(kind, asked) == asked
pure def lawAWeeklyBriefCoversTheWeek(kind: BriefKind): bool =
  briefPeriod(kind, PeriodUnstated) == (if (kind == WeeklyBrief) PeriodThisWeek else PeriodToday)
pure def lawOnlyTheEveningBriefRecapsTheDay(kind: BriefKind): bool = recapsTheDay(kind) iff kind == EveningBrief
```
