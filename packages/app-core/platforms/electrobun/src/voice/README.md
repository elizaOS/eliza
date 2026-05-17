# Voice Pipeline

`eliza.voice` is the Electrobun host voice pipeline layer for local voice
instrumentation. It is a pipeline and trace source, not a settings panel.

The default mode is deterministic mock/text-only execution:

- no microphone access
- no model download
- no real ASR
- no real TTS
- no playback requirement

The service records voice turns, stage marks, latency summaries, and trace
events for:

- VAD
- ASR partial/final
- runtime handoff
- model first token
- TTS started / first audio
- playback started

Component discovery prefers existing elizaOS local-inference sources:

1. local-inference runtime API when `ELIZA_VOICE_LIVE_RUNTIME=1`
2. `@elizaos/shared` local-inference catalog and voice model metadata
3. static host input/playback placeholders

Known model components such as OmniVoice, Kokoro, ASR, VAD, turn detection,
speaker attribution, and emotion classification are reported as `available`
when the repository catalog or voice model metadata advertises them. A component
is reported as `ready` only when a live runtime can prove readiness.

Trace integration is opt-in:

- pass `trace: true` to `voiceStart`, `voiceInjectTranscript`, or `voiceSpeak`
- pass `autoOpenTraceView: true` to open the dynamic `agent.run.trace` view
- set `ELIZA_VOICE_TRACE_AUTO_OPEN=1` in dev/test mode

Live voice work is deliberately guarded:

- `ELIZA_VOICE_LIVE_RUNTIME=1` allows local runtime API probing
- `ELIZA_VOICE_LIVE_AUDIO=1` allows live listening adapters to start
- `ELIZA_VOICE_LIVE_ASR=1` allows adapter-backed ASR calls
- `ELIZA_VOICE_LIVE_TTS=1` allows adapter-backed TTS calls

The live adapter reuses existing runtime and local-inference routes when they
are available:

- `/api/local-inference/voice-models` for voice model/component snapshots
- `/api/asr/local-inference` for final ASR transcripts
- `/api/tts/local-inference` for local TTS audio
- existing conversation message routes for runtime/Eliza-1 handoff

ASR partials, VAD, and turn events are consumed through adapter callbacks when
the underlying TalkMode or local-inference service exposes them. The current
HTTP ASR route only proves final transcript flow, so partial support remains
adapter/runtime dependent.

Current limitations:

- default tests do not exercise real microphone capture
- default tests do not run native ASR/TTS
- host playback for local TTS bytes is not wired yet; adapter playback returns
  `VOICE_AUDIO_OUTPUT_UNAVAILABLE` unless a concrete playback implementation is
  injected
- narrower host permissions should replace temporary trusted host request reuse

The real local path is wired behind flags:

VAD / turn detection -> ASR partials/final -> Eliza-1/runtime -> Kokoro or
OmniVoice TTS -> playback acknowledgement, with every latency mark streamed
into trace.
