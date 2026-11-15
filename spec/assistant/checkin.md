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

### A synced event's change time is the provider's own clock, and an unreadable one stays unknown

For an event synced from a calendar provider, the change time is the
provider's update time, else its alternate update time, else its creation
time; refreshing the local copy never counts as a change. Malformed
metadata, or an invalid time in the field chosen, leaves the change time
unknown and reports partial coverage, without falling back to another
field. A locally written event uses its writer's clock. The check-in keeps
an event that happens today or whose known change time is recent.

```quint
type ChangeClock = ClockAbsent | ClockOld | ClockRecent | ClockInvalid
type EventClocks = { synced: bool, malformed: bool, primaryClock: ChangeClock, alternateClock: ChangeClock, createdClock: ChangeClock, copyClock: ChangeClock, today: bool }
type ChangeProjection = { changeClock: ChangeClock, included: bool, partial: bool }
pure def providerClock(e: EventClocks): ChangeClock =
  if (e.primaryClock != ClockAbsent) e.primaryClock else if (e.alternateClock != ClockAbsent) e.alternateClock else e.createdClock
pure def projectChange(e: EventClocks): ChangeProjection = {
  val unreadable = e.synced and (e.malformed or providerClock(e) == ClockInvalid)
  val clock = if (not(e.synced)) e.copyClock else if (unreadable) ClockAbsent else providerClock(e)
  { changeClock: clock, included: e.today or clock == ClockRecent, partial: unreadable }
}
pure val oldSynced: EventClocks = { synced: true, malformed: false, primaryClock: ClockOld, alternateClock: ClockAbsent, createdClock: ClockAbsent, copyClock: ClockRecent, today: false }
pure val eValues: Set[EventClocks] = List(
  oldSynced, { ...oldSynced, primaryClock: ClockAbsent, today: true }, { ...oldSynced, primaryClock: ClockInvalid, alternateClock: ClockRecent },
  { ...oldSynced, primaryClock: ClockAbsent, createdClock: ClockRecent }, { ...oldSynced, synced: false, malformed: true },
  { ...oldSynced, malformed: true, primaryClock: ClockRecent }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
pure def lawRefreshIsNotAChange(e: EventClocks): bool =
  (e.synced and providerClock(e) != ClockRecent) implies (projectChange(e).included == e.today)
pure def lawInvalidMetadataStaysUnknown(e: EventClocks): bool =
  (e.synced and (e.malformed or providerClock(e) == ClockInvalid)) implies (projectChange(e).changeClock == ClockAbsent and projectChange(e).partial)
pure def lawTodayOrRecentIsKept(e: EventClocks): bool =
  projectChange(e).included == (e.today or projectChange(e).changeClock == ClockRecent)
```
