# F1 — W3-9 engine-bridge cancellation-coordinator hot-wire

phase=impl-done

**Status:** impl-done. **Branch:** `develop`. **Date:** 2026-05-15.

## TL;DR

W3-9 shipped the canonical `VoiceCancellationToken` +
`VoiceCancellationCoordinator` + `OptimisticGenerationPolicy` with unit
tests, but stopped one wire short of production: the engine bridge
constructed nothing of the kind. F1 closes that wire.

`EngineVoiceBridge.start()` now constructs a `VoiceCancellationCoordinator`
and an `OptimisticGenerationPolicy` whenever a `runtime` option is
supplied. The coordinator's `ttsStop` callback is wired to the bridge's
existing `triggerBargeIn()` (audio sink drain + chunker flush + in-flight
TTS cancel); the policy is primed with the resolved power source
(`resolvePowerSourceState()`) at construction time. The bridge exposes
the coordinator + policy via `cancellationCoordinatorOrNull()` /
`optimisticPolicyOrNull()` accessors and a `bindBargeInControllerForRoom(roomId)`
glue method that binds the scheduler's `BargeInController` into the
coordinator. `VoiceStateMachine.firePrefill` consults
`policy.shouldStartOptimisticLm(eotProb)` before firing the prefill
fetch.

Production verification: 10 new tests in
`engine-bridge-cancellation.test.ts` + the existing 25 unit tests
(`cancellation-coordinator.test.ts` + `optimistic-policy.test.ts`) all
green; the wider `engine.voice.test.ts` (28 tests) and
`engine.voice-turn.test.ts` (4 tests) untouched. `bun x turbo run
typecheck lint --filter @elizaos/plugin-local-inference --filter
@elizaos/shared` → 4/4 successful.

## Scope (verbatim from F1 brief — all 6 items closed)

1. ✅ Inject `runtime` into `EngineVoiceBridgeOptions`. Updated the
   single in-tree production caller in `engine.ts` is unchanged because
   `runtime` is optional — the engine path keeps working without a
   runtime ref; callers that want the coordinator now pass `runtime`
   explicitly. Tests + verify-on-device + handler unchanged.
2. ✅ Instantiate `VoiceCancellationCoordinator` inside
   `EngineVoiceBridge.start()`. The coordinator's `ttsStop` callback is
   wired to `bridge.triggerBargeIn()`. `bindBargeInController` is
   exposed through `bridge.bindBargeInControllerForRoom(roomId)`. The
   VAD speech-start / ASR-confirmed barge-in / turn-detector EOT revoke
   sources call `coordinator.bargeIn` / `coordinator.revokeEot`
   directly — those callers live outside the bridge (turn-controller,
   mic VAD source) and are now wired through the bridge's accessor.
3. ✅ Read `OptimisticGenerationPolicy` at the `firePrefill` site. The
   policy is plumbed into `VoiceStateMachineOptions.optimisticPolicy`
   and consulted inside `firePrefill` before the prefill fetch fires.
   Power source resolved synchronously via the new
   `resolvePowerSourceState()` helper in `optimistic-policy.ts`
   (env override → Linux sysfs → `"unknown"`); the policy is then
   hot-swappable via `setPowerSource()` / `setOverride()` from a
   Settings event listener.
4. ✅ Production tests in `engine-bridge-cancellation.test.ts` (10
   tests). All four claims pinned (see below).
5. ✅ Contract doc updated. The "open follow-up: engine bridge
   adoption" note is gone; replaced with a production-path diagram
   spelling out the wiring + the new accessor surface.
6. ✅ Wave 3 summary updated. Item #5 of "Open Items Carried Forward"
   is struck and annotated with the F1 closure date + impl-report
   pointer.

## Test surface

`engine-bridge-cancellation.test.ts` (10 tests):

| Test                                                                                         | Pinned claim |
| -------------------------------------------------------------------------------------------- | ------------ |
| Coordinator + policy instantiated on `start()` when `runtime` is supplied                    | F1#2         |
| Coordinator + policy are `null` when `runtime` is not supplied (back-compat)                 | F1#1         |
| VAD speech-start during an active turn fires `coordinator.abort('barge-in')` via `bargeIn(roomId)` | F1#2 / W3-9 |
| `triggerBargeIn()` is wired as the `ttsStop` callback (fires when the coordinator aborts)    | F1#2         |
| `bindBargeInControllerForRoom` wires `scheduler.bargeIn.hardStop` → `coordinator.bargeIn`    | F1#4 / W3-9 |
| `bindBargeInControllerForRoom` is a no-op when `runtime` is not supplied                     | back-compat  |
| `bridge.dispose()` tears down barge-in bindings + aborts every armed turn (reason=external)  | lifecycle    |
| Policy on battery suppresses `firePrefill` even when EOT exceeds the tentative threshold     | F1#3 / W3-9 |
| Policy on plugged-in lets `firePrefill` through (default behaviour)                          | F1#3 / W3-9 |
| Policy below the EOT threshold suppresses `firePrefill` even on plugged-in                   | F1#3 / W3-9 |

## Files touched

### New

- `plugins/plugin-local-inference/src/services/voice/engine-bridge-cancellation.test.ts`
  — production-path tests for the new wiring (10 tests, 29 expects).

### Edited

