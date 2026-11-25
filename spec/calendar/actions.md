# Calendar agent actions

The agent reads and changes the owner's calendars through one Calendar
action. A read answers from the active account's own listed calendars.
A change to the resident calendar runs at once for the owner who asked;
a change to a provider calendar waits for the owner's approval. Both run
through the [mutation ledger](./mutationLedger.md) with exactly the
fields that were reviewed.

## Story: Ask the agent about my calendar and get my active account's events

> As the owner, I want the agent to answer from the account I am using
> now, so that another account's events never appear in its answer.

### An event is shown only from a listed calendar of the active account

An event is part of an answer only when its account is the active
account and its calendar is one the active account lists. An event of
another account, or of a calendar no longer listed, is left out, however
well its title matches.

```quint
pure def eventVisible(eventAccount: str, activeAccount: str, sourceListed: bool): bool =
  eventAccount == activeAccount and sourceListed
pure def lawOtherAccountNeverShown(eventAccount: str, activeAccount: str, sourceListed: bool): bool =
  eventAccount != activeAccount implies not(eventVisible(eventAccount, activeAccount, sourceListed))
pure val eventAccountValues = Set("owner", "other")
pure val activeAccountValues = Set("owner", "other")
```

### The managed Google calendar is read and changed as one of the active account's calendars

When the agent holds the owner's [cloud link](../agent/models/binding.md),
the calendars the Cloud's [managed Google](./managedFeed.md) calendar lists
as readable for each connected Google account are listed calendars of the
account in use, beside the resident calendar. Searches, lookups, free-time
questions, trip questions, the agent's context and the client's feed read
them, through the Cloud for the exact calendar and window. Each answer
lists every calendar it read with whether that read was fresh, held only
kept events (stale), or failed. A Cloud read that fails answers from the
events the last good read of that calendar kept, and the answer is never
complete. A change to one of them waits for the owner's approval like any
provider calendar, goes to Google only at the revision that was read, and
is refused without reaching the Cloud while the owner has calendar edits
turned off. A managed create requires the selected calendar to advertise
support for private visibility with Google default reminders disabled. A
repeating create also requires support for saving the reviewed rules. A
create without the required support is refused before reaching Google.
The agent edits one occurrence at a time, at its reviewed revision. A series
master with its own recurrence rule cannot be the target of an occurrence
edit. It cannot email attendees, answer invitations or delete events. An
agent without the cloud link lists only the resident calendar.

```quint
type ManagedChange = ManagedCreate | ManagedEdit | ManagedDelete | ManagedAnswer
type SourceRead = ReadFresh | ReadStale | ReadFailed
pure def managedChangeAllowed(change: ManagedChange, oneOccurrence: bool, recurringCreate: bool): bool =
  (change == ManagedCreate and (oneOccurrence or recurringCreate)) or (change == ManagedEdit and oneOccurrence)
pure def managedEditTargetAllowed(holdsRules: bool, hasParentSeries: bool): bool = not(holdsRules) or hasParentSeries
pure def sourceRead(answered: bool, complete: bool, keptEvents: bool): SourceRead =
  if (answered and complete) ReadFresh
  else if (answered or keptEvents) ReadStale
  else ReadFailed
pure def lawAManagedDeleteIsRefused(oneOccurrence: bool, recurringCreate: bool): bool = not(managedChangeAllowed(ManagedDelete, oneOccurrence, recurringCreate))
pure def lawAManagedAnswerIsRefused(oneOccurrence: bool, recurringCreate: bool): bool = not(managedChangeAllowed(ManagedAnswer, oneOccurrence, recurringCreate))
pure def lawOnlyAnOfferedCreateSpansASeries(change: ManagedChange, recurringCreate: bool): bool =
  managedChangeAllowed(change, false, recurringCreate) iff (change == ManagedCreate and recurringCreate)
pure def lawAManagedOccurrenceEditDoesNotTargetTheSeriesMaster(holdsRules: bool, hasParentSeries: bool): bool =
  (holdsRules and not(hasParentSeries)) implies not(managedEditTargetAllowed(holdsRules, hasParentSeries))
pure def lawOnlyAnAnsweredCompleteReadIsFresh(answered: bool, complete: bool, keptEvents: bool): bool =
  sourceRead(answered, complete, keptEvents) == ReadFresh iff (answered and complete)
```

### A lookup finds the events that hold the most asked words, preferring their titles

A search, and the lookup that picks the event a change is for, read the
asked words: the query's words without those that name no event ("a",
"the", "my", "with", "at"), or all its words when every one is such a word.
A word is found in an event when its title, notes, place, or a guest's name
or address holds it as written or as its singular or plural
("appointments" finds "appointment"); a word in Han, Hiragana, Katakana or
Hangul script is also found inside a longer word. The whole query found in
one of them finds every asked word. The answer is the events that hold the
most asked words, and among them those whose titles hold the most; an event
that holds none is never part of it. So "my meeting with Sam" finds the
meeting Sam is invited to and not every meeting, and "the Ferry Building"
finds the event held there.

```quint
pure def lookupKeeps(found: int, titleFound: int, bestFound: int, bestTitle: int): bool =
  found > 0 and found == bestFound and titleFound == bestTitle
pure def lawAnEventHoldingNoWordIsNeverFound(titleFound: int, bestFound: int, bestTitle: int): bool =
  not(lookupKeeps(0, titleFound, bestFound, bestTitle))
pure def lawAFullerMatchWins(found: int, titleFound: int, bestFound: int, bestTitle: int): bool =
  found < bestFound implies not(lookupKeeps(found, titleFound, bestFound, bestTitle))
pure def lawATitleMatchWinsATie(found: int, titleFound: int, bestTitle: int): bool =
  titleFound < bestTitle implies not(lookupKeeps(found, titleFound, found, bestTitle))
pure val foundValues = Set(0, 1, 2)
pure val titleFoundValues = Set(0, 1, 2)
pure val bestFoundValues = Set(0, 1, 2)
pure val bestTitleValues = Set(0, 1, 2)
```

### A trip question shows everything from the first event at the place to the end of the last

A trip question (`trip_window`) names the place in its query and reads the
asked range, the next sixty days by default, on the calendar named or on
every listed calendar. The events that hold a word of the place, as a
lookup finds a word, mark the trip; the answer is every event from the
start of the first of them to the end of the last. With none, the answer
says that no trip there was found. A read that was not complete says so.

```quint
pure def tripHolds(eventBegin: int, eventFinish: int, tripStart: int, tripEnd: int): bool = eventFinish >= tripStart and eventBegin <= tripEnd
pure def lawAMarkIsInsideItsTrip(eventBegin: int, eventFinish: int): bool =
  eventBegin <= eventFinish implies tripHolds(eventBegin, eventFinish, eventBegin, eventFinish)
pure def lawAnEventAfterTheTripIsLeftOut(eventBegin: int, eventFinish: int, tripStart: int, tripEnd: int): bool =
  eventBegin > tripEnd implies not(tripHolds(eventBegin, eventFinish, tripStart, tripEnd))
```

