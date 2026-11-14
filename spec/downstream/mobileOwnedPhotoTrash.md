# Android owned Photos trash custody

AlphaPhone `8d44dfe5` registers `AlphaPhotosPlugin.java`, which extends
Eliza `c518127a`'s `PhotosPlugin.java` and imports its `OwnedMediaLibrary`,
`OwnedMediaSelection` and `TrashDeleteRequest` through the native-media
Gradle project. The Alpha caller is `apps/app/src/prototype/camera-adapter.ts`.
Grace `48b43b9c` registers `DevicePhotosPlugin.java` over Eliza
`7743504b`'s read-only `PermittedPhotosPlugin` with the image profile.
[Photos view receipts](./mobileDevicePhotos.md) govern agent-initiated
review. [Android photo access](./mobilePhotos.md) governs the separate
permitted-library path. This model owns Alpha's native app-owned rows.

Eliza's pinned `test/native-host/trash-request.node.mjs` exercises
`TrashDeleteRequestTest.java` and checks the overload's explicit intent.
`test/native-host/owned-media.node.mjs` checks the native configuration,
selection and readback helpers. Alpha's `test/quint-photos-trash.test.mjs`
covers the renderer's serialized, visibility-fenced trash refresh.
Alpha's `PhotosTrashInstrumentedTest.java` exercises the immutable
review against newly trashed and restored rows. Its
`PhotosBatchInstrumentedTest.java` covers partial owned trash and undo.
Eliza's `test/android-consumer` fixture `OwnedLibraryConsumerTest.java`
exercises restore and token replay rejection. These instrumentation
cases define Android acceptance evidence separately from the host
fixtures and the transition model.

## Story: Trash or restore the exact item I selected

### An owned mutation needs the listed row and a supported Android API

`setTrashed` takes an explicit Boolean, owned media key and mutation
revision. Owned keys are a positive decimal ID, optionally prefixed
with `v:` for video. The platform adapter parses the ID as a Java
`long` before querying and checks the owner package, image or video
type, and published state. The opaque mutation revision binds date
added, size, generation modified and trash state. Android 11 or later
is required. A matching row already in the desired state returns
`unchanged` without a write. Otherwise a single row update predicates
on its owner, ID, type, published state, generation and opposite
trash flag. An update count other than one yields `stale`. After a
one-row video flag change the plugin revokes playback grants, including
on restore. The desired flag must be read back and its version committed
before the bridge confirms `trashed` or `restored`. A thrown provider error or
unverified readback carries no positive receipt. A null initial cursor
on the flag path is treated as a stale row. The bridge's single
item entry point surfaces failure as a rejection.

An owned `changeMany` request validates the entire 1–20 item list before
the first write. IDs are distinct and revisions are nonempty and at most
160 Java UTF-16 code units. Each item yields its own original ID and
status. Confirmed outcomes also carry the observed item metadata.
A closed host marks remaining rows `unverified` without issuing new
writes. A valid request on Android below 11 reports `unsupported` per
row reached before closure. `complete` means every row is confirmed,
including exact no-ops. One stale, unsupported or unverified row makes
the batch `partial`. The same bridge can route permitted-key batches
to a separate Android review.

