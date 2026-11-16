# Native speech request and stream

One native speech request speaks one reply through the selected native or
paired endpoint: it captures the endpoint binding and the caller's abort
signal, and streams the rendered audio from the host under one fixed
request ID and immutable rendering input across retries. The caller's
cache, capacity retries, progressive playback and local fallback belong to
[segment playback](./segmentPlayback.md) and [local speech](./localSpeech.md).

## Story: Retry streaming speech without skipping or duplicating audio

> As a person listening to a long reply, I want a dropped connection to
> resume exactly where the audio left off.

### One request retains its original cursor across failed transport calls

Opening and pulling are single-flight. The native host returns batches,
each with its requested cursor and contiguous audio frames, kept apart
from the frames already delivered to the caller. A transport failure
leaves the cursor and stream binding unchanged. An invalid successful
payload stops the stream for good and requests cancellation. A stream
holds at most 2,048 frames, 8,388,608 audio bytes and 50,000 characters,
and an observation of monotonic time at or beyond its 600,000 ms lifetime
stops it, even while a response is outstanding.

```quint
type StreamPhase = Unopened | OpeningStream | OpenStream | PullingStream | CompletedStream | StoppedStream
type StartReceipt = { streamId: int, decoded: bool }
type BatchReceipt = { boundStream: int, atCursor: int, frames: int, bytes: int, characters: int, decoded: bool, done: bool }
type SpeechPhase = BeforeSpeech | Working | Succeeded | SpeechRejected | SpeechFailed
type RequestAuthority = { phase: SpeechPhase, bindingLive: bool, callerAborted: bool, ownedAborted: bool, watched: bool, cancellations: int }
type SpeechStream = { elapsedMs: int, phase: StreamPhase, streamId: int, cursor: int, audioBytes: int, characters: int, buffered: int, endBuffered: bool, authority: RequestAuthority }
pure val initial: SpeechStream = {
  elapsedMs: 0, phase: Unopened, streamId: 0, cursor: 0, audioBytes: 0, characters: 0, buffered: 0, endBuffered: false,
  authority: { phase: BeforeSpeech, bindingLive: true, callerAborted: false, ownedAborted: false, watched: false, cancellations: 0 }
}
pure def canObserveStreamTime(s: SpeechStream, elapsedMs: int): bool = elapsedMs >= s.elapsedMs
pure def observeStreamTime(s: SpeechStream, elapsedMs: int): SpeechStream = {
  ...s, elapsedMs: elapsedMs, phase: if (elapsedMs >= 600000) StoppedStream else s.phase
}
pure val elapsedMsValues = Set(0, 599999, 600000, 600001)
pure def canRequestOpen(s: SpeechStream): bool = s.phase == Unopened
pure def requestOpen(s: SpeechStream): SpeechStream = { ...s, phase: OpeningStream }
pure def canAcceptOpen(s: SpeechStream): bool = s.phase == OpeningStream
pure def acceptOpen(s: SpeechStream, receipt: StartReceipt): SpeechStream =
  if (receipt.decoded and receipt.streamId > 0) { ...s, phase: OpenStream, streamId: receipt.streamId }
  else { ...s, phase: StoppedStream }
pure val receiptValues = Set({streamId: 1, decoded: true}, {streamId: 0, decoded: false})
pure def canRequestPull(s: SpeechStream): bool = s.phase == OpenStream and s.buffered == 0 and not(s.endBuffered)
pure def requestPull(s: SpeechStream): SpeechStream = { ...s, phase: PullingStream }
pure def canTransportFailed(s: SpeechStream): bool = s.phase == OpeningStream or s.phase == PullingStream
pure def transportFailed(s: SpeechStream): SpeechStream =
  { ...s, phase: if (s.phase == OpeningStream) Unopened else OpenStream }
pure def validBatch(s: SpeechStream, batch: BatchReceipt): bool =
  batch.decoded and batch.boundStream == s.streamId and batch.atCursor == s.cursor and
  batch.frames >= 0 and batch.bytes >= 0 and batch.characters >= 0 and
  (batch.frames > 0 or batch.done) and (batch.frames > 0 or (batch.bytes == 0 and batch.characters == 0)) and
  s.cursor + batch.frames <= 2048 and s.audioBytes + batch.bytes <= 8388608 and
  s.characters + batch.characters <= 50000 and (not(batch.done) or s.audioBytes + batch.bytes > 0)
pure def canAcceptPull(s: SpeechStream): bool = s.phase == PullingStream
pure def acceptPull(s: SpeechStream, batch: BatchReceipt): SpeechStream =
  if (validBatch(s, batch)) {
    ...s, phase: OpenStream, cursor: s.cursor + batch.frames, audioBytes: s.audioBytes + batch.bytes,
    characters: s.characters + batch.characters, buffered: batch.frames, endBuffered: batch.done
  } else { ...s, phase: StoppedStream }
pure val batchValues = Set(
  {boundStream: 1, atCursor: 0, frames: 1, bytes: 10, characters: 2, decoded: true, done: false},
  {boundStream: 1, atCursor: 1, frames: 1, bytes: 10, characters: 2, decoded: true, done: false},
  {boundStream: 1, atCursor: 1, frames: 0, bytes: 0, characters: 0, decoded: true, done: true},
  {boundStream: 1, atCursor: 0, frames: 2, bytes: 20, characters: 4, decoded: true, done: true},
  {boundStream: 1, atCursor: 0, frames: 1, bytes: 8388609, characters: 2, decoded: true, done: false},
  {boundStream: 2, atCursor: 0, frames: 0, bytes: 0, characters: 0, decoded: false, done: false}
)
pure def alwaysBoundedStream(s: SpeechStream): bool =
  s.elapsedMs >= 0 and s.cursor >= 0 and s.cursor <= 2048 and s.audioBytes >= 0 and s.audioBytes <= 8388608 and
  s.characters >= 0 and s.characters <= 50000 and s.buffered >= 0 and s.buffered <= s.cursor
pure def alwaysOpenOwnsHostStream(s: SpeechStream): bool =
  s.phase == OpenStream or s.phase == PullingStream or s.phase == CompletedStream implies s.streamId > 0
pure def stepTransportFailureRetainsCursor(before: SpeechStream, via: str, after: SpeechStream): bool =
  via == "transportFailed" implies before.cursor == after.cursor and before.streamId == after.streamId
pure def sometimesBatchIsBuffered(s: SpeechStream): bool = s.buffered > 1
```

