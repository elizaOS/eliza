# #11377 Diarizer GGUF Epoch Evidence

## Scope

- Added `voice_diarizer.converter_epoch = 2` and
  `voice_diarizer.lstm_gate_order = "IFGO"` to the diarizer converter output.
- Taught the native GGUF metadata loader to parse the new diarizer keys.
- Made `voice_diarizer_open` reject missing/pre-epoch GGUFs before tensor load,
  so stale published artifacts fail closed instead of silently scrambling LSTM
  gates into DER=1.000 over-segmentation.
- Added `voice_diarizer_metadata_test`, a tiny metadata-only GGUF test that
  verifies fresh and stale epoch/gate metadata are parsed distinctly without
  requiring the large pyannote GGUF fixture.

## Local validation

- `cmake -B packages/native/plugins/voice-classifier-cpp/build -S packages/native/plugins/voice-classifier-cpp`
- `cmake --build packages/native/plugins/voice-classifier-cpp/build -j`
- `ctest --test-dir packages/native/plugins/voice-classifier-cpp/build --output-on-failure`
- `git diff --check origin/develop...HEAD`

## Evidence gaps

- This does not republish `pyannote-segmentation-3.0.gguf`; the HuggingFace
  artifact update still requires a maintainer token.
