# WooBench — Agent Guide

Mystical reading conversation and revenue benchmark. Evaluates an agent's ability
to conduct tarot, I Ching, and astrology readings across 10 persona archetypes
(skeptic, true believer, emotional crisis, scammer, etc.) while correctly handling
payment conversion, crisis support, and scam resistance. Registered as `woobench`.

## Run

```bash
# Direct, from packages/benchmarks/
python -m benchmarks.woobench --model gpt-5 --output benchmark_results/

# Filter by divination system
python -m benchmarks.woobench --system tarot --model gpt-5

# Filter by persona archetype
python -m benchmarks.woobench --persona skeptic --model gpt-5

# Run a single scenario
python -m benchmarks.woobench --scenario skeptic_tarot_01 --model gpt-5

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks woobench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic dummy agent + heuristic evaluator — no credentials needed
python -m benchmarks.woobench --agent dummy --evaluator heuristic --model dummy

# Dry run — lists scenarios that would be executed, no agent calls
python -m benchmarks.woobench --dry-run

# dummy-charge smoke: exercises the payment action path with a mock payment URL
python -m benchmarks.woobench --agent dummy-charge --evaluator heuristic \
    --payment-mock-url http://localhost:9999 --model dummy
```

## Test the harness

```bash
pytest packages/benchmarks/woobench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `__main__.py` | CLI entrypoint (`python -m benchmarks.woobench`) |
| `runner.py` | Orchestration loop (concurrency, result aggregation) |
| `evaluator.py` | Per-scenario turn driver and payment detection |
| `scorer.py` | Aggregates scenario results into `BenchmarkResult` |
| `types.py` | Dataclasses: `Scenario`, `ScenarioResult`, `BenchmarkResult`, `RevenueResult` |
| `payment_actions.py` | Payment action parsing and dispatch |
| `payment_mock.py` | `MockPaymentClient` for harness tests |
| `personas/` | One module per persona archetype |
| `scenarios/` | Tarot, I Ching, and astrology scenario definitions |
| `tests/` | pytest suite (scorer unit tests + payment mock integration) |

## Notes

- Results write to `benchmark_results/woobench_<model>_<timestamp>.json` (gitignored).
- Scored by `_score_from_woobench_json` in `registry/scores.py`; `overall_score` (0–100) is normalized to 0–1.
- Supported agents: `eliza` (default, elizaOS TS bridge), `hermes`, `openclaw`, `smithers`, `dummy`, `dummy-charge`.
- Evaluator modes: `llm` (OpenAI-compatible judge, default) and `heuristic` (deterministic, no credentials).
- Payment flow tested via `--payment-mock-url` pointing at a mock payments service; see `payment_mock.py`.
- Full background: [README.md](README.md).
