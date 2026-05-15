# Turn-detector fine-tune pipeline

Eliza-1 ships a bundled semantic end-of-turn (EOT) detector — one of three
Tier-3 EOU classifiers the runtime resolves at voice-session start
(`plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`).
Per device tier:

| Tier              | Bundle revision      | Backbone                       | On-disk (Q8 ONNX) | Languages |
| ----------------- | -------------------- | ------------------------------ | ----------------- | --------- |
| `0_8b`, `2b`      | `v1.2.2-en`          | SmolLM2-135M distilled         | ~66 MB            | EN only   |
| `4b`+             | `v0.4.1-intl`        | Pruned Qwen2.5-0.5B            | ~396 MB           | 14 langs  |
| `--turn-license=apache` (override) | n/a | SmolLM2-135M binary head (`latishab/turnsense`) | ~176 MB | EN only |

This directory hosts the **fine-tune + eval pipeline** for those models:

- `finetune_turn_detector.py` — LoRA / APOLLO finetune entrypoint. Reads a
  YAML config (`configs/turn_detector_<tier>.yaml`), supports either the
  text-only path (Option A in [R1](../../../../.swarm/research/R1-turn.md))
  or the future joint-with-text-LM path (Option B).
- `eval_turn_detector.py` — Computes F1 + mean detection latency on the
  configured held-out set. Gates a publish at:
  - `F1 ≥ 0.85`  (`TURN_DETECTOR_F1_THRESHOLD` in the manifest schema)
  - `meanLatencyMs ≤ 30` (`TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT`)
- `test_turn_detector_pipeline.py` — Smoke test for the eval threshold logic
  and the resolver/config IO so the scaffold stays runnable as the real
  finetune code lands.

## Data sources

- **TURNS-2K** (Apache-2.0, EN). Bundled with `latishab/turnsense`. 2 000
  samples covering backchannels, self-corrections, code-switching, STT
  formatting variants. Primary EN intrinsic eval.
- **Easy Turn** (arXiv 2509.23938). Four-state labels (complete /
  incomplete / backchannel / wait); paired audio + transcript. Useful for
  the future joint-with-text-LM path.
- **Our own trajectories** (privacy-filtered). Every voice turn the
  runtime records (when `ELIZA_DISABLE_TRAJECTORY_LOGGING != 1`) yields a
  `(transcript-so-far, did-the-user-continue-within-1s)` pair from VAD
  events. Becomes the dominant signal once we have several hundred hours.
- For multilingual coverage: NoXi (subject to per-corpus licensing) and the
  YODAS Thai EOU subset for Thai support (v2 only).

All data goes through the workspace privacy filter
(`eliza/plugins/plugin-training/src/core/privacy-filter.ts`) before it lands
on disk. No raw user transcript or audio escapes that boundary.

## Quick start (smoke)

```bash
uv run --extra train pytest \
  packages/training/scripts/turn_detector/test_turn_detector_pipeline.py
```

## Real run (LoRA + eval, English tier)

```bash
# 1) Stage TURNS-2K (Apache-2.0 mirror) + the optional Easy Turn split.
uv run --extra train python -m scripts.turn_detector.finetune_turn_detector \
    --config packages/training/scripts/turn_detector/configs/turn_detector_en.yaml \
    --out artifacts/turn-detector-en/ \
    --epochs 3

# 2) Eval the resulting ONNX export.
uv run --extra train python -m scripts.turn_detector.eval_turn_detector \
    --model artifacts/turn-detector-en/onnx/model_q8.onnx \
    --tokenizer artifacts/turn-detector-en/tokenizer.json \
    --testset packages/training/data/turn/TURNS-2K/test.jsonl \
    --report artifacts/turn-detector-en/eval.json
```

`eval.json` carries `{ "f1": <0..1>, "meanLatencyMs": <ms>, "passed": <bool> }`;
the publish orchestrator copies it into the manifest `evals.turnDetector`
slot the runtime validator enforces.

