# Alpha previous Notes Trash and recording custody

Alpha's pinned `notes-trash-adapter.ts`, `notes-trash-policy.ts`, and
`note-audio-deletions.ts` consume Eliza's device-local Notes Trash and
recording clients. These are the Previous Notes and device-review paths.
The primary agent-hosted Notes UI uses a separate restore-only flow
described below, together with the [canonical Notes client](./notes.md). The installed
Trash identifiers are `notes-trash:v1:device` on Android and
`alpha.browser.notes-trash.v1` on web. The recording recovery journal
uses the corresponding `notes-audio-deletions:v1:device` and
`alpha.browser.notes-audio-deletions.v1` identifiers.
The [browser document contract](./documentStore.md) owns durable browser
receipts. These models use Eliza pin `c518127a025ab173874af9c7d304f26b25213b0d`.

## Story: Restore my deleted note or remove its restorable copy

### Save a restorable copy before removing the exact live note

The version-1 Trash document holds at most one entry per deletion ID
and per note ID. An entry includes the full note, original index and
deletion time. A target, when present, binds the same note ID, stored
revision and collection source. Only a voice note can carry matching
recording metadata. The admitted note kinds are text, list, voice and link.
Capacity is 10,000 rows and 30 MiB of encoded JSON at addition. Existing
documents remain readable and shrinkable after either limit decreases.
Nothing changes if a definite capacity refusal prevents adding the entry.
Only that refusal opens the separate permanent-deletion confirmation,
which must still match the stored note and a fresh authoritative read.

Under the deletion lock, a move checks that the stored note and the
authoritative note both equal the reviewed note. A preexisting row for
the same note can be replaced only when it matches the just-read rows.
The store writes the restorable copy with an exact compare and exchange
and confirms readback. A second check of displayed, stored and saved
copies fences a later edit before the note is removed. A lost removal
receipt leaves the restorable copy. If the note is still saved, later
maintenance only drops the stale prewrite. Restore uses the operation ID
and reinserts the exact saved note near its former index. An old folder
that no longer exists becomes no folder. An unreadable folder list
preserves the old reference. A fresh same-ID saved note wins and only
the stale row is removed. A voice note with stored audio uses the
recording flow below.

The reducer follows one note and one latest Trash operation. Its
version integers stand for exact stored note bytes and target revisions.
A removal step supplies authoritative note presence, even where the
initial write had an unknown outcome. After a restore, a failed Trash
cleanup can leave a stale row for maintenance.
A single-erase review selects one operation ID. Pinned Delete All
confirms the whole Trash and applies to the authoritative rows read
under the lock when it runs. It can include rows added after the
confirmation was opened. Host codecs and locking refine those atomic
steps.

