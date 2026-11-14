# Android edited still-photo copy and recovery

AlphaPhone `8d44dfe5` reaches `AlphaPhotosPlugin.java` from its Photos
adapter in `apps/app/src/prototype/camera-adapter.ts`. The shared Android
`PhotosPlugin.java` delegates still-photo Save copy and `editResult` to
`OwnedPhotoEdits.java` under `plugins/plugin-native-media/android` at
Eliza `c518127a`. `AlphaMediaConfig.java` supplies installed preferences
`alpha-photo-edit-results`, path `Pictures/Alpha Phone/Edits/` and name
`Alpha-edit-<operation>.png`. Grace `48b43b9c` reaches the read-only
`PermittedPhotosPlugin` surface in this area and does not expose these
edits. [Photo permission epochs](./mobilePhotos.md) own read publication.
Video copying and in-place Replace have separate mutation paths. This
spec owns still-photo Save copy and native result reconciliation.

## Story: Save one copy of the exact edit and recover it after interruption

### Only the reviewed source and a reserved edit identity may publish a new copy

The native editor takes a source revision, captures the source SHA-256,
rejects animated inputs and uses a single active opaque session token.
Native work reads its source via the admitted photo identity and checks
its active session, not cancelled, unchanged revision and unchanged
byte digest before transform, before inserting the copy, and again
before publication. An unchanged transform returns `unchanged` with
no reserved operation. An admitted rotation, exact crop and filter
combination is recorded on the session's token. A matching retry reads
the existing operation. Different parameters or a Replace receipt under
the same token are refused. Recovery may still query the exact token
after the native edit session is gone.

The `incomplete` reservation must commit before MediaStore insert.
The destination is a PNG in the installed Edits folder with a
parent-owned name derived from the operation. The provider places it
in `is_pending=1`, receives and flushes the encoded bytes, and publishes
only after the final source-owner check. The publication update must
affect exactly one row. A `saved` reply names the token and MediaStore
ID. After provider publication, the direct save attempts to commit
that receipt but can return `saved` if only this final preference
commit fails. In that case a later result query reconciles the
published copy. Failed direct writes may attempt best-effort cleanup
of an observed pending row and reject. They do not assert a terminal
`failed` receipt. A provider outcome can be unknown when the caller
sees an exception. The model separates those port outcomes and follows
one exact operation. Full decoded image bytes stay in the native port.

