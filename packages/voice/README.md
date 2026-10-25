# @elizaos/voice

Browser-safe acoustic processing, turn analysis and speech metrics shared by UI,
native bridges and inference plugins. Import the public package barrel; internal
files import their defining modules directly. Batch renderer hosts can import
`@elizaos/voice/turn` for only the response gate and end-of-turn heuristic.
Native models and provider lifecycle
remain in their plugins.

From the repository root, run `bun run --cwd packages/voice build`,
and `bun run --cwd packages/voice typecheck`.

## Browser voice capture

`@elizaos/voice/browser-capture` records one MediaRecorder clip at a time. The host admits
the microphone (`openMicrophone(onLost)` returns the stream and its release) and receives the
finished clip in `stopped(event)`; clips stay in memory and nothing is uploaded or saved.
`decodeRecordingPcm` decodes a clip to bounded mono 16 kHz samples, and `encodePcm16Wav` /
`recordingPcmWav` produce mono PCM16 WAV for the host's speech service. The package has no
speech recognizer and no in-page model runtime; recognition belongs to the host, for example a
local agent's ASR route.
See `src/browser-capture/README.md`.

Browser consumers can qualify the recorder and PCM conversion in headless Chromium:

```sh
bun run --cwd packages/voice build
node packages/voice/test/consumer.mjs
```

It uses real MediaRecorder and Web Audio, never opens a physical microphone and makes no
request off the loopback host. It checks replacement capture ownership, decoding a WAV to
mono 16 kHz samples, PCM16 WAV encoding and cancellation. Reports are under root
`test-results/browser-capture-consumer`.
