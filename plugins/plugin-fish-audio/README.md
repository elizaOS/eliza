# @elizaos/plugin-fish-audio

Fish Audio realtime text-to-speech provider for elizaOS. The plugin is default-off and only registers `ModelType.TEXT_TO_SPEECH` when enablement and operator data-governance approval are both explicit.

## Configuration

- `ELIZA_TTS_FISH_ENABLED=true` enables registration.
- `FISH_AUDIO_DATA_GOVERNANCE_APPROVED=true` is a server/operator-only gate.
  Set it only after the provider's retention, training, and contractual policy
  has been attested for the deployment. Without it, Fish is unavailable even
  when the feature flag and credentials are present.
- `FISH_AUDIO_API_KEY` authenticates Fish Audio.
- `FISH_AUDIO_MODEL=s2.1-pro` by default; `s1`, `s2-pro`, and `s2.1-pro-free` are also accepted.
- `FISH_AUDIO_REFERENCE_ID` or `FISH_AUDIO_VOICE_ID` selects the Fish voice/reference.
- `FISH_AUDIO_FORMAT=pcm` and `FISH_AUDIO_SAMPLE_RATE=24000` default to Fish's raw mono PCM stream at 24 kHz.
- `FISH_AUDIO_MAX_BUFFER_BYTES=16777216` caps retained PCM for the legacy
  `bytes` result, including streaming calls.
- `FISH_AUDIO_SYNTHESIS_TIMEOUT_MS=120000` caps the complete provider round trip.

Fish receives the complete submitted text and the configured reference ID.
Neither flag nor credential presence constitutes retention/training approval;
the separate governance gate makes the provider visibly unavailable until an
authorized operator records that approval. Cloud production additionally
forces both Fish gates off.

The Node handler uses `wss://api.fish.audio/v1/tts/live` and MessagePack frames. It returns `AudioStreamResult` only when `audioStream: true`; otherwise it buffers and returns bytes for core compatibility. Browser use fails explicitly because Fish authentication requires WebSocket headers that browsers cannot set.

## Live test

A live integration test is intentionally skipped unless a funded key and voice are supplied:

```bash
ELIZA_TTS_FISH_ENABLED=true \
FISH_AUDIO_DATA_GOVERNANCE_APPROVED=true \
FISH_AUDIO_API_KEY=... \
FISH_AUDIO_REFERENCE_ID=... \
FISH_AUDIO_EVIDENCE_PATH=/tmp/fish-audio-evidence.wav \
bun run --cwd plugins/plugin-fish-audio test -- --testNamePattern "live Fish Audio"
```

`FISH_AUDIO_VOICE_ID` may be used instead of `FISH_AUDIO_REFERENCE_ID`. The
live test reports redacted first-audio and completion timing, incremental audio
frame count, byte counts, and the WAV SHA-256. It fails if Fish buffers the
response into one frame instead of streaming audio before completion. When
`FISH_AUDIO_EVIDENCE_PATH` is set, it also writes the raw
24 kHz mono PCM response into an inspectable WAV at that path. Evidence output
belongs outside the repository and must not contain the API key.

The live WebSocket uses `Authorization: Bearer <FISH_AUDIO_API_KEY>` and a `model` connection header. It sends MessagePack frames in this order: `{ event: "start", request: { text: "", reference_id, format: "pcm", sample_rate: 24000, latency: "balanced", chunk_length: 100 } }`, one `{ event: "text", text }`, `{ event: "flush" }`, then `{ event: "stop" }`. This benchmarked configuration produced multiple playable frames with substantially lower time to first audio than Fish's `normal` latency mode.

## Offline protocol integration

Offline integration tests use the resettable Fish Audio protocol service from
`@elizaos/cloud-test-mocks/fish-audio`. They exercise the production
WebSocket/MessagePack client with seeded chunks, cancellation, authentication,
rate limiting, malformed frames, provider failures, stalls, deterministic
reset, and credential-redacted ordered readback without provider traffic.
