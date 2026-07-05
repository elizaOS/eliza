# Solana-Gym — Agent Guide

Solana instruction-discovery benchmark: an agent discovers Solana on-chain
instructions (across 8 programs, 364 catalog entries (236 covered by the
deterministic phase)) by running TypeScript skills against a Surfpool sandbox.
Registered in the suite registry as `solana`.

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
pytest solana/test_solana_benchmark.py -v
```

Tests that require Bun and installed `node_modules` are auto-skipped when those
are absent. Tests requiring live Surfpool or API keys are not in this suite.

## Layout

| Path | Role |
| --- | --- |
| `eliza_explorer.py` | CLI entrypoint (`python -m benchmarks.solana.eliza_explorer`) |
| `exploration_strategy.py` | Deterministic + LLM-assisted phase state machine |
| `instruction_catalog.py` | Catalog of 8 programs and 364 unique instruction pairs (236 in deterministic phase) |
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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
