# Stage 1 Corpus Dedup Evidence

Issue: #12318, Local LLM pipeline Stage 1.

Slice covered here:

- Keeps the existing content-hash dedup pass in
  `prepare_eliza1_trajectory_dataset.py` and exposes the issue-requested
  manifest counters: `deduped_count` and `unique_count`.
- Adds duplicate-boundary validation to `validate_corpus.py` for
  `eliza_native_v1` rows. Duplicate model-training boundaries now report
  `duplicate_native_content` and fail under `--strict`.
- Adds focused tests for manifest dedup counters and validator duplicate
  rejection.

Verification run from repo root:

```bash
python3 -m pytest \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/test_validate_corpus.py -q
# 10 passed

python3 -m pytest packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  -q -k 'dedup'
# 3 passed

python3 -m pytest packages/training/scripts/test_validate_corpus.py -q
# 2 passed

python3 -m py_compile \
  packages/training/scripts/prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/validate_corpus.py \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/test_validate_corpus.py
# exit 0

git diff --check
# exit 0
```

Screenshots / recordings: N/A. This is a training-corpus CLI validation path
with no UI, browser, native, or device surface.
