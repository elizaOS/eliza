# Android owned media trash

The media bridge moves the app's own photos and videos into Android's
Recently deleted and back, and removes them for good in two steps: a
preparation that snapshots the trashed rows the person reviewed and returns
one expiring confirmation, and a deletion that consumes it. Sources:
`OwnedMediaLibrary.java` (`changeFlag`, `changeMany`, `prepareDeleteTrash`,
`cancelDeleteTrash`, `deletePreparedTrash`) and `TrashDeleteRequest.java` in
`plugins/plugin-native-media`.

The shell keeps the provider queries, payload parsing (an owned key is a
positive decimal id, `v:`-prefixed for a video; a revision is 1 to 160
UTF-16 units; `{all: true}` must be exactly `true` and never come with
`items`), the confirmation's UUID, the version-store cleanup and the
revocation of a video's playback grants after it is trashed, restored or
deleted. The [row ladder and token table](./rows.md) are imported; this spec
owns the decisions. A key here is the owned item's MediaStore id.

## Story: Trash or restore the exact items I selected

> As the person, I want Trash and Restore to change exactly the items I
> selected, as they were when I saw them, so that a changed or different
> item is never moved.

### A flag change is confirmed only for a row still at its listed revision on Android 11 or later

Recently deleted needs Android 11 (API 30); below it every row reports
unsupported. Otherwise each row runs the [row ladder](./rows.md): unchanged
when already as desired, trashed or restored only after one counted write
and a confirmed readback, stale when it changed first, unverified when the
effect is unknown. A row reached after the host closed is not inspected, so
it is unverified.

```quint
import rows.* from "./rows"
type OwnedChange = TrashOwned | RestoreOwned
type FlagReply = FlagUnchanged | FlagTrashed | FlagRestored | FlagStale | FlagUnverified | FlagUnsupported
pure val trashApiLevel = 30
pure def flagReply(change: OwnedChange, apiLevel: int, ladder: RowLadder): FlagReply = {
  val result = rowOutcome(ladder)
  if (apiLevel < trashApiLevel) FlagUnsupported
  else if (result == RowApplied) (if (change == TrashOwned) FlagTrashed else FlagRestored)
  else if (result == RowUnchanged) FlagUnchanged
  else if (result == RowStale) FlagStale
  else FlagUnverified
}
pure def flagConfirmed(reply: FlagReply): bool = reply == FlagUnchanged or reply == FlagTrashed or reply == FlagRestored
pure val apiLevelValues = Set(29, 30)
pure def lawConfirmedFlagWasListedOnSupportedAndroid(change: OwnedChange, apiLevel: int, ladder: RowLadder): bool = {
  val reply = flagReply(change, apiLevel, ladder)
  (flagConfirmed(reply) implies (apiLevel >= trashApiLevel and rowAtListing(ladder.inspection))) and
    (reply == FlagTrashed implies change == TrashOwned) and (reply == FlagRestored implies change == RestoreOwned)
}
```

### A batch names 1 to 20 distinct items and reports each one in its order

The whole request is checked before the first write. Each item then gets
its own reply under its own key, so a batch is complete only when every
row is confirmed (exact no-ops included) and partial otherwise; it is never
all or nothing. The single-item call is a batch of one whose unconfirmed
reply the bridge surfaces as a rejection.

```quint
type FlagRow = { key: int, ladder: RowLadder }
type FlagOutcome = { key: int, reply: FlagReply }
pure val ownedBatchLimit = 20
pure def distinctKeys(ids: List[int]): bool = ids.every(k => ids.select(other => other == k).length() == 1)
pure def validOwnedKeys(ids: List[int]): bool =
  ids.length() >= 1 and ids.length() <= ownedBatchLimit and ids.every(k => k > 0) and distinctKeys(ids)
pure def batchComplete(outcomes: List[FlagOutcome]): bool = outcomes.every(o => flagConfirmed(o.reply))
pure def canChangeOwnedFlags(s: OwnedTrash, items: List[FlagRow]): bool =
  not(s.hostClosed) and s.phase != Deleting and validOwnedKeys(items.listMap(r => r.key))
pure def changeOwnedFlags(s: OwnedTrash, change: OwnedChange, apiLevel: int, items: List[FlagRow]): OwnedTrash =
  { ...s, flagOutcomes: items.listMap(r => { key: r.key, reply: flagReply(change, apiLevel, r.ladder) }) }
pure val itemsValues = Set(List(), List({ key: 1, ladder: exactRowWrite }),
  List({ key: 1, ladder: exactRowWrite }, { key: 2, ladder: { ...exactRowWrite, inspection: RowChangedSinceListing } }),
  List({ key: 1, ladder: exactRowWrite }, { key: 1, ladder: exactRowWrite }))
pure def sometimesBatchComplete(s: OwnedTrash): bool =
  batchComplete(s.flagOutcomes) and s.flagOutcomes.some(o => o.reply == FlagTrashed)
pure def sometimesBatchPartial(s: OwnedTrash): bool =
  s.flagOutcomes.some(o => o.reply == FlagTrashed) and s.flagOutcomes.some(o => o.reply == FlagStale)
```

