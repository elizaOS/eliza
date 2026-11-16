# Native cloud live speech custody

A consumer's cloud voice driver can stream live speech through the native
cloud bridge when that bridge is available and resident inference is not
the direct route. The bridge owns credentials and PCM; the renderer
receives decoded lifecycle, level and text events. The server half is
[cloud speech](../../cloud/speech.md); the paid lease and consent deadline
are [cloud speech lease](./cloudSpeechLease.md), and the handover to a
successor session is [cloud speech successor](./cloudSpeechSuccessor.md).

## Story: Reopen capture without inheriting a provider turn from playback

> As a person talking through cloud speech, I want words spoken while the
> assistant was talking never to be taken as my next turn.

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
and its listeners. Speech audio receipt and cancellation belong to
[playback](./playback.md).

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
pure def stepPublicationNeedsExactLiveCapture(before: CloudCapture, via: str, after: CloudCapture): bool =
  after.published != before.published implies via == "hearFinal" and ownsCloudSpeech(before)
pure def sometimesMutedSpeechDrains(c: CloudCapture): bool = c.phase == CloudSpeechDraining and c.speechActive and c.speechOwner == 0
pure def sometimesClosingCaptureFinishesItsFinal(c: CloudCapture): bool = c.phase == CloudSpeechDraining and c.published > 0
pure def sometimesCloudFinalPublishes(c: CloudCapture): bool = c.published > 0
```

### A retired capture has no active speech and no speech owner

Discovered by the proof: without it, an open the bridge rejected could
retire the session while a captured speech owner remained, and a late
final could then be taken as a turn of a capture that no longer exists.

```quint
pure def alwaysRetiredCaptureIsSilent(c: CloudCapture): bool = c.phase == CloudSpeechRetired implies not(c.speechActive) and c.speechOwner == 0
```
