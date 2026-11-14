# Alpha's scoped Files operations

`apps/app/src/browser/files.ts` imports Eliza's
`plugins/plugin-files/src/browser/{files,storage-volume}.ts`. Its renderer
also uses the upstream browser adapter/model and reviewed `files-agent-contract`.
The previous Alpha Quint models are `FilesBrowserController`, `FilesAndSharing`,
`FilesPreview`, `BrowserFilesTrash`, `FilesFilter`, `FilesRecentIndex`, and
`FilesTree`. Eliza's pinned `FilesDirectAdmission` and `FilesViewOwnership`
cover direct and view-scoped requests, and `DeviceFilesNegotiation` and
`FilesReviewOwnership` cover agent review. This model owns per-row reviewed
mutation custody. Browser, Android, and remote adapters provide current row
identity, validated normalized paths and operation receipts.

## Story: Act only on the file revision I reviewed

### The mutation re-reads each selected row and reports each outcome

A recognized selection is nonempty, bounded, unique, and points to a
valid destination for transfers. For an admitted batch each row receives
its own outcome in request order. Reviewed transfers and deletes compare
an exact token for the current row ID and revision before any action.
An invalid or missing row, replaced revision, same-folder move, or
transfer into a selected folder's descendant does not reach a filesystem
operation. Copy and move accept a collision-free name. The resulting path
or trash ID comes from the write receipt. An unknown write result cannot
fabricate an applied outcome or autonomously repeat a mutation.

```quint
type FilesOp = Copy | Move | Trash
type FilesRowCheck = { validPath: bool, pathExists: bool, reviewRequired: bool, reviewMatches: bool, currentOwner: bool, sameFolder: bool, descendant: bool }
type FileOutcome = Invalid | Missing | Changed | Unchanged | Admitted | Copied | Moved | Trashed | Failed
pure val rowValues = Set(
  { validPath: true, pathExists: true, reviewRequired: true, reviewMatches: true, currentOwner: true, sameFolder: false, descendant: false },
  { validPath: true, pathExists: true, reviewRequired: true, reviewMatches: false, currentOwner: true, sameFolder: false, descendant: false },
  { validPath: true, pathExists: true, reviewRequired: false, reviewMatches: false, currentOwner: true, sameFolder: true, descendant: false },
  { validPath: true, pathExists: true, reviewRequired: false, reviewMatches: false, currentOwner: false, sameFolder: false, descendant: true },
  { validPath: false, pathExists: false, reviewRequired: false, reviewMatches: false, currentOwner: true, sameFolder: false, descendant: false }
)
pure def classifyRow(op: FilesOp, row: FilesRowCheck): FileOutcome =
  if (not(row.validPath) or not(row.currentOwner)) Invalid else if (not(row.pathExists)) Missing
  else if (row.reviewRequired and not(row.reviewMatches)) Changed
  else if (op == Move and row.sameFolder) Unchanged
  else if (op != Trash and row.descendant) Invalid
  else Admitted
pure def receiptOutcome(op: FilesOp, admission: FileOutcome, acknowledged: bool, resultingId: str): FileOutcome =
  if (admission != Admitted) admission else if (not(acknowledged) or resultingId == "") Failed
  else if (op == Copy) Copied else if (op == Move) Moved else Trashed
pure def lawStaleReviewedRowIsNotAdmitted(op: FilesOp, row: FilesRowCheck): bool = classifyRow(op, row) == Admitted implies row.currentOwner and (not(row.reviewRequired) or row.reviewMatches)
pure def lawAppliedRequiresReceipt(op: FilesOp, row: FilesRowCheck, acknowledged: bool, resultingId: str): bool = {
  val answer = receiptOutcome(op, classifyRow(op, row), acknowledged, resultingId)
  (answer == Copied or answer == Moved or answer == Trashed) implies classifyRow(op, row) == Admitted and acknowledged and resultingId != ""
}
```

### Trash owns a journal entry before moving the row

Trash operations share the same namespace lock with listing and pruning.
They write origin and deletion-time metadata first, move to the trash
container, and remove that journal row if the move fails. Unknown outcomes
remain explicit. Listing exposes only rows with metadata and actual trash
residency. A row expires at 30 days; deletion and journal cleanup are
separate receipts. Real tree validation, collision naming, per-folder
iteration, symlink/volume restrictions, cross-process locks, and hard
storage failure require adapter refinement.

```quint
type TrashPhase = Visible | Journaled | InTrash | MoveFailed | Expiring | Gone
pure val journaledPhase: TrashPhase = Journaled
pure val trashPhase: TrashPhase = InTrash
pure val failedPhase: TrashPhase = MoveFailed
pure val gonePhase: TrashPhase = Gone
pure val expiryMillis = 2592000000
type TrashRow = { phase: TrashPhase, journal: bool, resident: bool, deletedAt: int }
pure val initial: TrashRow = { phase: Visible, journal: false, resident: false, deletedAt: 0 }
pure def canJournal(s: TrashRow, op: FilesOp, row: FilesRowCheck, at: int): bool = s.phase == Visible and at >= 0 and op == Trash and classifyRow(op, row) == Admitted
pure def journal(s: TrashRow, op: FilesOp, row: FilesRowCheck, at: int): TrashRow = { ...s, phase: journaledPhase, journal: true, deletedAt: at }
pure def canMoveToTrash(s: TrashRow): bool = s.phase == Journaled
pure def moveToTrash(s: TrashRow, acknowledged: bool): TrashRow = { ...s, phase: if (acknowledged) trashPhase else failedPhase, resident: acknowledged }
pure def canUndoFailedJournal(s: TrashRow): bool = s.phase == MoveFailed
pure def undoFailedJournal(s: TrashRow): TrashRow = initial
pure def canPrune(s: TrashRow, at: int): bool = s.phase == InTrash and at - s.deletedAt >= expiryMillis
pure def prune(s: TrashRow, at: int, erased: bool): TrashRow = if (erased) { ...s, phase: Expiring, resident: false } else s
pure def canCompletePrune(s: TrashRow): bool = s.phase == Expiring
pure def completePrune(s: TrashRow, writeAcknowledged: bool): TrashRow = if (writeAcknowledged) { ...s, phase: gonePhase, journal: false } else s
pure def alwaysJournalPrecedesResidency(s: TrashRow): bool = s.resident == (s.phase == InTrash) and (s.journal == (s.phase == Journaled or s.phase == InTrash or s.phase == MoveFailed or s.phase == Expiring))
pure def listed(s: TrashRow, at: int): bool = s.resident and s.journal and at - s.deletedAt < expiryMillis
pure def lawExpiredIsNotListed(s: TrashRow, at: int): bool = at - s.deletedAt >= expiryMillis implies not(listed(s, at))
pure val atValues = Set(0, 1, 2592000000, 2592000001)
pure def sometimesTrashed(s: TrashRow): bool = s.phase == InTrash
pure def sometimesFailedMoveRetainsJournal(s: TrashRow): bool = s.phase == MoveFailed and s.journal
pure def sometimesMetadataCleanupRemainsPending(s: TrashRow): bool = s.phase == Expiring and s.journal and not(s.resident)
```
