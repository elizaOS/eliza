# Voice cancellation contract (Wave 3 W3-9)

Canonical reference for the single-token cancellation flow that binds the
voice loop (VAD → ASR → turn detector → LM → TTS) to the runtime's
per-turn abort surface. Read this before changing any of:

- `packages/shared/src/voice/voice-cancellation-token.ts`
- `plugins/plugin-local-inference/src/services/voice/cancellation-coordinator.ts`
- `plugins/plugin-local-inference/src/services/voice/optimistic-policy.ts`
- `plugins/plugin-local-inference/src/services/voice/barge-in.ts`
- `packages/core/src/runtime/turn-controller.ts`

## Why one token

Wave 2 ended with three independent abort surfaces:

1. The runtime's `TurnControllerRegistry` keyed by `roomId` (planner-loop,
   action handlers, streaming `useModel`).
2. The voice loop's `BargeInController` / `BargeInCancelToken`
   (`hardStop()` returns an `AbortSignal` the engine threads into the LM
   fetch).
3. The optimistic-rollback machine's per-turn checkpoint handle
   (`OptimisticRollbackController` + `VoiceStateMachine`).

R11's audit (`.swarm/research/R11-cancellation.md`) showed every voice
barge-in fires (2) but does not fire (1), so the planner-loop / action
handlers had to discover the abort indirectly via the streaming HTTP fetch
close. W3-9 binds these to one handle — `VoiceCancellationToken` — and
makes the engine bridge fire **both** the voice abort and the runtime
abort in lock-step.

## Token shape

```ts
interface VoiceCancellationToken {
  readonly runId: string;            // stable per-utterance id
  readonly slot?: number;            // DflashLlamaServer slot id, when known
  readonly aborted: boolean;         // cheap poll
  readonly reason: VoiceCancellationReason | null;
  readonly signal: AbortSignal;      // standard signal for fetch / model
  abort(reason: VoiceCancellationReason): void;
  onAbort(listener: (r: VoiceCancellationReason) => void): () => void;
}

type VoiceCancellationReason =
  | "barge-in"      // VAD speech-start during agent-speaking
  | "eot-revoked"   // turn detector revoked the previous EOT decision
  | "user-cancel"   // explicit cancel from UI / API
  | "timeout"       // turn exceeded its budget
  | "external";     // runtime / lifecycle abort (APP_PAUSE etc.)
```

Invariants:

- One token per `runId`.
- `abort()` is idempotent — first reason wins.
- `signal.aborted === true` after the first `abort()`.
- Listeners registered after abort fire synchronously with the recorded
  reason.

## Fan-out

The `VoiceCancellationCoordinator` (the only owner of live tokens, keyed
by `roomId`) wires every abort into four sinks:

```
coordinator.bargeIn(roomId)         coordinator.armTurn({ roomId, runId, slot? })
       │                                          │
       ▼                                          ▼
   token.abort("barge-in")  ─────────────►  token (registered in VoiceCancellationRegistry)
                                                  │
                                                  │ onAbort listener (set by coordinator)
                                                  ▼
                ┌───────────────────────────────────────────────────────────┐
                │ 1. runtime.turnControllers.abortTurn(roomId, reason)      │
                │    → planner-loop / action handlers / streaming useModel  │
                │      see TurnAbortedError at the next yield               │
                │                                                            │
                │ 2. slotAbort(slot, reason)  [if slot was registered]      │
                │    → DflashLlamaServer.abortSlot — closes in-flight       │
                │      fetches against the slot. On a fork with a           │
                │      slot-cancel REST route, the route is hit instead.    │
                │                                                            │
                │ 3. ttsStop(reason)                                         │
                │    → EngineVoiceBridge.triggerBargeIn → audio-sink drain  │
                │      (SIGKILLs the player child) + FFI/HTTP synthesis     │
                │      cancel at the next kernel boundary                   │
                │                                                            │
                │ 4. AbortSignal listeners                                  │
                │    → every fetch / useModel / FFI call that took          │
                │      token.signal aborts at the next yield point          │
                └───────────────────────────────────────────────────────────┘
```

The reverse direction (runtime → voice) is wired symmetrically: the
coordinator subscribes to `runtime.turnControllers.onEvent` and aborts
the active voice token whenever the runtime emits `aborted` /
`aborted-cleanup` for the same `roomId`. This is the path that fires
when `abortInflightInference(runtime)` is called from a lifecycle
listener (`APP_PAUSE_EVENT`) — the voice loop drops in sync.

## Sources of cancellation (one and only one entry per source)

| Source                                          | Entry point                                              |
| ----------------------------------------------- | -------------------------------------------------------- |
| VAD speech-start during agent-speaking          | `coordinator.bargeIn(roomId)`                            |
| ASR-confirmed barge-in words                    | `BargeInController.hardStop` → `bindBargeInController`   |
| Turn detector revokes EOT (user resumed)        | `coordinator.revokeEot(roomId)`                          |
| Explicit cancel from UI / API                   | `coordinator.abort(roomId, "user-cancel")`               |
| Lifecycle (APP_PAUSE, container shutdown)       | `runtime.turnControllers.abortAllTurns(reason)` (auto)   |
| Per-turn timeout                                | `coordinator.abort(roomId, "timeout")`                   |

## Optimistic LM start

Gated by `OptimisticGenerationPolicy`. Default heuristic:

