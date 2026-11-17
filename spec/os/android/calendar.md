# Device calendar

The Android calendar bridge: bounded reads of the Calendar provider, Android's
own editor as a handoff, and guarded changes to one event the owner
reviewed: an update, or a deletion of the event, of one occurrence or of the
whole series, delayed by the [deletion window](./deletionWindow.md). Every
call is admitted by [the bridge](./bridge.md); its provider writes report
through the bridge's write outcome and write gate. The provider queries, the
row digests behind a revision, the dialog text and the `ContentProviderOperation`
batches stay in the shell (`android/calendar/`, from develop's
`plugin-native-calendar` `CalendarPlugin`, `CalendarEventGuard` and
`CalendarEventEdits`). The durable deletion row and its replay belong to the
deletion journal; this spec decides what may be staged and what its dispatch
may claim.

## Story: Read my calendar and open Android's editor

> As an owner, I want my calendar read only over a range that makes sense,
> and Android's own editor opened when I ask, so that opening the editor is
> never taken for a saved change.

### A read covers a range of at most 370 days inside the safe integer range

Every millisecond value the bridge reads or passes on is a whole number from
zero up to the last safe integer; a range that is empty, reversed, longer
than 370 days or past that bound is refused before the provider is queried.

```quint
import bridge.* from "./bridge"
import deletionWindow as W from "./deletionWindow"
import numbers as Num from "../../core/numbers"
pure val maxReadSpanMs = 31968000000
type ReadDecision = ReadAllowed | InvalidRange
pure def readRange(rangeStart: int, rangeEnd: int): ReadDecision =
  if (rangeStart < 0 or rangeEnd <= rangeStart or rangeEnd - rangeStart > maxReadSpanMs or rangeEnd > Num::maxSafeInteger) InvalidRange else ReadAllowed
pure val rangeStartValues = Set(-1, 0, 1000, 31968000000, 9007199254740000)
pure val rangeEndValues = Set(0, 1000, 31968000000, 31968001000, 9007199254740991)
pure val instantValues = Set(-1, 0, 500, 31968000000, 9007199254740991)
pure def lawEveryInstantOfAnAllowedRangeIsSafe(rangeStart: int, rangeEnd: int, instant: int): bool =
  (readRange(rangeStart, rangeEnd) == ReadAllowed and instant >= rangeStart and instant <= rangeEnd) implies
    (instant >= 0 and instant <= Num::maxSafeInteger and rangeEnd - rangeStart <= 370 * 86400000)
```

### Opening Android's editor reports Opened at most and changes nothing

The editor handoff is a bridge handoff: `Opened` is a preview receipt, never
a write. It leaves the provider row, the review, the staged deletion and the
write gate as they were.

```quint
type ProviderChange = UpdateFields | DeleteRow | ExcludeOccurrence | CancelOccurrence | InsertCancelledOccurrence
type Recurrence = OneOff | RuleSeries | DateListSeries
type ProviderRow = RowGone | RowLive({ revision: int, writable: bool, recurrence: Recurrence })
type Review = NoReview | Reviewed({ ticket: int, revision: int, change: ProviderChange })
type StagedDeletion = NoStagedDeletion | Staged({ pending: W::PendingDeletion, revision: int, change: ProviderChange })
type CalendarResult = NoResult | ReviewReady | ReviewConflict | EditorNeeded | EditorShown | EditorUnavailable
  | DeletionQueued | DeletionUndone | WriteSettled({ settledAs: WriteOutcome, change: ProviderChange })
type CalendarEdit = { row: ProviderRow, nextTicket: int, review: Review, deletion: StagedDeletion, gate: WriteGate, lastResult: CalendarResult }
pure val initial: CalendarEdit = { row: RowLive({ revision: 1, writable: true, recurrence: OneOff }), nextTicket: 1,
  review: NoReview, deletion: NoStagedDeletion, gate: WriteIdle, lastResult: NoResult }
pure def openEditor(s: CalendarEdit, handoff: HandoffOutcome): CalendarEdit =
  { ...s, lastResult: if (handoff == Opened) EditorShown else EditorUnavailable }
pure def stepEditorChangesNothing(before: CalendarEdit, via: str, after: CalendarEdit): bool =
  via == "openEditor" implies (after.row == before.row and after.review == before.review and after.deletion == before.deletion and after.gate == before.gate)
pure def sometimesEditorShown(s: CalendarEdit): bool = s.lastResult == EditorShown
```