### End delivery requires validated nonempty audio and follows all buffered frames

A batch is accepted only when its decoder vouches for the wire format:
the exact frame sequence, MPEG audio, and a completion frame that comes
last and declares the exact frame and byte totals. Completion needs
nonempty audio, and the end is delivered only after every buffered frame.

```quint
pure def canDeliverAudio(s: SpeechStream): bool = s.phase == OpenStream and s.buffered > 0
pure def deliverAudio(s: SpeechStream): SpeechStream = { ...s, buffered: s.buffered - 1 }
pure def canDeliverEnd(s: SpeechStream): bool = s.phase == OpenStream and s.buffered == 0 and s.endBuffered
pure def deliverEnd(s: SpeechStream): SpeechStream = { ...s, phase: CompletedStream, endBuffered: false }
pure def canCancelStream(s: SpeechStream): bool = s.phase != StoppedStream
pure def cancelStream(s: SpeechStream): SpeechStream = { ...s, phase: StoppedStream }
pure def alwaysEndHasAudio(s: SpeechStream): bool =
  s.endBuffered or s.phase == CompletedStream implies s.audioBytes > 0
pure def alwaysCompletedHasNoBufferedFrames(s: SpeechStream): bool =
  s.phase == CompletedStream implies s.buffered == 0 and not(s.endBuffered)
pure def stepStoppedCannotPublish(before: SpeechStream, after: SpeechStream): bool =
  before.phase == StoppedStream implies after.phase == StoppedStream
pure def sometimesSpeechStreamCompleted(s: SpeechStream): bool = s.phase == CompletedStream
pure def sometimesInvalidBatchStopsDelivery(s: SpeechStream): bool = s.phase == StoppedStream and s.streamId > 0
```

