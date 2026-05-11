# InterruptBench — Wave 0 Contract Mirror

This file mirrors the Wave 0 design contract from the broader Milady project, scoped to the bench's shape.

## 1. Purpose

Measure interruption-handling quality at the **Stage-1 response handler** layer: the single LLM call that consumes a turn's input and emits a structured `ResponseHandlerResult` describing how to handle it (reply? route to planner? steer a thread? abort?).

Everything below is observable from the harness without booting a full runtime, which keeps the bench in-process, deterministic, and replayable.

## 2. The six observed primitives

| Primitive | From | Used by bench for |
|---|---|---|
| `ResponseHandlerResult` | `@elizaos/core` | Output shape per turn |
| `ResponseHandlerFieldEvaluator` | `@elizaos/core` | Per-field schema + handler |
| `ResponseHandlerFieldRegistry` | `@elizaos/core` | Composes schema + prompt; dispatches |
| `TurnControllerRegistry` | `@elizaos/core` | Turn-scoped AbortSignal; abort propagation |
| `RoomHandlerQueue` | `@elizaos/core` | One-at-a-time serialization per room |
| `withCleanup` | `@elizaos/core` | Graceful-abort wrap-up window |

The bench's `src/registry.ts` mirrors the core field set + threadOps from app-lifeops without pulling in plugin-side stores (work-threads, pending-prompts) that require a real `IAgentRuntime`. The schema is byte-identical to what an end-to-end runtime would compose.

## 3. Scenario shape

```jsonc
{
  "id": "A1-fragmented-email-draft",
  "category": "A",
  "interruptionType": "addition",
  "weight": 2,
  "setup": { /* agentId, rooms, users, openThreads, scheduledTasks, memory, pendingPrompts? */ },
  "script": [ { "t": 0, "channel": "dm-alice", "sender": "alice", "text": "i need to" }, ... ],
  "quiesceAfterMs": 5000,
  "expectedFinalState": {
    "threads": [ /* exact-id or structural matches */ ],
    "scheduledTasks": [ ... ],
    "repliesByChannel": { "dm-alice": { "count": { "min": 1, "max": 1 }, "mustContain": ["..."] } },
    "externalSideEffects": { "emailsSent": 0 },
    "pendingPrompts": { "<id>": { "resolved": true } }
  },
  "expectedTrace": {
    "stage1Calls": { "min": 1, "max": 2 },
    "plannerCalls": { "min": 0, "max": 2 },
    "boundaryViolations": 0,
    "intent": "RESPOND",
    "abortFired": false,
    "preemptMode": "ack-and-stop",
    "threadOps": [{ "type": "steer", "workThreadId": "..." }],
    "threadOpsContains": ["stop", "create"]
  },
  "responseRubric": {
    "judgePrompt": "Does the final reply address X?",
    "passRequiredForBonus": true
  }
}
```

## 4. Scoring axes

| Axis | Weight | What it measures |
|---|---|---|
| state | 0.30 | Final threads / tasks / replies match expectedFinalState |
| intent | 0.20 | Stage-1 `shouldRespond` matches expectedTrace.intent |
| routing | 0.20 | Replies landed in expected channels only |
| trace | 0.10 | Call counts + abort / preempt / threadOps match expectedTrace |
| boundary | 0.15 | Zero `boundary_violation` trace events. Violation → 0 here AND −5 to aggregate. |
| latency | 0.05 | Handler p50 < 800ms, p95 < 3000ms (scripted mode) |

Aggregate = `100 × Σ (weight × score) / Σ weight`, minus boundary penalty, plus up to +5 LLM-judge bonus.

Pass tiers: 70 / 82 / 90 / 95.

## 5. Coverage

10 scenarios ship. One per category (A, B, C, D, F, G, H, K) plus extras for A (A1 fragmented, A4 retraction) and B (B1 stop, B2 destructive stop).

Adding a new scenario:

1. Drop `scenarios/<category>/<id>.json`.
2. Run `bun run test` — every scenario file is auto-discovered and parsed.
3. For ideal-agent regression coverage, ensure `src/llm-scripted.ts` has a case for the new id.

## 6. Modes

- **scripted** (default): hand-rolled deterministic provider in `src/llm-scripted.ts`. Zero API calls. Validates harness + scoring.
- **cerebras**: live LLM via `https://api.cerebras.ai/v1/chat/completions`. Model: `gpt-oss-120b`. Requires `CEREBRAS_API_KEY`.

`bun run bench:smoke` is a single round-trip to Cerebras to confirm wiring before running the full bench.

## 7. Non-goals

- This bench does **not** measure end-to-end action quality (lifeops_thread_control, planner tool selection, etc.). Those are downstream of Stage-1 — separate benchmarks own them.
- This bench does **not** measure memory pipeline accuracy beyond what the Stage-1 fields (`facts`, `relationships`, `addressedTo`) emit.
- This bench does **not** spin up a real DB. The `SimulatorState` is the source of truth for "did the agent do the right thing?" — kept intentionally minimal.
