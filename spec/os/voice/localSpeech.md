# On-device speech request and model ownership

A consumer's device speech plugin builds on the os package's local
inference plugin and compiles the voice bundle into its own Android build.
The plugin owns status, synthesis, transcription, cancellation and the
process-wide speech and hearing lanes; the consumer supplies language
routing, audio focus, packaged asset policy and release timing. This spec
follows one request through one lane and the shared model hold through
application visibility and memory pressure. The resident agent serves the
same engine to the host app over its speech routes; which token each route
accepts is the [native gateway](../../agent/nativeHost/gateway.md).
[On-device microphone ownership](./microphoneSlot.md) owns the shared
capture.

## Story: Recognize and speak on the device with a verified speech bundle

> As a person who keeps speech on the device, I want only the speech models
> the build pinned to run, never ones fetched from the network.

### Only a packaged bundle whose SHA-256 matches its pin is installed

The speech bundle ships inside the application's own assets. Before any
request is admitted the host checks each model file's SHA-256 against the
digest the build pinned. A bundle that came from the network, or whose
digest differs, is never installed, so no model is ever held from it.

```quint
type BundleSource = PackagedBundle | DownloadedBundle
type SpeechBundle = { source: BundleSource, digestMatches: bool }
pure def bundleInstallable(bundle: SpeechBundle): bool =
  bundle.source == PackagedBundle and bundle.digestMatches
pure def lawNoNetworkInstall(bundle: SpeechBundle): bool =
  bundle.source == DownloadedBundle implies not(bundleInstallable(bundle))
pure def lawDigestMismatchRefused(bundle: SpeechBundle): bool =
  not(bundle.digestMatches) implies not(bundleInstallable(bundle))
pure val bundleValues = Set({ source: PackagedBundle, digestMatches: true },
  { source: PackagedBundle, digestMatches: false }, { source: DownloadedBundle, digestMatches: true })
```

### The app's speech library and the resident host carry the same engine bytes

The device speech library links the local inference engine without
packaging it; the application packages the engine its resident host
stages. A build is admitted only when the engine the application packages
is byte for byte the engine the resident host's record names, and every
staged voice output matches the bytes the build recorded. A separately
packaged wake listener carries its own verified copy.

```quint
type EngineStaging = { appMatchesResident: bool, outputsMatchRecord: bool }
pure def engineStagingAdmitted(staging: EngineStaging): bool = staging.appMatchesResident and staging.outputsMatchRecord
pure val stagingValues = Set({ appMatchesResident: true, outputsMatchRecord: true },
  { appMatchesResident: false, outputsMatchRecord: true }, { appMatchesResident: true, outputsMatchRecord: false })
pure def lawDivergentEngineRefused(staging: EngineStaging): bool =
  not(staging.appMatchesResident) implies not(engineStagingAdmitted(staging))
```

## Story: Stop or retire on-device speech without exposing a stale result

> As a person who cancels speech or leaves the app, I want no stale
> transcript or audio to appear afterwards.

### An admitted request retains its identity until its worker finishes

The plugin refuses a missing request ID, a duplicate pending ID,
a destroyed bridge, a queue already holding at least 64 entries, or a
speech bundle that has not been verified. The worker checks current
ownership, cancellation, memory pressure and consumer policy before
running. An active request may register a native cancellation callback.
Cancellation while queued, including by a destroyed bridge, prevents it
from running. Active cancellation
interrupts its callback and fences success. The owner releases the
pending entry on worker completion. The model records one request while
the queue-count observation comes from the other admission owner.

