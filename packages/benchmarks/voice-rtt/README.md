# Voice RTT Benchmark

Provider-agnostic end-to-end latency harness for a conversational voice path:
Deepgram Flux turn detection, Cerebras `gemma-4-31b` streaming text generation,
and Cartesia Sonic 3.5 streaming speech synthesis.

The harness does not create an elizaOS runtime and does not call production
routes or UI. It measures the client-observable path directly through provider
adapters and emits a PR #15931-compatible trace shape: `X-Eliza-Voice-Trace-Id`
per turn plus `Server-Timing` components in the JSON artifact.

## Measured Checkpoints

- acoustic/input end
- STT eager end and final turn
- chat admission
- Cerebras preforward
- first text token
- first speakable phrase
- Cartesia request
- first audio frame
- client playout simulation
- interruption and playout silence for the barge-in case

## Run

```bash
# Deterministic no-key mode. Enforces gates.
bun run --cwd packages/benchmarks/voice-rtt bench:mock

# Write artifacts.
bun run --cwd packages/benchmarks/voice-rtt bench:mock -- --out=./results

# Opt-in live mode. Requires provider keys and corpus PCM files.
DEEPGRAM_API_KEY=... CEREBRAS_API_KEY=... CARTESIA_API_KEY=... \
  bun run --cwd packages/benchmarks/voice-rtt bench:live -- --audio-dir=./audio

# Staging cloud WebSocket session benchmark. Requires 16 kHz PCM files.
VOICE_STAGING_BEARER_TOKEN=... VOICE_STAGING_AGENT_ID=... \
VOICE_STAGING_CONVERSATION_ID=... VOICE_STAGING_AUDIO_DIR=./audio \
  packages/benchmarks/voice-rtt/scripts/staging-session.sh --runs=3 --out=./results/session

# Current staging batch route baseline through /api/v1/voice/tts and /stt.
VOICE_STAGING_BEARER_TOKEN=... \
  packages/benchmarks/voice-rtt/scripts/staging-batch.sh --runs=5 --out=./results/batch
```

Live mode expects `short.pcm`, `long.pcm`, `pause.pcm`, and `barge-in.pcm` in
the supplied audio directory, encoded as 16 kHz signed 16-bit little-endian PCM.
The fixture corpus is fixed in `fixtures/corpus.json`; committed text is used
for deterministic mock timing and for expected reply lengths, not logged by
default.

## Gates

Mock mode enforces:

- EOS to first audio P50 `< 1000ms`
- EOS to first audio P95 `< 1500ms`
- interruption to silence `< 300ms`
- zero audio frames accepted after interrupt silence

Live mode reports those gates as advisory unless `--enforce-live-gates` is
supplied.

## Privacy

Artifacts redact transcripts and model replies by default. They include only
trace IDs, provider request IDs, lengths, timings, stage attribution, and gate
results. Use `--unsafe-transcripts` only for a local diagnostic run where the
artifact will not be shared.

The staging tools never print bearer tokens or response text. The WebSocket
session report records redacted session IDs, WebSocket hosts, event names, and
latency metrics. The batch baseline stores generated probe audio under the
local work directory so the exact TTS output is fed into STT, but its JSON and
Markdown reports include only timings, byte counts, route paths, and errors.

## Staging Voice Ops

`configs/staging-session.json` describes the public staging URL, mint route,
WebSocket event names, hello and barge-in message names, chunk size, and
timeouts. The phase-1 route may not exist in an environment yet, so the runner
fails with a clear mint or event-mapping error instead of falling back to
provider-direct adapters.

Session benchmark contract:

- `POST /api/v1/voice/session` with `Authorization: Bearer ...` and JSON body
  `agentId`, `conversationId`, `transport: "websocket"`.
- Expect `wsUrl`, `token`, and `sessionId`.
- Send hello JSON with token, protocol `1`, and `pcm16` at 16 kHz.
- Stream `<case>.pcm` in real-time 80 ms, 2560-byte chunks.
- Observe configured `ready`, `stt_final`, `llm_first_text`, and first binary
  TTS frame.
- For `barge-in.pcm`, send configured `barge_in` after the first binary frame,
  measure interrupt acknowledgement, wait the guard interval, and count
  post-interrupt binary frames.

`configs/staging-batch.json` describes the current batch TTS/STT endpoints and
curl response handling. Defaults target `https://staging.elizacloud.ai` and
route paths `/api/v1/voice/tts` and `/api/v1/voice/stt`. The runner generates
deterministic short and long speech probes through staging TTS, feeds those
exact audio files into staging STT, captures curl DNS/connect/TLS/TTFB/total
timings, extracts STT `duration_ms`, and reports p50/p90/p95.

## Provider Contracts

Adapters implement `SttAdapter`, `LlmAdapter`, and `TtsAdapter` from
`src/types.ts`. Future OpenRouter or alternate provider adapters should return
the same timestamped contracts rather than changing scoring/reporting code.

The live adapter follows the documented provider APIs:

- Deepgram Flux turn-based audio: `wss://api.deepgram.com/v2/listen`
- Cerebras chat completions streaming: `POST /v1/chat/completions`
- Cartesia Text-to-Speech WebSocket: `/tts/websocket`

## Test

```bash
bun run --cwd packages/benchmarks/voice-rtt test
bun run --cwd packages/benchmarks/voice-rtt typecheck
bun run --cwd packages/benchmarks/voice-rtt format:check
```
