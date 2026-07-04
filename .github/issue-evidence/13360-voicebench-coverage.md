# Issue 13360 - VoiceBench Coverage Table

## Scope

Added `packages/benchmarks/VOICEBENCH_COVERAGE.md`, a checked-in coverage table
that maps current public VoiceBench subsets to elizaOS support status, skip
reasons, evaluator families, and P0 adapter actions.

## Source Review

- Hugging Face `hlt-lab/voicebench` page checked on 2026-07-04.
  - Dataset metadata: Apache-2.0, 20,554 rows, 12 subsets.
  - Subsets observed: `advbench`, `alpacaeval`, `alpacaeval_full`,
    `alpacaeval_speaker`, `bbh`, `commoneval`, `ifeval`, `mmsu`, `mtbench`,
    `openbookqa`, `sd-qa`, `wildvoice`.
- GitHub `MatthewCYM/VoiceBench` README checked on 2026-07-04.
  - Documents dataset loading, task types, evaluator families, and sample counts
    for 11 subsets.

## Repo Inspection

`develop` already exposes checked-in VoiceBench packages and registry entries by
direct name search:

```bash
rg -n "voicebench|voicebench_quality|VoiceBench" packages/benchmarks packages/training packages/scenario-runner -g '!node_modules' -g '!dist'
```

Relevant local anchors:

- `packages/benchmarks/registry/commands.py` registers `voicebench` and
  `voicebench_quality`.
- `packages/benchmarks/voicebench/` is the TypeScript latency benchmark.
- `packages/benchmarks/voicebench-quality/` is the Python VoiceBench-quality
  harness for the eight current suite IDs.
- `packages/benchmarks/registry/scores.py` rejects mock/fixture VoiceBench
  results as non-publishable.

The coverage document maps the existing support separately from the remaining
public subsets and missing non-mock evidence.

## Validation

- `git diff --check`
- `bunx @biomejs/biome check packages/benchmarks/VOICEBENCH_COVERAGE.md .github/issue-evidence/13360-voicebench-coverage.md`
  - not applicable: Biome processed 0 files because these Markdown paths are
    ignored by repo configuration.

## Evidence Boundary

This PR closes the inventory/documentation gap only. #13360 still needs a real
non-mock VoiceBench run with dataset revision, row count, audio/STT provider,
assistant model, judge model where applicable, score JSON, and manually reviewed
outputs before the benchmark result can be considered publishable.
