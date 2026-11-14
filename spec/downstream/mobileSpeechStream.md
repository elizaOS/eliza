# Grace speech stream transport

Grace imports `createNativeSpeechStream`, `SpeechRenderingInput` and
`SpeechAudioFrame` from `@elizaos/cloud-sdk/native-speech-stream` in
`apps/app/src/stream-speech.ts`. The alias in `tsconfig.json` resolves to
Eliza's pinned `packages/cloud/sdk/src/native-speech-stream.ts`.
Its port is `(path, body) => Promise<unknown>`. It opens, pulls and
cancels private JSON sessions using
`/voice/tts/stream/{start,pull,cancel}`. The caller's cache, Android
capacity retries, progressive playback and local fallback have
separate owners. The stream consumes a fixed request ID and immutable
rendering input across retries. This state projects one request ID.

## Story: Retry streaming speech without skipping or duplicating audio

### One request retains its original cursor across failed transport calls

Opening and pulling are single-flight. The native host returns
batches, each with its requested cursor and contiguous audio frames.
The source separates accepted batch data from frames delivered to the
caller. A transport failure leaves the cursor and stream binding
unchanged. An invalid successful payload permanently stops the stream
and requests cancellation. A current-state check at or beyond the
600,000 ms lifetime also stops the stream, including while a
response is outstanding. This is an observation of monotonic
time, with no independent expiry timer in the source. The source accepts frames internally as it
validates a batch. It makes none visible if later validation fails
and cannot reuse the private counters thereafter.

```quint
type StreamPhase = Unopened | OpeningStream | OpenStream | PullingStream | CompletedStream | StoppedStream
type StartReceipt = { streamId: int, decoded: bool }
type BatchReceipt = { boundStream: int, atCursor: int, frames: int, bytes: int, characters: int, decoded: bool, done: bool }
type SpeechStream = { elapsedMs: int, phase: StreamPhase, streamId: int, cursor: int, audioBytes: int, characters: int, buffered: int, endBuffered: bool }
pure val initial: SpeechStream = {
  elapsedMs: 0, phase: Unopened, streamId: 0, cursor: 0, audioBytes: 0, characters: 0, buffered: 0, endBuffered: false
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

The JSON boundary validates the stream ID shape, open state and
rendered speed. Audio requires the exact frame sequence and
`audio/mpeg`, valid bounded base64 and valid optional ordered timing
arrays. A completion frame is last in its batch and declares exact
received frame and byte totals. In the model the decoder's
`decoded` evidence attests those wire checks. The model independently
enforces aggregate caps, ordering of accepted batches and nonempty
audio completion. The pull that accepts a batch also returns its first
frame in the source. Acceptance and draining are separate observations
here so all retained frame custody is explicit.

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

### A deadline observation irrevocably closes the request

A stream freezes its expiry at creation. In the implementation the
monotonic observation is part of entering open or pull and returning
from native I/O. At the deadline the check throws the expiry error and
initiates cancellation by the original request ID, even when the
host has not returned a stream ID. Later replies never reopen it.

```quint
pure def alwaysExpiredStreamStops(s: SpeechStream): bool =
  s.elapsedMs >= 600000 implies s.phase == StoppedStream
pure def sometimesExpiredOpening(s: SpeechStream): bool =
  s.phase == StoppedStream and s.elapsedMs >= 600000 and s.streamId == 0
```
