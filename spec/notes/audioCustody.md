# Device Notes audio and transcription windows

A note's recording lives on the device as an audio file in private,
non-backed-up storage, with its metadata, owned by its note, in an
encrypted slot. This spec begins when the device's recorder hands over a
stopped clip. [Notes Trash](./trash.md) owns journal admission and
[secure slots](../auth/secureSlots.md) own encrypted slot readback.

## Story: Retain a finished recording for the same note and recover interrupted metadata

> As the owner, I want a recording I finished to be kept with its note,
> and an interrupted save to be reported as unknown rather than lost or
> claimed.

### The audio and the confirmed metadata are separate parts of retention

Only a native recorder can nominate a source file. Recording and note IDs
are 1–100 ASCII letters, digits, underscores or dashes. The source must be
a file with positive length, the elapsed duration positive, and a
transcript must be supplied. Short clips are at most 4 MiB, 60 seconds
and 64,000 transcript units. A long note keeps up to 150,000 UTF-16 units
of transcript in its audio metadata without splitting a surrogate pair;
the complete transcript belongs to the note.

New audio is installed through a pending file that is then renamed; a
failed copy or rename cleans up the pending file. The metadata write
follows and must read back the exact encrypted slot. A failure can leave
audio with missing or unconfirmed metadata, and the retention is saved
only when both the bytes and the exact encrypted row are confirmed.

An existing audio file with a readable row may update its transcript
only for the same owner and only while the row is live. A retained
row keeps its original duration and creation time. A file with no row
may be replaced when the caller can still supply a stopped source.
An ID without audio and with retained deletion receipts cannot be
reattached.

```quint
import numbers as Num from "../core/numbers"
type RecordKind = ShortClip | LongNote
type RetainPlan = ImportAudio | UpdateTranscript | RetainRefused
type MetadataStatus = NoMetadata | CurrentMetadata | TrashedMetadata | RetiredMetadata | UnreadableMetadata
type RetainFacts = { nativeSource: bool, validIds: bool, filePresent: bool, bytes: int, duration: int, transcriptPresent: bool,
  transcriptUnits: int, targetAudio: bool, metadata: MetadataStatus, ownerExact: bool }
type RetainResult = RetentionRefused | RetentionUnknown | RetentionSaved
pure def sourceFits(kind: RecordKind, facts: RetainFacts): bool =
  facts.nativeSource and facts.validIds and facts.filePresent and facts.bytes > 0 and facts.duration > 0 and
    facts.transcriptPresent and facts.transcriptUnits >= 0 and
    (if (kind == ShortClip) facts.bytes <= 4194304 and facts.duration <= 60000 and facts.transcriptUnits <= 64000
      else facts.transcriptUnits <= 150000)
pure def retainPlan(kind: RecordKind, facts: RetainFacts): RetainPlan =
  if (not(sourceFits(kind, facts)) or facts.metadata == UnreadableMetadata) RetainRefused
  else if (not(facts.targetAudio) and facts.metadata == RetiredMetadata) RetainRefused
  else if (facts.targetAudio and facts.metadata != NoMetadata) {
    if (facts.metadata == CurrentMetadata and facts.ownerExact) UpdateTranscript else RetainRefused
  } else ImportAudio
pure def retentionResult(plan: RetainPlan, bytesInstalled: bool, exactEncryptedReadback: bool): RetainResult =
  if (plan == RetainRefused) RetentionRefused
  else if (bytesInstalled and exactEncryptedReadback) RetentionSaved else RetentionUnknown
pure def longTranscriptUnits(transcriptUnits: int, highSurrogateAtCut: bool): int =
  if (transcriptUnits <= 150000) transcriptUnits else if (highSurrogateAtCut) 149999 else 150000
pure val longFacts: RetainFacts = { nativeSource: true, validIds: true, filePresent: true, bytes: 11000000, duration: 100000,
  transcriptPresent: true, transcriptUnits: 150000, targetAudio: false, metadata: NoMetadata, ownerExact: true }
pure val factsValues = Set(longFacts, { ...longFacts, targetAudio: true, metadata: CurrentMetadata, ownerExact: false },
  { ...longFacts, metadata: RetiredMetadata }, { ...longFacts, transcriptUnits: 150001 })
pure def lawRetiredAudioCannotBeReattached(kind: RecordKind, facts: RetainFacts): bool =
  not(facts.targetAudio) and facts.metadata == RetiredMetadata implies retainPlan(kind, facts) == RetainRefused
pure def lawTranscriptUpdateRequiresExactLiveOwner(kind: RecordKind, facts: RetainFacts): bool =
  retainPlan(kind, facts) == UpdateTranscript implies facts.targetAudio and facts.ownerExact and facts.metadata == CurrentMetadata
pure def lawSavedRetentionHasBothParts(plan: RetainPlan, bytesInstalled: bool, exactEncryptedReadback: bool): bool =
  retentionResult(plan, bytesInstalled, exactEncryptedReadback) == RetentionSaved implies bytesInstalled and exactEncryptedReadback
pure def lawSurrogateAtCutIsNotKept(transcriptUnits: int): bool =
  transcriptUnits > 150000 implies longTranscriptUnits(transcriptUnits, true) == 149999
```

