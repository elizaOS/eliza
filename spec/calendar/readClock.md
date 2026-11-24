# Calendar read clock

UTC instants stay canonical in every Calendar record. A read or a create
chooses the zone it is about from the current request, and only the
display or the stored instant of a new event depends on it.
[Reviewed reads](./reviewedReads.md) own what is shared;
[availability](./availability.md) owns occupancy windows.

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

### A time sent without an offset is wall time in the request's zone

A time the Calendar action receives names a real date and a real clock
time, where 24:00 is the midnight that ends its day; anything else is
refused as no time at all. A time that carries its own offset is an
instant and is used as sent. Without one it is wall-clock time, and code,
not the planner, applies the offset of that date: in the request's zone
for a read or a change to an event; for an all-day event as that civil
date, whatever the zone; and for a new event in the create's context
zone. A new event's time sent with another zone, one that would move it,
is read in that zone only when the owner's own words name it ("9am Tokyo
time"); otherwise nothing is saved and the reply asks for the time with
its offset. A wall time that its zone's clock skips, or shows twice,
names no single instant: the request is refused and nothing is read or
changed.

```quint
type InstantRead = InstantAsSent | InstantInWallZone | InstantRefused | InstantUnreal
type WallZone = WallAsCivilDate | WallInRequestZone | WallInContextZone | WallInNamedZone | WallZoneUnsaid
pure def clockReal(clockHour: int, clockMinute: int, clockSecond: int): bool =
  clockHour >= 0 and clockMinute >= 0 and clockSecond >= 0 and clockMinute <= 59 and clockSecond <= 59 and
  (clockHour <= 23 or (clockHour == 24 and clockMinute == 0 and clockSecond == 0))
pure def instantRead(fieldsReal: bool, carriesOffset: bool, wallTimeIsOneInstant: bool): InstantRead =
  if (not(fieldsReal)) InstantUnreal
  else if (carriesOffset) InstantAsSent
  else if (wallTimeIsOneInstant) InstantInWallZone
  else InstantRefused
pure def wallZone(wholeDay: bool, creating: bool, zoneSent: bool, sentZoneMovesIt: bool, ownerNamedIt: bool): WallZone =
  if (wholeDay) WallAsCivilDate
  else if (not(creating)) WallInRequestZone
  else if (not(zoneSent) or not(sentZoneMovesIt)) WallInContextZone
  else if (ownerNamedIt) WallInNamedZone
  else WallZoneUnsaid
pure def lawAnUnrealTimeIsNeverRead(carriesOffset: bool, wallTimeIsOneInstant: bool): bool =
  instantRead(false, carriesOffset, wallTimeIsOneInstant) == InstantUnreal
pure def lawAnOffsetIsUsedAsSent(wallTimeIsOneInstant: bool): bool =
  instantRead(true, true, wallTimeIsOneInstant) == InstantAsSent
pure def lawASkippedOrRepeatedWallTimeIsRefused(fieldsReal: bool): bool =
  fieldsReal implies instantRead(fieldsReal, false, false) == InstantRefused
pure def lawTwentyFourIsOnlyMidnight(clockMinute: int, clockSecond: int): bool =
  clockReal(24, clockMinute, clockSecond) iff (clockMinute == 0 and clockSecond == 0)
pure def lawAWholeDayIsItsCivilDate(creating: bool, zoneSent: bool, sentZoneMovesIt: bool, ownerNamedIt: bool): bool =
  wallZone(true, creating, zoneSent, sentZoneMovesIt, ownerNamedIt) == WallAsCivilDate
pure def lawAZoneTheOwnerDidNotNameNeverMovesANewEvent(zoneSent: bool, sentZoneMovesIt: bool): bool =
  wallZone(false, true, zoneSent, sentZoneMovesIt, false) != WallInNamedZone
pure def lawANewEventIsNeverMovedSilently(ownerNamedIt: bool): bool =
  wallZone(false, true, true, true, ownerNamedIt) != WallInContextZone
pure val clockHourValues = Set(0, 23, 24, 25)
pure val clockMinuteValues = Set(0, 1, 59, 60)
pure val clockSecondValues = Set(0, 1, 59, 60)
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

### A clock time the owner stated is one the owner's words hold

A create or change through the Calendar action carries the times the
model read from the owner's request, and says which clock times the owner
stated: the start, the start and the end, or none. Code reads no day or
time from the words; it checks each new clock time against them instead.
A time is held by the owner's words when they write it in digits ("1:10
pm", "13:10", "4"), spell it with its minutes ("one ten PM", "one oh five
pm", "six PM"), or say noon, midnight, or half past, a quarter past or a
quarter to the hour; written with am or pm, it is that half of the day
only. The "am" of "am I" and "I am" ("between 2 and 4, am I free?") is
the verb, no half of the day; an "am" written onto its number ("9am I
think") is still the morning. A time the words hold is kept. A time the
words do not hold is kept only when the model says the owner stated no
clock time ("tomorrow afternoon", "push it back an hour"): a time the
model chose is no misread,
and a check of every time would refuse those requests. A time the words
do not hold that the model calls stated, or sent without saying which,
changes nothing, and the result tells the model which time it sent, so it
sends the time the owner said or says that the owner gave none; so a
misread is never saved only because the model left the choice out. An
end is checked only when the model says the owner stated the range: an end
the model worked out from a length ("move my 3pm to 4", an hour later) is
no clock time the owner said. A start or end a change keeps, and an
all-day event's day, are not checked. A new phone event's start is always one the owner stated, so it
is always checked; a change after a shared phone read is a review on the
phone that shows the new time before anything changes, and is not
checked against the words.

```quint
type StatedClockCheck = ClockAsSent | ClockUnsaid | ClockUndeclared
pure def statedClockCheck(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): StatedClockCheck =
  if (heldByOwnerWords) ClockAsSent
  else if (not(declared)) ClockUndeclared
  else if (statedByOwner) ClockUnsaid
  else ClockAsSent
