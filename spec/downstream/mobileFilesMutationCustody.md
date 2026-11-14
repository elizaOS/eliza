# Alpha Android Files mutation and trash custody

AlphaPhone `8d44dfe5` installs the projected
`plugins/plugin-files/src/browser/files-browser-adapter.ts` in
`apps/app/src/prototype/selection-adapter.ts`. It binds the storage port
to `AlphaFilesPlugin.java`, which imports `StorageBrowser` and
`StorageCatalog` from Eliza `c518127a` under
`plugins/plugin-native-filesystem/android/src/main/java/ai/eliza/plugins/filesystem/browser`.
The Android implementation owns the reviewed file identity, the write and
its filesystem receipts. [Files review](./alpha/files.md) owns common
review admission. [Storage watches](./mobileStorageWatch.md) own observer
registration and [selected document grants](./mobileSelectedDocumentGrants.md)
own the separate picker authority. Grace uses its own document and
app handoffs and does not register Alpha's volume browser.

The Android receipts refine the shared Files contract in three places.
A same-folder Move returns an unchanged receipt before the identity
comparison. A failed native move can retain a complete destination.
An expired Trash entry can appear in the same scan if the provider
cannot finish its cleanup. These receipts report the platform branch.
The renderer counts only acknowledged `moved` or `trashed` rows in its
reviewed action summary. The pinned Android plugin serializes calls
within each bridge instance.

Alpha's `test/files-browser.test.mjs` compiles the pinned Java engine
with `test/fixtures/StorageBrowserTest.java`. The fixture covers paths,
reviewed replacements, collision handling, copy failure, Trash restore,
retention and deletion. `test/files-storage-refusal.test.mjs` covers
worker and permission refusal dispatch. `test/files-legacy-storage.test.mjs`
covers the API 29 permission seam. The product
`StorageLegacyAccessInstrumentedTest` and `StorageCategoriesInstrumentedTest`
are Android evidence lanes.

## Story: Change only the reviewed file in the selected volume

### Review and dispatch bind to the granted, mounted volume and ordered selection

The worker checks storage access before resolving a mounted volume,
defaulting to primary when no volume is supplied. The path adapter
uses canonical volume-relative paths, excludes the hidden Trash
root and refuses symlink components. Its host facts represent real
path resolution and mounted-volume checks. Android 10 needs both
legacy storage permissions. Android 11 and later use all-files access.
The launcher and browser policy remain outside this port.

The plugin takes 1–500 distinct path strings. Review is foreground
only and reads each resolved file's no-follow metadata. It refuses a
review if any selected row lacks an identity. The token is unpadded
base64url of a SHA-256 digest of file key, creation time, last modified
time, size, and directory flag. This is an opaque metadata identity.
A reviewed mutation validates one 43-character base64url token for
each path in that same order and requires focus at dispatch. Direct
Files UI actions can omit those review tokens. The agent moves and
trashes only with reviewed tokens and the primary volume. The adapter
binds an observed review to the volume of its selection. The Java token
encoding has no independent volume field. The bridge scopes each call
to its requested mounted volume and re-reads that volume's file identity.