```quint
type OwnedReview = { key: str, ownedSyntax: bool, revisionUnits: int }
type OwnedChange = TrashOwned | RestoreOwned
type FlagReply = FlagUnchanged | FlagTrashed | FlagRestored | FlagStale | FlagUnverified | FlagUnsupported
type FlagEvidence = { android11: bool, liveAtItem: bool, queryKnown: bool, exactRow: bool,
  alreadyDesired: bool, updateKnown: bool, updatedRows: int, desiredReadback: bool, versionCommitted: bool }
pure def validOwnedReview(reviewedRow: OwnedReview): bool = reviewedRow.key != "" and reviewedRow.ownedSyntax and
  reviewedRow.revisionUnits >= 1 and reviewedRow.revisionUnits <= 160
pure def validOwnedSelection(items: List[OwnedReview]): bool =
  items.length() >= 1 and items.length() <= 20 and items.every(validOwnedReview) and
  items.every(reviewedRow => items.select(other => other.key == reviewedRow.key).length() == 1)
pure def ownedFlagReply(operation: OwnedChange, facts: FlagEvidence): FlagReply =
  if (not(facts.liveAtItem)) FlagUnverified
  else if (not(facts.android11)) FlagUnsupported
  else if (not(facts.queryKnown)) FlagUnverified
  else if (not(facts.exactRow)) FlagStale
  else if (facts.alreadyDesired) FlagUnchanged
  else if (not(facts.updateKnown)) FlagUnverified
  else if (facts.updatedRows != 1) FlagStale
  else if (not(facts.desiredReadback and facts.versionCommitted)) FlagUnverified
  else if (operation == TrashOwned) FlagTrashed else FlagRestored
pure def flagConfirmed(reply: FlagReply): bool = reply == FlagUnchanged or reply == FlagTrashed or reply == FlagRestored
pure def batchComplete(outcomes: List[FlagReply]): bool = outcomes.every(flagConfirmed)
pure val photoReview: OwnedReview = { key: "12", ownedSyntax: true, revisionUnits: 24 }
pure val videoReview: OwnedReview = { key: "v:12", ownedSyntax: true, revisionUnits: 48 }
pure val itemsValues = Set(List(), List(photoReview), List(photoReview, videoReview), List(photoReview, photoReview))
pure val reviewedRowValues = Set(photoReview, videoReview, { ...photoReview, revisionUnits: 161 })
pure val verifiedFlag: FlagEvidence = { android11: true, liveAtItem: true, queryKnown: true, exactRow: true, alreadyDesired: false,
  updateKnown: true, updatedRows: 1, desiredReadback: true, versionCommitted: true }
pure val factsValues = Set(verifiedFlag, { ...verifiedFlag, alreadyDesired: true, updatedRows: 0 },
  { ...verifiedFlag, updatedRows: 0 }, { ...verifiedFlag, desiredReadback: false },
  { ...verifiedFlag, versionCommitted: false }, { ...verifiedFlag, liveAtItem: false })
pure def lawOwnedBatchReviewBound(items: List[OwnedReview]): bool =
  validOwnedSelection(items) implies items.length() >= 1 and items.length() <= 20
pure def lawOwnedConfirmedFlagBindsExactRow(operation: OwnedChange, facts: FlagEvidence): bool =
  flagConfirmed(ownedFlagReply(operation, facts)) implies facts.android11 and facts.liveAtItem and facts.queryKnown and facts.exactRow
pure def lawOwnedChangedFlagUsesReadbackAndCommit(operation: OwnedChange, facts: FlagEvidence): bool =
  (ownedFlagReply(operation, facts) == FlagTrashed or ownedFlagReply(operation, facts) == FlagRestored) implies
    facts.updateKnown and facts.updatedRows == 1 and facts.desiredReadback and facts.versionCommitted
pure def lawOwnedCompleteBatchHasConfirmedRows(outcomes: List[FlagReply], reply: FlagReply): bool =
  batchComplete(outcomes) and outcomes.includes(reply) implies flagConfirmed(reply)
```

## Story: Permanently remove only the owned trash I confirmed

### Preparation snapshots the requested trashed rows and gives the worker one expiring token

`prepareDeleteTrash` accepts either the strict JSON Boolean `{all:true}`
with no `items`, or a valid named list with no `all`. A missing, null,
malformed, duplicate or empty selection refuses the named request.
The provider must return the full reviewed selection, including the
exact mutation revisions for named rows. It reads only published owned
trash. A catalog scan that would exceed 500 rows refuses the prepare
and keeps earlier tickets intact. A successful explicit all over an
empty trash may return count zero. Alpha cancels that token and shows
the empty state. Alpha also cancels newly returned tokens for a
discarded view. A large named selection stays bound to reviewed
revisions and is split into batches of up to 20 after the UI confirms.
The Android-permitted library and browser adapters have separate
confirmation contracts.

The native worker stores the frozen typed key and MediaStore generation
of each target. No MediaStore write runs during preparation. The opaque
UUID is private to the library instance and expires two minutes after
creation on Android's monotonic elapsed clock. Expiry uses `until < now`,
so the exact deadline is valid. On successful prepare the library drops
expired entries, evicts the oldest insertion if four entries remain,
and appends a fresh token. Cancel removes only its exact token. A
delete attempt consumes the matching token before checking expiry
or performing any provider write. The model represents fresh opaque
tokens by a monotonically allocated internal identity. The shell owns
UUID encoding and exact wire decoding. Provider enumeration, row key
and named snapshot revision checks supply trusted admission facts.

