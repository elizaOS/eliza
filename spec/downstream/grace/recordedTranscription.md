# Grace recorded transcription

Grace `48b43b9c` constructs the controller in
`apps/app/src/VoiceControls.tsx`. The controller and its typed failures
come from `packages/ui/src/voice/recorded-transcription-controller.ts` at
Eliza `7743504b`. This model owns one capture and its callbacks.
[Voice input](../voiceEndpoint.md) owns the decision to submit a turn.

## Story: Record one utterance and release its microphone when recording stops

### Only the current capture may adopt a recorder or publish speech

Start first authorizes, then acquires the microphone and starts a
recorder. It ignores another Start while pending. Cancel releases
current tracks, timer, endpoint and preview, and ignores late callbacks.
An acquisition resolving after Cancel still stops the acquired tracks.
Cleanup detaches recorder callbacks and attempts each resource release
even when another release throws. Late preview setup disposes its own
callback when preview admission has ended. A setup rejection after
the recorder stopped does not replace finalization.

Preview checks capture ownership before encoding, before transcribing,
and before publishing. A published preview must be a nonblank string.
It supplies the exact received string with the final flag false.
Recorder errors remain typed. Microphone and other setup errors retain
their original causes. Resource cleanup and asynchronous identity are
port effects, with the current capture's identity carried by each reply.

```quint
type CapturePhase = CaptureIdle | AuthorizingCapture | GettingMicrophone | RecordingUtterance |
  StoppingRecorder | WaitingHostTranscript | EncodingRecording | TranscribingRecording
type CaptureResult = NoResult | ReviewTextReady | CaptureCancelled | RecordingFailed |
  MissingAudio | OversizeAudio | MissingText | PortFailed
type CaptureState = { ticket: int, phase: CapturePhase, bytes: int, previewLive: bool,
  previewCount: int, result: CaptureResult }
pure val initial: CaptureState = { ticket: 0, phase: CaptureIdle, bytes: 0,
  previewLive: false, previewCount: 0, result: NoResult }
pure def settledCapture(ticket: int, captureResult: CaptureResult): CaptureState =
  { ...initial, ticket: ticket, result: captureResult }
pure def canStartCapture(s: CaptureState): bool = s.phase == CaptureIdle
pure def startCapture(s: CaptureState): CaptureState =
  { ...initial, ticket: s.ticket + 1, phase: AuthorizingCapture }
pure def canObserveAuthorization(s: CaptureState): bool = s.phase == AuthorizingCapture
pure def observeAuthorization(s: CaptureState, currentTicket: bool, authorized: bool): CaptureState =
  if (not(currentTicket)) s else if (authorized) { ...s, phase: GettingMicrophone }
  else settledCapture(s.ticket, PortFailed)
pure def canObserveMicrophone(s: CaptureState): bool = s.phase == GettingMicrophone
pure def observeMicrophone(s: CaptureState, currentTicket: bool, recorded: bool): CaptureState =
  if (not(currentTicket)) s else if (recorded) { ...s, phase: RecordingUtterance, previewLive: true }
  else settledCapture(s.ticket, PortFailed)
pure def canCancelCapture(s: CaptureState): bool = s.phase != CaptureIdle
pure def cancelCapture(s: CaptureState): CaptureState = settledCapture(s.ticket + 1, CaptureCancelled)
pure def canFailRecorder(s: CaptureState): bool = s.phase == RecordingUtterance or s.phase == StoppingRecorder
pure def failRecorder(s: CaptureState, currentTicket: bool): CaptureState =
  if (currentTicket) settledCapture(s.ticket, RecordingFailed) else s
pure def canObservePreview(s: CaptureState): bool = s.previewLive
pure def observePreview(s: CaptureState, currentTicket: bool, nonblankText: bool): CaptureState =
  if (currentTicket and nonblankText) { ...s, previewCount: s.previewCount + 1 } else s
pure def alwaysCaptureTicketOwnsPending(s: CaptureState): bool =
  s.ticket >= 0 and (s.phase != CaptureIdle implies s.ticket > 0 and s.result == NoResult)
pure def alwaysPreviewRequiresLivePhase(s: CaptureState): bool =
  s.previewLive implies (s.phase == RecordingUtterance or s.phase == StoppingRecorder or s.phase == WaitingHostTranscript)
pure def alwaysClosedCaptureDiscardsChunks(s: CaptureState): bool =
  s.bytes >= 0 and (s.phase == CaptureIdle implies s.bytes == 0 and s.previewCount == 0)
pure val weight_observeAuthorization = 6
pure val weight_observeMicrophone = 6
```

### Endpoint, timer and size stop use the same finalization boundary

The Grace capture supplies a 6 MiB byte limit and requests recorder
chunks every second. The capture also supplies a total-time limit.
The controller validates positive limits up to 2,147,483,647.
It accumulates complete chunks. Exceeding the byte limit requests a
stop, and a final chunk can still arrive before the stop event.
Exactly the limit is allowed. Finish, a pause event and the timer all
request the same stop. Without a host finalizer, the preview fence closes
as soon as the stop is requested. At the first current stop event,
the recorder, microphone and pause observer are released. A host
finalizer retains only the preview path until it settles.
The modeled byte limit uses Grace's configuration, and browser
recorder events supply actual byte counts and completion.

