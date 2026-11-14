# AlphaPhone Android video copy

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses
`beginVideoEdit`, `saveVideoEdit`, `cancelVideoEdit` and
`editResult` through `AlphaPhotosPlugin`. The producer is Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`,
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media`
under `PhotosPlugin.java`, `VideoCopyEdits.java` and
`VideoEditSpec.java`. [Photos access](./mobilePhotos.md) owns grants
and source read tickets. The [renderer copy intent](./alpha/mediaCopyIntent.md)
owns acknowledgement and whether a result can change the visible Photos view.

## Story: Save a playable edited video as a copy of the item I reviewed

### Opening and editing are bound to the exact permitted source and selected interval

Begin admits one active editor on the current activity epoch. Reconcile
unsettled records before opening another source. Require at least four
input limits of cache space. At 128 or more journal records, remove
the oldest terminal record after terminal cache cleanup and custody
checks. An unresolved recorded pending output can block a new Begin.

The source must have an eligible URI and revision, positive size through
100 MiB, and be neither pending nor trashed. Capture the MediaStore
size, modified date, pending state, and on Android 11 or later the
generation and trash state. Store a fresh canonical `video-<uuid>`
operation and prepared receipt. Copy the exact number of bytes to a
private synced input and retain its SHA-256. Read duration, displayed
size and audio presence. Recheck the source URI, revision, metadata
and digest before returning the editor and before admitting Save.
A permission or lifecycle change can retire the editor while opening.
Recheck the active epoch before publication.

A video lasts at most five minutes and covers at most 32 million
displayed pixels. The codec checks finite seconds, start at or after
zero, an end at most 50 ms past duration and an interval of at least
100 ms subject to the producer's floating-point tolerance. Round to
milliseconds, snap within 50 ms of duration to duration, and verify
the resulting interval again. Rotate clockwise by 0, 90, 180 or 270.
Optionally apply a centered 1.3× crop. Scale the larger output axis
to at most 1,920 pixels without upscaling, round each axis to an
even integer and floor it at two. The durable edit binding includes
the normalized interval, rotation, crop flag and output dimensions.
An exact bound retry reads the existing result. A different edit
under that token refuses. Full range, zero rotation and no crop
settle unchanged without encoding.

```quint
type VideoSourceFacts = { bytes: int, durationMs: int, width: int, height: int, exactSource: bool, available: bool }
type VideoEditFacts = { startMs: int, endMs: int, rotation: int, crop: bool, outputWidth: int, outputHeight: int, rawRangeValid: bool }
pure def nativeVideoSourceAdmitted(source: VideoSourceFacts): bool =
  source.available and source.exactSource and source.bytes > 0 and source.bytes <= 104857600 and
    source.durationMs > 0 and source.durationMs <= 300000 and source.width > 0 and source.height > 0 and
    source.width <= 32000000 and source.height <= 32000000 and source.width * source.height <= 32000000
pure def normalizedVideoEditAdmitted(edit: VideoEditFacts, durationMs: int): bool =
  edit.rawRangeValid and edit.startMs >= 0 and edit.startMs <= edit.endMs and edit.endMs <= durationMs and edit.endMs - edit.startMs >= 100 and
    Set(0,90,180,270).contains(edit.rotation) and edit.outputWidth >= 2 and edit.outputWidth <= 1920 and edit.outputWidth % 2 == 0 and
    edit.outputHeight >= 2 and edit.outputHeight <= 1920 and edit.outputHeight % 2 == 0
pure def nativeVideoEditChanges(edit: VideoEditFacts, durationMs: int): bool =
  edit.startMs != 0 or edit.endMs != durationMs or edit.rotation != 0 or edit.crop
pure def lawUnsupportedSourceCannotOpen(source: VideoSourceFacts): bool =
  (not(source.exactSource) or source.bytes > 104857600 or source.durationMs > 300000) implies not(nativeVideoSourceAdmitted(source))
pure def lawVideoCannotKeepAnOutOfRangeInterval(edit: VideoEditFacts, durationMs: int): bool =
  normalizedVideoEditAdmitted(edit,durationMs) implies edit.startMs >= 0 and edit.endMs <= durationMs and edit.endMs - edit.startMs >= 100
pure val goodVideo: VideoSourceFacts = { bytes: 512, durationMs: 4000, width: 1920, height: 1080, exactSource: true, available: true }
pure val sourceValues = Set(goodVideo, { ...goodVideo, exactSource: false }, { ...goodVideo, available: false },
  { ...goodVideo, bytes: 104857600 }, { ...goodVideo, bytes: 104857601 }, { ...goodVideo, durationMs: 300001 },
  { ...goodVideo, width: 7000, height: 5000 })
pure val goodVideoEdit: VideoEditFacts = { startMs: 100, endMs: 3800, rotation: 90, crop: true, outputWidth: 830, outputHeight: 1476, rawRangeValid: true }
pure val editValues = Set(goodVideoEdit, { ...goodVideoEdit, startMs: 0, endMs: 4000, rotation: 0, crop: false },
  { ...goodVideoEdit, endMs: 4010 }, { ...goodVideoEdit, endMs: 199 }, { ...goodVideoEdit, rawRangeValid: false },
  { ...goodVideoEdit, rotation: 45 }, { ...goodVideoEdit, outputWidth: 1919 })
pure val durationMsValues = Set(0,99,100,4000,300000,300001)
```

