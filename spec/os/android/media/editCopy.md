# Photo and video edit copies

The media plugin saves an edited photo or video as a new copy and never
changes the original. One copy journal serves both kinds: a save reserves
an edit identity under the editor's session token, inserts one owned
pending MediaStore row, publishes it, and recovers by an exact lookup of
the app's own row (owner package and the display name derived from the
token). Sources: `OwnedPhotoEdits.java` (`save`, `result`) and
`VideoCopyEdits.java` (`saveVideoEdit`, `reconcile`) in
`plugins/plugin-native-media/android`, and `PhotoCopyRecovery.qnt`. Bitmap
and encoder work, file digests and provider calls stay in the shell; this
machine follows one save token and decides what each provider result means.
Replacing the original in place is [photoReplace](./photoReplace.md); the
row write vocabulary is [rows](./rows.md).

## Story: Save an edited copy exactly once

> As the person, I want Save to make exactly one copy of the edit I
> reviewed, so that an interrupted save never leaves two copies or a
> hidden pending one.

### Only the active editor's unchanged source and a new changed edit reserve a copy

The editor holds one active session token per source. Before a save the
shell rechecks that the session is active and not cancelled, and that the
source revision and SHA-256 are the ones the editor opened. An edit is a
positive binding id (rotation, crop and filter of a photo; normalized
interval, rotation, crop and output size of a video); `0` is the identity
edit, answered `unchanged` with nothing reserved. A token that already has
a receipt is never reserved again: the same kind and edit read the existing
result through recovery, a different edit is refused. The shell sends the
reservation only after the `incomplete` receipt is committed, and the
reserved kind and edit never change afterwards.

```quint
import rows.* from "./rows"
type CopyKind = StillPhoto | Video
type Receipt = NoReceipt | Reserved | SavedReceipt({ id: int }) | FailedReceipt
type CopyRow = NoRow | PendingRow({ id: int }) | PublishedRow({ id: int })
type CopyReply = NoReply | NotStartedReply | SavedReply | FailedReply | UnconfirmedReply
type CopyJournal = { kind: CopyKind, edit: int, receipt: Receipt, row: CopyRow, recordedId: int,
  live: bool, insertions: int, reply: CopyReply }
pure val initial: CopyJournal = { kind: StillPhoto, edit: 0, receipt: NoReceipt, row: NoRow, recordedId: 0,
  live: false, insertions: 0, reply: NoReply }
pure def rowId(row: CopyRow): int = match row { | PendingRow(r) => r.id | PublishedRow(r) => r.id | NoRow => 0 }
pure def isPending(row: CopyRow): bool = match row { | PendingRow(_) => true | _ => false }
pure def isPublished(row: CopyRow): bool = match row { | PublishedRow(_) => true | _ => false }
pure def isSaved(receipt: Receipt): bool = match receipt { | SavedReceipt(_) => true | _ => false }

type EditRequest = { kind: CopyKind, edit: int, editorActive: bool, sourceExact: bool }
type CopyAdmission = RejectCopy | ReadExistingCopy | UnchangedCopy | ReserveCopy
pure def copyAdmission(s: CopyJournal, request: EditRequest): CopyAdmission =
  if (not(request.editorActive and request.sourceExact) or request.edit < 0) RejectCopy
  else if (s.receipt != NoReceipt) { if (request.kind == s.kind and request.edit == s.edit) ReadExistingCopy else RejectCopy }
  else if (request.edit == 0) UnchangedCopy else ReserveCopy
pure def canReserveCopy(s: CopyJournal, request: EditRequest): bool = copyAdmission(s, request) == ReserveCopy
pure def reserveCopy(s: CopyJournal, request: EditRequest): CopyJournal =
  { ...s, kind: request.kind, edit: request.edit, receipt: Reserved, live: true, reply: NoReply }
pure val goodRequest: EditRequest = { kind: StillPhoto, edit: 1, editorActive: true, sourceExact: true }
pure val requestValues = Set(goodRequest, { ...goodRequest, kind: Video, edit: 2 }, { ...goodRequest, edit: 0 },
  { ...goodRequest, sourceExact: false }, { ...goodRequest, editorActive: false })
pure def alwaysUnreservedTokenHasNoCopy(s: CopyJournal): bool =
  s.receipt == NoReceipt implies (s.row == NoRow and s.insertions == 0 and s.recordedId == 0 and not(s.live))
pure def alwaysReservationNamesAChangedEdit(s: CopyJournal): bool = s.receipt != NoReceipt implies s.edit > 0
pure def stepReservedIdentityNeverChanges(before: CopyJournal, after: CopyJournal): bool =
  before.receipt != NoReceipt implies (after.kind == before.kind and after.edit == before.edit)
```

