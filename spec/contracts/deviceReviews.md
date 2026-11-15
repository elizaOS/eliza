# Device reviews

Some device operations are resolved by the owner on the phone, in the
foreground, before anything is shared or changed: a free/busy answer over
the calendars the owner selected, a search of local notes, and an edit of a
record the agent named only by its title, which the owner picks among the
local matches. This contract fixes what each review may ask for and what
its answer may share. The plugin that owns notes, calendar events or
reminders validates their fields and its exact operations and passes those
checks in; the host keeps the local selection, permission and approval.
Nothing here grants device permission.

Instants are minutes on one timeline; an all-day event's bounds are its
owner-local civil midnights, converted by the host before these
definitions see them. A record's fields stand for the owner plugin's
validated value.

## Story: Answer from my device only what I reviewed

> As an owner, I want an agent's question about my calendar or notes, or
> its edit of a record it named, to be settled on my phone by me, and to
> share no more than I saw.

### Each review needs the capability the device negotiated for it

A free/busy read needs the availability capability. A notes search needs
the notes search capability and the local notes record capability. A named
edit needs the named-target capability and the record capability of its
domain; a reminder may use either reminder record version, and a calendar
read by name may instead use the calendar named-read capability with the
calendar record capability.

```quint
type DeviceReviewType = CalendarAvailabilityReview | NotesSearchReview | NotesNamedReview | CalendarNamedReview | ReminderNamedReview
pure val availabilityCapability = "calendar.availability-read.v1"
pure val notesSearchCapability = "notes.search.v1"
pure val namedTargetCapability = "device.named-target.v1"
pure val calendarNamedReadCapability = "calendar.named-read.v1"
pure val notesRecordCapability = "notes.local-record.v1"
pure val calendarRecordCapability = "calendar.local-event.v1"
pure val reminderRecordCapability = "reminders.local-record.v1"
pure val reminderRecordCapabilityV2 = "reminders.local-record.v2"
pure def reviewCapabilityAvailable(review: DeviceReviewType, capabilities: Set[str]): bool =
  if (review == CalendarAvailabilityReview) capabilities.contains(availabilityCapability)
  else if (review == NotesSearchReview) capabilities.contains(notesSearchCapability) and capabilities.contains(notesRecordCapability)
  else if (review == CalendarNamedReview)
    capabilities.contains(calendarRecordCapability) and (capabilities.contains(namedTargetCapability) or capabilities.contains(calendarNamedReadCapability))
  else if (review == NotesNamedReview) capabilities.contains(namedTargetCapability) and capabilities.contains(notesRecordCapability)
  else capabilities.contains(namedTargetCapability) and (capabilities.contains(reminderRecordCapability) or capabilities.contains(reminderRecordCapabilityV2))
pure val capabilitiesValues: Set[Set[str]] = Set(
  Set(), Set("calendar.availability-read.v1"), Set("notes.search.v1"), Set("notes.search.v1", "notes.local-record.v1"),
  Set("device.named-target.v1", "notes.local-record.v1"), Set("device.named-target.v1", "reminders.local-record.v2"),
  Set("calendar.named-read.v1", "calendar.local-event.v1"), Set("device.named-target.v1")
)
pure def lawNamedReviewNeedsItsRecordCapability(review: DeviceReviewType, capabilities: Set[str]): bool =
  (reviewCapabilityAvailable(review, capabilities) and review == NotesNamedReview) implies capabilities.contains(notesRecordCapability)
pure def lawNamedTargetAloneIsNotEnough(review: DeviceReviewType): bool =
  not(reviewCapabilityAvailable(review, Set(namedTargetCapability)))
```

### A free/busy read covers at most seven days, sixteen calendars and two hundred events

