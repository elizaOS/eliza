# AlphaPhone browser video copy

Alpha `8d44dfe52` uses `saveVideoCopy` in
`apps/app/src/prototype/browser-camera.ts` when Photos has no native video
editor. Its producers are `apps/app/src/browser/video-edit.ts`,
`video-transcode.ts`, `video-codecs.ts` and `edit-receipt.ts`.
[Media copy intent](./mediaCopyIntent.md) owns the renderer's pending
request and acknowledgement. [Android video copy](../mobileVideoCopy.md)
owns native editing. This model owns the browser encoder decision,
protected copy publication and operation outcome in browser Photos.

## Story: Save one playable edited copy and recover its outcome without recoding

### A local supported video owns one reviewed trim and transform

Start and end are finite. Duration is positive and at most 300 seconds.
Start is nonnegative and end may be up to 50 milliseconds beyond reported
duration. The range is at least 100 milliseconds, allowing floating-point
roundoff of `Number.EPSILON * max(1, duration)`. Rotation is 0, 90, 180 or
270 degrees, and crop is boolean. The encoded source is at most
140,000,000 string units and has a local WebM or MP4 base64 data URL.
Legacy octet-stream data can be retagged in memory when its leading
bytes match EBML or its offset-four box type is `ftyp`. Original bytes
and storage metadata stay intact. Decoded width and height must be
positive and their product at most 32 million pixels.

The canvas uses a centered crop by factor 1.3 when selected and swaps
axes for quarter turns. Canvas axes round to even numbers, stay at least
two and at most 1,920. The integer model expresses exact millisecond
limits. The host validates finite IEEE 754 inputs including the tiny
roundoff allowance.

```quint
type LocalSource = LocalWebm | LocalMp4 | LegacyWebm | LegacyMp4 | UnsupportedSource
type VideoRange = { startMs: int, endMs: int, durationMs: int, rotation: int, cropBoolean: bool }
pure val cutValues = Set(
  { startMs: 0, endMs: 100, durationMs: 300000, rotation: 90, cropBoolean: true },
  { startMs: 0, endMs: 99, durationMs: 1000, rotation: 0, cropBoolean: true },
  { startMs: 900, endMs: 1050, durationMs: 1000, rotation: 270, cropBoolean: true },
  { startMs: 900, endMs: 1051, durationMs: 1000, rotation: 0, cropBoolean: true },
  { startMs: 0, endMs: 200, durationMs: 301000, rotation: 0, cropBoolean: true }
)
pure val encodedUnitsValues = Set(0, 1, 140000000, 140000001)
pure def validVideoRange(cut: VideoRange): bool =
  cut.durationMs > 0 and cut.durationMs <= 300000 and cut.startMs >= 0 and cut.endMs <= cut.durationMs + 50 and
  cut.endMs - cut.startMs >= 100 and cut.cropBoolean and
  (cut.rotation == 0 or cut.rotation == 90 or cut.rotation == 180 or cut.rotation == 270)
pure def localVideoAllowed(source: LocalSource, encodedUnits: int): bool =
  source != UnsupportedSource and encodedUnits >= 0 and encodedUnits <= 140000000
pure def videoDimensionsAllowed(width: int, height: int): bool =
  width > 0 and height > 0 and width * height <= 32000000
pure def lawReviewRangeHasPositiveDuration(cut: VideoRange): bool =
  validVideoRange(cut) implies cut.endMs > cut.startMs and cut.endMs <= cut.durationMs + 50
pure def lawOversizeSourceIsRefused(source: LocalSource, encodedUnits: int): bool =
  encodedUnits > 140000000 implies not(localVideoAllowed(source, encodedUnits))
```

### Timestamp conversion falls back only when a suitable conversion is unavailable

The media element loads and seeks with a cancellable 15-second wait for
each event. Timestamp conversion requires both audio and both video
WebCodecs constructors. It trims timestamps and force-transcodes to
WebM VP8 and Opus. It keeps all tracks. Missing constructors or an
invalid conversion or a reported discarded track asks the same save
to use MediaRecorder. A thrown failure, size breach, timeout or abort
on the timestamp path terminates the save. The conversion races abort
and a deadline of the larger of 30 seconds or the clip length plus
15 seconds. A conversion that initializes after retirement cancels
itself and cannot publish. Terminal cleanup disposes input, removes
listeners and cancels an unfinalized output. Output must be nonempty
and at most 100 MiB.

The fallback captures the transformed canvas at 30 frames per second
and connects the source media element through an AudioContext. Its
startup waits up to 15 seconds. Candidate MIME order is VP9/Opus WebM,
VP8/Opus WebM, MP4, generic WebM and the browser default. Unsupported,
constructor-failed and start-failed candidates can advance to the next
choice. Recording samples chunks at 200 ms, refreshes transformed
frames at 20 ms, and ends at the trim endpoint or earlier source end.
A recorder or decoder error, abort, empty output or exceeding 100 MiB
fails. Deadline is clip length plus 15 seconds. Every terminal path
retires its recorder, timers, tracks, audio and video resources. The
copy reports requested duration for timestamp conversion and the
clamped observed endpoint for real-time encoding.

