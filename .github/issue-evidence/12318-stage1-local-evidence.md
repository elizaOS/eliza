# Issue #12318 — Stage 1 corpus hardening evidence

## What changed

- Scenario native export redacts obvious secrets, backend handles, contact-style data, and coordinates before writing `eliza_native_v1` JSONL.
- Scenario native export now emits row-level privacy attestations plus manifest and sidecar attestation files.
- Training prep and corpus validation now require/propagate privacy attestations, detect duplicate native content, and keep deterministic dedup metadata in the dataset manifest.

## Verification

Commands run in `/tmp/eliza-12318-stage1-corpus` on branch `fix/12318-training-corpus-hardening` before opening the PR:

```bash
bun install
bun run --cwd packages/scenario-runner test src/native-export.test.ts
python -m py_compile \
  packages/training/scripts/format_for_training.py \
  packages/training/scripts/prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/validate_corpus.py
uv run --project packages/training --with hypothesis --with pytest -- python -m pytest \
  packages/training/scripts/test_format_for_training.py \
  packages/training/scripts/test_format_for_training_privacy.py \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/test_validate_corpus.py \
  packages/training/scripts/test_validate_eliza1_trajectory_dataset.py
bun --conditions eliza-source --tsconfig-override ./tsconfig.json --eval '<synthetic trajectory export>'
uv run --project packages/training --with pytest -- python packages/training/scripts/validate_corpus.py \
  --input .github/issue-evidence/12318-stage1-native-export.jsonl \
  --report .github/issue-evidence/12318-stage1-native-export.validation-report.json \
  --strict
```

Results reviewed:

- Scenario native-export tests: 1 file, 17 tests passed.
- Training prep/privacy/validation tests: 58 passed, 1 pytest config warning about `asyncio_mode`.
- Python compile check: passed for the touched training scripts.
- Synthetic native export evidence: 1 row written, 4 redactions, 0 residual findings.
- Strict corpus validation of exported evidence: 1 valid, 0 invalid.

Commands rerun after rebasing PR #12597 onto `origin/develop` in
`/Users/shawwalters/eliza-pr-12597` on July 4, 2026:

```bash
python3 -m py_compile \
  packages/training/scripts/format_for_training.py \
  packages/training/scripts/prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/validate_corpus.py \
  packages/training/scripts/test_validate_corpus.py \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py
python3 -m pytest \
  packages/training/scripts/test_format_for_training.py \
  packages/training/scripts/test_format_for_training_privacy.py \
  packages/training/scripts/test_prepare_eliza1_trajectory_dataset.py \
  packages/training/scripts/test_validate_corpus.py \
  packages/training/scripts/test_validate_eliza1_trajectory_dataset.py \
  -q
python3 packages/training/scripts/validate_corpus.py \
  --input .github/issue-evidence/12318-stage1-native-export.jsonl \
  --report /tmp/12318-stage1-validation-rerun.json \
  --strict
git diff --check
```

Rebase results reviewed:

- Training prep/privacy/validation tests: 59 passed.
- Python compile check: passed for touched training scripts and tests.
- Strict corpus validation of exported evidence: 1 valid, 0 invalid.
- Diff whitespace check: passed.
- Scenario native-export JS test rerun: blocked in this clean worktree because
  `vitest` is not installed (`vitest: command not found`). The pre-rebase run
  above remains the recorded JS evidence for this PR.

## Artifacts

- `.github/issue-evidence/12318-stage1-native-export.jsonl`
- `.github/issue-evidence/12318-stage1-native-export.manifest.json`
- `.github/issue-evidence/12318-stage1-native-export.privacy-attestation.json`
- `.github/issue-evidence/12318-stage1-native-export.validation-report.json`

Manual review confirmed the raw fake OpenAI key, fake GitHub token, and raw coordinate values are absent from the exported JSONL/manifest/attestation, while `<REDACTED:openai-key>`, `<REDACTED:github-token>`, and `[REDACTED_GEO]` markers are present in the JSONL.

## Evidence N/A

- Live-model trajectory: N/A for this chunk because the change is the export/privacy/corpus tooling path; no live prompt/action/provider behavior changed.
- Screenshots/video/frontend logs: N/A, non-UI tooling change.
- Benchmarks: N/A, no training throughput or model-quality path changed.
