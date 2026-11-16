# On-device speech request and model ownership

A consumer's device speech plugin builds on the os package's local
inference plugin and compiles the voice bundle into its own Android build.
The plugin owns status, synthesis, transcription, cancellation and the
process-wide speech and hearing lanes; the consumer supplies language
routing, audio focus, packaged asset policy and release timing. This spec
follows one request through one lane and the shared model hold through
application visibility and memory pressure.
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

## Story: Stop or retire on-device speech without exposing a stale result

> As a person who cancels speech or leaves the app, I want no stale
> transcript or audio to appear afterwards.

### An admitted request retains its identity until its worker finishes

The plugin refuses a missing request ID, a duplicate pending ID,
a destroyed bridge, a queue already holding at least 64 entries, or a
speech bundle that has not been verified. The worker checks current
ownership, cancellation, memory pressure and consumer policy before
running. An active request may register a native cancellation callback.
Cancellation while queued prevents it from running. Active cancellation
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
  via == "finishLocalWork" and before.cancelled implies after.phase == NativeCanceled
pure def sometimesNativeSpeechAnswered(v: LocalVoice): bool = v.phase == Answered
pure def sometimesNativeSpeechCanceled(v: LocalVoice): bool = v.phase == NativeCanceled
```

## Story: Release native speech memory without invalidating hidden work

> As a person who switches away from the app, I want speech memory freed
> once it is quiet, without breaking a request still in flight.

### Quiet release requires the current hidden round and no active custody

The host keeps models while shown. A hidden check is current only for
its captured visibility round. An intervening show advances that
round. Quiet release waits at least 60 seconds since last activity and
requires empty queues, both lanes idle and no host audio-focus hold.
Memory pressure is distinct. It requests active cancellation and queues
release on the speech worker. New operations that start while pressure
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
pure def sometimesHiddenModelReleased(v: LocalVoice): bool = not(v.shown) and v.phase == Answered and not(v.modelsHeld)
```
