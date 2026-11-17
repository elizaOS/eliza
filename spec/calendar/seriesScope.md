# Calendar event and series scope

This contract covers what a Calendar write or deletion may touch: the
exact event, one occurrence, or its whole series. A device calendar
receives only an admitted, inspected target. The app's own document
Calendar turns an occurrence into an override or an exclusion under its
series and keeps a queued deletion in one document transaction. The
deletion window comes from [contracts](../os/index.md).
[Availability](./availability.md) owns recurrence read expansion. Device
provider snapshots, tickets and the durable dispatch journal are
separate producers ([device calendar deletion](../os/index.md)).

The linked OS contracts are being rebuilt. Their detailed models and execution
evidence remain pending.

## Story: Delete the exact Calendar event or scope I selected

> As the owner, I want deleting to remove exactly the event, occurrence or
> series part I chose, and to be told only what the calendar confirmed.

### Transfer only the admitted target to the device calendar

The renderer projects a row under the exact event ID and occurrence
begin. Opening the row for agent selection first tries the ordinary
inspection. On the device calendar, a non-ready response permits a scoped
deletion inspection of that same row. It publishes the returned
event ID when present or the row event ID otherwise, row calendar
ID, event revision and source revision. An owner, open row or
inspection generation change drops the asynchronous result.

For manual deletion, one Calendar save operation may run at a time.
An unresolved write holds its event ID only. Request scoped device
inspection with the selected row's event ID, calendar ID, title,
body, location, start and end. Default delete omits scope; the device
calendar chooses an event or occurrence. The user can explicitly choose
series deletion on a repeating device row. Complex, non-local,
all-day and repeating native edit goes to the external Calendar
editor with the exact event ID and begin and end. A native
inspection response requiring external review goes there too.

On an inspection result, check the captured owner and whether
its row is still open before proceeding. A ready device response
sends exactly its event ID, source ID, source revision and event
revision to the scoped removal; the renderer never reconstructs a
target. An external inspection
opens Calendar. Other inspection failures ask for refresh. Native
inspection and review enforce their own permission, the inspected ticket and
provider identity requirements.

```quint
type DeleteScope = DefaultScope | EntireSeries
type InspectStatus = TargetReady | ExternalTarget | TargetChanged
type InspectRoute = IgnoreInspection | OpenExternal | RefreshRows | SendScoped
type InspectedTicket = { eventKey: int, sourceKey: int, sourceRevision: int, eventRevision: int }
type OpenSelection = { owner: int, generation: int, openRow: int }
pure def inspectPublishes(captured: OpenSelection, active: OpenSelection, inspectionReady: bool): bool =
  inspectionReady and captured.owner == active.owner and captured.generation == active.generation and captured.openRow == active.openRow
pure def manualInspectionRoute(captured: OpenSelection, active: OpenSelection, inspected: InspectStatus): InspectRoute =
  if (captured.owner != active.owner or captured.openRow != active.openRow) IgnoreInspection
  else if (inspected == TargetReady) SendScoped
  else if (inspected == ExternalTarget) OpenExternal
  else RefreshRows
pure def deleteScope(recurring: bool, pickedSeries: bool): DeleteScope =
  if (recurring and pickedSeries) EntireSeries else DefaultScope
pure def localInlineEdit(local: bool, appAccount: bool, recurring: bool, allDay: bool, complexTiming: bool): bool =
  local and appAccount and not(recurring or allDay or complexTiming)
pure def scopedArguments(inspectedTicket: InspectedTicket): InspectedTicket = inspectedTicket
pure def lawSeriesScopeRequiresChoice(recurring: bool, pickedSeries: bool): bool =
  deleteScope(recurring, pickedSeries) == EntireSeries implies recurring and pickedSeries
pure def lawStaleInspectionCannotDispatch(captured: OpenSelection, active: OpenSelection, inspected: InspectStatus): bool =
  captured.owner != active.owner or captured.openRow != active.openRow implies manualInspectionRoute(captured, active, inspected) == IgnoreInspection
pure def lawAgentSelectionChecksGeneration(captured: OpenSelection, active: OpenSelection, inspectionReady: bool): bool =
  captured.generation != active.generation implies not(inspectPublishes(captured, active, inspectionReady))
pure val capturedValues = Set(
  { owner: 1, generation: 1, openRow: 1 }, { owner: 1, generation: 2, openRow: 1 },
  { owner: 1, generation: 2, openRow: 2 }, { owner: 2, generation: 2, openRow: 1 })
pure val activeValues = capturedValues
pure val inspectedTicketValues = Set(
  { eventKey: 1, sourceKey: 1, sourceRevision: 2, eventRevision: 3 },
  { eventKey: 2, sourceKey: 1, sourceRevision: 1, eventRevision: 4 })
```