### A whole-day read names its first and last day, and code finds the midnights

A search may name whole days in place of instants: `date`, the first
civil day as YYYY-MM-DD, and `endDate`, the last day it includes, which
is the first when left out. The read runs from the midnight that starts
the first day to the midnight that ends the last, in the request's zone,
so a day with a clock change is read whole. A day read that also sends
`timeMin` or `timeMax`, sends `endDate` alone, names a date no calendar
has, ends before it starts or covers more than 370 days is refused before
anything is read. A search that names no day reads its instants as
before.

```quint
type DayRead = ReadAskedWindow | ReadWholeDays | RefuseDayRead
pure val dayReadLimit: int = 370
pure def dayRead(dateSent: bool, endDateSent: bool, datesReal: bool, instantsSent: bool, dayCount: int): DayRead =
  if (not(dateSent) and not(endDateSent)) ReadAskedWindow
  else if (not(dateSent) or instantsSent or not(datesReal) or dayCount < 1 or dayCount > dayReadLimit) RefuseDayRead
  else ReadWholeDays
pure def lawADayReadNeverMixesWithInstants(endDateSent: bool, datesReal: bool, dayCount: int): bool =
  dayRead(true, endDateSent, datesReal, true, dayCount) == RefuseDayRead
pure def lawALastDayNeedsItsFirst(datesReal: bool, instantsSent: bool, dayCount: int): bool =
  dayRead(false, true, datesReal, instantsSent, dayCount) == RefuseDayRead
pure def lawAnUnrealDateIsNeverRead(dateSent: bool, endDateSent: bool, instantsSent: bool, dayCount: int): bool =
  dayRead(dateSent, endDateSent, false, instantsSent, dayCount) != ReadWholeDays
pure def lawWholeDaysAreBounded(dateSent: bool, endDateSent: bool, datesReal: bool, instantsSent: bool, dayCount: int): bool =
  dayRead(dateSent, endDateSent, datesReal, instantsSent, dayCount) == ReadWholeDays implies dayCount >= 1 and dayCount <= dayReadLimit
pure val dayCountValues = Set(0, 1, 370, 371)
```

## Story: Ask when I am free and get openings from my real calendar

> As the owner, I want the agent to tell me whether a whole period is
> free, or to find openings of the length I asked for inside it, from a
> complete read of my calendars and only within the period I named.

### A free-time question reads exactly the asked window and answers only from a complete read

Checking a period (`check_availability`) and finding openings
(`propose_times`) both take the window's start and end, each with an
explicit offset, in the request's zone. The end is after the start and
no later than seven civil days after it in that zone, at the same wall
time. Finding openings also needs the asked length, a whole number of
minutes from 5 to 480, and never guesses a missing one. The read covers
exactly that window, on the calendar named or on every listed calendar
of the active account. When any of them could not be read completely,
availability is unknown: the answer is neither free nor an opening.
Neither question books or changes anything.

```quint
import availability.* from "./availability"
type FreeTimeRead = RefuseWindow | AvailabilityUnknown | AvailabilityKnown
pure def slotMinutesAllowed(minutes: int): bool = minutes >= 5 and minutes <= 480
pure def freeTimeRead(windowValid: bool, durationValid: bool, readComplete: bool): FreeTimeRead =
  if (not(windowValid and durationValid)) RefuseWindow
  else if (not(readComplete)) AvailabilityUnknown
  else AvailabilityKnown
pure def lawIncompleteReadIsUnknown(windowValid: bool, durationValid: bool): bool =
  freeTimeRead(windowValid, durationValid, false) != AvailabilityKnown
pure def lawInvalidWindowIsRefused(durationValid: bool, readComplete: bool): bool =
  freeTimeRead(false, durationValid, readComplete) == RefuseWindow
pure def lawSlotLengthIsBounded(minutes: int): bool =
  slotMinutesAllowed(minutes) implies minutes >= 5 and minutes <= 480
pure val minutesValues = Set(4, 5, 480, 481)
```

### A morning-only question reads only that morning, from midnight to noon

