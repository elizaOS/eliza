# Android retained Notes audio and transcription windows

AlphaPhone `8d44dfe5` imports `RecordingStore` in `AlphaNoteAudioPlugin.java`
and `RecordingWindow` in `AlphaVoiceCloudPlugin.java`. The producer paths
are `plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media`
at Eliza `c518127a`. The installed files live in no-backup `note-audio` and
metadata uses `note-audio-metadata:v1:<id>` with owner field `noteId`.
Grace `48b43b9c` has no product call to either class. Its Eliza `7743504b`
contains an older RecordingStore and no RecordingWindow.
[Notes Trash and recovery](./alpha/notesTrash.md) owns renderer and journal
admission. [Native JSON slots](./mobileSecureSlots.md) own encrypted slot
readback. Alpha's separate native recorder and foreground service produce
stopped clips. This contract begins at the handoff from that recorder.

## Story: Retain a finished recording for the same note and recover interrupted metadata

### The audio and the confirmed metadata are separate parts of retention

Only a native recorder can nominate a source file. Recording and note IDs
are 1–100 ASCII letters, digits, underscores or dashes. The source must be
a file with positive length, the elapsed duration positive, and a
transcript must be supplied. Alpha's short clips are at most 4 MiB,
60 seconds and 64,000 transcript units. The long Notes path uses no
product byte or duration cap below the Java signed-long range. It keeps
up to 150,000 UTF-16 units in audio metadata without splitting a
surrogate pair. The complete transcript belongs to the note. The
separate encrypted slot still applies its serialized byte cap.

New audio first moves or copies to `<id>.pending`. The same-filesystem
move can avoid duplication. A copy uses bounded streaming and file sync.
Then the pending file is renamed to `<id>.audio`. A failed pending copy
or target rename attempts pending cleanup. The metadata write is next.
It must read back the exact serialized encrypted slot before replacing
the legacy sidecar with `{"encrypted":1}`. A failure can leave audio
with missing or unconfirmed metadata. No `saved` answer is owed until
both stages report success. The port reports whether this attempt's
bytes are installed and whether the exact encrypted row and marker
were confirmed. That readback is live process evidence.

An existing audio file with a readable row may update its transcript
only for the same owner and only while the row is live. A retained
row keeps its original duration and creation time. A file with no row
may be replaced when the caller can still supply a stopped source.
An ID without audio and with retained deletion receipts cannot be
reattached. The port supplies the exact metadata trust and byte states.

```quint
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
pure def retentionResult(plan: RetainPlan, bytesInstalled: bool, exactEncryptedReadback: bool, markerConfirmed: bool): RetainResult =
  if (plan == RetainRefused) RetentionRefused
  else if (bytesInstalled and exactEncryptedReadback and markerConfirmed) RetentionSaved else RetentionUnknown
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
pure def lawSavedRetentionHasBothParts(plan: RetainPlan, bytesInstalled: bool, exactEncryptedReadback: bool, markerConfirmed: bool): bool =
  retentionResult(plan, bytesInstalled, exactEncryptedReadback, markerConfirmed) == RetentionSaved implies
    bytesInstalled and exactEncryptedReadback and markerConfirmed
pure def lawSurrogateAtCutIsNotKept(transcriptUnits: int): bool =
  transcriptUnits > 150000 implies longTranscriptUnits(transcriptUnits, true) == 149999
```

### A legacy sidecar is replaced only after its equal encrypted copy is verified

A legacy `.json` sidecar or backup is read with a 512 KiB bound. JSON
with no `encrypted` member is legacy data. The store compares its exact
serialized JSON to an existing encrypted copy. A difference raises an
error and keeps both. Matching or missing encrypted data can be migrated
by writing it and verifying exact readback before switching the sidecar
to the marker. Marker or absent sidecar requires an encrypted row. A
failed or unreadable pass retains evidence for recovery. Startup checks
interruption between records and may report needs-recovery or stopped.
Plaintext audio itself is a private file. This contract does not equate
private app file storage with the separately encrypted metadata.

