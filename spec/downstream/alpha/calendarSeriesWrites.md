# Alpha Calendar event and series writes

AlphaPhone pin `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` owns
`apps/app/src/prototype/calendar-adapter.ts` and
`apps/app/src/browser/{calendar,calendar-records,calendar-deletions,calendar-store,journal-retention}.ts`.
Eliza gitlink `c518127a025ab173874af9c7d304f26b25213b0d` supplies
`packages/contracts/src/deletion-window.ts`. This contract covers
Android renderer handoff and fallback, browser development recurrence
mutation, and the browser document's queued deletion transaction.
The Calendar availability data story owns recurrence read expansion.
Android provider snapshots, tickets and the native durable dispatch
journal are separate producers.

## Story: Delete the exact Calendar event or scope I selected

### Transfer only the admitted target to Android

The renderer projects a row under the exact event ID and occurrence
begin. Opening the row for agent selection first tries the ordinary
inspection. On Android, a non-ready response permits a scoped
deletion inspection of that same row. It publishes the returned
event ID when present or the row event ID otherwise, row calendar
ID, event revision and source revision. An owner, open row or
inspection generation change drops the asynchronous result.

For manual deletion, one Calendar save operation may run at a time.
An unresolved write holds its event ID only. Request scoped Android
inspection with the selected row's event ID, calendar ID, title,
body, location, start and end. Default delete omits scope; Android
chooses an event or occurrence. The user can explicitly choose
series deletion on a repeating Android row. Complex, non-local,
all-day and repeating native edit goes to the external Calendar
editor with the exact event ID and begin and end. A native
inspection response requiring external review goes there too.

On an inspection result, check the captured owner and whether
its row is still open before proceeding. A ready Android response
sends exactly its event ID, source ID, source revision and event
revision to `removeScoped`. The renderer neither reconstructs a
target nor uses the legacy remove call. An external inspection
opens Calendar. Other inspection failures ask for refresh. Native
inspection and review enforce their own permission, the inspected ticket and
provider identity requirements.

```quint
type AndroidScope = DefaultScope | EntireSeries
type InspectStatus = TargetReady | ExternalTarget | TargetChanged
type InspectRoute = IgnoreInspection | OpenExternal | RefreshRows | SendScoped
type NativeTicket = { eventKey: int, sourceKey: int, sourceRevision: int, eventRevision: int }
type NativeSelection = { owner: int, generation: int, openRow: int }
pure def inspectPublishes(captured: NativeSelection, active: NativeSelection, inspectionReady: bool): bool =
  inspectionReady and captured.owner == active.owner and captured.generation == active.generation and captured.openRow == active.openRow
pure def manualInspectionRoute(captured: NativeSelection, active: NativeSelection, inspected: InspectStatus): InspectRoute =
  if (captured.owner != active.owner or captured.openRow != active.openRow) IgnoreInspection
  else if (inspected == TargetReady) SendScoped
  else if (inspected == ExternalTarget) OpenExternal
  else RefreshRows
pure def nativeScope(recurring: bool, pickedSeries: bool): AndroidScope =
  if (recurring and pickedSeries) EntireSeries else DefaultScope
pure def localInlineEdit(local: bool, alphaAccount: bool, recurring: bool, allDay: bool, complexTiming: bool): bool =
  local and alphaAccount and not(recurring or allDay or complexTiming)
pure def scopedArguments(inspectedTicket: NativeTicket): NativeTicket = inspectedTicket
pure def lawNativeScopeRequiresChoice(recurring: bool, pickedSeries: bool): bool =
  nativeScope(recurring, pickedSeries) == EntireSeries implies recurring and pickedSeries
pure def lawStaleInspectionCannotDispatch(captured: NativeSelection, active: NativeSelection, inspected: InspectStatus): bool =
  captured.owner != active.owner or captured.openRow != active.openRow implies manualInspectionRoute(captured, active, inspected) == IgnoreInspection
pure def lawAgentSelectionChecksGeneration(captured: NativeSelection, active: NativeSelection, inspectionReady: bool): bool =
  captured.generation != active.generation implies not(inspectPublishes(captured, active, inspectionReady))
pure def lawReadyCopiesTicket(inspectedTicket: NativeTicket): bool =
  val outgoing = scopedArguments(inspectedTicket)
  outgoing.eventKey == inspectedTicket.eventKey and outgoing.sourceKey == inspectedTicket.sourceKey and
  outgoing.sourceRevision == inspectedTicket.sourceRevision and outgoing.eventRevision == inspectedTicket.eventRevision
pure val capturedValues = Set(
  { owner: 1, generation: 1, openRow: 1 }, { owner: 1, generation: 2, openRow: 1 },
  { owner: 1, generation: 2, openRow: 2 }, { owner: 2, generation: 2, openRow: 1 })
pure val activeValues = capturedValues
pure val inspectedTicketValues = Set(
  { eventKey: 1, sourceKey: 1, sourceRevision: 2, eventRevision: 3 },
  { eventKey: 2, sourceKey: 1, sourceRevision: 1, eventRevision: 4 })
```

