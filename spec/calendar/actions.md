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

When the host names the Cloud's [managed Google](./managedFeed.md)
connection through its private broker, the calendars that broker lists are
listed calendars of the account in use, beside the resident calendar.
Searches, lookups, free-time questions, trip questions, the agent's context
and the client's feed read them, through the broker for the exact calendar
and window. Each answer lists every calendar it read with whether that read
was fresh, held only kept events (stale), or failed. A broker read that
fails answers from the events the last good read of that calendar kept, and
the answer is never complete. A change to one of them waits for the owner's
approval like any provider calendar. That calendar creates events and edits
one occurrence; it cannot email attendees, answer invitations, delete
events, or edit more than one occurrence of a repeating event, so such a
request is refused before anything is queued or changed. A broker address
or token that is not the device's private one stops the calendar from
starting rather than reading without it.

```quint
type ManagedChange = ManagedCreate | ManagedEdit | ManagedDelete | ManagedAnswer
type SourceRead = ReadFresh | ReadStale | ReadFailed
pure def managedChangeAllowed(change: ManagedChange, oneOccurrence: bool): bool =
  change == ManagedCreate or (change == ManagedEdit and oneOccurrence)
pure def sourceRead(answered: bool, complete: bool, keptEvents: bool): SourceRead =
  if (answered and complete) ReadFresh
  else if (answered or keptEvents) ReadStale
  else ReadFailed
pure def lawAManagedDeleteIsRefused(oneOccurrence: bool): bool = not(managedChangeAllowed(ManagedDelete, oneOccurrence))
pure def lawAManagedAnswerIsRefused(oneOccurrence: bool): bool = not(managedChangeAllowed(ManagedAnswer, oneOccurrence))
pure def lawOnlyACreateSpansASeries(change: ManagedChange): bool = change != ManagedCreate implies not(managedChangeAllowed(change, false))
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

### A resident delete runs at once only for the one event the owner named, and otherwise asks in chat

The resident calendar has no review of its own, so a delete there runs at
once only when the owner's own words ask to delete and point at one event.
The owner's own words are the request the host bound to the turn when it
holds one, else the turn's text. They ask to delete as a [phone
delete](./reviewedReads.md) asks, and a decline ("don't delete Dentist",
"no, keep it") keeps the event and deletes nothing. They point at an event
when its whole title is in them, as a reviewed phone request names an
event ("Delete Willow Harbor QA", "歯医者を削除して"), a read of every listed
calendar found no other event their words name, and that read was
complete; or when it is the event selected in Calendar on a screen that is
not sensitive. An event id, a query or a calendar the model chose points at
nothing.

Any other delete removes nothing and asks in chat: the reply names the
closest match and says that nothing was deleted, and, when a calendar could
not be read, that the event meant may be there. The owner's answer in a
later request of the same conversation, within 30 minutes, settles that
question for that one event: a yes, or the event's whole title, with no
question back and no decline, deletes it; a decline keeps it and spends the
question.

```quint
type DeleteAnswer = Unanswered | AnsweredYes | AnsweredNo
type ResidentDeleteStep = DeleteNow | AskInChat | KeepEvent
pure val deleteQuestionLifetime: int = 1800000
pure def ownerPointedAt(wholeTitleSaid: bool, onlyEventNamed: bool, everyCalendarRead: bool, selectedOnScreen: bool): bool =
  (wholeTitleSaid and onlyEventNamed and everyCalendarRead) or selectedOnScreen
pure def deleteAnswer(askedAboutThisEvent: bool, laterRequest: bool, sinceAsked: int, yesOrTitle: bool, declines: bool, asksBack: bool): DeleteAnswer =
  if (not(askedAboutThisEvent and laterRequest and sinceAsked >= 0 and sinceAsked < deleteQuestionLifetime)) Unanswered
  else if (declines) AnsweredNo
  else if (yesOrTitle and not(asksBack)) AnsweredYes
  else Unanswered