For old trash, the native audio restore limit is 60 days after deletion
in Alpha's two recording profiles. The limit is strict for automatic
legacy erase. After that period the migration pass can erase audio.
Rows with prior operation receipts keep them and clear the transcript.
A row without receipts can erase metadata after bytes are absent. The
separate Alpha Notes Trash backstop becomes due at 30 days, with live
notes, pending operations and exact native receipts deciding when the
note row can retire. That separate store is owned by Notes Trash.

```quint
type Sidecar = MissingSidecar | RawSidecar | MarkerSidecar | BrokenSidecar
type MetadataPlan = RejectMetadata | UseEncrypted | VerifyMigration
type LegacyCleanup = KeepLegacy | EraseLegacyWithReceipts | EraseLegacyWithoutReceipts
pure def metadataPlan(sidecar: Sidecar, hasEncrypted: bool, encryptedReadable: bool, copiesEqual: bool): MetadataPlan =
  if (sidecar == BrokenSidecar or not(encryptedReadable)) RejectMetadata
  else if (sidecar == RawSidecar) {
    if (hasEncrypted and not(copiesEqual)) RejectMetadata else VerifyMigration
  } else if (hasEncrypted) UseEncrypted else RejectMetadata
pure def mayMarkMigrated(plan: MetadataPlan, exactEncryptedReadback: bool): bool = plan == VerifyMigration and exactEncryptedReadback
pure def lawMigrationMarkerNeedsExactReadback(plan: MetadataPlan): bool = not(mayMarkMigrated(plan, false))
pure def legacyCleanup(deletedAt: int, wall: int, hasReceipts: bool): LegacyCleanup =
  if (deletedAt <= 0 or wall - deletedAt <= 5184000000) KeepLegacy
  else if (hasReceipts) EraseLegacyWithReceipts else EraseLegacyWithoutReceipts
pure def lawLegacyConflictLeavesBothCopies(hasEncrypted: bool, encryptedReadable: bool): bool =
  hasEncrypted implies metadataPlan(RawSidecar, hasEncrypted, encryptedReadable, false) == RejectMetadata
pure def lawLegacyDeadlineIsInclusive(deletedAt: int, hasReceipts: bool): bool =
  legacyCleanup(deletedAt, deletedAt + 5184000000, hasReceipts) == KeepLegacy
```

## Story: Change only the exact reviewed recording and retain its operation receipt

### One current operation controls trash and an erased ID remains retired

A native change checks stored note ownership, the exact audio ID and a
lowercase UUID-shaped operation. The store keeps at most 128 receipts
and never evicts an earlier operation to gain capacity. Moving to
trash commits the active operation and `removed` receipt together and
makes the file unplayable. Repeating the same request returns its existing
receipt. A foreign operation may not restore a trashed recording. The
old format without an active deletion or any receipts permits an
initial restore. Restoring requires the audio file and the 60-day
inclusive restore deadline. Once restored, the old operation returns
`restored`, even after another delete, without modifying the later row.
Purging requires the matching `removed` receipt and active operation.
It erases bytes first, then commits `purged` and clears the transcript.
If byte deletion fails, no `purged` status is published. If metadata
settlement fails after audio erasure, an unconfirmed outcome may have
no bytes. Exact retry can confirm the same operation after readback.
Already-purged retry returns its retained receipt. The native wrapper
stops playback of that ID before an admitted changing effect.

The machine follows a recording with validated metadata and bytes and
retains per-operation receipts. Production operation IDs are decoded by
the port and represented by synthetic integers. A failed encrypted
commit is opaque to the caller. This model selects the old-row branch
of an unconfirmed write until a subsequent exact observation. The slot
and readback contract owns how to obtain that observation; completion
without a confirmed marker does not imply disk rollback.