```quint
type Target = { key: str, generation: int }
type DeleteIntent = AllTrash | NamedTrash | InvalidTrash
type DeletePayload = { allPresent: bool, allIsTrue: bool, itemsPresent: bool, itemsArray: bool }
pure def ownedDeleteIntent(payload: DeletePayload): DeleteIntent =
  if (payload.allPresent) {
    if (payload.allIsTrue and not(payload.itemsPresent)) AllTrash else InvalidTrash
  } else if (payload.itemsPresent and payload.itemsArray) NamedTrash else InvalidTrash
pure val payloadValues = Set(
  { allPresent: true, allIsTrue: true, itemsPresent: false, itemsArray: false },
  { allPresent: true, allIsTrue: true, itemsPresent: true, itemsArray: true },
  { allPresent: true, allIsTrue: false, itemsPresent: false, itemsArray: false },
  { allPresent: false, allIsTrue: false, itemsPresent: true, itemsArray: true },
  { allPresent: false, allIsTrue: false, itemsPresent: true, itemsArray: false },
  { allPresent: false, allIsTrue: false, itemsPresent: false, itemsArray: false })
pure def lawOwnedEmptyIntentNeedsExplicitTrue(payload: DeletePayload): bool =
  ownedDeleteIntent(payload) == AllTrash implies payload.allPresent and payload.allIsTrue and not(payload.itemsPresent)
type PrepareEvidence = { android11: bool, intent: DeleteIntent,
  items: List[OwnedReview], enumerated: int, exactSnapshot: bool, targets: List[Target] }
pure def admitDeletePrepare(prep: PrepareEvidence): bool = prep.android11 and prep.exactSnapshot and
  prep.enumerated >= prep.targets.length() and prep.enumerated <= 500 and
  (if (prep.intent == AllTrash) prep.items.length() == 0 and prep.enumerated == prep.targets.length()
  else prep.intent == NamedTrash and validOwnedSelection(prep.items) and prep.targets.length() == prep.items.length() and
    prep.items.every(reviewedRow => prep.targets.some(target => target.key == reviewedRow.key)))
pure val firstTarget: Target = { key: "12", generation: 7 }
pure val secondTarget: Target = { key: "v:12", generation: 11 }
pure val allPrepared: PrepareEvidence = { android11: true, intent: AllTrash, items: List(), enumerated: 2,
  exactSnapshot: true, targets: List(firstTarget, secondTarget) }
pure val prepValues = Set(allPrepared, { ...allPrepared, enumerated: 0, targets: List() },
  { ...allPrepared, intent: NamedTrash, items: List(photoReview), enumerated: 1, targets: List(firstTarget) },
  { ...allPrepared, intent: NamedTrash }, { ...allPrepared, intent: InvalidTrash },
  { ...allPrepared, enumerated: 501 }, { ...allPrepared, exactSnapshot: false })
pure def lawOnlyExplicitAllCanPrepareAnEmptyTarget(prep: PrepareEvidence): bool =
  admitDeletePrepare(prep) and prep.targets.length() == 0 implies prep.intent == AllTrash
pure def lawNamedTrashRequiresEveryReviewedKey(prep: PrepareEvidence, reviewedRow: OwnedReview): bool =
  admitDeletePrepare(prep) and prep.intent == NamedTrash and prep.items.includes(reviewedRow) implies
    prep.targets.some(target => target.key == reviewedRow.key)
pure def lawPrepareRefusesOversizedOrInexactSnapshot(prep: PrepareEvidence): bool =
  (prep.enumerated > 500 or not(prep.exactSnapshot)) implies not(admitDeletePrepare(prep))
type TrashTicket = { token: int, until: int, targets: List[Target] }
pure val noTicket: TrashTicket = { token: 0, until: -1, targets: List() }
pure val ticketValues = Set(noTicket, { token: 1, until: 120000, targets: List(firstTarget, secondTarget) })
pure def ticketFor(tickets: List[TrashTicket], token: int): TrashTicket =
  tickets.select(ticket => ticket.token == token).nthOr(0, noTicket)
pure def dropTicket(tickets: List[TrashTicket], token: int): List[TrashTicket] =
  tickets.select(ticket => ticket.token != token)
pure def addTicket(tickets: List[TrashTicket], now: int, ticket: TrashTicket): List[TrashTicket] = {
  val fresh = tickets.select(prior => prior.until >= now)
  val kept = if (fresh.length() >= 4) fresh.removeAt(0) else fresh
  kept.append(ticket)
}
pure def liveTicket(ticket: TrashTicket, now: int): bool = ticket.token > 0 and ticket.until >= now
pure def lawExactTrashDeadlineStillValid(ticket: TrashTicket): bool =
  ticket.token > 0 implies liveTicket(ticket, ticket.until) and not(liveTicket(ticket, ticket.until + 1))
```

