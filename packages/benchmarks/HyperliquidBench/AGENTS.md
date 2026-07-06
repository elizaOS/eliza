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

# Direct — coverage scenario, demo mode
python -m benchmarks.HyperliquidBench \
  --coverage \
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
| `scripts/run_hian.sh` | HiaN demo runner + validator wrapper |
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