### An active writer holds its reservation and has not replied

Only the writer started by the reservation inserts, and it inserts one
pending row at most once. A video writer persists the row's exact id
before copying any output bytes; if that record fails the writer stops.

```quint
pure def canInsertCopy(s: CopyJournal, mediaId: int, idRecorded: bool): bool =
  s.live and s.row == NoRow and s.insertions == 0 and mediaId > 0
pure def insertCopy(s: CopyJournal, mediaId: int, idRecorded: bool): CopyJournal = {
  val keepsWriting = s.kind == StillPhoto or idRecorded
  { ...s, row: PendingRow({ id: mediaId }), insertions: 1, live: keepsWriting,
    recordedId: if (s.kind == Video and idRecorded) mediaId else 0,
    reply: if (keepsWriting) NoReply else UnconfirmedReply }
}
pure val mediaIdValues = Set(1, 2)
pure def alwaysLiveWriterHoldsItsReservation(s: CopyJournal): bool =
  s.live implies (s.receipt == Reserved and s.reply == NoReply)
pure def alwaysLiveVideoWriterRecordedItsRow(s: CopyJournal): bool =
  (s.live and s.kind == Video and s.row != NoRow) implies s.recordedId == rowId(s.row)
pure def alwaysAtMostOneInsertion(s: CopyJournal): bool =
  (s.insertions == 0 or s.insertions == 1) and ((s.row != NoRow or s.recordedId != 0) implies s.insertions == 1)
pure def stepOnlyTheLiveWriterInserts(before: CopyJournal, via: str, after: CopyJournal): bool =
  after.insertions != before.insertions implies (via == "insertCopy" and before.live)
```

### A copy reaches the library only after its bytes and source agree