### Deleting uses the consumed snapshot and returns only its row outcomes

The bridge serializes calls on its worker. An accepted token freezes the
row sequence for execution. The sole provider delete for each original
target predicates on the app's ownership, published state, typed key,
currently trashed flag and snapshotted generation. A readable missing,
restored or changed row is skipped before attempting deletion. A
condition race between inspection and the typed delete can also yield
a skipped row when the provider count is not one. A null cursor or a
provider exception reports a failed row. A count of one appends the
deleted ID, removes its version entry and revokes video playback.
The pinned wrapper appends that ID before cleanup, so an exception in
cleanup also appends it to the failed list. Both receipts for that ID
are retained in the model. The successful delete receipt rests on the
provider count. The plugin reports `partial` if any row is skipped
or failed. Otherwise it reports `deleted`, including an empty snapshot.

A host closed before a row begins sends no new provider operation for
that row. Work that already passed the check may return its result.
Closing the bridge retires its in-memory tickets from future use.
There is no replay or durable background delete authority. A later
trash row absent from the frozen snapshot never becomes a target of
that token. The model's row evidence distinguishes unreadable
inspection, exact-identity conflicts, guarded provider effect and
post-delete cleanup.

```quint
type DeleteObservation = { inspected: bool, ownedPublishedTrash: bool, inspectedKey: str, inspectedGeneration: int,
  counted: bool, affectedRows: int, cleanupFinished: bool }
type RowDeleteReply = RowDeleted | RowSkipped | RowFailed | RowDeletedCleanupFailed
pure def exactDeleteRow(target: Target, observation: DeleteObservation): bool =
  observation.ownedPublishedTrash and observation.inspectedKey == target.key and
    observation.inspectedGeneration == target.generation
pure def deleteRowReply(target: Target, observation: DeleteObservation): RowDeleteReply =
  if (not(observation.inspected)) RowFailed
  else if (not(exactDeleteRow(target, observation))) RowSkipped
  else if (not(observation.counted)) RowFailed
  else if (observation.affectedRows != 1) RowSkipped
  else if (observation.cleanupFinished) RowDeleted else RowDeletedCleanupFailed
pure def rowWasDeleted(reply: RowDeleteReply): bool = reply == RowDeleted or reply == RowDeletedCleanupFailed
pure def rowFailed(reply: RowDeleteReply): bool = reply == RowFailed or reply == RowDeletedCleanupFailed
pure val exactRemoval: DeleteObservation = { inspected: true, ownedPublishedTrash: true, inspectedKey: "12",
  inspectedGeneration: 7, counted: true, affectedRows: 1, cleanupFinished: true }
pure val videoRemoval: DeleteObservation = { ...exactRemoval, inspectedKey: "v:12", inspectedGeneration: 11 }
pure val targetValues = Set(firstTarget, secondTarget)
pure val observationValues = Set(exactRemoval, videoRemoval, { ...exactRemoval, ownedPublishedTrash: false },
  { ...exactRemoval, inspectedGeneration: 8 }, { ...exactRemoval, affectedRows: 0 },
  { ...exactRemoval, inspected: false }, { ...exactRemoval, cleanupFinished: false })
pure def lawOwnedDeleteRequiresExactTrashedGeneration(target: Target, observation: DeleteObservation): bool =
  rowWasDeleted(deleteRowReply(target, observation)) implies observation.inspected and
    exactDeleteRow(target, observation) and observation.counted and observation.affectedRows == 1
pure def lawOwnedCleanupFailureRetainsPositiveDelete(target: Target, observation: DeleteObservation): bool =
  rowWasDeleted(deleteRowReply(target, observation)) and not(observation.cleanupFinished) implies
    rowFailed(deleteRowReply(target, observation))
type DeleteReceipt = { deletedIds: List[str], skippedIds: List[str], failedIds: List[str] }
type TrashResult = NoTrashResult | TrashDeleted | TrashPartial | TrashExpired
pure def ownedDeleteStatus(receipt: DeleteReceipt): TrashResult =
  if (receipt.skippedIds.length() == 0 and receipt.failedIds.length() == 0) TrashDeleted else TrashPartial
pure val emptyReceipt: DeleteReceipt = { deletedIds: List(), skippedIds: List(), failedIds: List() }
pure def recordTrashReceipt(receipt: DeleteReceipt, key: str, reply: RowDeleteReply): DeleteReceipt =
  { deletedIds: if (rowWasDeleted(reply)) receipt.deletedIds.append(key) else receipt.deletedIds,
    skippedIds: if (reply == RowSkipped) receipt.skippedIds.append(key) else receipt.skippedIds,
    failedIds: if (rowFailed(reply)) receipt.failedIds.append(key) else receipt.failedIds }
type OwnedTrash = { closed: bool, clock: int, issued: int, pending: List[TrashTicket],
  active: TrashTicket, processing: bool, position: int, rowStarted: bool, receipt: DeleteReceipt, result: TrashResult }
pure val initial: OwnedTrash = { closed: false, clock: 0, issued: 0, pending: List(), active: noTicket,
  processing: false, position: 0, rowStarted: false, receipt: emptyReceipt, result: NoTrashResult }
pure def canPrepareOwnedTrash(s: OwnedTrash, prep: PrepareEvidence): bool =
  not(s.closed or s.processing) and admitDeletePrepare(prep)
pure def prepareOwnedTrash(s: OwnedTrash, prep: PrepareEvidence): OwnedTrash =
  { ...s, issued: s.issued + 1, pending: addTicket(s.pending, s.clock,
    { token: s.issued + 1, until: s.clock + 120000, targets: prep.targets }) }
pure def canCancelOwnedTrash(s: OwnedTrash, token: int): bool = not(s.closed or s.processing)
pure def cancelOwnedTrash(s: OwnedTrash, token: int): OwnedTrash = { ...s, pending: dropTicket(s.pending, token) }
pure def canAdvanceTrashClock(s: OwnedTrash, observedClock: int): bool = observedClock > s.clock
pure def advanceTrashClock(s: OwnedTrash, observedClock: int): OwnedTrash = { ...s, clock: observedClock }
pure def canBeginOwnedDeletion(s: OwnedTrash, token: int): bool = not(s.closed or s.processing)
pure def beginOwnedDeletion(s: OwnedTrash, token: int): OwnedTrash = {
  val ticket = ticketFor(s.pending, token)
  val valid = token == ticket.token and liveTicket(ticket, s.clock)
  { ...s, pending: dropTicket(s.pending, token), active: if (valid) ticket else noTicket,
    processing: valid, position: 0, receipt: emptyReceipt, result: if (valid) NoTrashResult else TrashExpired }
}
pure def canStartOwnedDeleteRow(s: OwnedTrash): bool =
  s.processing and not(s.closed or s.rowStarted) and s.position < s.active.targets.length()
pure def startOwnedDeleteRow(s: OwnedTrash): OwnedTrash = { ...s, rowStarted: true }
pure def canFinishOwnedDeleteRow(s: OwnedTrash): bool = s.processing and s.rowStarted
pure def finishOwnedDeleteRow(s: OwnedTrash, observation: DeleteObservation): OwnedTrash = {
  val target = s.active.targets.nthOr(s.position, firstTarget)
  { ...s, rowStarted: false, position: s.position + 1,
    receipt: recordTrashReceipt(s.receipt, target.key, deleteRowReply(target, observation)) }
}
pure def canFailClosedDeleteRow(s: OwnedTrash): bool =
  s.processing and s.closed and not(s.rowStarted) and s.position < s.active.targets.length()
pure def failClosedDeleteRow(s: OwnedTrash): OwnedTrash =
  { ...s, position: s.position + 1, receipt: recordTrashReceipt(s.receipt, s.active.targets.nthOr(s.position, firstTarget).key, RowFailed) }
pure def canCompleteOwnedDeletion(s: OwnedTrash): bool =
  s.processing and not(s.rowStarted) and s.position == s.active.targets.length()
pure def completeOwnedDeletion(s: OwnedTrash): OwnedTrash =
  { ...s, active: noTicket, position: 0, processing: false, result: ownedDeleteStatus(s.receipt) }
pure def canCloseOwnedTrash(s: OwnedTrash): bool = not(s.closed)
pure def closeOwnedTrash(s: OwnedTrash): OwnedTrash = { ...s, closed: true, pending: List() }
pure val tokenValues = Set(0, 1, 2, 3, 4, 5, 6)
pure val observedClockValues = Set(1, 120000, 120001, 240002, 500000)
pure val weight_prepareOwnedTrash = 8
pure val weight_beginOwnedDeletion = 8
pure val weight_startOwnedDeleteRow = 15
pure val weight_finishOwnedDeleteRow = 15
pure val weight_failClosedDeleteRow = 15
pure val weight_completeOwnedDeletion = 15
pure def alwaysOwnedDeletionCursorInSnapshot(s: OwnedTrash): bool =
  s.position >= 0 and s.position <= s.active.targets.length() and
  (s.rowStarted implies s.processing and s.position < s.active.targets.length())
pure def alwaysInactiveOwnedDeletionHoldsNoTarget(s: OwnedTrash): bool =
  not(s.processing) implies s.active == noTicket
pure def alwaysClosedOwnedTrashHoldsNoPending(s: OwnedTrash): bool = s.closed implies s.pending.length() == 0
pure def stepOwnedPrepareSnapshotsWithinTheCutoff(before: OwnedTrash, via: str, after: OwnedTrash): bool =
  via == "prepareOwnedTrash" implies after.issued == before.issued + 1 and after.active == before.active and
    after.receipt == before.receipt and after.position == before.position
pure def stepOwnedDeleteConsumesTheExactTicket(before: OwnedTrash, via: str, after: OwnedTrash): bool =
  via == "beginOwnedDeletion" and after.processing implies
    liveTicket(after.active, before.clock) and after.pending == dropTicket(before.pending, after.active.token)
pure def stepOwnedDeleteStartsOnlyOpen(before: OwnedTrash, via: str, after: OwnedTrash): bool =
  via == "startOwnedDeleteRow" implies not(before.closed) and before.processing and
    after.rowStarted and after.active == before.active
pure def stepOwnedDeleteFinishesOneFrozenRow(before: OwnedTrash, via: str, after: OwnedTrash): bool =
  via == "finishOwnedDeleteRow" or via == "failClosedDeleteRow" implies
    before.position < before.active.targets.length() and after.active == before.active and
      after.position == before.position + 1 and not(after.rowStarted)
pure def stepOwnedDeleteConfirmedOnlyAfterAllRows(before: OwnedTrash, via: str, after: OwnedTrash): bool =
  via == "completeOwnedDeletion" implies before.processing and before.position == before.active.targets.length() and
    after.result == ownedDeleteStatus(before.receipt)
pure def sometimesOwnedTrashPrepared(s: OwnedTrash): bool = s.pending.length() > 0
pure def sometimesOwnedTrashEmptyReceipt(s: OwnedTrash): bool = s.result == TrashDeleted and s.receipt.deletedIds.length() == 0
pure def sometimesOwnedTrashMixedReceipt(s: OwnedTrash): bool = s.result == TrashPartial and
  s.receipt.deletedIds.length() > 0 and s.receipt.skippedIds.length() > 0
pure def sometimesOwnedTrashRejected(s: OwnedTrash): bool = s.result == TrashExpired
pure def sometimesOwnedTrashClosedMidDelete(s: OwnedTrash): bool = s.closed and s.result == TrashPartial and
  s.receipt.failedIds.length() > 0
```
