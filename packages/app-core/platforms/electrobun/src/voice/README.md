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
- `ELIZA_VOICE_LIVE_AUDIO=1` is reserved for microphone/playback validation

Current limitations:

- default tests do not exercise real microphone capture
- default tests do not run native ASR/TTS
- live VAD/ASR/TTS wiring remains the next phase
- narrower host permissions should replace temporary trusted host request reuse

Phase 15 should wire the real local path:

VAD / turn detection -> ASR partials -> Eliza-1/runtime -> Kokoro or OmniVoice
TTS -> playback, with every latency mark streamed into trace.