### An uncertain delete holds its event until a complete read settles it

Only the captured owner adopts a reply. A queued reply does not prove
deletion; only a verified deleted reply does. A refusal before the
mutation was invoked leaves nothing uncertain, but an unknown result or a
failure after invocation holds the captured event: no further write to it
until a requested or forced read settles it. A complete read clears the
hold if it lists the event, or for a deletion if its range covers the
event's start, end exclusive. A truncated read, an ordinary read or another
range does not. Clearing the hold is not a provider deletion receipt.

```quint
type DeleteReply = QueuedReply | DeletedReply | ConflictReply | CancelledReply | UnknownReply | BeforeBridgeFault | AfterBridgeFault | OtherRefusal
type DeleteOutcome = { markUncertain: bool, deletedEvidence: bool }
type CalendarWriteKind = EditWrite | DeleteWrite
pure def deleteOutcome(sameOwner: bool, reply: DeleteReply): DeleteOutcome =
  { markUncertain: reply == AfterBridgeFault or (sameOwner and reply == UnknownReply),
    deletedEvidence: sameOwner and reply == DeletedReply }
pure def blockedByWrite(saving: bool, eventKey: int, uncertainEvent: int): bool =
  saving or (uncertainEvent > 0 and uncertainEvent == eventKey)
pure def readClearsHold(kind: CalendarWriteKind, readAccepted: bool, requestedOrForced: bool, complete: bool, listsEvent: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  readAccepted and requestedOrForced and complete and (listsEvent or (kind == DeleteWrite and begin >= rangeBegin and begin < rangeEnd))
pure def lawQueueHasNoDeleteReceipt(sameOwner: bool): bool = not(deleteOutcome(sameOwner, QueuedReply).deletedEvidence)
pure def lawPreBridgeFaultDoesNotFence(sameOwner: bool): bool = not(deleteOutcome(sameOwner, BeforeBridgeFault).markUncertain)
pure def lawAnotherEventCanProceed(saving: bool, eventKey: int, uncertainEvent: int): bool =
  not(saving) and eventKey != uncertainEvent implies not(blockedByWrite(saving, eventKey, uncertainEvent))
pure def lawUnrelatedReadKeepsHold(kind: CalendarWriteKind, readAccepted: bool, requestedOrForced: bool, complete: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  (begin < rangeBegin or begin >= rangeEnd) implies not(readClearsHold(kind, readAccepted, requestedOrForced, complete, false, begin, rangeBegin, rangeEnd))
pure def lawTruncatedReadKeepsHold(kind: CalendarWriteKind, readAccepted: bool, requestedOrForced: bool, listsEvent: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  not(readClearsHold(kind, readAccepted, requestedOrForced, false, listsEvent, begin, rangeBegin, rangeEnd))
pure def lawEditAbsenceCannotResolve(readAccepted: bool, requestedOrForced: bool, complete: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  not(readClearsHold(EditWrite, readAccepted, requestedOrForced, complete, false, begin, rangeBegin, rangeEnd))
pure val beginValues = Set(0, 1, 2, 3)
pure val rangeBeginValues = Set(0, 1)
pure val rangeEndValues = Set(2, 3)
```

## Story: Change one occurrence without changing its siblings

> As the owner, I want an edit to one occurrence of a repeating event to
> leave the other occurrences as they were.

### An occurrence becomes a standalone override or an exclusion under its series

This is the app's own document Calendar, used where no device
calendar holds the event. Its recurrence behavior describes that
document's local model; a device calendar applies its own series rules.

A generated occurrence is keyed by series ID and resolved start.
Existing stored rows take precedence over computed rows. Editing a
generated or existing occurrence saves a row under that same
occurrence ID, retains its original occurrence start and series ID,
sets repeat to Once and removes any exclusions from the override.
The parent keeps its content and receives the new revision.
This also rotates when an existing occurrence's response changes. A
dependent mutation with no parent fails. Deleting one occurrence
removes its override if present, adds its original occurrence
start to the parent's distinct exclusions, and rotates the
parent revision. Deleting the series removes the parent and its
stored overrides. Other rows stay in their original order.

