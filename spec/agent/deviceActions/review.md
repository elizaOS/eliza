# Foreground device review scope and exact local receipts

A device client publicly re-exports selected
`foreground-review-contract.ts` validators through
its device action runtime. That producer delegates
general operations and typed results to
`packages/contracts/src/device-reviews.ts`. The renderer uses
domain-specific Calendar, Notes and reminder schemas. This area
preserves negotiated grants, owner selection and receipt scope.
The [coordinator](./execution.md) handles claim,
journal and retry around these validators.

## Story: Review a local device record without changing the requested operation

> As a user, a review on my device shows the record the agent asked about,
> with the capability negotiated for it, and does not change what will be
> done.

### Every family requires its own negotiated capability

Calendar availability requires `calendar.availability-read.v1`.
Notes search requires `notes.search.v1` and `notes.local-record.v1`.
Named calendar read requires `calendar.named-read.v1` and its
selected-record capability. Named calendar writes and Notes edits
require `device.named-target.v1` and the named domain capability.
Named reminder operations admit v1 or v2 record capability alongside
the generic named-target grant. Timing fields require the reminder
timing capability. This is capability admission, independent of the
current owner and foreground screen checks.

```quint
type ReviewFamily = CalendarAvailability | NotesSearch | CalendarNamedRead | CalendarNamedWrite | NotesNamed | ReminderNamed
type ReviewCapabilities = {
  freeBusy: bool, notesSearch: bool, calendarReadNamed: bool, genericNamed: bool,
  calendarRecord: bool, notesRecord: bool, reminderV1: bool, reminderV2: bool, reminderTiming: bool
}
pure def permitsForegroundFamily(family: ReviewFamily, grants: ReviewCapabilities, requestsTiming: bool): bool =
  if (family == CalendarAvailability) grants.freeBusy
  else if (family == NotesSearch) grants.notesSearch and grants.notesRecord
  else if (family == CalendarNamedRead) grants.calendarReadNamed and grants.calendarRecord
  else if (family == CalendarNamedWrite) grants.genericNamed and grants.calendarRecord
  else if (family == NotesNamed) grants.genericNamed and grants.notesRecord
  else grants.genericNamed and (grants.reminderV1 or grants.reminderV2) and (not(requestsTiming) or grants.reminderTiming)
pure val allReviewGrants: ReviewCapabilities = {
  freeBusy: true, notesSearch: true, calendarReadNamed: true, genericNamed: true, calendarRecord: true,
  notesRecord: true, reminderV1: true, reminderV2: true, reminderTiming: true
}
pure val grantsValues = Set(allReviewGrants, {...allReviewGrants, genericNamed: false},
  {...allReviewGrants, calendarRecord: false}, {...allReviewGrants, notesRecord: false},
  {...allReviewGrants, reminderTiming: false})
pure def lawNamedCalendarReadOwnsRecordGrant(grants: ReviewCapabilities): bool =
  permitsForegroundFamily(CalendarNamedRead, grants, false) implies grants.calendarReadNamed and grants.calendarRecord
pure def lawTimingNeedsExplicitNegotiation(grants: ReviewCapabilities): bool =
  permitsForegroundFamily(ReminderNamed, grants, true) implies grants.reminderTiming
```

### No-match and owner-selected results retain their distinct evidence

A named receipt carries version 1, the same domain, requested
action, and name. A no-match receipt has no selected operation
or record. An owner-chosen receipt includes an exact selected
target. Resolving the original operation against that target must
reconstruct the same normalized operation and fields. Its record is
validated by the domain validator against the selected operation.
The guard evidence below is produced by those decoders. The
rendering label cannot stand in for any of the authoritative fields.

```quint
type NamedReceipt = { version: int, sameRequest: bool, noMatch: bool, ownerChosen: bool, hasOperation: bool, hasRecord: bool, exactFields: bool, recordValidated: bool }
pure def namedReceiptAllowed(r: NamedReceipt): bool =
  r.version == 1 and r.sameRequest and
  (if (r.noMatch) not(r.ownerChosen) and not(r.hasOperation) and not(r.hasRecord)
  else r.ownerChosen and r.hasOperation and r.hasRecord and r.exactFields and r.recordValidated)
pure val rValues = Set(
  {version: 1, sameRequest: true, noMatch: true, ownerChosen: false, hasOperation: false, hasRecord: false, exactFields: false, recordValidated: false},
  {version: 1, sameRequest: true, noMatch: false, ownerChosen: true, hasOperation: true, hasRecord: true, exactFields: true, recordValidated: true},
  {version: 1, sameRequest: true, noMatch: false, ownerChosen: true, hasOperation: true, hasRecord: true, exactFields: false, recordValidated: true}
)
pure def lawNamedMutationNeedsOwnerChoice(r: NamedReceipt): bool =
  namedReceiptAllowed(r) and r.hasRecord implies r.ownerChosen and r.hasOperation and r.exactFields and r.recordValidated
pure def lawNoMatchCannotCarryRecord(r: NamedReceipt): bool =
  namedReceiptAllowed(r) and r.noMatch implies not(r.hasRecord) and not(r.hasOperation)
```