### Receipts update the reviewed detail without consuming a newer view

After the bridge response only the captured shell owner may adopt
it. A queued receipt refreshes pending deletion views. A deleted
receipt refreshes the range. Either closes the detail only if
Calendar is active and visible and the same row is still open
without a form. Queued does not prove deletion. The normal agent
adapter reports a queued deletion as pending and unconfirmed.
A verified deleted response can retire an owned Note origin. On
browser the direct cleanup takes only a standalone event ID,
excluding linked occurrences and IDs in occurrence form. The
deferred bridge handles its own later origin reporting.

Conflict refreshes the range. A refusal before invoking the
mutation does not make it uncertain. An unknown result or a
thrown call after mutation invocation records uncertainty for the
captured target on that shell owner. The owner can request another
read. A successful requested or forced read clears uncertainty
if it lists that event ID, or for a deletion if its range covers the
captured begin, with end exclusive. An ordinary read or another
range does not resolve a missing event. This mirrors the pinned
projection: it uses event identity rather than validating an
occurrence receipt, and it can clear on a ready truncated range
that covers the start. Clearing this UI hold is not a provider
deletion receipt.

```quint
type DeleteReply = QueuedReply | DeletedReply | ConflictReply | CancelledReply | UnknownReply | BeforeBridgeFault | AfterBridgeFault | OtherRefusal
type ReplyScope = { sameOwner: bool, sameRow: bool, activeView: bool, visible: bool, formOpen: bool }
type DeleteDisplay = { closeDetail: bool, refreshRange: bool, refreshPending: bool, markUncertain: bool, deletedEvidence: bool }
type CalendarWriteKind = EditWrite | DeleteWrite
pure def completionClose(replyScope: ReplyScope): bool =
  replyScope.sameOwner and replyScope.sameRow and replyScope.activeView and replyScope.visible and not(replyScope.formOpen)
pure def deleteDisplay(replyScope: ReplyScope, reply: DeleteReply): DeleteDisplay =
  { closeDetail: completionClose(replyScope) and (reply == QueuedReply or reply == DeletedReply),
    refreshRange: replyScope.sameOwner and (reply == DeletedReply or reply == ConflictReply),
    refreshPending: replyScope.sameOwner and reply == QueuedReply,
    markUncertain: reply == AfterBridgeFault or (replyScope.sameOwner and reply == UnknownReply),
    deletedEvidence: replyScope.sameOwner and reply == DeletedReply }
pure def blockedByWrite(saving: bool, eventKey: int, uncertainEvent: int): bool =
  saving or (uncertainEvent > 0 and uncertainEvent == eventKey)
pure def readClearsHold(kind: CalendarWriteKind, readAccepted: bool, requestedOrForced: bool, listsEvent: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  readAccepted and requestedOrForced and (listsEvent or (kind == DeleteWrite and begin >= rangeBegin and begin < rangeEnd))
pure def lawQueueHasNoDeleteReceipt(replyScope: ReplyScope): bool =
  not(deleteDisplay(replyScope, QueuedReply).deletedEvidence)
pure def lawCompletionPreservesDraft(replyScope: ReplyScope, reply: DeleteReply): bool =
  replyScope.formOpen or not(replyScope.sameRow) or not(replyScope.sameOwner) implies not(deleteDisplay(replyScope, reply).closeDetail)
pure def lawPreBridgeFaultDoesNotFence(replyScope: ReplyScope): bool =
  not(deleteDisplay(replyScope, BeforeBridgeFault).markUncertain)
pure def lawAnotherEventCanProceed(saving: bool, eventKey: int, uncertainEvent: int): bool =
  not(saving) and eventKey != uncertainEvent implies not(blockedByWrite(saving, eventKey, uncertainEvent))
pure def lawUnrelatedReadKeepsHold(kind: CalendarWriteKind, readAccepted: bool, requestedOrForced: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  (begin < rangeBegin or begin >= rangeEnd) implies not(readClearsHold(kind, readAccepted, requestedOrForced, false, begin, rangeBegin, rangeEnd))
pure def lawEditAbsenceCannotResolve(readAccepted: bool, requestedOrForced: bool, begin: int, rangeBegin: int, rangeEnd: int): bool =
  not(readClearsHold(EditWrite, readAccepted, requestedOrForced, false, begin, rangeBegin, rangeEnd))
pure val replyScopeValues = Set(
  { sameOwner: true, sameRow: true, activeView: true, visible: true, formOpen: false },
  { sameOwner: true, sameRow: false, activeView: true, visible: true, formOpen: false },
  { sameOwner: true, sameRow: true, activeView: true, visible: true, formOpen: true },
  { sameOwner: true, sameRow: true, activeView: false, visible: true, formOpen: false },
  { sameOwner: false, sameRow: true, activeView: true, visible: true, formOpen: false })
pure val beginValues = Set(0, 1, 2, 3)
pure val rangeBeginValues = Set(0, 1)
pure val rangeEndValues = Set(2, 3)
```

