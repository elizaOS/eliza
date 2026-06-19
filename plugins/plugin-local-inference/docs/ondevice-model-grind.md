# On-device "grind all models" self-test — route + runner

Companion to [`memory-and-e2e-latency-review.md`](./memory-and-e2e-latency-review.md)
§5. The runner loads and exercises every local Eliza-1 model reachable from the
iOS native bridge and emits per-model + overall timing/telemetry so we can prove,
on the phone, that each model actually works.

## Runner

`runModelGrind(deps)` lives in
`plugins/plugin-capacitor-bridge/src/ios/model-grind.ts`. Native helpers are
injected (`ModelGrindDeps`) from `ios/bridge.ts`, so the orchestration is
testable without native coupling (`model-grind.test.ts`).

It runs three checks in sequence, each capturing its own error instead of
aborting (the point of a grind is to report *which* model fails):

| # | Model | Exercise | Metric | Pass criteria |
|---|---|---|---|---|
| 1 | `text` | load `TEXT_SMALL` + `llama_generate` (48 tok; MTP accept count if available) | `tokens_per_sec` | non-empty output, `outputTokens > 0` |
| 2 | `tts` | synthesize `GRIND_PHRASE` → WAV | `rtf` (real-time factor) | ≥ 0.3 s of decoded audio |
| 3 | `asr` | resample the TTS WAV to 16 kHz → transcribe | `wer` (token Levenshtein vs the phrase) | non-empty transcript **and** WER ≤ 0.5 |

Check 3 is the gold end-to-end gate: the TTS→ASR round-trip proves both
synthesis and recognition produce correct output together. Memory is sampled
before/after and at each step (`available_ram_gb`) to derive
`peakUsedDeltaGb`. The result is a `ModelGrindReport` (device probe, memory
deltas, per-model `ModelGrindResult[]`, `overall.allPassed/passed/failed`).

`wordErrorRate`, `decodeWavToPcm` (int16/float32 RIFF/WAV), and `resamplePcm`
are exported and unit-tested.

## Triggers

Both invoke the same `runModelGrind` from `ios/bridge.ts`:

1. **Boot self-test (env-gated).** `ELIZA_IOS_RUN_MODEL_GRIND=1` runs the grind
   once the native host IPC is wired (`ios/bridge.ts:499`), logs
   `[model-grind] REPORT <json>`, and writes `model-grind-report.json` into the
   iOS app-support dir. If the host never wires, it logs and skips (no crash).
2. **On-demand dev route.** `POST /api/dev/model-grind` (`ios/bridge.ts:3018`)
   runs it and returns the `ModelGrindReport` as JSON — use this to re-grind a
   running device without a relaunch.

## What it does NOT cover yet

The current runner grinds text + TTS + ASR. VAD boundary MAE, embedding, and
vision-describe are exercised elsewhere (latency review §5 lists the full target
metric set); folding them into the same report is a follow-up so a single grind
proves *every* modality on the device.
