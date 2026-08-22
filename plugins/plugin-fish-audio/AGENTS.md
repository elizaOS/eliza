# @elizaos/plugin-fish-audio

Fish Audio model-provider plugin for elizaOS. It registers only `ModelType.TEXT_TO_SPEECH` and remains unavailable unless enablement and server-side data-governance approval are both explicit.

## Commands

```bash
bun run --cwd plugins/plugin-fish-audio test
bun run --cwd plugins/plugin-fish-audio typecheck
bun run --cwd plugins/plugin-fish-audio lint:check
bun run --cwd plugins/plugin-fish-audio build
```

## Contracts

- Use Fish's public realtime endpoint `wss://api.fish.audio/v1/tts/live`.
- Encode provider frames with MessagePack via `@msgpack/msgpack`.
- Bind `s1`, `s2-pro`, `s2.1-pro`, or `s2.1-pro-free` through the WebSocket `model` header; default to `s2.1-pro`.
- Emit raw PCM16 mono 24 kHz and require a caller-provided reference or voice ID.
- Request Fish's `balanced` latency mode with a 100-character chunk length so
  callers receive incremental audio frames instead of a buffered response.
- Use the Node `ws` transport for authenticated connections; browsers cannot set the required WebSocket headers.
- Return `AudioStreamResult` only when `audioStream: true`; otherwise return buffered bytes for core compatibility.
- Cap retained PCM bytes and total synthesis wall time; provider stalls or
  oversized responses must close the socket and reject both result surfaces.
- Treat `FISH_AUDIO_DATA_GOVERNANCE_APPROVED` as a server/operator-only gate.
  Fish receives submitted text and the reference ID, so credentials and the
  feature flag alone must never authorize provider egress.
- Keep live tests skipped unless a caller explicitly provides `FISH_AUDIO_API_KEY` and a consented `FISH_AUDIO_REFERENCE_ID`/`FISH_AUDIO_VOICE_ID`.
- Keep offline protocol coverage on the production WebSocket/MessagePack client
  by connecting it to `@elizaos/cloud-test-mocks/fish-audio`; do not replace
  client methods with an in-memory socket when claiming integration evidence.
- Classify authentication, rate limit, timeout, cancellation, transport,
  malformed response, and provider failures explicitly so caller-owned retry
  policy never retries permanent failures.