## Story: Change one browser occurrence without changing its siblings

### An occurrence becomes a standalone override or an exclusion under its series

This is the browser development Calendar authority. The renderer
requires `testMocksEnabled`, web platform and the browser-local
selection. Its recurrence behavior describes the local model and
fixture, while Android remains the supported device Calendar path.

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
type BrowserSeriesRow = { id: int, parent: int, originalStart: int, start: int, revision: int, repeats: bool, excluded: List[int] }
pure def occurrenceOverride(row: BrowserSeriesRow, newStart: int, newRevision: int): BrowserSeriesRow =
  { ...row, start: newStart, revision: newRevision, repeats: false, excluded: List() }
pure def appendStart(starts: List[int], atStart: int): List[int] = starts.append(atStart)
pure def excludeStart(starts: List[int], atStart: int): List[int] =
  if (starts.includes(atStart)) starts else appendStart(starts, atStart)
pure def excludeOccurrence(parentRow: BrowserSeriesRow, occurrence: BrowserSeriesRow, newRevision: int): BrowserSeriesRow =
  { ...parentRow, revision: newRevision, excluded: excludeStart(parentRow.excluded, occurrence.originalStart) }
pure def detachOccurrence(row: BrowserSeriesRow, newRevision: int): BrowserSeriesRow =
  { ...row, parent: 0, originalStart: 0, revision: newRevision }
pure def deleteSeriesRows(rows: List[BrowserSeriesRow], seriesId: int): List[BrowserSeriesRow] =
  rows.select(row => row.id != seriesId and row.parent != seriesId)
pure def movedWall(oldAnchorCivil: int, oldExcludedCivil: int, nextWall: int): int =
  nextWall + oldExcludedCivil - oldAnchorCivil
pure def explicitSeriesScope(occurrenceExact: bool, parentFound: bool, confirmed: bool): bool =
  occurrenceExact and parentFound and confirmed
