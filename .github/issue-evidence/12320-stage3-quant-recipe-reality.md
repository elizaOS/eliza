# Stage 3 Quant/GGUF Recipe Reality Evidence

Issue: #12320
Date: 2026-07-04

## What Was Verified

- `packages/training/AGENTS.md` §3 now names the shipping Gemma weight quant as stock `llama-quantize` `Q4_K_M`, and distinguishes recipe roles:
  - TurboQuant: runtime KV-cache compressor.
  - QJL: runtime K-cache compressor.
  - PolarQuant: weight quantizer.
- Quantization converter callers now resolve the canonical fork at `plugins/plugin-local-inference/native/llama.cpp` when `LLAMA_CPP_DIR` is unset.
- `_kernel_manifest.py` emits real `sha256:<digest>` pins for kernel/reference source files and verifies them before emitting recipe manifest fragments.
- `gguf-q4_k_m_apply.py` treats the post-quantize `llama-cli` load-smoke as a release-suitable recipe gate: failure exits non-zero before writing `gguf_q4_k_m.json`; success records `recipe_test`.
- `gguf_eliza1_apply.py` records `recipeStatus` separately from `recipeManifest`, so legacy sidecars are not cited as provenance unless the produced artifact actually uses the corresponding recipe.

## Commands Run

```bash
uv run --project packages/training --with pytest --with transformers --with safetensors -- \
  python -m pytest \
  packages/training/scripts/quantization/test_gguf_eliza1_apply.py \
  packages/training/scripts/quantization/test_recipes_smoke.py
```

Result after rebasing over #12706: `60 passed, 1 warning in 19.76s`.

```bash
uv run --project packages/training -- python -m compileall -q \
  packages/training/scripts/quantization \
  packages/training/scripts/turn_detector/convert_to_gguf.py \
  packages/training/scripts/run_pipeline.py
```

Result: passed.

```bash
uv run --project packages/training --with transformers --with safetensors -- \
  python packages/training/scripts/quantization/gguf-q4_k_m_apply.py \
  --model google/gemma-4-E2B \
  --output /tmp/eliza-stage3-q4-dry \
  --dry-run
```

Result: dry-run JSON reported `quant_level: "Q4_K_M"` and `smoke_load: true`.

```bash
tmpdir=$(mktemp -d)
mkdir -p "$tmpdir/checkpoint" "$tmpdir/llama.cpp"
printf '# supports Q4_POLAR\n' > "$tmpdir/llama.cpp/convert_hf_to_gguf.py"
uv run --project packages/training --with transformers --with safetensors -- \
  python packages/training/scripts/quantization/gguf_eliza1_apply.py \
  --checkpoint "$tmpdir/checkpoint" \
  --output "$tmpdir/model.gguf" \
  --outtype q8_0 \
  --llama-cpp-dir "$tmpdir/llama.cpp" \
  --dry-run
```

Result: dry-run JSON included `recipeStatus` for each legacy sidecar type and no `recipeManifest`.

```bash
git diff --check
```

Result: passed.

## Remaining Real-Path Evidence Blockers

- No real 2B checkpoint was quantized in this local run. The required byte-level GGUF header dump and corrupt-block publish-blocking proof still need a built `plugins/plugin-local-inference/native/llama.cpp` fork with `llama-quantize` and `llama-cli`, plus the actual Gemma checkpoint bytes.
- No screenshots or screen recordings apply: this is a CLI/training pipeline change with no UI surface.
- No live model trajectories apply: this change does not alter agent prompts, model routing, or generation behavior.