```quint
type CopyAdmission = RejectCopy | ReadExistingCopy | NoChangeCopy | ReserveCopy
type RequestFacts = { activeEditor: bool, tokenExact: bool, sourceExact: bool, validTransform: bool,
   existingReceipt: bool, existingIsReplace: bool, editMatches: bool, changed: bool }
pure def copyAdmission(request: RequestFacts): CopyAdmission =
  if (not(request.activeEditor and request.tokenExact and request.sourceExact and request.validTransform)) RejectCopy
  else if (request.existingReceipt) {
    if (request.existingIsReplace or not(request.editMatches)) RejectCopy else ReadExistingCopy
  } else if (request.changed) ReserveCopy else NoChangeCopy
pure val requestValues = Set({ activeEditor: true, tokenExact: true, sourceExact: true, validTransform: true,
    existingReceipt: false, existingIsReplace: false, editMatches: true, changed: true },
  { activeEditor: true, tokenExact: true, sourceExact: true, validTransform: true,
    existingReceipt: true, existingIsReplace: false, editMatches: false, changed: true })
pure def lawExistingOperationNeverReservesAgain(request: RequestFacts): bool = request.existingReceipt implies copyAdmission(request) != ReserveCopy
pure def lawChangedSourceCannotReserve(request: RequestFacts): bool = not(request.sourceExact) implies copyAdmission(request) == RejectCopy

type CopyRow = NoCopyRow | PendingCopyRow | PublishedCopyRow
type CopyJournal = NoCopyReceipt | IncompleteCopy | SavedCopyReceipt | FailedCopyReceipt
type CopyReply = NoCopyReply | CopyNotStarted | CopySaved | CopyFailed | CopyUnconfirmed
type PhotoCopy = { journal: CopyJournal, row: CopyRow, live: bool, bytesWritten: bool, insertions: int, reply: CopyReply }
pure val initial: PhotoCopy = { journal: NoCopyReceipt, row: NoCopyRow, live: false, bytesWritten: false, insertions: 0, reply: NoCopyReply }
pure def canReservePhotoCopy(s: PhotoCopy, reviewed: bool, reserveCommitted: bool): bool =
  s.journal == NoCopyReceipt and reviewed and reserveCommitted
pure def reservePhotoCopy(s: PhotoCopy, reviewed: bool, reserveCommitted: bool): PhotoCopy =
  { ...s, journal: IncompleteCopy, live: true, reply: NoCopyReply }
pure def canInsertPhotoCopy(s: PhotoCopy, sourceExact: bool): bool =
  s.journal == IncompleteCopy and s.live and s.row == NoCopyRow and s.insertions == 0 and sourceExact
pure def insertPhotoCopy(s: PhotoCopy, sourceExact: bool): PhotoCopy =
  { ...s, row: PendingCopyRow, insertions: 1 }
pure def canWritePhotoCopy(s: PhotoCopy, flushed: bool): bool =
  s.live and s.row == PendingCopyRow and not(s.bytesWritten) and flushed
pure def writePhotoCopy(s: PhotoCopy, flushed: bool): PhotoCopy = { ...s, bytesWritten: true }
pure def canPublishPhotoCopy(s: PhotoCopy, sourceExact: bool, countApplied: int): bool =
  s.journal == IncompleteCopy and s.live and s.row == PendingCopyRow and s.bytesWritten and sourceExact and countApplied == 1
pure def publishPhotoCopy(s: PhotoCopy, sourceExact: bool, countApplied: int, receiptCommitted: bool): PhotoCopy =
  { ...s, live: false, row: PublishedCopyRow, journal: if (receiptCommitted) SavedCopyReceipt else IncompleteCopy, reply: CopySaved }
pure def canLoseCopyWriter(s: PhotoCopy): bool = s.live
pure def loseCopyWriter(s: PhotoCopy, pendingCleanupConfirmed: bool): PhotoCopy =
  { ...s, live: false, row: if (s.row == PendingCopyRow and pendingCleanupConfirmed) NoCopyRow else s.row, reply: CopyUnconfirmed }
pure val countAppliedValues = Set(0, 1, 2)
pure val weight_reservePhotoCopy = 8
pure val weight_insertPhotoCopy = 10
pure val weight_writePhotoCopy = 12
pure val weight_publishPhotoCopy = 12
pure def alwaysCopyHasAtMostOneInsertion(s: PhotoCopy): bool = s.insertions >= 0 and s.insertions <= 1
pure def alwaysOpenWriterHasReservation(s: PhotoCopy): bool = s.live implies s.journal == IncompleteCopy and s.reply == NoCopyReply
pure def stepOnlyReservedWriterCanInsert(before: PhotoCopy, via: str, after: PhotoCopy): bool =
  after.insertions > before.insertions implies via == "insertPhotoCopy" and before.live and before.journal == IncompleteCopy
pure def stepPublicationKeepsBytes(before: PhotoCopy, via: str, after: PhotoCopy): bool =
  via == "publishPhotoCopy" implies before.bytesWritten and after.row == PublishedCopyRow
pure def sometimesPublishedBeforeReceipt(s: PhotoCopy): bool = s.row == PublishedCopyRow and s.journal == IncompleteCopy and s.reply == CopySaved
```

### Recovery observes the unique owned row before reporting a result or confirming cleanup

Without a receipt the native query returns `not-started` without a
provider lookup. A saved receipt with an ID is a historical answer.
Otherwise it queries including pending rows, filtering by exact app
owner package and operation-derived display name. A null cursor or
multiple matching rows rejects with outcome unconfirmed and performs
no mutation. The recovery query uses the provider-reported numeric
identity. A unique published row confirms the copy if the saved receipt
commit succeeds. A unique pending row from an incomplete operation can
be deleted by exact ID only while `is_pending=1`, with an exact one-row
result. Confirm cleanup and commit failure before reporting `failed`.
An absent row can settle failed after the same receipt commit. A saved
receipt lacking an ID remains a historical save if a lookup finds
only pending or absent data. It never deletes pending data.