## Story: Change exactly the event I reviewed

> As an owner, I want an edit to change exactly the event I reviewed and
> confirmed on Android's own dialog, so that an event changed since, or a
> review I walked away from, never overwrites anything.

### Only the current inspection ticket supplies the native confirmation

An inspection reads the row and issues a new ticket holding its revision and
the change it allows; the previous ticket is retired. A confirmation names
its ticket and is admitted only for the current one, with the app focused,
unlocked and both calendar grants held. Pausing the Activity retires the
ticket. A confirmation consumes its ticket, so a retired or stale ticket
publishes nothing. An event that repeats is never updated here: its edit is
Android's editor.

```quint
pure def rowLive(row: ProviderRow): bool = match row { | RowLive(r) => true | _ => false }
pure def rowRevision(row: ProviderRow): int = match row { | RowLive(r) => r.revision | _ => 0 }
pure def rowWritable(row: ProviderRow): bool = match row { | RowLive(r) => r.writable | _ => false }
pure def rowRecurrence(row: ProviderRow): Recurrence = match row { | RowLive(r) => r.recurrence | _ => OneOff }
pure def reviewTicket(review: Review): int = match review { | Reviewed(r) => r.ticket | _ => 0 }
pure def reviewRevision(review: Review): int = match review { | Reviewed(r) => r.revision | _ => 0 }
pure def reviewChange(review: Review): ProviderChange = match review { | Reviewed(r) => r.change | _ => UpdateFields }
pure val confirmCall: BridgeCall = { need: WithFocus, needsGrant: true, needsFeature: false }
pure def currentTicket(s: CalendarEdit, ticket: int): bool = s.review != NoReview and ticket > 0 and reviewTicket(s.review) == ticket
pure def confirmed(facts: HostFacts): bool = admitCall(PluginRegistered, confirmCall, facts) == CallAdmitted
pure def inspectUpdate(s: CalendarEdit): CalendarEdit =
  if (rowWritable(s.row) and rowRecurrence(s.row) == OneOff)
    { ...s, review: Reviewed({ ticket: s.nextTicket, revision: rowRevision(s.row), change: UpdateFields }), nextTicket: s.nextTicket + 1, lastResult: ReviewReady }
  else if (rowLive(s.row) and rowRecurrence(s.row) != OneOff) { ...s, review: NoReview, lastResult: EditorNeeded }
  else { ...s, review: NoReview, lastResult: ReviewConflict }
pure def pause(s: CalendarEdit): CalendarEdit = { ...s, review: NoReview }
pure val ticketValues = Set(0, 1, 2, 3)
pure def stepConfirmationConsumesTheCurrentTicket(before: CalendarEdit, via: str, after: CalendarEdit): bool =
  ((via == "saveReviewed" or via == "stageDeletion") implies (before.review != NoReview and after.review == NoReview)) and
  (via == "pause" implies after.review == NoReview)
```

### An edit compares the reviewed revision and changes the row in one provider batch

The batch asserts the calendar row and the event row as reviewed, then
updates the event, so a row that changed, went or became read-only or
repeating after review refuses with nothing written (`Conflict`). An update
keeps its calendar, sets the end and clears the duration. The bridge's write
gate admits one write at a time, and an `Uncertain` outcome (no answer, or a
committed batch whose readback did not confirm it) blocks the next write
until an explicit read. A lost answer is never retried.

