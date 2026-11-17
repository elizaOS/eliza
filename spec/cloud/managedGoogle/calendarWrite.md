# Managed calendar writes

The cloud creates, changes and deletes an owner's Google Calendar events on
the owner's or the agent's behalf. A change or deletion may name the event
revision it was read at, and is refused when the event has moved on since,
so nothing written over a newer revision is lost. A synced calendar's
writes go through the cloud's sync protocol, which always names the
expected revision and creates each event once per operation key. One event
and its revision are the state machine. Which calendar may be read is
[managed calendar reads](./calendarRead.md), keeping a copy current is
[calendar sync](./calendarSync.md), and the owner's calendar edits switch is
[the write switches](./accessSwitches.md).

## Story: Change an event only at the revision I read

> As an owner, I want my agent's change to an event to apply only to the
> version I last saw, to be told when the event changed in between, and to
> get the new revision back when it applied.

### A write needs calendar write access, and each answer is created, changed, deleted, not found or precondition failed

A write is refused before Google is asked when the connection does not hold
calendar write. Creating an event answers 201 with the event and its first
revision. Changing or deleting an event the calendar does not hold answers
404. A change or deletion that names a revision (`If-Match`) other than the
event's current one answers 412 `precondition_failed` and changes nothing;
one that names none, or the current one, applies. A change answers the
event with a new revision, also sent as the `ETag` header; a deletion
removes the event. An `If-Match` that is empty, `*`, a list, longer than
1,024 characters or not printable ASCII is refused as `invalid_if_match`
before anything else.

```quint
type EventAnswer = NoEventAnswer | EventCreated | EventReturned | EventChanged | EventDeleted | EventNotFound | EventPreconditionFailed | EventNotGranted | EventInvalidRevision
type CalendarEvent = {
  exists: bool, etag: int, content: int, writeGranted: bool, lastAnswer: EventAnswer,
  keyContent: int, creates: int, lastExpected: int, appliedOver: int
}
pure val initial: CalendarEvent = {
  exists: false, etag: 0, content: 0, writeGranted: true, lastAnswer: NoEventAnswer,
  keyContent: 0, creates: 0, lastExpected: -1, appliedOver: 0
}
pure def ifMatchValid(ifMatchSent: bool, ifMatch: int): bool = not(ifMatchSent) or ifMatch > 0
pure def conditionalAnswer(e: CalendarEvent, ifMatchSent: bool, ifMatch: int, success: EventAnswer): EventAnswer =
  if (not(ifMatchValid(ifMatchSent, ifMatch))) EventInvalidRevision
  else if (not(e.writeGranted)) EventNotGranted
  else if (not(e.exists)) EventNotFound
  else if (ifMatchSent and ifMatch != e.etag) EventPreconditionFailed
  else success
pure def canUpdateEvent(e: CalendarEvent, ifMatchSent: bool, ifMatch: int, content: int): bool = content > 0
pure def updateEvent(e: CalendarEvent, ifMatchSent: bool, ifMatch: int, content: int): CalendarEvent = {
  val answer = conditionalAnswer(e, ifMatchSent, ifMatch, EventChanged)
  if (answer == EventChanged)
    { ...e, etag: e.etag + 1, content: content, lastAnswer: answer, lastExpected: if (ifMatchSent) ifMatch else -1, appliedOver: e.etag }
  else { ...e, lastAnswer: answer }
}
pure def deleteEvent(e: CalendarEvent, ifMatchSent: bool, ifMatch: int): CalendarEvent = {
  val answer = conditionalAnswer(e, ifMatchSent, ifMatch, EventDeleted)
  if (answer == EventDeleted)
    { ...e, exists: false, etag: e.etag + 1, lastAnswer: answer, lastExpected: if (ifMatchSent) ifMatch else -1, appliedOver: e.etag }
  else { ...e, lastAnswer: answer }
}
pure def canChangeWriteGrant(e: CalendarEvent, granted: bool): bool = e.writeGranted != granted
pure def changeWriteGrant(e: CalendarEvent, granted: bool): CalendarEvent = { ...e, writeGranted: granted }
pure def canEditElsewhere(e: CalendarEvent): bool = e.exists
pure def editElsewhere(e: CalendarEvent): CalendarEvent = { ...e, etag: e.etag + 1, lastAnswer: NoEventAnswer }
pure val ifMatchValues = Set(0, 1, 2, 3)
pure val contentValues = Set(1, 2)
pure def alwaysAppliedChangeMatchedTheReadRevision(e: CalendarEvent): bool =
  (e.lastAnswer == EventChanged or e.lastAnswer == EventDeleted) implies (e.lastExpected == -1 or e.lastExpected == e.appliedOver)
pure def alwaysEventExistsOnlyWithARevision(e: CalendarEvent): bool = e.etag >= 0 and (e.exists implies e.etag > 0)
pure def stepRefusedWriteChangesNoEvent(before: CalendarEvent, after: CalendarEvent): bool =
  (after.lastAnswer == EventPreconditionFailed or after.lastAnswer == EventNotGranted or after.lastAnswer == EventNotFound or after.lastAnswer == EventInvalidRevision) implies
    (after.exists == before.exists and after.etag == before.etag and after.content == before.content and after.creates == before.creates)
pure def stepWriteNeedsTheGrant(before: CalendarEvent, after: CalendarEvent): bool =
  not(before.writeGranted) implies (after.exists == before.exists and after.content == before.content and after.creates == before.creates)
pure def stepChangeIssuesANewRevision(before: CalendarEvent, after: CalendarEvent): bool =
  (after.content != before.content or after.exists != before.exists) implies after.etag > before.etag
pure def sometimesStaleRevisionRefused(e: CalendarEvent): bool = e.lastAnswer == EventPreconditionFailed and e.exists
pure def sometimesChangedAtTheReadRevision(e: CalendarEvent): bool = e.lastAnswer == EventChanged and e.lastExpected > 0
pure def sometimesDeletedAtTheReadRevision(e: CalendarEvent): bool = e.lastAnswer == EventDeleted and e.lastExpected > 0
pure val weight_updateEvent = 3
```