```quint
type FilesStorageAccess = { workerLive: bool, storageGranted: bool, volumeMounted: bool, focused: bool }
type SelectionFacts = { pathCount: int, distinctPaths: bool, reviewed: bool,
  tokenCount: int, tokensValid: bool, exactVolume: bool }
pure def validFilesBatch(batch: SelectionFacts): bool =
  batch.pathCount >= 1 and batch.pathCount <= 500 and batch.distinctPaths and
    (not(batch.reviewed) or (batch.tokenCount == batch.pathCount and batch.tokensValid and batch.exactVolume))
pure def admittedFilesDispatch(access: FilesStorageAccess, batch: SelectionFacts): bool =
  access.workerLive and access.storageGranted and access.volumeMounted and validFilesBatch(batch) and
    (not(batch.reviewed) or access.focused)
pure def issuesFilesReview(access: FilesStorageAccess, batch: SelectionFacts, allIdentitiesAvailable: bool): bool =
  access.workerLive and access.storageGranted and access.volumeMounted and access.focused and
    batch.pathCount >= 1 and batch.pathCount <= 500 and batch.distinctPaths and allIdentitiesAvailable
pure def lawEverySelectedFileMustBeVerifiable(access: FilesStorageAccess, batch: SelectionFacts, allIdentitiesAvailable: bool): bool =
  issuesFilesReview(access, batch, allIdentitiesAvailable) implies access.focused and allIdentitiesAvailable
pure val liveStorage: FilesStorageAccess = { workerLive: true, storageGranted: true, volumeMounted: true, focused: true }
pure val reviewedBatch: SelectionFacts = { pathCount: 2, distinctPaths: true, reviewed: true,
  tokenCount: 2, tokensValid: true, exactVolume: true }
pure val accessValues = Set(liveStorage, { ...liveStorage, workerLive: false }, { ...liveStorage, storageGranted: false },
  { ...liveStorage, focused: false }, { ...liveStorage, volumeMounted: false })
pure val batchValues = Set(reviewedBatch, { ...reviewedBatch, tokenCount: 1 },
  { ...reviewedBatch, exactVolume: false }, { ...reviewedBatch, pathCount: 501 },
  { ...reviewedBatch, reviewed: false, tokenCount: 0 })
pure def lawReviewedFilesDispatchCarriesCurrentAuthority(access: FilesStorageAccess, batch: SelectionFacts): bool =
  admittedFilesDispatch(access, batch) and batch.reviewed implies access.workerLive and access.storageGranted and
    access.volumeMounted and access.focused and batch.exactVolume and batch.pathCount == batch.tokenCount and batch.tokensValid
```

### Files separates no-op, collision, stale identity, and confirmed write outcomes

A valid batch carries outcomes in selection order. Transfers first
resolve a real destination directory. A missing source yields
`missing`; a source outside the selected volume, its root or its
hidden Trash yields `invalid` when path validation refuses it.
A Move to the current parent returns `unchanged` and the same
path before checking a token. A directory cannot transfer into
itself or a descendant. Other reviewed moves, copies and trashes
check the current source identity before mutation. A stale token
yields `changed`. A validation or provider error that escapes
per-item handling may terminate the bridge request after earlier
rows changed. A batch failure does not roll those rows back.

Copy, Move and restore choose a case-insensitively free name, adding
a numbered suffix before the file extension or after the directory
name. Explicit rename is separate. It rejects a hidden name, a
destination symbolic link, and a distinct existing destination. It
allows an existing destination denoting the same file. Explicit
rename calls the native rename once and returns the observed new
path only when it succeeds. Folder creation uses the free-name
policy and requires an existing parent directory. The shell supplies
canonical path, filename, collision and operation readback evidence.
The same-path Move receipt grants no mutation authority. Source
identity is read just before an admitted effect. The pinned code has
no atomic inode comparison at the rename or copy syscall.

```quint
type FilesChange = NativeCopy | NativeMove | NativeTrash
type FilesAdmission = FilesInvalid | FilesMissing | FilesUnchanged | FilesChanged | FilesAdmitted
type FilesSource = { validPath: bool, found: bool, sameParent: bool, intoOwnTree: bool, needsReview: bool, revisionExact: bool }
pure def filesRowAdmission(operation: FilesChange, source: FilesSource): FilesAdmission =
  if (not(source.validPath)) FilesInvalid
  else if (not(source.found)) FilesMissing
  else if (operation == NativeMove and source.sameParent) FilesUnchanged
  else if (operation != NativeTrash and source.intoOwnTree) FilesInvalid
  else if (source.needsReview and not(source.revisionExact)) FilesChanged
  else FilesAdmitted
pure val currentSource: FilesSource = { validPath: true, found: true, sameParent: false, intoOwnTree: false,
  needsReview: true, revisionExact: true }
pure val sourceValues = Set(currentSource, { ...currentSource, sameParent: true, revisionExact: false },
  { ...currentSource, found: false }, { ...currentSource, validPath: false },
  { ...currentSource, intoOwnTree: true }, { ...currentSource, revisionExact: false })
pure def lawNativeSameFolderIsNoOpBeforeRevision(source: FilesSource): bool =
  source.validPath and source.found and source.sameParent implies filesRowAdmission(NativeMove, source) == FilesUnchanged
pure def lawNativeReviewedWriteChecksTheCurrentIdentity(operation: FilesChange, source: FilesSource): bool =
  filesRowAdmission(operation, source) == FilesAdmitted and source.needsReview implies source.revisionExact
type RenameFacts = { sourceValid: bool, sourceFound: bool, visibleName: bool, destinationIsLink: bool,
  destinationExists: bool, destinationSameFile: bool, renameSucceeded: bool, reportedPath: str }
pure def nativeRenameConfirmed(rename: RenameFacts): bool =
  rename.sourceValid and rename.sourceFound and rename.visibleName and not(rename.destinationIsLink) and
    (not(rename.destinationExists) or rename.destinationSameFile) and rename.renameSucceeded and rename.reportedPath != ""
pure val successfulRename: RenameFacts = { sourceValid: true, sourceFound: true, visibleName: true, destinationIsLink: false,
  destinationExists: false, destinationSameFile: false, renameSucceeded: true, reportedPath: "Download/after.txt" }
pure val renameValues = Set(successfulRename, { ...successfulRename, destinationExists: true },
  { ...successfulRename, destinationExists: true, destinationSameFile: true }, { ...successfulRename, renameSucceeded: false })
pure def lawNativeRenameCannotReplaceADifferentExistingEntry(rename: RenameFacts): bool =
  nativeRenameConfirmed(rename) implies not(rename.destinationIsLink) and (not(rename.destinationExists) or rename.destinationSameFile)
```

