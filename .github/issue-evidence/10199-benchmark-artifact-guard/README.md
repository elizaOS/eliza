# #10199 — benchmark artifact-commit guard

## AC satisfied

#10199 acceptance criteria: *"The script fails clearly when ... generated
artifacts would be committed accidentally"* and *"Keep generated run output
ignored; commit only final reviewed markdown scorecards and lightweight
manifests."* No enforceable guard existed — the convention lived only in
`benchmarks/CLAUDE.md` + `.gitignore` (which silently ignores, never fails).

## What's added

- `packages/benchmarks/orchestrator/artifact_guard.py` — classifies a
  repo-relative path as generated benchmark output by matching **directory
  components** (`benchmark_results`/`benchmark_results*`/`test_output`/
  `trajectories`) + the two generated trajectory filenames, scoped to the
  benchmark tree (`packages/benchmarks/**`, repo-root `benchmark_results/`). The
  three `.gitignore`-negated reviewed artifacts are allow-listed 1:1.
- `python -m benchmarks.orchestrator verify-artifacts` — scans `git ls-files`
  (tracked + staged) and exits non-zero with a clear, actionable list if any
  generated output is committed.

## Why the classifier is scoped (real bug the test caught)

An initial substring/component match false-positived on legitimate **source**
`trajectories/` dirs (`packages/core/src/features/trajectories/`, UI
`components/composites/trajectories/`) and intentionally-committed **evidence**
(`.github/issue-evidence/**/trajectories/`). The `test_current_repo_index_is_clean`
test (real `git ls-files` over 46,123 tracked files) caught this; the classifier
now scopes to the benchmark tree exactly as `.gitignore` does. Source files whose
names merely resemble output (`trajectories.js`, `trajectories.py`,
`test_outputs.py`) are matched as filenames, never dir components, so they are
never flagged.

## Verification (host-only; no key)

```
$ python -m benchmarks.orchestrator verify-artifacts
# Benchmark artifact guard
OK — checked 46123 tracked file(s); no generated benchmark output is committed.
(exit 0)

$ python -m pytest benchmarks/orchestrator/tests/test_artifact_guard.py -q
7 passed
```

Tests cover: generated-output detection, source-lookalike protection, the three
allow-listed reviewed artifacts, dedupe/sort, injected-git report ok/fail paths,
and the real current-repo scan.

## N/A
- Live-model trajectory / screenshots / audio: N/A — this is a deterministic
  git-index guard; no model/UI/audio path. It complements (does not replace) the
  key-gated full benchmark rerun still tracked in #10199.
