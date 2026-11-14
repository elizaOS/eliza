# Foreground device review scope and exact local receipts

Alpha publicly re-exports selected
`foreground-review-contract.ts` validators through
`apps/app/src/runtime/device-actions.ts`. That producer delegates
general operations and typed results to
`packages/contracts/src/device-reviews.ts`. The renderer uses
domain-specific Calendar, Notes and reminder schemas. This area
preserves negotiated grants, owner selection and receipt scope.
The [coordinator](./mobileDeviceExecution.md) handles claim,
journal and retry around these validators.

## Story: Review a local device record without changing the requested operation

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

### Visible date precision follows the stored instant

Alpha uses `formatDeviceRecordDateTime` in calendar availability,
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
