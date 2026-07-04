# Stage 2 Finite Loss Guard Evidence

Issue: #12319, Local LLM pipeline Stage 2.

Slice covered here:

- Adds `assert_finite_loss()` to the training instrumentation module.
- Wires `train_local.py` so both direct model loss and fallback trainer loss
  hard-fail when the loss tensor contains NaN or Inf.
- Extends CPU-only finite-guard tests to cover finite scalar loss, NaN scalar
  loss, and mixed finite/Inf/NaN vector loss.

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
```

The two skipped tests are the existing `transformers` callback-factory tests.
They skip because the host system Python environment has incompatible packages:

```text
transformers requires huggingface-hub>=0.23.2,<1.0, but huggingface-hub==1.15.0 is installed
```

Screenshots / recordings: N/A. This is a training-script numerics guard with no
UI, device, or browser surface.
