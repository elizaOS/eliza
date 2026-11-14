# Native speech request authority

Alpha `apps/app/src/runtime/local-voice.ts` and `paired-voice.ts`
construct `createNativeSpeechRequests` from the staged source of
`packages/voice/src/native-speech-request.ts`. The pinned producer's
`packages/voice/quint/NativeSpeechRequest.qnt` captures an individual
request. Grace `apps/app/src/stream-speech.ts` imports
`createNativeSpeechStream`, `SpeechAudioFrame`, and
`SpeechRenderingInput` from `@elizaos/cloud-sdk/native-speech-stream`.
Grace selects its endpoint and abort controller in its own adapter. This
model captures the shared request authority and cancellation contract,
while transport frames and decoder contracts have their own state.

## Story: Speak using the selected native or paired endpoint

### The captured binding and caller signal control publication and cancellation

Work may settle after either the binding changes or the caller aborts.
An in-flight request owns the cancellation signal and aborts it exactly
once. A stale or aborted request rejects when its work settles. The
operation stops watching either condition at settlement, so late
notifications never cancel a previously completed request. The source
expects the work callback to honor the owned signal.

```quint
type SpeechPhase = BeforeSpeech | Working | Succeeded | SpeechRejected | SpeechFailed
type SpeechRequest = { phase: SpeechPhase, bindingLive: bool, callerAborted: bool, ownedAborted: bool, watched: bool, cancellations: int }
pure val initial: SpeechRequest = { phase: BeforeSpeech, bindingLive: true, callerAborted: false, ownedAborted: false, watched: false, cancellations: 0 }
pure def canBeginSpeech(s: SpeechRequest): bool = s.phase == BeforeSpeech
pure def beginSpeech(s: SpeechRequest): SpeechRequest =
  if (s.bindingLive and not(s.callerAborted)) { ...s, phase: Working, watched: true }
  else { ...s, phase: SpeechRejected }
pure def signalAborted(s: SpeechRequest): bool = s.ownedAborted or s.watched
pure def cancellationCount(s: SpeechRequest): int =
  s.cancellations + (if (s.watched and not(s.ownedAborted)) 1 else 0)
pure def invalidateBinding(s: SpeechRequest): SpeechRequest =
  { ...s, bindingLive: false, ownedAborted: signalAborted(s), cancellations: cancellationCount(s) }
pure def abortCaller(s: SpeechRequest): SpeechRequest =
  { ...s, callerAborted: true, ownedAborted: signalAborted(s), cancellations: cancellationCount(s) }
pure def canFinishWork(s: SpeechRequest): bool = s.phase == Working
pure def finishWork(s: SpeechRequest, workSucceeded: bool): SpeechRequest =
  { ...s, watched: false, phase: if (not(s.bindingLive) or s.callerAborted or s.ownedAborted) SpeechRejected else if (workSucceeded) Succeeded else SpeechFailed }
pure def alwaysCancellationAtMostOnce(s: SpeechRequest): bool =
  s.cancellations == (if (s.ownedAborted) 1 else 0)
pure def alwaysOnlyPendingObserves(s: SpeechRequest): bool = s.watched == (s.phase == Working)
pure def stepPublishNeedsLiveBinding(before: SpeechRequest, via: str, after: SpeechRequest): bool =
  via == "finishWork" and after.phase == Succeeded implies before.bindingLive and not(before.callerAborted) and not(before.ownedAborted)
pure def stepInvalidationIsPermanent(before: SpeechRequest, after: SpeechRequest): bool =
  not(before.bindingLive) implies not(after.bindingLive)
pure def sometimesSpeechPublished(s: SpeechRequest): bool = s.phase == Succeeded
pure def sometimesWorkCancelled(s: SpeechRequest): bool = s.phase == SpeechRejected and s.cancellations == 1
```
