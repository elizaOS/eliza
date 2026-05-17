# wakeword.cpp — native openWakeWord runtime (GGML)

GGML / llama.cpp port of the openWakeWord streaming detector. Replaces
the previous `onnxruntime-node`-backed path in
`plugins/plugin-local-inference/src/services/voice/wake-word.ts`.

## Status

**Scaffolding only.** The C ABI (ABI v5) and JS bindings are in place,
the fused-build stub returns `ELIZA_ERR_NOT_IMPLEMENTED`, and a Python
conversion tool produces the combined GGUF this runtime consumes. The
real ggml-backed kernel implementations are TODO.

The TS side already routes wake-word detection through the FFI
exclusively (no ONNX fallback). When the fused library is built without
the real kernels wired in, `WakeWordUnavailableError(code:
"runtime-not-ready")` is thrown — the JS side surfaces a clear diagnostic
to the caller.

## What needs to land

1. **Mel filterbank**: build a 32-bin Mel filterbank that consumes 80 ms
   (1280-sample) 16 kHz fp32 frames carrying a 480-sample lead-in and
   emits 8 mel frames per chunk. The upstream openWakeWord melspec graph
   is a fixed FFT + log-mel — the constants live in the GGUF as
   `mel.*` tensors (see `convert_openwakeword_to_gguf.py`). Reuse the
   mel computation already in `omnivoice.cpp/src/audio-*.h` if the
   constants line up.

2. **Speech embedding model**: a Conv2D-based net that windows 76 mel
   frames (hop 8) → a 96-dim embedding. Weights ship as `embed.*`
   tensors in the GGUF. Build out the graph in ggml mirroring the
   ONNX op order. The model is small (~10 MB fp32) — quantization is
   optional but f16 storage should be plenty.

3. **Per-phrase classifier head**: a tiny dense network (`head.<name>.*`).
   At `eliza_inference_wakeword_open(head_name=...)` resolve the head
   prefix inside the GGUF and bind those tensors for the lifetime of
   the session. The architecture is described in
   `train_eliza1_wakeword_head.py::build_head_module` (Flatten →
   Linear(96) → LayerNorm → ReLU → Linear(96) → ReLU → Linear(1) →
   sigmoid). The export keeps this exact shape, so the GGUF tensor
   names follow the PyTorch module names — match them in C++.

4. **Streaming state**: own the per-session audio tail (480 samples),
   mel ring (cap ≈ MEL_RING_CAP_FRAMES = 76 + 32 = 108 frames),
   embedding ring (cap ≈ 16 + 8 = 24 embeddings), and `framesSinceEmbedding`
   counter. Mirror exactly what the JS implementation used to do in
   `OpenWakeWordModel.scoreFrame` (the openWakeWord upstream convention:
   melspec output is rescaled `x/10 + 2` before the embedding model).

5. **Wire into the fused build**: add a `wake/` source directory under
   `omnivoice-fuse/` (or a sibling), produce the C symbols declared in
   `packages/app-core/scripts/omnivoice-fuse/ffi.h` (ABI v5), and link
   the wake-word object files into `libelizainference`. Make
   `eliza_inference_wakeword_supported()` return 1 when the kernels
   are linked in.

## Contract checks the runtime MUST enforce

When mmap'ing the GGUF the C side has to verify (and refuse to open on
mismatch):

- `openwakeword.format_version == 1`
- `openwakeword.sample_rate == 16000`
- `openwakeword.frame_samples == 1280`
- `openwakeword.mel_bins == 32`
- `openwakeword.embedding_window_frames == 76`
- `openwakeword.embedding_hop_frames == 8`
- `openwakeword.embedding_dim == 96`
- `openwakeword.head_window_embeddings == 16`

Any disagreement is a `ELIZA_ERR_BUNDLE_INVALID` with a clear
`out_error`. No silent fallbacks (AGENTS.md §3, §8).

## Conversion

To produce the GGUF this runtime consumes:

```bash
uv run python -m scripts.wakeword.convert_openwakeword_to_gguf \
  --melspectrogram /tmp/oww/melspectrogram.onnx \
  --embedding-model /tmp/oww/embedding_model.onnx \
  --head hey-eliza:/tmp/oww/hey-eliza.onnx \
  --out wake/openwakeword.gguf
```

The upstream graphs come from openWakeWord v0.5.1
(<https://github.com/dscripka/openWakeWord/releases/download/v0.5.1>);
the per-phrase head comes from
`packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`.

## License

The openWakeWord weights this port consumes are Apache-2.0
(<https://github.com/dscripka/openWakeWord>). Per-phrase heads inherit
the license of the TTS used to synthesize their training positives
(piper voices are MIT/CC0-ish — see provenance JSON).
