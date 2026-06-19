# swe_bench_pro_matrix

SWE-bench Pro adapter for the elizaOS code-agent comparison matrix. Loads tasks from the vendored `swe-bench-pro-public-vendored` dataset, dispatches each task to a code agent (elizaos or opencode), collects unified-diff patches, and optionally runs the SWE-bench Pro evaluator to score them.

The `run_swe_bench_pro_matrix` function is the primary API surface imported by the benchmark orchestrator. The module can also be run directly for ad-hoc use.

## Files

| File | Purpose |
|---|---|
| `code_agent_matrix.py` | Core matrix runner: loads tasks, prepares workspaces, dispatches agent commands, collects patches, runs the evaluator, and aggregates results into a normalized result dict. |
| `agent_command.py` | Per-task subprocess helper. Builds the prompt, sets up the adapter environment, invokes `ElizaServerManager`, and writes `agent-result.json`. Called as a subprocess by `code_agent_matrix.py` for each task. |
| `__init__.py` | Package marker. |
| `tests/test_code_agent_matrix.py` | Unit and integration tests covering task loading, command-template resolution, mock mode, patch extraction (from agent result and from `git diff`), evaluator command construction, and result aggregation. |

## Notes

- **Not run standalone by CI.** The orchestrator imports `run_swe_bench_pro_matrix` from `code_agent_matrix` and calls it directly. Direct invocation (`python -m benchmarks.swe_bench_pro_matrix.code_agent_matrix`) is supported for local debugging only.
- Evaluation requires Docker (local) or Modal; pass `--no-docker` to skip eval and collect patches only.
- The dataset file (`swe-bench-pro/helper_code/sweap_eval_full_v2.jsonl`) is a sibling package and must be present.
- Suite-level conventions are in `../AGENTS.md`.
