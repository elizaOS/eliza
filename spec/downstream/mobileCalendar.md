# Grace calendar read, review and guarded edits

Grace's `DeviceCalendarPlugin.java` imports `CalendarReadAccess`,
`CalendarDestinations`, `CalendarEventOptions` and
`CalendarEventEdits` from pinned Eliza's `plugin-native-calendar`.
Alpha's `AlphaCalendarPlugin.java` uses the same producer module
through a distinct calendar bridge with workflow availability,
per-operation execution and scoped deletion. This file captures
Grace's direct edit path and its shared atomic event guard. Alpha's
workflow and agent calendars use this as an adapter boundary rather
than granting the direct Grace surface authority.

## Story: Read calendar events and open the Android editor for review

### Reading uses a bounded range and editor dispatch confers no write receipt

Grace's list checks permission both before provider I/O and before
returning the events. A read covers a positive range of at most
370 days and reports revisions for stale-edit protection. The
separate review route opens Android's native editor without gaining
provider write permission. A dispatch receipt says only that the
editor opened. Native host parsing establishes event time, title
and all-day UTC date semantics before provider admission.

```quint
type CalendarDecision = RangeAllowed | InvalidRange | PermissionDenied | EditorDispatched | EditorUnavailable
pure def listCalendarDecision(startMs: int, endMs: int, permissionBefore: bool, permissionAfter: bool): CalendarDecision =
  if (not(permissionBefore)) PermissionDenied
  else if (startMs < 0 or endMs <= startMs or endMs - startMs > 31968000000 or endMs > 9007199254740991) InvalidRange
  else if (not(permissionAfter)) PermissionDenied
  else RangeAllowed
pure def reviewCalendarEditor(validEvent: bool, opened: bool): CalendarDecision =
  if (not(validEvent)) InvalidRange else if (opened) EditorDispatched else EditorUnavailable
pure val startMsValues = Set(0, 100, 31968000000)
pure val endMsValues = Set(0, 101, 31968000000, 31968000001)
pure def lawCalendarReadNeedsCurrentPermission(startMs: int, endMs: int, permissionBefore: bool, permissionAfter: bool): bool =
  listCalendarDecision(startMs, endMs, permissionBefore, permissionAfter) == RangeAllowed implies
    startMs >= 0 and endMs > startMs and endMs - startMs <= 31968000000 and permissionBefore and permissionAfter
```

## Story: Change exactly the calendar event the user reviewed

### The provider compares both rows atomically before editing or deleting

A snapshot has the event ID, calendar, current revision, write
eligibility and recurrence. The revision represents all fields
asserted in the provider batch. A missing row, read-only calendar,
repeating event or changed revision refuses the operation without
mutation. If a race happens after initial admission, the batch's
assertions still refuse it. A successful update preserves the
calendar, sets event end and clears duration. An update whose
subsequent readback is unavailable returns an error even though
the provider has changed. Deleting returns success only after the
batch succeeded. This is one event row. Its creation and unrelated
rows are external producer operations.

```quint
type EditPhase = ReviewIdle | PendingEdit | RefusedEdit | CommittedEdit | MissingReadback
type EditKind = UpdateOne | DeleteOne
type CalendarRow = { present: bool, writable: bool, repeating: bool, revision: int }
type CalendarEdit = { row: CalendarRow, expectedRevision: int, selectedEdit: EditKind, phase: EditPhase, committedCount: int }
pure val originalRow: CalendarRow = {present: true, writable: true, repeating: false, revision: 1}
pure val initial: CalendarEdit = {row: originalRow, expectedRevision: 0, selectedEdit: UpdateOne, phase: ReviewIdle, committedCount: 0}
pure def exactWritableRow(edit: CalendarEdit): bool =
  edit.row.present and edit.row.writable and not(edit.row.repeating) and
  edit.expectedRevision > 0 and edit.expectedRevision == edit.row.revision
pure def canAskEdit(edit: CalendarEdit, expectedRevision: int): bool =
  edit.phase != PendingEdit and expectedRevision > 0
pure def askEdit(edit: CalendarEdit, expectedRevision: int, kind: EditKind, permitted: bool): CalendarEdit = {
  val asked = {...edit, expectedRevision: expectedRevision, selectedEdit: kind}
  {...asked, phase: if (permitted and exactWritableRow(asked)) PendingEdit else RefusedEdit}
}
pure val expectedRevisionValues = Set(0, 1, 2, 3)
pure def changeProvider(edit: CalendarEdit, rowStillPresent: bool, calendarWritable: bool, nowRepeating: bool): CalendarEdit = {
  ...edit, row: {
    present: rowStillPresent, writable: calendarWritable, repeating: nowRepeating,
    revision: edit.row.revision + 1
  }
}
pure def canFinishEdit(edit: CalendarEdit): bool = edit.phase == PendingEdit
pure def finishEdit(edit: CalendarEdit, providerAccepted: bool, readbackAvailable: bool): CalendarEdit =
  if (not(exactWritableRow(edit)) or not(providerAccepted)) {...edit, phase: RefusedEdit}
  else {
    ...edit,
    row: {...edit.row, present: edit.selectedEdit != DeleteOne, revision: edit.row.revision + 1},
    phase: if (edit.selectedEdit == DeleteOne or readbackAvailable) CommittedEdit else MissingReadback,
    committedCount: edit.committedCount + 1
  }
pure def alwaysCalendarRevisionPositive(edit: CalendarEdit): bool = edit.row.revision > 0 and edit.committedCount >= 0
pure def stepCalendarCommitChecksExactRevision(before: CalendarEdit, via: str, after: CalendarEdit): bool =
  after.committedCount > before.committedCount implies via == "finishEdit" and before.phase == PendingEdit and exactWritableRow(before)
pure def sometimesCalendarCommit(edit: CalendarEdit): bool = edit.phase == CommittedEdit
pure def sometimesCalendarReadbackFailure(edit: CalendarEdit): bool = edit.phase == MissingReadback
```
