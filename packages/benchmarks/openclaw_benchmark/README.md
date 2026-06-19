# openclaw_benchmark

Matrix adapter that routes [OpenClaw-Bench](../openclaw-benchmark/) scenarios through the elizaOS code-agent harness. It wraps the upstream `BenchmarkRunner` in a thin `MatrixOpenClawRunner` that swaps `call_llm` for an `ElizaClient` call, normalizes results into the shared matrix schema, and supports mock mode for CI.

**Not run standalone.** Imported dynamically by `orchestrator/code_agent_matrix.py` as module `benchmarks.openclaw_benchmark.code_agent_matrix`. Suite-level conventions are in `../AGENTS.md`.

## Files

| File | Role |
|---|---|
| `code_agent_matrix.py` | Core adapter — `MatrixOpenClawRunner`, `run_openclaw_benchmark()`, result normalization, CLI entry point |
| `__init__.py` | Package marker; re-exports nothing (orchestrator imports the module directly) |
| `tests/test_code_agent_matrix.py` | Integration tests exercising the CLI in `--mock --no-docker` mode |

## Key concepts

- **`MatrixOpenClawRunner`** — subclasses `openclaw.runner.BenchmarkRunner`, overrides `call_llm` to forward messages to the running Eliza agent via `ElizaClient`, and tracks per-scenario turn state.
- **`run_openclaw_benchmark()`** — top-level entry called by the orchestrator; handles server lifecycle, scenario selection (`--scenario all` vs named), `--max-tasks` slicing, and mock short-circuit.
- **Result shape** — normalized to `{benchmark, adapter, model_provider, model, summary: {total_instances, resolved, resolve_rate}, results: [...]}` so the orchestrator can aggregate across benchmarks uniformly.
- **Mock mode** — `--mock` skips the real runner and writes synthetic passing results; used in CI where Docker/sandbox is unavailable.
