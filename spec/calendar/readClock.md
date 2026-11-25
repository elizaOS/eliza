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
digits ("1:10 pm", "13:10", "4"), spell it with its minutes ("one ten
PM", "one oh five pm", "six PM"), or say noon, midnight, or half past, a
quarter past or a quarter to the hour; written with am or pm, it is that
half of the day only. These are the spellings the check has always
read, and the words hold every time they held with them, so no create
or change is refused that was saved before.

The words also hold a time in a spelling the free-time reader knows
(next section): four digits ("0900", "1730"), an hour and its minutes as
two numbers ("14 30"), an hour and "h" ("14h30", "09h15"), noon or
midnight after twelve ("12:00 noon", "twelve o'clock noon", "12
midnight"), minutes counted past, after, to, of, till, til or before the
hour in words or digits ("ten past nine", "10 past 9", "twenty minutes
past two", "ten after nine", "twenty to three", "quarter of five", "ten
till six", "5 til 4", "ten before six"), "quarter after", "half 5" for
5:30, or "ish" ("noonish"). These only add times the words hold, so they
turn a refusal into a save only where the owner's words spell the time
sent. An hour and its minutes with a dot past 12:59 or with a leading
zero ("14.30", "09.30") hold nothing more than before, since a price, a
version, a setting or a day and month reads the same way ("sell at
14.50", "upgrade to 22.04", "set the thermostat to 21.30", "move the
review to 14.11"); "2.30" holds 2:30 as always. A further spelling holds
nothing where it could be a misread:

- Beside another number. Words that hold any other number, in digits
  or as a number word ("2", "7pm", "10:30", "4521", "AA 2245", "three",
  "half", "quarter", "dozen", noon, midnight, o'clock, or a sum with a
  currency sign), other than the other end of the same range right
  after or before a join ("standup from 0930 until noon", "block from
  1400 to 4pm"), hold no time in a further spelling, since the owner's
  clock time may be that one and the further spelling a price, a code,
  a version, a room, a page, a score, a year or an address: "pay the
  $14.30 invoice tomorrow at 2", "upgrade to node 22.11 tomorrow at
  4pm", "book room 15, 30 people, tomorrow at 3", "rematch tomorrow at
  6pm after the 21-15 loss", "meet tomorrow at 2240 and 5th at noon",
  "pick up from 1745 to 1747 Oak Street tomorrow at 3", "bake 5 past 6
  batches tomorrow at 2pm", "call tomorrow at 0930, pin 4521", "flight
  tomorrow at 0715, AA 2245", "raise the limit at 1500 tomorrow, 4
  o'clock" and "talk about 2030 goals tomorrow at 0930" hold no time from
  their further spellings. A written date ("3/5/2030", "March 5") and
  an ordinal ("5th") are no number here.
- Without a word that leads a clock, or where a count goes on. Minutes
  counted to the hour are a clock only right after "at", "by",
  "before", "after", "around" or "about" ("call at twenty to five"),
  since after "from" or "between", or alone, they may be a range
  ("coffee tomorrow from 10 to 6" or "coffee tomorrow 10 to 6" holds no
  5:50 PM), and after "to", "till" or "until" they may be a count
  ("pitch count up to 20 after 6 innings"). Minutes counted past or
  after the hour, and "half 5", are a clock only right after those
  words, "from" or "between" ("dinner at half 7", "call tomorrow at ten
  past four pm"); "buy half 3 dozen eggs", "we need 10 after 2 people
  leave", "run until 10 after 6 laps" and "reduce to half 2 cups" hold
  none. A counted spelling also holds only where the clause, a comma or
  the words end after it, or the next word is am, pm, o'clock, a day
  ("tomorrow", a weekday, a written date, or "on", "this" or "next"
  before one), "in the" before a part of the day, or a join before an
  hour ("half 3 till 4"): "bake at 5 past 6 batches" holds none.
- Digits alone. Four digits, or an hour and minutes as two numbers, are
  a clock only right after "at", or as the start of a range right after
  "from" or "between" whose other end, after the join, is itself a
  clock (noon, midnight, a time with a colon, a number with am or pm,
  or four digits that end a clock), or as the end of a range right after
  the join from such a start. After "at" or as a range's end they hold
  only where the sentence ends after them (a full stop, "!", "?", or the
  end of the words; a comma, a semicolon or a bracket is no end) or the
  next word is am or pm, or "on" before a day, or "this" or "next"
  before a day or a part of the day: "lunch tomorrow at 1230." holds
  12:30 PM, "standup at 0930 on Tuesday" 9:30 AM, "standup from 0930
  until noon" 9:30 AM and "from 0900 to 1100." both ends. A day word
  right after four digits is no clock end, since a code, a limit, a bid
  or an amount reads the same way ("change the door code to 1234
  tonight", "buy gold at 2345 tomorrow", "cap the ad spend at 1200
  tomorrow" hold none), nor is a name or another number ("lunch
  tomorrow at 1230 Broadway", "meet tomorrow at 1430 on 3rd Ave", "pick
  up the keys from 1230, Oak Street, tomorrow" and "call 0800 123 456
  tomorrow at 3" hold no time from their digits). "To", "until",
  "about" or "after" alone lead no digits ("raise the limit to 1500",
  "lecture about 1815", "bowling tomorrow, target up to 1230"). Two
  numbers that a comma or a dash splits are no clock ("Unit 14, 30 Main
  Street"). Four digits from 1900 to 2199 read as a year and are never a
  clock ("move the call from 2014 to 2016", "file taxes at 2025
  tomorrow", "Dinner tomorrow at 2045." and "review the 2030 plan" hold
  no time from them), since the year reader below takes them as the
  event's year. A number with a currency sign ("$14.30", "18.30€"), and
  a day and month that a dot closes ("on 14.11."), are no clock.
- As one end beside the other. When a further spelling alone holds a
  range's start, the end the model calls stated holds only in the words
  apart from that spelling and after it: "call at twenty to five
  tomorrow" states no end at 5:00, and "dinner at half 7 tomorrow" none
  at 7:00 PM. When the words hold the start as before and only a
  further spelling holds the end, that spelling holds the end only
  after other words that spell the start: "call at ten past 4 until 5
  tomorrow" states no end at 4:10 PM beside a 4:00 PM start, nor at
  4:10 PM beside a 5:00 PM start, and "coffee at half 3 till 4" none at
  3:30 beside a 3:00 start. A range that a further spelling holds at
  either end also ends less than twelve hours after it starts, since
  the words then give no half of the day for both ends: "call at ten
  past 4 until 5 tomorrow" holds 4:10 to 5:00, AM or PM, and not 4:10
  AM to 5:00 PM. A range whose ends the words hold as before is checked
  as before.

So every time held before is still held, except a range's end beside a
start that only a further spelling holds, where the start was refused
before; no create or change is refused that was saved before, and a
further spelling that saves a create saves it at the time it spells.
Words the reader cannot read hold only what these spellings find in
them, as before: "明天下午3点开会" holds no clock time, so a stated time
sent for it is refused whatever time it is.

A time the words hold is kept. A time the words do not hold is kept
only when the model says the owner stated no clock time ("tomorrow
afternoon", "push it back an hour"): a time the model chose is no
misread, and a check of every time would refuse those requests. A time
the words do not hold that the model calls stated, or sent without
saying which, changes nothing, and the result tells the model which time
it sent, so it sends the time the owner said or says that the owner gave
none; so a misread is never saved only because the model left the
choice out. An end is checked only when the model says the owner stated
the range: an end the model worked out from a length ("move my 3pm to
4", an hour later) is no clock time the owner said. A start or end a
change keeps, and an all-day event's day, are not checked. A new phone
event's start is always one the owner stated, so it is always checked;
a change after a shared phone read is a review on the phone that shows
the new time before anything changes, and is not checked against the
words. A free-time window's clock times are never checked: the words
only add a note to its answer (next section). The note asks only
whether the words spell a clock anywhere: it keeps the lead word for
minutes counted to the hour and the lead word and clause end for four
digits, and none of the other guards above, so a guard that keeps a
misread from being saved never adds a note.

```quint
type StatedClockCheck = ClockAsSent | ClockUnsaid | ClockUndeclared
pure def statedClockCheck(declared: bool, statedByOwner: bool, heldByOwnerWords: bool): StatedClockCheck =
  if (heldByOwnerWords) ClockAsSent
  else if (not(declared)) ClockUndeclared
  else if (statedByOwner) ClockUnsaid
  else ClockAsSent
pure def clockHeld(heldAsBefore: bool, heldInFurtherSpelling: bool): bool = heldAsBefore or heldInFurtherSpelling
pure def furtherSpellingHolds(spelled: bool, anotherNumberStated: bool, standsAsAClock: bool): bool =
  spelled and not(anotherNumberStated) and standsAsAClock
pure def countedStandsAsAClock(afterALead: bool, endWhereAClockEnds: bool): bool = afterALead and endWhereAClockEnds
pure def digitsStandAsAClock(afterAt: bool, opensARangeToAClock: bool, closesARangeFromAClock: bool, endWhereAClockEnds: bool, readAsAYear: bool, dottedOrSplit: bool): bool =
  not(readAsAYear) and not(dottedOrSplit) and (opensARangeToAClock or ((afterAt or closesARangeFromAClock) and endWhereAClockEnds))
pure def rangeEndHeld(startHeldOnlyInAFurtherSpelling: bool, endHeldAsBefore: bool, endHeldInAFurtherSpellingAfterTheStart: bool, endHeldAfterTheStartApartFromIt: bool, underHalfADay: bool): bool =
  if (startHeldOnlyInAFurtherSpelling) endHeldAfterTheStartApartFromIt and underHalfADay
  else endHeldAsBefore or (endHeldInAFurtherSpellingAfterTheStart and underHalfADay)
pure def lawAFurtherSpellingBesideAnotherNumberHoldsNothing(spelled: bool, standsAsAClock: bool): bool =
  not(furtherSpellingHolds(spelled, true, standsAsAClock))
pure def lawAFurtherSpellingHoldsOnlyWhereItStandsAsAClock(spelled: bool, anotherNumberStated: bool): bool =
  not(furtherSpellingHolds(spelled, anotherNumberStated, false))
pure def lawCountedMinutesNeedALeadAndAClockEnd(afterALead: bool, endWhereAClockEnds: bool): bool =
  countedStandsAsAClock(afterALead, endWhereAClockEnds) iff (afterALead and endWhereAClockEnds)
pure def lawDigitsThatReadAsAYearAreNoClock(afterAt: bool, opensARangeToAClock: bool, closesARangeFromAClock: bool, endWhereAClockEnds: bool, dottedOrSplit: bool): bool =
  not(digitsStandAsAClock(afterAt, opensARangeToAClock, closesARangeFromAClock, endWhereAClockEnds, true, dottedOrSplit))
pure def lawDottedOrSplitDigitsAreNoClock(afterAt: bool, opensARangeToAClock: bool, closesARangeFromAClock: bool, endWhereAClockEnds: bool, readAsAYear: bool): bool =
  not(digitsStandAsAClock(afterAt, opensARangeToAClock, closesARangeFromAClock, endWhereAClockEnds, readAsAYear, true))
pure def lawDigitsNeedAtOrARangeToAClock(afterAt: bool, opensARangeToAClock: bool, closesARangeFromAClock: bool, endWhereAClockEnds: bool, readAsAYear: bool, dottedOrSplit: bool): bool =
  digitsStandAsAClock(afterAt, opensARangeToAClock, closesARangeFromAClock, endWhereAClockEnds, readAsAYear, dottedOrSplit)
    implies (opensARangeToAClock or ((afterAt or closesARangeFromAClock) and endWhereAClockEnds))
pure def lawAnEndHeldBeforeIsHeldBesideAStartHeldBefore(endHeldInAFurtherSpellingAfterTheStart: bool, endHeldAfterTheStartApartFromIt: bool, underHalfADay: bool): bool =
  rangeEndHeld(false, true, endHeldInAFurtherSpellingAfterTheStart, endHeldAfterTheStartApartFromIt, underHalfADay)
pure def lawAnEndIsCheckedAsBeforeBesideAStartHeldBefore(endHeldAsBefore: bool, endHeldAfterTheStartApartFromIt: bool, underHalfADay: bool): bool =
  rangeEndHeld(false, endHeldAsBefore, false, endHeldAfterTheStartApartFromIt, underHalfADay) == endHeldAsBefore
pure def lawAnEndBesideAFurtherStartIsHeldApartFromIt(endHeldAsBefore: bool, endHeldInAFurtherSpellingAfterTheStart: bool, endHeldAfterTheStartApartFromIt: bool, underHalfADay: bool): bool =
  rangeEndHeld(true, endHeldAsBefore, endHeldInAFurtherSpellingAfterTheStart, endHeldAfterTheStartApartFromIt, underHalfADay) implies endHeldAfterTheStartApartFromIt
pure def lawARangeAFurtherSpellingHoldsLastsUnderHalfADay(startHeldOnlyInAFurtherSpelling: bool, endHeldAsBefore: bool, endHeldInAFurtherSpellingAfterTheStart: bool, endHeldAfterTheStartApartFromIt: bool): bool =
  rangeEndHeld(startHeldOnlyInAFurtherSpelling, endHeldAsBefore, endHeldInAFurtherSpellingAfterTheStart, endHeldAfterTheStartApartFromIt, false)
    implies (not(startHeldOnlyInAFurtherSpelling) and endHeldAsBefore)
pure def lawAStatedClockTheWordsDoNotHoldChangesNothing(heldByOwnerWords: bool): bool =
  (statedClockCheck(true, true, heldByOwnerWords) == ClockUnsaid) iff not(heldByOwnerWords)
pure def lawAnOpenTimeIsKept(heldByOwnerWords: bool): bool = statedClockCheck(true, false, heldByOwnerWords) == ClockAsSent
pure def lawAHeldTimeIsKept(declared: bool, statedByOwner: bool): bool = statedClockCheck(declared, statedByOwner, true) == ClockAsSent
pure def lawAnUndeclaredUnheldTimeChangesNothing(statedByOwner: bool): bool =
  statedClockCheck(false, statedByOwner, false) == ClockUndeclared
pure def lawEveryTimeHeldBeforeIsStillHeld(heldInFurtherSpelling: bool): bool = clockHeld(true, heldInFurtherSpelling)
pure def lawACreateIsRefusedOnlyWhereItWasBefore(declared: bool, statedByOwner: bool, heldAsBefore: bool, heldInFurtherSpelling: bool): bool =
  statedClockCheck(declared, statedByOwner, clockHeld(heldAsBefore, heldInFurtherSpelling)) != ClockAsSent
    implies statedClockCheck(declared, statedByOwner, heldAsBefore) == statedClockCheck(declared, statedByOwner, clockHeld(heldAsBefore, heldInFurtherSpelling))
```

### The owner's words are read for a free-time window only to note one they seem to give otherwise

A free-time question (actions.md, "Story: Ask when I am free and get
openings from my real calendar") reads the window the model sent,
exactly as sent, whatever the owner's words say: free-text clock words
are open-ended, and a check that refuses on what a reader makes of them
refuses windows the owner did ask for. Code reads the words only to add
a short note to the answer when, read with confidence, they seem to give
another window, so the model can say so or ask; the note never refuses,
never changes the window read, and is left out whenever the reader is
unsure (actions.md, "A free-time question refuses only as before the
window notes, and a note never changes the window read").

The reader sets aside written dates ("Nov 25", "11/25", "25/11",
"2026-11-25", "25.11.2026", "the 25th"), hedges ("around", "about",
"like", "maybe", "-ish", "uh"), and the punctuation that ends a phrase
("Dec 3, 2 to 4 pm"). It reads a range as a run of clock words joined by
"to", "until", "till", "through", "thru" or a dash, or by "and" after
"between" ("between noon and five", "from 2 to 4 PM", "2pm-4pm", "from
0900 to 1100", "14.30-16.00"). A run is split at one of its joins into a
start side and an end side; a split counts when each side is, whole, one
clock's spelling followed at most by that clock's half of the day, and
some end reading comes after some start reading. So a dash or "to"
inside a spoken clock joins nothing ("between noon and five-thirty",
"from quarter to 2 to 4 PM"), "one ten PM" names 1:10 PM, and when more
than one split counts the one at a word join is the range ("from
one-ten to one-thirty PM"), while a dash alone between two hour names
joins them ("nine-ten PM" is 9 to 10 PM). A run that is also, whole, one
clock counted to the hour ("ten to six") is that clock when the window
sent starts at it. A run followed by a unit of length ("30 to 45
minutes", "1-2 hr") or a count of people ("3 to 6 of us") is no range. A
clock after "from", "after", "at", "since", "start", "starts",
"starting", "begin", "begins" or "beginning" states a start, and one
after "until", "till", "til", "through", "thru", "before" or "now to"
states an end. A bare side holds both halves of the day; a side with am
or pm, or the other side's half, holds one.

The reader is unsure, and nothing is noted, for words in another script
or language ("明天下午2点到4点", "de dos a cuatro", "von 15 bis 17 Uhr"),
a number in a shape no clock has ("1.5", "9h15"), a run of clock words no
split reads as one range ("11-25 2-4pm"), a range whose end has an
alternative or a half ("between 2 and 4 or 5", "from 2 to 3 and a
half"), a half of the day said apart from any clock ("9 to 11 am, er
pm"), and words that name a zone other than the request's, or a zone
abbreviation code does not place ("2-4pm ET" asked in Los Angeles,
"9-11am London time"), since the model may have converted the window.

A range is about the window when one of its sides names the hour of the
window's start or end in either half of the day. On the window's day it
fits each pairing of a start reading with a later end reading; when one
side has a single reading, only the pairing nearest it fits, so "from 2
to 4 PM" fits 2 to 4 PM and "from 9 AM to 11" fits 9 to 11 AM. When the
model says the owner asked only about a morning or an afternoon, a
range's fits in that half of the day are its only ones whenever it has
one; a range with no fit is not used. The window sent seems right, and
nothing about its clocks is noted, when a range fits it, or a range fits its end and its start is
the current minute and inside that fit (a period already under way).
Otherwise a side of the window is off when the words do not explain it
and either a clock the words state for that side is the same clock in
the other half of the day ("from 2 to 4 PM" sent from 2 AM), or the
words hold that clock nowhere ("find me 12 minutes between 2 and 4"
sent from 10 AM). A side is explained by a fit of a range about the
window with that start or end, by a start or end the words state outside
that range ("from 2 to 4 pm, until 6 if needed" sent 2 to 6 PM), and a
start by being the current minute. A side the words hold is off only
as the other half of a clock stated for it, so a reading the reader gets
wrong adds no note where the words do say the window sent ("from 2 to
4-4:30" or "2 to 4, maybe 4:30" sent 2 to 4:30 PM). A start or end the
words state with no range is off only as the other half of the clock
they state for it ("am I free at 3pm" sent from 3 AM), since a bare one
may be about something else ("free tomorrow morning? I have a call
until 1").

```quint
pure def windowFits(startReadings: int, endReadings: int, pairings: int): int =
  if ((startReadings == 1 or endReadings == 1) and pairings > 1) 1 else pairings
pure def lawASideWithOneReadingFitsOneWay(readings: int, pairings: int): bool =
  windowFits(1, readings, pairings) <= 1 and windowFits(readings, 1, pairings) <= 1
pure def lawBareSidesKeepEveryFit(pairings: int): bool = windowFits(2, 2, pairings) == pairings
pure val pairingsValues = Set(0, 1, 2, 3)
pure val readingsValues = Set(0, 1, 2)
pure def windowStartChecked(startsThisMinute: bool): bool = not(startsThisMinute)
pure def lawAWindowStartAtNowIsNotChecked(startsThisMinute: bool): bool = windowStartChecked(startsThisMinute) iff not(startsThisMinute)
pure def windowSideOff(explained: bool, otherHalfOfAStatedClock: bool, heldByOwnerWords: bool): bool =
  not(explained) and (otherHalfOfAStatedClock or not(heldByOwnerWords))
pure def lawAnExplainedSideIsNeverOff(otherHalfOfAStatedClock: bool, heldByOwnerWords: bool): bool =
  not(windowSideOff(true, otherHalfOfAStatedClock, heldByOwnerWords))
pure def lawAHeldSideIsOffOnlyInTheOtherHalf(explained: bool): bool = not(windowSideOff(explained, false, true))
pure def lawAnUnexplainedSideTheWordsNeverHoldIsOff(otherHalfOfAStatedClock: bool): bool = windowSideOff(false, otherHalfOfAStatedClock, false)
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
resolved from those words. Four digits that hold the create's stated
start or end only in a further spelling (previous section) are that
clock, never the event's year: the year reader sets them aside, so
"Lunch tomorrow at 1230." with 12:30 PM sent is saved tomorrow at 12:30
PM and "Standup tomorrow at 0930." at 9:30 AM. Since a further spelling
holds nothing beside another number, no other digits are left there for
the year reader to take: "call tomorrow at 0930, pin 4521", "talk about
2030 goals tomorrow at 0930" and "archive the emails from 1999 tomorrow
at 1415" are refused, as before, and never saved in another year. Where the model says the
owner gave no clock time, or the words hold the time as before, the
words are read for a year as always, so a create saved before keeps its
year. The wall clock and duration stay as
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
pure def clockDigitsReadAsYear(clockOpen: bool, digitsHoldTheClockOnlyInAFurtherSpelling: bool): bool =
  clockOpen or not(digitsHoldTheClockOnlyInAFurtherSpelling)
pure def lawDigitsThatHoldAStatedClockAreNoYear(clockOpen: bool): bool =
  clockDigitsReadAsYear(clockOpen, true) == clockOpen
pure def lawOtherDigitsAreReadForAYearAsBefore(clockOpen: bool): bool = clockDigitsReadAsYear(clockOpen, false)
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
