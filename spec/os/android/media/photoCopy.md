# Android edited still-photo copy and recovery

A consumer's Photos adapter reaches the shared Android `PhotosPlugin.java`,
which delegates still-photo Save copy and `editResult` to
`OwnedPhotoEdits.java` under `plugins/plugin-native-media/android`, when the
consumer's media descriptor grants photo writes. The descriptor supplies the
edit-results preferences name, the `Pictures/<consumer>/Edits/` path and the
`<consumer>-edit-<operation>.png` name.
[Photo permission epochs](./permissionEpochs.md) own read publication. This spec owns
the pending-row copy journal: reserve an operation, insert one owned pending
MediaStore row, publish it, and recover by an exact owner and display-name
lookup. [Video copy](./videoCopy.md) reuses it;
[in-place Replace](./photoReplace.md) has its own path.

## Story: Save one copy of the exact edit and recover it after interruption

> As the person, I want Save to make exactly one copy of the edit I
> reviewed, so that an interrupted save never leaves duplicates or loses
> the copy.

### Only the reviewed source and a reserved edit identity may publish a new copy

The native editor takes a source revision, captures the source SHA-256,
rejects animated inputs and uses a single active opaque session token.
Native work reads its source via the admitted photo identity and checks
its active session, not cancelled, unchanged revision and unchanged
byte digest before transform, before inserting the copy, and again
before publication. An unchanged transform returns `unchanged` with
no reserved operation. An admitted rotation, exact crop and filter
combination, whose crop is one of the editor's crop identities
([crop receipt](./photoReplace.md)), is
recorded on the session's token. A matching retry reads
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
sees an exception. The model follows one exact operation; full decoded
image bytes stay in the native port.

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
pure def alwaysCopyHasAtMostOneInsertion(s: PhotoCopy): bool = s.insertions >= 0 and s.insertions <= 1
pure def stepOnlyReservedWriterCanInsert(before: PhotoCopy, via: str, after: PhotoCopy): bool =
  after.insertions > before.insertions implies via == "insertPhotoCopy" and before.live and before.journal == IncompleteCopy
pure def stepPublicationKeepsBytes(before: PhotoCopy, via: str, after: PhotoCopy): bool =
  via == "publishPhotoCopy" implies before.bytesWritten and after.row == PublishedCopyRow
pure def sometimesPublishedBeforeReceipt(s: PhotoCopy): bool = s.row == PublishedCopyRow and s.journal == IncompleteCopy and s.reply == CopySaved
```

### An active writer holds its reservation and has not replied

While a writer is live, the journal holds its incomplete reservation and
no reply has been sent, so a failed copy never appears to start an insert.

```quint
pure def alwaysOpenWriterHasReservation(s: PhotoCopy): bool = s.live implies s.journal == IncompleteCopy and s.reply == NoCopyReply
```

### Recovery observes the unique owned row before reporting a result or confirming cleanup

Without a receipt the native query returns `not-started` without a
provider lookup. A saved receipt with an ID is a historical answer.
Otherwise it queries including pending rows, filtering by exact app
owner package and operation-derived display name. A lookup resolves only
when it is available and unique and, when the writer recorded a pending ID,
it found that same ID; an unresolved lookup rejects with outcome
unconfirmed and performs no mutation. The recovery query uses the provider-reported numeric
identity. A unique published row confirms the copy if the saved receipt
commit succeeds. A unique pending row from an incomplete operation can
be deleted by exact ID only while `is_pending=1`, with an exact one-row
result. Confirm cleanup and commit failure before reporting `failed`.
An absent row can settle failed after the same receipt commit. A saved
receipt lacking an ID remains a historical save if a lookup finds
only pending or absent data. It never deletes pending data.

The model uses a port result for exact lookup, a conditional delete count
and the receipt commit. Only the non-recovery write path can insert.

```quint
type CopyLookup = LookupAbsent | LookupPending | LookupPublished | LookupUnavailable | LookupAmbiguous
type RecoveryPlan = ReadOnlyNotStarted | ReadHistoricalSave | SettleExistingSave | CheckPendingCleanup | SettleMissingCopy | AwaitCopyEvidence
pure def lookupResolves(lookup: CopyLookup, recordedId: int, matchedId: int): bool =
  lookup != LookupUnavailable and lookup != LookupAmbiguous and
    (recordedId == 0 or (lookup != LookupAbsent and matchedId == recordedId))
pure def lawRecordedPendingIdMustBeFound(lookup: CopyLookup, recordedId: int, matchedId: int): bool =
  recordedId > 0 and (lookup == LookupAbsent or matchedId != recordedId) implies not(lookupResolves(lookup, recordedId, matchedId))
pure val recordedIdValues = Set(0, 1)
pure val matchedIdValues = Set(1, 2)
pure def recoveryPlan(journal: CopyJournal, historicalId: bool, lookup: CopyLookup): RecoveryPlan =
  if (journal == NoCopyReceipt) ReadOnlyNotStarted
  else if (journal == SavedCopyReceipt and historicalId) ReadHistoricalSave
  else if (not(lookupResolves(lookup, 0, 0))) AwaitCopyEvidence
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
