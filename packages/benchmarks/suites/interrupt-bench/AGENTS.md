# InterruptBench — Agent Guide

TypeScript benchmark for **interruption handling** in the elizaOS agent runtime.
Exercises the Stage-1 response-handler field evaluators (`ResponseHandlerFieldRegistry`,
`TurnControllerRegistry`, `RoomHandlerQueue` — local mirrors in `src/core-lite.ts`)
against 10 authored scenarios (expanded to 110 with edge variants) covering
fragmentation, cancellation, steering, cross-channel leaks, pivots, merges,
and accumulation. Runnable directly or through the orchestrator's `interrupt_bench`
adapter (`suites/orchestrator/adapters.py`).

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
  `suites/orchestrator/adapters.py`.
- Full scenario format and scoring details: [README.md](README.md).