```quint
type NativeSpeechPhase = InitialRequest | QueuedRequest | NativeWorking | Answered | NativeFailed | NativeCanceled
type LocalVoice = {
  phase: NativeSpeechPhase, requestId: int, cancelled: bool, destroyed: bool,
  shown: bool, visibleRound: int, pressure: bool, modelsHeld: bool, bundleVerified: bool
}
pure val initial: LocalVoice = {
  phase: InitialRequest, requestId: 0, cancelled: false, destroyed: false,
  shown: true, visibleRound: 0, pressure: false, modelsHeld: false, bundleVerified: false
}
pure def canVerifyBundle(v: LocalVoice, bundle: SpeechBundle): bool =
  not(v.bundleVerified) and bundleInstallable(bundle)
pure def verifyBundle(v: LocalVoice, bundle: SpeechBundle): LocalVoice = { ...v, bundleVerified: true }
pure def canAdmitLocalSpeech(v: LocalVoice, requestId: int, queueCount: int, idUnused: bool): bool =
  v.phase == InitialRequest and v.bundleVerified and not(v.destroyed) and requestId > 0 and
  queueCount >= 0 and queueCount < 64 and idUnused
pure def admitLocalSpeech(v: LocalVoice, requestId: int, queueCount: int, idUnused: bool): LocalVoice =
  {...v, phase: QueuedRequest, requestId: requestId}
pure val requestIdValues = Set(0, 1, 2)
pure val queueCountValues = Set(0, 63, 64)
pure def canStartLocalWork(v: LocalVoice): bool = v.phase == QueuedRequest
pure def startLocalWork(v: LocalVoice, policyAllows: bool): LocalVoice =
  if (v.destroyed or v.cancelled) {...v, phase: NativeCanceled}
  else if (v.pressure or not(policyAllows)) {...v, phase: NativeFailed}
  else {...v, phase: NativeWorking, modelsHeld: true}
pure def canFinishLocalWork(v: LocalVoice): bool = v.phase == NativeWorking
pure def finishLocalWork(v: LocalVoice, workOk: bool): LocalVoice =
  {...v, phase: if (v.cancelled) NativeCanceled else if (workOk) Answered else NativeFailed}
pure def canCancelLocalWork(v: LocalVoice, requestId: int): bool =
  (v.phase == QueuedRequest or v.phase == NativeWorking) and v.requestId == requestId
pure def cancelLocalWork(v: LocalVoice, requestId: int): LocalVoice = {...v, cancelled: true}
pure def canDestroyBridge(v: LocalVoice): bool = not(v.destroyed)
pure def destroyBridge(v: LocalVoice): LocalVoice =
  {...v, destroyed: true, cancelled: v.cancelled or v.phase == NativeWorking or v.phase == QueuedRequest}
pure def alwaysPendingRequestOwnsIdentity(v: LocalVoice): bool = v.phase != InitialRequest implies v.requestId > 0
pure def alwaysModelsComeFromVerifiedBundle(v: LocalVoice): bool =
  (v.phase != InitialRequest or v.modelsHeld) implies v.bundleVerified
pure def stepCanceledCannotPublish(before: LocalVoice, via: str, after: LocalVoice): bool =
  (via == "finishLocalWork" or via == "startLocalWork") and before.cancelled implies after.phase == NativeCanceled
pure def sometimesNativeSpeechAnswered(v: LocalVoice): bool = v.phase == Answered
pure def sometimesNativeSpeechCanceled(v: LocalVoice): bool = v.phase == NativeCanceled
```

## Story: Release native speech memory without invalidating hidden work

> As a person who switches away from the app, I want speech memory freed
> once it is quiet, without breaking a request still in flight.

### Quiet release requires the current hidden round and no active custody

The host keeps models while shown: only a quiet hidden release or the
end of memory pressure lets them go. A hidden check is current only for
its captured visibility round. An intervening show advances that
round. Quiet release waits at least 60 seconds since last activity and
requires empty queues, both lanes idle and no host audio-focus hold.
Memory pressure is distinct. It requests cancellation of the active
request and queues release on the speech worker. New operations that start while pressure
is set return failure instead of taking a model. A release notification
is a host observation after that job.

