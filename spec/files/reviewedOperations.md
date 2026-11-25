# Scoped Files operations

This spec owns per-row reviewed mutation of the owner's files and the
batches they run in. The row facts, outcomes and write receipts are the os
package's [file storage](../os/android/files/storage.md) (`St`), and Files
admits exactly the rows the device admits. [Requests](./requests.md) cover opening, and
[reviewed file identity](./reviewPin.md) pins the file a review showed.

## Story: Act only on the file revision I reviewed

> As the owner, I want a change to touch only the file revision I
> reviewed, and to be told truthfully which changes happened.

### The mutation re-reads each selected row and reports each outcome

A recognized selection is nonempty, bounded, unique, and points to a
valid destination for transfers. For an admitted batch each row receives
its own outcome in request order. Reviewed transfers and deletes compare
an exact token for the current row ID and revision before any action.
An invalid or missing row, replaced revision, same-folder move, or
transfer into a selected folder's descendant does not reach a filesystem
operation. Copy and move accept a collision-free name. The resulting path
or trash ID comes from the write receipt. An unknown write result cannot
fabricate an applied outcome or autonomously repeat a mutation. A row is
admitted here exactly when the device's file storage admits it.

```quint
import storage as St from "../os/android/files/storage"
pure val rowValues = St::rowValues
pure def classifyRow(op: St::FilesOp, row: St::FilesRowCheck): St::FileOutcome =
  if (not(row.validPath) or not(row.currentOwner)) St::Invalid else if (not(row.pathExists)) St::Missing
  else if (row.reviewRequired and not(row.reviewMatches)) St::Changed
  else if (op == St::Move and row.sameFolder) St::Unchanged
  else if (op != St::Trash and row.descendant) St::Invalid
  else St::Admitted
pure def lawStaleReviewedRowIsNotAdmitted(op: St::FilesOp, row: St::FilesRowCheck): bool = classifyRow(op, row) == St::Admitted implies row.currentOwner and (not(row.reviewRequired) or row.reviewMatches)
pure def lawAppliedRequiresReceipt(op: St::FilesOp, row: St::FilesRowCheck, acknowledged: bool, resultingId: str): bool = {
  val answer = St::receiptOutcome(op, classifyRow(op, row), acknowledged, resultingId)
  (answer == St::Copied or answer == St::Moved or answer == St::Trashed) implies classifyRow(op, row) == St::Admitted and acknowledged and resultingId != ""
}
pure def lawFilesAdmitsExactlyWhatTheDeviceAdmits(op: St::FilesOp, row: St::FilesRowCheck): bool =
  (classifyRow(op, row) == St::Admitted) iff (St::nativeRowAdmission(op, row) == St::Admitted)
```

### Trash owns a journal entry before moving the row

Trash operations share the same namespace lock with listing and pruning.
They write origin and deletion-time metadata first, move to the trash
container, and remove that journal row if the move fails. Unknown outcomes
remain explicit. Listing exposes only rows with metadata and actual trash
residency. A row expires at 30 days; deletion and journal cleanup are
separate receipts.

```quint
type TrashPhase = Visible | Journaled | InTrash | MoveFailed | Expiring | Gone
pure val expiryMillis = 2592000000
type TrashRow = { phase: TrashPhase, journal: bool, resident: bool, deletedAt: int }
pure val initial: TrashRow = { phase: Visible, journal: false, resident: false, deletedAt: 0 }
pure def canJournal(s: TrashRow, op: St::FilesOp, row: St::FilesRowCheck, at: int): bool = s.phase == Visible and at >= 0 and op == St::Trash and classifyRow(op, row) == St::Admitted
pure def journal(s: TrashRow, op: St::FilesOp, row: St::FilesRowCheck, at: int): TrashRow = { ...s, phase: Journaled, journal: true, deletedAt: at }
pure def canMoveToTrash(s: TrashRow): bool = s.phase == Journaled
pure def moveToTrash(s: TrashRow, acknowledged: bool): TrashRow = { ...s, phase: if (acknowledged) InTrash else MoveFailed, resident: acknowledged }
pure def canUndoFailedJournal(s: TrashRow): bool = s.phase == MoveFailed
pure def undoFailedJournal(s: TrashRow): TrashRow = initial
pure def canPrune(s: TrashRow, at: int): bool = s.phase == InTrash and at - s.deletedAt >= expiryMillis
pure def prune(s: TrashRow, at: int, erased: bool): TrashRow = if (erased) { ...s, phase: Expiring, resident: false } else s
pure def canCompletePrune(s: TrashRow): bool = s.phase == Expiring
pure def completePrune(s: TrashRow, writeAcknowledged: bool): TrashRow = if (writeAcknowledged) { ...s, phase: Gone, journal: false } else s
pure def alwaysJournalPrecedesResidency(s: TrashRow): bool = s.resident == (s.phase == InTrash) and (s.journal == (s.phase == Journaled or s.phase == InTrash or s.phase == MoveFailed or s.phase == Expiring))
pure def listed(s: TrashRow, at: int): bool = s.resident and s.journal and at - s.deletedAt < expiryMillis
pure def lawExpiredIsNotListed(s: TrashRow, at: int): bool = at - s.deletedAt >= expiryMillis implies not(listed(s, at))
pure val atValues = Set(0, 1, 2592000000, 2592000001)
pure def sometimesTrashed(s: TrashRow): bool = s.phase == InTrash
pure def sometimesFailedMoveRetainsJournal(s: TrashRow): bool = s.phase == MoveFailed and s.journal
pure def sometimesMetadataCleanupRemainsPending(s: TrashRow): bool = s.phase == Expiring and s.journal and not(s.resident)
```