- Plugged-in / unknown power source: **enabled** (true).
- Battery: **disabled** (false) — the extra forward pass burns joules on
  every false-positive EOT.
- Explicit user override (`voice.optimisticGenerationOnEot`) wins.

The state machine's `handlePartialTranscript` consults
`policy.shouldStartOptimisticLm(eotProb)` before firing the speculative
drafter. When the policy says yes, the coordinator arms a token for the
turn and the LM call takes `token.signal` so subsequent VAD-driven
barge-ins abort it cleanly.

## Test surface

- Unit: `packages/shared/src/voice/voice-cancellation-token.test.ts` (16
  tests), `plugins/plugin-local-inference/src/services/voice/cancellation-coordinator.test.ts`
  (12 tests), `plugins/plugin-local-inference/src/services/voice/optimistic-policy.test.ts`
  (13 tests).
- Integration: `packages/app-core/__tests__/voice/barge-in.test.ts` (9
  scenarios) — covers the W3-9 brief's two load-bearing claims:
  1. "User speaks, EOT fires, LM start happens within 200 ms of EOT-fired
     timestamp."
  2. "User barges in mid-response, TTS stops within 100 ms of speech-
     detected timestamp, LM aborts, new turn re-plans."

## Production path — engine bridge wiring (W3-9 F1)

`EngineVoiceBridge.start()` constructs the canonical
`VoiceCancellationCoordinator` and the `OptimisticGenerationPolicy` for
the session whenever a `runtime` option is supplied. The bridge wires
both into the production hot path; nothing in the live voice loop is
manual any more. The flow:

```
EngineVoiceBridge.start({ runtime, ... })
  │
  ├─► VoiceCancellationCoordinator (per session, owns per-roomId tokens)
  │       │
  │       ├─ slotAbort   ← opts.slotAbort (production wires DflashLlamaServer.abortSlot
  │       │                when a slot id is known per turn)
  │       ├─ ttsStop     ← bridge.triggerBargeIn()  ← audio sink drain
  │       │                                          + scheduler chunker flush
  │       │                                          + in-flight TTS cancel
  │       └─ runtime.turnControllers.{abortTurn, onEvent}  ← both directions
  │
  └─► OptimisticGenerationPolicy (per session, hot-swappable power source)
          │
          └─ Primed with resolvePowerSourceState()  ← env override OR Linux sysfs
                                                       ("plugged-in" | "battery"
                                                        | "unknown")
                                                      Plugged-in / unknown → enabled
                                                      Battery → disabled

EngineVoiceBridge.bindBargeInControllerForRoom(roomId)
  │
  └─► coordinator.bindBargeInController(roomId, scheduler.bargeIn)
        │
        └─ scheduler.bargeIn.hardStop("barge-in-words")
            → coordinator.bargeIn(roomId)
              → token.abort("barge-in")
                → fan-out (runtime / slotAbort / ttsStop / AbortSignal)

VoiceStateMachine.firePrefill(partial, eotProb, turnId)  ← speech-pause / EOT
  │
  └─ if (optimisticPolicy && !policy.shouldStartOptimisticLm(eotProb))
       return — prefill suppressed (battery / below threshold / override off)
     else
       fire-and-forget prefillOptimistic + retain promise for speech-end
```

Accessors on the bridge (`null` when no `runtime` was supplied — back-
compat for callers that haven't adopted the canonical surface yet):

- `bridge.cancellationCoordinatorOrNull()` — the live coordinator.
- `bridge.optimisticPolicyOrNull()` — the live policy.
- `bridge.bindBargeInControllerForRoom(roomId)` — idempotent binding;
  returns an unsubscribe handle. Bridge `dispose()` tears down every
  remaining binding before the FFI context goes away.

## Open follow-ups

- **HTTP `/v1/audio/speech` C++ interrupt.** The fused-build synthesis
  handler is non-streaming and ignores `req.is_connection_closed`; the
  in-flight `ov_synthesize` keeps running after a client-side abort. The
  audio sink drain still cuts user-facing audio within one tick (the
  player child is SIGKILLed), so the wasted GPU work is the only cost.
  Fix tracked under R11 §5.3 — extend
  `packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs`.
- **REST-shape reconciliation.** `dflash-checkpoint-client.ts` speaks
  the post-merge shape (`POST /slots/<id>/save?filename=` +
  `DELETE /slots/<id>`); the bundled fork still serves the legacy
  `?action=` route. The capability-probe in `dflash-server.ts`
  `probeCtxCheckpointsSupported` is the seam — see R11 §3.3.

## How to extend

To add a new cancellation source:

1. Identify the `roomId` of the active voice turn.
2. Call `coordinator.abort(roomId, reason)` with the appropriate
   `VoiceCancellationReason` (extend the enum in
   `packages/shared/src/voice/voice-cancellation-token.ts` first if the
   new source doesn't map to an existing reason; bump the reason
   taxonomy with care — telemetry consumers pin these).
3. Add a unit test in `cancellation-coordinator.test.ts` proving the
   fan-out fires for the new entry point.

Do NOT bypass the coordinator. Any voice-side caller that wants to abort
in-flight inference goes through this single entry point. The legacy
`BargeInController.hardStop()` is preserved for callers that already
hold a controller reference, but it should be wired through
`coordinator.bindBargeInController()` so the canonical token is the
authoritative cancel surface.