```quint
pure def canShowHost(v: LocalVoice): bool = not(v.shown)
pure def showHost(v: LocalVoice): LocalVoice = {...v, shown: true, visibleRound: v.visibleRound + 1}
pure def canHideHost(v: LocalVoice): bool = v.shown
pure def hideHost(v: LocalVoice): LocalVoice = {...v, shown: false}
pure def canReleaseHidden(v: LocalVoice, visibilityRound: int, quietForMs: int, otherLanesQuiet: bool, audioFocusHeld: bool): bool =
  not(v.shown) and v.modelsHeld and visibilityRound == v.visibleRound and quietForMs >= 60000 and
  otherLanesQuiet and not(audioFocusHeld) and v.phase != QueuedRequest and v.phase != NativeWorking
pure def releaseHidden(v: LocalVoice, visibilityRound: int, quietForMs: int, otherLanesQuiet: bool, audioFocusHeld: bool): LocalVoice =
  {...v, modelsHeld: false}
pure val visibilityRoundValues = Set(0, 1, 2)
pure val quietForMsValues = Set(0, 59999, 60000, 90000)
pure def beginPressure(v: LocalVoice): LocalVoice =
  {...v, pressure: true, cancelled: v.cancelled or v.phase == NativeWorking}
pure def canFinishPressure(v: LocalVoice): bool = v.pressure
pure def finishPressure(v: LocalVoice): LocalVoice = {...v, pressure: false, modelsHeld: false}
pure def alwaysVisibilityRoundValid(v: LocalVoice): bool = v.visibleRound >= 0
pure def stepQuietReleaseKeepsRequests(before: LocalVoice, via: str, after: LocalVoice): bool =
  via == "releaseHidden" implies not(before.shown) and not(after.modelsHeld) and after.phase == before.phase and
    after.cancelled == before.cancelled
pure def stepModelsReleasedOnlyHiddenOrUnderPressure(before: LocalVoice, via: str, after: LocalVoice): bool =
  before.modelsHeld and not(after.modelsHeld) implies
    (via == "releaseHidden" and not(before.shown)) or (via == "finishPressure" and before.pressure)
pure def stepPressureFencesWork(before: LocalVoice, via: str, after: LocalVoice): bool =
  (via == "beginPressure" and before.phase == NativeWorking implies after.cancelled) and
  (via == "startLocalWork" and before.pressure implies after.phase != NativeWorking and after.modelsHeld == before.modelsHeld)
pure def sometimesHiddenModelReleased(v: LocalVoice): bool = not(v.shown) and v.phase == Answered and not(v.modelsHeld)
```

## Story: Serve speech on the device through the resident's speech routes

> As a person using speech on my device, I want recognition and read-aloud
> from the agent on the device whether or not I am signed in to a cloud
> account, and a stalled request to end instead of hanging.

### Each on-device speech route has one method and bounded input

The resident serves recorded recognition at `/api/asr/libelizainference`
(POST with audio) and its readiness at `/api/asr/libelizainference/status`
(GET), the live segment exchange at `/api/asr/local-inference/live` (POST)
and its readiness at `/api/asr/local-inference/live/status` (GET), the
end-of-turn score at `/api/asr/local-inference/end-of-turn` (POST), and
read-aloud synthesis at `/api/tts/local-inference` (POST). Every route and
provider name is generic: none names a model or a product. Recorded audio
is at most 2 MiB and its transcript at most 16,000 characters; read-aloud
text is 1 to 500 characters and answers one RIFF WAV with the request's
own identity. A request with any other method or with input outside these
bounds is refused before it reaches a model.

