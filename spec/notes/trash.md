# Notes Trash and recording custody

A deleted note goes to the canonical Notes Trash of the [Notes
client](./client.md), from which the owner restores it by its exact ID
and revision. Erasing needs the owner's retention choice and a current
review, never happens while the note's recording is shared, and is never
reported when its commit is unknown. [Audio custody](./audioCustody.md)
owns the device's recording files.

## Story: Recover a deleted note

> As the owner, I want to restore a note I deleted, exactly as it was, so
> that a deletion is never final until I decide it is.

### Canonical Trash restores the exact deleted ID against the current revision

The Recently Deleted list shows each row's note ID, deletion time and the
observed collection revision. Unless the owner chose three-day Trash
(below), it supports restore only, with no erase. Opening and accepting
the restore review require the same ID, deletion time and revision; a
delete's immediate Undo instead waits for the save and checks the same
ID and deletion time against the refreshed list. Restore requires update
authority and the current exact collection revision, removes the Trash
row and puts the full note back, and checks that the reply targets the
same note. An already active same ID or a missing Trash entry refuses
restore. The stored document has one schema, at most 10,000 Trash rows,
and no ID twice across the active list and Trash.

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
pure val notesSchemaVersion: int = 1
pure def canonicalDocument(version: int, exactShape: bool, uniqueIds: bool, validatedRows: bool, trashCount: int): bool =
  version == notesSchemaVersion and exactShape and uniqueIds and validatedRows and trashCount >= 0 and trashCount <= 10000
pure def lawCanonicalRestoreNeedsCurrentRevision(restoreFacts: CanonicalRestoreEvidence, expectedRevision: int, currentRevision: int): bool =
  expectedRevision != currentRevision implies not(canonicalRestore(restoreFacts, expectedRevision, currentRevision))
pure def lawCanonicalDocumentRejectsDuplicateIds(version: int, exactShape: bool, validatedRows: bool, trashCount: int): bool =
  not(canonicalDocument(version, exactShape, false, validatedRows, trashCount))
```

## Story: Erase or recover only the recording of my reviewed note

> As the owner, I want erasing or recovering a note to touch only that
> note's own recording, so that a recording another note or a share still
> uses is never lost.

### Fresh Notes references and the exact audio operation receipt govern cleanup

The recording journal allows one pending deletion for the exact note,
collection, revision, recording and operation. A fresh read classifies an
unchanged note as original, or an absent note with this operation's exact
tombstone and no other recording reference as deleted; anything else
needs review. A voice delete records the journal before committing the
tombstone, then moves the matching recording bytes to audio Trash under
the same operation; a lost receipt keeps the recovery evidence. Audio is
erased only for the exact tombstone and only when no saved note still
references it, and its row is removed only after an exact purged receipt.
A source grant is released only after a fresh read of both saved Notes and
Trash shows no reference.

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
pure def releasesSource(readBoth: bool, liveReference: bool, trashReference: bool): bool =
  readBoth and not(liveReference or trashReference)
pure def lawEraseNeedsExactTombstoneAndNoReference(evidence: RecordingEvidence): bool =
  (recoveryPlan(evidence) == EraseAudio or recoveryPlan(evidence) == MoveThenEraseAudio) implies
    evidence.noteState == ExactTombstone and not(evidence.shared) and evidence.metadataRead and evidence.owned
pure def lawDifferentNoteKeepsRecovery(evidence: RecordingEvidence): bool =
  evidence.noteState == DifferentNote implies recoveryPlan(evidence) == KeepForReview
pure def lawRestorableSourceGrantSurvives(readBoth: bool, liveReference: bool, trashReference: bool): bool =
  (liveReference or trashReference) implies not(releasesSource(readBoth, liveReference, trashReference))
```

## Story: Let deleted notes expire after three days when I choose that

> As the owner, I want to choose a three-day Trash, so that a deleted
> note can be erased for good once I review it or once three days pass,
> and never while a recording it holds is shared.