## Story: Delete only the trash I confirmed

> As the person, I want Empty Trash to remove only the trashed items I
> confirmed, so that nothing added or restored since is lost.

### Preparing snapshots exactly the trashed rows asked for and writes nothing

Emptying the whole trash is only ever the explicit `EmptyTrash` intent; a
named request lists 1 to 20 distinct keys, and an empty or missing list is
refused, never read as everything. The shell reads the app's published
trashed rows (all of them, or the named ones); a named request needs every
key found, at the revision the person reviewed. More than 500 trashed rows
refuse the preparation and keep earlier confirmations. The snapshot keeps
each row's key and MediaStore generation; no row is written. An empty trash
yields a confirmation for no rows, which the caller cancels; the caller
splits a larger named selection into batches of 20, each prepared and
deleted in turn.

```quint
type TrashTarget = { key: int, generation: int }
type ListedTrashRow = { key: int, generation: int, revisionMatches: bool }
type TrashRequest = EmptyTrash | NamedTrash({ wanted: List[int] })
pure val trashLimit = 500
pure def admitTrashSnapshot(request: TrashRequest, listed: List[ListedTrashRow]): bool = {
  val listedIds = listed.listMap(r => r.key)
  val asked = match request {
    | EmptyTrash => true
    | NamedTrash(n) => validOwnedKeys(n.wanted) and listed.length() == n.wanted.length() and
        n.wanted.every(k => listedIds.includes(k)) and listed.every(r => r.revisionMatches)
  }
  asked and listed.length() <= trashLimit and distinctKeys(listedIds)
}
pure def canPrepareTrashDelete(s: OwnedTrash, apiLevel: int, request: TrashRequest, listed: List[ListedTrashRow]): bool =
  not(s.hostClosed) and s.phase != Deleting and apiLevel >= trashApiLevel and admitTrashSnapshot(request, listed)
pure def prepareTrashDelete(s: OwnedTrash, apiLevel: int, request: TrashRequest, listed: List[ListedTrashRow]): OwnedTrash = {
  val issued = issueToken(s.confirmations, s.clock, confirmationCapacity, s.nextConfirmation, tokenLifetimeMs)
  { ...s, nextConfirmation: s.nextConfirmation + 1, confirmations: issued,
    prepared: s.prepared.select(p => issued.some(t => t.id == p.id))
      .append({ id: s.nextConfirmation, targets: listed.listMap(r => { key: r.key, generation: r.generation }) }) }
}
pure val requestValues = Set(EmptyTrash, NamedTrash({ wanted: List() }), NamedTrash({ wanted: List(1) }), NamedTrash({ wanted: List(1, 2) }))
pure val listedValues = Set(List(), List({ key: 1, generation: 7, revisionMatches: true }),
  List({ key: 1, generation: 7, revisionMatches: true }, { key: 2, generation: 11, revisionMatches: true }),
  List({ key: 1, generation: 7, revisionMatches: false }))
pure def sometimesConfirmationPending(s: OwnedTrash): bool = s.prepared.some(p => p.targets.length() == 2)
```

### A confirmation works once, for at most two minutes, and at most four wait at once

A confirmation is a [one-shot token](./rows.md) on Android's monotonic
clock, live through its deadline. Preparing drops expired confirmations and
evicts the oldest when four wait. Cancelling removes only its own; a
deletion takes it before any check or provider work. Each confirmation and
its snapshot exist together, so a snapshot never outlives its confirmation.

```quint
type PreparedTrash = { id: int, targets: List[TrashTarget] }
pure val confirmationCapacity = 4
pure def canObserveClock(s: OwnedTrash, now: int): bool = now > s.clock
pure def observeClock(s: OwnedTrash, now: int): OwnedTrash = { ...s, clock: now }
pure def canCancelTrashDelete(s: OwnedTrash): bool = s.phase != Deleting
pure def cancelTrashDelete(s: OwnedTrash, tokenId: int): OwnedTrash =
  { ...s, confirmations: dropToken(s.confirmations, tokenId), prepared: s.prepared.select(p => p.id != tokenId) }
pure val nowValues = Set(1, 120000, 120001, 240002)
pure def alwaysAtMostFourConfirmations(s: OwnedTrash): bool = s.confirmations.length() <= confirmationCapacity
pure def alwaysConfirmationsEndWithinTheirLifetime(s: OwnedTrash): bool =
  s.confirmations.every(t => t.until <= s.clock + tokenLifetimeMs)
pure def alwaysConfirmationsAndSnapshotsPair(s: OwnedTrash): bool =
  s.confirmations.every(t => s.prepared.some(p => p.id == t.id)) and s.prepared.every(p => s.confirmations.some(t => t.id == p.id))
```

