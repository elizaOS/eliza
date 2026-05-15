# W3-9 — Optimistic generation + barge-in cancellation end-to-end

phase=impl-done

**Status:** impl-done. **Branch:** `develop`. **Date:** 2026-05-14.

## TL;DR

Wave 2 left three independent cancellation surfaces; W3-9 collapses them
into one `VoiceCancellationToken` (`@elizaos/shared`) owned by the
`VoiceCancellationCoordinator` (plugin-local-inference). The coordinator
fans every abort to (1) the runtime's `TurnControllerRegistry`, (2) the
LM slot abort, (3) the TTS pipeline stop, (4) the standard `AbortSignal`
that fetch / `useModel` / FFI calls take. The reverse direction (runtime
→ voice) is symmetric via `turnControllers.onEvent`. Optimistic LM start
is gated by an `OptimisticGenerationPolicy` (default true on plugged-in,
false on battery, with explicit override). The two W3-9 brief claims —
"LM starts within 200 ms of EOT" and "TTS stops within 100 ms of
speech-detected, LM aborts, new turn re-plans" — are locked by 9
integration tests in `packages/app-core/__tests__/voice/barge-in.test.ts`.

## Token flow diagram

```
                ┌─────────────────────────────────────────────────────────┐
                │ Sources of cancellation                                 │
                ├─────────────────────────────────────────────────────────┤
                │ VAD speech-start during agent-speaking → coordinator.bargeIn  │
                │ ASR-confirmed barge-in words           → BargeInController.hardStop │
                │                                          (bound via bindBargeInController) │
                │ Turn detector EOT revoked              → coordinator.revokeEot │
                │ UI / API user cancel                   → coordinator.abort(reason="user-cancel") │
                │ APP_PAUSE / lifecycle abort            → runtime.turnControllers.abortAllTurns │
                │                                          (reverse-direction subscription) │
                │ Per-turn timeout                       → coordinator.abort(reason="timeout") │
                └─────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                            VoiceCancellationToken
                              (per roomId, single)
                                       │
                  ┌────────────────────┼──────────────────────┐
                  ▼                    ▼                      ▼                      ▼
        runtime.abortTurn       slotAbort(slot)          ttsStop()           signal.aborted
        (planner-loop /         (DflashLlamaServer       (EngineVoiceBridge   (every fetch/useModel
         action handlers /        slot abort)             .triggerBargeIn      that took the signal)
         streaming useModel)                              → audio-sink drain
                                                          → FFI/HTTP cancel)
```

## Files touched

### New

- `packages/shared/src/voice/voice-cancellation-token.ts` — canonical
  `VoiceCancellationToken` + `VoiceCancellationRegistry`. No runtime
  deps; bottom of the cancellation stack.
- `packages/shared/src/voice/voice-cancellation-token.test.ts` — 16
  unit tests covering token lifecycle, idempotent abort, listener
  ordering, linked-signal propagation, registry replace-on-arm.
- `plugins/plugin-local-inference/src/services/voice/cancellation-coordinator.ts`
  — `VoiceCancellationCoordinator` (owns the per-room registry, fans
  abort out + in).
- `plugins/plugin-local-inference/src/services/voice/cancellation-coordinator.test.ts`
  — 12 tests covering fan-out, runtime↔voice propagation, idempotency,
  listener-error tolerance, and the `BargeInController` glue
  (`bindBargeInController`).
- `plugins/plugin-local-inference/src/services/voice/optimistic-policy.ts`
  — `OptimisticGenerationPolicy` (power-source + override gate).
- `plugins/plugin-local-inference/src/services/voice/optimistic-policy.test.ts`
  — 13 tests over the pure resolver + the mutable policy + threshold
  arithmetic.