```quint
type TimestampOutcome = CodecUnavailable | ConversionUnsuitable | TimestampEncoded | TimestampFailed
type EncodingChoice = UseRecorder | UseTimestamp | StopEncoding
pure def selectEncoder(timestampResult: TimestampOutcome): EncodingChoice =
  if (timestampResult == CodecUnavailable or timestampResult == ConversionUnsuitable) UseRecorder
  else if (timestampResult == TimestampEncoded) UseTimestamp else StopEncoding
pure def usableCopyBytes(outputBytes: int): bool = outputBytes > 0 and outputBytes <= 104857600
pure val outputBytesValues = Set(0, 1, 104857600, 104857601)
pure def fallbackDuration(startMs: int, endMs: int, positionKnown: bool, positionMs: int): int = {
  val stop = if (not(positionKnown) or positionMs >= endMs) endMs else if (positionMs <= startMs) startMs else positionMs
  if (stop > startMs) stop - startMs else 1
}
pure def lawEncoderFailureCannotFallBack(timestampResult: TimestampOutcome): bool =
  timestampResult == TimestampFailed implies selectEncoder(timestampResult) == StopEncoding
pure def lawOutputCannotExceedLimit(outputBytes: int): bool = outputBytes > 104857600 implies not(usableCopyBytes(outputBytes))
pure def lawFallbackDurationIsBounded(startMs: int, endMs: int, positionKnown: bool, positionMs: int): bool =
  startMs < endMs implies fallbackDuration(startMs, endMs, positionKnown, positionMs) >= 1 and
    fallbackDuration(startMs, endMs, positionKnown, positionMs) <= endMs - startMs
```

### Copy bytes and the saved receipt commit together after the source is checked again

The operation key is `edit:` followed by a 36-character lowercase hex
or hyphen token. A transaction stores `saving` with the exact source
identity, mutation revision, and serialized edit tuple before encoding.
A same-token request with another source or edit is refused. A duplicate
while saving is in progress is refused. An identical settled request
may read the stored outcome without rendering again. The API first
reads and validates the source video and trim, even for a replay.

The commit transaction checks the operation is still saving and the
original row exists, is untrashed and retains the same mutation
revision. It also checks cancellation before adding any copy. The copy
row, its separated bytes and its saved receipt commit atomically in
`alpha.browser.photos.v1`. A successful copy has its own identity,
record revisions and date, begins untrashed and is not a favorite.
Only transaction completion delivers a saved answer. Staleness,
cancellation or a definite encoding or commit failure cannot publish
copy bytes. Failure cleanup can record `failed` while the operation
is still saving. A failed cleanup leaves the claim recoverable as a stored saving receipt.

The model represents one call-observed operation token. Source and
parameters are equality classes. A durable copy remains even if the
receipt is later forgotten. A caller uses a fresh token after
acknowledgement and receipt retirement.