### Deleting uses the consumed snapshot and reports only its rows

A live confirmation starts a deletion over its frozen snapshot; an unknown,
cancelled or expired one is refused with "Review trash again". Rows run in
snapshot order, one at a time, and a trashed row absent from the snapshot
never becomes a target. The result is deleted only when no row was skipped
or failed (an empty snapshot included), partial otherwise. The bridge runs
one call at a time on its worker, so no other trash call starts while a
deletion is under way.

```quint
type RowDelete = RowDeleted | RowSkipped | RowFailed | RowDeletedCleanupFailed
type DeleteReceipt = { deletedIds: List[int], skippedIds: List[int], failedIds: List[int] }
type TrashPhase = Idle | Deleting | AllDeleted | PartlyDeleted | ConfirmationRefused
type OwnedTrash = { clock: int, hostClosed: bool, nextConfirmation: int, confirmations: List[OneShotToken],
  prepared: List[PreparedTrash], phase: TrashPhase, targets: List[TrashTarget], position: int,
  receipt: DeleteReceipt, flagOutcomes: List[FlagOutcome] }
pure val noReceipt: DeleteReceipt = { deletedIds: List(), skippedIds: List(), failedIds: List() }
pure val initial: OwnedTrash = { clock: 0, hostClosed: false, nextConfirmation: 1, confirmations: List(), prepared: List(),
  phase: Idle, targets: List(), position: 0, receipt: noReceipt, flagOutcomes: List() }
pure def recordRow(receipt: DeleteReceipt, key: int, reply: RowDelete): DeleteReceipt =
  { deletedIds: if (reply == RowDeleted or reply == RowDeletedCleanupFailed) receipt.deletedIds.append(key) else receipt.deletedIds,
    skippedIds: if (reply == RowSkipped) receipt.skippedIds.append(key) else receipt.skippedIds,
    failedIds: if (reply == RowFailed or reply == RowDeletedCleanupFailed) receipt.failedIds.append(key) else receipt.failedIds }
pure def canBeginTrashDelete(s: OwnedTrash, apiLevel: int): bool = not(s.hostClosed) and s.phase != Deleting and apiLevel >= trashApiLevel
pure def beginTrashDelete(s: OwnedTrash, apiLevel: int, tokenId: int): OwnedTrash = {
  val taken = takeToken(s.confirmations, tokenId, s.clock)
  val snapshot = s.prepared.select(p => p.id == tokenId).nthOr(0, { id: 0, targets: List() })
  { ...s, confirmations: taken.left, prepared: s.prepared.select(p => p.id != tokenId),
    phase: if (taken.live) Deleting else ConfirmationRefused, targets: if (taken.live) snapshot.targets else List(),
    position: 0, receipt: noReceipt }
}
pure def canFinishTrashDelete(s: OwnedTrash): bool = s.phase == Deleting and s.position == s.targets.length()
pure def finishTrashDelete(s: OwnedTrash): OwnedTrash =
  { ...s, phase: if (s.receipt.skippedIds.length() == 0 and s.receipt.failedIds.length() == 0) AllDeleted else PartlyDeleted }
pure val weight_beginTrashDelete = 4
pure val weight_finishTrashDelete = 6
pure def alwaysDeletionCursorInSnapshot(s: OwnedTrash): bool = s.position >= 0 and s.position <= s.targets.length()
pure def alwaysReceiptNamesOnlySnapshotTargets(s: OwnedTrash): bool = {
  val ids = s.receipt.deletedIds.concat(s.receipt.skippedIds).concat(s.receipt.failedIds)
  ids.every(k => s.targets.some(t => t.key == k))
}
pure def alwaysDeletedMeansNothingSkippedOrFailed(s: OwnedTrash): bool =
  s.phase == AllDeleted implies (s.receipt.skippedIds.length() == 0 and s.receipt.failedIds.length() == 0)
pure def stepSnapshotFrozenWhileDeleting(before: OwnedTrash, after: OwnedTrash): bool =
  before.phase == Deleting implies after.targets == before.targets
pure def sometimesEveryConfirmedRowDeleted(s: OwnedTrash): bool = s.phase == AllDeleted and s.receipt.deletedIds.length() == 2
pure def sometimesEmptyTrashDeletedNothing(s: OwnedTrash): bool = s.phase == AllDeleted and s.targets.length() == 0
pure def sometimesDeletionPartlySkipped(s: OwnedTrash): bool =
  s.phase == PartlyDeleted and s.receipt.deletedIds.length() > 0 and s.receipt.skippedIds.length() > 0
pure def sometimesExpiredConfirmationRefused(s: OwnedTrash): bool = s.phase == ConfirmationRefused and s.clock > tokenLifetimeMs
```