```quint
pure val availabilityMaxSpan = 7 * 1440
pure val availabilityMaxCalendars = 16
pure val availabilityMaxEvents = 200
pure def availabilityWindowValid(windowStart: int, windowEnd: int): bool =
  windowStart >= 0 and windowEnd > windowStart and windowEnd - windowStart <= availabilityMaxSpan
pure def availabilityReadAdmitted(windowStart: int, windowEnd: int, calendarCount: int, eventCount: int): bool =
  availabilityWindowValid(windowStart, windowEnd) and calendarCount >= 1 and calendarCount <= availabilityMaxCalendars and eventCount >= 0 and eventCount <= availabilityMaxEvents
pure val windowStartValues = Set(-1, 0, 60)
pure val windowEndValues = Set(0, 60, 1440, 10080, 10081)
pure val calendarCountValues = Set(0, 1, 16, 17)
pure val eventCountValues = Set(0, 200, 201)
pure def lawAvailabilityReadIsBounded(windowStart: int, windowEnd: int, calendarCount: int, eventCount: int): bool =
  availabilityReadAdmitted(windowStart, windowEnd, calendarCount, eventCount) implies
    (windowEnd - windowStart <= availabilityMaxSpan and calendarCount <= availabilityMaxCalendars and eventCount <= availabilityMaxEvents)
```

### A free/busy answer shares busy intervals clipped to the window, never event content

An event marked free never makes the owner busy; it is only counted. A
tentative event makes the owner busy and is flagged. An event of no length
occupies no time. Each busy interval is cut to the window, and the owner
is busy exactly when some interval remains. The calendars read are counted,
never named.

```quint
type AvailabilityKind = BusyTime | FreeTime | TentativeTime
type AvailabilityEvent = { startsAt: int, endsAt: int, availability: AvailabilityKind }
type BusyInterval = { busyFrom: int, busyUntil: int, tentative: bool }
pure def occupiesWindow(windowStart: int, windowEnd: int, e: AvailabilityEvent): bool =
  e.endsAt > windowStart and e.startsAt < windowEnd and e.endsAt != e.startsAt
pure def busyIntervals(windowStart: int, windowEnd: int, events: List[AvailabilityEvent]): List[BusyInterval] =
  events.foldl(List(), (acc, e) =>
    if (not(occupiesWindow(windowStart, windowEnd, e)) or e.availability == FreeTime) acc
    else acc.append({ busyFrom: if (e.startsAt > windowStart) e.startsAt else windowStart, busyUntil: if (e.endsAt < windowEnd) e.endsAt else windowEnd, tentative: e.availability == TentativeTime }))
pure def ownerBusy(windowStart: int, windowEnd: int, events: List[AvailabilityEvent]): bool = busyIntervals(windowStart, windowEnd, events).length() > 0
pure def transparentIgnored(windowStart: int, windowEnd: int, events: List[AvailabilityEvent]): int =
  events.foldl(0, (n, e) => if (occupiesWindow(windowStart, windowEnd, e) and e.availability == FreeTime) n + 1 else n)
pure val eValues: Set[AvailabilityEvent] = List(
  { startsAt: 0, endsAt: 60, availability: BusyTime }, { startsAt: 30, endsAt: 30, availability: BusyTime },
  { startsAt: -60, endsAt: 120, availability: TentativeTime }, { startsAt: 0, endsAt: 60, availability: FreeTime },
  { startsAt: 2000, endsAt: 2100, availability: BusyTime }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
pure def lawFreeEventsNeverMakeTheOwnerBusy(windowStart: int, windowEnd: int, e: AvailabilityEvent): bool =
  e.availability == FreeTime implies not(ownerBusy(windowStart, windowEnd, List(e)))
pure def lawBusyIntervalsStayInsideTheWindow(windowStart: int, windowEnd: int, e: AvailabilityEvent): bool =
  (availabilityWindowValid(windowStart, windowEnd) and e.startsAt <= e.endsAt) implies
    busyIntervals(windowStart, windowEnd, List(e)).foldl(true, (ok, b) => ok and b.busyFrom >= windowStart and b.busyUntil <= windowEnd and b.busyFrom < b.busyUntil)
pure def lawTentativeEventsAreBusyAndFlagged(windowStart: int, windowEnd: int, e: AvailabilityEvent): bool =
  (e.availability == TentativeTime and occupiesWindow(windowStart, windowEnd, e)) implies
    busyIntervals(windowStart, windowEnd, List(e)) == List({ busyFrom: if (e.startsAt > windowStart) e.startsAt else windowStart, busyUntil: if (e.endsAt < windowEnd) e.endsAt else windowEnd, tentative: true })
```