Publication needs the encoded bytes flushed (a video's synced bytes read
back with the export's length and SHA-256), the source still at its opened
revision and digest, and the update that clears `is_pending` on the one
owned pending row counting exactly one row. A video also asserts the source
version in the same provider batch, publishes the recorded id only, and
reads back that the row is no longer pending. After publication the reply
is `saved` even if the saved receipt cannot commit; recovery then settles
it. A lost writer may delete its own row only while it is still pending
and no video id was recorded; any other row is left to recovery.

```quint
type PublishEvidence = { sourceExact: bool, bytesMatch: bool, update: RowWrite, readback: bool }
pure def publicationApplied(kind: CopyKind, evidence: PublishEvidence): bool =
  evidence.sourceExact and evidence.bytesMatch and evidence.update == RowWriteCounted({ rows: 1 }) and
    (kind == StillPhoto or evidence.readback)
pure def canPublishCopy(s: CopyJournal, evidence: PublishEvidence, receiptCommitted: bool): bool =
  s.live and isPending(s.row) and publicationApplied(s.kind, evidence) and
    (s.kind == StillPhoto or s.recordedId == rowId(s.row))
pure def publishCopy(s: CopyJournal, evidence: PublishEvidence, receiptCommitted: bool): CopyJournal =
  { ...s, row: PublishedRow({ id: rowId(s.row) }), live: false, reply: SavedReply,
    receipt: if (receiptCommitted) SavedReceipt({ id: rowId(s.row) }) else Reserved }
pure def canLoseWriter(s: CopyJournal, cleanup: RowWrite): bool = s.live
pure def loseWriter(s: CopyJournal, cleanup: RowWrite): CopyJournal =
  { ...s, live: false, reply: UnconfirmedReply,
    row: if (isPending(s.row) and s.recordedId == 0 and cleanup == RowWriteCounted({ rows: 1 })) NoRow else s.row }
pure val goodEvidence: PublishEvidence = { sourceExact: true, bytesMatch: true, update: RowWriteCounted({ rows: 1 }), readback: true }
pure val evidenceValues = Set(goodEvidence, { ...goodEvidence, sourceExact: false }, { ...goodEvidence, bytesMatch: false },
  { ...goodEvidence, update: RowWriteCounted({ rows: 0 }) }, { ...goodEvidence, update: RowWriteFailed },
  { ...goodEvidence, readback: false })
pure val cleanupValues = Set(RowWriteCounted({ rows: 1 }), RowWriteCounted({ rows: 0 }), RowWriteFailed, RowNotWritten)
pure def alwaysSavedReplyHasAPublishedCopy(s: CopyJournal): bool = s.reply == SavedReply implies isPublished(s.row)
pure def alwaysSavedReceiptNamesThePublishedRow(s: CopyJournal): bool = {
  val receipt = s.receipt
  match receipt { | SavedReceipt(r) => r.id > 0 and s.row == PublishedRow({ id: r.id }) | _ => true }
}
pure def stepPublishedCopyStaysPublished(before: CopyJournal, after: CopyJournal): bool =
  isPublished(before.row) implies after.row == before.row
pure def sometimesPhotoCopySaved(s: CopyJournal): bool = s.kind == StillPhoto and isSaved(s.receipt)
pure def sometimesVideoCopySaved(s: CopyJournal): bool = s.kind == Video and isSaved(s.receipt)
pure def sometimesPublishedBeforeReceipt(s: CopyJournal): bool =
  isPublished(s.row) and s.receipt == Reserved and s.reply == SavedReply
```

## Story: Recover the same copy after an interruption

> As the person, I want a save I closed, or lost the answer to, to resolve
> to the same copy, so that I never end up with two copies or a hidden
> pending one.

### Recovery observes the unique owned row before it settles anything

With no receipt the answer is `not-started` without a lookup; a saved or
failed receipt is a historical answer. Otherwise the shell queries the
owned row, pending rows included. A lookup resolves only when it is
available and unique and, when a video id was recorded, finds that same
row; an unresolved lookup changes nothing and answers unconfirmed. A unique
published row settles saved with its id; a unique pending row is deleted
only by the guarded `is_pending=1` delete counting exactly one row; an
absent row settles failed. Each settlement takes effect only when its
receipt commits; recovery never inserts and never removes a published row.

```quint
type Observation = { available: bool, unique: bool }
type CopyLookup = LookupUnavailable | LookupAmbiguous | LookupAbsent | LookupPending | LookupPublished
pure def copyLookup(row: CopyRow, observed: Observation): CopyLookup =
  if (not(observed.available)) LookupUnavailable else if (not(observed.unique)) LookupAmbiguous
  else match row { | NoRow => LookupAbsent | PendingRow(_) => LookupPending | PublishedRow(_) => LookupPublished }
pure def lookupResolves(lookup: CopyLookup, recordedId: int): bool =
  lookup != LookupUnavailable and lookup != LookupAmbiguous and (recordedId == 0 or lookup != LookupAbsent)
pure def canRecoverCopy(s: CopyJournal, observed: Observation, deletion: RowWrite, receiptCommitted: bool): bool = not(s.live)
pure def recoverCopy(s: CopyJournal, observed: Observation, deletion: RowWrite, receiptCommitted: bool): CopyJournal = {
  val lookup = copyLookup(s.row, observed)
  val unconfirmed = { ...s, reply: UnconfirmedReply }
  val receipt = s.receipt
  match receipt {
    | NoReceipt => { ...s, reply: NotStartedReply }
    | SavedReceipt(_) => { ...s, reply: SavedReply }
    | FailedReceipt => { ...s, reply: FailedReply }
    | Reserved =>
      if (not(lookupResolves(lookup, s.recordedId))) unconfirmed
      else if (lookup == LookupPublished)
        (if (receiptCommitted) { ...s, receipt: SavedReceipt({ id: rowId(s.row) }), reply: SavedReply } else unconfirmed)
      else if (lookup == LookupPending)
        (if (deletion != RowWriteCounted({ rows: 1 })) unconfirmed
         else if (receiptCommitted) { ...s, row: NoRow, recordedId: 0, receipt: FailedReceipt, reply: FailedReply }
         else { ...s, row: NoRow, reply: UnconfirmedReply })
      else if (receiptCommitted) { ...s, recordedId: 0, receipt: FailedReceipt, reply: FailedReply }
      else unconfirmed
  }
}
pure val goodObservation: Observation = { available: true, unique: true }
pure val observedValues = Set(goodObservation, { ...goodObservation, available: false }, { ...goodObservation, unique: false })
pure val deletionValues = Set(RowWriteCounted({ rows: 1 }), RowWriteCounted({ rows: 0 }), RowWriteFailed)
pure def alwaysFailureLeavesNoRow(s: CopyJournal): bool =
  (s.receipt == FailedReceipt or s.reply == FailedReply) implies s.row == NoRow
pure def alwaysRecordedIdNamesTheVideoRow(s: CopyJournal): bool =
  s.recordedId >= 0 and (s.recordedId > 0 implies (s.kind == Video and (s.row == NoRow or rowId(s.row) == s.recordedId))) and
    (s.row != NoRow implies rowId(s.row) > 0)
pure def stepSettledReceiptIsFinal(before: CopyJournal, after: CopyJournal): bool =
  (isSaved(before.receipt) or before.receipt == FailedReceipt) implies after.receipt == before.receipt
pure def sometimesInterruptedCopySettlesFailed(s: CopyJournal): bool = s.receipt == FailedReceipt and s.insertions == 1
```

### A removed recorded video copy settles only by an explicit review

When recovery has confirmed deleting a video's pending row but the failed
receipt did not commit, the durable record still names the recorded id and
every later lookup finds no row, which recovery refuses as unresolved (the
state `VideoCopyEdits.java` reports as "needs recovery review"). The shell
offers a review: after the person checks Photos, a fresh available and
unique lookup that still finds no owned row settles the save failed and
clears the recorded id. Nothing else settles that state.

```quint
pure def awaitingReview(s: CopyJournal): bool =
  not(s.live) and s.receipt == Reserved and s.recordedId > 0 and s.row == NoRow
pure def canReviewRemovedCopy(s: CopyJournal, observed: Observation, receiptCommitted: bool): bool =
  awaitingReview(s) and copyLookup(s.row, observed) == LookupAbsent
pure def reviewRemovedCopy(s: CopyJournal, observed: Observation, receiptCommitted: bool): CopyJournal =
  if (receiptCommitted) { ...s, recordedId: 0, receipt: FailedReceipt, reply: FailedReply } else { ...s, reply: UnconfirmedReply }
pure def stepOnlyReviewSettlesARemovedRecordedCopy(before: CopyJournal, via: str, after: CopyJournal): bool =
  (awaitingReview(before) and after.receipt != Reserved) implies via == "reviewRemovedCopy"
pure def sometimesRemovedVideoAwaitsReview(s: CopyJournal): bool = s.kind == Video and awaitingReview(s)
```
