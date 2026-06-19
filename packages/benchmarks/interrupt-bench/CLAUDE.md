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
| `src/llm-cerebras.ts` | Live Cerebras client (gpt-oss-120b) |
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
