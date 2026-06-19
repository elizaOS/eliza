# qwen_claw_bench_matrix

Code-agent comparison adapter for the QwenClawBench benchmark. Provides task loading, workspace setup, agent dispatch, grading, and result aggregation for the suite's cross-agent matrix runs.

This module is imported dynamically by `orchestrator/code_agent_matrix.py` (as `benchmarks.qwen_claw_bench_matrix.code_agent_matrix`) and is not meant to be run standalone. The suite-level `../AGENTS.md` covers how to invoke benchmark runs via the orchestrator.

## Key files

| File | Purpose |
|---|---|
| `code_agent_matrix.py` | Core adapter: loads tasks from the qwen-claw-bench dataset, copies workspace files, dispatches per-task agent subprocesses, grades responses via `lib_grading`, and returns a normalized result dict. |
| `agent_command.py` | CLI helper invoked as a subprocess per task. Builds the task prompt, starts an `ElizaServerManager`, sends the prompt through the chosen adapter (`elizaos` or `opencode`), and writes a JSON result file. |
| `tests/test_code_agent_matrix.py` | Unit tests covering task-slice filtering, command-template generation, and mock-mode result structure. |

## Grading scopes

`code_agent_matrix.py` filters tasks by `grading_scope`:

- `automated` — fully automated grading only
- `hybrid` — judge-assisted grading only
- `supported` (default) — both automated and hybrid tasks

The default dataset slice is `qwenclawbench-v1.1-100`; the active version constant is `DATASET_VERSION = "qwenclawbench-v1.1-100-supported-slice-v2"`.
