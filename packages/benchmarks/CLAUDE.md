# Benchmarks — Agent Guide

The elizaOS evaluation suite. The **registry** declares every benchmark; the
**orchestrator** runs them; each benchmark lives in its own directory with its
own `README.md` / `AGENTS.md` / `CLAUDE.md`.

## Layout

```
registry/        Canonical benchmark definitions (id, command, requirements, scorer)
orchestrator/    Runner: executes registry benchmarks, normalizes results, viewer, gates
framework/ lib/  Shared harness framework + helpers
standard/        MMLU / HumanEval / GSM8K / MT-Bench adapters (dispatched by run.py)
viewer/          Static results UI
tests/           Suite-level tests (registry, scoring, normalization, acceptance gate)
*-adapter/       Agent harness bridges: eliza / hermes / openclaw / smithers
agentbench_matrix/  Code-agent comparison adapter (driven by orchestrator/code_agent_matrix.py); the duplicate *_matrix/ + app_eval/ import-shim variants were removed in #9475
loadperf/ memperf/ mobile-resource/ view-bundle-size/
                 Resource/device/bundle KPI harnesses (infra/CPU/memory/battery/bundle size),
                 NOT agent benchmarks — own CI lanes, not orchestrator adapters
<benchmark>/     One self-contained benchmark per directory
benchmark_results/   Generated run output — GITIGNORED, never commit
```

`orchestrator/ci_coverage.py` classifies every registered benchmark's CI lane
(scheduled / smoke / manual), and `tests/test_ci_coverage.py` keeps that mapping
1:1 with the registry.

## Run a benchmark

```bash
# List integrated benchmarks + adapter coverage
python -m benchmarks.orchestrator list-benchmarks

# Run one (idempotent: skips already-successful signatures)
python -m benchmarks.orchestrator run --benchmarks <id> --provider <p> --model <m>

# Run all
python -m benchmarks.orchestrator run --all --provider cerebras --model gemma-4-31b
```

`--rerun-failed` reruns only failed signatures; `--force` always makes a fresh
run; `--extra '<json>'` passes benchmark-specific options. Each benchmark's own
`AGENTS.md` documents the direct (non-orchestrator) command and a no-key
smoke/mock path.

## Test the harnesses

```bash
pytest tests/ -v                                   # suite-level
pytest <benchmark>/.../tests/ -v                   # one benchmark (see its AGENTS.md)
```

TypeScript/Bun benchmarks (`eliza-1`, `vision-language`, `configbench`,
`interrupt-bench`, `personality-bench`, `three-agent-dialogue`) test with
`bun test`; Rust components (HyperliquidBench runner) with `cargo test`.

## Conventions

- **One directory per benchmark.** All of a benchmark's code, data, tests, and
  docs live under its directory. Don't scatter benchmark code into shared dirs.
- **The registry is the source of truth.** A benchmark is "integrated" only when
  it has an entry in `registry/commands.py` and a scorer in `registry/scores.py`.
  Some directories are run-only / experimental and not yet registered — their
  `AGENTS.md` says so.
- **Results are generated, not committed.** Anything under `benchmark_results/`
  (and per-benchmark run output) is gitignored. Never commit result JSON, SQLite
  DBs, trajectories, logs, or coverage.
- **Every benchmark carries all three docs.** `README.md` (overview),
  `AGENTS.md` (how to run + smoke + test), `CLAUDE.md` (pointer to AGENTS.md).

## Add a benchmark

1. Create `<your-benchmark>/` (harness + tests + three docs).
2. Add a `BenchmarkDefinition` in `registry/commands.py` and a `_score_from_*`
   in `registry/scores.py`.
3. Verify with `python -m benchmarks.orchestrator list-benchmarks`.

Operator runbook (remote GPU, calibration/readiness gates, code-agent matrix):
[`ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md),
[`orchestrator/README.md`](orchestrator/README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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