pure def stageSeriesAllowed(occurrenceExact: bool, parentFound: bool, confirmed: bool, latestOccurrenceExact: bool, latestParentExact: bool): bool =
  explicitSeriesScope(occurrenceExact, parentFound, confirmed) and latestOccurrenceExact and latestParentExact
pure def lawOverrideKeepsOriginal(row: BrowserSeriesRow, newStart: int, newRevision: int): bool =
  val saved = occurrenceOverride(row, newStart, newRevision)
  saved.id == row.id and saved.parent == row.parent and saved.originalStart == row.originalStart and
  saved.revision == newRevision and saved.start == newStart and not(saved.repeats)
pure def lawOnceDetachesWithoutMoving(row: BrowserSeriesRow, newRevision: int): bool =
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

### Pending browser deletion guards the same row until transaction settlement

After a confirmed review, Calendar stages a cloned row, source
revision, scope, owner, operation ID and deletion deadline inside
the Calendar document. Staging leaves events intact. A queued or
paused entry blocks a new deletion of that row, deleting its
parent from a pending occurrence, or deleting an occurrence
covered by a pending parent-series deletion. Distinct sibling
occurrences can both be queued. Duplicate journal IDs are
refused. The browser trims oldest definite entries to 127 before
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
be undone. Clock discontinuity alone does not advance the browser
entry to paused, and cannot authorize dispatch.

```quint
type DeletePhase = DeleteQueued | DeletePaused | DeleteDispatching | DeleteUndone | DeleteDeleted | DeleteConflict | DeleteUnknown
type DeadlineView = WindowOpen | WindowExpired | ClockChanged
type BrowserDeleteDecision = KeepEntry | PauseEntry | ConflictEntry | CommitDelete
type RowMatch = { existsNow: bool, existed: bool, computedNow: bool, exactBytes: bool, ownBytes: bool }
pure def unresolvedDeletion(phase: DeletePhase): bool = phase == DeleteQueued or phase == DeletePaused
pure def blocksSiblingOrParent(phase: DeletePhase, targetId: int, targetParent: int, targetSeries: bool, newId: int, newParent: int): bool =
  unresolvedDeletion(phase) and (targetId == newId or (targetParent > 0 and targetParent == newId) or (targetSeries and targetId == newParent))
pure def sameBrowserRow(rowMatch: RowMatch): bool =
  if (rowMatch.computedNow and rowMatch.existsNow and rowMatch.existed) rowMatch.ownBytes
  else rowMatch.exactBytes
pure def browserSettlement(phase: DeletePhase, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): BrowserDeleteDecision =
  if (phase != DeleteQueued or windowView != WindowExpired) KeepEntry
  else if (not(ownerCurrent)) PauseEntry
  else if (not(sourceCurrent) or not(rowMatch.existsNow) or not(sameBrowserRow(rowMatch))) ConflictEntry
  else CommitDelete
pure def browserUndo(phase: DeletePhase, windowView: DeadlineView, ownerVisible: bool): bool =
  ownerVisible and (phase == DeleteUndone or phase == DeletePaused or (phase == DeleteQueued and windowView != WindowExpired))
pure def allowsPendingWrite(phase: DeletePhase, phaseUnchanged: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  not(unresolvedDeletion(phase) and phaseUnchanged) or (sourceCurrent and sameBrowserRow(rowMatch))
pure def mayStageDeletion(existingId: bool, pendingTarget: bool, retainedCount: int): bool =
  not(existingId or pendingTarget) and retainedCount >= 0 and retainedCount < 500
pure def afterTerminalTrim(terminalCount: int): int =
  if (terminalCount <= 127) terminalCount else 127
pure def lawDispatchRequiresExactSource(phase: DeletePhase, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  browserSettlement(phase, windowView, ownerCurrent, sourceCurrent, rowMatch) == CommitDelete implies
  phase == DeleteQueued and windowView == WindowExpired and ownerCurrent and sourceCurrent and rowMatch.existsNow and sameBrowserRow(rowMatch)
pure def lawClockChangeCannotDispatch(phase: DeletePhase, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch): bool =
  browserSettlement(phase, ClockChanged, ownerCurrent, sourceCurrent, rowMatch) == KeepEntry
pure def lawExpiredQueueCannotUndo(ownerVisible: bool): bool =
  not(browserUndo(DeleteQueued, WindowExpired, ownerVisible))
pure def lawPausedCanUndo(windowView: DeadlineView, ownerVisible: bool): bool =
  browserUndo(DeletePaused, windowView, ownerVisible) == ownerVisible
pure def lawPendingGuardStopsContentChange(phase: DeletePhase, rowMatch: RowMatch): bool =
  unresolvedDeletion(phase) and not(sameBrowserRow(rowMatch)) implies not(allowsPendingWrite(phase, true, true, rowMatch))
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

### Publish a browser deletion only with the committed document

The staged row and event survive a failed document write. A fully
committed delete changes the Calendar row and receipt together.
The model covers one target and compares the captured source and
row before each commit. Its abort input can represent document
compare-and-exchange failure. The actual provider mutation is
outside this browser transaction.

```quint
type BrowserDeleteTx = { phase: DeletePhase, staged: bool, eventPresent: bool, writes: int }
pure val initial: BrowserDeleteTx = { phase: DeleteUndone, staged: false, eventPresent: true, writes: 0 }
pure def canQueueDelete(s: BrowserDeleteTx): bool = not(s.staged) and s.eventPresent
pure def queueDelete(s: BrowserDeleteTx): BrowserDeleteTx = { ...s, staged: true, phase: DeleteQueued }
pure def canCommitBrowserDelete(s: BrowserDeleteTx, windowView: DeadlineView): bool =
  s.staged and s.phase == DeleteQueued and windowView == WindowExpired