pure def lawAStatedClockTheWordsDoNotHoldChangesNothing(heldByOwnerWords: bool): bool =
  (statedClockCheck(true, true, heldByOwnerWords) == ClockUnsaid) iff not(heldByOwnerWords)
pure def lawAnOpenTimeIsKept(heldByOwnerWords: bool): bool = statedClockCheck(true, false, heldByOwnerWords) == ClockAsSent
pure def lawAHeldTimeIsKept(declared: bool, statedByOwner: bool): bool = statedClockCheck(declared, statedByOwner, true) == ClockAsSent
pure def lawAnUndeclaredUnheldTimeChangesNothing(statedByOwner: bool): bool =
  statedClockCheck(false, statedByOwner, false) == ClockUndeclared
```

### A free-time window's clock times the owner stated are ones the owner's words hold

A free-time question through the Calendar action says, as a create does,
which of its window's clock times the owner stated: the start, the start
and the end, or none. An owner who names the window ("between noon and
five", "from 2 to 4", "from one ten PM to two PM") states its start and
its end. Each stated clock time is checked against the owner's words as a
new event's is: one the words hold is read, and one they do not hold reads
nothing, and the result names the time sent so the model sends the window
the owner said. A window the model did not call stated, or called none, is
read as asked: a window the model chose ("tomorrow afternoon", "is
Wednesday free?") holds no clock time the owner said. A window's start
within the current minute is not checked: a window already under way
starts at the current time, which the result of a window that starts
before now asks for ("between noon and five today" at 1 PM starts at 1
PM), and that start is no clock time the owner said; its end is still
checked. Only the Calendar action's free-time questions send a window;
their story is "Ask when I am free and get openings from my real
calendar" in actions.md.

```quint
pure def windowClockCheck(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): StatedClockCheck =
  if (declared) statedClockCheck(true, statedByOwner, heldByOwnerWords) else ClockAsSent
pure def windowStartChecked(startsThisMinute: bool): bool = not(startsThisMinute)
pure def lawAWindowStartAtNowIsNotChecked(startsThisMinute: bool): bool = windowStartChecked(startsThisMinute) iff not(startsThisMinute)
pure def lawAStatedWindowClockTheWordsDoNotHoldReadsNothing(heldByOwnerWords: bool): bool =
  (windowClockCheck(true, true, heldByOwnerWords) == ClockUnsaid) iff not(heldByOwnerWords)
pure def lawAnUndeclaredWindowIsReadAsAsked(statedByOwner: bool, heldByOwnerWords: bool): bool =
  windowClockCheck(false, statedByOwner, heldByOwnerWords) == ClockAsSent
pure def lawAWindowCheckNeverAsksForADeclaration(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): bool =
  windowClockCheck(declared, statedByOwner, heldByOwnerWords) != ClockUndeclared