### A bound export reaches the library only after its bytes and source agree

A committed `exporting` receipt precedes encoder startup. Android's
Transformer clips samples, applies the edit, and encodes H.264 video
and AAC audio. Trim optimization and MP4 edit-list trim are disabled.
The guard checks every 250 ms and aborts on closure, excessive size
or elapsed time beyond the larger of 60 seconds and three times the
selected interval. The original remains read-only. Validate that the
output file is nonempty and at most 100 MiB, with expected dimensions,
the same audio presence, and duration within 150 ms of the edit.

Insert one owned pending MP4 with the operation-derived name and
configured path. Persist its exact ID before copying output bytes.
After flushing, syncing and closing, verify exact byte length and
SHA-256 against the export. Recheck the source bytes and provider
version. Atomically assert the version of the source row and update
the one owned pending destination under the live lifecycle epoch.
Read back that the destination is published. Persist a saved receipt
with the exact ID. The bridge returns the ID prefixed with `v:`.
A failed acknowledgement permits recovery by ID. Only the initial
live exporter inserts. Background and callback retirement preserve
the existing journal, and an already published copy remains committed.

```quint
type ExportPublishEvidence = { currentWriter: bool, exactSource: bool, exactPendingId: bool,
  completeOutput: bool, bytesMatch: bool, batchAuthorized: bool }
pure def permitsVideoPublication(publishFacts: ExportPublishEvidence): bool =
  publishFacts.currentWriter and publishFacts.exactSource and publishFacts.exactPendingId and
    publishFacts.completeOutput and publishFacts.bytesMatch and publishFacts.batchAuthorized
pure def lawStaleSourceCannotPublishVideo(publishFacts: ExportPublishEvidence): bool =
  not(publishFacts.currentWriter and publishFacts.exactSource) implies not(permitsVideoPublication(publishFacts))
type ClipPhase = ClipEmpty | ClipPrepared | ClipEncoding | ClipPending | ClipPublished | ClipSaved | ClipFailed | ClipNotStarted
type ClipState = { phase: ClipPhase, active: bool, bound: bool, pendingId: int, insertions: int, receiptId: int, removedPending: bool }
pure val initial: ClipState = { phase: ClipEmpty, active: false, bound: false, pendingId: 0, insertions: 0, receiptId: 0, removedPending: false }
pure def canPrepareClip(s: ClipState, source: VideoSourceFacts, historyReady: bool, preparedCommitted: bool): bool =
  s.phase == ClipEmpty and nativeVideoSourceAdmitted(source) and historyReady and preparedCommitted
pure def prepareClip(s: ClipState, source: VideoSourceFacts, historyReady: bool, preparedCommitted: bool): ClipState =
  { ...s, phase: ClipPrepared, active: true }
pure def canStartClip(s: ClipState, matchesEditor: bool, changed: bool, validBinding: bool, bindingCommitted: bool): bool =
  s.phase == ClipPrepared and s.active and matchesEditor and changed and validBinding and bindingCommitted
pure def startClip(s: ClipState, matchesEditor: bool, changed: bool, validBinding: bool, bindingCommitted: bool): ClipState =
  { ...s, phase: ClipEncoding, bound: true }
pure def canRecordPendingClip(s: ClipState, outputValid: bool, mediaId: int): bool =
  s.phase == ClipEncoding and s.active and outputValid and mediaId > 0
pure def recordPendingClip(s: ClipState, outputValid: bool, mediaId: int, idCommitted: bool): ClipState =
  { ...s, phase: ClipPending, active: idCommitted, insertions: 1, pendingId: if (idCommitted) mediaId else 0 }
pure def canPublishClip(s: ClipState, mediaId: int, publishFacts: ExportPublishEvidence, batchCommitted: bool): bool =
  s.phase == ClipPending and s.active and s.pendingId > 0 and mediaId == s.pendingId and
    permitsVideoPublication(publishFacts) and batchCommitted
pure def publishClip(s: ClipState, mediaId: int, publishFacts: ExportPublishEvidence, batchCommitted: bool): ClipState =
  { ...s, phase: ClipPublished, active: false }
pure def canRetireClip(s: ClipState): bool = s.active
pure def retireClip(s: ClipState): ClipState = { ...s, active: false }
pure def alwaysActiveVideoWriterHasCustody(s: ClipState): bool =
  s.active implies s.phase == ClipPrepared or s.phase == ClipEncoding or (s.phase == ClipPending and s.pendingId > 0)
pure def alwaysClipInsertionAtMostOnce(s: ClipState): bool =
  (s.insertions == 0 or s.insertions == 1) and
  (s.phase == ClipEmpty or s.phase == ClipPrepared or s.phase == ClipEncoding implies s.insertions == 0)
pure def stepOnlyExporterInsertsClip(before: ClipState, via: str, after: ClipState): bool =
  after.insertions != before.insertions implies via == "recordPendingClip" and before.phase == ClipEncoding and before.active and after.insertions == 1
pure def stepPublishedClipKeepsIdentity(before: ClipState, after: ClipState): bool =
  before.phase == ClipPublished implies (after.phase == ClipPublished or after.phase == ClipSaved)
pure def sometimesClipPublished(s: ClipState): bool = s.phase == ClipPublished
pure val goodPublish: ExportPublishEvidence = { currentWriter: true, exactSource: true, exactPendingId: true, completeOutput: true, bytesMatch: true, batchAuthorized: true }
pure val publishFactsValues = Set(goodPublish, { ...goodPublish, exactSource: false }, { ...goodPublish, bytesMatch: false }, { ...goodPublish, currentWriter: false })
pure val mediaIdValues = Set(1,2)
pure val weight_prepareClip = 7
pure val weight_startClip = 10
pure val weight_recordPendingClip = 12
pure val weight_publishClip = 12
```