```quint
type ParentAfter = ParentGone | ParentLive
type Readback = { parentAfter: ParentAfter, fieldsMatch: bool, exclusionExact: bool, cancelledAtStart: int, instanceRemains: bool }
pure def isOccurrenceChange(change: ProviderChange): bool =
  change == ExcludeOccurrence or change == CancelOccurrence or change == InsertCancelledOccurrence
pure def exactRow(row: ProviderRow, revision: int, change: ProviderChange): bool =
  rowWritable(row) and rowRevision(row) == revision and (change == UpdateFields implies rowRecurrence(row) == OneOff)
pure def readbackConfirms(change: ProviderChange, readback: Readback): bool =
  if (change == UpdateFields) readback.parentAfter == ParentLive and readback.fieldsMatch
  else if (change == DeleteRow) readback.parentAfter == ParentGone
  else if (change == ExcludeOccurrence) readback.parentAfter == ParentLive and readback.exclusionExact and not(readback.instanceRemains)
  else readback.parentAfter == ParentLive and readback.cancelledAtStart == 1 and not(readback.instanceRemains)
pure def batchReply(row: ProviderRow, revision: int, change: ProviderChange, answered: bool, readback: Readback): ProviderReply =
  if (not(exactRow(row, revision, change))) RevisionMismatch
  else if (not(answered)) NoReply
  else if (readbackConfirms(change, readback)) CommittedAndReadBack
  else CommittedNotReadBack
pure def changedRow(row: ProviderRow, change: ProviderChange): ProviderRow = match row {
  | RowLive(r) => if (change == DeleteRow) RowGone else RowLive({ ...r, revision: r.revision + 1 })
  | _ => row
}
pure def applyBatch(change: ProviderChange, s: CalendarEdit, revision: int, answered: bool, readback: Readback): CalendarEdit = {
  val reply = batchReply(s.row, revision, change, answered, readback)
  val settledAs = writeOutcome(reply)
  { ...s, row: if (reply == RevisionMismatch) s.row else changedRow(s.row, change),
    gate: gateOnOutcome(gateOnDispatch(s.gate), settledAs), lastResult: WriteSettled({ settledAs: settledAs, change: change }) }
}
pure def canSaveReviewed(s: CalendarEdit, ticket: int, facts: HostFacts): bool =
  currentTicket(s, ticket) and reviewChange(s.review) == UpdateFields and confirmed(facts) and gateAllowsWrite(s.gate)
pure def saveReviewed(s: CalendarEdit, ticket: int, facts: HostFacts, answered: bool, readback: Readback): CalendarEdit =
  applyBatch(UpdateFields, { ...s, review: NoReview }, reviewRevision(s.review), answered, readback)
pure def canChangeProvider(s: CalendarEdit): bool = rowLive(s.row)
pure def changeProvider(s: CalendarEdit, kept: bool, writable: bool, recurrence: Recurrence): CalendarEdit =
  { ...s, row: if (kept) RowLive({ revision: rowRevision(s.row) + 1, writable: writable, recurrence: recurrence }) else RowGone }
pure def observeRead(s: CalendarEdit, read: ReadEvidence): CalendarEdit = { ...s, gate: gateOnRead(s.gate, read) }
pure val readbackValues = Set(
  { parentAfter: ParentLive, fieldsMatch: true, exclusionExact: false, cancelledAtStart: 0, instanceRemains: true },
  { parentAfter: ParentGone, fieldsMatch: false, exclusionExact: false, cancelledAtStart: 0, instanceRemains: false },
  { parentAfter: ParentLive, fieldsMatch: false, exclusionExact: true, cancelledAtStart: 0, instanceRemains: false },
  { parentAfter: ParentLive, fieldsMatch: false, exclusionExact: false, cancelledAtStart: 1, instanceRemains: false })
pure def lawAppliedNeedsTheReviewedRowAndItsReadback(row: ProviderRow, revision: int, change: ProviderChange, answered: bool, readback: Readback): bool =
  writeOutcome(batchReply(row, revision, change, answered, readback)) == Applied implies
    (rowRevision(row) == revision and rowWritable(row) and answered and readbackConfirms(change, readback))
pure val rowValues: Set[ProviderRow] = List(RowGone, RowLive({ revision: 1, writable: true, recurrence: OneOff }),
  RowLive({ revision: 2, writable: false, recurrence: OneOff }), RowLive({ revision: 1, writable: true, recurrence: RuleSeries })
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure val revisionValues = Set(0, 1, 2)
pure def alwaysNoBatchIsLeftInFlight(s: CalendarEdit): bool = s.gate != WriteInFlight
pure def stagedRevision(deletion: StagedDeletion): int = match deletion { | Staged(d) => d.revision | _ => 0 }
pure def stagedChange(deletion: StagedDeletion): ProviderChange = match deletion { | Staged(d) => d.change | _ => UpdateFields }
pure def appliedResult(result: CalendarResult): bool = match result { | WriteSettled(w) => w.settledAs == Applied | _ => false }
pure def stepWritesOnlyTheReviewedRevision(before: CalendarEdit, via: str, after: CalendarEdit): bool = {
  val expected = if (via == "saveReviewed") reviewRevision(before.review) else stagedRevision(before.deletion)
  ((via == "saveReviewed" or via == "dispatchDeletion") implies before.gate == WriteIdle) and
  ((after.row != before.row and via != "changeProvider") implies (rowWritable(before.row) and rowRevision(before.row) == expected))
}
pure def stepAppliedOnlyAfterTheProviderChanged(before: CalendarEdit, via: str, after: CalendarEdit): bool =
  ((via == "saveReviewed" or via == "dispatchDeletion") and appliedResult(after.lastResult)) implies after.row != before.row
pure def sometimesUpdateApplied(s: CalendarEdit): bool = s.lastResult == WriteSettled({ settledAs: Applied, change: UpdateFields })
pure def sometimesStaleReviewRefused(s: CalendarEdit): bool = s.lastResult == WriteSettled({ settledAs: Conflict, change: UpdateFields })
pure def sometimesUncertainWriteBlocks(s: CalendarEdit): bool = s.gate == WriteUnsettled
pure def sometimesRepeatingEventNeedsTheEditor(s: CalendarEdit): bool = s.lastResult == EditorNeeded
```

