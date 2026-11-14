# Grace on-device speech request and model ownership

Grace's `DeviceSpeechPlugin.java` extends the pinned
`ElizaInferencePlugin` from
`plugins/plugin-local-inference/native/android/capacitor/src/main/java/ai/eliza/voice`.
Grace compiles the voice bundle under `apps/app/native/android/voice`.
The producer owns status, synthesize, transcribe, cancel and the
process-wide speech and hearing lanes. Grace supplies language
routing, audio focus, packaged asset policy and hidden release timing.
This model follows one request through one lane and the shared
model hold through application visibility and pressure. Concurrent
requests are counted via the lane and queue evidence on release.

## Story: Stop or retire on-device speech without exposing a stale result

### An admitted request retains its identity until its worker finishes

The producer refuses a missing request ID, a duplicate pending ID,
a destroyed bridge or a queue already holding at least 64 entries.
The worker checks current ownership, cancellation, memory pressure
and product policy before running. An active request may register a
native cancellation callback. Cancellation while queued prevents it
from running. Active cancellation interrupts its callback and fences
success. The owner releases the pending entry on worker completion.
The model records one request while the queue-count observation
comes from the other admission owner.

```quint
type NativeSpeechPhase = InitialRequest | QueuedRequest | NativeWorking | Answered | NativeFailed | NativeCanceled
type LocalVoice = {
  phase: NativeSpeechPhase, requestId: int, cancelled: bool, destroyed: bool,
  shown: bool, visibleRound: int, pressure: bool, modelsHeld: bool
}
pure val initial: LocalVoice = {
  phase: InitialRequest, requestId: 0, cancelled: false, destroyed: false,
  shown: true, visibleRound: 0, pressure: false, modelsHeld: false
}
pure def canAdmitLocalSpeech(v: LocalVoice, requestId: int, queueCount: int, idUnused: bool): bool =
  v.phase == InitialRequest and not(v.destroyed) and requestId > 0 and queueCount >= 0 and queueCount < 64 and idUnused
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
pure def stepCanceledCannotPublish(before: LocalVoice, via: str, after: LocalVoice): bool =
  via == "finishLocalWork" and before.cancelled implies after.phase == NativeCanceled
pure def sometimesNativeSpeechAnswered(v: LocalVoice): bool = v.phase == Answered
pure def sometimesNativeSpeechCanceled(v: LocalVoice): bool = v.phase == NativeCanceled
```

## Story: Release native speech memory without invalidating hidden work

### Quiet release requires the current hidden round and no active custody

Grace keeps models while shown. A hidden check is current only for
its captured visibility round. An intervening show advances that
round. Grace's quiet release waits at least 60 seconds since last
activity and requires empty queues, both lanes idle and no host
audio-focus hold. Memory pressure is distinct. It requests active
cancellation and queues release on the speech worker. New operations
that start while pressure is set return failure instead of taking a
model. A release notification is a host observation after that job.

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
