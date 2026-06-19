# clawbench_matrix

ClawBench adapter for the code-agent comparison matrix. Wraps the `clawbench` harness so the orchestrator can run ClawBench scenarios against any registered code agent (elizaOS, OpenCode, etc.) and receive results in the normalized matrix format.

This package is **not run standalone**. It is invoked as a subprocess by `orchestrator/code_agent_matrix.py` via `python -m benchmarks.clawbench_matrix.code_agent_matrix`.

## Files

| File | Purpose |
|---|---|
| `__init__.py` | Package marker; no public API. |
| `code_agent_matrix.py` | Entry point. Configures agent env vars, selects scenarios, drives `clawbench.multi_harness_runner`, and returns a normalized result dict with `benchmark`, `adapter`, `summary`, and `results` fields. Supports `--mock` mode for smoke testing without a live agent. |
| `tests/test_code_agent_matrix.py` | Smoke test: runs the CLI in `--mock` mode and asserts the output JSON shape. |

## Key behaviour

- **`run_clawbench_matrix()`** is the main callable; the orchestrator passes `task_agent`, `model_provider`, `model`, scenario filters, and output paths.
- Scores are clamped to `[0.0, 1.0]`. The summary `resolve_rate` and `score` fields are the fraction of scenarios that achieved a perfect score.
- `--mock` returns synthetic perfect-score results for every selected scenario without starting a real agent.
