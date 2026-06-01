# HyperliquidBench — Agent Guide

Measures **operational competence** of Hyperliquid perp trading agents: correct
order routing, cancels, transfers, and leverage changes across two tracks —
Coverage (breadth of action signatures across perp/account/risk domains) and
HiaN (Haystack-in-a-Needle long-context precision). Registered in the suite
registry as `hyperliquid_bench`.

Scoring: `FINAL_SCORE = Base + Bonus − Penalty` computed by `hl-evaluator` (Rust).
The Python `__main__.py` routes plan generation through the Eliza TS bridge (`--mode eliza`)
and delegates execution/evaluation to the Rust crates.

## Run

```bash
# Direct — demo mode (no funds at risk, no key required), eliza TS bridge
python -m benchmarks.HyperliquidBench --demo

# Direct — specific task file, demo mode
python -m benchmarks.HyperliquidBench \
  --tasks hl_perp_basic_01.jsonl \
  --demo

# Through the suite orchestrator (stores results, resolves provider/model)
python -m benchmarks.orchestrator run \
  --benchmarks hyperliquid_bench \
  --provider cerebras \
  --model gpt-oss-120b

# Live orchestrated run (all harnesses, Cerebras, no demo)
HL_PRIVATE_KEY=0x... \
CEREBRAS_API_KEY=csk-... \
python -m benchmarks.orchestrator run \
  --benchmarks hyperliquid_bench \
  --all-harnesses \
  --provider cerebras \
  --model gpt-oss-120b \
  --force \
  --show-incompatible
```

## Smoke test (no API keys, no network)

```bash
# Deterministic local agent — no TS bridge, no Rust required for plan generation
python -m benchmarks.HyperliquidBench --mode deterministic --demo

# Rust runner demo mode (validates full pipeline without touching live endpoints)
cargo run -p hl-runner --release -- \
  --demo \
  --plan dataset/tasks/hl_perp_basic_01.jsonl:1 \
  --out runs/demo

cargo run -p hl-evaluator --release -- \
  --input runs/demo/per_action.jsonl \
  --domains dataset/domains-hl.yaml \
  --out-dir runs/demo
```

The convenience wrapper `scripts/run_cov.sh` handles the two-step runner + evaluator
call; omit `NETWORK` or set it to `demo` and pass `-- --demo` for offline runs.

## Test the harness

```bash
# Rust unit tests (no API keys required)
cargo test

# Or via make
make test
```

No Python pytest suite exists in this directory; harness logic is tested through
the Rust `cargo test` target and the Makefile shortcuts (`make format`, `make check`, `make build`).

## Layout

| Path | Role |
| --- | --- |
| `__main__.py` | Python CLI entrypoint (`python -m benchmarks.HyperliquidBench`) |
| `eliza_agent.py` | Local deterministic agent + scenario helpers |
| `types.py` | `HLBenchConfig`, `TradingScenario` shared types |
| `crates/hl-runner/` | Rust CLI: loads plans, signs + submits actions, writes artifacts |
| `crates/hl-evaluator/` | Rust CLI: normalizes signatures, applies scoring, emits score reports |
| `crates/hl-common/` | Shared plan schema, action types, time utils, artifact helpers |
| `dataset/domains-hl.yaml` | Domain weights + signature allowlists (scoring config) |
| `dataset/tasks/` | Authoritative coverage task JSONL files |
| `dataset/hian/` | HiaN case bundles (prompt, ground truth, metadata) |
| `scripts/run_cov.sh` | Convenience wrapper: runner + evaluator in one call |
| `scripts/run_hian.sh` | HiaN runner wrapper (validator not yet wired) |
| `frontend/` | Static leaderboard + trajectory explorer |

## Notes

- Results write to `HyperliquidBench/runs/<timestamp>/` (gitignored). The Python
  entrypoint also writes an aggregated `hyperliquid_bench-<mode>-<timestamp>.json`
  to `--output` (default: `runs/`).
- Scored by `_score_from_hyperliquid_bench_json` in `registry/scores.py`.
  Demo-mode results are intentionally rejected by the publishability gate.
- Rust crates must be built before live runs:
  `cargo build --release -p hl-runner -p hl-evaluator`
- Live network runs require `HL_PRIVATE_KEY` and `--no-demo`.
  Default model provider is Cerebras (`gpt-oss-120b`); OpenRouter is also supported.
- Full background: [README.md](README.md).
