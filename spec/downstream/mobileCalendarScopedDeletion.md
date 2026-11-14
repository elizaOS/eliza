# Android calendar deletion review and occurrence dispatch

AlphaPhone `8d44dfe5` uses `AlphaCalendarPlugin.java`,
`CalendarScopedDeletionReview.java`, `CalendarDeletionIdentity.java` and
`NativeDeletionCoordinator.java` in `android/app/src/main/java/ai/alphacompute/alphaphone`.
They call `CalendarEventGuard.ScopedDeletion` in Eliza `c518127a`, under
`plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar`.
This contract accepts a durable dispatch claim from the deferred deletion
journal. The journal owns the ten-second Undo window, restart and replay.
The renderer owns which action is shown and which selected row is sent.
[Grace's direct calendar path](./mobileCalendar.md) refuses repeating
edits and deletes, leaving them to the device calendar editor.

## Story: Review the exact event, series or single occurrence before queueing deletion

### The provider resolves the selected instance and decides the permitted scope

The version 2 identity is `delete2:<parent>:event`,
`delete2:<parent>:series` or `delete2:<parent>:occurrence:<original-start>`.
IDs are canonical decimal signed-long strings with positive event IDs
and nonnegative starts. Only the occurrence form has an original start.
A positive numeric legacy ID authorizes only the old one-event path.
The provider supplies the relationship from selected row to parent. For a
moved exception, its original instance time is the identity, while its
actual begin and end are the range the user sees. A null requested scope
means event for a single row and occurrence for a series or its exception.
An explicit scope must match the provider's recurrence shape.

The source and parent must still exist, be writable, match their source
and leave exactly one provider instance for the selected row and begin
and end. The selected row must be live. A requested occurrence requires
an RRULE. A synced source with no parent sync ID needs the external editor.
A local source without a sync ID can use an exclusion only for an
unmodified parent with no exception rows at a whole-second original
start. A live exception for the selected original start must be unique,
match the selected row, and remain uncancelled. Provider evidence includes
separately bounded lists of 2,048 event-family rows, attendees and
reminders, and at most 2 Mi UTF-16 units in the serialized revision input.
The model uses exact ID and revision identities and the port validates
the grammar, including signed-long range, before issuing its wire evidence.
Synthetic integer identities in the model stay in the exactly representable
range of generated TypeScript. Provider IDs use exact decimal strings at
the consumer boundary.

```quint
type CalendarScope = SingleEvent | OneOccurrence | WholeSeries
type RequestedScope = DefaultScope | ExplicitEvent | ExplicitOccurrence | ExplicitSeries
type ScopePlan = ScopeConflict | EditorRequired | DeleteParent | ExcludeOriginal | UpdateCancelledException | InsertCancelledException
type ScopeIdentity = { parentId: int, scope: CalendarScope, originalStart: int }
type ScopeSnapshot = { parentId: int, selectedId: int, sourceId: int, begin: int, finish: int, exceptionOriginal: int,
  wireDecoded: bool, sourceCurrent: bool, writable: bool, parentCurrent: bool, parentIsRoot: bool, selectedLive: bool, matchesInstance: int,
  rule: bool, dates: bool, local: bool, hasSyncId: bool, familyRows: int, attendeeRows: int, reminderRows: int, revisionUnits: int,
  liveExceptions: int, matchingExceptionSelected: bool, selectedCancelled: bool }
pure def wireIdentityValid(identity: ScopeIdentity, wireDecoded: bool): bool =
  wireDecoded and identity.parentId > 0 and
    (if (identity.scope == OneOccurrence) identity.originalStart >= 0 else identity.originalStart == -1)
pure def resolvedScope(snapshot: ScopeSnapshot, requestedScope: RequestedScope): CalendarScope = match requestedScope {
  | ExplicitEvent => SingleEvent
  | ExplicitOccurrence => OneOccurrence
  | ExplicitSeries => WholeSeries
  | DefaultScope => if (snapshot.parentId != snapshot.selectedId or snapshot.rule or snapshot.dates) OneOccurrence else SingleEvent
}
pure def resolvedIdentity(snapshot: ScopeSnapshot, requestedScope: RequestedScope): ScopeIdentity = {
  val scope = resolvedScope(snapshot, requestedScope)
  { parentId: snapshot.parentId, scope: scope, originalStart: if (scope != OneOccurrence) -1
    else if (snapshot.selectedId == snapshot.parentId) snapshot.begin else snapshot.exceptionOriginal }
}
pure def sourceAndParentCurrent(snapshot: ScopeSnapshot, identity: ScopeIdentity): bool =
  wireIdentityValid(identity, snapshot.wireDecoded) and snapshot.sourceId > 0 and snapshot.sourceCurrent and snapshot.writable and
    snapshot.parentCurrent and snapshot.parentIsRoot and ((snapshot.rule or snapshot.dates) == (identity.scope != SingleEvent))
pure def boundedFamily(snapshot: ScopeSnapshot): bool =
  snapshot.familyRows >= 1 and snapshot.familyRows <= 2048 and snapshot.attendeeRows >= 0 and snapshot.attendeeRows <= 2048 and
    snapshot.reminderRows >= 0 and snapshot.reminderRows <= 2048 and snapshot.revisionUnits >= 0 and snapshot.revisionUnits <= 2097152
pure def exactSelectedInstance(snapshot: ScopeSnapshot, identity: ScopeIdentity): bool =
  snapshot.selectedId > 0 and snapshot.selectedLive and snapshot.begin >= 0 and snapshot.finish > snapshot.begin and
    snapshot.matchesInstance == 1 and (identity.scope != OneOccurrence or
      (not(snapshot.selectedCancelled) and snapshot.liveExceptions >= 0 and snapshot.liveExceptions <= 1 and
        (snapshot.liveExceptions == 0 or snapshot.matchingExceptionSelected) and
        (snapshot.selectedId != snapshot.parentId or snapshot.begin == identity.originalStart)))
pure def scopePlan(snapshot: ScopeSnapshot, requestedScope: RequestedScope): ScopePlan = {
  val identity = resolvedIdentity(snapshot, requestedScope)
  val localExclusion = snapshot.local and not(snapshot.hasSyncId)
  if (not(sourceAndParentCurrent(snapshot, identity))) ScopeConflict
  else if (identity.scope == OneOccurrence and (not(snapshot.rule) or (not(snapshot.local) and not(snapshot.hasSyncId)))) EditorRequired
  else if (not(boundedFamily(snapshot))) ScopeConflict
  else if (identity.scope == OneOccurrence and localExclusion and
    (snapshot.familyRows != 1 or snapshot.selectedId != snapshot.parentId or identity.originalStart % 1000 != 0)) EditorRequired
  else if (not(exactSelectedInstance(snapshot, identity))) ScopeConflict
  else if (identity.scope != OneOccurrence) DeleteParent
  else if (localExclusion) ExcludeOriginal
  else if (snapshot.liveExceptions == 1) UpdateCancelledException else InsertCancelledException
}
pure val localSnapshot: ScopeSnapshot = { parentId: 42, selectedId: 42, sourceId: 7, begin: 1000, finish: 2000, exceptionOriginal: -1,
  wireDecoded: true, sourceCurrent: true, writable: true, parentCurrent: true, parentIsRoot: true, selectedLive: true, matchesInstance: 1,
  rule: true, dates: false, local: true, hasSyncId: false, familyRows: 1, attendeeRows: 1, reminderRows: 0, revisionUnits: 300,
  liveExceptions: 0, matchingExceptionSelected: false, selectedCancelled: false }
pure val movedSnapshot: ScopeSnapshot = { ...localSnapshot, selectedId: 90, local: false, hasSyncId: true,
  begin: 5000, finish: 6000, exceptionOriginal: 1000, familyRows: 2, liveExceptions: 1, matchingExceptionSelected: true }
pure val snapshotValues = Set(localSnapshot, movedSnapshot, { ...localSnapshot, rule: false, dates: true },
  { ...localSnapshot, rule: false }, { ...localSnapshot, matchesInstance: 2 }, { ...localSnapshot, local: false })
pure val identityValues = Set({ parentId: 42, scope: OneOccurrence, originalStart: 1000 }, { parentId: 42, scope: WholeSeries, originalStart: -1 })
pure def lawOccurrenceCannotPlanParentDelete(snapshot: ScopeSnapshot, requestedScope: RequestedScope): bool =
  resolvedScope(snapshot, requestedScope) == OneOccurrence implies scopePlan(snapshot, requestedScope) != DeleteParent
pure def lawMovedExceptionKeepsOriginalStart(snapshot: ScopeSnapshot, requestedScope: RequestedScope): bool =
  (resolvedScope(snapshot, requestedScope) == OneOccurrence and snapshot.selectedId != snapshot.parentId) implies
    resolvedIdentity(snapshot, requestedScope).originalStart == snapshot.exceptionOriginal
pure def lawOccurrencePlanNeedsOneInstance(snapshot: ScopeSnapshot, requestedScope: RequestedScope): bool =
  (scopePlan(snapshot, requestedScope) == ExcludeOriginal or scopePlan(snapshot, requestedScope) == UpdateCancelledException or
    scopePlan(snapshot, requestedScope) == InsertCancelledException) implies snapshot.matchesInstance == 1
```

### Only the current inspected ticket supplies the native confirmation and queued target

The bridge inspects with both permissions, foreground focus and an
unlocked live activity. It compares the visible title, body, location,
begin and end with the provider snapshot and rechecks foreground,
permission and generation before retaining a ticket. A ticket binds the
encoded event and scope, exact revision, source and source revision.
Its canonical retained target also carries the provider and selected row
IDs, original instance time, visible times and review fields. Renderer
fields beyond the four ticket coordinates do not replace that target.
The insertion-ordered cache holds 32 tickets. At capacity it discards the
first ticket before storing, even when that key already exists. Replacing
an existing key in the remaining cache retains its position. Deadlines
use elapsed milliseconds and accept the instant exactly 60 seconds
from insertion. A lookup does not consume the ticket. Generic deferred
admission owns durable duplicate prevention.

Only one review can acquire the dialog. The native worker looks up the
ticket and rereads the two revisions before posting the dialog to the
activity. Opening rechecks the generation, focus and both permissions.
A positive button is admitted only while the dialog is showing, the host
is resumed and unlocked, the activity or its dialog has focus, and both
permissions are still granted. The frozen target queues through the
journal; uncertain staging returns unknown. Pause retires all tickets
and any open dialog, and prevents a held inspection from publishing.
A review already posted when pause occurs settles on its stale generation.
Destroy additionally prevents new review. The model uses a process-local
elapsed clock and one in-flight inspection from the serialized worker.

```quint
type TicketKey = { eventId: str, revision: str, sourceId: str, sourceRevision: str }
type ReviewTicket = { key: TicketKey, targetRef: str, expires: int, generation: int }
type DialogPhase = ReviewIdle | ReviewPosted | ReviewOpen
type ReviewReply = NoReviewReply | InspectionReady | InspectionChanged | InspectionExternal | ReviewBusy | ReviewCancelled | ReviewQueued | ReviewUnknown | ReviewUnavailable
type ScopedReview = { clock: int, epoch: int, retired: bool, inspecting: bool, inspectEpoch: int,
  tickets: List[ReviewTicket], phase: DialogPhase, active: ReviewTicket, inspectReply: ReviewReply, dialogReply: ReviewReply,
  competingReply: ReviewReply, stageAttempts: int, stagedTarget: str }
pure val emptyKey: TicketKey = { eventId: "", revision: "", sourceId: "", sourceRevision: "" }
pure val firstKey: TicketKey = { eventId: "delete2:42:occurrence:1000", revision: "event-digest", sourceId: "7", sourceRevision: "source-digest" }
pure val otherKey: TicketKey = { ...firstKey, revision: "changed" }
pure val emptyTicket: ReviewTicket = { key: emptyKey, targetRef: "", expires: -1, generation: -1 }
pure val firstTicket: ReviewTicket = { key: firstKey, targetRef: "provider-target", expires: 60000, generation: 0 }
pure val initial: ScopedReview = { clock: 0, epoch: 0, retired: false, inspecting: false, inspectEpoch: -1,
  tickets: List(), phase: ReviewIdle, active: emptyTicket, inspectReply: NoReviewReply, dialogReply: NoReviewReply,
  competingReply: NoReviewReply, stageAttempts: 0, stagedTarget: "" }
pure def ticketKeyValid(key: TicketKey): bool = key.eventId != "" and key.revision != "" and key.sourceId != "" and key.sourceRevision != ""
pure def insertTicket(tickets: List[ReviewTicket], ticket: ReviewTicket): List[ReviewTicket] = {
  val kept = if (tickets.length() >= 32) tickets.removeAt(0) else tickets
  if (kept.some(prior => prior.key == ticket.key))
    kept.listMap(prior => if (prior.key == ticket.key) ticket else prior)
  else kept.append(ticket)
}
pure def lookupTicket(tickets: List[ReviewTicket], key: TicketKey): ReviewTicket =
  tickets.foldl(emptyTicket, (found, ticket) => if (ticket.key == key) ticket else found)
pure def freshTicket(ticket: ReviewTicket, key: TicketKey, epoch: int, elapsed: int): bool =
  ticket.targetRef != "" and ticket.key == key and ticket.generation == epoch and elapsed <= ticket.expires
pure def canBeginInspection(s: ScopedReview, foreground: bool, granted: bool): bool =
  not(s.inspecting or s.retired) and foreground and granted
pure def beginInspection(s: ScopedReview, foreground: bool, granted: bool): ScopedReview =
  { ...s, inspecting: true, inspectEpoch: s.epoch, inspectReply: NoReviewReply }
pure def canCompleteInspection(s: ScopedReview): bool = s.inspecting
pure def completeInspection(s: ScopedReview, canonical: ReviewTicket, inspectionPlan: ScopePlan, visibleExact: bool, foreground: bool, granted: bool): ScopedReview =
  if (inspectionPlan == EditorRequired) { ...s, inspecting: false, inspectReply: InspectionExternal }
  else if (inspectionPlan == ScopeConflict or not(visibleExact) or not(ticketKeyValid(canonical.key)) or canonical.targetRef == "")
    { ...s, inspecting: false, inspectReply: InspectionChanged }
  else if (s.retired or s.inspectEpoch != s.epoch or not(foreground and granted))
    { ...s, inspecting: false, inspectReply: ReviewUnavailable }
  else { ...s, inspecting: false, inspectReply: InspectionReady,
    tickets: insertTicket(s.tickets, { ...canonical, generation: s.epoch, expires: s.clock + 60000 }) }
pure def canRequestReview(s: ScopedReview, foreground: bool, granted: bool): bool = not(s.retired) and foreground and granted
pure def requestReview(s: ScopedReview, key: TicketKey, foreground: bool, granted: bool, revisionsExact: bool): ScopedReview = {
  val ticket = lookupTicket(s.tickets, key)
  if (s.phase != ReviewIdle) { ...s, competingReply: ReviewBusy }
  else if (not(freshTicket(ticket, key, s.epoch, s.clock) and revisionsExact)) { ...s, dialogReply: InspectionChanged }
  else { ...s, phase: ReviewPosted, active: ticket, dialogReply: NoReviewReply }
}
pure def canShowReview(s: ScopedReview): bool = s.phase == ReviewPosted
pure def showReview(s: ScopedReview, openingForeground: bool, openingGranted: bool): ScopedReview =
  if (not(s.retired) and s.active.generation == s.epoch and openingForeground and openingGranted)
    { ...s, phase: ReviewOpen }
  else { ...s, phase: ReviewIdle, active: emptyTicket, dialogReply: ReviewCancelled }
pure def canAnswerReview(s: ScopedReview): bool = s.phase == ReviewOpen
pure def answerReview(s: ScopedReview, positive: bool, dialogAuthorized: bool, granted: bool, stageConfirmed: bool): ScopedReview =
  if (not(positive and dialogAuthorized and granted))
    { ...s, phase: ReviewIdle, active: emptyTicket, dialogReply: ReviewCancelled }
  else { ...s, phase: ReviewIdle, active: emptyTicket, dialogReply: if (stageConfirmed) ReviewQueued else ReviewUnknown,
    stageAttempts: s.stageAttempts + 1, stagedTarget: s.active.targetRef }
pure def canPauseReview(s: ScopedReview): bool = not(s.retired)
pure def pauseReview(s: ScopedReview, destroying: bool): ScopedReview =
  if (s.phase == ReviewOpen)
    { ...s, retired: destroying, epoch: s.epoch + 1, tickets: List(), phase: ReviewIdle, active: emptyTicket, dialogReply: ReviewCancelled }
  else { ...s, retired: destroying, epoch: s.epoch + 1, tickets: List() }
pure def canSetElapsed(s: ScopedReview, elapsed: int): bool = elapsed > s.clock and not(s.retired)
pure def setElapsed(s: ScopedReview, elapsed: int): ScopedReview = { ...s, clock: elapsed }
pure val canonicalValues = Set(firstTicket, emptyTicket)
pure val inspectionPlanValues = Set(ExcludeOriginal, DeleteParent, EditorRequired, ScopeConflict)
pure val ticketsValues = Set(List(), List(firstTicket))
pure val keyValues = Set(firstKey, otherKey)
pure val ticketValues = Set(firstTicket, emptyTicket)
pure val elapsedValues = Set(0, 1, 60000, 60001, 120002)
pure val weight_beginInspection = 7
pure val weight_completeInspection = 10
pure val weight_requestReview = 12
pure val weight_showReview = 12
pure val weight_answerReview = 12
pure def alwaysOpenReviewCurrent(s: ScopedReview): bool =
  s.phase == ReviewOpen implies not(s.retired) and s.active.generation == s.epoch and s.active.targetRef != ""
pure def alwaysPostedOwnsTarget(s: ScopedReview): bool = s.phase == ReviewPosted implies s.active.targetRef != ""
pure def stepStagingNeedsOpenReview(before: ScopedReview, via: str, after: ScopedReview): bool =
  after.stageAttempts != before.stageAttempts implies via == "answerReview" and before.phase == ReviewOpen and
    after.stageAttempts == before.stageAttempts + 1 and after.stagedTarget == before.active.targetRef
pure def lawCurrentDialogCanOpen(s: ScopedReview, openingForeground: bool, openingGranted: bool): bool =
  (canShowReview(s) and not(s.retired) and s.active.generation == s.epoch and openingForeground and openingGranted) implies
    showReview(s, openingForeground, openingGranted).phase == ReviewOpen
pure def lawExpiredTicketCannotOwnReview(ticket: ReviewTicket, key: TicketKey, epoch: int, elapsed: int): bool =
  elapsed > ticket.expires implies not(freshTicket(ticket, key, epoch, elapsed))
pure def lawTicketCoordinatesMustMatch(ticket: ReviewTicket, key: TicketKey, epoch: int, elapsed: int): bool =
  ticket.key != key implies not(freshTicket(ticket, key, epoch, elapsed))
pure def sometimesQueuedExactReview(s: ScopedReview): bool = s.dialogReply == ReviewQueued
pure def sometimesUnconfirmedQueue(s: ScopedReview): bool = s.dialogReply == ReviewUnknown
pure def sometimesHeldInspectionRetired(s: ScopedReview): bool = s.inspectReply == ReviewUnavailable and s.inspectEpoch < s.epoch
```

## Story: Apply the reviewed deletion only to its authorized provider target

### A claimed dispatch uses one atomic provider assertion batch and scope-specific readback

The dispatch boundary accepts the version 2 target and its exact durable
claim from the journal, including the source and both revisions. The
bridge checks permission, binds the wire identity to the canonical
provider parent, original start and scope, and rereads the target. A
read or assertion conflict returns conflict. The batch asserts the values
of the Calendar source row and all event-family, attendee and reminder
rows, plus the membership counts for each of those dependent row sets.
One mutation follows the assertions in the same provider transaction.
A single event or whole series deletes its parent row. A local unsynced
occurrence appends exactly its UTC date to `EXDATE` and preserves
`DTSTART`, `DTEND`, `allDay`, `DURATION`, timezone and other recurrence
fields. A synced occurrence cancels its exact existing exception or
inserts one exception for its original start. Both occurrence paths
preserve the parent and leave the other occurrences alone.

A parent delete needs readback showing it missing or marked deleted.
For an occurrence the same calendar parent must remain live. A local
exclusion also needs the exact new `EXDATE` value and no instance at
the selected row and time interval. Synced readback needs exactly one
live cancelled exception for that original start and no instance for
either its parent or the exception at the selected displayed start.
Unavailable readback or an unconfirmed provider failure after dispatch
returns unknown. The provider's assertion exception means conflict.
Local readback establishes no remote synchronization or guest delivery.

```quint
type BatchResult = BatchCommitted | BatchAssertionConflict | BatchUnconfirmed
type DeleteReply = DeleteConflict | DeletePermissionRequired | DeleteUnknown | DeleteVerified
type DispatchGate = { exactClaim: bool, granted: bool, exactIdentity: bool, exactRevision: bool, exactSourceRevision: bool }
type ProviderReadback = { readable: bool, parentRemoved: bool, parentCurrent: bool, exactExclusion: bool,
  liveExceptionCount: int, cancelledException: bool, instanceGone: bool }
pure def admitsBatch(plan: ScopePlan, gate: DispatchGate): bool =
  gate.exactClaim and gate.granted and gate.exactIdentity and gate.exactRevision and gate.exactSourceRevision and
    plan != ScopeConflict and plan != EditorRequired
pure def deletionReadback(plan: ScopePlan, evidence: ProviderReadback): bool =
  evidence.readable and (if (plan == DeleteParent) evidence.parentRemoved
    else if (plan == ExcludeOriginal) evidence.parentCurrent and evidence.exactExclusion and evidence.instanceGone
    else if (plan == UpdateCancelledException or plan == InsertCancelledException)
      evidence.parentCurrent and evidence.liveExceptionCount == 1 and evidence.cancelledException and evidence.instanceGone else false)
pure def dispatchReply(plan: ScopePlan, gate: DispatchGate, batch: BatchResult, evidence: ProviderReadback): DeleteReply =
  if (not(gate.granted)) DeletePermissionRequired
  else if (not(admitsBatch(plan, gate)) or batch == BatchAssertionConflict) DeleteConflict
  else if (batch == BatchCommitted and deletionReadback(plan, evidence)) DeleteVerified else DeleteUnknown
pure val gateValues = Set({ exactClaim: true, granted: true, exactIdentity: true, exactRevision: true, exactSourceRevision: true },
  { exactClaim: false, granted: true, exactIdentity: true, exactRevision: true, exactSourceRevision: true },
  { exactClaim: true, granted: true, exactIdentity: true, exactRevision: true, exactSourceRevision: false })
pure val evidenceValues = Set({ readable: true, parentRemoved: true, parentCurrent: false, exactExclusion: false,
    liveExceptionCount: 0, cancelledException: false, instanceGone: true },
  { readable: true, parentRemoved: false, parentCurrent: true, exactExclusion: true,
    liveExceptionCount: 1, cancelledException: true, instanceGone: true },
  { readable: true, parentRemoved: false, parentCurrent: true, exactExclusion: true,
    liveExceptionCount: 2, cancelledException: true, instanceGone: true },
  { readable: true, parentRemoved: false, parentCurrent: true, exactExclusion: true,
    liveExceptionCount: 1, cancelledException: true, instanceGone: false })
pure def lawScopeWriteRequiresExactClaim(plan: ScopePlan, gate: DispatchGate): bool =
  admitsBatch(plan, gate) implies gate.exactClaim and gate.exactIdentity and gate.exactRevision and gate.exactSourceRevision
pure def lawScopedSuccessNeedsCommittedBatch(plan: ScopePlan, gate: DispatchGate, batch: BatchResult, evidence: ProviderReadback): bool =
  dispatchReply(plan, gate, batch, evidence) == DeleteVerified implies
    admitsBatch(plan, gate) and batch == BatchCommitted and deletionReadback(plan, evidence)
pure def lawOccurrenceReadbackKeepsParent(plan: ScopePlan, evidence: ProviderReadback): bool =
  (plan != DeleteParent and deletionReadback(plan, evidence)) implies evidence.parentCurrent and evidence.instanceGone
```
