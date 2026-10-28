# @elizaos/plugin-local-inference

Eliza-1 local inference provider: text generation, embeddings, TTS, ASR, image
generation, and vision description — all served through the elizaOS model-handler
registry without a network call.

Local text, embeddings, speech, and vision use supported native backends and downloaded
model artifacts. Root installation builds/verifies the desktop fused library; GGUF
models download during warmup. See [native/README.md](native/README.md) for native
builds. Missing hardware/models are unavailable, not fabricated inference.

Initial model downloads require a network connection and sufficient disk space. Register this plugin in the agent configuration; select local/cloud routing in Settings → Model Routing.

Paradee speech is part of this plugin. Its desktop worker registers with the
shared model registry and releases native memory on voice disarm or memory
pressure. The next request reloads it. Android bindings and pinned bundle inputs
live in [native/android](native/android/README.md); they use `libelizainference`
and do not register a separate Paradee plugin.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-local-inference build  # build
bun run --cwd plugins/plugin-local-inference test   # tests
```

`bench:streaming` and `bench:stt` measure runtime dispatch with simulated
providers. `voice:hardware --help` describes opt-in model/artifact and trace
checks; these do not run as part of the offline unit suite.

## Live voice transcription

On Android the agent's TRANSCRIPTION handler streams through the bionic host
when the host reports a streaming ASR backend (Phonon-2): the utterance goes
through `BionicHostLoader.createStreamingTranscriber()` and `flush()` returns
the final. Batch `op:"asr"` runs only when the host answers `STREAM_UNSUPPORTED`
(a host library built without the Parakeet-TDT backend). Phonon-2 is the only
local ASR model.

For live text while the user speaks, a client streams mic audio to
`POST /api/asr/local-inference/live` (auth as `/api/asr/local-inference`):

```json
{
  "sessionId": "phone-1",
  "roomId": "<conversation room, optional>",
  "frames": [{ "pcm16": "<base64 LE-s16>", "sampleRate": 16000, "channels": 1,
               "samples": 320, "rms": 0.02, "timestamp": 1234, "frameIndex": 61 }],
  "vad": [{ "type": "speech-start" }],
  "close": false
}
```

`frames` use the `/api/voice/audio-frames` wire format (16 kHz mono). `vad`
carries the Silero segment edges for that audio (on Android the Silero VAD runs
in the app process, which the musl agent cannot load); per request the session
applies `speech-start`, then the frames, then `speech-end`. A request that
carries `speech-end` (or `close: true`) answers with the final transcript:
`{ ok, sessionId, mode, framesReceived, final: { turnId, text, mode,
asrFinalFromSpeechEndMs } }`. At most 4 sessions; an idle session is dropped
after 60 s. `GET /api/asr/local-inference/live/status` returns
`{ ready, streaming, sessions, maxSessions }`.

Interim text arrives on the API WebSocket as ephemeral `agent_event` frames on
the `voice-transcript` stream. The server broadcasts them without buffering (no
replay after reconnect, no conversation routing), and the agent never stores or
logs their text:

```json
{
  "type": "agent_event", "version": 1, "ephemeral": true, "eventId": "eph-12",
  "stream": "voice-transcript", "runId": "voice-transcript:phone-1", "seq": 3,
  "ts": 1760440000000, "agentId": "…", "roomId": "…",
  "payload": { "type": "voice-transcript", "phase": "partial",
               "sessionId": "phone-1", "turnId": "vt-…", "text": "set a timer", "seq": 2 }
}
```

`phase` is `speech-start` (clear the interim text), `partial` (`text` is the full
running transcript, not a delta; `seq` increases within the turn), `final`
(`text`, `mode` = `stream` | `batch`, `asrFinalFromSpeechEndMs`), or `error`
(`code: "ASR_FAILED"`). Drop events whose `turnId` is not the current turn.

End-of-turn latency goes to the shared `voiceLatencyTracer`
(`src/services/latency-trace.ts`): `vad-speech-end` marks the last audio frame of the
utterance, giving `asrFinalFromSpeechEndMs` (last frame → final transcript) and
`ttftFromSpeechEndMs` (last frame → first streamed LLM token of the reply, which
the local text handler marks). One `[voice-latency]` log line per turn carries
the numbers, never text.
