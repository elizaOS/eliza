# Eliza-1 Smallest-Tier Fine-Tuning Runbook

This runbook is the release contract for fine-tuning Eliza-1 components.
Only the smallest active component in each model family is fine-tuned by
default; larger tiers inherit the validated recipe after the smallest run
passes base-vs-finetuned evals and bundle gates.

## Scope

| family | fine-tune target | base artifact | publish target |
| --- | --- | --- | --- |
| text | `eliza-1-0_8b` | `Qwen/Qwen3.5-0.8B-Base` | `bundles/0_8b/text/` |
| drafter | `drafter-0_8b` | 0.8B text target features | `bundles/0_8b/dflash/` |
| ASR | `eliza-1-asr` | `ggml-org/Qwen3-ASR-0.6B-GGUF` | `bundles/0_8b/asr/` |
| TTS voice | default Kokoro/voice adapter | `hexgrad/Kokoro-82M` / default voice corpus | `bundles/0_8b/tts/` |
| turn detector | smallest turn detector head | active turn detector base config | `bundles/0_8b/turn/` |
| image generation | SD 1.5 adapter only | `imagegen/sd-1.5-Q5_0.gguf` lineage | `bundles/0_8b/imagegen/` |

Do not start 2B, 4B, 9B, or 27B fine-tunes until the matching smallest
family run has a baseline eval, finetuned eval, regression comparison, and
bundle manifest evidence.

## Text SFT

Run the 0.8B APOLLO path against the active `sft/0_8b` release package in
`elizaos/eliza-1-training`. The current published 0.8B SFT package is
`chat_messages` JSONL (`{"messages":[...]}`), not `eliza_native_v1`; it is
validated by `sft/0_8b/validation.json` and is compatible with
`train_local.py --train-file`.

```bash
hf download elizaos/eliza-1-training \
  --type dataset \
  --include 'sft/0_8b/*' \
  --local-dir /tmp/eliza-1-training

uv run --extra train python scripts/run_pipeline.py \
  --registry-key qwen3.5-0.8b \
  --train-file /tmp/eliza-1-training/sft/0_8b/train.jsonl \
  --val-file /tmp/eliza-1-training/sft/0_8b/val.jsonl \
  --test-file /tmp/eliza-1-training/sft/0_8b/test.jsonl \
  --epochs 1 \
  --run-name eliza-1-0_8b-finetuned-v2
```

Required evidence:

- `bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf`
- provenance metadata tying the artifact to `elizaos/eliza-1-training/sft/0_8b`
- baseline and finetuned `eliza_bench` reports
- baseline and finetuned `native_tool_call` reports
- baseline and finetuned `structured_response` reports
- `evidence/training/fine-tune-comparison.json` with
  `comparisons.0_8b.passed=true` and `beatsBaseline=true`

Do not reuse the legacy `0_6b` SFT artifact or comparison reports for the
active release gate; the live audit rejects legacy-only evidence.

## DFlash Drafter

Distill the smallest drafter only after the 0.8B target model is fixed:

```bash
bash scripts/dflash/jobs/distill_dflash_0_8b.sh
python scripts/dflash/validate_drafter.py \
  --target bundles/0_8b/text/eliza-1-0_8b-128k.gguf \
  --drafter bundles/0_8b/dflash/drafter-0_8b.gguf
```

Publish only if the DFlash acceptance gate improves or preserves latency
without regressing correctness.

## ASR

Use the smallest Qwen3 ASR lineage and a real-recorded labelled corpus:

```bash
uv run --extra train python scripts/asr/finetune_asr.py \
  --config scripts/asr/configs/base.yaml \
  --model ggml-org/Qwen3-ASR-0.6B-GGUF
```

The publish WER must come from explicit real-recorded provenance, not a TTS
loopback directory.

## TTS Voice

For Kokoro/default voice work, run the LoRA smoke/full path on the smallest
voice model:

```bash
bash scripts/kokoro/run_finetune.sh \
  scripts/kokoro/configs/kokoro_lora_ljspeech.yaml
```

Package only the default voice artifact and eval it against the baseline
voice before updating `bundles/0_8b/tts/`.

## Turn Detector

Fine-tune only the smallest turn detector head:

```bash
uv run --extra train python scripts/turn_detector/finetune_turn_detector.py \
  --config scripts/turn_detector/configs/turn_detector_eliza1_drafter.yaml
```

The endpoint and false-barge-in metrics must feed the bundle eval aggregate.

## Image Generation

Image generation defaults to deployed GGUF runtime artifacts. If an adapter
is trained, constrain it to the SD 1.5 small-tier default first and validate
through `stable-diffusion.cpp` packaging before any larger image model work:

```bash
node plugins/plugin-local-inference/scripts/probe-sd-cpp.mjs --json
bun test plugins/plugin-local-inference/__tests__/imagegen-routing.test.ts \
  plugins/plugin-local-inference/__tests__/imagegen-publishing.test.ts
```

Do not mark image generation release-ready from training alone. The required
evidence is: bundle artifact hash, runtime routing parity, backend probe
support, and platform-specific smoke evidence.