Whole-series edit or delete begins from a selected occurrence
and checked revision, finds the parent and requests explicit
scope review. Editing then reopens the same parent revision and
checks it again at save. Removal checks both parent revision and
selected occurrence revision again inside the staging transaction.
Changing the series to Once removes its exclusions and detaches
the existing overrides into standalone events with new revisions.
Moving or changing a still repeating series preserves both deleted
dates and edited dates as exclusions. Take each date's civil-day
offset from the old series anchor in the old zone, add it to the
new series wall time and resolve in the new zone with the same
forward-gap policy as the range expander. All-day uses UTC at
each side. Deduplicate the resolved exclusions. The moved
parent does not move the overrides' own times.

```quint
type SeriesRow = { id: int, parent: int, originalStart: int, start: int, revision: int, repeats: bool, excluded: List[int] }
pure def occurrenceOverride(row: SeriesRow, newStart: int, newRevision: int): SeriesRow =
  { ...row, start: newStart, revision: newRevision, repeats: false, excluded: List() }
pure def appendStart(starts: List[int], atStart: int): List[int] = starts.append(atStart)
pure def excludeStart(starts: List[int], atStart: int): List[int] =
  if (starts.includes(atStart)) starts else appendStart(starts, atStart)
pure def excludeOccurrence(parentRow: SeriesRow, occurrence: SeriesRow, newRevision: int): SeriesRow =
  { ...parentRow, revision: newRevision, excluded: excludeStart(parentRow.excluded, occurrence.originalStart) }
pure def detachOccurrence(row: SeriesRow, newRevision: int): SeriesRow =
  { ...row, parent: 0, originalStart: 0, revision: newRevision }
pure def deleteSeriesRows(rows: List[SeriesRow], seriesId: int): List[SeriesRow] =
  rows.select(row => row.id != seriesId and row.parent != seriesId)
pure def movedWall(oldAnchorCivil: int, oldExcludedCivil: int, nextWall: int): int =
  nextWall + oldExcludedCivil - oldAnchorCivil
pure def explicitSeriesScope(occurrenceExact: bool, parentFound: bool, confirmed: bool): bool =
  occurrenceExact and parentFound and confirmed
pure def stageSeriesAllowed(occurrenceExact: bool, parentFound: bool, confirmed: bool, latestOccurrenceExact: bool, latestParentExact: bool): bool =
  explicitSeriesScope(occurrenceExact, parentFound, confirmed) and latestOccurrenceExact and latestParentExact
pure def lawOverrideKeepsOriginal(row: SeriesRow, newStart: int, newRevision: int): bool =
  val saved = occurrenceOverride(row, newStart, newRevision)
  saved.id == row.id and saved.parent == row.parent and saved.originalStart == row.originalStart and
  saved.revision == newRevision and saved.start == newStart and not(saved.repeats)
pure def lawOnceDetachesWithoutMoving(row: SeriesRow, newRevision: int): bool =
  val detached = detachOccurrence(row, newRevision)
  detached.id == row.id and detached.parent == 0 and detached.start == row.start
pure def lawSeriesMovePreservesCivilDelta(oldAnchorCivil: int, oldExcludedCivil: int, nextWall: int): bool =
  movedWall(oldAnchorCivil, oldExcludedCivil, nextWall) - nextWall == oldExcludedCivil - oldAnchorCivil
pure def lawSeriesDeleteRechecksBoth(occurrenceExact: bool, parentFound: bool, confirmed: bool, latestOccurrenceExact: bool, latestParentExact: bool): bool =
  not(latestOccurrenceExact and latestParentExact) implies
  not(stageSeriesAllowed(occurrenceExact, parentFound, confirmed, latestOccurrenceExact, latestParentExact))
pure val rowValues = Set(
  { id: 1, parent: 0, originalStart: 0, start: 1, revision: 1, repeats: true, excluded: List(2) },
  { id: 2, parent: 1, originalStart: 3, start: 4, revision: 2, repeats: false, excluded: List() },
  { id: 4, parent: 0, originalStart: 0, start: 5, revision: 2, repeats: false, excluded: List() })
pure val parentRowValues = rowValues
pure val occurrenceValues = rowValues
pure val rowsValues = Set(List(),
  List({ id: 1, parent: 0, originalStart: 0, start: 1, revision: 1, repeats: true, excluded: List(2) },
    { id: 2, parent: 1, originalStart: 3, start: 4, revision: 2, repeats: false, excluded: List() }))
pure val startsValues = Set(List(), List(1), List(2, 3))
```

### A pending deletion guards the same row until transaction settlement