```

### A stated window is read only when the owner's words fit it one way on its day

A free-time window the model calls a stated range is read only when the
owner's words fit it one way on its day and that way is the window sent.
Code finds every range in the owner's words: clock words for the start
and for the end, joined by "and" after "between", or by "to", "until",
"till", "through" or a dash ("between noon and five", "from 2 to 4 PM",
"2pm-4pm"); the "to" of "quarter to" joins nothing, a dash inside a
spoken clock ("between noon and five-thirty", "from one-twenty-five to
three PM", "five-oh-five") is part of the clock and joins nothing, while
one between two hour names ("nine-ten") joins a range, a hedge before a
clock ("between noon and around 5", "from noon till about five") leaves
the range a range, and a range followed by a unit of length ("30 to 45
minutes", "1 to 2 hours") is a length, no range. It reads each range's
start only from the clock words before its join and its end only from
those after it, so a date or a length elsewhere in the request ("on the
12th", "find me 12 minutes", "1 to 2 hours") adds no reading. Only a
range one of whose sides holds the window's start or its end, in either
half of the day, is the window's range: another number range in the
request ("can 3 to 6 of us meet between noon and around 5?") is not
paired. In each range it takes each reading of the window's start and of
its end, in either half of the day, that its side holds, and pairs them
where the end comes after the start on that day. A reading of the start
by the current minute counts only while the window from it to its
nearest end reading is under way, and then from the current minute (a
free-time window starts no earlier than the current minute: actions.md,
"A free-time window starts no earlier than the current minute"): "from 2
to 4 today" asked at 11 AM fits only 2 to 4 PM, and "from 9 to 11 today"
asked at 10 AM fits 10 to 11 AM, 10 AM to 11 PM, or 9 to 11 PM. A window
whose start is the current minute is under way: its start is the one
sent, which is not checked against the owner's words, and pairs with the
end only when a range's start side holds a reading by now whose window is
under way, so "between 1 and 5 today" at 1 PM is 1 to 5 PM, and "between
3 and 5 today" sent from 1 PM fits no way. When one side holds a single
reading, the other side takes the reading nearest it, so the window fits
at most one way: "from 2 to 4 PM" is 2 to 4 PM, and "from 9 AM to 11" is
9 to 11 AM. "Between noon and five" and "from one ten PM to two PM" fit
one way and are read. A range that fits the window sent one way settles
it, whatever another range fits ("can 2 to 4 people meet from 2 to 4
PM?"). Bare hours on both sides that fit more than one way ("from 2 to 4"
tomorrow: 2 to 4 AM, 2 AM to 4 PM, or 2 to 4 PM) read nothing, and the
result lists each pairing, so the model asks the owner which one they
mean or, when the conversation already settles it, sends that window as
one it read (statedClock none). A window the words fit one other way
("from 2 to 4 PM" sent as 2 AM to 4 PM) reads nothing, and the result
names the window that fits and the time sent on the side that differs, so
the model sends it. A window whose range fits it no way ("find me 12
minutes between 2 and 4" sent from noon) reads nothing, and the result
names the request's ranges, so the model sends the window the owner
stated. A window that runs past midnight, one whose request holds no
range of its start or end, and one the model did not call a stated range,
are not paired.

```quint
type WindowPairing = PairingSettled | PairingOpen | PairingOther | PairingNone
pure def windowPairing(statedRange: bool, sameDay: bool, rangeInWords: bool, pairings: int, sentFits: bool): WindowPairing =
  if (not(statedRange and sameDay and rangeInWords)) PairingSettled
  else if (pairings == 0) PairingNone
  else if (pairings > 1) PairingOpen
  else if (sentFits) PairingSettled
  else PairingOther
pure def windowFits(startReadings: int, endReadings: int, pairings: int): int =
  if ((startReadings == 1 or endReadings == 1) and pairings > 1) 1 else pairings
pure def lawAWindowTheWordsFitMoreThanOneWayReadsNothing(pairings: int, sentFits: bool): bool =
  (windowPairing(true, true, true, pairings, sentFits) == PairingOpen) iff pairings > 1
pure def lawAWindowTheWordsFitAnotherWayReadsNothing(sentFits: bool): bool =
  (windowPairing(true, true, true, 1, sentFits) == PairingOther) iff not(sentFits)
pure def lawAWindowItsRangeFitsNoWayReadsNothing(sentFits: bool): bool =
  windowPairing(true, true, true, 0, sentFits) == PairingNone
pure def lawAnUnstatedWindowIsNotPaired(sameDay: bool, rangeInWords: bool, pairings: int, sentFits: bool): bool =
  windowPairing(false, sameDay, rangeInWords, pairings, sentFits) == PairingSettled
pure def lawAWindowPastMidnightIsNotPaired(statedRange: bool, rangeInWords: bool, pairings: int, sentFits: bool): bool =
  windowPairing(statedRange, false, rangeInWords, pairings, sentFits) == PairingSettled
pure def lawAWindowWithoutARangeIsNotPaired(statedRange: bool, sameDay: bool, pairings: int, sentFits: bool): bool =
  windowPairing(statedRange, sameDay, false, pairings, sentFits) == PairingSettled
pure def lawASideWithOneReadingFitsOneWay(readings: int, pairings: int): bool =
  windowFits(1, readings, pairings) <= 1 and windowFits(readings, 1, pairings) <= 1
pure def lawBareSidesKeepEveryFit(pairings: int): bool = windowFits(2, 2, pairings) == pairings
type StartReading = StartAsSaid | StartUnderWay | StartPassed
pure def startReading(byThisMinute: bool, nearestEndAhead: bool): StartReading =
  if (not(byThisMinute)) StartAsSaid else if (nearestEndAhead) StartUnderWay else StartPassed