## Story: Sync an event through the cloud with an operation key and an expected revision

> As an owner whose calendar is synced, I want each local event created at
> the provider once, however often the sync retries, and every later change
> to land only on the revision the sync last saw.

### Creating an event under an operation key happens once, and the key stays bound to its content

A sync create names an operation key, from which the cloud derives the
event's identity. The first create under a key makes a private event with
reminders off and answers it; a later create with the same key and the same
content answers that event again without making another, or not found if it
was deleted since; the same key with other content is refused as
`precondition_failed` and changes nothing. Discovered by the proof: the
count of events made under a key is never negative; without it, a first
create could not be shown to make exactly one event.

```quint
pure def canCreateEvent(e: CalendarEvent, content: int): bool = content > 0
pure def createEvent(e: CalendarEvent, content: int): CalendarEvent =
  if (not(e.writeGranted)) { ...e, lastAnswer: EventNotGranted }
  else if (e.keyContent == 0) { ...e, exists: true, etag: e.etag + 1, content: content, keyContent: content, creates: e.creates + 1, lastAnswer: EventCreated }
  else if (e.keyContent != content) { ...e, lastAnswer: EventPreconditionFailed }
  else if (e.exists) { ...e, lastAnswer: EventReturned }
  else { ...e, lastAnswer: EventNotFound }
pure def alwaysOneEventPerOperationKey(e: CalendarEvent): bool = e.creates >= 0 and e.creates <= 1 and ((e.creates == 1) iff (e.keyContent > 0))
pure def stepKeyStaysBoundToItsContent(before: CalendarEvent, after: CalendarEvent): bool =
  before.keyContent > 0 implies after.keyContent == before.keyContent
pure def sometimesRepeatedCreateReturnsTheEvent(e: CalendarEvent): bool = e.lastAnswer == EventReturned and e.creates == 1
pure val weight_createEvent = 2
```

### A sync request names an exact revision, and a sync reply is accepted only for the calendar and access it asked about

A sync request names the grant, which is a UUID, and the calendar. A read
names exactly one of the event ID and the operation key. A create carries
its operation key. A change or deletion carries the event ID and the
expected revision, which is one exact revision of at most 1,024 characters
and never `*`. Every reply is version 1, names the calendar asked about and
says the provider does not apply anything exactly once. Sync starts only
when the capabilities reply names the bound account and allows reading,
writing, keyed creation and conditional writes. A refusal is taken as the
cloud's own only when its status is 400, 403, 409, 412, 413 or 429, its
code is a calendar sync code, and it says the change was not accepted or
its precondition failed; anything else is an unknown outcome. A create is
accepted only when the event reads back private with reminders off, a
create or change only when Google's stored event reads back as exactly the
requested one, and a deletion only when the reply says it was deleted.

