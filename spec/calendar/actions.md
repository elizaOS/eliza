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

### A tomorrow-morning question reads only tomorrow, from midnight to noon

When the owner's words ask about tomorrow morning and no other period,
the window must start no earlier than tomorrow's midnight and end no
later than tomorrow's noon in the request's zone; a wider window is
refused before anything is read, pointing to a slot search for a shorter
opening. Both bounds themselves are inside the morning. A noon end bound
("until noon", "through 12:00 PM") keeps the request morning-only. The
request names another period when it also names another part of the day
(afternoon, evening, tonight, noon, lunch, all day, the rest of the day,
the week), an afternoon clock time (1 to 12 pm, 12:01 to 12:59 without
"am", or 13:00 to 23:59), another day (today, a weekday, a date), or asks
after, before, except or not tomorrow morning; such a window is read as
asked.

```quint
type MorningAdmission = ReadMorning | RefuseOutsideMorning
pure def morningAdmission(morningOnly: bool, startsEarly: bool, endsLate: bool): MorningAdmission =
  if (morningOnly and (startsEarly or endsLate)) RefuseOutsideMorning else ReadMorning
pure def lawMorningReadStaysInMorning(startsEarly: bool, endsLate: bool): bool =
  morningAdmission(true, startsEarly, endsLate) == ReadMorning implies not(startsEarly) and not(endsLate)
pure def lawWiderRequestIsRead(startsEarly: bool, endsLate: bool): bool =
  morningAdmission(false, startsEarly, endsLate) == ReadMorning
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
out an opening off the quarter hour.

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

## Story: Change my calendar only as I asked and know it happened

> As the owner, I want a change the agent makes to my calendar to carry
> exactly the fields I reviewed, to land in the calendar it named, and to
> be reported done only when the calendar shows it.

### A write goes to the active account's writable calendar, at once only for the resident calendar

A write needs the active account and a calendar that account can write.
The resident calendar applies it at once for the owner who asked, unless
the owner asked to review the new event before it is saved: that create
queues for approval like any other reviewed change, and nothing is saved
before the owner approves it. Any provider calendar queues the exact
fields for the owner's approval. A write for another account, or to a
calendar it cannot write, is refused.

```quint
type WriteProvider = ResidentProvider | AccountProvider
type WriteRoute = RefuseWrite | ApplyNow | QueueApproval
pure def writeRoute(provider: WriteProvider, sameAccount: bool, writable: bool, reviewFirst: bool): WriteRoute =
  if (not(sameAccount and writable)) RefuseWrite
  else if (provider == ResidentProvider and not(reviewFirst)) ApplyNow
  else QueueApproval
pure def lawProviderWriteWaitsForApproval(sameAccount: bool, writable: bool, reviewFirst: bool): bool =
  writeRoute(AccountProvider, sameAccount, writable, reviewFirst) != ApplyNow
pure def lawForeignAccountRefused(provider: WriteProvider, writable: bool, reviewFirst: bool): bool =
  writeRoute(provider, false, writable, reviewFirst) == RefuseWrite
pure def lawAskedReviewWaitsForApproval(provider: WriteProvider, sameAccount: bool, writable: bool): bool =
  writeRoute(provider, sameAccount, writable, true) != ApplyNow
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
