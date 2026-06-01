# Solana-Gym — Agent Guide

Solana instruction-discovery benchmark: an agent discovers Solana on-chain
instructions (across 8 programs, 236 unique program/discriminator pairs) by
running TypeScript skills against a Surfpool sandbox. Registered in the suite
registry as `solana`.

## Run

```bash
# Direct — from packages/benchmarks/ (env vars control all knobs)
MODEL_NAME=anthropic/claude-sonnet-4.6 \
MAX_MESSAGES=50 \
ENVIRONMENT_CONFIG=voyager/environments/basic_env.json \
USE_EXTERNAL_SURFPOOL=true \
python -m benchmarks.solana.eliza_explorer --harness eliza

# With auto-managed Surfpool (spawns and tears down surfpool automatically)
ENVIRONMENT_CONFIG=voyager/environments/basic_env.json \
python -m benchmarks.solana.eliza_explorer

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks solana --provider cerebras --model gpt-oss-120b
```

### Key environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_NAME` | `openai/gpt-oss-120b` | LLM for exploration phase |
| `MAX_MESSAGES` | `50` | Budget for LLM turns |
| `ENVIRONMENT_CONFIG` | _(none)_ | Path to env JSON (`basic_env.json` or `swap_env.json`) |
| `USE_EXTERNAL_SURFPOOL` | `false` | Use a running Surfpool instead of launching one |
| `OUTPUT_DIR` | _(none)_ | Directory for result JSON (defaults to `solana-gym-env/metrics/`) |
| `BENCHMARK_HARNESS` | `eliza` | Agent harness: `eliza`, `hermes`, or `openclaw` |

## One-time setup

```bash
# From packages/benchmarks/solana/
bash setup.sh
```

This installs Python deps (via `uv`), Bun deps in `skill_runner/`, and checks
that `surfpool` is available (install via `cargo install surfpool`).

## Test the harness

```bash
# From packages/benchmarks/
pytest benchmarks/solana/test_solana_benchmark.py -v
```

Tests that require Bun and installed `node_modules` are auto-skipped when those
are absent. Tests requiring live Surfpool or API keys are not in this suite.

## Layout

| Path | Role |
| --- | --- |
| `eliza_explorer.py` | CLI entrypoint (`python -m benchmarks.solana.eliza_explorer`) |
| `exploration_strategy.py` | Deterministic + LLM-assisted phase state machine |
| `instruction_catalog.py` | Catalog of 8 programs and 236 unique instruction pairs |
| `skill_templates.py` | Pre-built TypeScript skill templates (deterministic phase) |
| `trajectory.py` | JSONL trajectory writer |
| `test_solana_benchmark.py` | pytest suite for catalog, templates, strategy, explorer |
| `solana-gym-env/` | Vendored gym environment (voyager runner, Bun skill_runner) |
| `solana-gym-env/voyager/skill_runner/` | Bun TypeScript executor for skills |
| `solana-gym-env/voyager/environments/` | Environment configs (basic, swap) |
| `setup.sh` | One-time dependency setup script |

## Notes

- Results write to `solana-gym-env/metrics/eliza_*_metrics.json` and
  `*_trajectory.jsonl` (gitignored via the metrics/ directory not being tracked).
- Scored by `_score_from_solana_json` in `registry/scores.py`; score =
  `final_reward / 236.0` (ratio of unique instruction pairs discovered).
- Deterministic phase (pre-seeded TypeScript templates) needs only Bun.
  LLM exploration phase additionally needs provider API key and Surfpool.
- Supported harnesses: `eliza` (default), `hermes`, `openclaw`.
- Full gym background: [solana-gym-env/README.md](solana-gym-env/README.md).
