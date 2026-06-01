# LifeOpsBench — Agent Guide

Multi-turn, tool-use benchmark for life-assistant agents. Evaluates whether an
agent correctly emits tool calls against a deterministic in-memory world state
across 10 domains: calendar, mail, messages, contacts, reminders, finance,
travel, health, sleep, and focus. Registered in the suite registry as
`lifeops_bench`.

## Run

```bash
# Direct — from packages/benchmarks/lifeops-bench/
pip install -e .[anthropic,test]   # one-time install
python -m eliza_lifeops_bench --agent perfect --domain calendar

# Full static run against the cerebras-direct reference backend
CEREBRAS_API_KEY=... python -m eliza_lifeops_bench --agent cerebras-direct --mode static

# Live mode (simulated user + judge) requires both keys
CEREBRAS_API_KEY=... ANTHROPIC_API_KEY=... \
  python -m eliza_lifeops_bench --agent hermes --mode live

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks lifeops_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# PerfectAgent oracle — no API keys needed, runs static scenarios only
python -m eliza_lifeops_bench --agent perfect --suite smoke

# Dry-run: resolve config + print scenario list without executing
python -m eliza_lifeops_bench --agent perfect --dry-run
```

## Test the harness

```bash
pip install -e .[test]   # one-time
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `eliza_lifeops_bench/__main__.py` | CLI entrypoint (argparse) |
| `eliza_lifeops_bench/runner.py` | Orchestration + action execution loop |
| `eliza_lifeops_bench/evaluator.py` | LIVE-mode simulated-user + judge wiring |
| `eliza_lifeops_bench/scorer.py` | state_hash, output_substring, pass@k |
| `eliza_lifeops_bench/lifeworld/` | Deterministic in-memory world state |
| `eliza_lifeops_bench/scenarios/` | 492 static + 528 live scenarios by domain |
| `eliza_lifeops_bench/agents/` | Adapters: eliza, hermes, openclaw, cerebras-direct, perfect, smithers, wrong |
| `eliza_lifeops_bench/clients/` | Provider clients (Cerebras, Anthropic, Hermes) |
| `data/snapshots/` | Seeded deterministic LifeWorld snapshots |
| `manifests/actions.manifest.json` | JSON-Schema dump of every Eliza action |
| `tests/` | pytest suite (574 passing; 3 live-gated skips) |

## Notes

- Results write to `lifeops_bench_results/` (default; override with `--output-dir`).
- Registry result locator looks for `lifeops_*.json` in the output dir.
- Scored by `_score_from_lifeops_bench_json` in `registry/scores.py`.
- LIVE mode requires `CEREBRAS_API_KEY` (simulated user) + `ANTHROPIC_API_KEY` (judge). Without both, the CLI silently restricts to STATIC scenarios.
- Cost cap: `--max-cost-usd` (default $10). Use `--concurrency 4` for non-Cerebras providers; keep at 2 for Cerebras to avoid 429s.
- See [SCENARIO_AUTHORING.md](SCENARIO_AUTHORING.md) to add scenarios and [ADAPTER_AUTHORING.md](ADAPTER_AUTHORING.md) to add agent adapters.
- Full background: [README.md](README.md).