## Story: Recover the same copy after closing or losing the save response

### Recovery reads exact custody and keeps pending evidence when the result is unresolved

An absent journal record is not-started. A live Save with this token
returns incomplete. A saved receipt returns its historical ID and
attempts cache cleanup. Otherwise query pending-inclusive MediaStore
by exact owner package and operation-derived display name. Missing
cursor or ambiguous matches refuse. An existing reserved pending ID
must match the unique result. Missing or different evidence for that
ID remains unresolved. Recover an observed published copy by committing
the same ID as saved. A pending row already recorded failed is held
for recovery review. Other pending matches can be removed only while
pending and under the exact package, and require one confirmed deletion.
Absent output can settle failed for a bound edit or not-started for a
prepared editor, after cache cleanup and receipt commit.

If deletion succeeds but the terminal receipt cannot commit, the
old durable ID can still be present when the next lookup sees an
absent row. That read remains unresolved. A recovered saved receipt
can outlive a later cache cleanup failure. Keep the confirmed deletion
separate from the old pending ID until the terminal receipt commits. It includes legacy
recovery records through the recovery classifier. The protected native
preservation port for an explicitly authorized closed failed operation
is outside ordinary Save and `editResult`.

```quint
type ClipLookup = ClipLookupError | ClipLookupAmbiguous | ClipLookupAbsent | ClipLookupPending | ClipLookupPublished
type ClipRecovery = ReturnClipNotStarted | ReturnClipIncomplete | ReturnHistoricalClip | SettlePublishedClip | RemovePendingClip | CleanAbsentClip | RetainUnresolvedClip
type ClipRecoveryFacts = { journalPresent: bool, liveSave: bool, savedReceipt: bool, failedReceipt: bool,
  recordedId: int, matchedId: int, lookup: ClipLookup }
pure def clipRecovery(facts: ClipRecoveryFacts): ClipRecovery =
  if (not(facts.journalPresent)) ReturnClipNotStarted
  else if (facts.liveSave) ReturnClipIncomplete
  else if (facts.savedReceipt) ReturnHistoricalClip
  else if (facts.lookup == ClipLookupError or facts.lookup == ClipLookupAmbiguous) RetainUnresolvedClip
  else if (facts.recordedId > 0 and (facts.lookup == ClipLookupAbsent or facts.recordedId != facts.matchedId)) RetainUnresolvedClip
  else if (facts.lookup == ClipLookupPublished and facts.matchedId > 0) SettlePublishedClip
  else if (facts.lookup == ClipLookupPending and facts.matchedId > 0 and not(facts.failedReceipt)) RemovePendingClip
  else if (facts.lookup == ClipLookupAbsent) CleanAbsentClip else RetainUnresolvedClip
pure def lawRecordedVideoCannotDisappearIntoFailure(facts: ClipRecoveryFacts): bool =
  facts.journalPresent and not(facts.liveSave or facts.savedReceipt) and facts.recordedId > 0 and facts.lookup == ClipLookupAbsent implies
    clipRecovery(facts) == RetainUnresolvedClip
pure def lawClosedFailedPendingVideoCannotBeDeleted(facts: ClipRecoveryFacts): bool =
  facts.failedReceipt implies clipRecovery(facts) != RemovePendingClip
type ClipSettlement = { lookup: ClipLookup, matchedId: int, deletedCount: int, filesCleaned: bool, receiptCommitted: bool }
pure def canRecoverClip(s: ClipState): bool =
  not(s.active) and (s.phase == ClipPrepared or s.phase == ClipEncoding or s.phase == ClipPending or s.phase == ClipPublished)
pure def recoverClip(s: ClipState, readback: ClipSettlement): ClipState = {
  val lookup = if (s.removedPending) ClipLookupAbsent else readback.lookup
  val plan = clipRecovery({ journalPresent: true, liveSave: false, savedReceipt: false,
    failedReceipt: false, recordedId: s.pendingId, matchedId: readback.matchedId, lookup: lookup })
  val removed = s.phase == ClipPending and plan == RemovePendingClip and readback.deletedCount == 1
  if (plan == SettlePublishedClip and readback.receiptCommitted)
    { ...s, phase: ClipSaved, receiptId: readback.matchedId }
  else if (s.phase != ClipPublished and readback.filesCleaned and readback.receiptCommitted and
    (plan == CleanAbsentClip or removed))
    { ...s, phase: if (s.bound) ClipFailed else ClipNotStarted, pendingId: 0, removedPending: false }
  else { ...s, removedPending: s.removedPending or removed }
}
pure def alwaysSavedClipHasMediaId(s: ClipState): bool = s.phase == ClipSaved implies s.receiptId > 0
pure def alwaysRemovedPendingClipKeepsItsRecord(s: ClipState): bool =
  s.removedPending implies s.phase == ClipPending and not(s.active)
pure def stepRemovedClipIsNeverPublished(before: ClipState, after: ClipState): bool =
  before.removedPending implies after.phase != ClipSaved and after.phase != ClipPublished
pure def sometimesClipDeletionOutlivesReceipt(s: ClipState): bool =
  s.removedPending and s.pendingId > 0
pure def sometimesClipRecovered(s: ClipState): bool = s.phase == ClipSaved
pure def sometimesClipFailsCleanly(s: ClipState): bool = s.phase == ClipFailed and s.insertions == 1
pure val matchedClip: ClipRecoveryFacts = { journalPresent: true, liveSave: false, savedReceipt: false, failedReceipt: false,
  recordedId: 1, matchedId: 1, lookup: ClipLookupPending }
pure val factsValues = Set(matchedClip, { ...matchedClip, failedReceipt: true }, { ...matchedClip, liveSave: true },
  { ...matchedClip, lookup: ClipLookupAbsent }, { ...matchedClip, lookup: ClipLookupPublished },
  { ...matchedClip, matchedId: 2 }, { ...matchedClip, lookup: ClipLookupAmbiguous }, { ...matchedClip, journalPresent: false })
pure val settledClip: ClipSettlement = { lookup: ClipLookupPending, matchedId: 1, deletedCount: 1, filesCleaned: true, receiptCommitted: true }
pure val readbackValues = Set(settledClip, { ...settledClip, lookup: ClipLookupPublished },
  { ...settledClip, lookup: ClipLookupAbsent }, { ...settledClip, lookup: ClipLookupAmbiguous },
  { ...settledClip, matchedId: 2 }, { ...settledClip, matchedId: 2, lookup: ClipLookupPublished },
  { ...settledClip, deletedCount: 0 }, { ...settledClip, receiptCommitted: false })
pure val weight_recoverClip = 10
```

Alpha's pinned `VideoCopyInstrumentedTest` exercises real encoded
video and audio, source changes during export, cancellation and worker
retirement, and missing or different pending-output custody. The
renderer fixtures exercise its persistence and view through the bridge.
Transformer, Android media permissions and the MediaStore batch remain
effect boundaries.
