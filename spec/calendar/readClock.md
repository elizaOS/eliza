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
model read from the owner's request, and says which clock times the
owner stated: the start, the start and the end, or none. Code reads no
day or time from the words; it checks each new clock time against them
instead. A time is held by the owner's words when they write it in
digits ("1:10 pm", "13:10", "4", "0900", "1730", "14.30", "2.30 pm",
"14h30", "09h15"),
spell it with its minutes ("one ten PM", "one oh five pm", "six PM"),
say noon or midnight, alone or after twelve ("12:00 noon", "twelve
o'clock noon", "12 midnight"), count minutes past, after, to, of, till, til or before
the hour in words or digits ("ten past nine", "10 past 9", "twenty minutes
past two", "ten after nine", "twenty to three", "10 to 6", "quarter of
five", "ten till six", "5 til 4", "ten before six", half past, a quarter
past, a quarter to or till, and "half 5" for 5:30),
or say it with "ish" ("noonish");
written with am or pm, or with a or p on its number ("10a", "4p"), it is
that half of the day only. The "am" of "I am", of "am I" after a word
that is no clock ("between 2 and 4, am I free?"), and of "am I"
followed by a word about the owner's time ("free", "busy", "available",
"booked", "around") even after a clock ("between 2 and 4 am I free?") is
the verb, no half of the day; an "am" after a clock that "I" and other
words follow ("from 9 to 11 am I need a free hour", "at 9 am I think"),
and one written onto its number ("9am I think"), is still the morning.
Every time the words held before the free-time window checks were added
is still held, save the other half of the day of a number written with a
or p. A time the words hold is kept, and so is a time sent with words
the reader cannot read (an unread clock, as the next sections define
it: "明天下午3点", "a las tres") when the words hold no clock time at all
in a spelling above, since the reader can then tell nothing against it.
Words that hold any clock time contradict a time they do not hold,
however much else in them the reader cannot read, as they did before the
free-time window checks were added: "Lunch with Дмитрий tomorrow at
1pm" sent at 1 AM or 2 PM, "Call Дмитрий tomorrow at quarter to 3" sent
at 3:45 PM, "Sync with my PM tomorrow at 3pm" sent at 4 PM (a "PM" or
"AM" that names a person or a team is no half of the day the reader
can place), "Dentist tomorrow at 3:30pm, 1.5 hrs" sent at 3 PM, "Coffee
with Ana tomorrow at 10:30, 2h" sent at 10, "Run tomorrow 6am 10.5km"
sent at 6 PM, "Termin morgen um 15:30 Uhr" sent at 3 PM and "move
Дмитрий's call to 4:30pm" sent at 4 PM change nothing. A time the words do not hold is kept
only when the model says the owner stated no clock time ("tomorrow
afternoon", "push it back an hour"): a time the model chose is no
misread, and a check of every time would refuse those requests. A time
the words do not hold that the model calls stated, or sent without
saying which, changes nothing, and the result tells the model which
time it sent, so it sends the time the owner said or says that the owner
gave none; so a misread is never saved only because the model left the
choice out. An end is checked only when the model says the owner stated
the range: an end the model worked out from a length ("move my 3pm to
4", an hour later) is no clock time the owner said. A start or end a
change keeps, and an all-day event's day, are not checked. A new phone
event's start is always one the owner stated, so it is always checked;
a change after a shared phone read is a review on the phone that shows
the new time before anything changes, and is not checked against the
words.

```quint
type StatedClockCheck = ClockAsSent | ClockUnsaid | ClockUndeclared
pure def statedClockCheck(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): StatedClockCheck =
  if (heldByOwnerWords) ClockAsSent
  else if (not(declared)) ClockUndeclared
  else if (statedByOwner) ClockUnsaid
  else ClockAsSent
pure def clockHeldOrUnread(wordsRead: bool, heldByOwnerWords: bool, aClockHeld: bool): bool =
  heldByOwnerWords or (not(wordsRead) and not(aClockHeld))
pure def lawAStatedClockTheWordsDoNotHoldChangesNothing(heldByOwnerWords: bool): bool =
  (statedClockCheck(true, true, heldByOwnerWords) == ClockUnsaid) iff not(heldByOwnerWords)
pure def lawAnOpenTimeIsKept(heldByOwnerWords: bool): bool = statedClockCheck(true, false, heldByOwnerWords) == ClockAsSent
pure def lawAHeldTimeIsKept(declared: bool, statedByOwner: bool): bool = statedClockCheck(declared, statedByOwner, true) == ClockAsSent
pure def lawAnUndeclaredUnheldTimeChangesNothing(statedByOwner: bool): bool =
  statedClockCheck(false, statedByOwner, false) == ClockUndeclared
pure def lawWordsTheReaderCannotReadKeepATimeTheyDoNotContradict(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): bool =
  statedClockCheck(declared, statedByOwner, clockHeldOrUnread(false, heldByOwnerWords, false)) == ClockAsSent
pure def lawWordsHoldingAClockRefuseAStatedTimeTheyDoNotHoldHoweverTheyRead(wordsRead: bool): bool =
  statedClockCheck(true, true, clockHeldOrUnread(wordsRead, false, true)) == ClockUnsaid
pure def lawAHeldTimeIsKeptHoweverTheWordsRead(wordsRead: bool, aClockHeld: bool): bool =
  clockHeldOrUnread(wordsRead, true, aClockHeld)
```

### A free-time window's clock times the owner stated are ones the owner's words hold

A free-time question through the Calendar action says, as a create does,
which of its window's clock times the owner stated: the start, the start
and the end, or none. An owner who names the window ("between noon and
five", "from 2 to 4", "from one ten PM to two PM") states its start and
its end. Code checks a window's start only when the owner's words state
a start, and its end only when they state an end and the model calls the
window a stated range: a range in the words (next section) states both;
a clock after "from", "after", "at", "since", "start", "starts",
"starting", "begin", "begins" or "beginning" states a start; one after
"until", "till", "til", "through", "thru", "before" or "now to" states
an end. A stated clock time is checked against the owner's words as a
new event's is, and is held when the words hold it as written or once
the hedges the window reading sets aside (next section) are dropped
("from two uh thirty to four" and "at 2 um 30" hold 2:30), so every
clock the words state is one they hold: one the words hold is read, and one they do not hold
reads nothing, and the result names the time sent so the model sends the
window the owner said, or statedClock none when the model chose it. A
window the model did not call stated, or called none, is read as asked:
a window the model chose ("tomorrow afternoon", "is Wednesday free?")
holds no clock time the owner said. A start or end the words do not
state is no clock time the owner said and is read as sent: "tomorrow
afternoon until 5:30" called a range starts at noon, and "free at 3 for
two hours" called a range ends at 5. Words the reader cannot read state
nothing (section "A window check refuses only a window the owner's words
contradict"). A window's start within the current minute is not checked:
a window already under way starts at the current time, which the result
of a window that starts before now asks for ("between noon and five
today" at 1 PM starts at 1 PM), and that start is no clock time the
owner said; its end is still checked. Only the Calendar action's
free-time questions send a window; their story is "Ask when I am free
and get openings from my real calendar" in actions.md.

```quint
pure def windowClockCheck(declared: bool, statedByOwner: bool, wordsStateIt: bool, heldByOwnerWords: bool): StatedClockCheck =
  if (declared and wordsStateIt) statedClockCheck(true, statedByOwner, heldByOwnerWords) else ClockAsSent
pure def windowClockHeld(heldAsWritten: bool, heldWithoutHedges: bool): bool = heldAsWritten or heldWithoutHedges
pure def lawAClockTheWordsStateIsRead(declared: bool, statedByOwner: bool, heldAsWritten: bool): bool =
  windowClockCheck(declared, statedByOwner, true, windowClockHeld(heldAsWritten, true)) == ClockAsSent
pure def windowStartChecked(startsThisMinute: bool): bool = not(startsThisMinute)
pure def lawAWindowStartAtNowIsNotChecked(startsThisMinute: bool): bool = windowStartChecked(startsThisMinute) iff not(startsThisMinute)
pure def lawAStatedWindowClockTheWordsDoNotHoldReadsNothing(heldByOwnerWords: bool): bool =
  (windowClockCheck(true, true, true, heldByOwnerWords) == ClockUnsaid) iff not(heldByOwnerWords)
pure def lawAnUndeclaredWindowIsReadAsAsked(statedByOwner: bool, wordsStateIt: bool, heldByOwnerWords: bool): bool =
  windowClockCheck(false, statedByOwner, wordsStateIt, heldByOwnerWords) == ClockAsSent
pure def lawAWindowCheckNeverAsksForADeclaration(declared: bool, statedByOwner: bool, wordsStateIt: bool, heldByOwnerWords: bool): bool =
  windowClockCheck(declared, statedByOwner, wordsStateIt, heldByOwnerWords) != ClockUndeclared
pure def lawAClockTheWordsDoNotStateIsReadAsSent(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): bool =
  windowClockCheck(declared, statedByOwner, false, heldByOwnerWords) == ClockAsSent
```

### A stated window is read unless the owner's words fit it only other ways on its day

A free-time window the model calls a stated range is checked against
every range in the owner's words. Code reads a range as a run of clock
words joined by "to", "until", "till", "through", "thru" or a dash, or
by "and" after "between" ("between noon and five", "from 2 to 4 PM",
"2pm-4pm", "from 0900 to 1100", "14.30-16.00"), after it has set aside
written dates ("Nov 25", "11/25", "25/11", "2026-11-25", "25.11.2026",
"the 25th"), hedges ("around", "about", "like", "maybe", "-ish", "uh"),
and the punctuation that ends a phrase ("Dec 3, 2 to 4 pm"). A run is
split at one of its joins into a start side and an end side; a split
counts when each side is, whole, one clock's spelling followed at most by
that clock's half of the day, and some end reading comes after some
start reading. So a dash or "to" inside a spoken clock joins nothing
("between noon and five-thirty", "from one-twenty-five to three PM",
"from quarter to 2 to 4 PM", "from twenty to three till five pm"), "one
ten PM" names 1:10 PM and never 1:00 or 10:00, and a date or a length
elsewhere adds no reading. When more than one split counts, the one at a
word join is the range ("from one-ten to one-thirty PM", "from
twelve-ten to one PM"), while a dash alone between two hour names joins
them ("nine-ten PM" is 9 to 10 PM). A run that splits into a range and
is also, whole, one clock counted to the hour ("ten to six", "10 to 6",
"five to seven", "ten till six", "5 til 4") is that one clock when the window sent starts at it:
"free at ten to six for an hour" or "from ten to six for an hour" sent
from 5:50 PM states that start and no range or end, so its end is read
as sent, as "free at 3 for two hours" is. Sent from any other start, the
run is the range ("from ten to six" sent 10 AM to 6 PM). A run followed by a unit of length,
written whole or short ("30 to 45 minutes", "1-2 hr", "2-3h"), or by a
count of people ("3 to 6 of us", "2 to 4 people", "4-6 people") is no
range. A side whose last word is the "am" of "am I free" holds both
halves of the day.

Only a range one of whose sides names the hour of the window's start or
of its end, in either half of the day, is the window's range: another
number range in the request ("can 3 to 6 of us meet between noon and
around 5?") is not paired. In each such range code pairs each start
reading with each end reading after it on that day; when one side holds
a single reading, the other side takes the reading nearest it, so "from
2 to 4 PM" is 2 to 4 PM and "from 9 AM to 11" is 9 to 11 AM. A start
reading by the current minute counts only while the window from it to
its nearest end reading is under way, and then from the current minute
(actions.md, "A free-time window starts no earlier than the current
minute"): "from 2 to 4 today" asked at 11 AM fits only 2 to 4 PM, and
"from 9 to 11 today" asked at 10 AM fits 10 to 11 AM, 10 AM to 11 PM,
or 9 to 11 PM. A window whose start is the current minute pairs from the
current minute when a range's start reading is under way ("between 1
and 5 today" at 1 PM is 1 to 5 PM); otherwise its range's later
readings are the fits, so "between 3 and 5 today" sent from 1 PM fits 3
to 5 PM. When the model says the owner asked only about a morning or an
afternoon (actions.md, "A morning-only question reads only that
morning, from midnight to noon" and "An afternoon-only question reads
only that afternoon, from noon to five"), a range's pairings inside that
half of the day are its only ones whenever it has one. A window the
owner's words state elsewhere is the range's too: when the window's
start is a fit's start or a start the words state outside this range,
and its end a fit's end or an end they state outside it ("from 2 to 4 pm
tomorrow, until 6 if needed" sent 2 to 6 PM), the range fits it. When
the window sent differs from a fit and its start or end is one the words
state outside the range, the fit the result names takes that stated
start or end, the one nearest that widens it: "from 2 to 4 pm tomorrow,
until 6 if needed" sent 2 AM to 6 PM, or 2 AM to 6 AM, names 2 to 6 PM.

A window that is one of its range's fits is read, however many others
there are: "from 2 to 4" sent as 2 to 4 PM is read, as it was before
these checks. A range that fits the window sent settles it, whatever
another range fits ("can 2 to 4 people meet from 2 to 4 PM?"). A window
its ranges fit one other way ("from 2 to 4 PM" sent as 2 AM to 4 PM)
reads nothing, and the result names the window that fits and the time
sent on the side that differs, so the model sends it. A window its
ranges fit several other ways ("find me 12 minutes between 2 and 4" sent
from noon) reads nothing, and the result lists them, so the model sends
the one the owner means or asks the owner which. A window that runs past
midnight, one whose request holds no such range, one whose range fits
no way, one the model did not call a stated range, and one whose words
the reader cannot read, are not paired and are read as sent.

```quint
type WindowPairing = PairingSettled | PairingOpen | PairingOther
pure def windowPairing(statedRange: bool, sameDay: bool, rangeInWords: bool, wordsRead: bool, pairings: int, sentFits: bool): WindowPairing =
  if (not(statedRange and sameDay and rangeInWords and wordsRead) or pairings == 0 or sentFits) PairingSettled
  else if (pairings > 1) PairingOpen
  else PairingOther
pure def windowFits(startReadings: int, endReadings: int, pairings: int): int =
  if ((startReadings == 1 or endReadings == 1) and pairings > 1) 1 else pairings
pure def lawAWindowTheWordsFitIsRead(pairings: int): bool =
  windowPairing(true, true, true, true, pairings, true) == PairingSettled
pure def lawAWindowTheWordsFitSeveralOtherWaysReadsNothing(pairings: int): bool =
  (windowPairing(true, true, true, true, pairings, false) == PairingOpen) iff pairings > 1
pure def lawAWindowTheWordsFitOneOtherWayReadsNothing(sentFits: bool): bool =
  (windowPairing(true, true, true, true, 1, sentFits) == PairingOther) iff not(sentFits)
pure def lawAWindowItsRangeFitsNoWayIsReadAsSent(sentFits: bool): bool =
  windowPairing(true, true, true, true, 0, sentFits) == PairingSettled
pure def lawAnUnstatedWindowIsNotPaired(sameDay: bool, rangeInWords: bool, wordsRead: bool, pairings: int, sentFits: bool): bool =
  windowPairing(false, sameDay, rangeInWords, wordsRead, pairings, sentFits) == PairingSettled
pure def lawAWindowPastMidnightIsNotPaired(statedRange: bool, rangeInWords: bool, wordsRead: bool, pairings: int, sentFits: bool): bool =
  windowPairing(statedRange, false, rangeInWords, wordsRead, pairings, sentFits) == PairingSettled
pure def lawAWindowWithoutARangeIsNotPaired(statedRange: bool, sameDay: bool, wordsRead: bool, pairings: int, sentFits: bool): bool =
  windowPairing(statedRange, sameDay, false, wordsRead, pairings, sentFits) == PairingSettled
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

### A window check refuses only a window the owner's words contradict

The free-time window checks and the clock-word checks refuse only on a
positive contradiction: the owner's words were read with confidence,
every side of the relevant range reads as a known clock, and that
reading contradicts the window sent. Whatever the reader cannot read
with confidence falls back to reading the window as sent, as free time
did before these checks: another script or language
("明天下午2点到4点", "오후 2시부터 4시까지", "午後2時から4時まで", "de
dos a cuatro", "von 15 bis 17 Uhr"), a number written in a shape no
clock has ("14h30", "1.5"), a run of clock words no split reads as one
range ("11-25 2-4pm", "room 10 2 to 4"), a range whose end has an
alternative ("between 2 and 4 or 5") or a half ("from 2 to 3 and a
half"), a half of the day said apart from any clock, as an owner
correcting it does ("9 to 11 am, er pm", "1 to 3 AM I mean pm"), and a
statement clock no spelling names. For a free-time window such words
hold every time and state no start or end, and their windows are not
paired; a create or change still refuses a time they do not hold when
they hold some clock time (section "A clock time the owner stated is one
the owner's words hold"), and a morning-only window still ends by noon (actions.md, "A
morning-only question reads only that morning, from midnight to
noon"). A
refusal's result always names a window that reads when sent again: the
window a range fits one other way is its fit, or that fit with a start
or end the words state elsewhere, every window listed is a fit, a clock
the words state is one they hold, and a time the words do not hold
reads with statedClock none. So a
window read before these checks is refused only when the owner's words
plainly give another one.

```quint
pure def windowCheckRefuses(clockCheck: StatedClockCheck, pairing: WindowPairing): bool =
  clockCheck != ClockAsSent or pairing != PairingSettled
pure def lawUnreadWordsNeverRefuse(declared: bool, statedByOwner: bool, statedRange: bool, sameDay: bool, rangeInWords: bool, pairings: int, sentFits: bool, heldByOwnerWords: bool): bool =
  not(windowCheckRefuses(windowClockCheck(declared, statedByOwner, false, heldByOwnerWords), windowPairing(statedRange, sameDay, rangeInWords, false, pairings, sentFits)))
pure def lawAFitTheRefusalNamesIsReadWhenSent(pairings: int, sentFits: bool): bool =
  windowPairing(true, true, true, true, pairings, sentFits) != PairingSettled implies windowPairing(true, true, true, true, pairings, true) == PairingSettled
pure def lawAWindowTheWordsStateIsNeverRefused(declared: bool, statedByOwner: bool, wordsStateIt: bool, pairings: int): bool =
  not(windowCheckRefuses(windowClockCheck(declared, statedByOwner, wordsStateIt, true), windowPairing(true, true, true, true, pairings, true)))
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
