# Ambient Audio — Implementation Notes

This directory is a **scaffold only**. The types, consent state machine, ring-buffer data structure, response-gate pure function, and `MockAmbientAudioService` are real. Everything below has to be done before this becomes a shipping feature.

## Native audio capture

- macOS: AVAudioEngine / CoreAudio tap, request `NSMicrophoneUsageDescription`, handle device-change notifications.
- Windows: WASAPI loopback + capture endpoint, MMDevice notifications for hot-swap.
- Linux: PipeWire (preferred) or PulseAudio source-output, fall back to ALSA.
- iOS: AVAudioSession with `.record` category; background audio entitlement is **out of scope** — onboarding must reflect this constraint.
- Android: `AudioRecord` + `MediaRecorder.AudioSource.VOICE_RECOGNITION`, foreground service required for >5s capture.

Frames must be normalized to 16 kHz mono Int16 before reaching `ReplayBuffer.push`.

## VAD

- Silero VAD v5 (recommended) or webrtcvad as a fallback. The signal feeds `ResponseGateSignals.vadActive`.
- Run on a 30 ms hop. Smooth with a 200 ms close-window so we don't flap during natural pauses.

## Wake-word / intent

- openWakeWord or a distilled local wake-classifier feeds `wakeIntent` (0..1 score).
- `directAddress` requires either an addressee classifier or a name-match against the owner profile display name + nicknames pulled from `voice-profiles`.

## ASR

- Whisper-small (int8) is the working target for desktop; CTranslate2 build for ARM, GGUF for the bundled llama.cpp path on mobile.
- Streaming transcription with 1 s commit window; segments map directly onto `TranscribedSegment`.
- `confidence` should be derived from the model's per-segment avg-logprob, not faked.

## Retention

- Replay buffer max is enforced by `ReplayBuffer.maxSeconds`. Default policy for the first ship: 30 s tail, drop on pause.
- The "silent trace" (heard but not responded to) is for an in-app debug pane only. It must respect the same retention policy and be cleared on `stop()`.
- Transcripts can be persisted only after explicit owner action ("save this conversation"). Default = volatile.

## Consent UX integration

- The onboarding flow (Workstream F) owns first-grant consent. This service must refuse to `start()` unless a `ConsentRecord` exists.
- Pause must be reachable from the desktop bar (Workstream H) in <=1 click.
- An always-on indicator must reflect `mode()` continuously; the renderer is in `packages/ui/src/companion/desktop-bar/`.

## Response gating

- `decideResponse` is intentionally pure and threshold-driven. Production should drive `ownerConfidence` from `services/voice-profiles/owner-confidence.ts` and `contextExpectsReply` from a small turn-prediction classifier (separate from the swarm's `turn-intl` work, which is conversational-turn-end detection, not the same thing).

## Cross-cutting

- Audit log of every gate decision lives in the agent's memory store with a `gate-decision` fact type. Schema is out of scope here.
- Threat-model write-up belongs alongside the owner-confidence work in `voice-profiles/IMPL_NOTES.md`.
