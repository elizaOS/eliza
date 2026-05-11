# InterruptBench

A TypeScript benchmark for **interruption handling** in the Milady / elizaOS agent runtime. Measures whether the Stage-1 response handler does the right thing when the user fragments, retracts, refines, steers, pivots, merges, or otherwise interrupts an in-flight conversation.

InterruptBench is **in-process** — it does not boot a full agent runtime or hit a real database. Instead it directly wires the Wave 0 primitives shipped from `@elizaos/core`:

- `ResponseHandlerFieldRegistry` (Stage-1 schema + prompt composer + dispatcher)
- `TurnControllerRegistry` (turn-scoped AbortSignals; abort propagation)
- `RoomHandlerQueue` (one-at-a-time per room serialization)
- `withCleanup` (graceful abort wrap-up)

…and exercises them with a deterministic clock, scripted channels, and a real or scripted LLM.

## What this bench tests

| Category | Pattern |
|---|---|
| **A** | Fragmented user input (e.g., "i need to" / "send" / "an email" / "to bob about lunch") |
| **B** | Pure cancellation ("stop", "nvm") — possibly mid-action with external side effects pending |
| **C** | Mid-task steering (refine the active thread, don't create a new one) |
| **D** | Cross-channel boundary (reply only in the channel the message came from) |
| **F** | Topic pivots within a thread (stop old, create new) |
| **G** | Cross-channel prompt resolution (user answers a pending question in a different room) |
| **H** | Concurrent merge (combine overlapping threads on demand) |
| **K** | Recipe-style accumulation (assemble specs from multiple short messages) |

Ten scenarios ship in this package, one per category (plus A4 and an extra A1). Add more by dropping JSON into `scenarios/<category>/`.

## Six scoring axes

| Axis | Weight | Signal |
|---|---|---|
| **State** | 0.30 | Final WorkThreads + ScheduledTasks + replies match `expectedFinalState` |
| **Intent** | 0.20 | Stage-1 classifier output matches `expectedTrace.intent` |
| **Routing** | 0.20 | Replies landed in the expected channels only |
| **Trace** | 0.10 | `stage1Calls`, `plannerCalls`, `abortFired`, `threadOps` all match bounds |
| **Boundary** | 0.15 | Zero cross-channel leak, no unauthorized mutation. **Violation → 0 here + −5 to aggregate.** |
| **Latency** | 0.05 | Handler p50 < 800ms, p95 < 3000ms (scripted) |

**Aggregate** = `100 × Σ (weight × score) / Σ weight`, minus `5` per boundary violation, plus up to `+5` LLM-judge bonus.

**Pass tiers**: 70 / 82 / 90 / 95.

## Running

```bash
# Scripted mode — deterministic, no LLM calls. Validates harness + scoring.
bun run bench

# Cerebras live mode — real LLM (gpt-oss-120b at https://api.cerebras.ai/v1).
# Requires CEREBRAS_API_KEY in your env.
bun run bench -- --mode=cerebras

# With LLM judge bonus (also Cerebras).
bun run bench -- --mode=cerebras --judge

# One scenario only.
bun run bench -- --scenario=B1-pure-cancellation

# Persist report files.
bun run bench -- --out=./results

# One-shot Cerebras round trip to verify the wiring.
bun run bench:smoke
```

## Scenario JSON shape

```jsonc
{
  "id": "A1-fragmented-email-draft",
  "category": "A",
  "interruptionType": "addition",     // addition | revision | retraction
  "weight": 2,
  "setup": {
    "agentId": "agent-test",
    "rooms": [{ "id": "dm-alice", "kind": "dm", "owner": "alice" }],
    "users": [{ "id": "alice", "role": "OWNER" }],
    "openThreads": [],
    "scheduledTasks": [],
    "memory": []
  },
  "script": [
    { "t": 0,    "channel": "dm-alice", "sender": "alice", "text": "i need to" },
    { "t": 800,  "channel": "dm-alice", "sender": "alice", "text": "send" },
    { "t": 1600, "channel": "dm-alice", "sender": "alice", "text": "an email" },
    { "t": 2400, "channel": "dm-alice", "sender": "alice", "text": "to bob about lunch tomorrow" }
  ],
  "expectedFinalState": {
    "threads": [],
    "scheduledTasks": [],
    "repliesByChannel": { "dm-alice": { "count": { "min": 1, "max": 1 } } }
  },
  "expectedTrace": {
    "stage1Calls": { "min": 1, "max": 2 },
    "plannerCalls": { "min": 0, "max": 2 },
    "boundaryViolations": 0,
    "intent": "RESPOND"
  },
  "responseRubric": {
    "judgePrompt": "Does the final reply address sending an email to Bob about lunch tomorrow?",
    "passRequiredForBonus": true
  }
}
```

See `scenarios/A/A1-fragmented-email-draft.json` for the working example.

## How the harness drives a scenario

1. Load all scenario JSON files (or one, via `--scenario=`).
2. For each scenario:
   - Initialize a `FakeClock`, a `Trace`, a `SimulatorState` from `setup`, a `ChannelSimulator` (wraps `RoomHandlerQueue`), and a `TurnControllerRegistry`.
   - Compose the Stage-1 schema + system prompt via `ResponseHandlerFieldRegistry` (see `src/registry.ts` — registers `shouldRespond`, `contexts`, `intents`, `candidateActionNames`, `replyText`, `facts`, `relationships`, `addressedTo`, and `threadOps`).
   - Schedule every `script` step on the fake clock.
   - As each step fires, hand the message to either the scripted provider (`src/llm-scripted.ts`) or Cerebras (`src/llm-cerebras.ts`) to get a parsed `ResponseHandlerResult`.
   - Dispatch the result into state mutations (apply `threadOps`, record replies, fire abort if any op is `type: "abort"`).
   - Capture everything in the trace.
3. Score each scenario across the six axes and aggregate.
4. (Optional) Run the LLM judge for the bonus tier.

## Files

```
src/
  runner.ts          # CLI entry — orchestrates scenarios, prints report
  evaluator.ts       # one-scenario orchestrator
  scorer.ts          # 6-axis scoring
  judge.ts           # LLM-as-judge bonus
  report.ts          # markdown + JSON output
  registry.ts        # ResponseHandlerFieldRegistry seeded for the bench
  prompt.ts          # render conversation snapshot for the LLM
  clock.ts           # FakeClock — virtual time
  channels.ts        # ChannelSimulator (wraps RoomHandlerQueue)
  state.ts           # SimulatorState — threads, tasks, replies, side effects
  trace.ts           # append-only trace
  llm-scripted.ts    # deterministic provider for harness validation
  llm-cerebras.ts    # live Cerebras client (gpt-oss-120b)
  scenarios.ts       # loader for scenarios/*.json
  types.ts           # public types
  index.ts           # public API
scripts/
  cerebras-smoke.ts  # one round-trip to Cerebras with the composed schema
scenarios/
  A|B|C|D|F|G|H|K/*.json
tests/
  scenarios.test.ts  # vitest: every scenario parses + runs
```

## Acceptance

- `bun install` succeeds.
- `bun run typecheck` succeeds.
- `bun run bench:smoke` round-trips one Cerebras call with the composed schema and prints the parsed JSON.
- `bun run bench` runs all 10 scenarios against the scripted provider and emits a markdown report.
- `bun run bench -- --mode=cerebras --judge` runs all 10 against Cerebras with the judge bonus enabled.

## See also

- `packages/core/src/runtime/response-handler-field-evaluator.ts` — the Stage-1 contract.
- `packages/core/src/runtime/response-handler-field-registry.ts` — composition primitives.
- `packages/core/src/runtime/turn-controller.ts` — turn-scoped abort.
- `packages/core/src/runtime/room-handler-queue.ts` — per-room serialization.
- `packages/core/src/runtime/cleanup-scope.ts` — graceful-abort wrap-up.
- `plugins/app-lifeops/src/lifeops/work-threads/field-evaluator-thread-ops.ts` — real `threadOps` evaluator (mirrored here).