```quint
type TrashState = { live: bool, noteRevision: int, row: int, rowRevision: int, deletedAt: int, clock: int, fullRefusal: int, serial: int }
pure val initial: TrashState = { live: true, noteRevision: 1, row: 0, rowRevision: 0, deletedAt: 0, clock: 1, fullRefusal: 0, serial: 0 }
pure def expiredNote(deletedAt: int, now: int): bool = deletedAt > 0 and now - deletedAt >= 2592000000
pure def withinTrashCapacity(rows: int, encodedBytes: int): bool =
  rows >= 0 and rows <= 10000 and encodedBytes >= 0 and encodedBytes <= 31457280
pure def canMoveNote(s: TrashState, checkedRevision: int): bool =
  s.live and s.noteRevision == checkedRevision
pure def moveNote(s: TrashState, checkedRevision: int, hasCapacity: bool): TrashState =
  if (hasCapacity) { ...s, serial: s.serial + 1, row: s.serial + 1, rowRevision: s.noteRevision, deletedAt: s.clock, fullRefusal: 0 }
  else { ...s, fullRefusal: s.noteRevision }
pure def canCommitDeletion(s: TrashState, deletionId: int): bool =
  s.live and s.row > 0 and deletionId == s.row and s.noteRevision == s.rowRevision
pure def commitDeletion(s: TrashState, deletionId: int, savedStillLive: bool): TrashState =
  { ...s, live: savedStillLive, fullRefusal: if (savedStillLive) s.fullRefusal else 0 }
pure def canEditSaved(s: TrashState): bool = s.live
pure def editSaved(s: TrashState): TrashState = { ...s, noteRevision: s.noteRevision + 1, fullRefusal: 0 }
pure def canRestoreNote(s: TrashState, deletionId: int): bool =
  not(s.live) and s.row > 0 and s.row == deletionId and not(expiredNote(s.deletedAt, s.clock))
pure def restoreNote(s: TrashState, deletionId: int, cleanupConfirmed: bool): TrashState =
  { ...s, live: true, noteRevision: s.noteRevision + 1, row: if (cleanupConfirmed) 0 else s.row,
    rowRevision: if (cleanupConfirmed) 0 else s.rowRevision, deletedAt: if (cleanupConfirmed) 0 else s.deletedAt, fullRefusal: 0 }
pure def canDropStaleRow(s: TrashState): bool = s.live and s.row > 0
pure def dropStaleRow(s: TrashState): TrashState = { ...s, row: 0, rowRevision: 0, deletedAt: 0 }
pure def canExpireRow(s: TrashState): bool = not(s.live) and s.row > 0 and expiredNote(s.deletedAt, s.clock)
pure def expireRow(s: TrashState, erasedContent: bool): TrashState =
  if (erasedContent) dropStaleRow(s) else s
pure def canEraseRow(s: TrashState, deletionId: int, allRows: bool): bool =
  s.row > 0 and (allRows or s.row == deletionId)
pure def eraseRow(s: TrashState, deletionId: int, allRows: bool, erasedContent: bool): TrashState =
  if (erasedContent) dropStaleRow(s) else s
pure def canDeleteWithoutCopy(s: TrashState, checkedRevision: int, confirmed: bool): bool =
  s.live and confirmed and s.fullRefusal == s.noteRevision and s.noteRevision == checkedRevision
pure def deleteWithoutCopy(s: TrashState, checkedRevision: int, confirmed: bool, savedStillLive: bool): TrashState =
  { ...dropStaleRow(s), live: savedStillLive, fullRefusal: 0 }
pure def canMoveClock(s: TrashState, now: int): bool = now > 0 and now != s.clock
pure def moveClock(s: TrashState, now: int): TrashState = { ...s, clock: now }
pure def alwaysTrashReceiptShape(s: TrashState): bool =
  s.row >= 0 and s.row <= s.serial and s.noteRevision > 0 and (s.row > 0 implies s.rowRevision > 0 and s.deletedAt > 0)
pure def alwaysClockAndSerial(s: TrashState): bool = s.clock > 0 and s.serial >= 0
pure def alwaysRefusalBindsLiveRevision(s: TrashState): bool =
  s.fullRefusal == 0 or (s.live and s.fullRefusal == s.noteRevision)
pure def stepLiveRemovalRequiresDurableCopyOrNewReview(before: TrashState, via: str, after: TrashState): bool =
  before.live and not(after.live) implies
    (via == "commitDeletion" and before.row > 0 and before.rowRevision == before.noteRevision) or
    (via == "deleteWithoutCopy" and before.fullRefusal == before.noteRevision)
pure def stepStaleCleanupPreservesLiveNote(before: TrashState, via: str, after: TrashState): bool =
  via == "dropStaleRow" implies before.live and after.live and before.noteRevision == after.noteRevision
pure def lawClockRewindCannotExpire(deletedAt: int, now: int): bool =
  now < deletedAt implies not(expiredNote(deletedAt, now))
pure def lawWrongEraseIdCannotRemove(s: TrashState, deletionId: int): bool =
  deletionId != s.row implies not(canEraseRow(s, deletionId, false))
pure def lawWrongRevisionCannotDeleteWithoutCopy(s: TrashState, checkedRevision: int, confirmed: bool): bool =
  checkedRevision != s.noteRevision implies not(canDeleteWithoutCopy(s, checkedRevision, confirmed))
pure def sometimesTrashRetainsCopy(s: TrashState): bool = not(s.live) and s.row > 0
pure def sometimesFullRefusesWithoutDelete(s: TrashState): bool = s.live and s.fullRefusal > 0
pure def sometimesExpiredCopy(s: TrashState): bool = canExpireRow(s)
pure val checkedRevisionValues = Set(1, 2, 3, 4)
pure val deletionIdValues = Set(1, 2, 3, 4)
pure val nowValues = Set(0, 1, 2, 2592000001, 2592000002, 2592000003)
pure val weight_moveNote = 7
pure val weight_commitDeletion = 8
pure val weight_moveClock = 3
```

