# InterruptBench — Agent Guide

TypeScript benchmark for **interruption handling** in the elizaOS agent runtime.
Exercises the Stage-1 response-handler field evaluators (`ResponseHandlerFieldRegistry`,
`TurnControllerRegistry`, `RoomHandlerQueue`, `withCleanup`) against 10 scenarios
covering fragmentation, cancellation, steering, cross-channel leaks, pivots, merges,
and accumulation. Not registered in the suite registry — run directly.

## Run

```bash
# From this directory. Default: scripted mode (deterministic, no LLM calls).
bun run bench

# Live Cerebras mode (requires CEREBRAS_API_KEY).
bun run bench -- --mode=cerebras

# With LLM-judge bonus.
bun run bench -- --mode=cerebras --judge

# Single scenario.
bun run bench -- --scenario=B1-pure-cancellation

# Write report.md + report.json to a directory.
bun run bench -- --out=./results
```

## Smoke test (no API keys)

Scripted mode IS the no-key path — the default `bun run bench` runs all 10
scenarios against a deterministic scripted provider without any LLM calls.

For a one-shot Cerebras round-trip that validates the network wiring (requires
`CEREBRAS_API_KEY`):

```bash
bun run bench:smoke
```

## Test the harness

```bash
bun install
bun run test          # vitest run — all scenarios parse, run scripted, and score
bun run test:watch    # watch mode
bun run typecheck     # tsgo --noEmit
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
| `src/registry.ts` | `ResponseHandlerFieldRegistry` seeded for the bench |
| `scenarios/` | 10 JSON scenario files across categories A/B/C/D/F/G/H/K |
| `tests/scenarios.test.ts` | vitest suite: parse + run + score assertions |
| `scripts/cerebras-smoke.ts` | One-shot Cerebras round-trip for wiring validation |

## Notes

- Pass tiers: 70 / 82 / 90 / 95 (aggregate score out of 100).
- Boundary violations deduct 5 points each from the aggregate.
- Report files write to `--out=<dir>` when specified; nothing is written by default.
- Not registered in `registry/commands.py` — no orchestrator invocation path.
- Full scenario format and scoring details: [README.md](README.md).

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