After a confirmed review, Calendar stages a cloned row, source
revision, scope, owner, operation ID and deletion deadline inside
the Calendar document. Staging leaves events intact. A queued or
paused entry blocks a new deletion of that row, deleting its
parent from a pending occurrence, or deleting an occurrence
covered by a pending parent-series deletion. Distinct sibling
occurrences can both be queued. Duplicate journal IDs are
refused. The document trims oldest definite entries to 127 before
admitting, retains unresolved and unknown entries, and fails if
500 entries still remain before admission. A manual owner is
bound to the source revision. An agent owner must match its
current binding for dispatch, while the same enrolled owner
can Undo after session restart. The fact comparison for Undo
binds origin, owner, agent, installation and enrollment; dispatch
includes exact session as well. An agent delete carries the
proposal binding and operation digest, and a replay under a
retained claim reports unknown.

The shared deadline provides a 10-second monotonic window from
the same renderer. The wall timestamp is for display. Only a
queued entry with a proven expired window reaches settlement.
A changed owner pauses it. A changed source or row marks conflict.
An expired entry claims dispatch within the same document
transaction that removes the row or adds its exclusion and
records the deleted receipt. A failed compare-and-exchange does
not leave a separate persisted dispatch claim from this body.

Stored rows compare exactly. A computed occurrence compares all
its fields except the copied parent revision and excluded start
list, so one sibling settling does not invalidate another.
Any actual content change, replacement or disappearance still
conflicts. The common document mutation guard rejects a changed
row or source while its deletion phase remains queued or paused.
Settlement rereads each row after prior sibling settlement.
The polling read and the locked callback both require an expired
entry. An empty callback after a concurrent winner cannot mint a
document revision.

An owned already-undone entry returns the same receipt. Undo
can claim a queued entry during its open window or after clock
continuity is lost, and a paused entry can be cancelled even
when its prior deadline elapsed. A queued expired entry cannot
be undone. Clock discontinuity alone does not advance the document
entry to paused, and cannot authorize dispatch.

```quint
type DeletePhase = DeleteQueued | DeletePaused | DeleteDispatching | DeleteUndone | DeleteDeleted | DeleteConflict | DeleteUnknown
type DeadlineView = WindowOpen | WindowExpired | ClockChanged
type DeleteDecision = KeepEntry | PauseEntry | ConflictEntry | CommitDelete
type RowMatch = { existsNow: bool, existed: bool, computedNow: bool, exactBytes: bool, ownBytes: bool }
pure def unresolvedDeletion(phase: DeletePhase): bool = phase == DeleteQueued or phase == DeletePaused
pure def blocksSiblingOrParent(phase: DeletePhase, targetId: int, targetParent: int, targetSeries: bool, newId: int, newParent: int): bool =
  unresolvedDeletion(phase) and (targetId == newId or (targetParent > 0 and targetParent == newId) or (targetSeries and targetId == newParent))
pure def sameStoredRow(rowMatch: RowMatch): bool =
  if (rowMatch.computedNow and rowMatch.existsNow and rowMatch.existed) rowMatch.ownBytes
  else rowMatch.exactBytes
pure def deletionSettlement(phase: DeletePhase, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): DeleteDecision =
  if (phase != DeleteQueued or windowView != WindowExpired) KeepEntry
  else if (not(ownerCurrent)) PauseEntry
  else if (not(sourceCurrent) or not(rowMatch.existsNow) or not(sameStoredRow(rowMatch))) ConflictEntry
  else CommitDelete
pure def deletionUndo(phase: DeletePhase, windowView: DeadlineView, ownerVisible: bool): bool =
  ownerVisible and (phase == DeleteUndone or phase == DeletePaused or (phase == DeleteQueued and windowView != WindowExpired))
pure def allowsPendingWrite(phase: DeletePhase, phaseUnchanged: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  not(unresolvedDeletion(phase) and phaseUnchanged) or (sourceCurrent and sameStoredRow(rowMatch))
pure def mayStageDeletion(existingId: bool, pendingTarget: bool, retainedCount: int): bool =
  not(existingId or pendingTarget) and retainedCount >= 0 and retainedCount < 500
pure def afterTerminalTrim(terminalCount: int): int =
  if (terminalCount <= 127) terminalCount else 127
pure def lawDispatchRequiresExactSource(phase: DeletePhase, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  deletionSettlement(phase, windowView, ownerCurrent, sourceCurrent, rowMatch) == CommitDelete implies
  phase == DeleteQueued and windowView == WindowExpired and ownerCurrent and sourceCurrent and rowMatch.existsNow and sameStoredRow(rowMatch)
pure def lawClockChangeCannotDispatch(phase: DeletePhase, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  deletionSettlement(phase, ClockChanged, ownerCurrent, sourceCurrent, rowMatch) == KeepEntry
pure def lawExpiredQueueCannotUndo(ownerVisible: bool): bool =
  not(deletionUndo(DeleteQueued, WindowExpired, ownerVisible))
pure def lawPendingGuardStopsContentChange(phase: DeletePhase, rowMatch: RowMatch): bool =
  unresolvedDeletion(phase) and not(sameStoredRow(rowMatch)) implies not(allowsPendingWrite(phase, true, true, rowMatch))
pure def lawDistinctOccurrencesMayQueue(phase: DeletePhase, targetId: int, targetParent: int, newId: int): bool =
  targetId != newId and targetParent != newId implies not(blocksSiblingOrParent(phase, targetId, targetParent, false, newId, targetParent))
pure def lawPendingOccurrenceBlocksParent(phase: DeletePhase, targetId: int, targetParent: int): bool =
  unresolvedDeletion(phase) and targetParent > 0 implies blocksSiblingOrParent(phase, targetId, targetParent, false, targetParent, 0)
pure val rowMatchValues = Set(
  { existsNow: true, existed: true, computedNow: true, exactBytes: false, ownBytes: true },
  { existsNow: true, existed: true, computedNow: true, exactBytes: false, ownBytes: false },
  { existsNow: true, existed: true, computedNow: false, exactBytes: true, ownBytes: true },
  { existsNow: false, existed: true, computedNow: false, exactBytes: false, ownBytes: false })
pure val retainedCountValues = Set(0, 127, 499, 500)
```

