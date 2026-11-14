# Grace microphone sample and preview custody

Grace `48b43b9c` directly calls the Eliza `7743504b` browser capture
from `apps/app/src/live-transcription.ts` and
`apps/app/src/device-hearing.ts`. The pinned producers are
`packages/ui/src/voice/microphone-capture.ts`,
`microphone-samples.worklet.mjs`, and `pcm-wave.ts`.
[Recorded transcription](./recordedTranscription.md) owns the final
utterance and [voice input](../voiceEndpoint.md) owns turn admission.

## Story: Share one microphone context with the meter and retain the right samples

### Capture owns its graph and releases only the context it opened

The shared capture requires positive finite options and nonempty worklet
and processor names. It rejects a supplied context at another sample
rate. Missing browser capability or failed setup returns no capture.
Grace passes its open 16 kHz meter context if available. Otherwise the
capture requests its own context. It waits for worklet registration,
checks current ownership, connects the mono graph, waits for resume, then
checks ownership again before enabling previews. On retirement it
disconnects nodes, clears the interval and closes the message port.
It requests closure only for its own context and leaves the caller's
tracks alone. Late setup must release what it acquired. Setup and close
failures are handled at the capture lifecycle port.

The worklet copies only the first input channel. It sends each full
2,048-sample block in source order and transfers its buffer. It produces
no microphone monitoring output. The model observes decoded sample counts
and speech levels. It uses the observed context rate, which is 16 kHz in
the Grace paths.

```quint
type CaptureLife = BeforeOpening | LoadingWorklet | ResumingGraph | SampleCapture | SampleClosed
type ContextCustody = OwnedContext | SharedContext
type SampleCaptureState = { phase: CaptureLife, custody: ContextCustody, rate: int, secondsLimit: int,
  received: int, stored: int, heardSpeech: bool, lastOffered: int, pendingOffer: int, previewOk: bool }
pure val initial: SampleCaptureState = { phase: BeforeOpening, custody: OwnedContext, rate: 16000,
  secondsLimit: 35, received: 0, stored: 0, heardSpeech: false, lastOffered: 0, pendingOffer: 0, previewOk: false }
pure def captureLimitSeconds(deviceHearing: bool): int = if (deviceHearing) 60 else 35
pure def canOpenSampleCapture(s: SampleCaptureState): bool = s.phase == BeforeOpening
pure def openSampleCapture(s: SampleCaptureState, custody: ContextCustody, deviceHearing: bool, opened: bool): SampleCaptureState =
  { ...s, phase: if (opened) LoadingWorklet else SampleClosed, custody: custody,
    secondsLimit: captureLimitSeconds(deviceHearing) }
pure def canObserveGraph(s: SampleCaptureState): bool = s.phase == LoadingWorklet or s.phase == ResumingGraph
pure def observeGraph(s: SampleCaptureState, currentCapture: bool, portSucceeded: bool): SampleCaptureState =
  if (not(currentCapture and portSucceeded)) { ...s, phase: SampleClosed }
  else if (s.phase == LoadingWorklet) { ...s, phase: ResumingGraph }
  else { ...s, phase: SampleCapture }
pure def closeSampleCapture(s: SampleCaptureState): SampleCaptureState =
  { ...s, phase: SampleClosed }
pure def closesAudioContext(custody: ContextCustody, allocated: bool): bool = allocated and custody == OwnedContext
pure def lawSharedContextStaysOpen(allocated: bool): bool = not(closesAudioContext(SharedContext, allocated))
pure val weight_observeGraph = 5
```

### The retained prefix is bounded while block-level observation keeps advancing

An active capture accepts only a nonempty Float32 block. The model
represents an admitted block as its sample count. The sample clock
advances by even the portion beyond the retention cap. RMS level and
the end sample of that block go to the meter where configured.
Retained samples stay in arrival order, clipping only the final block
at the cap. Only the retained portion can satisfy the speech threshold.
Speech detected once continues to qualify later snapshots. At 16 kHz,
Grace retains at most 560,000 samples for Cloud previews, including
initial silence, and 960,000 for setup hearing. The final recorder
owns a different audio source.

Before context opening there are no observed or stored samples.
This matters when the selected input changes the retention bound
from the initial setting. The graph can deliver its first block
while resume is still pending.