## Story: Expire a stream without adopting a late response

> As a person, I want a stream that ran out of time to stay stopped, even
> if a late answer arrives, so that a stale reply is never spoken.

### A deadline observation irrevocably closes the request

A stream fixes its expiry when it is created and observes the clock on
entering open or pull and on every native reply. At the deadline it stops
and asks the host to cancel by the original request ID, even before the
host has returned a stream ID. Later replies never reopen it.

```quint
pure def alwaysExpiredStreamStops(s: SpeechStream): bool =
  s.elapsedMs >= 600000 implies s.phase == StoppedStream
pure def sometimesExpiredOpening(s: SpeechStream): bool =
  s.phase == StoppedStream and s.elapsedMs >= 600000 and s.streamId == 0
```

## Story: Speak using the selected native or paired endpoint

> As a person switching between the device's own voice and a paired one,
> I want a reply spoken only by the endpoint still selected, and a
> cancelled reply never spoken late.

### The captured binding and caller signal control publication and cancellation

The request captures the endpoint binding and the caller's signal when it
starts. While its work is in flight it owns a cancellation signal and
aborts it exactly once when the binding changes or the caller aborts; a
stale or aborted request rejects when its work settles. The request stops
watching at settlement, so a late notification never cancels a completed
request. The work is expected to honor the owned signal.

```quint
pure def canBeginSpeech(s: SpeechStream): bool = s.authority.phase == BeforeSpeech
pure def beginSpeech(s: SpeechStream): SpeechStream =
  if (s.authority.bindingLive and not(s.authority.callerAborted)) { ...s, authority: { ...s.authority, phase: Working, watched: true } }
  else { ...s, authority: { ...s.authority, phase: SpeechRejected } }
pure def ownedSignalAborted(a: RequestAuthority): bool = a.ownedAborted or a.watched
pure def cancellationCount(a: RequestAuthority): int =
  a.cancellations + (if (a.watched and not(a.ownedAborted)) 1 else 0)
pure def invalidateBinding(s: SpeechStream): SpeechStream =
  { ...s, authority: { ...s.authority, bindingLive: false, ownedAborted: ownedSignalAborted(s.authority), cancellations: cancellationCount(s.authority) } }
pure def abortCaller(s: SpeechStream): SpeechStream =
  { ...s, authority: { ...s.authority, callerAborted: true, ownedAborted: ownedSignalAborted(s.authority), cancellations: cancellationCount(s.authority) } }
pure def canFinishWork(s: SpeechStream): bool = s.authority.phase == Working
pure def finishWork(s: SpeechStream, workSucceeded: bool): SpeechStream = {
  val a = s.authority
  { ...s, authority: { ...a, watched: false,
    phase: if (not(a.bindingLive) or a.callerAborted or a.ownedAborted) SpeechRejected else if (workSucceeded) Succeeded else SpeechFailed } }
}
pure def alwaysCancellationAtMostOnce(s: SpeechStream): bool =
  s.authority.cancellations == (if (s.authority.ownedAborted) 1 else 0)
pure def alwaysOnlyPendingObserves(s: SpeechStream): bool = s.authority.watched == (s.authority.phase == Working)
pure def stepPublishNeedsLiveBinding(before: SpeechStream, via: str, after: SpeechStream): bool =
  via == "finishWork" and after.authority.phase == Succeeded implies
    before.authority.bindingLive and not(before.authority.callerAborted) and not(before.authority.ownedAborted)
pure def stepInvalidationIsPermanent(before: SpeechStream, after: SpeechStream): bool =
  not(before.authority.bindingLive) implies not(after.authority.bindingLive)
pure def sometimesSpeechPublished(s: SpeechStream): bool = s.authority.phase == Succeeded
pure def sometimesWorkCancelled(s: SpeechStream): bool = s.authority.phase == SpeechRejected and s.authority.cancellations == 1
```