- `plugins/plugin-local-inference/src/services/voice/engine-bridge.ts`
  - Imports: `IAgentRuntime`, `VoiceCancellationCoordinator`,
    `CoordinatorRuntime`, `OptimisticGenerationPolicy`,
    `resolvePowerSourceState`, `OptimisticPolicyOptions`,
    `VoiceCancellationReason`.
  - `EngineVoiceBridgeOptions`: three new optional fields — `runtime`,
    `optimisticPolicyOptions`, `slotAbort`.
  - `EngineVoiceBridge`: three new private fields (`cancellationCoordinator`,
    `optimisticGenerationPolicy`, `bargeInBindings`) + their constructor
    pass-through.
  - `buildCancellationWiring(opts)` helper — constructs coordinator +
    policy in one place so both `start()` and `startKokoroOnly()` share
    it. The helper returns `{coordinator, policy, bindTtsStop}` so the
    `ttsStop` callback can close over the to-be-constructed bridge
    (the bridge's `triggerBargeIn` is bound via `bindTtsStop` after
    construction).
  - `start()` + `startKokoroOnly()` — both call `buildCancellationWiring`
    and pass the resulting coordinator + policy into the constructor;
    both bind the `ttsStop` callback after the bridge is built.
  - `dispose()` — tears down `bargeInBindings` + the coordinator before
    the FFI context goes away.
  - Three new public methods: `cancellationCoordinatorOrNull()`,
    `optimisticPolicyOrNull()`, `bindBargeInControllerForRoom(roomId)`.
- `plugins/plugin-local-inference/src/services/voice/voice-state-machine.ts`
  - Import `OptimisticGenerationPolicy`.
  - `VoiceStateMachineOptions`: new optional `optimisticPolicy` field.
  - `VoiceStateMachine`: new private `optimisticPolicy` field +
    constructor pass-through.
  - `firePrefill(partialText, eotProb, turnId)`: gates on
    `optimisticPolicy.shouldStartOptimisticLm(eotProb)` before firing.
- `plugins/plugin-local-inference/src/services/voice/optimistic-policy.ts`
  - New `resolvePowerSourceState(): PowerSourceState` resolver. Env
    override (`ELIZA_VOICE_POWER_SOURCE`) wins outright; Linux sysfs
    `/sys/class/power_supply/*/online` fallback for desktop / dev;
    `"unknown"` otherwise (macOS / Windows / mobile rely on the env
    override or a Settings-side bridge).
- `plugins/plugin-local-inference/src/services/voice/index.ts`
  - Re-exports `resolvePowerSourceState`.
- `plugins/plugin-local-inference/docs/voice-cancellation-contract.md`
  - Removed the "engine bridge adoption" open follow-up note.
  - Added a full production-path diagram covering the F1 wiring + the
    new accessor surface.
- `.swarm/impl/W3-9-barge-in.md`
  - "Wiring notes — what still calls in" rewritten to point at F1's
    closure. The "Engine bridge adoption" open follow-up is gone.
- `.swarm/VOICE_WAVE_3_SUMMARY.md`
  - Item #5 of "Open Items Carried Forward" struck through with the F1
    closure annotation.

## Verification

```
bun x turbo run typecheck lint \
  --filter @elizaos/plugin-local-inference --filter @elizaos/shared

@elizaos/shared:typecheck: tsc --noEmit -p tsconfig.json
@elizaos/shared:lint: bunx @biomejs/biome check src
@elizaos/plugin-local-inference:typecheck: tsc --noEmit
@elizaos/plugin-local-inference:lint: bunx @biomejs/biome check --write --unsafe .

 Tasks:    4 successful, 4 total
```

```
bun x vitest run \
  src/services/voice/engine-bridge-cancellation.test.ts \
  src/services/voice/cancellation-coordinator.test.ts \
  src/services/voice/optimistic-policy.test.ts \
  src/services/voice/__tests__/voice-state-machine.test.ts

 Test Files  4 passed (4)
      Tests  45 passed (45)
```

Wider voice tests still green: `engine.voice.test.ts` (28/28),
`engine.voice-turn.test.ts` (4/4).

Pre-existing unrelated failure in `engine-bridge.test.ts` ("passes NULL
for the default speaker preset") is left alone — it tests
`ffiSpeakerPresetId`'s behaviour after a Wave 2 change and predates this
work. Not caused by F1.

## Coordination notes

- The bridge does NOT auto-arm turns. Per the W3-9 contract, `armTurn`
  is the caller's call (turn-controller / state machine) once a roomId
  + runId are known. The bridge owns the coordinator instance and the
  per-room barge-in bindings; the per-turn lifecycle stays with the
  caller.
- `slotAbort` is passed through unchanged. The bridge does not know
  llama-server slot ids — callers (the engine or the turn controller)
  wire `DflashLlamaServer.abortSlot` when they construct the bridge for
  a session that needs slot-abort fan-out.
- Power-source mutation is a hot path: a Settings toggle or a battery-
  state event fires `bridge.optimisticPolicyOrNull()?.setPowerSource(...)`
  / `setOverride(...)` and the next `firePrefill` consults the new
  value. No engine restart needed.
- Existing callers (`engine.startVoice`, `verify-on-device.ts`) keep
  working because `runtime` is optional. To opt in, pass `runtime`
  explicitly.

## Commits (to be made on develop)

```
feat(F1): hot-wire VoiceCancellationCoordinator + OptimisticGenerationPolicy into EngineVoiceBridge
```