### A notes search shares only the note the owner chose, or only the titles the owner reviewed

A content search names 1 to 256 characters of text; a titles listing asks
for 1 to 50 titles. A content match shares exactly one note, the one the
owner chose after the local match. A titles answer shares no note text and
at most the titles asked for, newest first, and says whether more notes
exist. No match shares nothing.

```quint
pure val notesTitlesLimit = 50
type NotesSearchQuery = { byContent: bool, textLength: int, titleLimit: int }
type NotesSearchBasis = NoNoteMatch | ContentMatch | TitlesReviewed
type NotesSearchAnswer = { basis: NotesSearchBasis, notesShared: int, titlesShared: int, ownerChose: bool }
pure def notesQueryValid(q: NotesSearchQuery): bool =
  if (q.byContent) q.textLength >= 1 and q.textLength <= 256 else q.titleLimit >= 1 and q.titleLimit <= notesTitlesLimit
pure def notesAnswerValid(q: NotesSearchQuery, a: NotesSearchAnswer): bool =
  notesQueryValid(q) and (
    if (a.basis == NoNoteMatch) a.notesShared == 0 and a.titlesShared == 0
    else if (a.basis == ContentMatch) q.byContent and a.ownerChose and a.notesShared == 1 and a.titlesShared == 0
    else not(q.byContent) and a.ownerChose and a.notesShared == 0 and a.titlesShared >= 0 and a.titlesShared <= q.titleLimit)
pure val qValues: Set[NotesSearchQuery] = Set({ byContent: true, textLength: 5, titleLimit: 0 }, { byContent: false, textLength: 0, titleLimit: 3 }, { byContent: false, textLength: 0, titleLimit: 51 }, { byContent: true, textLength: 0, titleLimit: 0 })
pure val aValues: Set[NotesSearchAnswer] = Set(
  { basis: NoNoteMatch, notesShared: 0, titlesShared: 0, ownerChose: false }, { basis: ContentMatch, notesShared: 1, titlesShared: 0, ownerChose: true },
  { basis: ContentMatch, notesShared: 2, titlesShared: 0, ownerChose: true }, { basis: TitlesReviewed, notesShared: 0, titlesShared: 3, ownerChose: true },
  { basis: TitlesReviewed, notesShared: 0, titlesShared: 4, ownerChose: true }, { basis: ContentMatch, notesShared: 1, titlesShared: 0, ownerChose: false })
pure def lawContentMatchSharesOnlyTheChosenNote(q: NotesSearchQuery, a: NotesSearchAnswer): bool =
  (notesAnswerValid(q, a) and a.basis == ContentMatch) implies (a.ownerChose and a.notesShared == 1)
pure def lawTitlesNeverExceedTheRequest(q: NotesSearchQuery, a: NotesSearchAnswer): bool =
  notesAnswerValid(q, a) implies (a.titlesShared <= notesTitlesLimit and a.notesShared <= 1)
```

### A named edit applies the reviewed fields to the record the owner chose

Notes may be updated or deleted by name, calendar events updated, deleted
or read, and reminders updated or cancelled. Each resolves to one exact
operation on the record the owner picked. The fields come from the reviewed
proposal, never from the local match.