- `packages/app-core/__tests__/voice/barge-in.test.ts` — 9 integration
  tests:
  - LM starts within 200 ms of EOT-fired timestamp.
  - Battery: optimistic gate suppresses LM start.
  - EOT below threshold: no LM start.
  - Barge-in: TTS drained + LM aborted + runtime.abortTurn fired +
    slot abort recorded within one tick of speech-detected timestamp.
  - Re-plan: arming a fresh token after barge-in starts a new turn
    cleanly.
  - Mid-stream chunk halt after abort.
  - Reverse direction: runtime emits `aborted` → voice token aborts
    with reason=external.
  - Idempotent barge-in.
  - Dispose tears down every armed turn.
- `plugins/plugin-local-inference/docs/voice-cancellation-contract.md`
  — full contract doc.

### Edited

- `packages/shared/src/index.ts` — re-exports the canonical token from
  the package barrel.
- `plugins/plugin-local-inference/src/services/voice/index.ts` —
  re-exports `VoiceCancellationCoordinator`,
  `OptimisticGenerationPolicy`, and the resolver helper.
- `plugins/plugin-local-inference/native/AGENTS.md` — adds a "Voice
  cancellation contract (W3-9)" entry alongside the existing barge-in
  bullet.

## Verification

| Suite                                                                                                | Pass |
| ---------------------------------------------------------------------------------------------------- | ---- |
| `packages/shared` `voice-cancellation-token.test.ts` (16 tests)                                      | ✅   |
| `plugins/plugin-local-inference` `cancellation-coordinator.test.ts` (12 tests)                       | ✅   |
| `plugins/plugin-local-inference` `optimistic-policy.test.ts` (13 tests)                              | ✅   |
| `packages/app-core` `__tests__/voice/barge-in.test.ts` (9 tests)                                     | ✅   |

Total new test cases this round: **50**. All green.

```
shared:       Tests  16 passed (16)   Duration 258ms
plugin-li:    Tests  25 passed (25)   (coordinator + policy combined)
app-core:     Tests   9 passed  (9)   Duration  9.42s
```

## Wiring notes — production adoption (closed by F1 on 2026-05-15)

The deferred engine-bridge adoption landed in F1 (see
`.swarm/impl/F1-engine-bridge-wire.md`). `EngineVoiceBridge.start()` now
constructs the `VoiceCancellationCoordinator` + `OptimisticGenerationPolicy`
whenever a `runtime` option is supplied, wires `ttsStop` to
`bridge.triggerBargeIn()`, primes the policy with the resolved power
source, and exposes the coordinator through
`bridge.cancellationCoordinatorOrNull()` /
`bridge.bindBargeInControllerForRoom(roomId)`. `VoiceStateMachine`
consults `policy.shouldStartOptimisticLm(eotProb)` at the `firePrefill`
site. The contract doc has the full production-path diagram.

## Open follow-ups (out of scope for W3-9, captured in the contract doc)

1. **HTTP `/v1/audio/speech` C++ interrupt** — the fused-build synthesis
   handler is non-streaming and ignores `req.is_connection_closed`. The
   audio sink drain cuts user-facing audio in one tick, so the wasted
   GPU work is the only cost. Tracked R11 §5.3.
2. **REST-shape reconciliation** between
   `dflash-checkpoint-client.ts` (post-merge shape) and the bundled
   fork's `?action=` route. Tracked R11 §3.3.

## Coordination

- W3-3 (fork merge): coordinator is forward-compat with a future slot
  abort REST route — `slotAbort` is a single callback the coordinator
  fires; the underlying HTTP transport is the bridge's concern, not
  this module's.
- W3-4 (omnivoice simplify): `ttsStop` is the cancel callback the
  coordinator fires; the underlying audio sink + FFI cancel are owned
  by the bridge.

## Commits

```
(see git log --grep="W3-9" or the squash log on develop)
wip(W3-9): canonical VoiceCancellationToken in @elizaos/shared
wip(W3-9): VoiceCancellationCoordinator + OptimisticGenerationPolicy
feat(W3-9): barge-in + optimistic LM integration tests + contract doc
```

Some staged files landed under sibling-agent commits due to a global
hook race; final tree state on `develop` is correct.