## Story: Keep enough custody to recover a partial Files move

### The fallback preserves a completed destination when source removal fails

The shared move first refuses a linked source or existing destination
and tries a native rename. A successful rename completes the move.
When rename returns false, the fallback copies into a fresh
destination and verifies file lengths. File modification time is
copied on a best-effort basis. A failed copy attempts to remove the
partly written destination. If cleanup fails, the leftover stays
visible to subsequent provider inspection. The ordinary Copy path
uses the same fresh-copy behavior and leaves the original in place.

After a complete fallback copy, the source removal begins. An
unsuccessful removal can leave all, some, or none of the original
entries. The completed destination stays in its entirety. The operation
reports failure and does not certify rollback or retry automatically.
A rename acknowledgement stands on the native operation, and a
fallback move acknowledgement requires both a complete copy and
confirmed source deletion. The complete destination reflects the
provider input read by that operation. The pinned file-length check
supplies no hash proof or assurance about an earlier version.

```quint
type EntryPresence = EntryMissing | EntryComplete | EntryIncomplete
type MoveMethod = DirectRename | CopyOnly | CopyThenDelete
type CopyResult = CopyCleanFailure | CopyLeftRemnant | CopyComplete
type WriteResult = NativeWriteFailed | NativeWriteCopied | NativeWriteMoved
type MoveReceipt = { answer: WriteResult, destination: EntryPresence }
pure def moveReceipt(method: MoveMethod, copied: CopyResult, sourceRemovalConfirmed: bool): MoveReceipt =
  if (method == DirectRename) { answer: NativeWriteMoved, destination: EntryComplete }
  else if (copied == CopyCleanFailure) { answer: NativeWriteFailed, destination: EntryMissing }
  else if (copied == CopyLeftRemnant) { answer: NativeWriteFailed, destination: EntryIncomplete }
  else if (method == CopyOnly) { answer: NativeWriteCopied, destination: EntryComplete }
  else if (sourceRemovalConfirmed) { answer: NativeWriteMoved, destination: EntryComplete }
  else { answer: NativeWriteFailed, destination: EntryComplete }
pure def lawFailedRemovalPreservesFallbackCopy(copied: CopyResult, sourceRemovalConfirmed: bool): bool =
  copied == CopyComplete and not(sourceRemovalConfirmed) implies
    moveReceipt(CopyThenDelete, copied, sourceRemovalConfirmed).answer == NativeWriteFailed and
    moveReceipt(CopyThenDelete, copied, sourceRemovalConfirmed).destination == EntryComplete
pure def lawAcknowledgedFallbackMoveRequiresBothSteps(copied: CopyResult, sourceRemovalConfirmed: bool): bool =
  moveReceipt(CopyThenDelete, copied, sourceRemovalConfirmed).answer == NativeWriteMoved implies
    copied == CopyComplete and sourceRemovalConfirmed
```

### Trash records the origin before moving and keeps metadata for any retained target

