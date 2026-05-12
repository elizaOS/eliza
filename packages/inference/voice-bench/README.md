# @elizaos/voice-bench

Voice-loop benchmark harness for the Eliza-1 voice pipeline.

A deterministic, replayable harness that drives the real voice pipeline
with synthetic audio inputs and measures latency, barge-in behavior, and
rollback waste. **Per AGENTS.md "evidence-or-it-didn't-happen" rule,
every optimization PR that touches the voice loop ships this harness's
JSON output as proof.**

## What it measures

The harness records timestamps for every observable transition in the
mic → ASR → drafter ∥ verifier → chunker → TTS pipeline (see
`BenchEventName` in `src/types.ts`) and derives:

| Metric | Definition |
|---|---|
| **TTFA** (★ primary) | `t_tts_first_audio − t_speech_start` |
| **Perceived response latency** | `t_tts_first_audio − t_speech_end` |
| **Barge-in response** | `t_barge_in_hard_stop − t_barge_in_trigger` |
| **Rollback waste** | drafter tokens rejected / drafter tokens proposed |
| **DFlash acceptance** | when DFlash is wired |
| **Peak RSS / CPU / GPU** | best-effort process sampling at 100 ms |

## Running

```bash
# Run all scenarios against the mock driver and write JSON
bun run --cwd packages/inference/voice-bench bench \
  --bundle eliza-1-1.7b --backend mock --scenario all --runs 3 \
  --output run.json

# Compare to a recorded baseline; exit 1 on regression
bun run --cwd packages/inference/voice-bench bench \
  --baseline baselines/M4Max-metal.json \
  --output run.json
```

Unit tests:

```bash
bun run --cwd packages/inference/voice-bench test
bun run --cwd packages/inference/voice-bench typecheck
```

Regenerate fixture WAVs into `fixtures/`:

```bash
bun run --cwd packages/inference/voice-bench generate-fixtures
```

The `fixtures/` directory is gitignored — the harness uses in-memory
fixtures by default and only writes WAVs when you ask it to.

## Scenario catalog

| ID | Shape | What it exercises |
|---|---|---|
| `short-turn` | 1.5 s utterance | Baseline TTFA on a healthy pipeline |
| `long-turn` | 8 s utterance | Verifier coverage; no token drop |
| `false-end-of-speech` | utterance with 400 ms mid-clause pause | Voice state machine `PAUSE_TENTATIVE → LISTENING` rollback (C1 discard) |
| `barge-in` | utterance + overlay at t=3 s | Hard-stop within 200 ms |
| `barge-in-mid-response` | utterance + overlay at t=5 s | Voice state machine `SPEAKING → LISTENING` rollback (C1 restore) |
| `cold-start` | first turn on a fresh process | Load-side latency |
| `warm-start` | second turn after prewarm | Steady-state TTFA |

Rollback scenarios report two extra fields on top of the per-fixture
`BenchMetrics`:

- `rollbackCount` — number of `rollback-drop` events the pipeline emitted
  (one per C1 discard or C1 restore).
- `rollbackWasteTokens` — drafter tokens thrown away because the state
  machine rolled back. The driver may supply this directly; otherwise the
  harness sums `data.tokens` from each `rollback-drop` event.

## Eval gates

Defined in `src/gates.ts`. Defaults:

| Metric | Warn | Fail |
|---|---|---|
| TTFA p50 regression vs baseline | +20 % | +50 % |
| TTFA p95 regression vs baseline | +30 % | +50 % |
| Barge-in p95 | — | 250 ms absolute ceiling |
| False-barge-in rate | — | 0.05 / turn ceiling |
| Rollback waste | — | 0.30 ceiling |

`evaluateGates()` returns a `GateReport` with a markdown table. The CLI
emits this to stdout and exits **1** on a `fail` row.

### Updating baselines

When a real optimization legitimately improves a metric, record a new
baseline:

```bash
bun run --cwd packages/inference/voice-bench bench \
  --bundle eliza-1-1.7b --backend metal --runs 5 \
  --output packages/inference/voice-bench/baselines/M4Max-metal.json
```

Commit the JSON. Future PRs compare against it.

## Wiring the real pipeline (follow-up)

The current build ships **only** the `MockPipelineDriver`. The real
pipeline driver is a follow-up — the contract is the
`PipelineDriver` interface in `src/types.ts`. To wire it:

1. Construct a `VoicePipeline` (`packages/app-core/.../voice/pipeline.ts`)
   with real `StreamingTranscriber`, `DraftProposer`, and `TargetVerifier`
   implementations. The bench package intentionally does **not** depend on
   `@elizaos/app-core` — wire from a thin host package that owns both.
2. Inside the driver's `run(args)`, feed `args.audio.pcm` to the
   `VoiceScheduler` via its `MicSource` adapter while replaying frames
   through `SyntheticAudioSource` at wall-clock rate.
3. Attach a `VoiceBenchProbe` to each pipeline event. The events you need
   to fire (see `BenchEventName`):
   - `speech-start` / `speech-pause` / `speech-end` — from the VAD
   - `asr-partial` / `asr-final` — from `StreamingTranscriber`
   - `draft-start` / `draft-first-token` / `draft-complete` — from
     `DraftProposer`
   - `verifier-start` / `verifier-first-token` / `verifier-complete` —
     from `TargetVerifier`
   - `phrase-emit` — from the phrase chunker
   - `tts-first-pcm` — from the streaming TTS backend
   - `audio-out-first-frame` — from the ring buffer's first dequeue
   - `barge-in-trigger` / `barge-in-hard-stop` — from `BargeInController`
4. Optionally implement `dispose()` to tear down GPU resources.
5. Register the driver under a backend name (`metal`, `cuda`, `vulkan`,
   `cpu`) and add a case in `bin/voice-bench`.

`MockPipelineDriver` is a faithful skeleton of the timing model — copy
its structure for the real driver.

## Known limitations

- **Synthetic audio is not real speech.** Per
  [`docs/audits/lifeops-2026-05-11/ELIZA_1_GGUF_READINESS.md`](../../docs/audits/lifeops-2026-05-11/ELIZA_1_GGUF_READINESS.md),
  release-blocking latency gates still require a real-recorded WAV
  corpus.
- **GPU utilization is not yet sampled.** The Metal/Vulkan counter hooks
  are TBD; the field is optional in `BenchMetrics`.
- **DFlash stats are driver-supplied.** The mock returns dummy values;
  the real driver must hook into `dflash-server`.
- **Single-process only.** The harness runs the driver in-process. For
  cold-start measurement that includes shell startup, the runner needs a
  subprocess wrapper — a follow-up.

## Architecture

```
SyntheticAudioSource ─┐
                      │
                      ▼
                 PipelineDriver.run({ audio, injection, probe })
                      │
                      ▼ (BenchEventName timestamps)
                 MetricsCollector ──► BenchMetrics
                      │
                      ▼
                 aggregate() ──► BenchAggregates
                      │
                      ▼
                 evaluateGates(current, baseline) ──► GateReport (md)
```

Everything in `src/` is pure TypeScript with `strict` + no `any`. No
runtime dependency on `@elizaos/*` packages — the harness is intentionally
isolated so a `bun test` in CI doesn't drag the inference stack along.