### A trash record that cannot be read is listed as unreadable, refuses only its own restore, and can be emptied

In the local and browser Files volumes, each trashed item keeps its own
record of its name, origin and deletion time. A record whose contents can
be read but cannot be decoded, such as one torn by an interrupted write,
is not an absent record, and it answers only for its own item. On the local
volume, only journal files named for a generated trash ID are considered,
and a read error prevents the operation from treating the record as torn.
Listing the trash still lists every readable item, and shows
the torn one by its trash name, marked unreadable, with no origin or
deletion time claimed for it, even when its data is already gone, since
nothing else would ever clear it. A restore that names it answers that item
failed, never missing, and leaves its record and data where they are,
while the other items in the same restore are restored as usual. Since
its deletion time is unknown it never expires on its own and is listed
after every readable item: emptying it from the trash erases whatever
data it still has and its record, counts it as emptied, and is how the
owner clears it. Emptying never erases or counts a readable record whose
data is already gone, since that is no item the owner can see. An item
with no record at all is still missing, and a trash that never held
anything is still an empty trash.

```quint
type TrashRecordRead = RecordAbsent | RecordRead | RecordUnreadable
type TrashItemAnswer = ItemRestorable | ItemMissing | ItemUnreadable
pure def trashItemAnswer(read: TrashRecordRead, resident: bool): TrashItemAnswer =
  if (read == RecordUnreadable) ItemUnreadable else if (read == RecordRead and resident) ItemRestorable else ItemMissing
pure def emptyErases(read: TrashRecordRead, resident: bool): bool = resident or read == RecordUnreadable
pure def lawAnUnreadableRecordIsNeverReadAsNoRecord(read: TrashRecordRead, resident: bool): bool =
  trashItemAnswer(read, resident) == ItemMissing implies (read == RecordAbsent or not(resident)) and read != RecordUnreadable
pure def lawEveryUnreadableItemCanBeEmptied(read: TrashRecordRead, resident: bool): bool =
  trashItemAnswer(read, resident) == ItemUnreadable implies emptyErases(read, resident)
pure def lawNoRecordIsStillMissing(resident: bool): bool =
  trashItemAnswer(RecordAbsent, resident) == ItemMissing and emptyErases(RecordAbsent, resident) == resident
pure def lawAReadableRecordIsEmptiedOnlyWithItsData(resident: bool): bool =
  emptyErases(RecordRead, resident) == resident
```

## Story: Keep every batch outcome, including the ones I cannot be sure of

> As the owner, I want a batch of file operations to stop when I leave,
> keep an undo for every chunk that was confirmed, and never pretend an
> unknown chunk succeeded.

### A retired batch dispatches nothing new, and an unknown chunk is never confirmed

A batch sends its chunks one at a time, each at most once. Once the
batch is retired, no new chunk is sent; the one already sent still
settles. A confirmed chunk keeps its undo. A chunk whose outcome is
unknown may have taken effect, so it is neither confirmed nor undone
automatically, and the batch stops there. A refused chunk stops the
batch and keeps the confirmations before it.

```quint
type ChunkOutcome = ChunkConfirmed | ChunkUnknown | ChunkRefused
type ChunkRecord = { confirmed: bool, undoKept: bool, unknown: bool, batchContinues: bool }
pure def mayDispatchChunk(retired: bool, chunkPending: bool, alreadySent: bool): bool =
  not(retired) and not(chunkPending) and not(alreadySent)
pure def settleChunk(verdict: ChunkOutcome, retired: bool, lastChunk: bool): ChunkRecord =
  if (verdict == ChunkConfirmed) { confirmed: true, undoKept: true, unknown: false, batchContinues: not(retired or lastChunk) }
  else if (verdict == ChunkUnknown) { confirmed: false, undoKept: false, unknown: true, batchContinues: false }
  else { confirmed: false, undoKept: false, unknown: false, batchContinues: false }
pure def lawRetiredBatchSendsNothing(chunkPending: bool, alreadySent: bool): bool =
  not(mayDispatchChunk(true, chunkPending, alreadySent))
pure def lawChunkSentOnce(retired: bool, chunkPending: bool): bool = not(mayDispatchChunk(retired, chunkPending, true))
pure def lawUnknownNeverConfirmed(retired: bool, lastChunk: bool): bool =
  val record = settleChunk(ChunkUnknown, retired, lastChunk)
  not(record.confirmed) and not(record.batchContinues)
pure def lawConfirmedKeepsUndo(retired: bool, lastChunk: bool): bool =
  val record = settleChunk(ChunkConfirmed, retired, lastChunk)
  record.confirmed and record.undoKept
```
