# Stage 3 Quant Recipe Path + Doc Parity Evidence

Issue: #12320, Local LLM pipeline Stage 3.

Slice covered here:

- Reconcile the training quantization contract with the active Gemma shipping path:
  TurboQuant is KV-cache compression, PolarQuant is weight quantization, and the
  shipped Gemma text GGUF is stock `llama-quantize` `Q4_K_M` unless a tier
  manifest proves a recipe was actually applied to the bytes.
- Repoint stale converter defaults and runbook hints from the removed
  `packages/inference/llama.cpp` path to the real runtime submodule:
  `plugins/plugin-local-inference/native/llama.cpp`.
- Add CI-friendly regression coverage so wrapper defaults cannot drift back to
  the removed path.

Verification run from repo root:

```bash
cmp -s packages/training/CLAUDE.md packages/training/AGENTS.md && echo training-docs-identical
# training-docs-identical

git diff --check
# exit 0

python3 -m py_compile \
  packages/training/scripts/quantization/gguf-q3_k_m_apply.py \
  packages/training/scripts/quantization/gguf-q4_k_m_apply.py \
  packages/training/scripts/quantization/gguf-q5_k_m_apply.py \
  packages/training/scripts/quantization/gguf-q6_k_apply.py \
  packages/training/scripts/quantization/gguf_asr_apply.py \
  packages/training/scripts/quantization/gguf_kokoro_apply.py \
  packages/training/scripts/quantization/gguf_eliza1_apply.py \
  packages/training/scripts/turn_detector/convert_to_gguf.py \
  packages/training/scripts/run_pipeline.py \
  packages/training/scripts/quantization/test_recipes_smoke.py
# exit 0

python3 -m pytest packages/training/scripts/quantization/test_recipes_smoke.py \
  -q -k 'gguf_wrappers_default or eliza_typed_gguf'
# 7 passed

rg -n 'packages/inference/llama\.cpp|"packages" / "inference" / "llama\.cpp"|packages/native-plugins' \
  packages/training/scripts/quantization \
  packages/training/scripts/turn_detector \
  packages/training/scripts/run_pipeline.py \
  packages/training/AGENTS.md \
  packages/training/CLAUDE.md \
  packages/training/pyproject.toml \
  packages/shared/src/local-inference/catalog.ts
# Only the new negative assertions in test_recipes_smoke.py match.
```

Full `test_recipes_smoke.py` was attempted with system Python and failed before
the changed assertions because the host environment has incompatible Python
packages:

```text
transformers requires huggingface-hub>=0.23.2,<1.0, but huggingface-hub==1.15.0 is installed
```

`uv run --project packages/training --extra train ...` was also attempted, but
the macOS arm64 environment cannot install `triton==3.6.0`; that wheel is Linux
only. CI/Linux training workers remain the correct verifier for the full train
extra.

Screenshots / recordings: N/A. This is a docs + Python script path-resolution
slice with no UI, device, or browser surface.
