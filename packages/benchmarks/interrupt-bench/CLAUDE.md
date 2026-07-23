# InterruptBench — Agent Guide

TypeScript benchmark for **interruption handling** in the elizaOS agent runtime.
Exercises the Stage-1 response-handler field evaluators (`ResponseHandlerFieldRegistry`,
`TurnControllerRegistry`, `RoomHandlerQueue` — local mirrors in `src/core-lite.ts`)
against 10 authored scenarios (expanded to 110 with edge variants) covering
fragmentation, cancellation, steering, cross-channel leaks, pivots, merges,
and accumulation. Runnable directly or through the orchestrator's `interrupt_bench`
adapter (`orchestrator/adapters.py`).

## Run

```bash
# From this directory. Default: live Cerebras mode (requires CEREBRAS_API_KEY).
bun run bench

# Scripted mode — deterministic, no LLM calls.
bun run bench -- --mode=scripted

# Harness mode — Stage-1 calls via the Eliza/Hermes/OpenClaw bridge.
bun run bench -- --mode=harness

# With LLM-judge bonus.
bun run bench -- --mode=cerebras --judge

# Single scenario.
bun run bench -- --scenario=B1-pure-cancellation

# Write report.md + report.json to a directory.
bun run bench -- --out=./results

# Via the orchestrator (adapter id: interrupt_bench).
python -m benchmarks.orchestrator run --benchmarks interrupt_bench --provider cerebras --model gemma-4-31b
```

## Smoke test (no API keys)

Scripted mode is the no-key path — `bun run bench -- --mode=scripted` runs all
110 scenarios against a deterministic scripted provider without any LLM calls.
The default mode is `cerebras` (live model) and needs `CEREBRAS_API_KEY`.

For a one-shot Cerebras round-trip that validates the network wiring (requires
`CEREBRAS_API_KEY`):

```bash
bun run bench:smoke
```

## Test the harness

```bash
bun install
bun run test          # vitest run — scenarios, scoring, judge, harness bridge
bun run test:watch    # watch mode
bun run typecheck     # tsc --noEmit
```

## Layout

| Path | Role |
| --- | --- |
| `src/runner.ts` | CLI entrypoint — parses flags, runs scenarios, prints report |
| `src/evaluator.ts` | Per-scenario orchestrator (clock, channels, state, trace) |
| `src/scorer.ts` | 6-axis scoring (state, intent, routing, trace, boundary, latency) |
| `src/judge.ts` | LLM-as-judge bonus tier |
| `src/llm-scripted.ts` | Deterministic provider (no LLM calls) |
| `src/llm-cerebras.ts` | Live Cerebras client (gemma-4-31b) |
| `src/llm-harness.ts` | Stage-1 client backed by the Eliza/Hermes/OpenClaw bridge |
| `src/core-lite.ts` | Local mirrors of the core Wave 0 primitives |
| `src/registry.ts` | `ResponseHandlerFieldRegistry` seeded for the bench |
| `scenarios/` | 10 authored JSON scenarios across categories A/B/C/D/F/G/H/K (each expanded 10× at load) |
| `tests/` | vitest suites: scenarios, aggregate/honest scoring, judge, harness bridge |
| `scripts/cerebras-smoke.ts` | One-shot Cerebras round-trip for wiring validation |
| `scripts/harness_stage1_turn.py` | Per-turn bridge invoked by `--mode=harness` |

## Notes

- Pass tiers: 70 / 82 / 90 / 95 (aggregate score out of 100).
- Boundary violations deduct 5 points each from the aggregate.
- Report files write to `--out=<dir>` when specified; nothing is written by default.
- Orchestrator integration is via the `interrupt_bench` adapter in
  `orchestrator/adapters.py` (there is no `registry/commands.py` entry).
- Full scenario format and scoring details: [README.md](README.md).

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
