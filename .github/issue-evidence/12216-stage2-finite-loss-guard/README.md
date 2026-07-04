# Stage 2 Finite Loss Guard Evidence

Issue: #12319, Local LLM pipeline Stage 2.

Slice covered here:

- Adds `assert_finite_loss()` to the training instrumentation module.
- Wires `train_local.py` so both direct model loss and fallback trainer loss
  hard-fail when the loss tensor contains NaN or Inf.
- Extends CPU-only finite-guard tests to cover finite scalar loss, NaN scalar
  loss, and mixed finite/Inf/NaN vector loss.
- Adds a registry-owned `max_grad_norm` per Gemma 4 tier and wires it through
  `train_local.py` into TRL's `SFTConfig`, with tighter clipping on the
  12B/31B tiers.
- Extends CPU-only registry/default-merge tests so the per-tier clip is
  explicit, large tiers do not inherit HF defaults accidentally, and an
  explicit `--max-grad-norm` still wins over the registry.
- Adds a post-finetune checkpoint finite-tensor scan in `run_pipeline.py`.
  A checkpoint containing NaN/Inf tensors now aborts before benchmark,
  quantization, or publish stages.
- Extends finite-guard tests with tiny local checkpoint shards covering finite
  checkpoints, non-finite tensors, and missing tensor-shard failures.
- Threads registry-owned `train_dtype` through `train_local.py` and fails loud
  for unsupported future dtype declarations instead of silently training bf16.
- Adds a Liger architecture allowlist gate: the validated `gemma4` path can use
  fused kernels, unsupported archs disable in auto mode, and explicit
  `--use-liger on` fails loud for unsupported / `gemma4_unified` configs.

Verification run from repo root:

```bash
python3 -m pytest packages/training/scripts/training/test_finite_guard.py \
  -q -k 'finite_loss or finite_weights or callback'
# 5 passed, 2 skipped

python3 -m py_compile \
  packages/training/scripts/train_local.py \
  packages/training/scripts/training/instrumentation.py \
  packages/training/scripts/training/test_finite_guard.py
# exit 0

git diff --check
# exit 0

python3 -m pytest \
  packages/training/scripts/training/test_model_registry.py \
  packages/training/scripts/test_train_local_low_vram_smoke.py -q
# 44 passed

python3 -m py_compile \
  packages/training/scripts/train_local.py \
  packages/training/scripts/training/model_registry.py \
  packages/training/scripts/training/test_model_registry.py \
  packages/training/scripts/test_train_local_low_vram_smoke.py
# exit 0

python3 -m pytest packages/training/scripts/training/test_finite_guard.py \
  -q -k 'finite_loss or finite_weights or callback or checkpoint_scan'
# 8 passed, 2 skipped

python3 -m py_compile \
  packages/training/scripts/run_pipeline.py \
  packages/training/scripts/training/instrumentation.py \
  packages/training/scripts/training/test_finite_guard.py
# exit 0
```

The two skipped tests are the existing `transformers` callback-factory tests.
They skip because the host system Python environment has incompatible packages:

```text
transformers requires huggingface-hub>=0.23.2,<1.0, but huggingface-hub==1.15.0 is installed
```

Screenshots / recordings: N/A. This is a training-script numerics guard with no
UI, device, or browser surface.
