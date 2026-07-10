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
```
