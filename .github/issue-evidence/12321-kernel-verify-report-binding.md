# Issue #12321 - Stage 4 kernel verification report binding

PR scope:

- Stage 2 publish hardware verification reports now require a pass report to be
  bound to the current training repo commit.
- Pass reports must also carry `modelSha256`, `ggufSha256`, or
  `artifactSha256`, and that digest must match a shipped text GGUF in the
  staged bundle.
- Regression coverage blocks stale-commit reports and swapped-model reports
  before `eliza-1.manifest.json` can be emitted.

Local verification on 2026-07-04:

```bash
python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q
# 54 passed

python3 -m py_compile \
  packages/training/scripts/publish/orchestrator.py \
  packages/training/scripts/publish/test_orchestrator.py

git diff --check
```

Screenshots/recordings: N/A, publisher gate behavior only; no UI changed.
