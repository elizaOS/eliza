# Issue 10199 Evidence: Benchmark Inventory Slice

## Scope

Implemented the deterministic local slice for #10199: a static benchmark
inventory checklist generated from the live registry and adapter discovery.

This does not claim to replace the full live `gpt-oss-120b` graded rerun or HITL
multi-Codex runner. Those remain gated on live model/accounts. This slice gives
operators the missing preflight inventory that shows registry, adapter, directory,
harness, environment, result-locator, and trajectory-expectation coverage before
they run the expensive live suite.

## Commands Run

```bash
bun install
```

Result: passed. Downloaded and synced the repo artifact bundle; generated
untracked artifact residue was cleaned from this isolated worktree.

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/orchestrator/tests -q
```

Result: passed, 341 tests.

```bash
bun run --cwd packages/benchmarks/recall-bench test
```

Result: passed, 3 files / 30 tests.

```bash
bun run --cwd packages/shared build:i18n
bun run --cwd packages/benchmarks/recall-bench bench
```

Result: passed. The real recall smoke drove PGlite + DocumentService +
`searchMemories`; budgets passed 19/19.

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator run \
  --benchmarks recall_bench \
  --agent perfect_v1 \
  --provider cerebras \
  --model gpt-oss-120b \
  --force
```

Result: passed. `recall_bench` synthetic calibration succeeded with score `1.0`.

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator run \
  --benchmarks trajectory_replay \
  --agent perfect_v1 \
  --provider cerebras \
  --model gpt-oss-120b \
  --force
```

Result: passed. `trajectory_replay` synthetic calibration succeeded with score
`1.0`.

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator validate-matrix --format json
```

Result: passed. Adapter count `53`, command construction errors `0`,
compatible cells `141`, incompatible cells `18`.

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator inventory --format json
```

Result: passed. Adapter count `53`, registry entry count `44`, directory gaps
`[]`, registry gaps `[]`.

## Evidence Notes

- Live model trajectory evidence: N/A for this local slice. The implemented
  feature is a static inventory generator plus keyless recall-bench discovery and
  synthetic calibration coverage. The full issue's live `gpt-oss-120b` rerun
  remains out of scope for this machine without live model/accounts.
- Screenshot/video: N/A. This is a CLI/operator benchmark harness change with no
  UI surface.
