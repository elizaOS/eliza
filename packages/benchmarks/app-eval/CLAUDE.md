# App Eval — Agent Guide

End-to-end evaluation suite for elizaOS app agents. Submits research and
coding tasks to a running elizaOS agent, collects responses, and scores them
deterministically (keyword coverage, structure, depth — no LLM judge).

Not registered in the suite orchestrator registry; run directly.

## Run

```bash
# All tasks (from repo root)
bun run packages/benchmarks/app-eval/run-benchmarks.ts

# Research tasks only
bun run packages/benchmarks/app-eval/run-benchmarks.ts --type research

# Coding tasks only
bun run packages/benchmarks/app-eval/run-benchmarks.ts --type coding

# Single task
bun run packages/benchmarks/app-eval/run-benchmarks.ts --task research-001

# Server mode — boot runtime once, stream all tasks (faster for full suite)
bun run packages/benchmarks/app-eval/run-benchmarks.ts --server

# Explicit app root (required if auto-detect fails)
ELIZA_APP_ROOT=/path/to/app bun run packages/benchmarks/app-eval/run-benchmarks.ts
```

After a run, evaluate the saved results:

```bash
python3 packages/benchmarks/app-eval/evaluate.py \
    packages/benchmarks/app-eval/results/latest/
```

## Smoke test (no live agent)

```bash
# Show tasks without executing (no agent required)
bun run packages/benchmarks/app-eval/run-benchmarks.ts --dry-run

# Code-agent coding module mock mode (no agent, no API keys)
python3 packages/benchmarks/app-eval/code_agent_coding.py \
    --task-agent elizaos --mock --max-tasks 1 --json
```

## Test the harness

```bash
# Python unit tests (no agent needed)
pytest packages/benchmarks/app-eval/test_adapter.py \
       packages/benchmarks/app-eval/test_code_agent_coding.py -v

# Vitest integration test (requires python3 + evaluate.py dependencies)
bun test packages/benchmarks/app-eval/evaluate.real.test.ts
```

## Layout

| Path | Role |
| --- | --- |
| `run-benchmarks.ts` | Bun CLI orchestrator — loads tasks, spawns agent, writes results |
| `evaluate.py` | Python evaluator — scores a results directory, writes `evaluation.json` |
| `adapter.py` | Bridge adapter for the benchmarks orchestrator (`APP_EVAL_ADAPTER`) |
| `code_agent_coding.py` | Code-agent matrix variant with `--mock` mode and token metrics |
| `agent_command.py` | Helper invoked per-task by `code_agent_coding.py` to drive the agent |
| `tasks/research-tasks.json` | 10 research task definitions |
| `tasks/coding-tasks.json` | 10 coding task definitions |
| `tasks/research_evaluator.py` | Research scoring logic (keyword, depth, structure, reasoning) |
| `tasks/coding_evaluator.py` | Coding scoring logic (code presence, TS quality, completeness) |
| `test_adapter.py` | pytest unit tests for `adapter.py` |
| `test_code_agent_coding.py` | pytest unit tests for `code_agent_coding.py` |
| `evaluate.real.test.ts` | Vitest integration test for `evaluate.py` |
| `results/` | Run output directories; gitignored |

## Notes

- Results write to `results/<ISO-timestamp>/` with a `latest` symlink. Gitignored.
- Scores are 0-10 per task; deterministic by default (keyword/structure/depth
  — reproducible, no API key). An OPT-IN LLM judge (#9475) augments it: set
  `APP_EVAL_LLM_JUDGE=1` plus `APP_EVAL_JUDGE_API_KEY`/`APP_EVAL_JUDGE_MODEL`
  (or `OPENAI_*`) to blend an LLM judge's 0-10 rating into the score
  (`APP_EVAL_LLM_JUDGE_WEIGHT`, default 0.5). See `llm_judge.py` / `test_llm_judge.py`.
- `adapter.py` exposes `APP_EVAL_ADAPTER` for integration with the benchmarks
  orchestrator's adapter discovery path; set `ELIZA_APP_ROOT` before use.
- `code_agent_coding.py` is the matrix-comparison path for coding tasks. Run it
  by file path (`python3 packages/benchmarks/app-eval/code_agent_coding.py …`)
  with `packages/` on `PYTHONPATH`; it imports `benchmarks.nl2repo.adapter_matrix`
  for token metrics. (The `benchmarks/app_eval/` underscore import shim was
  removed in #9475.)
- Full task format and scoring breakdown: [README.md](README.md).
