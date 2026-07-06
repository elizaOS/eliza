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