Trash stores the data and origin record under one unique ID in the
selected volume's `.Trash-alpha` folder. It validates those namespaces
and creates a `.nomedia` marker before writing. The record includes
the original name, origin folder, wall-clock deletion time, type,
size, and MIME type. The write creates a new record and forces it
before any move. A row with a successful move returns `trashed`
and the ID. A row with a failed move returns `failed`. If the target
exists after failure, the catch keeps the record with it. If the
target is absent after failure, the code tries to remove the record.
A partial target left by a failed copy can therefore remain with
its record. A crash can strand a record before any data moves.

The model follows one already selected volume and one unique
trash ID. The port owns record read and creation, exact volume and
ID selection, and a snapshot of file presence. Once a record
commits the operation moves exactly its associated data. File and
record cleanup receipts describe one worker's operation. The pinned
bridge does not supply a cross-instance filesystem lock. External file
changes remain provider observations.

```quint
type TrashReply = TrashNone | TrashRecorded | TrashMoved | TrashMoveFailed | TrashRestored |
  TrashRestoreFailed | TrashShown | TrashHidden | TrashErased | TrashEraseFailed
type NativeTrashCustody = { record: bool, payload: EntryPresence, writing: bool, used: bool,
  deletedAt: int, reply: TrashReply, restoredDestination: EntryPresence, removedCount: int }
pure val initial: NativeTrashCustody = { record: false, payload: EntryMissing, writing: false,
  used: false, deletedAt: 0, reply: TrashNone, restoredDestination: EntryMissing, removedCount: 0 }
pure def canCommitFilesTrashRecord(s: NativeTrashCustody, review: FilesAdmission, deletedAt: int): bool =
  not(s.used) and review == FilesAdmitted and deletedAt >= 0
pure def commitFilesTrashRecord(s: NativeTrashCustody, review: FilesAdmission, deletedAt: int): NativeTrashCustody =
  { ...s, used: true, writing: true, record: true, deletedAt: deletedAt, reply: TrashRecorded }
pure def canCompleteFilesTrashMove(s: NativeTrashCustody, method: MoveMethod): bool =
  s.writing and s.record and method != CopyOnly
pure def completeFilesTrashMove(s: NativeTrashCustody, method: MoveMethod, copied: CopyResult,
    sourceRemovalConfirmed: bool, failedRecordCleanup: bool): NativeTrashCustody = {
  val result = moveReceipt(method, copied, sourceRemovalConfirmed)
  { ...s, writing: false, payload: result.destination,
    record: result.destination != EntryMissing or failedRecordCleanup,
    reply: if (result.answer == NativeWriteMoved) TrashMoved else TrashMoveFailed }
}
pure def canObserveInterruptedTrashMove(s: NativeTrashCustody): bool = s.writing and s.record
pure def observeInterruptedTrashMove(s: NativeTrashCustody, observedPayload: EntryPresence): NativeTrashCustody =
  { ...s, writing: false, payload: observedPayload, reply: TrashMoveFailed }
pure val reviewValues = Set(FilesAdmitted, FilesChanged, FilesInvalid)
pure val deletedAtValues = Set(0, 1, 2592000000)
pure def alwaysFilesTrashPayloadKeepsItsOrigin(s: NativeTrashCustody): bool =
  s.payload != EntryMissing implies s.record and s.used
pure def alwaysOriginPrecedesTheFilesTrashMove(s: NativeTrashCustody): bool =
  (s.record implies s.used) and (s.writing implies s.used and s.record and s.payload == EntryMissing)
pure def stepTrashMoveNeedsItsDurableOrigin(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  via == "completeFilesTrashMove" or via == "observeInterruptedTrashMove" implies
    before.writing and before.record and (after.payload != EntryMissing implies after.record)
pure def sometimesFilesFailedMoveStillHasRecoverableCopy(s: NativeTrashCustody): bool =
  s.reply == TrashMoveFailed and s.payload == EntryComplete and s.record
```

## Story: Restore or erase the exact Files Trash entry

### Restore uses the recorded origin and confirms only a completed move

Restore needs both a regular metadata file and retained data for
the explicit ID. The model's read evidence also covers the 64 KiB
metadata read limit and parse failure. Restore resolves the recorded
origin in the same volume, falling back to its root if the origin
is an invalid path. It can recreate a missing origin directory.
The target takes the first free name. A failed move leaves the
record. If a complete fallback destination exists after that failure,
the reply is still `failed`. The original trash payload can be partly
removed after that copy. A successful move returns `restored`
with the destination path, even if removing the now-orphaned record
fails.