```quint
type SyncOperation = SyncCapabilities | SyncGet | SyncCreate | SyncUpdate | SyncDelete
type SyncRequest = { operation: SyncOperation, grantIsUuid: bool, calendarNamed: bool, eventIdNamed: bool, keyNamed: bool, expectedUnits: int, expectedIsStar: bool }
type SyncReply = { replyVersion: int, sameCalendar: bool, exactlyOnceDenied: bool }
type SyncAccess = { boundAccount: bool, canRead: bool, canWrite: bool, keyedCreate: bool, conditionalWrites: bool }
type SyncRefusal = { status: int, syncCode: bool, notAccepted: bool, preconditionFailed: bool }
type SyncWriteReadback = { privateEvent: bool, remindersOff: bool, matchesRequest: bool, deletedConfirmed: bool }
pure def exactRevision(r: SyncRequest): bool = r.expectedUnits >= 1 and r.expectedUnits <= 1024 and not(r.expectedIsStar)
pure def syncRequestAdmitted(r: SyncRequest): bool =
  r.grantIsUuid and r.calendarNamed and
  (if (r.operation == SyncCapabilities) true
   else if (r.operation == SyncGet) (r.eventIdNamed != r.keyNamed)
   else if (r.operation == SyncCreate) r.keyNamed
   else r.eventIdNamed and exactRevision(r))
pure def syncReplyAdmitted(reply: SyncReply): bool = reply.replyVersion == 1 and reply.sameCalendar and reply.exactlyOnceDenied
pure def syncAccessAdmitted(a: SyncAccess): bool = a.boundAccount and a.canRead and a.canWrite and a.keyedCreate and a.conditionalWrites
pure def refusalIsTheCloudsOwn(x: SyncRefusal): bool =
  (x.status == 400 or x.status == 403 or x.status == 409 or x.status == 412 or x.status == 413 or x.status == 429) and x.syncCode and (x.notAccepted or x.preconditionFailed)
pure def syncWriteAccepted(operation: SyncOperation, b: SyncWriteReadback): bool =
  if (operation == SyncCreate) b.privateEvent and b.remindersOff and b.matchesRequest
  else if (operation == SyncUpdate) b.matchesRequest
  else if (operation == SyncDelete) b.deletedConfirmed
  else true
pure val rValues = Set(
  { operation: SyncUpdate, grantIsUuid: true, calendarNamed: true, eventIdNamed: true, keyNamed: false, expectedUnits: 1024, expectedIsStar: false },
  { operation: SyncUpdate, grantIsUuid: true, calendarNamed: true, eventIdNamed: true, keyNamed: false, expectedUnits: 1, expectedIsStar: true },
  { operation: SyncDelete, grantIsUuid: true, calendarNamed: true, eventIdNamed: true, keyNamed: false, expectedUnits: 0, expectedIsStar: false },
  { operation: SyncGet, grantIsUuid: true, calendarNamed: true, eventIdNamed: true, keyNamed: true, expectedUnits: 0, expectedIsStar: false },
  { operation: SyncCreate, grantIsUuid: false, calendarNamed: true, eventIdNamed: false, keyNamed: true, expectedUnits: 0, expectedIsStar: false })
pure val replyValues = Set({ replyVersion: 1, sameCalendar: true, exactlyOnceDenied: true }, { replyVersion: 1, sameCalendar: false, exactlyOnceDenied: true }, { replyVersion: 2, sameCalendar: true, exactlyOnceDenied: true })
pure val xValues = Set({ status: 412, syncCode: true, notAccepted: false, preconditionFailed: true }, { status: 502, syncCode: true, notAccepted: true, preconditionFailed: false }, { status: 409, syncCode: false, notAccepted: true, preconditionFailed: false })
pure val aValues = Set({ boundAccount: true, canRead: true, canWrite: true, keyedCreate: true, conditionalWrites: true }, { boundAccount: true, canRead: true, canWrite: true, keyedCreate: true, conditionalWrites: false }, { boundAccount: false, canRead: true, canWrite: true, keyedCreate: true, conditionalWrites: true })
pure val bValues = Set({ privateEvent: true, remindersOff: true, matchesRequest: true, deletedConfirmed: false }, { privateEvent: false, remindersOff: true, matchesRequest: true, deletedConfirmed: true })
pure def lawConditionalSyncNeedsAnExactRevision(r: SyncRequest): bool =
  ((r.operation == SyncUpdate or r.operation == SyncDelete) and syncRequestAdmitted(r)) implies (exactRevision(r) and not(r.expectedIsStar))
pure def lawSyncReadNamesOneReference(r: SyncRequest): bool =
  (r.operation == SyncGet and syncRequestAdmitted(r)) implies (r.eventIdNamed != r.keyNamed)
pure def lawForeignCalendarReplyRefused(reply: SyncReply): bool = not(reply.sameCalendar) implies not(syncReplyAdmitted(reply))
pure def lawServerErrorIsNeverACleanRefusal(x: SyncRefusal): bool = x.status >= 500 implies not(refusalIsTheCloudsOwn(x))
pure def lawCreateConfirmsPrivacy(b: SyncWriteReadback): bool = syncWriteAccepted(SyncCreate, b) implies (b.privateEvent and b.remindersOff)
pure def lawSyncNeedsFullAccess(a: SyncAccess): bool = syncAccessAdmitted(a) implies (a.canWrite and a.conditionalWrites and a.keyedCreate)
```
