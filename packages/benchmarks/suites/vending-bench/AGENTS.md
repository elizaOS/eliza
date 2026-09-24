# Vending-Bench — Agent Guide

elizaOS reimplementation of Andon Labs' Vending-Bench ([arXiv 2502.15840](https://arxiv.org/abs/2502.15840),
[leaderboard](https://andonlabs.com/evals/vending-bench)): evaluates LLM long-horizon coherence by
simulating a vending-machine business (inventory ordering, pricing, cash management). Headline score
is net worth at end of run. Registered as `vending_bench`.

This is a deterministic local reimplementation, not Andon Labs' private simulator. Its results compare
the repository's native harnesses with each other and must not be presented as official leaderboard
scores. The full campaign uses five base seeds, ten edge variants per seed, a 2,000-message cap,
a 30,000-token bounded transcript, and a 365-day safety ceiling.

## Run

```bash
# Direct — heuristic agent (no API key needed for quick structural check)
python -m elizaos_vending_bench.cli run --provider heuristic --runs 5 --days 30

# Direct — OpenAI
python -m elizaos_vending_bench.cli run --provider openai --model gpt-4o --runs 5 --days 30

# Direct — Anthropic
python -m elizaos_vending_bench.cli run --provider anthropic --model claude-sonnet-4-6 --runs 5 --days 30

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks vending_bench --provider <p> --model <m>

# Validate the full campaign shape without spending model quota (55 scenarios)
python -m elizaos_vending_bench.cli run --provider heuristic --runs 5 --days 365 \
  --max-actions-per-day 25 --max-messages-per-run 2000 --context-window-tokens 30000 \
  --seed 42 --expand-scenarios --expected-scenarios 55 --count-scenarios --no-leaderboard
```

## Smoke test (no API keys)

```bash
# Heuristic agent runs without any LLM provider
python -m elizaos_vending_bench.cli run --provider heuristic --runs 1 --days 3 --starter-inventory
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest elizaos_vending_bench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_vending_bench/cli.py` | CLI entrypoint (`vending-bench` script + `python -m elizaos_vending_bench.cli`) |
| `elizaos_vending_bench/runner.py` | Main execution loop |
| `elizaos_vending_bench/environment.py` | Vending machine simulation (inventory, sales, cash) |
| `elizaos_vending_bench/agent.py` | LLM agent interface and heuristic fallback |
| `elizaos_vending_bench/evaluator.py` | Coherence scoring and metrics |
| `elizaos_vending_bench/providers/` | OpenAI and Anthropic provider implementations |
| `elizaos_vending_bench/types.py` | Shared dataclasses and enums |
| `elizaos_vending_bench/reporting.py` | Markdown report generation |
| `elizaos_vending_bench/tests/` | pytest suite (unit + integration) |
| `run_benchmark.py` | Standalone script (heuristic, 10 runs, fixed seed) |

## Notes

- Results write to `./benchmark_results/vending-bench/vending-bench-results-<timestamp>.json` (gitignored).
- Scored by `_score_from_vendingbench_json` in `registry/scores.py`.
- Smoke defaults use starter inventory and six actions per day; explicit full profiles preserve the
  requested horizon, message cap, context budget, seed, inventory state, and action budget.
- The `--provider eliza` path routes through the elizaOS TS benchmark bridge (`eliza-adapter`).
- Native turns fail closed on missing usage and invalid/empty model output is scored as invalid; the
  bridge never supplies a strategy or profitable fallback action.
- Full background: [RESEARCH.md](RESEARCH.md).