Both installed `incomplete` and historical `writing` statuses follow the
same recovery branch. The producer's portable `PhotoCopyRecovery.qnt`
and `photo-copy-recovery.node.mjs` exercise this branch. The model uses
a port result for exact lookup, a conditional delete count, and the
receipt commit. Only the non-recovery write path can insert. The
renderer separately retires only an exact terminal intent and fences
view publication after its source or editor changes.

```quint
type CopyLookup = LookupAbsent | LookupPending | LookupPublished | LookupUnavailable | LookupAmbiguous
type RecoveryPlan = ReadOnlyNotStarted | ReadHistoricalSave | SettleExistingSave | CheckPendingCleanup | SettleMissingCopy | AwaitCopyEvidence
pure def recoveryPlan(journal: CopyJournal, historicalId: bool, lookup: CopyLookup): RecoveryPlan =
  if (journal == NoCopyReceipt) ReadOnlyNotStarted
  else if (journal == SavedCopyReceipt and historicalId) ReadHistoricalSave
  else if (lookup == LookupUnavailable or lookup == LookupAmbiguous) AwaitCopyEvidence
  else if (lookup == LookupPublished) SettleExistingSave
  else if (journal == SavedCopyReceipt) ReadHistoricalSave
  else if (lookup == LookupPending) CheckPendingCleanup else SettleMissingCopy
pure def copyLookup(row: CopyRow, available: bool, unique: bool): CopyLookup =
  if (not(available)) LookupUnavailable else if (not(unique)) LookupAmbiguous
  else if (row == PendingCopyRow) LookupPending else if (row == PublishedCopyRow) LookupPublished else LookupAbsent
pure def canRecoverPhotoCopy(s: PhotoCopy): bool = not(s.live)
pure def recoverPhotoCopy(s: PhotoCopy, available: bool, unique: bool, cleanupCount: int, receiptCommitted: bool): PhotoCopy = {
  val plan = recoveryPlan(s.journal, s.journal == SavedCopyReceipt, copyLookup(s.row, available, unique))
  if (plan == ReadOnlyNotStarted) { ...s, reply: CopyNotStarted }
  else if (plan == ReadHistoricalSave) { ...s, reply: CopySaved }
  else if (plan == SettleExistingSave and receiptCommitted) { ...s, journal: SavedCopyReceipt, reply: CopySaved }
  else if (plan == SettleMissingCopy and receiptCommitted) { ...s, journal: FailedCopyReceipt, reply: CopyFailed }
  else if (plan == CheckPendingCleanup and cleanupCount == 1)
    { ...s, row: NoCopyRow, journal: if (receiptCommitted) FailedCopyReceipt else s.journal,
      reply: if (receiptCommitted) CopyFailed else CopyUnconfirmed }
  else { ...s, reply: CopyUnconfirmed }
}
pure val cleanupCountValues = Set(0, 1, 2)
pure val weight_recoverPhotoCopy = 10
pure def alwaysFailedCopyHasNoPendingRow(s: PhotoCopy): bool = s.reply == CopyFailed implies s.row == NoCopyRow
pure def stepRecoveryNeverInserts(before: PhotoCopy, via: str, after: PhotoCopy): bool =
  via == "recoverPhotoCopy" implies before.insertions == after.insertions
pure def stepPublishedCopyIsNeverCleaned(before: PhotoCopy, after: PhotoCopy): bool =
  before.row == PublishedCopyRow implies after.row == PublishedCopyRow
pure def lawHistoricalSaveNeverDeletesPending(lookup: CopyLookup, historicalId: bool): bool =
  recoveryPlan(SavedCopyReceipt, historicalId, lookup) != CheckPendingCleanup
pure def lawAmbiguousLookupCannotMutate(journal: CopyJournal, historicalId: bool): bool =
  journal != NoCopyReceipt and (journal != SavedCopyReceipt or not(historicalId)) implies
    recoveryPlan(journal, historicalId, LookupAmbiguous) == AwaitCopyEvidence
pure def sometimesRecoversFailedCopy(s: PhotoCopy): bool = s.journal == FailedCopyReceipt and s.insertions == 1
```