## Story: Present a stored device receipt in the reviewed timezone

> As a user, a device receipt shows its time with the precision it was
> stored in and in the timezone I reviewed it in.

### Visible date precision follows the stored instant

A device client uses `formatDeviceRecordDateTime` in calendar availability,
device receipt and action review screens. It supplies the persisted
timestamp and reviewed timezone to the host formatter. The format
is English-US with a short timezone name. A nonzero UTC second
or millisecond includes seconds. A nonzero millisecond includes
three fractional digits. This rule checks the precision
selection. Locale formatting and timezone rules come from the host's
Intl implementation.

```quint
type DatePrecision = MinuteLabel | SecondLabel | MillisecondLabel
pure def receiptDatePrecision(seconds: int, milliseconds: int): DatePrecision =
  if (milliseconds != 0) MillisecondLabel else if (seconds != 0) SecondLabel else MinuteLabel
pure val secondsValues = Set(0, 1, 59)
pure val millisecondsValues = Set(0, 1, 999)
pure def lawFractionalReceiptRetainsPrecision(seconds: int, milliseconds: int): bool =
  milliseconds != 0 implies receiptDatePrecision(seconds, milliseconds) == MillisecondLabel
pure def lawMinuteReceiptHasNoExtraPrecision(seconds: int, milliseconds: int): bool =
  receiptDatePrecision(seconds, milliseconds) == MinuteLabel implies seconds == 0 and milliseconds == 0
```

## Story: Return only the availability window or Notes selection that was reviewed

> As a user, the agent gets back only the calendar window or the note I
> reviewed, never a broader list.

### Calendar receipts retain the exact window and bounded interval list

The availability operation covers at most seven days and names an
explicit timezone. The result repeats its requested start, end and
timezone, counts between one and sixteen approved calendars
without disclosing calendar identities, and includes at most 200
sorted busy intervals. Every interval is positive and lies
inside that window. The aggregate status is free exactly when the
busy interval list is empty. Transparent ignored events are
counted separately.

```quint
type FreeBusyReceipt = {
  version: int, matchesWindow: bool, windowStart: int, windowEnd: int,
  calendarCount: int, busyCount: int, sortedAndContained: bool, busyStatus: bool, ignored: int
}
pure def validFreeBusyReceipt(busyReceipt: FreeBusyReceipt): bool =
  busyReceipt.version == 1 and busyReceipt.matchesWindow and busyReceipt.windowEnd > busyReceipt.windowStart and busyReceipt.windowEnd - busyReceipt.windowStart <= 604800000 and
  busyReceipt.calendarCount >= 1 and busyReceipt.calendarCount <= 16 and busyReceipt.busyCount >= 0 and busyReceipt.busyCount <= 200 and
  busyReceipt.sortedAndContained and busyReceipt.busyStatus == (busyReceipt.busyCount > 0) and busyReceipt.ignored >= 0 and busyReceipt.ignored <= 200
pure val qualifiedBusy: FreeBusyReceipt = {
  version: 1, matchesWindow: true, windowStart: 0, windowEnd: 60000,
  calendarCount: 1, busyCount: 1, sortedAndContained: true, busyStatus: true, ignored: 0
}
pure val busyReceiptValues = Set(qualifiedBusy, {...qualifiedBusy, calendarCount: 17}, {...qualifiedBusy, matchesWindow: false},
  {...qualifiedBusy, busyStatus: false}, {...qualifiedBusy, busyCount: 0, busyStatus: false})
pure def lawBusyMeansReviewedWindow(busyReceipt: FreeBusyReceipt): bool =
  validFreeBusyReceipt(busyReceipt) and busyReceipt.busyStatus implies
    busyReceipt.matchesWindow and busyReceipt.sortedAndContained and busyReceipt.busyCount > 0
```

### A Notes search cannot substitute a list for a selected record

A Notes receipt repeats the exact normalized query. No-match has
neither titles nor a selected record. A titles query can return
only the reviewed titles within its bounded requested limit. A
content-match query requires an exact selected Notes record
validated against its target. The coordinator binds the eventual
private reply to the original receipt origin, proposal digest
and granted attempt.

