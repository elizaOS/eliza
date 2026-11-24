# Android Files storage and trash custody

The device half of reviewed file operations: the files bridge (`android/filesystem/`,
`StorageBrowser`) changes entries of one mounted volume, one call at a time,
and keeps its Trash in `.Trash-<consumer>` (`files/<id>` data, `info/<id>.json`
origin record). Admission is [the bridge's](../bridge.md). A symbolic-link
component, the Trash root or a path outside the volume is `invalid`.

## Story: Change files only as reviewed

> As the owner, I want a copy, move, rename or trash to touch only the files I
> reviewed, as I reviewed them, so that a file changed since is never moved.

### A call reaches the volume only with storage access, a mounted volume and a valid selection, and a reviewed call also needs focus

Access is the all-files grant (read and write storage on Android 10); the
volume defaults to primary. A selection holds 1 to 500 distinct paths, and a
reviewed one a well-formed token (43 characters of base64url) per path, in
order. Issuing tokens is a focused call that hashes each file's no-follow
identity (file key, times, size, directory flag) and refuses when any row has
none. A token names no volume: the call re-reads identity in its own volume.

```quint
import bridge.* from "../bridge"
type StorageSelection = { reviewed: bool, paths: int, distinct: bool, tokens: int, tokensWellFormed: bool }
type StorageAnswer = StorageReady | StorageUnavailable | StorageDenied | InvalidSelection | ReviewNeeded
pure val batchMax = 500
pure def storageCall(reviewed: bool): BridgeCall =
  { need: if (reviewed) WithFocus else Anytime, needsGrant: true, needsFeature: false }
pure def validSelection(selection: StorageSelection): bool =
  selection.paths >= 1 and selection.paths <= batchMax and selection.distinct and
    (not(selection.reviewed) or (selection.tokens == selection.paths and selection.tokensWellFormed))
pure def admitStorage(presence: PluginPresence, facts: HostFacts, mounted: bool, selection: StorageSelection): StorageAnswer = {
  val admission = admitCall(presence, storageCall(selection.reviewed), facts)
  if (admission == CallAdmitted and mounted and validSelection(selection)) StorageReady
  else if (admission == BridgeUnavailable or admission == DeviceUnsupported or not(mounted)) StorageUnavailable
  else if (admission == PermissionRequired) StorageDenied
  else if (not(validSelection(selection))) InvalidSelection
  else ReviewNeeded
}
pure def issuesReview(presence: PluginPresence, facts: HostFacts, mounted: bool, selection: StorageSelection, identitiesKnown: bool): bool =
  admitStorage(presence, facts, mounted, { ...selection, reviewed: false, tokens: 0 }) == StorageReady and
    admitCall(presence, storageCall(true), facts) == CallAdmitted and identitiesKnown
pure val reviewedTwo: StorageSelection = { reviewed: true, paths: 2, distinct: true, tokens: 2, tokensWellFormed: true }
pure val selectionValues = Set(reviewedTwo, { ...reviewedTwo, tokens: 1 }, { ...reviewedTwo, tokensWellFormed: false },
  { ...reviewedTwo, reviewed: false, paths: 501, tokens: 0 }, { ...reviewedTwo, reviewed: false, tokens: 0 })
pure def lawReviewedDispatchCarriesCurrentAuthority(presence: PluginPresence, facts: HostFacts, mounted: bool, selection: StorageSelection): bool =
  admitStorage(presence, facts, mounted, selection) == StorageReady implies
    presence == PluginRegistered and facts.granted and mounted and selection.paths <= batchMax and
      (selection.reviewed implies (facts.focused and selection.tokens == selection.paths and selection.tokensWellFormed))
pure def lawReviewIsIssuedOnlyWithFocusAndEveryIdentity(presence: PluginPresence, facts: HostFacts, mounted: bool, selection: StorageSelection, identitiesKnown: bool): bool =
  issuesReview(presence, facts, mounted, selection, identitiesKnown) implies facts.focused and facts.granted and mounted and identitiesKnown
```

### A same-folder move is a no-op before its identity is compared, and otherwise a row is admitted only when it is current, owned and as reviewed

Rows keep selection order. A move into the source's own parent answers
`unchanged` with the same path and checks no token; a folder never transfers
into itself or a descendant. Every other reviewed row compares the token with
the identity read at the operation, and a stale one answers `changed`.

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
pure def nativeRowAdmission(op: FilesOp, row: FilesRowCheck): FileOutcome =
  if (not(row.validPath) or not(row.currentOwner)) Invalid
  else if (not(row.pathExists)) Missing
  else if (op == Move and row.sameFolder) Unchanged
  else if (op != Trash and row.descendant) Invalid
  else if (row.reviewRequired and not(row.reviewMatches)) Changed
  else Admitted
pure def lawNativeAdmitsOnlyACurrentReviewedRow(op: FilesOp, row: FilesRowCheck): bool =
  nativeRowAdmission(op, row) == Admitted implies
    row.validPath and row.currentOwner and row.pathExists and (not(row.reviewRequired) or row.reviewMatches) and
      not(op == Move and row.sameFolder) and (op == Trash or not(row.descendant))
pure def lawSameFolderMoveIsANoOpBeforeTheIdentityCheck(row: FilesRowCheck): bool =
  row.validPath and row.currentOwner and row.pathExists and row.sameFolder implies nativeRowAdmission(Move, row) == Unchanged
```

### A rename never replaces a different entry and reports the new path only when it happened

Rename takes no free name. A hidden name is invalid; a destination that is a
link, or an existing entry that is not the same file, is a collision.

```quint
type RenameFacts = { nameValid: bool, sourceFound: bool, targetIsLink: bool, targetExists: bool, targetSameFile: bool, renamed: bool }
type RenameOutcome = Renamed | Collision | RenameInvalid | RenameMissing | RenameFailed
pure def renameOutcome(rename: RenameFacts): RenameOutcome =
  if (not(rename.nameValid)) RenameInvalid
  else if (not(rename.sourceFound)) RenameMissing
  else if (rename.targetIsLink or (rename.targetExists and not(rename.targetSameFile))) Collision
  else if (rename.renamed) Renamed
  else RenameFailed
pure val freeRename: RenameFacts = { nameValid: true, sourceFound: true, targetIsLink: false, targetExists: false, targetSameFile: false, renamed: true }
pure val renameValues = Set(freeRename, { ...freeRename, targetExists: true }, { ...freeRename, targetExists: true, targetSameFile: true },
  { ...freeRename, targetIsLink: true }, { ...freeRename, renamed: false }, { ...freeRename, nameValid: false })
pure def lawRenameCannotReplaceADifferentEntry(rename: RenameFacts): bool =
  renameOutcome(rename) == Renamed implies
    rename.renamed and not(rename.targetIsLink) and (rename.targetExists implies rename.targetSameFile)
```

## Story: Never lose a file half way through a move

> As the owner, I want a move that is interrupted or fails half way to leave
> my file whole somewhere, and to be told it moved only when it did.

### A failed source removal keeps the completed copy, and a move is acknowledged only when it completed

A move refuses a linked source or an existing destination, then tries a
rename. When the rename is refused (another mount), it copies into a fresh
destination and checks the length; a failed copy removes what it wrote, or
leaves a remnant when that fails. After a complete copy the source is removed;
a removal that fails keeps the copy, leaves the source partial (incomplete
here) and answers `failed`, with no rollback or retry. A copy is the same fresh
copy and leaves the source alone. Copy, move and restore take a free name.

```quint
type EntryPresence = EntryMissing | EntryIncomplete | EntryComplete
type MovePath = RenameInPlace | CopyThenRemove
type CopyResult = CopyCleanFailure | CopyLeftRemnant | CopyComplete
type WriteResult = WriteFailed | WriteCopied | WriteMoved
type MoveReceipt = { result: WriteResult, destination: EntryPresence }
pure def copyReceipt(content: EntryPresence, copied: CopyResult): MoveReceipt =
  if (copied == CopyCleanFailure) { result: WriteFailed, destination: EntryMissing }
  else if (copied == CopyLeftRemnant) { result: WriteFailed, destination: EntryIncomplete }
  else { result: WriteCopied, destination: content }
pure def moveReceipt(content: EntryPresence, path: MovePath, copied: CopyResult, sourceRemoved: bool): MoveReceipt =
  if (path == RenameInPlace) { result: WriteMoved, destination: content }
  else if (copied != CopyComplete) copyReceipt(content, copied)
  else { result: if (sourceRemoved) WriteMoved else WriteFailed, destination: content }
pure def sourceAfterMove(content: EntryPresence, path: MovePath, copied: CopyResult, sourceRemoved: bool): EntryPresence =
  if (path == RenameInPlace or (copied == CopyComplete and sourceRemoved)) EntryMissing
  else if (copied == CopyComplete) EntryIncomplete
  else content
pure def lawFailedRemovalKeepsTheCompleteCopy(copied: CopyResult, sourceRemoved: bool): bool =
  copied == CopyComplete and not(sourceRemoved) implies
    moveReceipt(EntryComplete, CopyThenRemove, copied, sourceRemoved) == { result: WriteFailed, destination: EntryComplete }
pure def lawMoveIsAcknowledgedOnlyWhenItCompleted(path: MovePath, copied: CopyResult, sourceRemoved: bool): bool =
  moveReceipt(EntryComplete, path, copied, sourceRemoved).result == WriteMoved implies
    (path == RenameInPlace or (copied == CopyComplete and sourceRemoved))
pure def lawMoveNeverLosesTheFile(path: MovePath, copied: CopyResult, sourceRemoved: bool): bool =
  moveReceipt(EntryComplete, path, copied, sourceRemoved).destination == EntryComplete or
    sourceAfterMove(EntryComplete, path, copied, sourceRemoved) == EntryComplete
```

### A row answers copied, moved or trashed only for an admitted row whose own write was acknowledged

A row that was not admitted answers its admission. An admitted row answers
copied, moved or trashed only when its write was acknowledged with a
resulting path or trash ID, and `failed` otherwise.

```quint
pure def nativeAcknowledged(op: FilesOp, result: WriteResult): bool =
  if (op == Copy) result == WriteCopied else result == WriteMoved
pure def receiptOutcome(op: FilesOp, admission: FileOutcome, acknowledged: bool, resultingId: str): FileOutcome =
  if (admission != Admitted) admission else if (not(acknowledged) or resultingId == "") Failed
  else if (op == Copy) Copied else if (op == Move) Moved else Trashed
pure def nativeRowOutcome(op: FilesOp, row: FilesRowCheck, result: WriteResult, resultingId: str): FileOutcome =
  receiptOutcome(op, nativeRowAdmission(op, row), nativeAcknowledged(op, result), resultingId)
pure def lawWrittenRowMatchesItsReceipt(op: FilesOp, row: FilesRowCheck, result: WriteResult, resultingId: str): bool = {
  val answer = nativeRowOutcome(op, row, result, resultingId)
  (answer == Copied implies (result == WriteCopied and nativeRowAdmission(op, row) == Admitted)) and
    ((answer == Moved or answer == Trashed) implies (result == WriteMoved and nativeRowAdmission(op, row) == Admitted))
}
```

### A move into another volume takes the copy path, and its copy is written and cleaned up on that volume

A copy or move may name a destination folder on another mounted volume. The
destination resolves as a path of that volume, and every copied or moved row
names its new path there. Android refuses a rename across volumes, so such a
move always copies, checks and then removes the source as above. A copy that
fails part way is removed again from the destination volume, the only place
it was written.

```quint
type VolumeTransfer = { crossVolume: bool, renameAccepted: bool, copied: CopyResult, sourceRemoved: bool }
pure def transferMovePath(transfer: VolumeTransfer): MovePath =
  if (not(transfer.crossVolume) and transfer.renameAccepted) RenameInPlace else CopyThenRemove
pure def transferReceipt(transfer: VolumeTransfer): MoveReceipt =
  moveReceipt(EntryComplete, transferMovePath(transfer), transfer.copied, transfer.sourceRemoved)
pure val crossComplete: VolumeTransfer = { crossVolume: true, renameAccepted: false, copied: CopyComplete, sourceRemoved: true }
pure val transferValues = Set(crossComplete, { ...crossComplete, sourceRemoved: false }, { ...crossComplete, copied: CopyCleanFailure },
  { ...crossComplete, copied: CopyLeftRemnant }, { ...crossComplete, renameAccepted: true }, { ...crossComplete, crossVolume: false, renameAccepted: true })
pure def lawACrossVolumeMoveTakesTheCopyPath(transfer: VolumeTransfer): bool =
  transfer.crossVolume implies transferMovePath(transfer) == CopyThenRemove
pure def lawACrossVolumeMoveIsAcknowledgedOnlyAfterACompleteCopy(transfer: VolumeTransfer): bool =
  (transfer.crossVolume and transferReceipt(transfer).result == WriteMoved) implies (transfer.copied == CopyComplete and transfer.sourceRemoved)
pure def lawAFailedCrossVolumeCopyLeavesNoCompleteCopy(transfer: VolumeTransfer): bool =
  (transfer.crossVolume and transfer.copied != CopyComplete) implies transferReceipt(transfer).destination != EntryComplete
```

## Story: Get back exactly what I trashed

> As the owner, I want a trashed file to keep the way back to where it was,
> come back there only when it really moved, and be erased only when I
> confirm it or its 30 days are over.

### Trash forces the origin record before it moves anything, and Trash data always has its record

The machine is one entry under its fresh ID. Its record (name, origin, deletion
time, directory flag, size, MIME type) is forced to storage before the move. A
failed move keeps it while any data reached the Trash and otherwise tries to
remove it; a process death between leaves it with data absent, partial or whole.

```quint
type TrashStage = Fresh | Moving | Settled | Erasing
type OriginRecord = NoRecord | Recorded({ deletedAt: int })
type Interruption = BeforeMove | DuringCopy | DuringRemoval | AfterRename
type TrashAnswer = NoAnswer | MovedToTrash | TrashMoveFailed | RestoredToOrigin | RestoreFailed | ShownInList | HiddenFromList | ErasedForever | EraseFailed
type NativeTrashCustody = { stage: TrashStage, record: OriginRecord, source: EntryPresence, payload: EntryPresence, restored: EntryPresence, answer: TrashAnswer }
pure val initial: NativeTrashCustody =
  { stage: Fresh, record: NoRecord, source: EntryComplete, payload: EntryMissing, restored: EntryMissing, answer: NoAnswer }
pure def canRecordOrigin(s: NativeTrashCustody, row: FilesRowCheck, deletedAt: int): bool =
  s.stage == Fresh and nativeRowAdmission(Trash, row) == Admitted and deletedAt >= 0
pure def recordOrigin(s: NativeTrashCustody, row: FilesRowCheck, deletedAt: int): NativeTrashCustody =
  { ...s, stage: Moving, record: Recorded({ deletedAt: deletedAt }) }
pure def canFinishTrashMove(s: NativeTrashCustody): bool = s.stage == Moving
pure def finishTrashMove(s: NativeTrashCustody, path: MovePath, copied: CopyResult, sourceRemoved: bool, recordCleaned: bool): NativeTrashCustody = {
  val receipt = moveReceipt(s.source, path, copied, sourceRemoved)
  { ...s, stage: Settled, source: sourceAfterMove(s.source, path, copied, sourceRemoved), payload: receipt.destination,
    record: if (receipt.destination == EntryMissing and recordCleaned) NoRecord else s.record,
    answer: if (receipt.result == WriteMoved) MovedToTrash else TrashMoveFailed }
}
pure def canInterruptTrashMove(s: NativeTrashCustody): bool = s.stage == Moving
pure def interruptTrashMove(s: NativeTrashCustody, cut: Interruption): NativeTrashCustody =
  { ...s, stage: Settled,
    source: if (cut == DuringRemoval) EntryIncomplete else if (cut == AfterRename) EntryMissing else s.source,
    payload: if (cut == BeforeMove) EntryMissing else if (cut == DuringCopy) EntryIncomplete else EntryComplete }
pure val deletedAtValues = Set(0, 1)
pure def alwaysTheOriginIsRecordedBeforeAnyMove(s: NativeTrashCustody): bool =
  (s.stage == Fresh implies (s.record == NoRecord and s.source == EntryComplete and s.payload == EntryMissing and s.restored == EntryMissing)) and
  (s.stage == Moving implies (s.record != NoRecord and s.source == EntryComplete and s.payload == EntryMissing and s.restored == EntryMissing)) and
  (s.payload != EntryMissing implies s.record != NoRecord)
pure def stepTrashDataArrivesOnlyAfterItsRecord(before: NativeTrashCustody, after: NativeTrashCustody): bool =
  (before.payload == EntryMissing and after.payload != EntryMissing) implies (before.stage == Moving and before.record != NoRecord)
pure def sometimesTrashed(s: NativeTrashCustody): bool = s.answer == MovedToTrash and s.payload == EntryComplete and s.source == EntryMissing
pure def sometimesFailedMoveKeepsACompleteCopy(s: NativeTrashCustody): bool = s.answer == TrashMoveFailed and s.payload == EntryComplete and s.source == EntryIncomplete
pure def sometimesInterruptionLeavesAnOrphanRecord(s: NativeTrashCustody): bool = s.stage == Settled and s.record != NoRecord and s.payload == EntryMissing
```

### Until its erasure begins the file is whole at its source, in the Trash or back at its origin

Erasure begins when listing past expiry or the owner removes the data; a
removal that fails part way may leave it partial, and the entry stays listed.

```quint
pure def alwaysTheFileSurvivesUntilErasureBegins(s: NativeTrashCustody): bool =
  s.stage != Erasing implies (s.source == EntryComplete or s.payload == EntryComplete or s.restored == EntryComplete)
```

### Restore moves the data to its recorded origin and says restored only when that move completed

The origin resolves in the same volume (its root when no longer a valid path)
and is recreated when missing; an unreadable record fails and changes nothing.
A failed restore keeps the record and any complete copy left at the origin. A
completed one answers `restored` even when its record stays; listing removes
that orphan.

```quint
pure def betterOf(a: EntryPresence, b: EntryPresence): EntryPresence =
  if (a == EntryComplete or b == EntryComplete) EntryComplete
  else if (a == EntryIncomplete or b == EntryIncomplete) EntryIncomplete else EntryMissing
pure def canRestoreFromTrash(s: NativeTrashCustody): bool =
  (s.stage == Settled or s.stage == Erasing) and s.record != NoRecord and s.payload != EntryMissing
pure def restoreFromTrash(s: NativeTrashCustody, path: MovePath, copied: CopyResult, sourceRemoved: bool, recordCleaned: bool): NativeTrashCustody = {
  val receipt = moveReceipt(s.payload, path, copied, sourceRemoved)
  val atOrigin = betterOf(s.restored, receipt.destination)
  if (receipt.result == WriteMoved)
    { ...s, payload: EntryMissing, restored: atOrigin, record: if (recordCleaned) NoRecord else s.record, answer: RestoredToOrigin }
  else { ...s, payload: sourceAfterMove(s.payload, path, copied, sourceRemoved), restored: atOrigin, answer: RestoreFailed }
}
pure def stepRestoreConfirmsOnlyACompletedMove(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  (via == "restoreFromTrash" and after.answer == RestoredToOrigin) implies
    (before.payload != EntryMissing and after.payload == EntryMissing and after.restored != EntryMissing)
pure def sometimesRestored(s: NativeTrashCustody): bool = s.answer == RestoredToOrigin and s.restored == EntryComplete and s.record == NoRecord
pure def sometimesRestoreFailsWithACompleteDestination(s: NativeTrashCustody): bool =
  s.answer == RestoreFailed and s.restored == EntryComplete and s.record != NoRecord
```

### Listing erases only an entry past its 30 days, and removes the record only after the data is gone

Listing never creates the Trash. An entry whose data is gone is hidden and its
orphan record removed. An unreadable record is hidden and its data left for
recovery by hand. Past the deadline listing removes the data, then the record;
a removal that fails leaves the entry shown for this scan.

```quint
type TrashCleanup = { payloadLeft: EntryPresence, recordRemoved: bool }
pure val trashRetentionMs = 2592000000
pure def recordedAt(record: OriginRecord): int = match record { | Recorded(r) => r.deletedAt | NoRecord => 0 }
pure def remainingPayload(held: EntryPresence, left: EntryPresence): EntryPresence =
  if (held == EntryMissing or left == EntryMissing) EntryMissing else if (left == EntryIncomplete) EntryIncomplete else held
pure def removeEntry(cleanup: TrashCleanup, s: NativeTrashCustody, removed: TrashAnswer, kept: TrashAnswer): NativeTrashCustody = {
  val left = remainingPayload(s.payload, cleanup.payloadLeft)
  val gone = left == EntryMissing and cleanup.recordRemoved
  { ...s, stage: Erasing, payload: left, record: if (gone) NoRecord else s.record, answer: if (gone) removed else kept }
}
pure def canListTrash(s: NativeTrashCustody): bool = (s.stage == Settled or s.stage == Erasing) and s.record != NoRecord
pure def listTrash(s: NativeTrashCustody, at: int, cleanup: TrashCleanup): NativeTrashCustody =
  if (s.payload == EntryMissing) { ...s, record: if (cleanup.recordRemoved) NoRecord else s.record, answer: HiddenFromList }
  else if (at < recordedAt(s.record) + trashRetentionMs) { ...s, answer: ShownInList }
  else removeEntry(cleanup, s, HiddenFromList, ShownInList)
pure val atValues = Set(1, 2592000001)
pure val cleanupValues = Set({ payloadLeft: EntryMissing, recordRemoved: true }, { payloadLeft: EntryMissing, recordRemoved: false },
  { payloadLeft: EntryIncomplete, recordRemoved: false }, { payloadLeft: EntryComplete, recordRemoved: true })
pure def stepListingShowsOnlyARecordedEntry(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  (via == "listTrash" and after.answer == ShownInList) implies after.record != NoRecord
pure def sometimesShownWithinRetention(s: NativeTrashCustody): bool = s.answer == ShownInList and s.stage == Settled
pure def sometimesExpiryWaitsOnRecordCleanup(s: NativeTrashCustody): bool =
  s.answer == ShownInList and s.stage == Erasing and s.payload == EntryMissing and s.record != NoRecord
```

### Erasing forever takes the owner's confirmation and is counted only when both data and record are gone

The renderer confirms 1 to 500 distinct listed IDs; only those are erased, so
an entry trashed later is never touched. Data goes first, without following
links, then the record; the count is of entries whose two removals succeeded.

```quint
type EraseRequest = { confirmed: bool, ids: int, distinctIds: bool, namesThisEntry: bool }
pure def confirmedErase(request: EraseRequest): bool =
  request.confirmed and request.ids >= 1 and request.ids <= batchMax and request.distinctIds and request.namesThisEntry
pure def canEraseForever(s: NativeTrashCustody, request: EraseRequest): bool =
  (s.stage == Settled or s.stage == Erasing) and s.record != NoRecord and confirmedErase(request)
pure def eraseForever(s: NativeTrashCustody, request: EraseRequest, cleanup: TrashCleanup): NativeTrashCustody =
  removeEntry(cleanup, s, ErasedForever, EraseFailed)
pure val confirmedOne: EraseRequest = { confirmed: true, ids: 1, distinctIds: true, namesThisEntry: true }
pure val requestValues = Set(confirmedOne, { ...confirmedOne, confirmed: false }, { ...confirmedOne, ids: 2, namesThisEntry: false }, { ...confirmedOne, ids: 0 })
pure def stepEraseIsReportedOnlyWhenDataAndRecordAreGone(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  via == "eraseForever" implies ((after.answer == ErasedForever) iff (after.payload == EntryMissing and after.record == NoRecord))
pure def sometimesErased(s: NativeTrashCustody): bool = s.answer == ErasedForever
pure def sometimesErasureLeavesItsRecord(s: NativeTrashCustody): bool = s.answer == EraseFailed and s.record != NoRecord
```

## Story: Browse my storage as I asked

> As the owner, I want to see hidden files only when I ask for them, never
> the app's own Trash folder, and an honest size for each category, so that
> browsing never surprises me or hides what takes up space.

### A listing or folder walk shows dot entries only when asked, and never the Trash under any spelling

A folder listing and the folder filter's walk skip dot entries unless the
owner asks for hidden entries, and a folder's child count follows the same
choice. The Trash folder at the volume root is never listed, counted or
walked into, whatever the case of its name: shared storage ignores case, so a
`.TRASH-x` another app made is the Trash. A dot folder elsewhere named like
the Trash is an ordinary hidden folder.

```quint
type ListedEntry = { dotName: bool, trashName: bool, atVolumeRoot: bool }
pure def entryShown(listed: ListedEntry, hidden: bool): bool =
  not(listed.dotName) or (hidden and not(listed.trashName and listed.atVolumeRoot))
pure val plainEntry: ListedEntry = { dotName: false, trashName: false, atVolumeRoot: true }
pure val listedValues = Set(plainEntry, { ...plainEntry, dotName: true }, { ...plainEntry, dotName: true, trashName: true },
  { dotName: true, trashName: true, atVolumeRoot: false })
pure def lawDotEntriesAreShownOnlyWhenAsked(listed: ListedEntry, hidden: bool): bool =
  (listed.dotName and entryShown(listed, hidden)) implies hidden
pure def lawTheTrashIsNeverListed(listed: ListedEntry, hidden: bool): bool =
  (listed.trashName and listed.atVolumeRoot) implies not(entryShown(listed, hidden))
pure def lawAVisibleNameIsAlwaysListed(listed: ListedEntry, hidden: bool): bool =
  not(listed.dotName) implies entryShown(listed, hidden)
```

### A category count totals the sizes its files record, and a file without one adds nothing

A Browse category count answers how many visible files the category holds
and `bytes`, the sum of their sizes: Downloads counts the files directly in
its folder, every other category its media provider rows. A row with no
recorded size, or a negative one, adds nothing, so the total is never
negative and never guessed.

```quint
type CategoryRow = { sized: bool, size: int }
pure def categoryRowBytes(categoryRow: CategoryRow): int = if (categoryRow.sized and categoryRow.size > 0) categoryRow.size else 0
pure def categoryBytes(rows: List[CategoryRow]): int = rows.foldl(0, (total, counted) => total + categoryRowBytes(counted))
pure val unsizedRow: CategoryRow = { sized: false, size: 0 }
pure val rowsValues: Set[List[CategoryRow]] = Set(List(), List({ sized: true, size: 5 }), List({ sized: true, size: 5 }, { sized: true, size: -1 }, unsizedRow))
pure def lawAnUnsizedRowAddsNothing(rows: List[CategoryRow]): bool = categoryBytes(rows.append(unsizedRow)) == categoryBytes(rows)
pure def lawACategoryTotalIsNeverNegative(rows: List[CategoryRow]): bool = categoryBytes(rows) >= 0
pure def lawASizedRowAddsItsSize(rows: List[CategoryRow]): bool =
  categoryBytes(rows.append({ sized: true, size: 5 })) == categoryBytes(rows) + 5
```