## Story: Change only the exact reviewed recording and retain its operation receipt

> As the owner, I want trashing, restoring or erasing a recording to act
> only on the recording I reviewed, once, with a receipt I can rely on.

### One current operation controls trash and an erased ID remains retired

A native change checks stored note ownership, the exact audio ID and a
lowercase UUID-shaped operation. The store keeps at most 128 receipts
and never evicts an earlier operation to gain capacity. Moving to
trash commits the active operation and `removed` receipt together and
makes the file unplayable. Repeating the same request returns its existing
receipt. A foreign operation may not restore a trashed recording.
Restoring requires the audio file and is open for 60 days after
deletion, inclusive. Once restored, the old operation returns
`restored`, even after another delete, without modifying the later row.
Purging requires the matching `removed` receipt and active operation.
It erases bytes first, then commits `purged` and clears the transcript.
If byte deletion fails, no `purged` status is published. If metadata
settlement fails after audio erasure, an unconfirmed outcome may have
no bytes. Exact retry can confirm the same operation after readback.
Already-purged retry returns its retained receipt. Playback of the
recording stops before an admitted change. An unconfirmed metadata write
keeps the old row until an exact readback shows otherwise.

```quint
type AudioReceipt = RemovedAudio | RestoredAudio | PurgedAudio | UnknownAudio
pure val audioRestoreWindowMs: int = 5184000000
type AudioCustody = { owner: int, hasAudio: bool, activeOp: int, deletedAt: int, wall: int, transcript: bool,
  receiptCount: int, receipts: int -> AudioReceipt }
pure val initial: AudioCustody = { owner: 1, hasAudio: true, activeOp: 0, deletedAt: 0, wall: 1, transcript: true,
  receiptCount: 0, receipts: Map() }
pure def priorReceipt(s: AudioCustody, operation: int): AudioReceipt = s.receipts.getOr(operation, UnknownAudio)
pure def roomFor(s: AudioCustody, operation: int): bool = s.receipts.keys().contains(operation) or s.receiptCount < 128
pure def countWith(s: AudioCustody, operation: int): int = if (s.receipts.keys().contains(operation)) s.receiptCount else s.receiptCount + 1
pure def canTrashAudio(s: AudioCustody, noteOwner: int, operation: int): bool =
  noteOwner == s.owner and operation > 0 and (priorReceipt(s, operation) != UnknownAudio or
    ((s.deletedAt == 0 or s.activeOp == operation) and roomFor(s, operation)))
pure def trashAudio(s: AudioCustody, noteOwner: int, operation: int, metadataConfirmed: bool): AudioCustody =
  if (not(metadataConfirmed) or priorReceipt(s, operation) != UnknownAudio) s
  else { ...s, activeOp: operation, deletedAt: s.wall, receiptCount: countWith(s, operation), receipts: s.receipts.put(operation, RemovedAudio) }
pure def canRestoreAudio(s: AudioCustody, noteOwner: int, operation: int): bool =
  noteOwner == s.owner and operation > 0 and (priorReceipt(s, operation) == RestoredAudio or
    (priorReceipt(s, operation) != PurgedAudio and s.hasAudio and roomFor(s, operation) and
      (s.deletedAt == 0 or (s.activeOp == operation and s.wall - s.deletedAt <= audioRestoreWindowMs))))
pure def restoreAudio(s: AudioCustody, noteOwner: int, operation: int, metadataConfirmed: bool): AudioCustody =
  if (not(metadataConfirmed) or priorReceipt(s, operation) == RestoredAudio) s
  else { ...s, activeOp: 0, deletedAt: 0, receiptCount: countWith(s, operation), receipts: s.receipts.put(operation, RestoredAudio) }
pure def canPurgeAudio(s: AudioCustody, noteOwner: int, operation: int): bool =
  noteOwner == s.owner and operation > 0 and (priorReceipt(s, operation) == PurgedAudio or
    (priorReceipt(s, operation) == RemovedAudio and s.deletedAt > 0 and s.activeOp == operation))
pure def purgeAudio(s: AudioCustody, noteOwner: int, operation: int, bytesGone: bool, metadataConfirmed: bool): AudioCustody =
  if (priorReceipt(s, operation) == PurgedAudio or (s.hasAudio and not(bytesGone))) s
  else if (metadataConfirmed) { ...s, hasAudio: false, transcript: false, receipts: s.receipts.put(operation, PurgedAudio) }
  else { ...s, hasAudio: false }
pure def canAdvanceAudioClock(s: AudioCustody, wall: int): bool = wall > 0 and wall != s.wall
pure def advanceAudioClock(s: AudioCustody, wall: int): AudioCustody = { ...s, wall: wall }
pure val operationValues = Set(0, 1, 2, 3)
pure val noteOwnerValues = Set(0, 1, 2)
pure val wallValues = Set(1, 2, 5184000001, 5184000002)
pure val weight_trashAudio = 4
pure val weight_restoreAudio = 4
pure val weight_purgeAudio = 5
pure def alwaysAudioTimeAndOwner(s: AudioCustody): bool = s.wall > 0 and s.owner == 1 and s.deletedAt >= 0
pure def alwaysLiveAudioHasNoActiveOperation(s: AudioCustody): bool = s.deletedAt == 0 implies s.activeOp == 0
pure def alwaysReceiptBudget(s: AudioCustody): bool = s.receiptCount >= 0 and s.receiptCount <= 128
pure def stepErasedAudioCannotReappear(before: AudioCustody, after: AudioCustody): bool = not(before.hasAudio) implies not(after.hasAudio)
pure def stepOnlyPurgeErasesBytes(before: AudioCustody, via: str, after: AudioCustody): bool =
  before.hasAudio and not(after.hasAudio) implies via == "purgeAudio" and before.deletedAt > 0 and before.activeOp > 0
pure def lawRestoredOperationCannotTrashAgain(s: AudioCustody, noteOwner: int, operation: int, metadataConfirmed: bool): bool =
  priorReceipt(s, operation) == RestoredAudio implies trashAudio(s, noteOwner, operation, metadataConfirmed) == s
pure def sometimesReceiptConfirmsPurge(s: AudioCustody): bool = priorReceipt(s, 1) == PurgedAudio
pure def sometimesBytesGoneAwaitingReceipt(s: AudioCustody): bool = not(s.hasAudio) and priorReceipt(s, 1) == RemovedAudio
```