The model reads from the owner's request whether it asks about a morning
and no other period ("am I free tomorrow morning?", "tomorrow morning
until noon"), and says so with the request; code reads no period words.
Such a window starts at or after the midnight of the day it starts on,
and must end no later than that day's noon in the request's zone; a
window that runs past it is refused before anything is read, pointing to
a slot search for a shorter opening. Noon itself is inside the morning.
A request the model does not call morning-only is read as asked.

```quint
type MorningAdmission = ReadMorning | RefuseOutsideMorning
pure def morningAdmission(morningOnly: bool, endsAfterNoon: bool): MorningAdmission =
  if (morningOnly and endsAfterNoon) RefuseOutsideMorning else ReadMorning
pure def lawMorningReadStaysInMorning(endsAfterNoon: bool): bool =
  morningAdmission(true, endsAfterNoon) == ReadMorning implies not(endsAfterNoon)
pure def lawWiderRequestIsRead(endsAfterNoon: bool): bool =
  morningAdmission(false, endsAfterNoon) == ReadMorning
```

### A free-time question refuses only as before the window notes, and a note never changes the window read

A free-time question refuses only for the reasons it always had: a
window or a length it cannot read, a morning-only window that runs past
noon, and a read that is incomplete (sections above). It never refuses
for anything the owner's words seem to say about the window: their clock
times, a range they state, a start already past, or an afternoon the
model said was asked. It reads the window exactly as sent, and its
answer may carry one short note, as text after the answer and as a
typed `windowNote` with a kind, the words it adds to the answer, and for
a range the windows the words fit (readClock.md, "The owner's words are
read for a free-time window only to note one they seem to give
otherwise"):

- the owner's words seem to give another window, when a side of the
  window sent is off (readClock.md): the note names the windows a range
  about the window fits that day, or else the start or end the words
  state;
- the window starts before the current minute: the note says the model
  can start the rest of a period under way at now, and that
  search_events lists what was on earlier;
- the model said the owner asked only about an afternoon, and the window
  starts before noon or ends after 5 PM at a clock the owner's words do
  not hold ("tomorrow afternoon until 5:30" holds its end).

Only one note is given, in that order. Words the reader cannot read with
confidence, or that name a zone other than the request's, carry no note
at all. The model may mention the note to the owner, ask which window
was meant, or ask again with another window; the answer itself stands.

```quint
type WindowNote = NoNote | WordsGiveAnotherWindow | StartsBeforeNow | AfternoonAsked
pure def windowNote(wordsRead: bool, otherZoneNamed: bool, sidesOff: bool, startPassed: bool, afternoonLeft: bool): WindowNote =
  if (not(wordsRead) or otherZoneNamed) NoNote
  else if (sidesOff) WordsGiveAnotherWindow
  else if (startPassed) StartsBeforeNow
  else if (afternoonLeft) AfternoonAsked
  else NoNote
type FreeTimeOutcome = FreeTimeRefusesWindow | FreeTimeRefusesOutsideMorning | FreeTimeUnknown | FreeTimeAnswered
type FreeTimeAnswer = { outcome: FreeTimeOutcome, readStart: int, readEnd: int, note: WindowNote }
pure def freeTimeAnswer(windowValid: bool, durationValid: bool, morning: MorningAdmission, readComplete: bool, sentStart: int, sentEnd: int, note: WindowNote): FreeTimeAnswer = {
  outcome: if (freeTimeRead(windowValid, durationValid, true) == RefuseWindow) FreeTimeRefusesWindow
    else if (morning == RefuseOutsideMorning) FreeTimeRefusesOutsideMorning
    else if (freeTimeRead(windowValid, durationValid, readComplete) != AvailabilityKnown) FreeTimeUnknown
    else FreeTimeAnswered,
  readStart: sentStart,
  readEnd: sentEnd,
  note: note
}
pure def lawFreeTimeNeverRefusesOnWords(windowValid: bool, durationValid: bool, morning: MorningAdmission, readComplete: bool, wordsRead: bool, otherZoneNamed: bool, sidesOff: bool, startPassed: bool, afternoonLeft: bool): bool =
  freeTimeAnswer(windowValid, durationValid, morning, readComplete, 0, 60000, windowNote(wordsRead, otherZoneNamed, sidesOff, startPassed, afternoonLeft)).outcome
    == freeTimeAnswer(windowValid, durationValid, morning, readComplete, 0, 60000, NoNote).outcome
pure def lawFreeTimeRefusesOnlyAsBefore(windowValid: bool, durationValid: bool, morning: MorningAdmission, readComplete: bool, note: WindowNote): bool =
  (freeTimeAnswer(windowValid, durationValid, morning, readComplete, 0, 60000, note).outcome != FreeTimeAnswered)
    iff (not(windowValid and durationValid) or morning == RefuseOutsideMorning or not(readComplete))
pure def lawANoteNeverChangesTheWindowRead(sentStart: int, sentEnd: int, note: WindowNote): bool =
  freeTimeAnswer(true, true, ReadMorning, true, sentStart, sentEnd, note).readStart == sentStart
    and freeTimeAnswer(true, true, ReadMorning, true, sentStart, sentEnd, note).readEnd == sentEnd
pure def lawUnreadWordsCarryNoNote(otherZoneNamed: bool, sidesOff: bool, startPassed: bool, afternoonLeft: bool): bool =
  windowNote(false, otherZoneNamed, sidesOff, startPassed, afternoonLeft) == NoNote
pure def lawAnotherZoneCarriesNoNote(wordsRead: bool, sidesOff: bool, startPassed: bool, afternoonLeft: bool): bool =
  windowNote(wordsRead, true, sidesOff, startPassed, afternoonLeft) == NoNote
pure def lawANoteHasItsReason(wordsRead: bool, otherZoneNamed: bool, sidesOff: bool, startPassed: bool, afternoonLeft: bool): bool =
  windowNote(wordsRead, otherZoneNamed, sidesOff, startPassed, afternoonLeft) != NoNote implies (sidesOff or startPassed or afternoonLeft)
pure val sentStartValues = Set(0, 60000)
pure val sentEndValues = Set(60000, 3600000)
```

### A period is free only when no blocking event overlaps it

An event blocks the time it overlaps with positive length; a zero-length
or adjacent event blocks nothing. A cancelled event, one the owner
declined and one marked free block nothing. A tentative event blocks,
and so does an all-day event, over its civil days in the request's zone.
A period is free exactly when no blocking event overlaps it, and a busy
answer lists the start and end of each blocking event.

```quint
pure def eventBlocks(cancelled: bool, ownerDeclined: bool, markedFree: bool): bool =
  not(cancelled) and not(ownerDeclined) and not(markedFree)
pure def intervalFree(asked: TimeWindow, busy: List[TimeWindow]): bool =
  not(busy.some(blocker => positiveOverlap(asked, blocker)))
pure def lawDeclinedNeverBlocks(cancelled: bool, markedFree: bool): bool =
  not(eventBlocks(cancelled, true, markedFree))
pure def lawOverlapIsBusy(asked: TimeWindow, blocker: TimeWindow): bool =
  positiveOverlap(asked, blocker) implies not(intervalFree(asked, List(blocker)))
pure def lawAdjacentLeavesFree(asked: TimeWindow): bool =
  intervalFree(asked, List({ begin: asked.finish, finish: asked.finish + 1 }, { begin: asked.begin, finish: asked.begin }))
pure val askedValues = Set({ begin: 0, finish: 4 }, { begin: 2, finish: 6 }, { begin: 0, finish: 3600000 })
pure val blockerValues = Set({ begin: 3, finish: 5 }, { begin: 4, finish: 4 }, { begin: 6, finish: 8 })
pure val busyValues = Set(List(), List({ begin: 3, finish: 5 }), List({ begin: 4, finish: 4 }, { begin: 6, finish: 8 }))
```

### Openings are at most two quarter-hour starts of the asked length inside the window

An opening has exactly the asked length, lies inside the window and is
free. It starts on a quarter hour of UTC time. The first is the earliest
such start, the second the earliest at or after the first one's end, and
there are at most two. The answer says that an empty list does not rule
out an opening off the quarter hour. It names each opening as a spoken
range, its weekday and date in full, from its start to its end with the
zone's full name, and offers them as alternatives ("Monday, March 4, from
10:45 AM to 11:05 AM Pacific Standard Time or …").

```quint
pure val quarterHour: int = 900000
pure def alignedStart(at: int): int = if (at % quarterHour == 0) at else (at / quarterHour + 1) * quarterHour
pure def slotOffered(asked: TimeWindow, start: int, durationMs: int, busy: List[TimeWindow]): bool =
  durationMs > 0 and start % quarterHour == 0 and start >= asked.begin and start + durationMs <= asked.finish and
  intervalFree({ begin: start, finish: start + durationMs }, busy)
pure def nextSearchStart(foundStart: int, durationMs: int): int = alignedStart(foundStart + durationMs)
pure def lawOfferedSlotFitsWindow(asked: TimeWindow, start: int, durationMs: int, busy: List[TimeWindow]): bool =
  slotOffered(asked, start, durationMs, busy) implies start >= asked.begin and start + durationMs <= asked.finish
pure def lawNextOpeningNeverOverlaps(foundStart: int, durationMs: int): bool =
  foundStart >= 0 and durationMs > 0 implies nextSearchStart(foundStart, durationMs) >= foundStart + durationMs
pure def lawAlignedStartIsOnTheQuarter(at: int): bool =
  at >= 0 implies alignedStart(at) % quarterHour == 0 and alignedStart(at) >= at and alignedStart(at) < at + quarterHour
pure val startValues = Set(0, 900000, 1800000)
pure val durationMsValues = Set(0, 300000, 900000, 1200000)
pure val foundStartValues = Set(0, 900000, 1000000)
pure val atValues = Set(-1, 0, 1, 900000, 1350000)
```

### The calendar reaches the agent only in a turn whose audience is the owner alone

The upcoming-events context and the Calendar action are disclosed only
when the owner asks and the turn's attested audience is the owner alone.
In a room anyone else can read, or with no attested audience, the owner's
events stay out of the prompt and the action does not run.

```quint
pure def calendarDisclosed(isOwner: bool, ownerAlone: bool): bool = isOwner and ownerAlone
pure def lawSharedAudienceSeesNoCalendar(isOwner: bool): bool = not(calendarDisclosed(isOwner, false))
pure def lawOthersSeeNoCalendar(ownerAlone: bool): bool = not(calendarDisclosed(false, ownerAlone))
```

### A calendar the active account does not list never narrows a read

A read or a lookup narrows to the calendar it names only when the active
account lists that calendar. A name no listed calendar has, such as a
masked or invented id, is dropped, and the read covers every listed
calendar of the account, so it never answers "nothing" from a calendar
that does not exist.

```quint
type ReadScope = AllListed | OneListed
pure def readScope(named: bool, namedListed: bool): ReadScope =
  if (named and namedListed) OneListed else AllListed
pure def lawUnlistedNameNeverNarrows(named: bool): bool = readScope(named, false) == AllListed
```

## Story: Change my calendar only as I asked and know it happened

> As the owner, I want a change the agent makes to my calendar to carry
> exactly the fields I reviewed, to land in the calendar it named, and to
> be reported done only when the calendar shows it.

### A new event's guests and a change of guests are the ones the owner's words give

A new event invites the guest addresses its request lists; an update adds
the addresses its request lists and removes the guests it names, and every
other guest stays. An address is invited only when the owner's own words
hold it exactly; the agent never guesses or looks one up. A guest is removed
only when the event has them and the owner's words name them, by their
address, the part of it before "@", or a word of their name. A request that
invites an address the owner did not write, removes a guest the owner did
not name, or removes one the event does not have changes nothing and says
which. The guests other than the owner are part of the reviewed fields and
their digest, and a change reads back with exactly those guests. The
resident calendar keeps a guest's address, never their name, and emails
nobody.

```quint
type GuestChange = GuestsAsAsked | AddressNotWritten | GuestNotNamed | GuestNotOnEvent
pure def guestChange(addsWritten: bool, removalsNamed: bool, removalsOnEvent: bool): GuestChange =
  if (not(addsWritten)) AddressNotWritten
  else if (not(removalsNamed)) GuestNotNamed
  else if (not(removalsOnEvent)) GuestNotOnEvent
  else GuestsAsAsked
pure def lawAnUnwrittenAddressIsNeverInvited(removalsNamed: bool, removalsOnEvent: bool): bool =
  guestChange(false, removalsNamed, removalsOnEvent) != GuestsAsAsked
pure def lawAnUnnamedGuestIsNeverRemoved(addsWritten: bool, removalsOnEvent: bool): bool =
  guestChange(addsWritten, false, removalsOnEvent) != GuestsAsAsked
pure def lawOnlyAGuestOfTheEventIsRemoved(addsWritten: bool, removalsNamed: bool): bool =
  guestChange(addsWritten, removalsNamed, false) != GuestsAsAsked
```

### A change finds its one event from a year back to five years ahead, and never calls an unread calendar empty

A change that names its event by words, not by id, looks on the calendar
named or on every listed calendar. A range the request gives, at most 370
days, is read once. Otherwise the lookup reads from one day back to 60
days ahead, then a year at a time to five years ahead, then the year
back. The first read that holds a match decides and nothing later is
read. A span that could not be read whole, when the first read was whole,
is read again at half its length, down to 45 days. What is still unread,
and everything past 16 reads, counts as unread and never as empty.

The occurrences of one repeating event count as one event. Exactly one
event, read fresh from its own calendar, is the target. More than one
asks which. One whose own calendar was not read fresh, or none while
something could not be read, says the calendars could not be read, since
the event may be there or may have changed, and changes nothing. None,
when everything was read, says the event was not found.

When the owner's own words state the event's day, the target is the match
that starts on that day, read on that day itself: for an update, a day
stated before where the event is going ("move Thursday's standup to
3pm"); for a delete, any day stated. Words inside a matched title state
no day. When no match starts on that day, an update of the only match
whose day follows its name, with no "on", "from", "of" or possessive
before it ("move Dentist tomorrow at 10am"), takes the day as where the
event is going; any other request changes nothing and asks which, naming
each candidate's day.

With no day stated, an event with one occurrence read is that
occurrence. Of several, a change of the whole series, and a change whose
scope is still to be asked, takes the earliest that has not ended, else
the latest, and the scope question names its day; a change of one
occurrence, or of one and those following, asks which occurrence.

```quint
type ChangeTarget = TargetFound | TargetAmbiguous | TargetUnread | TargetMissing
type LookupStep = LookupDecides | LookupAdvances | LookupShrinks | LookupUnread
type OffDay = DayIsDestination | DayHoldsNone
type OccurrenceChoice = TheOnlyOccurrence | TheNextOccurrence | AskWhichDay
pure val lookupDaysBack: int = 365
pure val lookupDaysAhead: int = 1825
pure val lookupNearBack: int = 1
pure val lookupNearAhead: int = 60
pure val lookupSpanDays: int = 365
pure val lookupSmallestSpan: int = 45
pure val lookupReadLimit: int = 16
pure def lookupStep(matchedEvents: int, readWhole: bool, firstReadWhole: bool, spanDays: int): LookupStep =
  if (matchedEvents > 0) LookupDecides
  else if (readWhole) LookupAdvances
  else if (firstReadWhole and spanDays >= 2 * lookupSmallestSpan) LookupShrinks
  else LookupUnread
pure def changeTarget(matchedEvents: int, everythingRead: bool, matchReadFresh: bool): ChangeTarget =
  if (matchedEvents > 1) TargetAmbiguous
  else if (matchedEvents == 1 and matchReadFresh) TargetFound
  else if (matchedEvents == 1 or not(everythingRead)) TargetUnread
  else TargetMissing
pure def offDay(moving: bool, matchedEvents: int, dayFollowsName: bool, dayMarksTheEvent: bool): OffDay =
  if (moving and matchedEvents == 1 and dayFollowsName and not(dayMarksTheEvent)) DayIsDestination else DayHoldsNone
pure def occurrenceChoice(occurrencesRead: int, scopeSaid: bool, wholeSeries: bool): OccurrenceChoice =
  if (occurrencesRead <= 1) TheOnlyOccurrence
  else if (wholeSeries or not(scopeSaid)) TheNextOccurrence
  else AskWhichDay
pure def lawAMatchEndsTheLookup(readWhole: bool, firstReadWhole: bool, spanDays: int): bool =
  lookupStep(1, readWhole, firstReadWhole, spanDays) == LookupDecides
pure def lawAnUnreadSpanIsNeverPassedAsEmpty(firstReadWhole: bool, spanDays: int): bool =
  lookupStep(0, false, firstReadWhole, spanDays) != LookupAdvances
pure def lawASpanNeverShrinksBelowTheSmallest(matchedEvents: int, readWhole: bool, firstReadWhole: bool, spanDays: int): bool =
  lookupStep(matchedEvents, readWhole, firstReadWhole, spanDays) == LookupShrinks implies spanDays >= 2 * lookupSmallestSpan
pure def lawAnUnreadCalendarIsNeverCalledEmpty(matchedEvents: int, matchReadFresh: bool): bool =
  changeTarget(matchedEvents, false, matchReadFresh) != TargetMissing
pure def lawOnlyOneFreshMatchIsTheTarget(matchedEvents: int, everythingRead: bool, matchReadFresh: bool): bool =
  changeTarget(matchedEvents, everythingRead, matchReadFresh) == TargetFound iff (matchedEvents == 1 and matchReadFresh)
pure def lawADayThatMarksTheEventIsNeverWhereItGoes(moving: bool, matchedEvents: int, dayFollowsName: bool): bool =
  offDay(moving, matchedEvents, dayFollowsName, true) == DayHoldsNone
pure def lawADeleteNeverTakesItsDayAsADestination(matchedEvents: int, dayFollowsName: bool, dayMarksTheEvent: bool): bool =
  offDay(false, matchedEvents, dayFollowsName, dayMarksTheEvent) == DayHoldsNone
pure def lawOneOccurrenceOfSeveralIsNeverGuessed(occurrencesRead: int): bool =
  occurrencesRead > 1 implies occurrenceChoice(occurrencesRead, true, false) == AskWhichDay
pure val matchedEventsValues = Set(0, 1, 2)
pure val spanDaysValues = Set(45, 89, 90, 365)
pure val occurrencesReadValues = Set(0, 1, 2)
```

### A new event with a start and no end lasts the asked minutes, else one hour

A create that gives a start and no end ends after the length the request
gives: any whole number of minutes from 1 to 44640, which is 31 days.
With no length, a timed event lasts one hour and an all-day event one
day. A stated end is kept as sent and the length is not read. Any other
length is refused before anything is saved, and the reply asks for the
end instead.

```quint
type CreateLength = KeepEnd | UseLength | DefaultLength | RefuseLength
pure val defaultEventMs: int = 3600000
pure val allDayEventMs: int = 86400000
pure val longestLengthMinutes: int = 44640
pure def createLength(endGiven: bool, lengthSent: bool, lengthWhole: bool, lengthMinutes: int): CreateLength =
  if (endGiven) KeepEnd
  else if (not(lengthSent)) DefaultLength
  else if (lengthWhole and lengthMinutes >= 1 and lengthMinutes <= longestLengthMinutes) UseLength
  else RefuseLength
pure def createEndMs(startMs: int, endGiven: bool, endMs: int, lengthMinutes: int, wholeDay: bool): int =
  if (endGiven) endMs
  else if (lengthMinutes > 0) startMs + lengthMinutes * 60000
  else if (wholeDay) startMs + allDayEventMs
  else startMs + defaultEventMs
pure def lawAStatedEndIsKept(startMs: int, endMs: int, lengthMinutes: int, wholeDay: bool): bool =
  createEndMs(startMs, true, endMs, lengthMinutes, wholeDay) == endMs
pure def lawAnOpenEndedEventEndsAfterItStarts(startMs: int, endMs: int, lengthMinutes: int, wholeDay: bool): bool =
  createEndMs(startMs, false, endMs, lengthMinutes, wholeDay) > startMs
pure def lawAStatedEndNeedsNoLength(lengthSent: bool, lengthWhole: bool, lengthMinutes: int): bool =
  createLength(true, lengthSent, lengthWhole, lengthMinutes) == KeepEnd
pure def lawAnAdmittedLengthIsWholeAndBounded(lengthSent: bool, lengthWhole: bool, lengthMinutes: int): bool =
  createLength(false, lengthSent, lengthWhole, lengthMinutes) == UseLength implies lengthWhole and lengthMinutes >= 1 and lengthMinutes <= longestLengthMinutes
pure def lawASentLengthIsUsedOrRefused(lengthWhole: bool, lengthMinutes: int): bool =
  createLength(false, true, lengthWhole, lengthMinutes) != DefaultLength
pure val lengthMinutesValues = Set(-1, 0, 1, 30, 44640, 44641)
```

### A change that moves only the start keeps the event's length

A change that gives a new start and no end ends as long after the new
start as the event lasted before it ("move my 3pm to 4" keeps a one-hour
meeting one hour long). A change that gives an end keeps that end as
sent, and a change that gives no new start keeps the end it had.

```quint
pure def changedEndMs(oldStartMs: int, oldEndMs: int, startGiven: bool, newStartMs: int, endGiven: bool, endMs: int): int =
  if (endGiven) endMs
  else if (startGiven) newStartMs + (oldEndMs - oldStartMs)
  else oldEndMs
pure def lawAMovedStartKeepsTheLength(oldStartMs: int, oldEndMs: int, newStartMs: int, endMs: int): bool =
  changedEndMs(oldStartMs, oldEndMs, true, newStartMs, false, endMs) - newStartMs == oldEndMs - oldStartMs
pure def lawAChangedEndIsKept(oldStartMs: int, oldEndMs: int, startGiven: bool, newStartMs: int, endMs: int): bool =
  changedEndMs(oldStartMs, oldEndMs, startGiven, newStartMs, true, endMs) == endMs
pure def lawAnUnmovedEventKeepsItsEnd(oldStartMs: int, oldEndMs: int, newStartMs: int, endMs: int): bool =
  changedEndMs(oldStartMs, oldEndMs, false, newStartMs, false, endMs) == oldEndMs
```

### A chat create or move that overlaps a commitment is refused, naming it

A new timed event, and a change of an event's start or end, asked in chat
is checked against the active account's calendars over its new span
before anything is queued or changed. An event that blocks time there, as
a free-time question counts it, and overlaps the span with positive
length refuses the change; the reply names each such event and nothing is
created or moved. The event being moved never blocks itself. When the
calendar the change goes to could not be read, the change is refused,
since its time cannot be called free. When only another calendar could
not be read, the change goes ahead and its reply says overlaps there were
not checked. An all-day event, a change that leaves the times alone, a
change from the owner's client and a request the ledger already applied
are not checked.

```quint
type WriteSlot = SlotClear | SlotUnchecked | SlotTaken | SlotUnread
pure def slotChecked(fromChat: bool, timed: bool, movesTime: bool, alreadyApplied: bool): bool =
  fromChat and timed and movesTime and not(alreadyApplied)
pure def writeSlot(checked: bool, targetCalendarRead: bool, everyCalendarRead: bool, overlapping: int): WriteSlot =
  if (not(checked)) SlotClear
  else if (overlapping > 0) SlotTaken
  else if (not(targetCalendarRead)) SlotUnread
  else if (not(everyCalendarRead)) SlotUnchecked
  else SlotClear
pure def lawAnOverlapIsNeverWritten(targetCalendarRead: bool, everyCalendarRead: bool, overlapping: int): bool =
  overlapping > 0 implies writeSlot(true, targetCalendarRead, everyCalendarRead, overlapping) == SlotTaken
pure def lawAnUnreadTargetIsNeverWritten(everyCalendarRead: bool, overlapping: int): bool =
  writeSlot(true, false, everyCalendarRead, overlapping) != SlotClear and writeSlot(true, false, everyCalendarRead, overlapping) != SlotUnchecked
pure def lawAnAppliedRequestIsNotCheckedAgain(fromChat: bool, timed: bool, movesTime: bool): bool =
  not(slotChecked(fromChat, timed, movesTime, true))
pure def lawAClientChangeIsNotChecked(timed: bool, movesTime: bool, alreadyApplied: bool): bool =
  not(slotChecked(false, timed, movesTime, alreadyApplied))
pure val overlappingValues = Set(0, 1, 2)
```

### A change waiting for approval expires a day after it was asked

A change queued for the owner's approval carries the instant it expires:
24 hours after it was asked. The agent's upcoming-events context reads
the same length of time ahead of now.

```quint
pure val approvalLifetime: int = 86400000
pure val contextLookahead: int = 86400000
pure def approvalExpiry(askedAt: int): int = askedAt + approvalLifetime
pure def lawAnApprovalExpiresAfterItWasAsked(askedAt: int): bool = approvalExpiry(askedAt) > askedAt
```

### A write goes to the active account's writable calendar, at once only for the resident calendar

A write needs the active account and a calendar that account can write.
The resident calendar can apply a write at once for the owner who asked.
A chat create queues for approval by default and saves at once only when
the owner explicitly chose to save it without review. A resident delete
runs at once only as the next rule allows. Any provider calendar queues
the exact fields for the owner's approval. A queued change is filed with
its change and digest and, when it changes an existing event, the start of
that event as it was read (`targetStartAt`), so a review can read the event
again outside the window it has loaded. A write for another account,
or to a calendar it cannot write, is refused.

```quint
type WriteProvider = ResidentProvider | AccountProvider
type WriteRoute = RefuseWrite | ApplyNow | QueueApproval
pure def writeRoute(provider: WriteProvider, sameAccount: bool, writable: bool, reviewFirst: bool): WriteRoute =
  if (not(sameAccount and writable)) RefuseWrite
  else if (provider == ResidentProvider and not(reviewFirst)) ApplyNow
  else QueueApproval
pure def chatCreateReviewed(saveNowChosen: bool): bool = not(saveNowChosen)
pure def lawProviderWriteWaitsForApproval(sameAccount: bool, writable: bool, reviewFirst: bool): bool =
  writeRoute(AccountProvider, sameAccount, writable, reviewFirst) != ApplyNow
pure def lawForeignAccountRefused(provider: WriteProvider, writable: bool, reviewFirst: bool): bool =
  writeRoute(provider, false, writable, reviewFirst) == RefuseWrite
pure def lawAskedReviewWaitsForApproval(provider: WriteProvider, sameAccount: bool, writable: bool): bool =
  writeRoute(provider, sameAccount, writable, true) != ApplyNow
pure def lawUnsaidChatCreateIsReviewed(provider: WriteProvider): bool =
  writeRoute(provider, true, true, chatCreateReviewed(false)) == QueueApproval
```

### A new event the owner put on the phone's own calendar is proposed on the phone

The phone's own calendar is written only through a review on the phone.
Whether the owner asked to put a new event on the phone's own calendar
is the model's reading of the request, in any language, sent with the
create; code matches no calendar words. When the model reads that and the
phone negotiated its own calendar for the turn, the Calendar action saves
nothing and the result tells the model to propose the event on the phone
instead. On a device that offers no phone calendar, or when the model did
not read a phone calendar, the create goes on as any chat create.

```quint
type CreateStore = CreateHere | ProposeOnPhone
pure def createStore(phoneCalendarAsked: bool, phoneCalendarOffered: bool): CreateStore =
  if (phoneCalendarAsked and phoneCalendarOffered) ProposeOnPhone else CreateHere
pure def lawAPhoneCalendarCreateIsNeverSavedHere(phoneCalendarOffered: bool): bool =
  (createStore(true, phoneCalendarOffered) == CreateHere) iff not(phoneCalendarOffered)
pure def lawWithoutAPhoneCalendarTheCreateGoesOn(phoneCalendarAsked: bool): bool =
  createStore(phoneCalendarAsked, false) == CreateHere
pure def lawAnUnaskedCreateGoesOn(phoneCalendarOffered: bool): bool =
  createStore(false, phoneCalendarOffered) == CreateHere
```

### A resident delete runs at once only for the one event the owner named, and otherwise asks in chat

The resident calendar has no review of its own, so a delete there runs at
once only when the model sends its reading that the owner asked to delete
(yes, below) and the owner's own words point at one event. A delete the
model sent without that reading, as a request it misread, deletes nothing
and asks in chat. The owner's own words are the
request the host bound to the turn when it holds one, else the turn's
text. Whether the owner asked to delete, said yes or turned a delete down
is the model's reading of the request, in any language, sent with it as
the owner's answer: yes for a request that asks to delete or agrees to it
("delete Dentist", "yes, delete it", "sí, bórralo"), no for one that
turns it down, in a first request or an answer ("don't delete Dentist",
"keep Dentist", "no, keep it"); code matches no delete, yes or decline
words. A decline keeps the event and deletes nothing, even when the
owner's words point at it. The owner's words point at an event when its
whole title is in them, as a reviewed phone request names an event
("Delete Willow Harbor QA", "歯医者を削除して"), a read of every listed
calendar found no other event their words name, and that read was
complete; or when it is the event selected in Calendar on a screen that is
not sensitive. An event id, a query or a calendar the model chose points at
nothing.

Any other delete removes nothing and asks in chat: the reply names the
closest match and says that nothing was deleted, and, when a calendar could
not be read, that the event meant may be there. The owner's answer in a
later request of the same conversation, within 30 minutes, settles that
question for that one event: a yes the model read deletes it; a decline
keeps it and spends the question; anything else leaves it asked.

A chat delete removes one occurrence at most. A wider scope (this and
following, or the whole series) is the model's choice, not the owner's: it
deletes nothing and asks nothing, and the reply tells the owner to choose
the event and its scope in Calendar. A decline still keeps the event.

```quint
type OwnerAnswer = SaidYes | SaidNo | SaidNeither
type DeleteAnswer = Unanswered | AnsweredYes | AnsweredNo
type ResidentDeleteStep = DeleteNow | AskInChat | KeepEvent | PickInCalendar
pure val deleteQuestionLifetime: int = 1800000
pure def ownerPointedAt(wholeTitleSaid: bool, onlyEventNamed: bool, everyCalendarRead: bool, selectedOnScreen: bool): bool =
  (wholeTitleSaid and onlyEventNamed and everyCalendarRead) or selectedOnScreen
pure def deleteAnswer(askedAboutThisEvent: bool, laterRequest: bool, sinceAsked: int, said: OwnerAnswer): DeleteAnswer =
  if (not(askedAboutThisEvent and laterRequest and sinceAsked >= 0 and sinceAsked < deleteQuestionLifetime)) Unanswered
  else if (said == SaidNo) AnsweredNo
  else if (said == SaidYes) AnsweredYes
  else Unanswered
pure def residentDeleteStep(pointedAt: bool, said: OwnerAnswer, answer: DeleteAnswer): ResidentDeleteStep =
  if (said == SaidNo or answer == AnsweredNo) KeepEvent
  else if (answer == AnsweredYes or (pointedAt and said == SaidYes)) DeleteNow
  else AskInChat
pure def chatDeleteStep(oneOccurrence: bool, unscoped: ResidentDeleteStep): ResidentDeleteStep =
  if (oneOccurrence or unscoped == KeepEvent) unscoped else PickInCalendar
pure def lawADeclineNeverDeletes(pointedAt: bool, answer: DeleteAnswer): bool =
  residentDeleteStep(pointedAt, SaidNo, answer) == KeepEvent
pure def lawAnUnreadDeleteNeverDeletesAtOnce(pointedAt: bool): bool =
  residentDeleteStep(pointedAt, SaidNeither, Unanswered) == AskInChat
pure def lawResidentChatDeleteCannotBroaden(pointedAt: bool, said: OwnerAnswer, answer: DeleteAnswer): bool =
  chatDeleteStep(false, residentDeleteStep(pointedAt, said, answer)) != DeleteNow
pure def lawAPartialMatchIsNeverAnImmediateDelete(onlyEventNamed: bool, everyCalendarRead: bool, said: OwnerAnswer): bool =
  residentDeleteStep(ownerPointedAt(false, onlyEventNamed, everyCalendarRead, false), said, Unanswered) != DeleteNow
pure def lawAnIncompleteSearchNeverDeletesAtOnce(wholeTitleSaid: bool, onlyEventNamed: bool, said: OwnerAnswer): bool =
  residentDeleteStep(ownerPointedAt(wholeTitleSaid, onlyEventNamed, false, false), said, Unanswered) != DeleteNow
pure def lawASecondNamedEventAsksFirst(everyCalendarRead: bool, said: OwnerAnswer): bool =
  residentDeleteStep(ownerPointedAt(true, false, everyCalendarRead, false), said, Unanswered) != DeleteNow
pure def lawOnlyTheAskedEventIsConfirmed(laterRequest: bool, sinceAsked: int, said: OwnerAnswer): bool =
  deleteAnswer(false, laterRequest, sinceAsked, said) == Unanswered
pure def lawAStaleQuestionIsNeverConfirmed(askedAboutThisEvent: bool, laterRequest: bool, said: OwnerAnswer): bool =
  deleteAnswer(askedAboutThisEvent, laterRequest, deleteQuestionLifetime, said) == Unanswered
pure def lawTheAskingRequestNeverAnswers(askedAboutThisEvent: bool, sinceAsked: int, said: OwnerAnswer): bool =
  deleteAnswer(askedAboutThisEvent, false, sinceAsked, said) == Unanswered
pure val sinceAskedValues = Set(-1, 0, 60000, 1800000)
```

### Attendees hear of a change only when the owner asked and the calendar can tell them

An update, a delete or an answer to an invitation carries whether the
owner asked to let the event's attendees know, as part of its reviewed
change and digest. The owner asked when the request says so: the model
reads it from the owner's request ("let Sam know", "notify the guests",
"send an update"), and a request turning it down ("don't tell anyone")
asks for nothing; code matches no notice words. It is asked only for an event with an
attendee other than the owner; with none, nobody is told and nothing is
carried. A provider calendar that can send updates sends its update to the
attendees exactly when the change carries it (for Google, `sendUpdates`
all, else none). A calendar that cannot, as the resident calendar and the
Cloud's managed Google calendar, never carries it: a chat change lands as
asked and its reply, or the approval the owner reviews, says that nobody
was or will be notified; a change from the owner's client that asks to
notify there is refused before anything changes.

```quint
type AttendeeNotice = NotifyAttendees | NotifyNobody | CannotNotify
pure def attendeeNotice(noticeWanted: bool, otherAttendees: bool, canNotify: bool): AttendeeNotice =
  if (not(noticeWanted and otherAttendees)) NotifyNobody
  else if (not(canNotify)) CannotNotify
  else NotifyAttendees
pure def clientNoticeRefused(noticeWanted: bool, canNotify: bool): bool = noticeWanted and not(canNotify)
pure def lawAnUnaskedChangeTellsNobody(otherAttendees: bool, canNotify: bool): bool =
  attendeeNotice(false, otherAttendees, canNotify) == NotifyNobody
pure def lawACalendarThatCannotSendNeverNotifies(noticeWanted: bool, otherAttendees: bool): bool =
  attendeeNotice(noticeWanted, otherAttendees, false) != NotifyAttendees
pure def lawNoAttendeesNoNotice(noticeWanted: bool, canNotify: bool): bool =
  attendeeNotice(noticeWanted, false, canNotify) == NotifyNobody
pure def lawAClientNoticeIsRefusedWhereNobodyCanBeTold(noticeWanted: bool): bool =
  clientNoticeRefused(noticeWanted, false) == noticeWanted
```

### Declining an invitation never deletes the event

A removal from the owner's client names how it ends the owner's part in
the event: the organizer cancels it (`organizer_cancel`), the owner
removes a private copy (`remove_private_copy`), or the owner declines an
invitation (`decline_invitation`). A removal with any other mode, or
none, is refused before anything is read. The first two remove the event
as any delete does, under the invitation rule below. Declining an
invitation is a reply to the organizer, not a removal: it is the owner's
answer declined to that invitation, under the same rule, so it runs only
for an invitee on a calendar that can answer, and otherwise is refused.
Either way the event stays on the organizer's calendar.

```quint
type CancellationMode = OrganizerCancel | DeclineInvitation | RemovePrivateCopy
type CancellationRoute = RemoveEvent | AnswerDeclined
pure def cancellationRoute(mode: CancellationMode): CancellationRoute =
  if (mode == DeclineInvitation) AnswerDeclined else RemoveEvent
pure def lawDeclineNeverDeletes(mode: CancellationMode): bool =
  mode == DeclineInvitation implies cancellationRoute(mode) != RemoveEvent
```

### An approved change runs only with its reviewed fields for the account that approved it

The executed change is the reviewed one: the same operation, target,
recurrence scope and fields, compared by their digest. When the active account changed since
the review, or the stored change no longer has its digest, the change is
invalidated before any provider call.

```quint
pure def reviewStillBinds(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  approvedAccount == activeAccount and reviewedDigest == payloadDigest and reviewedDigest != ""
pure def lawSwitchedAccountInvalidates(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  approvedAccount != activeAccount implies not(reviewStillBinds(approvedAccount, activeAccount, reviewedDigest, payloadDigest))
pure def lawChangedFieldsInvalidate(approvedAccount: str, activeAccount: str, reviewedDigest: str, payloadDigest: str): bool =
  reviewedDigest != payloadDigest implies not(reviewStillBinds(approvedAccount, activeAccount, reviewedDigest, payloadDigest))
pure val approvedAccountValues = Set("owner", "other")
pure val reviewedDigestValues = Set("", "a", "b")
pure val payloadDigestValues = Set("a", "b")
```

### A create is reported only after it reads back from the same calendar

After the provider accepts a create, the event is read again through the
same account and calendar. Only a readback that holds the reviewed fields
reports the event created. A readback that is missing, comes from another
calendar or differs leaves the outcome unconfirmed.

```quint
type CreateOutcome = NotCreated | CreatedAndRead | CreatedUnconfirmed
pure def createOutcome(written: bool, readBack: bool, sameSource: bool, fieldsMatch: bool): CreateOutcome =
  if (not(written)) NotCreated
  else if (readBack and sameSource and fieldsMatch) CreatedAndRead
  else CreatedUnconfirmed
pure def lawCreatedNeedsSameCalendarReadback(written: bool, readBack: bool, sameSource: bool, fieldsMatch: bool): bool =
  createOutcome(written, readBack, sameSource, fieldsMatch) == CreatedAndRead implies readBack and sameSource and fieldsMatch
```

### A repeating create carries its reviewed recurrence and reads back with it

A new event may repeat daily, on weekdays or weekly, with an optional
last start and starts it skips, in the zone of its reviewed fields. The
recurrence is part of the reviewed change and its digest. The resident
calendar saves it as one series row. A provider calendar receives it as
RFC 5545 recurrence lines when its provider writes them, and refuses a
repeating create with that reason otherwise. A timed series needs a known
zone, and its last start is never before its first. The create is
reported only when its readback also holds exactly the reviewed
recurrence lines.

```quint
type RecurrenceCarrier = ResidentRows | ProviderRuleLines | ProviderWithoutRules
pure def repeatingCreateAllowed(repeating: bool, carrier: RecurrenceCarrier): bool =
  not(repeating) or carrier != ProviderWithoutRules
pure def lawProviderWithoutRulesRefusesRepeats(repeating: bool): bool =
  repeating implies not(repeatingCreateAllowed(repeating, ProviderWithoutRules))
pure def lawOneOffCreateNeedsNoRules(carrier: RecurrenceCarrier): bool = repeatingCreateAllowed(false, carrier)
pure def lawRecurrenceMismatchIsUnconfirmed(written: bool, readBack: bool, sameSource: bool): bool =
  createOutcome(written, readBack, sameSource, false) != CreatedAndRead
```

### Only an invitee answers an invitation, and an invitee's delete is a decline

The owner's role on an event comes from the event as read: organizer
when its organizer is the owner (the organizer marked as the owner's
own, the owner's attendee marked organizer, or an organizer address
equal to the calendar's account address), invitee when the owner is an
attendee who does not organize it, and unknown otherwise. Every event of
the resident calendar is the owner's own. Accepting, answering tentative
and declining answer an invitation, and only an invitee may answer. An
invitee's delete is a decline: it answers declined and leaves the
organizer's event in place. An invitee's edit of the event, an
organizer's answer, and any change while the role is unknown are
refused. An answer covers this event or the whole series, never this and
following. It changes nothing else of the event, goes through the
owner's approval and the ledger with its reviewed digest like any
provider change, and is reported only when the event reads back from the
same calendar with the owner's answer and its fields unchanged. The role
is checked again on the event read just before the provider call. A
provider that cannot answer invitations, as the Cloud's managed Google
calendar, refuses an answer before reading or changing anything there.

```quint
type OwnerRole = OrganizerRole | InviteeRole | UnknownRole
type InvitationChange = EditEvent | DeleteEvent | AnswerInvitation
type InvitationVerdict = RunAsAsked | RunAsDecline | RefuseRole | RefuseUnsupported | RefuseScope
pure def invitationVerdict(change: InvitationChange, role: OwnerRole, answers: bool, followingScope: bool): InvitationVerdict =
  if (role == UnknownRole) RefuseRole
  else if (change == AnswerInvitation and role != InviteeRole) RefuseRole
  else if (change == EditEvent and role == InviteeRole) RefuseRole
  else if (role == OrganizerRole) RunAsAsked
  else if (followingScope) RefuseScope
  else if (not(answers)) RefuseUnsupported
  else if (change == DeleteEvent) RunAsDecline
  else RunAsAsked
pure def lawOnlyInviteeAnswers(role: OwnerRole, answers: bool, followingScope: bool): bool =
  invitationVerdict(AnswerInvitation, role, answers, followingScope) == RunAsAsked implies role == InviteeRole
pure def lawInviteeDeleteNeverRemoves(answers: bool, followingScope: bool): bool =
  invitationVerdict(DeleteEvent, InviteeRole, answers, followingScope) != RunAsAsked
pure def lawInviteeNeverEdits(answers: bool, followingScope: bool): bool =
  invitationVerdict(EditEvent, InviteeRole, answers, followingScope) == RefuseRole
pure def lawUnknownRoleChangesNothing(change: InvitationChange, answers: bool, followingScope: bool): bool =
  invitationVerdict(change, UnknownRole, answers, followingScope) == RefuseRole
pure def lawAnswerNeedsAnsweringProvider(change: InvitationChange, role: OwnerRole, followingScope: bool): bool =
  val verdict = invitationVerdict(change, role, false, followingScope)
  verdict != RunAsDecline and (change == AnswerInvitation implies verdict != RunAsAsked)
pure def lawAnswerNeverFollows(change: InvitationChange, answers: bool): bool =
  invitationVerdict(change, InviteeRole, answers, true) != RunAsAsked and invitationVerdict(change, InviteeRole, answers, true) != RunAsDecline
pure def lawOrganizerChangesAsAsked(answers: bool, followingScope: bool): bool =
  invitationVerdict(EditEvent, OrganizerRole, answers, followingScope) == RunAsAsked and invitationVerdict(DeleteEvent, OrganizerRole, answers, followingScope) == RunAsAsked
```

### A change's result names its target as read before the change and the version it produced

An update or a delete reports the event it changed as it was read before
the change, with that event's provider version. An update's receipt names
the changed event's version; a delete's names the deleted target's
version, marked deleted. A result without its target's version names no
receipt.

```quint
type ChangeOp = UpdateChange | DeleteChange
type VersionSource = FromChangedEvent | FromDeletedTarget | NoVersion
pure def receiptVersion(op: ChangeOp, targetVersioned: bool, changedVersioned: bool): VersionSource =
  if (not(targetVersioned)) NoVersion
  else if (op == DeleteChange) FromDeletedTarget
  else if (changedVersioned) FromChangedEvent
  else NoVersion
pure def lawDeleteNamesItsTarget(targetVersioned: bool, changedVersioned: bool): bool =
  targetVersioned implies receiptVersion(DeleteChange, targetVersioned, changedVersioned) == FromDeletedTarget
pure def lawUnversionedTargetHasNoReceipt(op: ChangeOp, changedVersioned: bool): bool =
  receiptVersion(op, false, changedVersioned) == NoVersion
```
