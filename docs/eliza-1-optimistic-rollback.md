# Eliza-1 Voice — Optimistic Decode with Rollback

Status: scaffolded, gated behind a feature flag. Upstream llama.cpp merge
(`--ctx-checkpoints`) is queued; our buun-llama-cpp fork has a 44-file
quant-id conflict that blocks the rebase. JS code paths ship today so the
moment the fork build picks up the flag, the runtime probe in
`dflash-server.ts` flips and the feature can be enabled without further code
changes.

## Why

The voice loop's pause hangover currently has to choose between two
behaviors:

1. **Wait the full hangover (~220 ms) before responding** — minimizes false
   cuts but adds a fixed 220 ms latency floor to every turn.
2. **Respond on first pause** — fast, but cuts the user off whenever they
   pause mid-thought.

Upstream llama.cpp's mid-prefill checkpoint feature lets us have both: take
a KV snapshot at the moment we detect a pause, run the response decode
speculatively, and roll back to the snapshot if the user resumes. The
worst-case extra cost is one snapshot write + one restore read (both happen
inside the slot's `--slot-save-path` directory; effectively a memcpy at the
sizes we use). The best case is that we save the full hangover budget on
every turn the user actually finished.

## State machine

```
IDLE
  │ speech-start
  ▼
LISTENING
  │ speech-pause
  ▼
PAUSE_TENTATIVE  ── speech-active (within rollback window) ──▶ LISTENING
  │                                                              ▲
  │ speech-end (or pause > rollback window)                       │
  ▼                                                               │
DRAFT_RESPONSE  ──── speech-active (within rollback window) ──────┘
  │                  (restore checkpoint, abort drafter)
  │ commit
  ▼
COMMITTED → IDLE
```

Implemented in
`packages/app-core/src/services/local-inference/voice/optimistic-rollback.ts`.
The controller subscribes to `VadEvent` from `VadDetector` (`voice/vad.ts`).
It does **not** modify the turn controller, scheduler, phrase chunker, VAD,
barge-in, pipeline, or transcriber. The voice agent owning those files
composes this controller in once the merge lands.

### Rollback window

Rollback window = `2 × pauseHangoverMs`. Default hangover is 220 ms; rollback
window is therefore 440 ms. A `speech-active` event arriving outside the
window commits rather than rolls back — by then the speculative drafter has
likely produced several phrases, and the cheaper move is to keep them.

## Checkpoint primitives

REST endpoints (upstream llama.cpp `master`):

- `POST /slots/<id>/save?filename=<name>` — write the slot's full KV state
  (including the mid-prefill checkpoint chain) to `<--slot-save-path>/<name>`.
  Atomic — either the file lands or the call fails.
- `POST /slots/<id>/restore?filename=<name>` — replace the slot's current
  state with the contents of `<name>`. The slot must be idle or its
  in-flight decode is implicitly cancelled.
- `DELETE /slots/<id>` — cancel any in-flight generation on the slot. Used
  on rollback to abort the speculative drafter cleanly.

Server-side flags wired via
`packages/app-core/src/services/local-inference/dflash-server.ts`:

- `--ctx-checkpoints N` — how many mid-prefill snapshots the server retains
  per slot. Larger = more rollback granularity, more disk.
- `--ctx-checkpoint-interval M` — tokens between checkpoints during
  prefill.

Defaults are tier-specific (declared in
`packages/shared/src/local-inference/catalog.ts`):

| Tier      | `ctxCheckpoints` | `ctxCheckpointInterval` |
|-----------|------------------|-------------------------|
| 0.6b/1.7b | 4                | 4096                    |
| 4b/9b     | 8                | 8192                    |
| 27b       | 16               | 8192                    |

The server-side flags are guarded by a runtime probe
(`probeCtxCheckpointsSupported`): we run `llama-server --help` and grep for
`--ctx-checkpoints`. If absent, the flags aren't passed and a warning is
logged once per binary path. This keeps every existing buun-llama-cpp build
unbroken while the JS side waits for the fork merge.

## Feature flag

`OptimisticRollbackControllerOptions.enableOptimisticRollback` (default
`false`). When `false`:

- The controller still subscribes to VAD events and tracks state for
  telemetry parity.
- No REST calls fire. No speculative draft starts.
- Behavior is indistinguishable from the no-rollback path for the user.

### Rollout plan

1. **Off (current)** — code lands; flag defaults to `false`. Buun-llama-cpp
   master rebase happens.
2. **10%** — flip to `true` for new sessions where
   `hash(userId) % 10 === 0`. Watch `onCheckpointError` rate, p95 voice TTR,
   and the rollback/commit ratio.
3. **50%** — bake one week. If `onCheckpointError` stays below 0.1% of
   pauses and TTR doesn't regress, advance.
4. **100%** — flag still exists as a kill switch but defaults `true`.

## Telemetry

`OptimisticRollbackTelemetry` exposes four lifecycle events plus an error
sink:

- `onCheckpointSaved(handle, turnId)` — slot snapshot landed.
- `onCheckpointRestored(handle, turnId)` — slot was rolled back.
- `onSpeculativeDraftStarted(turnId)` — drafter took the partial.
- `onSpeculativeDraftAborted(turnId, reason)` — drafter was cancelled.
  Reasons: `resumed`, `committed`, `shutdown`.
- `onCheckpointError(op, error, turnId)` — surfaced when the checkpoint
  client raised. Op ∈ {`save`, `restore`, `cancel`}.

Wire these into the existing voice-bench trajectory captures
(`packages/voice-bench`). The ratio `restored / saved` is the headline
metric — at saturation it tells us how often the optimistic path actually
buys us latency.

## Known limitations

- **Multimodal blocked**: upstream issue #21133 — `--mmproj` + slot save
  is currently broken upstream. The controller will be disabled
  automatically for any model load that includes a multimodal projector
  until the upstream fix lands. Catalog `optimizations.mmproj` is the
  signal.
- **Snapshot disk pressure**: 16 checkpoints × 27b KV ≈ a few hundred MB
  per slot. The catalog `ctxCheckpoints` defaults keep the total bounded;
  if disk pressure shows up in telemetry we drop the 27b default to 8.
- **Single-slot scope**: the controller assumes a fixed `slotId` for the
  turn (the voice loop pins this via the conversation registry). Multi-slot
  rollback is out of scope.

## Measurement

The optimistic-rollback win is "p95 voice TTR with rollback enabled vs
disabled" measured by `packages/voice-bench`. The benchmark already simulates
mid-utterance pauses; add a `--with-rollback` arm once 10% rollout is live.

Cross-link: `packages/voice-bench/README.md` for the voice TTR measurement
methodology, and `packages/inference/AGENTS.md` §4 for the broader voice
loop architecture this composes into.

## File map

- `packages/shared/src/local-inference/types.ts` —
  `LocalRuntimeOptimizations.ctxCheckpoints*` fields.
- `packages/shared/src/local-inference/catalog.ts` — per-tier defaults via
  `ctxCheckpointsForTier`.
- `packages/app-core/src/services/local-inference/dflash-server.ts` —
  `probeCtxCheckpointsSupported`, `appendCtxCheckpointFlags`, wired into
  `start()`.
- `packages/app-core/src/services/local-inference/dflash-checkpoint-client.ts`
  — REST client (`CheckpointClient`).
- `packages/app-core/src/services/local-inference/voice/optimistic-rollback.ts`
  — state machine controller.
- Tests: `__tests__/dflash-checkpoint-client.test.ts`,
  `voice/__tests__/optimistic-rollback.test.ts`.