```quint
type NamedAction = UpdateNamed | DeleteNamed | ReadNamed | CancelNamed
type NamedTarget = { targetReview: DeviceReviewType, namedAction: NamedAction, recordName: str, proposedFields: str }
type ExactOperation = { operation: str, target: str, exactFields: str }
pure def namedActionAllowed(review: DeviceReviewType, act: NamedAction): bool =
  if (review == NotesNamedReview) act == UpdateNamed or act == DeleteNamed
  else if (review == CalendarNamedReview) act == UpdateNamed or act == DeleteNamed or act == ReadNamed
  else if (review == ReminderNamedReview) act == UpdateNamed or act == CancelNamed
  else false
pure def namedTargetValid(t: NamedTarget): bool = namedActionAllowed(t.targetReview, t.namedAction) and t.recordName != ""
pure def exactOperationType(t: NamedTarget): str =
  if (t.targetReview == NotesNamedReview) (if (t.namedAction == UpdateNamed) "notes_update" else "notes_delete")
  else if (t.targetReview == CalendarNamedReview) (if (t.namedAction == ReadNamed) "calendar_read_selected" else if (t.namedAction == UpdateNamed) "calendar_update" else "calendar_delete")
  else if (t.namedAction == UpdateNamed) "reminder_update" else "reminder_cancel"
pure def resolveNamedTarget(t: NamedTarget, chosen: str): ExactOperation =
  { operation: exactOperationType(t), target: chosen, exactFields: if (t.namedAction == UpdateNamed) t.proposedFields else "" }
pure val tValues: Set[NamedTarget] = Set(
  { targetReview: NotesNamedReview, namedAction: UpdateNamed, recordName: "Groceries", proposedFields: "milk" },
  { targetReview: CalendarNamedReview, namedAction: ReadNamed, recordName: "Dentist", proposedFields: "" },
  { targetReview: ReminderNamedReview, namedAction: CancelNamed, recordName: "Call", proposedFields: "" },
  { targetReview: NotesNamedReview, namedAction: ReadNamed, recordName: "Groceries", proposedFields: "" })
pure def lawResolvedFieldsComeFromTheProposal(t: NamedTarget, chosen: str): bool =
  (namedTargetValid(t) and t.namedAction == UpdateNamed) implies resolveNamedTarget(t, chosen).exactFields == t.proposedFields
```

### A named-edit answer keeps the reviewed scope and the resolved operation

The answer names the same review, action and record name as the request.
It either reports no match, or reports the owner's choice with exactly the
operation the request resolves to on the chosen record.

```quint
type NamedAnswer = { answerReview: DeviceReviewType, answerAction: NamedAction, answerName: str, ownerChosen: bool, exact: ExactOperation }
pure def namedAnswerValid(t: NamedTarget, answer: NamedAnswer): bool =
  namedTargetValid(t) and answer.answerReview == t.targetReview and answer.answerAction == t.namedAction and answer.answerName == t.recordName and
  (not(answer.ownerChosen) or answer.exact == resolveNamedTarget(t, answer.exact.target))
pure val answerValues: Set[NamedAnswer] = Set(
  { answerReview: NotesNamedReview, answerAction: UpdateNamed, answerName: "Groceries", ownerChosen: true, exact: { operation: "notes_update", target: "note7", exactFields: "milk" } },
  { answerReview: NotesNamedReview, answerAction: UpdateNamed, answerName: "Groceries", ownerChosen: true, exact: { operation: "notes_update", target: "note7", exactFields: "eggs" } },
  { answerReview: NotesNamedReview, answerAction: DeleteNamed, answerName: "Groceries", ownerChosen: true, exact: { operation: "notes_delete", target: "note7", exactFields: "" } },
  { answerReview: NotesNamedReview, answerAction: UpdateNamed, answerName: "Groceries", ownerChosen: false, exact: { operation: "", target: "", exactFields: "" } })
pure def lawAnswerCannotChangeTheReviewedEdit(t: NamedTarget, answer: NamedAnswer): bool =
  (namedAnswerValid(t, answer) and answer.ownerChosen) implies
    (answer.exact.operation == exactOperationType(t) and answer.answerName == t.recordName and (t.namedAction == UpdateNamed implies answer.exact.exactFields == t.proposedFields))
```
