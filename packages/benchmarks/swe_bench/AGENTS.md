# SWE-bench — Agent Guide

Software engineering benchmark (Lite / Verified / Full / Multilingual): generates unified-diff patches
for real GitHub issues and evaluates them with the official SWE-bench Docker harness. Registered as
`swe_bench` (single-provider) and `swe_bench_orchestrated` (multi-provider / capability-matrix).

## Run

```bash
# Direct — from packages/benchmarks/
python -m benchmarks.swe_bench.cli --variant lite --harness eliza

# Cap instances, skip Docker eval
python -m benchmarks.swe_bench.cli --variant lite --max-instances 10 --no-docker

# Orchestrated path (multi-provider matrix)
python -m benchmarks.swe_bench.cli --orchestrated --providers elizaos opencode --variant lite

# Via the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks swe_bench --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks swe_bench_orchestrated --provider <p> --model <m>
```

## Smoke test (no API keys, no Docker, no dataset download)

```bash
# Synthetic single instance; mock client; no eliza bridge
python -m benchmarks.swe_bench.cli --mock --no-docker

# Head-to-head elizaOS vs opencode comparison (stub mode — no calls)
python -m benchmarks.swe_bench.harness.comparison --n 2 --stub
```

## Test the harness

```bash
# One-time install (from swe_bench/)
pip install -e ".[dev]"

# Run the unit suite
pytest swe_bench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint (`python -m benchmarks.swe_bench.cli`) |
| `dataset.py` | HuggingFace dataset loader (Lite / Verified / Full) |
| `evaluator.py` | Patch grader (Docker harness or basic validator) |
| `repo_manager.py` | Per-instance repo checkout / diff / cleanup |
| `providers.py` | Top-level provider helpers |
| `types.py` | Dataclasses: `SWEBenchInstance`, `SWEBenchResult`, `SWEBenchReport` |
| `character.py` | Prompt character / persona helpers |
| `harness/comparison.py` | elizaOS vs opencode head-to-head comparison runner |
| `harness/fixtures/` | Static fixture for schema validation (`comparison_smoke.json`) |
| `orchestrator/` | Orchestrated multi-provider control plane and trace tooling |
| `tests/` | pytest suite (unit, no network/Docker required) |

## Notes

- Results write to `benchmark_results/swe-bench/` (single) or `benchmark_results/swe-bench-orchestrated/` (orchestrated). Both paths are gitignored.
- Scored by `_score_from_swebench_json` / `_score_from_swebench_orchestrated_json` in `registry/scores.py`.
- Score = `resolve_rate` (fraction of instances where the generated patch makes the fail-to-pass tests pass).
- Harness adapters: `eliza` (TS bridge, default), `hermes`, `openclaw`, `smithers` — select with `--harness`.
- Task-agent providers for the orchestrated path: `elizaos`, `opencode`, `codex`, `claude-code`.
- Docker is required for official evaluation; `--no-docker` runs a lightweight apply-only check.
- `SWE_BENCH_REPAIR_ATTEMPTS` env var controls how many times the harness retries a failed patch.
- Full design notes and historical results: [README.md](README.md).