```quint
pure val recordingLimit = 6291456
pure def canAppendChunk(s: CaptureState, chunkBytes: int): bool =
  (s.phase == RecordingUtterance or s.phase == StoppingRecorder) and chunkBytes >= 0
pure def appendChunk(s: CaptureState, chunkBytes: int, hostFinalizer: bool): CaptureState = {
  val total = s.bytes + chunkBytes
  if (s.phase == RecordingUtterance and total > recordingLimit)
    { ...s, bytes: total, phase: StoppingRecorder, previewLive: s.previewLive and hostFinalizer }
  else { ...s, bytes: total }
}
pure def canRequestRecordingStop(s: CaptureState): bool = s.phase == RecordingUtterance
pure def requestRecordingStop(s: CaptureState, hostFinalizer: bool): CaptureState =
  { ...s, phase: StoppingRecorder, previewLive: s.previewLive and hostFinalizer }
pure def recordingFallback(hasUsableBytes: bool, s: CaptureState): CaptureState =
  if (s.bytes > recordingLimit) settledCapture(s.ticket, OversizeAudio)
  else if (not(hasUsableBytes)) settledCapture(s.ticket, MissingAudio)
  else { ...s, phase: EncodingRecording, previewLive: false }
pure def canObserveRecorderStopped(s: CaptureState): bool =
  s.phase == RecordingUtterance or s.phase == StoppingRecorder
pure def observeRecorderStopped(s: CaptureState, currentTicket: bool, hostFinalizer: bool): CaptureState =
  if (not(currentTicket)) s
  else if (hostFinalizer) { ...s, phase: WaitingHostTranscript }
  else recordingFallback(s.bytes > 0, s)
pure val chunkBytesValues = Set(-1, 0, 1, 32, 6291456, 6291457)
pure val weight_observeRecorderStopped = 10
```

## Story: Review the complete words from the current utterance

### Only an undefined host result may fall back to the recording

At stop the host can take a final snapshot while the preview path
remains usable. The host closes that path on settlement. It can return
a final value directly even if recorded bytes were absent or oversize.
Only undefined selects the default recording path. A nonblank host
result goes straight to review. An invalid or blank host value reports
`empty-transcript` and a rejected host result keeps its error. Without
host text the recording requires nonempty bytes within its limit. It
is encoded as one blob under the recorder MIME, and the same MIME is
used to transcribe. A revoked or replaced capture never starts the
next effect or publishes a final value. The code sends the final text
to a callback for review and has no send operation.

```quint
type HostTranscript = HostText | HostUndefined | HostBlank | HostRejected
type RecordingTranscript = RecordingText | RecordingBlank | RecordingRejected
pure def canObserveHostTranscript(s: CaptureState): bool = s.phase == WaitingHostTranscript
pure def observeHostTranscript(s: CaptureState, currentTicket: bool, hostTranscript: HostTranscript): CaptureState =
  if (not(currentTicket)) s else match hostTranscript {
    | HostText => settledCapture(s.ticket, ReviewTextReady)
    | HostUndefined => recordingFallback(s.bytes > 0, s)
    | HostBlank => settledCapture(s.ticket, MissingText)
    | HostRejected => settledCapture(s.ticket, PortFailed)
  }
pure def canObserveRecordingEncoded(s: CaptureState): bool = s.phase == EncodingRecording
pure def observeRecordingEncoded(s: CaptureState, currentTicket: bool, encoded: bool): CaptureState =
  if (not(currentTicket)) s else if (encoded) { ...s, phase: TranscribingRecording, bytes: 0 }
  else settledCapture(s.ticket, PortFailed)
pure def canObserveRecordingText(s: CaptureState): bool = s.phase == TranscribingRecording
pure def observeRecordingText(s: CaptureState, currentTicket: bool, recordingText: RecordingTranscript): CaptureState =
  if (not(currentTicket)) s else match recordingText {
    | RecordingText => settledCapture(s.ticket, ReviewTextReady)
    | RecordingBlank => settledCapture(s.ticket, MissingText)
    | RecordingRejected => settledCapture(s.ticket, PortFailed)
  }
pure def stepEncodingFollowsRecordingBytes(before: CaptureState, via: str, after: CaptureState): bool =
  before.phase != EncodingRecording and after.phase == EncodingRecording implies
    before.bytes > 0 and before.bytes <= recordingLimit and
      (via == "observeRecorderStopped" or via == "observeHostTranscript")
pure def sometimesLastSnapshotOpen(s: CaptureState): bool = s.phase == WaitingHostTranscript and s.previewLive
pure def sometimesDefaultRecordingUpload(s: CaptureState): bool = s.phase == TranscribingRecording
pure def sometimesCurrentReviewReady(s: CaptureState): bool = s.result == ReviewTextReady
pure val weight_appendChunk = 6
pure val weight_observeHostTranscript = 10
pure val weight_observeRecordingEncoded = 9
```

The pinned `recorded-transcription-controller.test.ts` exercises the
default MIME upload, host text, undefined fallback and both preview
lifetimes with a controlled recorder. Grace's voice controller uses a
complete, untrimmed, current preview only when it covers the end of the
utterance. That matching policy and the decision to use Cloud or device
recognition are supplied through the host finalizer.
