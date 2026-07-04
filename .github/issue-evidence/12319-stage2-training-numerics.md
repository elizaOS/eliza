# Issue #12319 — Stage 2 training numerics evidence

## What changed

- `train_local.py` persists the existing finite checkpoint scan as `final/numerics_scan.json` immediately after saving the model.
- Added a CPU-safe one-step smoke test that builds a tiny local Transformers causal LM, runs the real `train_local.py` forward/backward/save path, and verifies the emitted checkpoint numerics report.

Current `develop` already contains the Stage 2 finite-loss boundary, finite-weights callback, checkpoint scan gate in `run_pipeline.py`, registry `train_dtype`, per-tier `max_grad_norm`, and Gemma Liger allowlist. This chunk adds the missing persisted artifact and real entrypoint smoke around those gates.

## Verification

Commands run in `/tmp/eliza-12318-stage1-corpus` on branch `fix/12319-training-numerics`:

```bash
python -m py_compile \
  packages/training/scripts/train_local.py \
  packages/training/scripts/run_pipeline.py \
  packages/training/scripts/training/model_registry.py \
  packages/training/scripts/training/instrumentation.py \
  packages/training/scripts/test_train_local_stage2_smoke.py
uv run --project packages/training --with pytest -- python -m pytest \
  packages/training/scripts/training/test_finite_guard.py \
  packages/training/scripts/training/test_model_registry.py \
  packages/training/scripts/test_train_local_low_vram_smoke.py \
  packages/training/scripts/test_train_local_stage2_smoke.py
```

Observed result:

- Python compile check passed.
- Pytest: 59 passed, 3 skipped, 1 pytest config warning about `asyncio_mode`.
- Finite guard tests covered non-finite loss and checkpoint tensor rejection.
- Registry/low-vram tests covered tier dtype and gradient clipping defaults plus explicit override behavior.
- Stage 2 smoke test covered the real `train_local.py` one-step path and asserted `final/numerics_scan.json` had `passed: true`, nonzero `tensor_files`, and nonzero `tensors`.

## Evidence N/A

- Full Gemma-4 + Liger hardware trajectory: not captured in this local chunk because the host does not expose CUDA/H200-class hardware. The existing Liger allowlist intentionally fails closed for unsupported architectures.
- Screenshots/video: N/A, non-UI training tooling.
- Benchmarks: N/A, this change verifies fail-closed numerics behavior rather than model quality/throughput.