pure def commitBrowserDelete(s: BrowserDeleteTx, windowView: DeadlineView, ownerCurrent: bool, sourceCurrent: bool, rowMatch: RowMatch, casSaved: bool): BrowserDeleteTx =
  val decision = browserSettlement(s.phase, windowView, ownerCurrent, sourceCurrent, rowMatch)
  if (not(casSaved)) s
  else if (decision == PauseEntry) { ...s, phase: DeletePaused }
  else if (decision == ConflictEntry) { ...s, phase: DeleteConflict }
  else if (decision == CommitDelete) { ...s, phase: DeleteDeleted, eventPresent: false, writes: s.writes + 1 }
  else s
pure def canCancelBrowserDelete(s: BrowserDeleteTx, windowView: DeadlineView, ownerVisible: bool): bool =
  s.staged and browserUndo(s.phase, windowView, ownerVisible)
pure def cancelBrowserDelete(s: BrowserDeleteTx, windowView: DeadlineView, ownerVisible: bool): BrowserDeleteTx =
  { ...s, phase: DeleteUndone }
pure def alwaysReceiptMatchesBrowserWrite(s: BrowserDeleteTx): bool =
  if (s.phase == DeleteDeleted) not(s.eventPresent) and s.writes == 1 else s.eventPresent and s.writes == 0
pure def alwaysOnlyStagedCanBeDeleted(s: BrowserDeleteTx): bool =
  s.phase == DeleteDeleted implies s.staged
pure def stepDeleteSettlesOnce(before: BrowserDeleteTx, via: str, after: BrowserDeleteTx): bool =
  after.writes > before.writes implies via == "commitBrowserDelete" and before.phase == DeleteQueued
pure def sometimesBrowserDelete(s: BrowserDeleteTx): bool = s.phase == DeleteDeleted
pure def sometimesBrowserUndo(s: BrowserDeleteTx): bool = s.staged and s.phase == DeleteUndone
pure def sometimesBrowserPause(s: BrowserDeleteTx): bool = s.phase == DeletePaused
pure val weight_commitBrowserDelete = 10
pure val weight_cancelBrowserDelete = 5
```