```quint
type AudioReceipt = RemovedAudio | RestoredAudio | PurgedAudio | UnknownAudio
pure val removedReceipt: AudioReceipt = RemovedAudio
pure val restoredReceipt: AudioReceipt = RestoredAudio
pure val purgedReceipt: AudioReceipt = PurgedAudio
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
  else { ...s, activeOp: operation, deletedAt: s.wall, receiptCount: countWith(s, operation), receipts: s.receipts.put(operation, removedReceipt) }
pure def canRestoreAudio(s: AudioCustody, noteOwner: int, operation: int): bool =
  noteOwner == s.owner and operation > 0 and (priorReceipt(s, operation) == RestoredAudio or
    (priorReceipt(s, operation) != PurgedAudio and s.hasAudio and roomFor(s, operation) and
      (s.deletedAt == 0 or ((s.activeOp == operation or (s.activeOp == 0 and s.receiptCount == 0)) and s.wall - s.deletedAt <= 5184000000))))
pure def restoreAudio(s: AudioCustody, noteOwner: int, operation: int, metadataConfirmed: bool): AudioCustody =
  if (not(metadataConfirmed) or priorReceipt(s, operation) == RestoredAudio) s
  else { ...s, activeOp: 0, deletedAt: 0, receiptCount: countWith(s, operation), receipts: s.receipts.put(operation, restoredReceipt) }
pure def canPurgeAudio(s: AudioCustody, noteOwner: int, operation: int): bool =
  noteOwner == s.owner and operation > 0 and (priorReceipt(s, operation) == PurgedAudio or
    (priorReceipt(s, operation) == RemovedAudio and s.deletedAt > 0 and s.activeOp == operation))
pure def purgeAudio(s: AudioCustody, noteOwner: int, operation: int, bytesGone: bool, metadataConfirmed: bool): AudioCustody =
  if (priorReceipt(s, operation) == PurgedAudio or (s.hasAudio and not(bytesGone))) s
  else if (metadataConfirmed) { ...s, hasAudio: false, transcript: false, receipts: s.receipts.put(operation, purgedReceipt) }
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

### A private temporary clip and the exact recording identity fence every use

`RecordingWindow.open` admits the selected recording ID, `noteId`, exact
stored duration and a nonnegative 25,000 ms aligned offset strictly below
that duration. Duration is a positive safe integer. The stored row must
name both IDs, have matching duration, and have no `deletedAt` key. The
live audio file must exist. The decoder accepts one AAC track of 16 kHz
mono and reads only the selected range, from the offset up to at most
25 seconds later. Samples must fit the bounded 256 KiB buffer. During
sample iteration the port checks cancellation and its 20-second elapsed
budget. A sample omission raises error, except that an offset at or past
reported encoded end may produce a distinct empty window. That empty
case is checked again by the caller before publishing silence.

The temporary `.m4a` file stays native, with best-effort deletion on
failure and on close. Nonempty windows recheck the recording after
extraction. Alpha rechecks before every Cloud upload (including one
allowed warming replay), before direct STT, and again before returning
provider text. Provider ownership and cancellation also apply. Empty
windows never enter transport. The model uses port evidence for media
container parsing, exact file and recording identities, cleanup and
transport; no user path or raw audio crosses this model.

```quint
type WindowInput = { validIds: bool, exactAudio: bool, exactNote: bool, duration: int, recordedDuration: int,
  offset: int, deletedKeyPresent: bool, liveFilePresent: bool }
type Extraction = ExtractedClip | BeyondEncodedEnd | ExtractionFailed
type WindowResult = WindowUnavailable | WindowHasAudio | WindowIsEmpty
type WindowFile = NoWindowFile | CallerOwnsWindow | CleanupPending | CleanupUnconfirmed
pure def windowAllowed(window: WindowInput): bool =
  window.validIds and window.exactAudio and window.exactNote and window.duration == window.recordedDuration and
    window.duration > 0 and window.duration <= 9007199254740991 and window.offset >= 0 and window.offset < window.duration and
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
