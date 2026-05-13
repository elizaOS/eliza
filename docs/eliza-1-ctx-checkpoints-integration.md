# eliza-1 — `--ctx-checkpoints` integration (JS side)

JS-side scaffold for upstream llama.cpp's per-slot KV checkpoint feature.
Built behind a feature flag so we can ship now and turn on the moment the
buun-llama-cpp fork merges upstream `master` (currently blocked on 44
quant-id enum conflicts in `ggml-quants.h` — human review needed).

## What upstream offers

| Endpoint / flag                                | Purpose                                                              |
|------------------------------------------------|----------------------------------------------------------------------|
| `--ctx-checkpoints N` (default 8)              | Server retains `N` in-memory KV checkpoints per slot                 |
| `--ctx-checkpoint-interval M` (tokens)         | Token-boundary sampling rate for the LRU                             |
| `POST /slots/<id>/save?filename=<f>`           | Persist slot's KV state to disk under `--slot-save-path`             |
| `POST /slots/<id>/restore?filename=<f>`        | Restore a previously-saved snapshot                                  |
| `DELETE /slots/<id>`                           | Cancel any in-flight decode on the slot + free it                    |
| `POST /slots/<id>/erase`                       | Clear slot's KV without freeing the slot                             |

**Caveats**

- Blocked when `--mmproj` (multimodal projector) is loaded — upstream
  issue [#21133](https://github.com/ggml-org/llama.cpp/issues/21133).
- Broken on recurrent / mamba models — issue
  [#22384](https://github.com/ggml-org/llama.cpp/issues/22384). Fine for
  dense Qwen3-derived eliza-1 checkpoints.

## How to flip it on

1. Wait for the buun-llama-cpp merge to land (44 quant-id enum conflicts
   resolved; binaries re-shipped).
2. Set `ELIZA_CTX_CHECKPOINTS=1` in the env. The dev orchestrator already
   forwards it through `bun run dev` / `bun run dev:desktop`.
3. Restart the local-inference server. On boot:
   - `appendCtxCheckpointFlags` in `dflash-server.ts` probes
     `<binary> --help` for `--ctx-checkpoints` and appends
     `--ctx-checkpoints N --ctx-checkpoint-interval M` from the catalog
     (`shared/src/local-inference/catalog.ts` —
     `ctxCheckpointsForTier`).
   - `GatedCheckpointManager.detectCapability()` probes the running
     server (`GET /health` — looks for `slot_save_path` or an explicit
     `ctx_checkpoints_supported: true` field) and caches the result.
4. `CheckpointPolicy` then issues real REST calls on every VAD
   transition. No code change needed in `turn-controller.ts` once the
   wiring described below is in place.

## Feature-flag behavior matrix

| Flag (`ELIZA_CTX_CHECKPOINTS`) | Server supports? | `save` / `restore` / `erase`           | `cancel`                    |
|--------------------------------|------------------|----------------------------------------|-----------------------------|
| OFF                            | n/a              | no-op + debug log                      | SSE-disconnect callback     |
| ON                             | NO (probe fails) | no-op + warn log                       | SSE-disconnect callback     |
| ON                             | YES (probe ok)   | REST `POST /slots/<id>/{save,restore}` | `DELETE /slots/<id>`        |

The wrapper short-circuits when either gate is off so callers can write
unconditional `policy.onSpeechPause / onSpeechResume / onSpeechEndCommit /
onHardStop` calls.

## Module layout

```
packages/app-core/src/services/local-inference/
  dflash-server.ts                       (existing) ─ appends --ctx-checkpoints args
  dflash-checkpoint-client.ts            (existing) ─ thin REST adapter + /health probe
  checkpoint-manager.ts                  (existing) ─ GatedCheckpointManager (flag + capability + registry + TTL)
  voice/checkpoint-manager.ts            (existing) ─ REST + Mock managers (slot-id strings + handles)
  voice/checkpoint-policy.ts             (new)      ─ VAD events → save/restore/erase/cancel
  voice/optimistic-rollback.ts           (existing) ─ legacy state-machine controller (still used by voice loop)
  voice/voice-state-machine.ts           (existing) ─ alternative explicit FSM
  __tests__/checkpoint-manager.test.ts   (new)
  voice/__tests__/checkpoint-policy.test.ts (new)
```

## Voice state-machine wiring

`CheckpointPolicy` is intentionally a free-standing module so it can be
landed without touching `turn-controller.ts`, `pipeline.ts`,
`pipeline-impls.ts`, `vad.ts`, `scheduler.ts`, `phrase-chunker.ts`,
`barge-in.ts`, `transcriber.ts`, or anything under `voice/kokoro/` /
`voice/streaming-asr/` — those files are owned by other agents.

The turn-controller owner picks up the wiring in a follow-up PR:

```
                       ┌───────────────────────────┐
                       │   GatedCheckpointManager  │
                       │   - flag / capability     │
                       │   - named registry / TTL  │
                       └────────────┬──────────────┘
                                    │
                       ┌────────────▼──────────────┐
                       │     CheckpointPolicy      │
                       └────────────┬──────────────┘
                                    │
                       ┌────────────▼──────────────┐
                       │     TurnController        │
                       │   ┌─────────────────────┐ │
       speech-pause ───┼──▶│ policy.onSpeechPause│ │  ──▶  save C1
                       │   └─────────────────────┘ │       (kick speculative draft)
       speech-active ──┼──▶│ policy.onSpeechResume│──▶  restore C1 if draft fired
                       │   └─────────────────────┘ │
       speech-end ─────┼──▶│ policy.onSpeechEnd…  │──▶  erase C1 (commit)
                       │   └─────────────────────┘ │
       mute / barge-in │   ┌─────────────────────┐ │
       / dispose ──────┼──▶│ policy.onHardStop   │──▶  restore→erase OR cancel
                       │   └─────────────────────┘ │
                       └───────────────────────────┘
```

### Pseudocode for the turn-controller (do NOT apply in this PR)

```ts
// At session start — one per slot.
const ckpt = new GatedCheckpointManager({ baseUrl, fetchImpl });
await ckpt.detectCapability();
const policy = new CheckpointPolicy({
  manager: ckpt,
  events: { onError: voiceTelemetry.onCheckpointError },
});

// VAD speech-pause handler
await policy.onSpeechPause(this.turnId, this.slotId);
this.kickSpeculativeDraft(...);

// VAD speech-active handler (within rollback window)
await policy.onSpeechResume(this.turnId, this.slotId, {
  speculativeFired: this.speculativeFired,
});
this.speculativeAbort?.abort();

// speech-end → SPEAKING (verifier promoted the draft)
await policy.onSpeechEndCommit(this.turnId, this.slotId);

// dispose / mute / app-background / mid-SPEAKING barge-in
await policy.onHardStop(this.turnId, this.slotId, () => {
  this.speculativeAbort?.abort();  // existing SSE-disconnect path
});
```

## Capability detection

`GatedCheckpointManager.detectCapability()` is conservative:

- Returns `false` whenever the feature flag is off (no point probing).
- Returns `false` on any network/fetch error or non-2xx response.
- Returns `true` only when `GET /health` returns a JSON object
  containing **either** `ctx_checkpoints_supported: true` **or** a
  non-empty `slot_save_path` string.

Cached per `baseUrl`; `setBaseUrl()` clears the cache (e.g. on server
restart). Call with `force=true` to bypass the cache.

## Rollback testing strategy

The scaffold lands without real-model integration tests for two
explicit reasons:

1. The fork merge hasn't happened yet — there is no binary to point real
   tests at.
2. Loading real models risks OOM on the dev box (Mac with 64GB; the
   2025-05-11 Apollo training run already pushed the limit).

So this scaffold ships:

- **Unit tests with mocked fetch** (`__tests__/checkpoint-manager.test.ts`)
  covering flag matrix, capability cache, TTL eviction, REST URLs.
- **Unit tests with stub manager** (`voice/__tests__/checkpoint-policy.test.ts`)
  covering each VAD event → checkpoint op mapping.

When the fork merge lands the follow-up PR adds:

- **Capability-probe integration test** against a real `llama-server`
  spawned with a 100KB stub GGUF (or the smallest `eliza-1-0_8b` if the
  CI runner has the RAM).
- **`save → restore` round-trip integration test** asserting that the
  KV state after `restore` produces the same logits as the pre-save
  decode.
- **Rollback-fidelity benchmark** in `voice-bench`: simulate
  `speech-pause` → speculative draft → `speech-active` and assert the
  next turn's prompt KV matches the baseline (no speculative bleed-in).

## Prerequisites before flipping `ELIZA_CTX_CHECKPOINTS=1` in production

- [ ] Upstream llama.cpp PR with `--ctx-checkpoints` merged into
      `master`.
- [ ] buun-llama-cpp fork rebased on top; 44 quant-id enum conflicts
      resolved by hand.
- [ ] Fork binary re-shipped via the bundled-models pipeline; the
      `probeCtxCheckpointsSupported` runtime check passes against the
      packaged binary.
- [ ] CI matrix runs the capability-probe integration test green on
      macOS / Linux x86 / Linux aarch64.
- [ ] Rollback-fidelity benchmark within 1 % of baseline logits.
- [ ] mmproj-loaded voice paths gated off (the upstream feature is
      currently broken with `--mmproj`; the voice pipeline checks
      `appendCtxCheckpointFlags` skip when mmproj is set, but the
      pipeline plumbing needs a separate audit).
- [ ] Recurrent / mamba model variants explicitly excluded from the
      capability probe (dense Qwen3-derived eliza-1 only).
