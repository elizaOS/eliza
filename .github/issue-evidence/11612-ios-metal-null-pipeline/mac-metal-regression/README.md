# #11612 — Mac (Apple Metal) regression proof for the nil-pipeline guard

The primary PR evidence notes the A18 Pro device repro is Linux-host-gated. This
directory adds the piece a Linux host cannot: a **real Apple Metal run of the
guarded llama.cpp**, proving the two new nil-checks are a safe no-op on the
healthy Metal path (they only abort on an actual nil pipeline — they do not
regress normal inference).

## What was run

- **Host:** macOS 26.2 (25C56), Apple M4 Max, `metal` 32023.883.
- **Submodule commit built:** `299d5b78b` (`fix(metal): guard nil compute
  pipelines`, elizaOS/llama.cpp#39) — the exact commit this PR points the
  `plugins/plugin-local-inference/native/llama.cpp` submodule at.
- **Build:** `cmake -S llama.cpp -B <out> -DGGML_METAL=ON
  -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_BUILD_TYPE=Release` → `--target
  llama-cli` → **BUILD SUCCEEDED** (`cmake-build-tail.log`). The guarded
  `ggml/src/ggml-metal/ggml-metal-device.m` compiles clean with the Metal
  toolchain.
- **Model:** a real eliza-1 0.8B GGUF (`pretrained_0_8b_128k.gguf`, 557 MB,
  GGUF magic verified).
- **Inference:** `llama-completion -m <gguf> -p "The capital of France is"
  -n 12 -ngl 99 -c 256 --temp 0` — exit 0.

## What it proves

1. **Guarded code runs on the exact hot path.** All model layers offloaded to
   the Metal GPU (`load_tensors: layer N assigned to device MTL0` for every
   layer — see `eliza1-metal-device-assignment.log`), so `llama_decode` drove
   `ggml_metal_op_mul_mat` → the guarded `ggml_metal_encoder_set_pipeline` /
   `ggml_metal_pipeline_max_theads_per_threadgroup` on real Metal.
2. **The guard does NOT false-fire.** No `nil Metal compute pipeline`, no
   `GGML_ABORT`, no `EXC_BAD_ACCESS`. Generation completed correctly:
   `The capital of France is **Paris**.` (`eliza1-metal-generation.txt`),
   430 tok/s prompt eval / 174 tok/s eval (`eliza1-metal-run-summary.log`).

So on healthy Apple Metal the patch is inert; it changes behaviour only when a
compute pipeline is actually nil — exactly the A18 Pro crash condition, where it
converts the silent `EXC_BAD_ACCESS (SIGSEGV) at 0x0` crash-loop into an
explicit, diagnosable `nil Metal compute pipeline` abort.

## Still device-gated (unchanged from the primary evidence)

- The A18 Pro **root cause** (why the `mul_mat` pipeline is nil on that GPU
  family) needs on-device Metal diagnostics on the physical iPhone 16 Pro Max.
- The **jetsam/memory** symptom (item 3) is a separate on-device budgeting fix.

This host cannot build/run iOS Metal on an A18 Pro; it can and did verify the
guard on desktop Apple Metal, which is the regression risk a submodule bump
introduces.