pure def lawALaterStartReadingIsReadAsSaid(nearestEndAhead: bool): bool = startReading(false, nearestEndAhead) == StartAsSaid
pure def lawAStartReadingByNowCountsOnlyWhileUnderWay(nearestEndAhead: bool): bool =
  (startReading(true, nearestEndAhead) == StartUnderWay) iff nearestEndAhead
pure def lawAStartReadingIsNeverPassedAfterNow(byThisMinute: bool, nearestEndAhead: bool): bool =
  startReading(byThisMinute, nearestEndAhead) == StartPassed implies byThisMinute
pure val pairingsValues = Set(0, 1, 2, 3)
pure val readingsValues = Set(0, 1, 2)
```

### A stated year wins, a wrong extracted year is corrected, and a past start asks first

When a create's request names a date or a year, the year comes from the
owner's words, never from the year the extractor guessed: a trailing
year wins. Otherwise "next year" chooses the coming year, and so does
"next" before a month or a date that is not later than today, as in
"next March 3" said in June or "next November" said in November. A
stated numeric year comes next, and a date with no year or "this year"
chooses the current year. "next" before anything else is no year cue:
"next Friday on March 3" names March 3 of the current year. A year named
before the month or a numeric date counts the same way: "2027년" and
"2027年" state 2027, "내년" and "明年" say next year, and "올해" and
"今年" say this year. A marker inside a longer word or number, as in
"국내년" or "12027년", is no cue. A create that names neither a date
nor a year, as "tomorrow" or "next Friday", keeps the date the extractor
resolved from those words. The wall clock and duration stay as
extracted, and only the year moves. A start that is already past in the
create's zone must be confirmed by the owner before anything is stored;
a future start is ready.

```quint
type YearCue = NoYearCue | ThisYearCue | NextYearCue | StatedYearCue
pure def correctedYear(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int): int =
  if (trailingYear > 0) trailingYear
  else if (cue == StatedYearCue) statedYear
  else if (cue == NextYearCue) currentYear + 1
  else currentYear
pure def nextMeansNextYear(namesNextYear: bool, nextNamesDate: bool, datePassed: bool): bool =
  namesNextYear or (nextNamesDate and datePassed)
pure def yearCueFrom(saysNextYear: bool, statesYear: bool, saysThisYear: bool): YearCue =
  if (saysNextYear) NextYearCue else if (statesYear) StatedYearCue else if (saysThisYear) ThisYearCue else NoYearCue
pure def yearCorrectionApplies(cue: YearCue, trailingYear: int, namesDate: bool): bool =
  cue != NoYearCue or trailingYear > 0 or namesDate
pure def createStartYear(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int, namesDate: bool, extractedYear: int): int =
  if (yearCorrectionApplies(cue, trailingYear, namesDate)) correctedYear(cue, statedYear, trailingYear, currentYear) else extractedYear
pure def mustAskBeforeCreate(startYear: int, currentYear: int, dayPassed: bool): bool =
  startYear < currentYear or (startYear == currentYear and dayPassed)
pure def lawTrailingYearWins(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int): bool =
  trailingYear > 0 implies correctedYear(cue, statedYear, trailingYear, currentYear) == trailingYear
pure def lawYearlessUsesCurrentYear(statedYear: int, currentYear: int): bool =
  correctedYear(NoYearCue, statedYear, 0, currentYear) == currentYear
pure def lawNextWeekdayIsNoYearCue(datePassed: bool): bool =
  not(nextMeansNextYear(false, false, datePassed))
pure def lawNextUpcomingDateKeepsYear(namesNextYear: bool): bool =
  nextMeansNextYear(namesNextYear, true, false) == namesNextYear
pure def lawDatedCreateIgnoresExtractedYear(cue: YearCue, statedYear: int, trailingYear: int, currentYear: int, extractedYear: int): bool =
  createStartYear(cue, statedYear, trailingYear, currentYear, true, extractedYear) == correctedYear(cue, statedYear, trailingYear, currentYear)
pure def lawUndatedCreateKeepsExtractedYear(statedYear: int, currentYear: int, extractedYear: int): bool =
  createStartYear(NoYearCue, statedYear, 0, currentYear, false, extractedYear) == extractedYear
pure def lawFutureStartIsReady(startYear: int, currentYear: int, dayPassed: bool): bool =
  (startYear > currentYear or (startYear == currentYear and not(dayPassed))) implies not(mustAskBeforeCreate(startYear, currentYear, dayPassed))
pure val statedYearValues = Set(2026, 2027, 2028)
pure val currentYearValues = Set(2026)
pure val trailingYearValues = Set(0, 2028)
pure val startYearValues = Set(2025, 2026, 2027)
pure val extractedYearValues = Set(2025, 2026, 2030, 2031)
```