### Erase and expiry need the owner's three-day choice, a current review, and no shared recording

When the owner has chosen three-day Trash, a deleted note can be erased
by the owner after reviewing that exact deletion: the same note
revision and deletion time. It is also swept once three days have
passed since deletion. Neither happens while its recording is shared.
Once three days have passed, the note can no longer be restored. Without
that choice nothing in canonical Trash is erased.

```quint
type CanonicalTrashEntry = { retentionOn: bool, trashed: bool, sharedAudio: bool, deletedAt: int, now: int,
  revision: int, reviewRevision: int, reviewDeletion: int }
pure val threeDays = 259200000
pure def canonicalDue(entry: CanonicalTrashEntry): bool = entry.now - entry.deletedAt >= threeDays
pure def canonicalReviewed(entry: CanonicalTrashEntry): bool =
  entry.trashed and entry.revision == entry.reviewRevision and entry.deletedAt == entry.reviewDeletion
pure def canonicalRestoreOpen(entry: CanonicalTrashEntry): bool =
  canonicalReviewed(entry) and not(entry.retentionOn and canonicalDue(entry))
pure def canonicalEraseAllowed(entry: CanonicalTrashEntry, isOwner: bool): bool =
  entry.retentionOn and isOwner and canonicalReviewed(entry) and not(entry.sharedAudio)
pure def canonicalSweepAllowed(entry: CanonicalTrashEntry): bool =
  entry.retentionOn and entry.trashed and canonicalDue(entry) and not(entry.sharedAudio)
pure def lawEraseNeedsRetentionChoice(entry: CanonicalTrashEntry, isOwner: bool): bool =
  canonicalEraseAllowed(entry, isOwner) or canonicalSweepAllowed(entry) implies entry.retentionOn and not(entry.sharedAudio)
pure def lawExpiredNoteCannotRestore(entry: CanonicalTrashEntry): bool =
  entry.retentionOn and canonicalDue(entry) implies not(canonicalRestoreOpen(entry))
pure def lawStaleReviewCannotErase(entry: CanonicalTrashEntry, isOwner: bool): bool =
  entry.revision != entry.reviewRevision implies not(canonicalEraseAllowed(entry, isOwner))
pure def lawSweepWaitsForThreeDays(entry: CanonicalTrashEntry): bool =
  not(canonicalDue(entry)) implies not(canonicalSweepAllowed(entry))
pure val entryValues = Set(
  { retentionOn: true, trashed: true, sharedAudio: false, deletedAt: 0, now: 259199999, revision: 1, reviewRevision: 1, reviewDeletion: 0 },
  { retentionOn: true, trashed: true, sharedAudio: false, deletedAt: 0, now: 259200000, revision: 1, reviewRevision: 1, reviewDeletion: 0 },
  { retentionOn: true, trashed: true, sharedAudio: true, deletedAt: 0, now: 259200000, revision: 2, reviewRevision: 2, reviewDeletion: 0 },
  { retentionOn: false, trashed: true, sharedAudio: false, deletedAt: 0, now: 518400000, revision: 1, reviewRevision: 1, reviewDeletion: 0 },
  { retentionOn: true, trashed: true, sharedAudio: false, deletedAt: 0, now: 1, revision: 2, reviewRevision: 1, reviewDeletion: 0 })
```

### An erase that may or may not have committed never reports success

An erase commits the whole Notes document at once. A saved commit
erases the note and, for a voice note, leaves its recording cleanup
pending. A definite conflict changes nothing. When the commit or its
readback fails so the outcome is unknown, nothing is reported as
successful and the store must be reopened from its authoritative copy
before it is read again; if the commit did apply, the note is erased and
its recording cleanup is pending.

