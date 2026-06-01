# Tau-bench — Agent Guide

Vendored implementation of Sierra's [tau-bench](https://github.com/sierra-research/tau-bench)
(Yao et al., 2024): Tool-Agent-User Interaction benchmark across retail (115 tasks) and airline
(50 tasks) domains, with pass^k scoring and an LLM judge. Registered in the suite registry as
`tau_bench`.

## Run

```bash
# Direct, from this directory — full 165-task suite, pass^4 (paper default)
python -m elizaos_tau_bench --agent-model gpt-4o

# With a non-OpenAI agent; keep openai for user-simulator and judge
python -m elizaos_tau_bench \
    --agent-provider anthropic --agent-model claude-3-5-sonnet-latest \
    --user-provider openai --user-model gpt-4o \
    --judge-provider openai --judge-model gpt-4o-mini

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks tau_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic mock agent — no LLM calls, no keys required
python -m elizaos_tau_bench --mock --use-sample-tasks
```

## Test the harness

```bash
# One-time install (from this directory)
pip install -e ".[dev]"

# Run the pytest suite
pytest packages/benchmarks/tau-bench/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_tau_bench/cli.py` | CLI entrypoint (`python -m elizaos_tau_bench`) |
| `elizaos_tau_bench/runner.py` | Main execution loop (TauBenchRunner) |
| `elizaos_tau_bench/judge.py` | LLM judge (gpt-4o-mini, falls back to substring) |
| `elizaos_tau_bench/pass_k.py` | Unbiased pass^k estimator |
| `elizaos_tau_bench/types.py` | TauBenchConfig, TauBenchReport DTOs |
| `elizaos_tau_bench/upstream/` | Vendored sierra-research/tau-bench source (MIT) |
| `elizaos_tau_bench/compact_fixtures/` | Compact DB fixtures for smoke runs |
| `tests/` | pytest suite (dataset, pass^k, judge, output contract, smoke) |
| `pyproject.toml` | Package metadata; `tau-bench` console script |

## Notes

- Results write to `benchmark_results/tau-bench/<timestamp>/` (report.json + trajectories.json).
- Scored by `_score_from_taubench_json` in `registry/scores.py`.
- Required env vars: `OPENAI_API_KEY` (agent + user simulator + judge by default). Override
  each component's provider with `--agent-provider`, `--user-provider`, `--judge-provider`.
- Full retail + airline data is fetched lazily into `~/.cache/elizaos_tau_bench/` on first run.
  Set `TAU_BENCH_DATA_DIR` to a pre-populated path, or `TAU_BENCH_DATA_MODE=smoke` to use only
  compact fixtures.
- Vendored upstream commit: `59a200c6d575d595120f1cb70fea53cef0632f6b`.
- Full background: [README.md](README.md).
