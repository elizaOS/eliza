# Eliza-1 Smallest-Tier Fine-Tuning Runbook

This runbook is the release contract for fine-tuning Eliza-1 components.
Only the smallest active component in each model family is fine-tuned by
default; larger tiers inherit the validated recipe after the smallest run
passes base-vs-finetuned evals and bundle gates.

## Scope

| family | fine-tune target | base artifact | publish target |
| --- | --- | --- | --- |
| text | `eliza-1-2b` | `google/gemma-4-E2B` via `gemma4-e2b` | `bundles/2b/text/` |
| drafter | `drafter-2b` | 2B text target features | `bundles/2b/mtp/` |
| ASR | frozen until verified Gemma ASR artifacts exist | no active base configured | `bundles/2b/asr/` |
| TTS voice | default Kokoro/voice adapter | `hexgrad/Kokoro-82M` / default voice corpus | `bundles/2b/tts/` |
| turn detector | smallest turn detector head | active turn detector base config | `bundles/2b/turn/` |
| image generation | SD 1.5 adapter only | `imagegen/sd-1.5-Q5_0.gguf` lineage | `bundles/2b/imagegen/` |

Do not start 2B, 4B, 9B, or 27B fine-tunes until the matching smallest
family run has a baseline eval, finetuned eval, regression comparison, and
bundle manifest evidence.

## Text SFT

Run the 2B APOLLO path against the active `sft/2b` release package in
`elizaos/eliza-1-training`. The current published 2B SFT package is
`chat_messages` JSONL (`{"messages":[...]}`), not `eliza_native_v1`; it is
validated by `sft/2b/validation.json` and is compatible with
`train_local.py --train-file`.

```bash
hf download elizaos/eliza-1-training \
  --type dataset \
  --include 'sft/2b/*' \
  --local-dir /tmp/eliza-1-training

uv run --extra train python scripts/run_pipeline.py \
  --registry-key gemma4-e2b \
  --train-file /tmp/eliza-1-training/sft/2b/train.jsonl \
  --val-file /tmp/eliza-1-training/sft/2b/val.jsonl \
  --test-file /tmp/eliza-1-training/sft/2b/test.jsonl \
  --epochs 1 \
  --run-name eliza-1-2b-finetuned-v2
```

Required evidence:

- `bundles/2b/finetuned-v2/eliza-1-2b-sft.gguf`
- provenance metadata tying the artifact to `elizaos/eliza-1-training/sft/2b`
- baseline and finetuned `eliza_bench` reports
- baseline and finetuned `native_tool_call` reports
- baseline and finetuned `structured_response` reports
- `evidence/training/fine-tune-comparison.json` with
  `comparisons.2b.passed=true` and `beatsBaseline=true`

Do not reuse the legacy `0_6b` SFT artifact or comparison reports for the
active release gate; the live audit rejects legacy-only evidence.

## MTP Drafter

The in-repo drafter distiller and validator (`scripts/distill_mtp_drafter.py`,
`scripts/mtp/validate_drafter.py`) were removed. Release-grade from-scratch
drafter distillation is H100/H200-gated and done out of band; it is not required
for a release-shaped bundle.

The supported, no-train path converts the published Gemma-4 MTP drafter to the
`mtp-draft` GGUF arch and A/B-validates it against the target, then stages it at
`bundles/2b/mtp/drafter-2b.gguf`. Full runbook:
`plugins/plugin-local-inference/docs/gemma4-mtp-drafter-conversion.md`.

Publish only if the MTP acceptance gate improves or preserves latency
without regressing correctness.
The half-context 128k text GGUF remains a runtime variant, but drafter
validation targets the native 256k text artifact.

## ASR

ASR is frozen for the active Gemma cutover. Do not launch real ASR
fine-tuning until a verified Gemma-compatible ASR checkpoint and matching
projector are hosted and wired into the bundle staging scripts. The legacy
ASR scaffold remains available for synthetic CI shape checks only; real
train/eval fails closed when no active Gemma-compatible `base_model` is
configured.

```bash
uv run --extra train python scripts/asr/finetune_asr.py \
  --config scripts/asr/configs/base.yaml \
  --synthetic-smoke
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
voice before updating `bundles/2b/tts/`.

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