```quint
type BrowserCopyPhase = EmptyReceipt | EncodingCopy | RecorderCopy | EncodedCopy | FailedPending | SavedCopy | FailedCopy | RetiredCopy
type BrowserCopy = { phase: BrowserCopyPhase, sourceIdentity: int, mutationRevision: int, parameterIdentity: int, copyExists: bool }
pure val initial: BrowserCopy =
  { phase: EmptyReceipt, sourceIdentity: 0, mutationRevision: 0, parameterIdentity: 0, copyExists: false }
pure def isSaving(s: BrowserCopy): bool = s.phase == EncodingCopy or s.phase == RecorderCopy or s.phase == EncodedCopy or s.phase == FailedPending
pure def canClaimBrowserCopy(s: BrowserCopy, sourceIdentity: int, mutationRevision: int, parameterIdentity: int, admitted: bool): bool =
  s.phase == EmptyReceipt and not(s.copyExists) and admitted and sourceIdentity > 0 and mutationRevision > 0 and parameterIdentity > 0
pure def claimBrowserCopy(s: BrowserCopy, sourceIdentity: int, mutationRevision: int, parameterIdentity: int, admitted: bool): BrowserCopy =
  { ...s, phase: EncodingCopy, sourceIdentity: sourceIdentity, mutationRevision: mutationRevision, parameterIdentity: parameterIdentity }
pure def canSettleTimestamp(s: BrowserCopy): bool = s.phase == EncodingCopy
pure def settleTimestamp(s: BrowserCopy, timestampResult: TimestampOutcome, outputBytes: int): BrowserCopy =
  { ...s, phase: if (selectEncoder(timestampResult) == UseRecorder) RecorderCopy
    else if (selectEncoder(timestampResult) == UseTimestamp and usableCopyBytes(outputBytes)) EncodedCopy else FailedPending }
pure def canSettleRecorder(s: BrowserCopy): bool = s.phase == RecorderCopy
pure def settleRecorder(s: BrowserCopy, accepted: bool, outputBytes: int): BrowserCopy =
  { ...s, phase: if (accepted and usableCopyBytes(outputBytes)) EncodedCopy else FailedPending }
pure def mayCommitVideo(sourceUnchanged: bool, aborted: bool, committed: bool): bool =
  sourceUnchanged and not(aborted) and committed
pure def canCommitBrowserCopy(s: BrowserCopy): bool = s.phase == EncodedCopy
pure def commitBrowserCopy(s: BrowserCopy, sourceUnchanged: bool, aborted: bool, committed: bool): BrowserCopy =
  if (mayCommitVideo(sourceUnchanged, aborted, committed)) { ...s, phase: SavedCopy, copyExists: true }
  else { ...s, phase: if (committed) FailedCopy else FailedPending }
pure def canRecordFailure(s: BrowserCopy): bool = s.phase == FailedPending
pure def recordFailure(s: BrowserCopy, committed: bool): BrowserCopy =
  if (committed) { ...s, phase: FailedCopy } else s
pure def replayStoredCopy(s: BrowserCopy, sourceIdentity: int, mutationRevision: int, parameterIdentity: int, admitted: bool): bool =
  admitted and s.phase != EmptyReceipt and not(isSaving(s)) and s.sourceIdentity == sourceIdentity and
  s.mutationRevision == mutationRevision and s.parameterIdentity == parameterIdentity
pure def alwaysReceiptHasSource(s: BrowserCopy): bool =
  s.phase != EmptyReceipt implies s.sourceIdentity > 0 and s.mutationRevision > 0 and s.parameterIdentity > 0
pure def alwaysReceiptAndCopyAgree(s: BrowserCopy): bool =
  (s.phase == SavedCopy implies s.copyExists) and (s.copyExists implies s.phase == SavedCopy or s.phase == EmptyReceipt)
pure def stepOnlyCommitAddsCopy(before: BrowserCopy, via: str, after: BrowserCopy): bool =
  not(before.copyExists) and after.copyExists implies via == "commitBrowserCopy"
pure def lawSourceChangeCannotCommit(aborted: bool, committed: bool): bool = not(mayCommitVideo(false, aborted, committed))
pure def sometimesSavedVideo(s: BrowserCopy): bool = s.phase == SavedCopy
pure def sometimesRecorderVideo(s: BrowserCopy): bool = s.phase == RecorderCopy
pure def sometimesFailedWithoutReceipt(s: BrowserCopy): bool = s.phase == FailedPending
pure val weight_claimBrowserCopy = 3
pure val weight_settleTimestamp = 3
pure val weight_settleRecorder = 3
pure val weight_commitBrowserCopy = 3
```

### An outcome read retires unfinished work and acknowledged outcomes may be forgotten

An outcome read returns not-started when no receipt exists. Reading an
unfinished operation marks it cancelled transactionally and then
returns not-started. A renderer suspended in encoding can no longer
commit that copy. A saved receipt returns the exact copy ID. A failed
one returns failed. Cancellation does not delete a copy. Forgetting
the exact settled receipt leaves its media row and bytes. The
one-day sweep applies only to legacy unclaimed prepared receipts,
never to browser video saves, which begin in saving directly.

```quint
pure def canRetireByOutcomeRead(s: BrowserCopy): bool = isSaving(s)
pure def retireByOutcomeRead(s: BrowserCopy): BrowserCopy = { ...s, phase: RetiredCopy }
pure def canForgetBrowserReceipt(s: BrowserCopy): bool =
  s.phase == SavedCopy or s.phase == FailedCopy or s.phase == RetiredCopy
pure def forgetBrowserReceipt(s: BrowserCopy): BrowserCopy = { ...initial, copyExists: s.copyExists }
pure def stepOutcomeReadDoesNotPublish(before: BrowserCopy, via: str, after: BrowserCopy): bool =
  via == "retireByOutcomeRead" implies not(after.copyExists) and not(isSaving(after))
pure def stepForgetKeepsCopy(before: BrowserCopy, via: str, after: BrowserCopy): bool =
  via == "forgetBrowserReceipt" implies after.copyExists == before.copyExists
pure def sometimesInterruptedSave(s: BrowserCopy): bool = s.phase == RetiredCopy
```

Pinned `test/browser/video-edit.spec.ts` and
`test/browser/video-timestamp-boundaries.spec.ts` exercise original
bytes, audio preservation, trim timestamps, recorder fallback,
cancellation cleanup, duplicate receipts, rollback and reload recovery
using actual Chromium codecs and IndexedDB with synthetic media.
