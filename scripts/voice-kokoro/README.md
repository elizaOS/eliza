# tools/voice-kokoro — Kokoro fork-runtime verification harness

J2 verification entry point for the fork-side Kokoro TTS path. The harness
wraps the `kokoro-tts` CLI built under `plugins/plugin-local-inference/native/llama.cpp/build/.../bin/kokoro-tts`
and lets the caller:

1. Build the CLI from the fork's `tools/kokoro/` subtree.
2. Stage a stub or trained Kokoro GGUF + a voice preset.
3. Run end-to-end synthesis with a fixed prompt and check the produced WAV
   is non-blank.

## Quick start

```sh
# 1. Build the fork-side CLI (one-time).
cd plugins/plugin-local-inference/native/llama.cpp
cmake -B build -DLLAMA_BUILD_KOKORO=ON -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_OMNIVOICE=OFF
cmake --build build --target kokoro-tts

# 2. Stage a smoke-test GGUF + voice preset.
python3 tools/kokoro/convert_kokoro_pth_to_gguf.py --stub --output /tmp/kokoro-stub.gguf
python3 -c "
import numpy as np
np.random.default_rng(seed=11).standard_normal((510, 1, 256)).astype(np.float32).tofile('/tmp/af_test.bin')
"

# 3. Synthesize.
./build/bin/kokoro-tts \
    --model /tmp/kokoro-stub.gguf \
    --voice /tmp/af_test.bin \
    --text "Hello world." \
    --output /tmp/kokoro-out.wav
```

The harness exits non-zero if the produced WAV is blank (peak amplitude
< 1e-6). Audio quality is documented as degraded vs the ONNX baseline in
`.swarm/impl/J2-kokoro-port-notes.md`; the harness checks for *non-silence*,
not parity.

## Run the wrapper script

```sh
bash scripts/voice-kokoro/smoke.sh
```

The wrapper handles the build, staging, and verification steps above in a
single command. Returns exit code 0 on a non-blank WAV being produced.