```quint
type TrashEntryFacts = { idValid: bool, safeEntries: bool, readableRecord: bool }
pure val readableEntry: TrashEntryFacts = { idValid: true, safeEntries: true, readableRecord: true }
pure val entryValues = Set(readableEntry, { ...readableEntry, safeEntries: false },
  { ...readableEntry, idValid: false }, { ...readableEntry, readableRecord: false })
pure def canRestoreNativeTrash(s: NativeTrashCustody, entry: TrashEntryFacts, destinationAvailable: bool,
    method: MoveMethod): bool =
  not(s.writing) and s.record and s.payload != EntryMissing and entry.idValid and
    entry.safeEntries and entry.readableRecord and destinationAvailable and method != CopyOnly
pure def restoreNativeTrash(s: NativeTrashCustody, entry: TrashEntryFacts, destinationAvailable: bool,
    method: MoveMethod, copied: CopyResult, sourceRemovalConfirmed: bool, failedRecordCleanup: bool,
    remainingPayload: EntryPresence): NativeTrashCustody = {
  val result = moveReceipt(method, copied, sourceRemovalConfirmed)
  if (result.answer == NativeWriteMoved)
    { ...s, payload: EntryMissing, record: failedRecordCleanup, restoredDestination: result.destination, reply: TrashRestored }
  else { ...s, reply: TrashRestoreFailed, restoredDestination: result.destination,
    payload: if (copied == CopyComplete) remainingPayload else s.payload }
}
pure def stepRestoredFilesTrashHasNoRemainingPayload(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  via == "restoreNativeTrash" and after.reply == TrashRestored implies
    before.record and before.payload != EntryMissing and after.payload == EntryMissing and
    after.restoredDestination == EntryComplete
pure def sometimesFilesRestoreFailedWithCompleteDestination(s: NativeTrashCustody): bool =
  s.reply == TrashRestoreFailed and s.record and s.restoredDestination == EntryComplete
pure def sometimesFilesRestoreLeavesOrphanedRecord(s: NativeTrashCustody): bool =
  s.reply == TrashRestored and s.record and s.payload == EntryMissing
```

### Listing and explicit deletion distinguish payload erasure from record cleanup

Listing opens an existing safe Trash namespace without creating
one. It scans legal IDs with nonlinked record and data paths and
orders published rows newest first. A missing payload causes an
attempt to remove its orphaned record, and that row is omitted
regardless of the cleanup outcome. An unreadable or invalid record
is omitted without erasing its data. A readable entry with payload
is listed until the 30-day wall-clock retention deadline. At or
beyond the deadline listing first attempts payload removal, then
record removal. On ordinary refusal of either removal it may
publish the captured row for that scan, even if its payload was
erased before record cleanup failed. A subsequent scan observes
missing payload and omits that row. A thrown exception within that
row's listing work suppresses the captured row while preserving any
observed partial cleanup.

Manual permanent erasure requires the renderer's explicit confirmation
and 1–500 unique listed IDs for the selected volume. Only those
names are passed to deletion, so later items are excluded. The raw
native bridge accepts a confirmed named ID without consulting
list history. It skips unsafe or malformed entries. It first deletes
the payload within the volume, then the record. An already absent
entry can satisfy the filesystem removal result. The count is the
number of IDs for which both path operations report success, rather
than a byte-erasure count. Native directory cleanup uses no-follow
traversal where supported and rechecks the parent paths on other
providers. A link nested inside the selected tree may be unlinked
without opening its target. Failure in recursive removal may leave a
partially cleaned tree.

