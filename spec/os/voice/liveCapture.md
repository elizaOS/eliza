# Live voice capture

How the device's live capture turns the microphone into speech segments
for the agent: 16 kHz mono PCM read in 32 ms windows, Silero VAD on each
window through the local inference library, and the frames of each
segment with its edges. The microphone slot and the capture's admission
are [the microphone's](./microphone.md); the reply it may interrupt is
[speech output's](./speechOutput.md). The capture, its gate and the pipe
to the agent are the `local-inference` module's Java; the product's
speech bridge subclasses `LocalSpeechBridgePlugin` and supplies only its
identity, its owner-bound transport and its prompts.

## Story: Talk to my agent on the device without the renderer hearing my audio

> As the owner, I want my phone to send only what I say, and only to my
> own agent, so that silence, the room and my audio never reach anything
> else, and stopping cuts it off at once.

### Only a speech segment and its short pre-roll leave the capture, and nothing is stored

A segment opens after the start run of consecutive windows at or above
0.5 and closes after the end hangover of consecutive windows below 0.35;
the run is 1 to 10 windows, so it never exceeds the 10-window pre-roll
that keeps the opening syllable, and the hangover is at least one window.
Outside a segment a window only joins the pre-roll; the frames of a
window leave only while the segment is open, at its opening edge with the
pre-roll, or at its closing edge. Nothing is written to storage, and the
buffers are cleared when the capture ends.

```quint
type VadGate = { speaking: bool, above: int, below: int }
type VadEdge = NoEdge | SpeechStart | SpeechEnd
type GateStep = { gate: VadGate, edge: VadEdge }
pure val vadStartMilli = 500
pure val vadEndMilli = 350
pure val prerollWindows = 10
pure def gateAdmitted(startWindows: int, endWindows: int): bool =
  startWindows >= 1 and startWindows <= prerollWindows and endWindows >= 1
pure def acceptWindow(g: VadGate, milli: int, startWindows: int, endWindows: int): GateStep = {
  val above = if (milli >= vadStartMilli) g.above + 1 else 0
  val below = if (milli < vadEndMilli) g.below + 1 else 0
  if (not(g.speaking))
    (if (above >= startWindows) { gate: { speaking: true, above: 0, below: 0 }, edge: SpeechStart }
     else { gate: { ...g, above: above }, edge: NoEdge })
  else
    (if (below >= endWindows) { gate: { speaking: false, above: 0, below: 0 }, edge: SpeechEnd }
     else { gate: { ...g, below: below }, edge: NoEdge })
}
pure def windowLeaves(g: VadGate, edge: VadEdge): bool = g.speaking or edge != NoEdge
pure val gValues = Set(
  { speaking: false, above: 0, below: 0 }, { speaking: false, above: 1, below: 0 },
  { speaking: true, above: 0, below: 0 }, { speaking: true, above: 0, below: 15 })
pure val milliValues = Set(0, 349, 350, 499, 500, 1000)
pure val startWindowsValues = Set(1, 2, 10)
pure val endWindowsValues = Set(1, 16)
pure def lawASegmentOpensOnlyAfterItsSpeechRun(g: VadGate, milli: int, startWindows: int, endWindows: int): bool =
  (gateAdmitted(startWindows, endWindows) and acceptWindow(g, milli, startWindows, endWindows).edge == SpeechStart)
    implies (not(g.speaking) and milli >= vadStartMilli and g.above + 1 >= startWindows)
pure def lawSilenceOutsideASegmentNeverLeaves(g: VadGate, milli: int, startWindows: int, endWindows: int): bool = {
  val accepted = acceptWindow(g, milli, startWindows, endWindows)
  val silentOutside = gateAdmitted(startWindows, endWindows) and not(g.speaking) and accepted.edge == NoEdge
  silentOutside implies not(windowLeaves(accepted.gate, accepted.edge))
}
pure def lawASegmentClosesOnlyAfterItsHangover(g: VadGate, milli: int, startWindows: int, endWindows: int): bool =
  (gateAdmitted(startWindows, endWindows) and acceptWindow(g, milli, startWindows, endWindows).edge == SpeechEnd)
    implies (g.speaking and milli < vadEndMilli and g.below + 1 >= endWindows)
```

### A routed capture sends its segments only to the owner's agent, in order and bounded, and a stop cuts them off

With the owner's agent as its route, a capture's frames go only to that
agent's voice session (a 36-character session id and a room of at most
128 characters) and the host receives the VAD edges and level with no
frames. The microphone opens while that session warms: what the capture
takes meanwhile waits within the bounds below, and no audio is sent before
the session is ready, even after a stop that keeps the tail; only a
cancelled route skips the warm-up and drops what waits. A session not
ready within 10 s ends the route as `TRANSPORT`, reported once; the
deadline never ends a session that became ready, or a route already
cancelled or finished. Batches go out in the order they were taken. A
batch is at most 32 frames and 128 KiB, and at most about 4 s of frames (125) and 1 MiB
wait; a batch over either bound ends the route as `BACKPRESSURE`, never
dropping frames silently. Nothing taken after the stop's cutoff is sent,
and a discarding stop also drops what still waits.

```quint
type OfferVerdict = BatchQueued | RouteClosed | Backpressure
pure val maxBatchFrames = 32
pure val maxBatchChars = 131072
pure val maxQueuedFrames = 125
pure val maxQueuedChars = 1048576
pure def offerVerdict(closing: bool, frames: int, chars: int, queuedFrames: int, queuedChars: int): OfferVerdict =
  if (closing) RouteClosed
  else if (frames <= maxBatchFrames and chars <= maxBatchChars and queuedFrames + frames <= maxQueuedFrames and queuedChars + chars <= maxQueuedChars) BatchQueued
  else Backpressure
pure def hostFrames(routed: bool, frames: int): int = if (routed) 0 else frames
pure val pipeReadyMs = 10000
pure def audioSent(ready: bool, cancelled: bool): bool = ready and not(cancelled)
pure def warmupExpires(ready: bool, ended: bool, elapsedMs: int): bool =
  elapsedMs >= pipeReadyMs and not(ready) and not(ended)
pure def sentAfterStop(takenAtMs: int, cutoffMs: int, discard: bool, waiting: bool): bool =
  takenAtMs <= cutoffMs and not(discard and waiting)
pure val framesValues = Set(0, 1, 32, 33)
pure val charsValues = Set(0, 131072, 131073)
pure val queuedFramesValues = Set(0, 93, 124, 125)
pure val queuedCharsValues = Set(0, 917504, 1048576)
pure val takenAtMsValues = Set(0, 1, 2)
pure val cutoffMsValues = Set(0, 1)
pure val elapsedMsValues = Set(0, 9999, 10000, 10001)
pure def lawAQueuedBatchStaysWithinEveryBound(closing: bool, frames: int, chars: int, queuedFrames: int, queuedChars: int): bool =
  offerVerdict(closing, frames, chars, queuedFrames, queuedChars) == BatchQueued implies
    (not(closing) and frames <= maxBatchFrames and chars <= maxBatchChars and queuedFrames + frames <= maxQueuedFrames and queuedChars + chars <= maxQueuedChars)
pure def lawTheRendererGetsNoRoutedAudio(frames: int): bool = hostFrames(true, frames) == 0
pure def lawNoAudioIsSentBeforeTheSessionIsReady(ready: bool, cancelled: bool): bool =
  audioSent(ready, cancelled) implies ready
pure def lawTheDeadlineNeverEndsAReadySession(ready: bool, ended: bool, elapsedMs: int): bool =
  ready implies not(warmupExpires(ready, ended, elapsedMs))
pure def lawNothingTakenAfterTheCutoffIsSent(takenAtMs: int, cutoffMs: int, discard: bool, waiting: bool): bool =
  takenAtMs > cutoffMs implies not(sentAfterStop(takenAtMs, cutoffMs, discard, waiting))
```

### An availability probe keeps at most one idle detector, which the next capture takes

Asking whether VAD is usable opens its context and at most one idle
detector the first time, and answers later probes from that without
opening more. The next capture takes that idle detector instead of opening
another. Trimming memory or closing the session frees the idle detector,
and once the context is freed the next probe checks again.

```quint
type VadProbe = { contextOpen: bool, idle: int, detectors: int, verified: bool }
pure def probeVad(p: VadProbe): VadProbe =
  if (p.verified) p
  else { contextOpen: true, idle: if (p.detectors == 0) 1 else p.idle, detectors: p.detectors, verified: true }
pure def detectorOpensNatively(p: VadProbe): bool = p.idle == 0
pure def openDetector(p: VadProbe): VadProbe = { contextOpen: true, idle: 0, detectors: p.detectors + 1, verified: true }
pure def trimVad(p: VadProbe): VadProbe = {
  val kept = p.contextOpen and p.detectors > 0
  { contextOpen: kept, idle: 0, detectors: p.detectors, verified: p.verified and kept }
}
pure val vadValues = Set(
  { contextOpen: false, idle: 0, detectors: 0, verified: false }, { contextOpen: true, idle: 1, detectors: 0, verified: true },
  { contextOpen: true, idle: 0, detectors: 1, verified: true }, { contextOpen: true, idle: 0, detectors: 2, verified: false })
pure def lawAProbeKeepsAtMostOneIdleDetector(vad: VadProbe): bool =
  vad.idle <= 1 implies probeVad(vad).idle <= 1
pure def lawARepeatedProbeOpensNothingMore(vad: VadProbe): bool =
  probeVad(probeVad(vad)).idle == probeVad(vad).idle and probeVad(probeVad(vad)).contextOpen == probeVad(vad).contextOpen
pure def lawTheNextCaptureTakesTheIdleDetector(vad: VadProbe): bool = {
  val probed = probeVad(vad)
  probed.idle == 1 implies (not(detectorOpensNatively(probed)) and openDetector(probed).idle == 0)
}
pure def lawATrimFreesTheIdleDetectorAndForgetsAFreedContext(vad: VadProbe): bool = {
  val trimmed = trimVad(vad)
  trimmed.idle == 0 and (not(trimmed.contextOpen) implies not(trimmed.verified))
}
```
