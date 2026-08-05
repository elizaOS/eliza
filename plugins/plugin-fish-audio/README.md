# @elizaos/plugin-fish-audio

Fish Audio realtime text-to-speech provider for elizaOS. The plugin is default-off and only registers `ModelType.TEXT_TO_SPEECH` when `ELIZA_TTS_FISH_ENABLED` is truthy.

## Configuration

- `ELIZA_TTS_FISH_ENABLED=true` enables registration.
- `FISH_AUDIO_API_KEY` authenticates Fish Audio.
- `FISH_AUDIO_MODEL=s2.1-pro` by default; `s1`, `s2-pro`, and `s2.1-pro-free` are also accepted.
- `FISH_AUDIO_REFERENCE_ID` or `FISH_AUDIO_VOICE_ID` selects the Fish voice/reference.
- `FISH_AUDIO_FORMAT=pcm` and `FISH_AUDIO_SAMPLE_RATE=24000` default to Fish's raw mono PCM stream at 24 kHz.

The Node handler uses `wss://api.fish.audio/v1/tts/live` and MessagePack frames. It returns `AudioStreamResult` only when `audioStream: true`; otherwise it buffers and returns bytes for core compatibility. Browser use fails explicitly because Fish authentication requires WebSocket headers that browsers cannot set.

## Live test

A live integration test is intentionally skipped unless a funded key and voice are supplied:

```bash
ELIZA_TTS_FISH_ENABLED=true \
FISH_AUDIO_API_KEY=... \
FISH_AUDIO_REFERENCE_ID=... \
bun run --cwd plugins/plugin-fish-audio test -- --testNamePattern "live Fish Audio"
```

The live WebSocket uses `Authorization: Bearer <FISH_AUDIO_API_KEY>` and a `model` connection header. It sends MessagePack frames in this order: `{ event: "start", request: { text: "", reference_id, format: "pcm", sample_rate: 24000, latency: "normal" } }`, one `{ event: "text", text }`, `{ event: "flush" }`, then `{ event: "stop" }`.