```quint
type NotesProof = NotesNoMatch | NotesTitlesReviewed | NotesContentMatch
type NotesReviewReceipt = {
  version: int, exactQuery: bool, titlesQuery: bool, proof: NotesProof, count: int,
  limit: int, hasTargetAndRecord: bool, selectedRecordValid: bool
}
pure def validNotesReview(n: NotesReviewReceipt): bool =
  n.version == 1 and n.exactQuery and
  (if (n.proof == NotesNoMatch) n.count == 0 and not(n.hasTargetAndRecord)
  else if (n.proof == NotesTitlesReviewed) n.titlesQuery and n.count >= 1 and n.count <= n.limit and n.limit <= 50 and not(n.hasTargetAndRecord)
  else not(n.titlesQuery) and n.count == 0 and n.hasTargetAndRecord and n.selectedRecordValid)
pure val nValues = Set(
  {version: 1, exactQuery: true, titlesQuery: false, proof: NotesNoMatch, count: 0, limit: 0, hasTargetAndRecord: false, selectedRecordValid: false},
  {version: 1, exactQuery: true, titlesQuery: true, proof: NotesTitlesReviewed, count: 2, limit: 5, hasTargetAndRecord: false, selectedRecordValid: false},
  {version: 1, exactQuery: true, titlesQuery: false, proof: NotesContentMatch, count: 0, limit: 0, hasTargetAndRecord: true, selectedRecordValid: true}
)
pure def lawNotesRecordRequiresSelectedMatch(n: NotesReviewReceipt): bool =
  validNotesReview(n) and n.hasTargetAndRecord implies n.proof == NotesContentMatch and
    not(n.titlesQuery) and n.exactQuery and n.selectedRecordValid
```

## Story: Change only the file I reviewed

> As a user, when I approve a change to a file on my device, the change
> applies to the exact file I saw in the review. If the file was replaced in
> between, or the review was refreshed or abandoned, the replacement is left
> untouched.

### The review pins the identity it displayed, and a stale completion changes nothing

`client-coordinator.ts` owns the current review and its per-proposal identity
pin; `BrowserStorageVolume` compares that pin with the current storage object
before `BrowserFiles` commits a revision-checked change. Each refresh starts a
newer review. When the current review reads the file's identity, it pins it
(or keeps an existing pin), displays it and binds the proposal to it. A
completion for any review that is no longer the latest leaves the pin, the
displayed identity and the proposal as they were. A refresh never moves an
existing pin to another object.

```quint
type FilesReview = { latest: int, pin: int, displayed: int, proposalToken: int, file: int, dispatched: bool, dispatchToken: int, appliedFile: int }
pure val initial: FilesReview = { latest: 0, pin: -1, displayed: -1, proposalToken: -1, file: 0, dispatched: false, dispatchToken: -1, appliedFile: -1 }
pure def canStartReview(fr: FilesReview): bool = not(fr.dispatched)
pure def startReview(fr: FilesReview): FilesReview = { ...fr, latest: fr.latest + 1 }
pure def canIdentityReturns(fr: FilesReview, review: int): bool = review >= 1 and review <= fr.latest
pure def identityReturns(fr: FilesReview, review: int): FilesReview = {
  val token = if (fr.pin >= 0) fr.pin else fr.file
  if (review != fr.latest) fr else { ...fr, pin: token, displayed: token, proposalToken: token }
}
pure val reviewValues = Set(1, 2, 3)
pure def canReplaceFile(fr: FilesReview): bool = fr.file == 0
pure def replaceFile(fr: FilesReview): FilesReview = { ...fr, file: 1 }
pure def alwaysPinMatchesDisplayedIdentity(fr: FilesReview): bool = fr.pin == fr.displayed
pure def alwaysProposalUsesThePin(fr: FilesReview): bool = fr.proposalToken >= 0 implies fr.proposalToken == fr.pin
pure def stepRefreshKeepsThePin(before: FilesReview, after: FilesReview): bool = (before.pin >= 0 and after.pin >= 0) implies after.pin == before.pin
pure val frValues = Set(initial, { ...initial, latest: 2 }, { ...initial, latest: 2, pin: 0, displayed: 0, proposalToken: 0, file: 1 })
pure def lawStaleCompletionChangesNothing(fr: FilesReview, review: int): bool = review != fr.latest implies identityReturns(fr, review) == fr
```

### One dispatch changes the reviewed object or nothing

The claim, journal and server admission are preconditions outside this model.
A single dispatch compares the preserved review token with the current object:
it changes the object only when they match, and leaves a replacement untouched.

```quint
pure def canDispatchChange(fr: FilesReview): bool = not(fr.dispatched) and fr.proposalToken >= 0
pure def dispatchChange(fr: FilesReview): FilesReview =
  { ...fr, dispatched: true, dispatchToken: fr.proposalToken, appliedFile: if (fr.file == fr.proposalToken) fr.file else -1 }
pure def alwaysOnlyTheReviewedObjectChanges(fr: FilesReview): bool = fr.appliedFile >= 0 implies fr.appliedFile == fr.dispatchToken
pure def sometimesReviewedFileChanged(fr: FilesReview): bool = fr.dispatched and fr.appliedFile == 0
pure def sometimesReplacementLeftUntouched(fr: FilesReview): bool = fr.dispatched and fr.appliedFile == -1 and fr.file == 1
```