## Story: Delete the event, one occurrence or the whole series as I chose

> As an owner, I want to see whether a deletion removes one event, one
> occurrence or a whole series before I confirm it, and ten seconds to undo
> it, so that I never delete more than I meant.

### The provider resolves the selected instance and decides the permitted scope

The renderer names a row and, at most, a scope; everything else comes from
the provider. A row of a series, or a moved exception, defaults to one
occurrence; a single row to the event. An explicit scope must match the
parent's recurrence. An occurrence is identified by its original start: the
selected begin for a row of the parent, the exception's original instance
time for a moved exception. A writing plan needs a writable current source
and parent, families of at most 2,048 event, attendee and reminder rows and
at most 2 Mi units of revision input (`bounded`), and exactly one provider
instance at the selected row and times. An occurrence needs a rule
(`RRULE`); on a synced calendar it cancels its existing exception or inserts
a cancelled one, and on a local unsynced calendar it excludes its whole-second
original start from an unmodified parent. Anything else is Android's editor.

```quint
type CalendarScope = SingleEvent | OneOccurrence | WholeSeries
type RequestedScope = DefaultScope | AskEvent | AskOccurrence | AskSeries
type SelectedRow = ParentRow | ExceptionRow
type SeriesSync = LocalUnsynced | SyncedSeries | RemoteUnsynced
type LiveException = NoLiveException | SelectedException | OtherException | CancelledSelection
type ScopeEvidence = { selectedRow: SelectedRow, sync: SeriesSync, sourceCurrent: bool, bounded: bool, otherExceptions: bool,
  liveException: LiveException, instances: int, begin: int, finish: int, exceptionOriginal: int }
type ScopePlan = ScopeConflict | EditorRequired | ScopeWrite({ change: ProviderChange })
pure def resolvedScope(shape: Recurrence, evidence: ScopeEvidence, requested: RequestedScope): CalendarScope =
  if (requested == AskEvent) SingleEvent else if (requested == AskOccurrence) OneOccurrence else if (requested == AskSeries) WholeSeries
  else if (evidence.selectedRow == ExceptionRow or shape != OneOff) OneOccurrence else SingleEvent
pure def originalStart(evidence: ScopeEvidence, scope: CalendarScope): int =
  if (scope != OneOccurrence) -1 else if (evidence.selectedRow == ParentRow) evidence.begin else evidence.exceptionOriginal
pure def selectionExact(evidence: ScopeEvidence, scope: CalendarScope): bool =
  evidence.instances == 1 and evidence.begin >= 0 and evidence.finish > evidence.begin and evidence.finish <= Num::maxSafeInteger and
    (scope != OneOccurrence or (evidence.selectedRow == ParentRow and evidence.liveException == NoLiveException) or
      (evidence.selectedRow == ExceptionRow and evidence.liveException == SelectedException))
pure def scopePlan(shape: Recurrence, writable: bool, evidence: ScopeEvidence, requested: RequestedScope): ScopePlan = {
  val scope = resolvedScope(shape, evidence, requested)
  val start = originalStart(evidence, scope)
  val localExclusion = evidence.sync == LocalUnsynced
  if (not(writable and evidence.sourceCurrent) or (shape != OneOff) != (scope != SingleEvent) or (scope == OneOccurrence and start < 0)) ScopeConflict
  else if (scope == OneOccurrence and (shape != RuleSeries or evidence.sync == RemoteUnsynced)) EditorRequired
  else if (not(evidence.bounded)) ScopeConflict
  else if (scope == OneOccurrence and localExclusion and (evidence.otherExceptions or evidence.selectedRow != ParentRow or start % 1000 != 0)) EditorRequired
  else if (not(selectionExact(evidence, scope))) ScopeConflict
  else if (scope != OneOccurrence) ScopeWrite({ change: DeleteRow })
  else if (localExclusion) ScopeWrite({ change: ExcludeOccurrence })
  else if (evidence.liveException == SelectedException) ScopeWrite({ change: CancelOccurrence })
  else ScopeWrite({ change: InsertCancelledOccurrence })
}
pure def plannedChange(plan: ScopePlan): ProviderChange = match plan { | ScopeWrite(w) => w.change | _ => UpdateFields }
pure def planWrites(plan: ScopePlan): bool = match plan { | ScopeWrite(w) => true | _ => false }
pure val localParent: ScopeEvidence = { selectedRow: ParentRow, sync: LocalUnsynced, sourceCurrent: true, bounded: true, otherExceptions: false,
  liveException: NoLiveException, instances: 1, begin: 1000, finish: 2000, exceptionOriginal: -1 }
pure val evidenceValues: Set[ScopeEvidence] = List(localParent, { ...localParent, sync: SyncedSeries },
  { ...localParent, selectedRow: ExceptionRow, sync: SyncedSeries, liveException: SelectedException, begin: 5000, finish: 6000, exceptionOriginal: 1000 },
  { ...localParent, sync: RemoteUnsynced }, { ...localParent, instances: 2 }, { ...localParent, begin: 1500, finish: 2500 }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
pure def lawOccurrenceNeverDeletesTheSeries(shape: Recurrence, writable: bool, evidence: ScopeEvidence, requested: RequestedScope): bool =
  resolvedScope(shape, evidence, requested) == OneOccurrence implies plannedChange(scopePlan(shape, writable, evidence, requested)) != DeleteRow
pure def lawMovedExceptionIsCancelledAtItsOriginalStart(shape: Recurrence, writable: bool, evidence: ScopeEvidence, requested: RequestedScope): bool = {
  val plan = scopePlan(shape, writable, evidence, requested)
  (planWrites(plan) and evidence.selectedRow == ExceptionRow and resolvedScope(shape, evidence, requested) == OneOccurrence) implies plannedChange(plan) == CancelOccurrence
}
pure def lawEveryPlannedWriteHasOneCurrentInstance(shape: Recurrence, writable: bool, evidence: ScopeEvidence, requested: RequestedScope): bool =
  planWrites(scopePlan(shape, writable, evidence, requested)) implies
    (writable and evidence.sourceCurrent and evidence.bounded and evidence.instances == 1 and evidence.finish <= Num::maxSafeInteger)
pure def lawExplicitScopeMustMatchTheRecurrence(shape: Recurrence, writable: bool, evidence: ScopeEvidence): bool =
  (shape != OneOff implies scopePlan(shape, writable, evidence, AskEvent) == ScopeConflict) and
  (shape == OneOff implies (scopePlan(shape, writable, evidence, AskSeries) == ScopeConflict and scopePlan(shape, writable, evidence, AskOccurrence) == ScopeConflict))
```

