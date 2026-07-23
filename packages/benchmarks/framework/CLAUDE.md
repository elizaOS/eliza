# Framework Benchmark — Agent Guide

Measures the overhead of the elizaOS framework itself: a TypeScript (Bun)
harness drives a real `AgentRuntime` with a deterministic mock-LLM plugin and
in-memory DB, reporting latency, throughput, pipeline breakdown, memory, and
startup across 21 scenarios. A Python cross-harness runner
(`scripts/harness_runner.py`) replays the same scenario fixtures against real
Eliza / Hermes / OpenClaw clients. Exposed to the suite orchestrator as the
`framework` adapter (public adapter, not a registry entry).

## Run

```bash
# Wrapper — install/build checks, TypeScript harness, comparison report
cd packages/benchmarks/framework
./run.sh                 # default scenarios
./run.sh --all           # all 21 scenarios (includes stress tests)
./run.sh --scenarios=single-message,burst-100,startup-cold
./run.sh --compare       # comparison report only, from existing results/

# TypeScript harness directly (from the REPO ROOT — needs the workspace install)
bun run packages/benchmarks/framework/typescript/src/bench.ts --scenarios=single-message

# Real-LLM mode (end-to-end sanity, NOT overhead measurement); needs
# ELIZA_CHAT_VIA_CLI, OPENAI_API_KEY, or CEREBRAS_API_KEY
bun run packages/benchmarks/framework/typescript/src/bench.ts --real-llm

# Through the suite orchestrator (mode=harness replays fixtures against a real
# agent-harness client; mode=typescript runs the local mock-LLM harness)
python -m benchmarks.orchestrator run --benchmarks framework --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks framework --provider <p> --model <m> \
  --extra '{"mode": "typescript", "flags": "--scenarios=single-message"}'
```

## Smoke test (no API keys)

The default TypeScript harness uses the deterministic mock-LLM plugin and the
in-memory DB adapter — no keys, no network, no disk. This is the no-key smoke
path:

```bash
bun run packages/benchmarks/framework/typescript/src/bench.ts \
  --scenarios=single-message --output=/tmp/framework-smoke.json
```

Expect a scenario summary (latency/throughput/memory/pipeline) on stdout and a
result JSON at `--output`.

## Test the harness

There is no dedicated test suite; the mock-LLM smoke run above is the
functional check. Static checks via the harness package scripts:

```bash
cd packages/benchmarks/framework/typescript
bun run typecheck        # tsc --noEmit
bun run lint:check       # biome
bun run check            # typecheck + lint + format check
```

## Layout

| Path | Role |
| --- | --- |
| `run.sh` | Wrapper: workspace/core-build checks, TS harness, comparison report |
| `typescript/src/bench.ts` | Benchmark harness (scenario loop, flags, result JSON) |
| `typescript/src/mock-llm-plugin.ts` | Deterministic mock handlers for `TEXT_SMALL/LARGE/EMBEDDING/COMPLETION` + dummy providers |
| `typescript/src/metrics.ts` | Latency/throughput stats, RSS monitor, pipeline timer |
| `scripts/harness_runner.py` | Cross-harness runner over the shared fixtures (eliza / hermes / openclaw adapters) |
| `shared/scenarios.json` | 21 scenario fixtures shared by both runners |
| `shared/character.json` | Benchmark agent character |
| `compare.ts` | Side-by-side comparison of result JSON files |
| `visualize.py` | ASCII charts / summary tables from `results/` |
| `results/` | Timestamped result JSON (gitignored) |

## Notes

- The orchestrator adapter (`orchestrator/adapters.py`, `_command_framework`)
  defaults to `mode=harness` with `scenarios=single-message`; scored by
  `_score_from_framework` from `framework-results.json`. CI lane: `smoke`
  (`orchestrator/ci_coverage.py`).
- Mock-mode numbers measure framework overhead only; `--real-llm` results
  include network/model latency and must not be compared against them.
- `--ts-only` / `--py-only` / `--rs-only` are relics of the removed
  multi-runtime (Python/Rust) comparison and exit with an error.
- Harness-runner env knobs: `FRAMEWORK_HARNESS_TIMEOUT_S`,
  `FRAMEWORK_OPENCLAW_THINKING`, `ELIZA_BENCH_URL` + `ELIZA_BENCH_TOKEN`
  (reuse a running Eliza server instead of spawning one).
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
