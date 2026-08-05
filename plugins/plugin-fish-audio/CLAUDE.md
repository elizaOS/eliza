# @elizaos/plugin-fish-audio

Fish Audio model-provider plugin for elizaOS. It registers only `ModelType.TEXT_TO_SPEECH` and remains default-off unless `ELIZA_TTS_FISH_ENABLED` is truthy.

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
- Use the Node `ws` transport for authenticated connections; browsers cannot set the required WebSocket headers.
- Return `AudioStreamResult` only when `audioStream: true`; otherwise return buffered bytes for core compatibility.
- Keep live tests skipped unless a caller explicitly provides `FISH_AUDIO_API_KEY` and a consented `FISH_AUDIO_REFERENCE_ID`/`FISH_AUDIO_VOICE_ID`.