pure def residentDeleteStep(pointedAt: bool, asksToDelete: bool, declines: bool, answer: DeleteAnswer): ResidentDeleteStep =
  if (declines or answer == AnsweredNo) KeepEvent
  else if (answer == AnsweredYes or (pointedAt and asksToDelete)) DeleteNow
  else AskInChat
pure def lawADeclineNeverDeletes(pointedAt: bool, asksToDelete: bool, answer: DeleteAnswer): bool =
  residentDeleteStep(pointedAt, asksToDelete, true, answer) == KeepEvent
pure def lawUnaskedWordsNeverDeleteAtOnce(pointedAt: bool): bool =
  residentDeleteStep(pointedAt, false, false, Unanswered) == AskInChat
pure def lawAPartialMatchIsNeverAnImmediateDelete(onlyEventNamed: bool, everyCalendarRead: bool, asksToDelete: bool): bool =
  residentDeleteStep(ownerPointedAt(false, onlyEventNamed, everyCalendarRead, false), asksToDelete, false, Unanswered) == AskInChat
pure def lawAnIncompleteSearchNeverDeletesAtOnce(wholeTitleSaid: bool, onlyEventNamed: bool, asksToDelete: bool): bool =
  residentDeleteStep(ownerPointedAt(wholeTitleSaid, onlyEventNamed, false, false), asksToDelete, false, Unanswered) == AskInChat
pure def lawASecondNamedEventAsksFirst(everyCalendarRead: bool, asksToDelete: bool): bool =
  residentDeleteStep(ownerPointedAt(true, false, everyCalendarRead, false), asksToDelete, false, Unanswered) == AskInChat
pure def lawOnlyTheAskedEventIsConfirmed(laterRequest: bool, sinceAsked: int, yesOrTitle: bool, declines: bool, asksBack: bool): bool =
  deleteAnswer(false, laterRequest, sinceAsked, yesOrTitle, declines, asksBack) == Unanswered
pure def lawAStaleQuestionIsNeverConfirmed(askedAboutThisEvent: bool, laterRequest: bool, yesOrTitle: bool, declines: bool, asksBack: bool): bool =
  deleteAnswer(askedAboutThisEvent, laterRequest, deleteQuestionLifetime, yesOrTitle, declines, asksBack) == Unanswered
pure def lawTheAskingRequestNeverAnswers(askedAboutThisEvent: bool, sinceAsked: int, yesOrTitle: bool, declines: bool, asksBack: bool): bool =
  deleteAnswer(askedAboutThisEvent, false, sinceAsked, yesOrTitle, declines, asksBack) == Unanswered
pure val sinceAskedValues = Set(-1, 0, 60000, 1800000)
```

### Attendees hear of a change only when the owner asked and the calendar can tell them

An update, a delete or an answer to an invitation carries whether the
owner asked to let the event's attendees know, as part of its reviewed
change and digest. The owner asked when the request asks for it and the
owner's own words do too ("let Sam know", "notify the guests", "send an
update") without turning it down ("don't tell anyone"); a flag the model
set on its own asks for nothing. It is asked only for an event with an
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
pure def noticeAsked(flagged: bool, ownerWordsAsk: bool, ownerWordsDecline: bool): bool =
  flagged and ownerWordsAsk and not(ownerWordsDecline)
pure def clientNoticeRefused(noticeWanted: bool, canNotify: bool): bool = noticeWanted and not(canNotify)
pure def lawAnUnaskedChangeTellsNobody(otherAttendees: bool, canNotify: bool): bool =
  attendeeNotice(false, otherAttendees, canNotify) == NotifyNobody
pure def lawACalendarThatCannotSendNeverNotifies(noticeWanted: bool, otherAttendees: bool): bool =
  attendeeNotice(noticeWanted, otherAttendees, false) != NotifyAttendees
pure def lawNoAttendeesNoNotice(noticeWanted: bool, canNotify: bool): bool =
  attendeeNotice(noticeWanted, false, canNotify) == NotifyNobody
pure def lawAModelFlagAloneAsksNothing(ownerWordsDecline: bool): bool =
  not(noticeAsked(true, false, ownerWordsDecline))
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