## Eliza-1 drafter target (alternative — runs *on* the live drafter)

`configs/turn_detector_eliza1_drafter.yaml` trains a LoRA adapter on top
of the eliza-1 drafter (the small model DFlash already keeps warm for
speculative decoding) instead of a standalone ONNX. The runtime layers
the adapter onto a dedicated EOT context at voice-session start and
reads P(`<|im_end|>`) directly off the live model — see
[`plugins/plugin-local-inference/src/services/voice/eliza1-eot-scorer.ts`](../../../../plugins/plugin-local-inference/src/services/voice/eliza1-eot-scorer.ts).

```bash
uv run --extra train python -m scripts.turn_detector.finetune_turn_detector \
    --config packages/training/scripts/turn_detector/configs/turn_detector_eliza1_drafter.yaml \
    --out artifacts/turn-detector-eliza1-drafter/ \
    --epochs 3

# Convert the saved torch LoRA to GGUF for the runtime to consume.
# `convert_lora_to_gguf.py` ships with the llama.cpp checkout — see
# `EXPORT-NEXT-STEP.txt` written under the run dir.
python llama.cpp/convert_lora_to_gguf.py \
    --base elizaos/eliza-1 \
    --revision bundles/2b/drafter \
    artifacts/turn-detector-eliza1-drafter/checkpoints/best.pt \
    --outfile artifacts/turn-detector-eliza1-drafter/eot-lora.gguf
```

The resulting `.gguf` adapter ships under the manifest slot
`files.eotLoraAdapter` (see
[`schema.ts`](../../../../plugins/plugin-local-inference/src/services/manifest/schema.ts))
and the runtime loads it via `startVoiceSession({ useEliza1Eot: true,
eliza1EotLoraPath })` — operators can also force this path by setting
`ELIZA_VOICE_EOT_BACKEND=eliza-1` in the env.

Trade-offs vs the LiveKit/Turnsense ONNX path:

| Aspect                | LiveKit ONNX                | Eliza-1 drafter LoRA            |
| --------------------- | --------------------------- | ------------------------------- |
| On-disk weight cost   | 66–396 MB (separate ONNX)   | ~few MB adapter (no base model) |
| Cold start            | Loads ONNX runtime + ONNX   | Reuses the drafter context      |
| Calibration baseline  | Distilled SmolLM2 / Qwen2.5 | Vanilla drafter + LoRA          |
| Multilingual coverage | 14 langs (intl revision)    | Inherits eliza-1 vocab coverage |
| Backend requirement   | Works with any text backend | `node-llama-cpp` in-process     |

The eliza-1-drafter path is preferred when the in-process backend is
active. The runtime falls back to LiveKit transparently when the
drafter is not loaded (e.g. `llama-server` subprocess builds).

## Cancellation contract (handshake with R11)

Turn detection emits a `VoiceTurnSignal` (data); it **never** aborts a
turn directly. The controller above it (`VoiceTurnController`) consumes
the signal and decides whether to suppress speculative generation via
`BargeInCancelToken.signal` with reason `"turn-suppressed"`. See
[`.swarm/research/R11-cancellation.md`](../../../../.swarm/research/R11-cancellation.md).

## See also

- [R1 research report](../../../../.swarm/research/R1-turn.md) — full
  spec, device-tier mapping, and effort estimates.
- [`stage_eliza1_bundle_assets.py`](../manifest/stage_eliza1_bundle_assets.py)
  — the staging step that pulls the matching ONNX for each tier
  (`stage_turn_detector` / `--turn-license={livekit,apache}`).
- [`plugins/plugin-local-inference/src/services/manifest/schema.ts`](../../../../plugins/plugin-local-inference/src/services/manifest/schema.ts)
  — `Eliza1EvalsSchema.turnDetector` + the threshold constants
  (`TURN_DETECTOR_F1_THRESHOLD`, `TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT`).
