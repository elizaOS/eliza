# Stage 3: stock K-quant artifact load gate

Issue: #12320

This slice makes the stock GGUF K-quant wrappers fail closed when their
post-quantization `llama-cli` load-smoke fails. The shipped Gemma path uses
stock llama.cpp K-quants (`Q4_K_M` today), so the apply step now treats the
real produced GGUF load test as publish-blocking instead of warning and still
writing success metadata. The explicit `--no-smoke-load` escape hatch remains
for local debugging but records `releaseEligible: false` in the sidecar.

Verification commands:

```bash
python3 -m pytest packages/training/scripts/quantization/test_recipes_smoke.py -q -k 'kquant_sibling_fails_when_artifact_load_smoke_fails or kquant_sibling_no_smoke_marks_artifact_not_release_eligible'
python3 -m pytest packages/training/scripts/quantization/test_recipes_smoke.py -q -k 'kquant_sibling_exports_constant or kquant_sibling_dry_run_prints_quant_level or gguf_wrappers_default_to_runtime_llama_cpp_submodule'
python3 -m py_compile packages/training/scripts/quantization/_common.py packages/training/scripts/quantization/gguf-q3_k_m_apply.py packages/training/scripts/quantization/gguf-q4_k_m_apply.py packages/training/scripts/quantization/gguf-q5_k_m_apply.py packages/training/scripts/quantization/gguf-q6_k_apply.py packages/training/scripts/quantization/test_recipes_smoke.py
git diff --check origin/develop..HEAD
```

UI/screenshots/video: N/A. This change only affects training quantization
scripts and their tests.
