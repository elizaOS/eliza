# Calendar read clock

UTC instants stay canonical in every Calendar record. A read or a create
chooses the zone it is about from the current request, and only the
display or the stored instant of a new event depends on it. A selected
event read uses a whole-second window around the event's start and
publishes only while the selection, owner, feed and source are still the
ones it was asked for. [Reviewed reads](./reviewedReads.md) owns what is
shared; [availability](./availability.md) owns occupancy windows.

## Story: See and create times in the zone I am asking about

> As the owner, I want Calendar times shown and created in the zone my
> request names, or my device's zone, or else my own configured zone,
> without the stored instant changing.

### A request's zone is the stated zone, else the client's zone, else the owner's

An explicit zone in the request wins. Without one, a valid zone hint
from the client is used. Otherwise the owner's configured zone applies.
A zone the planner proposed is never part of this choice: the context
zone for a create is the client's zone, else the owner's.

```quint
type ClockZone = UtcZone | PacificZone | EasternZone
type ZoneHint = { present: bool, zone: ClockZone }
pure def requestZone(explicit: ZoneHint, client: ZoneHint, owner: ClockZone): ClockZone =
  if (explicit.present) explicit.zone else if (client.present) client.zone else owner
pure def contextZone(client: ZoneHint, owner: ClockZone): ClockZone = if (client.present) client.zone else owner
pure val explicitValues = Set({ present: false, zone: UtcZone }, { present: true, zone: PacificZone }, { present: true, zone: EasternZone })
pure val clientValues = Set({ present: false, zone: UtcZone }, { present: true, zone: UtcZone }, { present: true, zone: PacificZone })
pure def lawExplicitZoneWins(explicit: ZoneHint, client: ZoneHint, owner: ClockZone): bool =
  explicit.present implies requestZone(explicit, client, owner) == explicit.zone
pure def lawClientZoneBeforeOwner(explicit: ZoneHint, client: ZoneHint, owner: ClockZone): bool =
  not(explicit.present) and client.present implies requestZone(explicit, client, owner) == client.zone
pure def lawOwnerZoneOtherwise(explicit: ZoneHint, client: ZoneHint, owner: ClockZone): bool =
  not(explicit.present) and not(client.present) implies requestZone(explicit, client, owner) == owner
```

### Display shifts the canonical instant by the zone's offset on that date

A displayed time is the stored UTC minute plus the chosen zone's offset
on that date, so summer and winter differ. The stored minute itself
never changes. A created event stores the wall time it was asked for
minus the chosen zone's offset, so it reads back as the same wall time
in that zone.

```quint
pure def utcOffsetMinutes(zone: ClockZone, summer: bool): int =
  if (zone == PacificZone) (if (summer) -420 else -480)
  else if (zone == EasternZone) (if (summer) -240 else -300)
  else 0
pure def displayMinutes(stored: int, zone: ClockZone, summer: bool): int = stored + utcOffsetMinutes(zone, summer)
pure def createdUtcMinutes(wall: int, zone: ClockZone, summer: bool): int = wall - utcOffsetMinutes(zone, summer)
pure def lawWinterPacificEvening(summer: bool): bool =
  not(summer) implies displayMinutes(1140, PacificZone, summer) == 660
pure def lawCreatedWallTimeReadsBack(wall: int, zone: ClockZone, summer: bool): bool =
  displayMinutes(createdUtcMinutes(wall, zone, summer), zone, summer) == wall
pure val wallValues = Set(0, 977, 1439)
```

### An all-day event keeps its civil date; a timed event uses the viewer's day

An all-day event is a civil date, not an instant, so its displayed day
is that date whatever the source and viewer offsets are. A timed event's
day is the day its UTC minute falls on in the viewer's current zone: the
day before, the same day, or the day after. The complete selected event
stays canonical; only the label is derived.

```quint
pure def dayShift(localMinute: int): int = if (localMinute < 0) -1 else if (localMinute >= 1440) 1 else 0
pure def displayDayShift(utcMinute: int, viewerOffset: int, allDay: bool): int =
  if (allDay) 0 else dayShift(utcMinute + viewerOffset)
pure def lawAllDayKeepsCivilDate(utcMinute: int, viewerOffset: int): bool = displayDayShift(utcMinute, viewerOffset, true) == 0
pure def lawTimedMidnightWestIsPreviousDay(viewerOffset: int): bool =
  viewerOffset < 0 implies displayDayShift(0, viewerOffset, false) == -1
pure val viewerOffsetValues = Set(-480, 0, 840)
pure val utcMinuteValues = Set(0, 1439)
```

### A stated year wins, a wrong extracted year is corrected, and a past start asks first

When a create names a date, a trailing year wins. Otherwise a stated
numeric year or "next" chooses the coming year, and a date with no year
or "this year" chooses the current year. The year the extractor guessed
is never used on its own. The wall clock and duration stay as
extracted. A start that is already past must be confirmed by the owner
before anything is stored; a future start is ready.