```quint
type EraseCommit = CommitSaved | CommitConflict | CommitUnknownApplied | CommitUnknownNotApplied
type EraseOutcome = { erased: bool, cleanupPending: bool, storeReady: bool, reportedSuccess: bool }
pure def eraseOutcome(commit: EraseCommit, hasAudio: bool): EraseOutcome =
  if (commit == CommitSaved) { erased: true, cleanupPending: hasAudio, storeReady: true, reportedSuccess: true }
  else if (commit == CommitConflict) { erased: false, cleanupPending: false, storeReady: true, reportedSuccess: false }
  else if (commit == CommitUnknownApplied) { erased: true, cleanupPending: hasAudio, storeReady: false, reportedSuccess: false }
  else { erased: false, cleanupPending: false, storeReady: false, reportedSuccess: false }
pure def lawUnknownCommitNeverClaimsSuccess(hasAudio: bool): bool =
  not(eraseOutcome(CommitUnknownApplied, hasAudio).reportedSuccess) and not(eraseOutcome(CommitUnknownNotApplied, hasAudio).reportedSuccess)
pure def lawUnknownCommitRequiresReopen(hasAudio: bool): bool =
  not(eraseOutcome(CommitUnknownApplied, hasAudio).storeReady) and not(eraseOutcome(CommitUnknownNotApplied, hasAudio).storeReady)
pure def lawRecordingCleanupFollowsErase(commit: EraseCommit, hasAudio: bool): bool =
  eraseOutcome(commit, hasAudio).cleanupPending iff (eraseOutcome(commit, hasAudio).erased and hasAudio)
```

### A recording's cleanup is acknowledged only with the device's proof that the audio is gone

After an erase leaves a recording cleanup pending, the owner's store
acknowledges it only when it is open, the device has proven that exact
recording erased, and the receipt is the exact one. A queued erase or
acknowledgement that is cancelled before it is dispatched does nothing;
once its commit is dispatched, cancelling cannot undo the published
document.

```quint
type QueuedTrashCall = { dispatched: bool, cancelled: bool, published: bool }
pure def mayAcknowledgeCleanup(storeReady: bool, isOwner: bool, exactReceipt: bool, cleanupPending: bool, deviceErased: bool): bool =
  storeReady and isOwner and exactReceipt and cleanupPending and deviceErased
pure def cancelQueuedCall(call: QueuedTrashCall): QueuedTrashCall =
  if (call.dispatched) { ...call, cancelled: true } else { ...call, cancelled: true, published: false }
pure def lawAcknowledgementNeedsDeviceProof(storeReady: bool, isOwner: bool, exactReceipt: bool, cleanupPending: bool): bool =
  not(mayAcknowledgeCleanup(storeReady, isOwner, exactReceipt, cleanupPending, false))
pure def lawCancelBeforeDispatchPublishesNothing(call: QueuedTrashCall): bool =
  not(call.dispatched) implies not(cancelQueuedCall(call).published)
pure def lawCancelAfterDispatchKeepsPublication(call: QueuedTrashCall): bool =
  call.dispatched implies cancelQueuedCall(call).published == call.published
pure val callValues = Set(
  { dispatched: false, cancelled: false, published: false },
  { dispatched: true, cancelled: false, published: true },
  { dispatched: true, cancelled: false, published: false })
```

### The proof of erase comes from the service's own verifier, else the host's verifier found when the cleanup is acknowledged, and only a literal true is proof

A host whose recordings live outside the agent proves an erase through its
registered verifier. The Notes service asks its own verifier first; with
none, it looks the host's verifier up when the cleanup is acknowledged, so
a host that registered after the Notes service started still counts. With
neither, no cleanup is acknowledged. Only an answer that is exactly `true`
proves the erase: any other value, or a failure, proves nothing and the
cleanup stays pending. The acknowledgement is an owner route, and it
retires only the exact pending receipt.

