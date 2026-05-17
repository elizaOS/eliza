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
- ASR partial prepare-only handling
- runtime handoff
- model first token
- model deltas when explicitly enabled
- TTS started / first audio
- playback started
- latency budget evaluation

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
- `ELIZA_VOICE_STREAM_ASR_PARTIALS=1` allows ASR partial preparation mode
- `ELIZA_VOICE_TRACE_MODEL_DELTAS=1` records model deltas into trace

ASR partial streaming is disabled by default. When enabled without a verified
draft runtime API, partials are marked as prepare-only and never sent to
conversation message routes. The final ASR transcript is the only committed user
message, and it is committed once per turn.

Latency budgets are reporting signals, not production hard failures. Defaults
are:

- input to VAD: 50ms
- VAD to ASR partial: 150ms
- ASR partial to runtime prepare: 100ms
- ASR final to runtime commit: 100ms
- runtime to first token: 500ms
- first token to TTS request: 80ms
- TTS request to first audio: 400ms
- first audio to playback: 100ms
- total to first token: 900ms
- total to first audio: 1200ms
- total to playback: 1400ms

Each target has an `ELIZA_VOICE_BUDGET_*_MS` override matching the stage name.

The streaming coordinator models the safe path:

ASR partials -> local prepare state -> single ASR final commit -> runtime first
token -> ordered TTS chunks -> first audio -> playback acknowledgement.

TTS chunking starts synthesis before the full model response completes when a
streaming TTS implementation is available. Defaults are:

- `ELIZA_VOICE_TTS_CHUNK_MIN_CHARS=40`
- `ELIZA_VOICE_TTS_CHUNK_MAX_CHARS=240`
- `ELIZA_VOICE_TTS_CHUNK_MAX_DELAY_MS=300`
- `ELIZA_VOICE_TTS_CHUNK_FLUSH_ON_PUNCTUATION=true`

Barge-in uses `voiceInterrupt` and the adapter interruption hook when live mode
supports it. Mock/text mode validates turn interruption deterministically.

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
- host playback acknowledgement for local TTS bytes is not wired yet; the
  default playback adapter reports `playbackAckSupported: false` and live
  playback returns `VOICE_AUDIO_OUTPUT_UNAVAILABLE` unless a concrete playback
  implementation is injected
- streaming TTS depends on an adapter/runtime route that can emit first-audio
  events; otherwise the service reports `ttsStreamingSupported: false`
- narrower host permissions should replace temporary trusted host request reuse

The real local path is wired behind flags:

VAD / turn detection -> ASR partials/final -> Eliza-1/runtime -> Kokoro or
OmniVoice TTS -> playback acknowledgement, with every latency mark streamed
into trace.
