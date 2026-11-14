# Native Cloud live speech custody

AlphaPhone's `apps/app/src/runtime/cloud-voice.ts` imports
`packages/voice/src/native-cloud-speech.ts` at Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. The product can select it for
a Cloud voice driver with the native streaming bridge available and
resident inference outside the direct route. The bridge owns credentials
and PCM. The renderer receives decoded lifecycle, level, and text events.

## Story: Reopen capture without inheriting a provider turn from playback

### A provider speech edge belongs to the capture that was live when it began

A logical speech session has one owner signal and shares native open.
Open verifies the requested session identity and a 16 kHz rate. A
different owner signal cannot claim it. Closing listening mutes and
drains an outstanding final before the next capture, with a 2,500 ms
bound. While close still owns its active listener, its final reaches that
same generation before close settles. An unsolicited speech start during a muted hold owns no capture.
Its final can finish the drain but cannot publish into a newer listener.
Interim and final text require a matching provider session, a current
capture generation, and decoded text of at most 16,384 UTF-16 units.
Final text is trimmed. Cancellation and native failure retire the session
and its listeners. Discovered by the proof: a rejected open must also clear
any captured speech owner before entering the retired state. The model uses one logical provider session and
projects retirement, final and unmute acknowledgments as bridge events.
Speech audio receipt and cancellation use the separately owned
[playback boundary](./mobilePlayback.md).

```quint
type NativeCloudPhase = CloudSpeechClosed | CloudSpeechOpening | CloudSpeechListening | CloudSpeechMuted | CloudSpeechDraining | CloudSpeechRetired
type CloudCapture = { phase: NativeCloudPhase, generation: int, speechActive: bool, speechOwner: int, published: int }
pure val initial: CloudCapture = { phase: CloudSpeechClosed, generation: 0, speechActive: false, speechOwner: 0, published: 0 }
pure def canOpenSpeech(c: CloudCapture, ownerLive: bool): bool = c.phase == CloudSpeechClosed and ownerLive
pure def openSpeech(c: CloudCapture, ownerLive: bool): CloudCapture = { ...c, phase: CloudSpeechOpening }
pure def canObserveOpen(c: CloudCapture): bool = c.phase == CloudSpeechOpening
pure def observeOpen(c: CloudCapture, sessionExact: bool, sample16k: bool, ownerLive: bool): CloudCapture =
  if (sessionExact and sample16k and ownerLive) { ...c, phase: CloudSpeechListening, generation: c.generation + 1 }
  else { ...c, phase: CloudSpeechRetired, speechActive: false, speechOwner: 0 }
pure def canHearStart(c: CloudCapture, sessionExact: bool): bool =
  sessionExact and not(c.speechActive) and (c.phase == CloudSpeechListening or c.phase == CloudSpeechMuted)
pure def hearStart(c: CloudCapture, sessionExact: bool): CloudCapture =
  { ...c, speechActive: true, speechOwner: if (c.phase == CloudSpeechListening) c.generation else 0 }
pure def ownsCloudSpeech(c: CloudCapture): bool = (c.phase == CloudSpeechListening or c.phase == CloudSpeechDraining) and c.generation > 0 and c.speechOwner == c.generation
pure def canHearFinal(c: CloudCapture, sessionExact: bool, validText: bool): bool =
  sessionExact and validText and c.speechActive and c.phase != CloudSpeechRetired
pure def hearFinal(c: CloudCapture, sessionExact: bool, validText: bool): CloudCapture =
  { ...c, speechActive: false, speechOwner: 0, published: c.published + (if (ownsCloudSpeech(c)) 1 else 0) }
pure def canBeginBusyHold(c: CloudCapture): bool = c.phase == CloudSpeechListening
pure def beginBusyHold(c: CloudCapture): CloudCapture =
  { ...c, phase: if (c.speechActive) CloudSpeechDraining else CloudSpeechMuted }
pure def canEndDrain(c: CloudCapture, drained: bool): bool = c.phase == CloudSpeechDraining and (not(drained) or not(c.speechActive))
pure def endDrain(c: CloudCapture, drained: bool): CloudCapture =
  { ...c, phase: if (drained) CloudSpeechMuted else CloudSpeechRetired, speechActive: false, speechOwner: 0 }
pure def canResumeCloudCapture(c: CloudCapture, ownerLive: bool, exactOwner: bool): bool =
  c.phase == CloudSpeechMuted and ownerLive and exactOwner
pure def resumeCloudCapture(c: CloudCapture, ownerLive: bool, exactOwner: bool): CloudCapture =
  if (c.speechActive) { ...c, phase: CloudSpeechDraining }
  else { ...c, phase: CloudSpeechListening, generation: c.generation + 1 }
pure def retireCloudCapture(c: CloudCapture): CloudCapture =
  { ...c, phase: CloudSpeechRetired, speechActive: false, speechOwner: 0 }
pure def alwaysCaptureGeneration(c: CloudCapture): bool =
  c.generation >= 0 and c.speechOwner >= 0 and c.speechOwner <= c.generation and
  (c.phase == CloudSpeechListening implies c.generation > 0)
pure def alwaysRetiredCaptureIsSilent(c: CloudCapture): bool = c.phase == CloudSpeechRetired implies not(c.speechActive) and c.speechOwner == 0
pure def stepPublicationNeedsExactLiveCapture(before: CloudCapture, via: str, after: CloudCapture): bool =
  after.published != before.published implies via == "hearFinal" and ownsCloudSpeech(before)
pure def sometimesMutedSpeechDrains(c: CloudCapture): bool = c.phase == CloudSpeechDraining and c.speechActive and c.speechOwner == 0
pure def sometimesClosingCaptureFinishesItsFinal(c: CloudCapture): bool = c.phase == CloudSpeechDraining and c.published > 0
pure def sometimesCloudFinalPublishes(c: CloudCapture): bool = c.published > 0
```