## Story: Erase or recover only the recording of my reviewed note

### Fresh Notes references and the exact audio operation receipt govern cleanup

The recording journal allows one pending deletion for the exact note,
collection, revision, recording and operation. It validates and reads
back the whole row after create, replacement or retirement. A fresh
saved read classifies an unchanged note as original, or an absent note
with this operation's exact tombstone and no other recording reference
as deleted. A different revision, source reset, other operation, other
saved reference or unreadable evidence needs review. An agent voice
delete writes both the restorable copy and journal before committing the
tombstone, then moves matching recording bytes to audio Trash under
the same operation. A lost receipt retains recovery evidence. An audio
purge keeps the Trash row while the operation has a recovery row or
a saved note still references the note or audio. It removes the row
only after an exact purged receipt.

Maintenance plans based on authoritative saved records and replans
under the shared deletion lock. A live note's stale row needs no
recording erase. An absent note is automatically due only once 30
full days have elapsed. Expired audio that cannot be proven erased
retains its Trash row for a later pass. A backward clock cannot
make a row expire early. A source grant can be released only after a
fresh read of both saved Notes and restorable Trash shows no reference.
The browser requires Web Locks for this mutation and recovery. Browser
views hold live row claims, and Android respects a renewable 20-minute
renderer lease. The renderer renews when less than half remains.
Startup recovery re-reads authoritative evidence while holding the
deletion lock and does not settle a row still owned by another live
operation. The pinned references are `NotesTrashReadPublication`,
`NotesTrashSession` and the Java deletion lease fixture.

```quint
type NoteReadback = OriginalNote | ExactTombstone | DifferentNote
type RecordingReceipt = ReceiptUnreadable | ReceiptUnknown | ReceiptRemoved | ReceiptRestored | ReceiptPurged
type RecordingRecovery = KeepForReview | RetireRow | EraseAudio | MoveThenEraseAudio | ReturnAudio | DeleteOriginal
type RecordingEvidence = { noteState: NoteReadback, metadataRead: bool, owned: bool, audioTrashed: bool, receipt: RecordingReceipt, shared: bool }
pure val evidenceValues = Set(
  { noteState: ExactTombstone, metadataRead: true, owned: true, audioTrashed: true, receipt: ReceiptRemoved, shared: false },
  { noteState: ExactTombstone, metadataRead: true, owned: true, audioTrashed: true, receipt: ReceiptRemoved, shared: true },
  { noteState: ExactTombstone, metadataRead: true, owned: true, audioTrashed: false, receipt: ReceiptUnknown, shared: false },
  { noteState: OriginalNote, metadataRead: true, owned: true, audioTrashed: true, receipt: ReceiptRemoved, shared: false },
  { noteState: OriginalNote, metadataRead: true, owned: true, audioTrashed: false, receipt: ReceiptPurged, shared: false },
  { noteState: DifferentNote, metadataRead: false, owned: false, audioTrashed: false, receipt: ReceiptUnreadable, shared: false }
)
pure def recoveryPlan(evidence: RecordingEvidence): RecordingRecovery =
  if (evidence.noteState == DifferentNote or not(evidence.metadataRead and evidence.owned) or evidence.receipt == ReceiptUnreadable) KeepForReview
  else if (evidence.noteState == ExactTombstone) {
    if (evidence.shared) KeepForReview
    else if (evidence.receipt == ReceiptPurged) RetireRow
    else if (evidence.receipt == ReceiptRemoved and evidence.audioTrashed) EraseAudio
    else if (evidence.receipt == ReceiptUnknown and not(evidence.audioTrashed)) MoveThenEraseAudio
    else KeepForReview
  } else if (evidence.receipt == ReceiptPurged) DeleteOriginal
  else if (evidence.receipt == ReceiptRemoved and evidence.audioTrashed) ReturnAudio
  else if (evidence.receipt == ReceiptRemoved or evidence.audioTrashed) KeepForReview
  else RetireRow
pure def admitsBackstop(lockHeld: bool, liveClaim: bool, leaseUntil: int, now: int): bool =
  lockHeld and not(liveClaim) and now >= leaseUntil
pure def releasesSource(readBoth: bool, liveReference: bool, trashReference: bool): bool =
  readBoth and not(liveReference or trashReference)
pure def lawEraseNeedsExactTombstoneAndNoReference(evidence: RecordingEvidence): bool =
  (recoveryPlan(evidence) == EraseAudio or recoveryPlan(evidence) == MoveThenEraseAudio) implies
    evidence.noteState == ExactTombstone and not(evidence.shared) and evidence.metadataRead and evidence.owned
pure def lawDifferentNoteKeepsRecovery(evidence: RecordingEvidence): bool =
  evidence.noteState == DifferentNote implies recoveryPlan(evidence) == KeepForReview
pure def lawLeaseProtectsCurrentRenderer(lockHeld: bool, liveClaim: bool, leaseUntil: int, now: int): bool =
  (liveClaim or now < leaseUntil) implies not(admitsBackstop(lockHeld, liveClaim, leaseUntil, now))
pure def lawRestorableSourceGrantSurvives(readBoth: bool, liveReference: bool, trashReference: bool): bool =
  (liveReference or trashReference) implies not(releasesSource(readBoth, liveReference, trashReference))
```