### Publish a deletion only with the committed document

The staged row and event survive a failed document write. A fully
committed delete changes the Calendar row and receipt together.
The captured source and row are compared before each commit, and a
failed compare and exchange changes nothing. The provider mutation is
outside this document transaction.

```quint
type DeleteTx = { phase: DeletePhase, staged: bool, eventPresent: bool, writes: int }
pure val initial: DeleteTx = { phase: DeleteUndone, staged: false, eventPresent: true, writes: 0 }
pure def canQueueDelete(s: DeleteTx): bool = not(s.staged) and s.eventPresent
pure def queueDelete(s: DeleteTx): DeleteTx = { ...s, staged: true, phase: DeleteQueued }
pure def canCommitDelete(s: DeleteTx, windowView: DeadlineView): bool =
  s.staged and s.phase == DeleteQueued and windowView == WindowExpired
pure def commitDelete(s: DeleteTx, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch, casSaved: bool): DeleteTx =
  val decision = deletionSettlement(s.phase, windowView, ownerCurrent, sourceCurrent, rowMatch)
  if (not(casSaved)) s
  else if (decision == PauseEntry) { ...s, phase: DeletePaused }
  else if (decision == ConflictEntry) { ...s, phase: DeleteConflict }
  else if (decision == CommitDelete) { ...s, phase: DeleteDeleted, eventPresent: false, writes: s.writes + 1 }
  else s
pure def canCancelDelete(s: DeleteTx, windowView: DeadlineView, ownerVisible: bool): bool =
  s.staged and deletionUndo(s.phase, windowView, ownerVisible)
pure def cancelDelete(s: DeleteTx, windowView: DeadlineView, ownerVisible: bool): DeleteTx =
  { ...s, phase: DeleteUndone }
pure def alwaysReceiptMatchesWrite(s: DeleteTx): bool =
  if (s.phase == DeleteDeleted) not(s.eventPresent) and s.writes == 1 else s.eventPresent and s.writes == 0
pure def alwaysOnlyStagedCanBeDeleted(s: DeleteTx): bool =
  s.phase == DeleteDeleted implies s.staged
pure def stepDeleteSettlesOnce(before: DeleteTx, via: str, after: DeleteTx): bool =
  after.writes > before.writes implies via == "commitDelete" and before.phase == DeleteQueued
pure def sometimesDeleted(s: DeleteTx): bool = s.phase == DeleteDeleted
pure def sometimesUndone(s: DeleteTx): bool = s.staged and s.phase == DeleteUndone
pure def sometimesPaused(s: DeleteTx): bool = s.phase == DeletePaused
pure val weight_commitDelete = 10
pure val weight_cancelDelete = 5
```
