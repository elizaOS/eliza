# @elizaos/voice

Browser-safe acoustic processing, turn analysis and speech metrics shared by UI,
native bridges and inference plugins. Import the public package barrel; internal
files import their defining modules directly. Batch renderer hosts can import
`@elizaos/voice/turn` for only the response gate and end-of-turn heuristic.
Native models and provider lifecycle
remain in their plugins.

From the repository root, run `bun run --cwd packages/voice build`,
and `bun run --cwd packages/voice typecheck`.

## Browser speech recognition

`@elizaos/voice/browser-speech` runs English speech recognition in the browser: Whisper
tiny.en over ONNX Runtime Web in a dedicated worker. Recordings never leave the page. The
host serves the model files itself and supplies three inputs:

- a speech manifest (`SpeechManifest`: model, revision, runtime, and the size and SHA-256 of
  the encoder, decoder, vocabulary, generation config, WebAssembly and glue files). The worker
  fetches each file same-origin and refuses any file whose size or digest differs;
- a worker module that calls `installSpeechWorker(self, ort)` with the host's
  `onnxruntime-web/wasm` import (the external-WebAssembly build, so only the verified binary
  is used);
- `new BrowserSpeechRecognizer({manifestUrl, createWorker, idleMs})`.

One request runs at a time. Cancelling terminates the worker, so a late result cannot arrive;
an idle model is released after `idleMs`. Errors use the codes `model-load-failed` and
`recognition-failed`; `silentRecording` reports digital silence before any model download.

## Browser voice capture

`@elizaos/voice/browser-capture` records one MediaRecorder clip at a time. The host admits
the microphone (`openMicrophone(onLost)` returns the stream and its release) and receives the
finished clip in `stopped(event)`; clips stay in memory and nothing is uploaded or saved.
`decodeRecordingPcm` decodes a clip to bounded mono 16 kHz samples for
`BrowserSpeechRecognizer`, and `encodePcm16Wav` / `recordingPcmWav` produce mono PCM16 WAV.
See `src/browser-capture/README.md`.

Browser consumers can qualify the worker and recorder with a prepared manifest and its
assets, the host's `onnxruntime-web/wasm` module, and an owned WAV with a known transcript:

```sh
bun run --cwd packages/voice build
node packages/voice/test/consumer.mjs ASSET_DIRECTORY ONNX_WASM_MODULE SPEECH_WAV "Expected words"
```

This uses headless Chromium, real MediaRecorder/Web Audio, and ONNX WebAssembly. It never
opens a physical microphone or sends audio off the loopback host. It checks replacement
capture ownership, complete transcription and rejection of changed runtime glue. Reports
are under root `test-results/browser-speech-consumer`. An unfinished decoder result is an
error, not a shortened transcript. The host must permit blob module imports for the verified
glue and supply the model/runtime assets; the package does not download them.