### A row is deleted only while still trashed at its snapshot generation, by one counted delete

Each row is read first: unreadable (a null cursor or a provider error) is
failed; missing, restored or at another generation is skipped without a
delete. Otherwise the one delete predicates on owner, published state, key,
the trashed flag and the snapshot generation. A count of one deletes the
row and then cleans up its version entry and playback grants; a cleanup
error also lists the row as failed, keeping its delete. A count of zero is
skipped; a thrown delete or any other count may have removed the row, so
it is failed, never skipped.

The native code reports a count above one as skipped; it cannot occur under
the id predicate, and here it is failed so that skipped never covers a
possible removal, as in the [row ladder](./rows.md).

```quint
type RowDeleteEvidence = { inspection: RowInspection, write: RowWrite, cleanupFinished: bool }
pure def rowDeleteReply(evidence: RowDeleteEvidence): RowDelete =
  if (evidence.inspection == RowNotInspected or evidence.inspection == RowInspectFailed) RowFailed
  else if (not(rowNeedsWrite(evidence.inspection))) RowSkipped
  else if (evidence.write == RowWriteCounted({ rows: 1 })) (if (evidence.cleanupFinished) RowDeleted else RowDeletedCleanupFailed)
  else if (evidence.write == RowWriteCounted({ rows: 0 })) RowSkipped
  else RowFailed
pure val exactRowDelete: RowDeleteEvidence = { inspection: RowAtListing({ alreadyDesired: false }), write: RowWriteCounted({ rows: 1 }), cleanupFinished: true }
pure val evidenceValues = Set(exactRowDelete, { ...exactRowDelete, cleanupFinished: false },
  { ...exactRowDelete, write: RowWriteCounted({ rows: 0 }) }, { ...exactRowDelete, write: RowWriteCounted({ rows: 2 }) },
  { ...exactRowDelete, write: RowWriteFailed }, { ...exactRowDelete, inspection: RowChangedSinceListing },
  { ...exactRowDelete, inspection: RowInspectFailed })
pure def lawDeletedRowWasAtItsSnapshotWithOneCountedDelete(evidence: RowDeleteEvidence): bool = {
  val reply = rowDeleteReply(evidence)
  ((reply == RowDeleted or reply == RowDeletedCleanupFailed) implies
    (rowNeedsWrite(evidence.inspection) and evidence.write == RowWriteCounted({ rows: 1 }))) and
  ((rowNeedsWrite(evidence.inspection) and writeMayHaveApplied(evidence.write)) implies reply != RowSkipped)
}
```

### A closed host starts no new row and retires its confirmations

Closing the bridge retires every waiting confirmation; nothing replays a
deletion later. A deletion under way reports each row it has not begun as
failed, without a provider call, and then finishes partial.

```quint
pure val weight_deleteTrashRow = 6
pure def canDeleteTrashRow(s: OwnedTrash): bool = s.phase == Deleting and s.position < s.targets.length()
pure def deleteTrashRow(s: OwnedTrash, evidence: RowDeleteEvidence): OwnedTrash = {
  val key = s.targets.nthOr(s.position, { key: 0, generation: 0 }).key
  val reply = if (s.hostClosed) RowFailed else rowDeleteReply(evidence)
  { ...s, position: s.position + 1, receipt: recordRow(s.receipt, key, reply) }
}
pure def canCloseHost(s: OwnedTrash): bool = not(s.hostClosed)
pure def closeHost(s: OwnedTrash): OwnedTrash = { ...s, hostClosed: true, confirmations: List(), prepared: List() }
pure def alwaysClosedHostHoldsNoConfirmation(s: OwnedTrash): bool =
  s.hostClosed implies (s.confirmations.length() == 0 and s.prepared.length() == 0)
pure def sometimesClosedDuringDeletion(s: OwnedTrash): bool =
  s.hostClosed and s.phase == PartlyDeleted and s.receipt.deletedIds.length() > 0 and s.receipt.failedIds.length() > 0
```