```quint
type CleanupVerifier = OwnVerifier | HostVerifier | NoVerifier
type VerifierAnswer = AnsweredTrue | AnsweredOther | AnswerFailed
pure def cleanupVerifier(ownVerifier: bool, hostRegistered: bool): CleanupVerifier =
  if (ownVerifier) OwnVerifier else if (hostRegistered) HostVerifier else NoVerifier
pure def verifierProvedErase(verifier: CleanupVerifier, answer: VerifierAnswer): bool =
  verifier != NoVerifier and answer == AnsweredTrue
pure def lawOwnVerifierTakesPrecedence(hostRegistered: bool): bool = cleanupVerifier(true, hostRegistered) == OwnVerifier
pure def lawLateHostVerifierCounts(ownVerifier: bool): bool = not(ownVerifier) implies cleanupVerifier(ownVerifier, true) == HostVerifier
pure def lawNoVerifierProvesNothing(answer: VerifierAnswer): bool = not(verifierProvedErase(NoVerifier, answer))
pure def lawOnlyLiteralTrueProves(verifier: CleanupVerifier): bool =
  not(verifierProvedErase(verifier, AnsweredOther)) and not(verifierProvedErase(verifier, AnswerFailed))
```

## Story: Delete the phone note I asked to delete

> As the owner, I want a note my phone looked up to be offered for deletion
> only when I asked the agent to delete a note, and only once I chose exactly
> which note it is.

### A phone note a lookup found is offered for deletion only when the model read the request as a deletion

The model reads the owner's original message in whatever words it uses and
gives each title or latest lookup it proposes an intent: read, edit or
delete. A lookup proposed with no intent is a read. After the owner shares
the note a lookup with the delete intent found, its exact target is offered
for a separate deletion review on the phone, bound to the original message,
with the answer "The note is ready for deletion review. Approve the exact
note to delete it. Nothing has been deleted yet." A deleting lookup that
found no note answers "No matching note was shared. Nothing was deleted.",
and one that left the choice to the owner's uncertain pick answers "The
lookup did not establish which note you meant. Nothing was deleted. Choose
the exact note before continuing."; neither deletes anything. A read or an
edit lookup is never offered for deletion. The intent is the model's
reading, not the owner's words, so the deletion review on the phone, which
names the exact note and runs only on the owner's approval, is what stands
between a deletion intent that text from a page, an email or a connector
led the model to and a deleted note. A deletion intent also needs words of
the owner's own in the message, and a title lookup's title must be words
the owner said ([read](read.md)).

```quint
type LookupIntent = ReadIntent | EditIntent | DeleteIntent
type LookupOutcome = NoteFound | NoNoteFound | ChoiceUncertain
type DeletionReply = OffersDeletionReview | SaysNothingWasDeleted | NotADeletion
pure def deletionIntent(intent: LookupIntent): bool = intent == DeleteIntent
pure def deleteAfterLookup(intent: LookupIntent, found: LookupOutcome): bool = deletionIntent(intent) and found == NoteFound
pure def deletionReply(intent: LookupIntent, found: LookupOutcome): DeletionReply =
  if (not(deletionIntent(intent))) NotADeletion
  else if (deleteAfterLookup(intent, found)) OffersDeletionReview
  else SaysNothingWasDeleted
pure def lawOnlyADeleteIntentDeletes(intent: LookupIntent, found: LookupOutcome): bool =
  deleteAfterLookup(intent, found) implies intent == DeleteIntent
pure def lawAnUnresolvedLookupDeletesNothing(intent: LookupIntent): bool =
  not(deleteAfterLookup(intent, NoNoteFound)) and not(deleteAfterLookup(intent, ChoiceUncertain))
pure def lawAReadOrAnEditDeletesNothing(found: LookupOutcome): bool =
  not(deleteAfterLookup(ReadIntent, found)) and not(deleteAfterLookup(EditIntent, found)) and
    deletionReply(ReadIntent, found) == NotADeletion and deletionReply(EditIntent, found) == NotADeletion
pure def lawADeletionAlwaysAnswersWhatItDeleted(found: LookupOutcome): bool =
  deletionReply(DeleteIntent, found) != NotADeletion
```