## Story: Transcribe only a bounded window of the recording I selected

> As the owner, I want transcription to hear only a short window of the
> recording I selected, and nothing once that recording has changed.

### A private temporary clip and the exact recording identity fence every use

A window names the recording, its note, the exact stored duration and an
offset aligned to 25 seconds strictly below that duration. The stored row
must name both, match the duration and not be deleted, and the live audio
file must exist. Only the range from the offset up to 25 seconds later is
read, within a bounded buffer and time budget, checking cancellation. An
offset at or past the encoded end yields a distinct empty window, which
the caller checks again before publishing silence.

The temporary clip stays on the device and is deleted on failure and on
close. A nonempty window rechecks the recording after extraction, before
every upload and before returning text; an empty window is never sent.

```quint
type WindowInput = { validIds: bool, exactAudio: bool, exactNote: bool, duration: int, recordedDuration: int,
  offset: int, deletedKeyPresent: bool, liveFilePresent: bool }
type Extraction = ExtractedClip | BeyondEncodedEnd | ExtractionFailed
type WindowResult = WindowUnavailable | WindowHasAudio | WindowIsEmpty
type WindowFile = NoWindowFile | CallerOwnsWindow | CleanupPending | CleanupUnconfirmed
pure def windowAllowed(window: WindowInput): bool =
  window.validIds and window.exactAudio and window.exactNote and window.duration == window.recordedDuration and
    window.duration > 0 and window.duration <= Num::maxSafeInteger and window.offset >= 0 and window.offset < window.duration and
    window.offset % 25000 == 0 and not(window.deletedKeyPresent) and window.liveFilePresent
pure def windowEnd(offset: int, duration: int): int = if (duration - offset <= 25000) duration else offset + 25000
pure def extractedWindow(window: WindowInput, decoded: Extraction, supportedTrack: bool, sampledSafely: bool,
  exactAfter: bool, cancelled: bool): WindowResult =
  if (not(windowAllowed(window) and supportedTrack)) WindowUnavailable
  else if (decoded == BeyondEncodedEnd) WindowIsEmpty
  else if (decoded == ExtractedClip and sampledSafely and exactAfter and not(cancelled)) WindowHasAudio else WindowUnavailable
pure def mayUploadWindow(result: WindowResult, exactAtUse: bool, currentAuthority: bool, cancelled: bool): bool =
  result == WindowHasAudio and exactAtUse and currentAuthority and not(cancelled)
pure def mayPublishSilence(result: WindowResult, exactAtUse: bool, currentAuthority: bool, cancelled: bool): bool =
  result == WindowIsEmpty and exactAtUse and currentAuthority and not(cancelled)
pure def temporaryAfterExtraction(result: WindowResult, allocated: bool): WindowFile =
  if (not(allocated)) NoWindowFile else if (result == WindowUnavailable) CleanupPending else CallerOwnsWindow
pure def temporaryAfterClose(held: WindowFile, deleteConfirmed: bool): WindowFile =
  if (held == NoWindowFile or deleteConfirmed) NoWindowFile else CleanupUnconfirmed
pure val windowValues = Set({ validIds: true, exactAudio: true, exactNote: true, duration: 70000, recordedDuration: 70000,
    offset: 25000, deletedKeyPresent: false, liveFilePresent: true },
  { validIds: true, exactAudio: true, exactNote: false, duration: 70000, recordedDuration: 70000,
    offset: 25001, deletedKeyPresent: false, liveFilePresent: true })
pure def lawValidWindowIsBounded(window: WindowInput): bool =
  windowAllowed(window) implies windowEnd(window.offset, window.duration) > window.offset and
    windowEnd(window.offset, window.duration) - window.offset <= 25000
pure def lawEmptyWindowNeverUploads(exactAtUse: bool, currentAuthority: bool, cancelled: bool): bool =
  not(mayUploadWindow(WindowIsEmpty, exactAtUse, currentAuthority, cancelled))
pure def lawEmptyResponseNeedsLiveAuthority(result: WindowResult, exactAtUse: bool, currentAuthority: bool, cancelled: bool): bool =
  mayPublishSilence(result, exactAtUse, currentAuthority, cancelled) implies exactAtUse and currentAuthority and not(cancelled)
pure def lawFailedExtractionDoesNotTransferClip(allocated: bool): bool =
  temporaryAfterExtraction(WindowUnavailable, allocated) != CallerOwnsWindow
pure def lawCloseWithoutDeleteCannotConfirmAbsence(held: WindowFile): bool =
  held != NoWindowFile implies temporaryAfterClose(held, false) == CleanupUnconfirmed
```