```quint
type SpeechRoute = RecordedRecognition | RecognitionStatus | LiveSegment | LiveStatus | EndOfTurnScore | ReadAloud
type SpeechRequest = { route: SpeechRoute, isPost: bool, audioBytes: int, textChars: int }
pure def speechRoutePost(route: SpeechRoute): bool = route != RecognitionStatus and route != LiveStatus
pure def speechInputBounded(request: SpeechRequest): bool =
  if (request.route == RecordedRecognition) request.audioBytes > 0 and request.audioBytes <= 2097152
  else if (request.route == ReadAloud) request.textChars >= 1 and request.textChars <= 500
  else true
pure def speechRequestAdmitted(request: SpeechRequest): bool =
  request.isPost == speechRoutePost(request.route) and speechInputBounded(request)
pure val speechRequestValues = Set(
  { route: ReadAloud, isPost: true, audioBytes: 0, textChars: 500 }, { route: ReadAloud, isPost: true, audioBytes: 0, textChars: 501 },
  { route: ReadAloud, isPost: false, audioBytes: 0, textChars: 10 }, { route: RecordedRecognition, isPost: true, audioBytes: 2097153, textChars: 0 },
  { route: RecordedRecognition, isPost: true, audioBytes: 1024, textChars: 0 }, { route: LiveStatus, isPost: false, audioBytes: 0, textChars: 0 })
pure def lawStatusIsReadOnly(speechRequest: SpeechRequest): bool =
  (speechRequest.route == RecognitionStatus or speechRequest.route == LiveStatus) and speechRequest.isPost implies not(speechRequestAdmitted(speechRequest))
pure def lawReadAloudTextBounded(speechRequest: SpeechRequest): bool =
  speechRequest.route == ReadAloud and speechRequestAdmitted(speechRequest) implies speechRequest.textChars >= 1 and speechRequest.textChars <= 500
pure def lawRecordedAudioBounded(speechRequest: SpeechRequest): bool =
  speechRequest.route == RecordedRecognition and speechRequestAdmitted(speechRequest) implies speechRequest.audioBytes > 0 and speechRequest.audioBytes <= 2097152
```

### Read-aloud ends within 45 seconds and a live segment exchange within 8 seconds

A read-aloud request that has not answered within 45 seconds, a live
segment exchange within 8 seconds, and a recorded recognition within 120
seconds ends as timed out; an answer that arrives after that is dropped
and never played or shown.

```quint
type TimedSpeech = TimedReadAloud | TimedLiveSegment | TimedRecognition
type SpeechExchangeOutcome = ExchangeWaiting | ExchangeAnswered | ExchangeTimedOut
pure def speechDeadlineMs(kind: TimedSpeech): int =
  if (kind == TimedReadAloud) 45000 else if (kind == TimedLiveSegment) 8000 else 120000
pure def speechExchange(kind: TimedSpeech, elapsedMs: int, answered: bool): SpeechExchangeOutcome =
  if (elapsedMs >= speechDeadlineMs(kind)) ExchangeTimedOut else if (answered) ExchangeAnswered else ExchangeWaiting
pure val elapsedMsValues = Set(0, 7999, 8000, 44999, 45000, 120000)
pure def lawLateAnswerDropped(kind: TimedSpeech, elapsedMs: int, answered: bool): bool =
  elapsedMs >= speechDeadlineMs(kind) implies speechExchange(kind, elapsedMs, answered) == ExchangeTimedOut
pure def lawReadAloudWaitsUnderDeadline(elapsedMs: int): bool =
  elapsedMs >= 0 and elapsedMs < 45000 implies speechExchange(TimedReadAloud, elapsedMs, false) == ExchangeWaiting
```

### On-device speech does not depend on a cloud account

The on-device routes are served whenever the speech bundle is verified,
signed in to a cloud account or not, and with or without a plan. When the
person chose cloud speech and it is unavailable, speech falls back to the
device; cloud speech is used only when it is both chosen and available.

```quint
type SpeechPath = DeviceSpeech | CloudSpeechPath | NoSpeech
pure def speechPath(bundleVerified: bool, cloudChosen: bool, cloudAvailable: bool): SpeechPath =
  if (cloudChosen and cloudAvailable) CloudSpeechPath else if (bundleVerified) DeviceSpeech else NoSpeech
pure def lawDeviceSpeechFallsBack(bundleVerified: bool, cloudChosen: bool): bool =
  bundleVerified implies speechPath(bundleVerified, cloudChosen, false) == DeviceSpeech
pure def lawCloudOnlyWhenChosen(bundleVerified: bool, cloudAvailable: bool): bool =
  speechPath(bundleVerified, false, cloudAvailable) != CloudSpeechPath
```