```quint
pure val nativeFilesRetention = 2592000000
type TrashCleanup = { payloadRemoved: bool, recordRemoved: bool, threw: bool, observedPayload: EntryPresence }
pure val cleanedEntry: TrashCleanup = { payloadRemoved: true, recordRemoved: true, threw: false, observedPayload: EntryMissing }
pure val cleanupValues = Set(cleanedEntry, { ...cleanedEntry, recordRemoved: false },
  { ...cleanedEntry, payloadRemoved: false, recordRemoved: false, observedPayload: EntryIncomplete },
  { ...cleanedEntry, payloadRemoved: false, recordRemoved: false, observedPayload: EntryComplete },
  { ...cleanedEntry, recordRemoved: false, threw: true })
pure def remainingTrashData(cleanup: TrashCleanup): EntryPresence =
  if (cleanup.payloadRemoved) EntryMissing else cleanup.observedPayload
pure def canListNativeTrash(s: NativeTrashCustody, entry: TrashEntryFacts, at: int, cleanup: TrashCleanup): bool =
  not(s.writing) and s.record
pure def listNativeTrash(s: NativeTrashCustody, entry: TrashEntryFacts, at: int, cleanup: TrashCleanup): NativeTrashCustody =
  if (not(entry.idValid and entry.safeEntries and entry.readableRecord)) { ...s, reply: TrashHidden }
  else if (s.payload == EntryMissing) { ...s, record: not(cleanup.recordRemoved), reply: TrashHidden }
  else if (at < s.deletedAt + nativeFilesRetention) { ...s, reply: TrashShown }
  else { ...s, record: not(cleanup.payloadRemoved and cleanup.recordRemoved), payload: remainingTrashData(cleanup),
    reply: if (cleanup.threw or (cleanup.payloadRemoved and cleanup.recordRemoved)) TrashHidden else TrashShown }
type ExplicitErase = { confirmed: bool, uniqueIds: bool, idCount: int, requestedId: bool, exactVolume: bool,
  safeNamespace: bool, idValid: bool, safeEntries: bool }
pure def matchesNativeErase(request: ExplicitErase): bool = request.confirmed and request.uniqueIds and
  request.idCount >= 1 and request.idCount <= 500 and request.requestedId and request.exactVolume and
    request.safeNamespace and request.idValid and request.safeEntries
pure val selectedErase: ExplicitErase = { confirmed: true, uniqueIds: true, idCount: 1, requestedId: true,
  exactVolume: true, safeNamespace: true, idValid: true, safeEntries: true }
pure val requestValues = Set(selectedErase, { ...selectedErase, confirmed: false },
  { ...selectedErase, requestedId: false }, { ...selectedErase, exactVolume: false },
  { ...selectedErase, idCount: 0 }, { ...selectedErase, safeEntries: false })
pure def lawFilesEraseRequiresThisReviewedVolumeAndId(request: ExplicitErase): bool =
  matchesNativeErase(request) implies request.confirmed and request.requestedId and request.exactVolume
pure def canEraseNativeTrash(s: NativeTrashCustody, request: ExplicitErase, cleanup: TrashCleanup): bool =
  not(s.writing) and matchesNativeErase(request) and (s.record or s.payload == EntryMissing)
pure def eraseNativeTrash(s: NativeTrashCustody, request: ExplicitErase, cleanup: TrashCleanup): NativeTrashCustody = {
  val counted = cleanup.payloadRemoved and cleanup.recordRemoved and not(cleanup.threw)
  { ...s, payload: if (s.payload == EntryMissing) EntryMissing else remainingTrashData(cleanup),
    record: s.record and not(cleanup.payloadRemoved and cleanup.recordRemoved),
    reply: if (counted) TrashErased else TrashEraseFailed, removedCount: s.removedCount + (if (counted) 1 else 0) }
}
pure val atValues = Set(0, 2592000000, 2592000001, 5184000000)
pure val weight_commitFilesTrashRecord = 6
pure val weight_completeFilesTrashMove = 12
pure val weight_observeInterruptedTrashMove = 4
pure val weight_restoreNativeTrash = 12
pure val weight_listNativeTrash = 15
pure val weight_eraseNativeTrash = 7
pure def stepFilesTrashErasureCountsOnlyAfterBothRemovals(before: NativeTrashCustody, via: str, after: NativeTrashCustody): bool =
  after.removedCount > before.removedCount implies via == "eraseNativeTrash" and
    after.removedCount == before.removedCount + 1 and not(after.record) and after.payload == EntryMissing
pure def sometimesFilesRetentionListKeepsFailedMetadataCleanup(s: NativeTrashCustody): bool =
  s.reply == TrashShown and s.record and s.payload == EntryMissing
pure def sometimesFilesTrashCanExpireSuccessfully(s: NativeTrashCustody): bool =
  s.reply == TrashHidden and s.used and not(s.record) and s.payload == EntryMissing
pure def sometimesFilesTrashErasureIsCounted(s: NativeTrashCustody): bool = s.removedCount > 0 and s.reply == TrashErased
```