## Story: Keep a stopped recording until it is claimed for its note

> As the owner, I want a recording I stopped kept until it is saved to its
> note, so that a lost reply or reload never loses or duplicates it.

### A stopped recording is claimed once and committed only to its canonical note

A stopped recording is staged with its bytes. Its owner can claim it
once, and a claimed recording is committed only to its canonical note.
The owner can discard a recording only while it is still unclaimed. A
lost reply, a retry, a reload, a refused rebind or an aborted
transaction keeps the bytes and the claim, so a claimed create is never
replayed. A stopped recording has its bytes and no claim yet, and a
claimed or committed recording always has its bytes.

```quint
type PendingPhase = PendingEmpty | PendingStopped | PendingClaimed | PendingCommitted | PendingDiscarded
type PendingRecording = { phase: PendingPhase, bytes: bool, claims: int, canonicalNote: bool }
pure def stagePending(pending: PendingRecording): PendingRecording =
  if (pending.phase == PendingEmpty or pending.phase == PendingDiscarded) { phase: PendingStopped, bytes: true, claims: 0, canonicalNote: false }
  else pending
pure def claimPending(pending: PendingRecording, isOwner: bool): PendingRecording =
  if (pending.phase == PendingStopped and isOwner) { ...pending, phase: PendingClaimed, claims: pending.claims + 1 } else pending
pure def commitPending(pending: PendingRecording, isOwner: bool, canonical: bool): PendingRecording =
  if (pending.phase == PendingClaimed and isOwner and canonical) { ...pending, phase: PendingCommitted, canonicalNote: true } else pending
pure def discardPending(pending: PendingRecording, isOwner: bool): PendingRecording =
  if (pending.phase == PendingStopped and isOwner) { ...pending, phase: PendingDiscarded, bytes: false } else pending
pure def pendingSafe(pending: PendingRecording): bool =
  pending.claims <= 1 and
  (pending.phase == PendingStopped implies pending.bytes and pending.claims == 0) and
  ((pending.phase == PendingClaimed or pending.phase == PendingCommitted) implies pending.bytes) and
  (pending.phase == PendingCommitted iff pending.canonicalNote)
pure def lawClaimHappensOnce(pending: PendingRecording, isOwner: bool): bool =
  pendingSafe(pending) implies pendingSafe(claimPending(claimPending(pending, isOwner), isOwner))
pure def lawCommitNeedsCanonicalNote(pending: PendingRecording, isOwner: bool): bool =
  commitPending(pending, isOwner, false) == pending
pure def lawClaimedRecordingCannotBeDiscarded(pending: PendingRecording, isOwner: bool): bool =
  pending.phase == PendingClaimed implies discardPending(pending, isOwner) == pending
pure def lawStepsKeepRecordingSafe(pending: PendingRecording, isOwner: bool, canonical: bool): bool =
  pendingSafe(pending) implies pendingSafe(stagePending(pending)) and pendingSafe(claimPending(pending, isOwner)) and
  pendingSafe(commitPending(pending, isOwner, canonical)) and pendingSafe(discardPending(pending, isOwner))
pure val pendingValues = Set(
  { phase: PendingEmpty, bytes: false, claims: 0, canonicalNote: false },
  { phase: PendingStopped, bytes: true, claims: 0, canonicalNote: false },
  { phase: PendingClaimed, bytes: true, claims: 1, canonicalNote: false },
  { phase: PendingCommitted, bytes: true, claims: 1, canonicalNote: true },
  { phase: PendingDiscarded, bytes: false, claims: 0, canonicalNote: false })
```