### A confirmed deletion is staged on the review clock and dispatched only through its claim

Inspecting a deletion asks the provider for the plan and issues a ticket for
it; a plan that needs Android's editor or does not hold issues none.
Confirming the current ticket stages one deletion, with a deadline taken on a
usable review clock; the owner can undo it while `W::claimDeletion` lets
Undo win, and the provider batch runs only when the dispatch claim wins,
with the calendar grant still held. The batch asserts the source row and every
event-family, attendee and reminder row with their counts, then makes the
one planned change: delete the parent, append the exact UTC `EXDATE`, or
cancel the occurrence's exception. Its readback is the plan's own: the
parent gone; or the parent live, the instance gone and the exclusion exact or
exactly one cancelled exception at the original start. Local readback says
nothing about remote sync or guests.

```quint
pure val deletionOwner = "calendar"
pure val dispatchCall: BridgeCall = { need: Anytime, needsGrant: true, needsFeature: false }
pure def inspectDeletion(s: CalendarEdit, evidence: ScopeEvidence, requested: RequestedScope): CalendarEdit = {
  val plan = scopePlan(rowRecurrence(s.row), rowWritable(s.row), evidence, requested)
  if (planWrites(plan))
    { ...s, review: Reviewed({ ticket: s.nextTicket, revision: rowRevision(s.row), change: plannedChange(plan) }), nextTicket: s.nextTicket + 1, lastResult: ReviewReady }
  else { ...s, review: NoReview, lastResult: if (plan == EditorRequired) EditorNeeded else ReviewConflict }
}
pure def canStageDeletion(s: CalendarEdit, ticket: int, facts: HostFacts, clock: W::DeletionClock): bool =
  currentTicket(s, ticket) and reviewChange(s.review) != UpdateFields and s.deletion == NoStagedDeletion and confirmed(facts) and W::clockUsable(clock)
pure def stageDeletion(s: CalendarEdit, ticket: int, facts: HostFacts, clock: W::DeletionClock): CalendarEdit =
  { ...s, review: NoReview, lastResult: DeletionQueued, deletion: Staged({
    pending: { owner: deletionOwner, deadline: W::deletionDeadline(clock), deletionPhase: W::Queued },
    revision: reviewRevision(s.review), change: reviewChange(s.review) }) }
pure def stagedClaim(deletion: StagedDeletion, later: W::DeletionClock, claimAction: W::DeletionClaimAction): bool = match deletion {
  | Staged(d) => W::claimDeletion(d.pending, d.pending.owner, later, claimAction).won
  | _ => false
}
pure def canUndoDeletion(s: CalendarEdit, later: W::DeletionClock): bool = stagedClaim(s.deletion, later, W::ClaimUndo)
pure def undoDeletion(s: CalendarEdit, later: W::DeletionClock): CalendarEdit = { ...s, deletion: NoStagedDeletion, lastResult: DeletionUndone }
pure def canDispatchDeletion(s: CalendarEdit, later: W::DeletionClock, facts: HostFacts): bool =
  stagedClaim(s.deletion, later, W::ClaimDispatch) and admitCall(PluginRegistered, dispatchCall, facts) == CallAdmitted and gateAllowsWrite(s.gate)
pure def dispatchDeletion(s: CalendarEdit, later: W::DeletionClock, facts: HostFacts, answered: bool, readback: Readback): CalendarEdit =
  applyBatch(stagedChange(s.deletion), { ...s, deletion: NoStagedDeletion }, stagedRevision(s.deletion), answered, readback)
pure val clockValues = Set({ continuity: "boot1", elapsed: 0, wall: 100 }, { continuity: "", elapsed: 0, wall: 100 })
pure val laterValues = Set({ continuity: "boot1", elapsed: 5000, wall: 5100 }, { continuity: "boot1", elapsed: 10000, wall: 10100 },
  { continuity: "boot2", elapsed: 5000, wall: 5100 })
pure val weight_stageDeletion = 4
pure val weight_dispatchDeletion = 4
pure val weight_inspectDeletion = 3
pure def stagedOnARealWindow(deletion: StagedDeletion): bool = match deletion {
  | Staged(d) => d.pending.deletionPhase == W::Queued and d.pending.owner == deletionOwner and d.pending.deadline.deadlineContinuity != "" and
      d.pending.deadline.createdElapsed >= 0 and d.pending.deadline.createdElapsed <= W::latestClockMs and
      d.pending.deadline.expiresElapsed == d.pending.deadline.createdElapsed + W::deleteUndoMs and d.change != UpdateFields
  | _ => true
}
pure def alwaysStagedDeletionIsQueuedOnARealWindow(s: CalendarEdit): bool = stagedOnARealWindow(s.deletion)
pure def stepOccurrenceDeletionKeepsTheSeries(before: CalendarEdit, via: str, after: CalendarEdit): bool =
  (via == "dispatchDeletion" and isOccurrenceChange(stagedChange(before.deletion)) and rowLive(before.row)) implies rowLive(after.row)
pure def sometimesDeletionQueued(s: CalendarEdit): bool = s.deletion != NoStagedDeletion
pure def sometimesDeletionUndone(s: CalendarEdit): bool = s.lastResult == DeletionUndone
pure def sometimesSeriesDeleted(s: CalendarEdit): bool = s.row == RowGone and s.lastResult == WriteSettled({ settledAs: Applied, change: DeleteRow })
pure def settledChange(result: CalendarResult): ProviderChange = match result { | WriteSettled(w) => w.change | _ => UpdateFields }
pure def sometimesOccurrenceRemovedSeriesKept(s: CalendarEdit): bool =
  rowLive(s.row) and appliedResult(s.lastResult) and isOccurrenceChange(settledChange(s.lastResult))
```