```quint
type YearCue = NoYearCue | ThisYearCue | NextYearCue | StatedYearCue
pure def correctedYear(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int): int =
  if (trailingYear > 0) trailingYear
  else if (cue == StatedYearCue) statedYear
  else if (cue == NextYearCue) currentYear + 1
  else currentYear
pure def mustAskBeforeCreate(startYear: int, currentYear: int, dayPassed: bool): bool =
  startYear < currentYear or (startYear == currentYear and dayPassed)
pure def lawTrailingYearWins(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int): bool =
  trailingYear > 0 implies correctedYear(cue, statedYear, trailingYear, currentYear) == trailingYear
pure def lawYearlessUsesCurrentYear(statedYear: int, currentYear: int): bool =
  correctedYear(NoYearCue, statedYear, 0, currentYear) == currentYear
pure def lawPastStartAsks(startYear: int, currentYear: int, dayPassed: bool): bool =
  (startYear < currentYear or (startYear == currentYear and dayPassed)) implies mustAskBeforeCreate(startYear, currentYear, dayPassed)
pure def lawFutureStartIsReady(startYear: int, currentYear: int, dayPassed: bool): bool =
  (startYear > currentYear or (startYear == currentYear and not(dayPassed))) implies not(mustAskBeforeCreate(startYear, currentYear, dayPassed))
pure val statedYearValues = Set(2026, 2027, 2028)
pure val currentYearValues = Set(2026)
pure val trailingYearValues = Set(0, 2028)
pure val startYearValues = Set(2025, 2026, 2027)
```

## Story: Share the exact event I selected, read through a whole-second window

> As the owner, I want a selected event found even when its start has
> milliseconds, and shared only if what I selected is still current.

### The read window covers the whole second around the selected start

The provider filters by whole seconds. The read window therefore runs
from the second before the start's second to the second after it, so an
event with a fractional start or a one-millisecond duration is never
lost. The window never grants authority to read: it only finds the
record.

```quint
pure def wholeSecond(ms: int): int = (ms / 1000) * 1000
pure def windowIncludes(start: int, duration: int): bool =
  start < wholeSecond(start + 1000) and start + duration > wholeSecond(start - 1000)
pure def lawWholeSecondWindowIncludesSelection(start: int, duration: int): bool =
  start >= 1000 and duration >= 1 implies windowIncludes(start, duration)
pure val startValues = Set(10000, 10500, 10999)
pure val durationValues = Set(1, 1000)
```

### A selected read publishes the whole event only while it is still current

The query returns first; then the read finishes. It publishes the whole
selected event only when the query found it and the selection is still
current, the owner still authorized, the feed complete, the source the
one selected, and the read not cancelled. A change to any of these
before it finishes makes it publish nothing. Each read finishes.

```quint
type SelectedReadPhase = Querying | Queried | Finished
type SelectedRead = { phase: SelectedReadPhase, found: bool, authorized: bool, current: bool, complete: bool,
  matching: bool, cancelled: bool, published: bool }
pure val initial: SelectedRead = { phase: Querying, found: false, authorized: true, current: true, complete: true,
  matching: true, cancelled: false, published: false }
pure def eligible(s: SelectedRead): bool = s.found and s.authorized and s.current and s.complete and s.matching and not(s.cancelled)
pure def canQueryReturns(s: SelectedRead): bool = s.phase == Querying
pure def queryReturns(s: SelectedRead, start: int, duration: int): SelectedRead =
  { ...s, phase: Queried, found: windowIncludes(start, duration) }
pure def canChangeSelection(s: SelectedRead): bool = s.phase != Finished and s.current
pure def changeSelection(s: SelectedRead): SelectedRead = { ...s, current: false }
pure def canRevokeOwner(s: SelectedRead): bool = s.phase != Finished and s.authorized
pure def revokeOwner(s: SelectedRead): SelectedRead = { ...s, authorized: false }
pure def canPartialFeed(s: SelectedRead): bool = s.phase != Finished and s.complete
pure def partialFeed(s: SelectedRead): SelectedRead = { ...s, complete: false }
pure def canChangeSource(s: SelectedRead): bool = s.phase != Finished and s.matching
pure def changeSource(s: SelectedRead): SelectedRead = { ...s, matching: false }
pure def canCancelRead(s: SelectedRead): bool = s.phase != Finished and not(s.cancelled)
pure def cancelRead(s: SelectedRead): SelectedRead = { ...s, cancelled: true }
pure def canFinish(s: SelectedRead): bool = s.phase == Queried
pure def finish(s: SelectedRead): SelectedRead = { ...s, phase: Finished, published: eligible(s) }
pure def alwaysPublicationNeedsCurrentAuthority(s: SelectedRead): bool = s.published implies s.phase == Finished and eligible(s)
pure def sometimesPublished(s: SelectedRead): bool = s.published
pure def sometimesWithheld(s: SelectedRead): bool = s.phase == Finished and s.found and not(s.published)
pure val fair_queryReturns = "weak"
pure val fair_finish = "weak"
pure def leadsToReadFinishes(s: SelectedRead, later: SelectedRead): bool = later.phase == Finished
```