```quint
type MicBlock = { sampleCount: int, retainedPrefixHasSpeech: bool }
pure val soundBlock: MicBlock = { sampleCount: 2048, retainedPrefixHasSpeech: true }
pure val micBlockValues = Set(soundBlock, { ...soundBlock, retainedPrefixHasSpeech: false },
  { ...soundBlock, sampleCount: 0 }, { ...soundBlock, sampleCount: 559999 },
  { ...soundBlock, sampleCount: 560001 }, { ...soundBlock, sampleCount: 960001 })
pure def capSamples(s: SampleCaptureState): int = s.rate * s.secondsLimit
pure def canReceiveBlock(s: SampleCaptureState, currentCapture: bool, micBlock: MicBlock): bool =
  (s.phase == ResumingGraph or s.phase == SampleCapture) and currentCapture and micBlock.sampleCount > 0
pure def receiveBlock(s: SampleCaptureState, currentCapture: bool, micBlock: MicBlock): SampleCaptureState = {
  val room = capSamples(s) - s.stored
  val admitted = if (micBlock.sampleCount < room) micBlock.sampleCount else room
  { ...s, received: s.received + micBlock.sampleCount, stored: s.stored + admitted,
    heardSpeech: s.heardSpeech or (admitted > 0 and micBlock.retainedPrefixHasSpeech) }
}
pure def alwaysSampleBounds(s: SampleCaptureState): bool =
  s.rate == 16000 and (s.secondsLimit == 35 or s.secondsLimit == 60) and
    s.stored >= 0 and s.stored <= s.received and s.stored <= capSamples(s)
pure def alwaysUnopenedCaptureHasNoSamples(s: SampleCaptureState): bool =
  s.phase == BeforeOpening implies s.received == 0 and s.stored == 0
pure def stepStoredPrefixNeverRegresses(before: SampleCaptureState, after: SampleCaptureState): bool =
  after.stored >= before.stored and after.received >= before.received
pure def sometimesMeterContinuesBeyondCap(s: SampleCaptureState): bool = s.received > capSamples(s) and s.stored == capSamples(s)
pure val weight_receiveBlock = 9
```

## Story: Offer fresh speech previews without resending a failed snapshot

### A preview marks the sample position before calling the receiver

The timer offers the full retained prefix once the capture is current,
has heard speech, has enough new samples, and has no receiver call in
flight. The manual snapshot waits for the in-flight call and then
requires one new sample. It returns false for an unavailable snapshot or
receiver failure, true for a completed call. The last-offered position
advances before the receiver starts, even when the receiver throws
synchronously. Failure clears the in-flight marker without retrying the
same samples, and leaves the separate recording intact. Closing the
capture drops its buffers. The model retains sample counts as history
and permits an older receiver promise to settle without opening another
offer. The receiver's own result is independent of capture retirement.

Grace's Cloud receiver returns before the Cloud transcription settles.
Its separate preview scheduler handles Cloud concurrency and chooses an
8-second trailing window. The device-hearing receiver waits for native
delivery and uses the supplied full prefix to forward new samples.
The WAV encoder writes a single-channel PCM16 header with 44 bytes
before payload and preserves sample order across chunks. It rounds
to integer samples, clamps to the PCM range, and maps nonfinite input
to silence. A clipped preview cannot qualify as a full utterance.

```quint
type OfferKind = TimerOffer | SnapshotOffer
pure def minimumOfferSamples(deviceHearing: bool, offerKind: OfferKind): int =
  if (offerKind == SnapshotOffer) 1 else if (deviceHearing) 1600 else 4800
pure def deviceSamplePolicy(s: SampleCaptureState): bool = s.secondsLimit == 60
pure def canOfferPreview(s: SampleCaptureState, currentCapture: bool, offerKind: OfferKind): bool =
  s.phase == SampleCapture and currentCapture and s.heardSpeech and s.pendingOffer == 0 and
    s.stored - s.lastOffered >= minimumOfferSamples(deviceSamplePolicy(s), offerKind)
pure def offerPreview(s: SampleCaptureState, currentCapture: bool, offerKind: OfferKind): SampleCaptureState =
  { ...s, lastOffered: s.stored, pendingOffer: s.stored, previewOk: false }
pure def canSettlePreview(s: SampleCaptureState): bool = s.pendingOffer > 0
pure def settlePreview(s: SampleCaptureState, receiverCompleted: bool): SampleCaptureState =
  { ...s, pendingOffer: 0, previewOk: receiverCompleted }
pure def cloudPreviewCount(totalSamples: int): int =
  if (totalSamples <= 0) 0 else if (totalSamples > 128000) 128000 else totalSamples
pure def waveBytes(sampleCount: int): int = 44 + 2 * sampleCount
pure def lawCloudPreviewKeepsOnlyTail(totalSamples: int): bool =
  totalSamples >= 0 implies cloudPreviewCount(totalSamples) <= totalSamples and cloudPreviewCount(totalSamples) <= 128000
pure def alwaysOffersArePrefixCheckpoints(s: SampleCaptureState): bool =
  s.lastOffered >= 0 and s.lastOffered <= s.stored and
    (s.pendingOffer == 0 or s.pendingOffer == s.lastOffered and s.pendingOffer > 0)
pure def stepOfferRequiresNewSamples(before: SampleCaptureState, via: str, after: SampleCaptureState): bool =
  via == "offerPreview" implies after.lastOffered > before.lastOffered and after.pendingOffer == before.stored
pure def sometimesSuccessfulPreview(s: SampleCaptureState): bool = s.previewOk and s.lastOffered > 0
pure def sometimesLatePreviewCanSettle(s: SampleCaptureState): bool = s.phase == SampleClosed and s.pendingOffer > 0
pure val totalSamplesValues = Set(0, 1, 127999, 128000, 128001, 560000)
pure val weight_offerPreview = 7
pure val weight_settlePreview = 7
```

The pinned `microphone-capture.test.ts` exercises owned and shared
contexts, rate mismatch, continued block observation, synchronous
receiver failure and snapshots. Grace's `live-transcription.test.mjs`
and `device-hearing-capture.test.mjs` cover the receiving adapters.
Audio permission, native recognition and provider results are effect
inputs.