## Story: Recover a note from the primary agent-hosted collection

### Canonical Trash restores the exact deleted ID against the current revision

The primary Alpha view also exposes a canonical Recently Deleted
list. It supports restore only, with no empty or permanent erase
control. The displayed row holds note ID, deleted time and the observed
collection revision. Opening and accepting the restore review require
the same ID, deletion time and revision. A delete toast's immediate
Undo instead waits for the existing save and checks the same ID and
deletion time against the refreshed current list. In both paths the
editor sends `restore-note` with the current exact collection revision
and checks that the reply targets the same note. Canonical service
restore requires update authority, serializes the transaction, checks
the revision again, removes the Trash row and prepends the full note.
An already active same ID or missing Trash entry refuses restore.
The delete transaction can Trash a set of existing notes with the
same service content key. Its explicit changed ID set is separate
from the user-visible target ID.

The stored Notes reader accepts schemas 1, 2 and 3 and returns schema 3.
A missing or null Trash is empty. Its capacity is 10,000 rows.
It validates exact admitted envelope fields and each Trash entry's
note and deletion timestamp. It rejects duplicate IDs across active
and Trash, including duplicates within either list. Every optional
note revision names an active or trashed ID and must be an integer
between zero and the current collection revision. Schema 1 active
nonempty bodies receive their historical leading separator on upgrade.
Unsupported documents fail validation. Decoding dates, authored
bytes, content-key equivalence and atomic multi-note transactions
remain adapter conformance requirements.

```quint
type CanonicalRestoreEvidence = { currentOwner: bool, canUpdate: bool, activeId: bool, matchesDeletion: bool, openedAtRevision: bool, undoToast: bool, readyToRestore: bool }
pure val restoreFactsValues = Set(
  { currentOwner: true, canUpdate: true, activeId: false, matchesDeletion: true, openedAtRevision: true, undoToast: false, readyToRestore: true },
  { currentOwner: true, canUpdate: true, activeId: false, matchesDeletion: true, openedAtRevision: false, undoToast: true, readyToRestore: true },
  { currentOwner: true, canUpdate: true, activeId: true, matchesDeletion: true, openedAtRevision: true, undoToast: false, readyToRestore: true }
)
pure def canonicalRestore(restoreFacts: CanonicalRestoreEvidence, expectedRevision: int, currentRevision: int): bool =
  restoreFacts.currentOwner and restoreFacts.canUpdate and not(restoreFacts.activeId) and restoreFacts.matchesDeletion and
    (restoreFacts.undoToast or restoreFacts.openedAtRevision) and restoreFacts.readyToRestore and expectedRevision >= 0 and expectedRevision == currentRevision
pure def canonicalDocument(version: int, exactShape: bool, uniqueIds: bool, validatedRows: bool, trashCount: int): bool =
  (version == 1 or version == 2 or version == 3) and exactShape and uniqueIds and validatedRows and trashCount >= 0 and trashCount <= 10000
pure def lawCanonicalRestoreNeedsCurrentRevision(restoreFacts: CanonicalRestoreEvidence, expectedRevision: int, currentRevision: int): bool =
  expectedRevision != currentRevision implies not(canonicalRestore(restoreFacts, expectedRevision, currentRevision))
pure def lawCanonicalDocumentRejectsDuplicateIds(version: int, exactShape: bool, validatedRows: bool, trashCount: int): bool =
  not(canonicalDocument(version, exactShape, false, validatedRows, trashCount))
```
