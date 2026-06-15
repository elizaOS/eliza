# Ambient Audio — Implementation Notes

This directory contains the host-independent ambient-audio primitives:

- `types.ts` defines the consent, audio-frame, transcript, response-gate, and
  service contracts.
- `consent.ts` enforces explicit owner consent before capture can start.
- `replay-buffer.ts` stores a bounded 16 kHz mono Int16 tail and clears it on
  stop.
- `response-gate.ts` keeps response decisions pure and threshold-driven.
- `service.ts` provides an in-memory service for tests and local wiring.

The native capture, VAD, ASR, and persistence adapters still live outside this
directory. They must feed these contracts rather than bypassing consent,
retention, or response gating.

## Native Audio Capture

- macOS: AVAudioEngine / CoreAudio tap, request
  `NSMicrophoneUsageDescription`, handle device-change notifications.
- Windows: WASAPI loopback + capture endpoint, MMDevice notifications for
  hot-swap.
- Linux: PipeWire preferred, PulseAudio source-output acceptable, ALSA only as
  a last resort.
- iOS: AVAudioSession with `.record` category; background audio entitlement is
  out of scope for the first release, and first-run setup must reflect that.
- Android: `AudioRecord` + `MediaRecorder.AudioSource.VOICE_RECOGNITION`;
  foreground service required for capture longer than five seconds.

Frames must be normalized to 16 kHz mono Int16 before reaching
`ReplayBuffer.push`.

## VAD

- Silero VAD v5 is the preferred model; webrtcvad is an acceptable browser or
  low-resource fallback.
- Run on a 30 ms hop. Smooth with a 200 ms close window so natural pauses do not
  flap `ResponseGateSignals.vadActive`.

## Wake Word / Intent

- openWakeWord or a distilled local wake classifier feeds `wakeIntent` as a
  0..1 score.
- `directAddress` requires either an addressee classifier or a name match
  against the owner profile display name plus nicknames from `voice-profiles`.

## ASR

- Whisper-small int8 is the working target for desktop. Mobile should use the
  bundled llama.cpp/GGUF path when available.
- Streaming transcription should use a one-second commit window; segments map
  directly onto `TranscribedSegment`.
- `confidence` must come from model evidence such as per-segment avg-logprob.

## Retention

- Replay-buffer retention is enforced by `ReplayBuffer.maxSeconds`.
- The default first-release policy is a 30-second volatile tail, cleared on
  `stop()`.
- Transcripts can be persisted only after explicit owner action such as “save
  this conversation”. Default storage remains volatile.

## Consent UX Integration

- First-run setup owns the initial grant. `AmbientAudioConsentState` is the
  service-side enforcement point.
- Pause must be reachable from the desktop bar in one click.
- An always-on indicator must reflect `mode()` continuously; the renderer lives
  in `packages/ui/src/companion/desktop-bar/`.

## Response Gating

- `decideResponse` is intentionally pure and threshold-driven.
- Production should drive `ownerConfidence` from
  `services/voice-profiles/owner-confidence.ts`.
- `contextExpectsReply` should come from a small turn-prediction classifier,
  separate from conversational turn-end detection.
