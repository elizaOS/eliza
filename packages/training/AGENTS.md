# AGENTS.md — Eliza-1 training & quantization

This file is the canonical contract for training, quantization,
evaluation, and HuggingFace publishing of the Eliza-1 model line. It
applies to everything under `packages/training/`.

The inference-side companion is at [`packages/inference/AGENTS.md`](../inference/AGENTS.md).
**Read it first.** The product mandates (three runtime modes, mandatory
optimizations, fused pipeline, manifest schema, HF publishing flow,
verification gates) live there, and this file does not repeat them.
This file describes what training has to *do* to satisfy that
contract.

---

## 1. What this package owns

- Text fine-tuning of the Qwen3.5/Qwen3.6 0.8B / 2B / 4B / 9B / 27B
  backbones used by the current Eliza-1 release line.
- Drafter training for DFlash speculative decoding.
- Voice handling (freeze, cache, evaluate — see §4; we do not retrain
  voice weights right now).
- Quantization recipes that produce shippable Eliza-1 artifacts:
  TurboQuant, QJL, PolarQuant, plus the fused TurboQuant pipeline.
- Eval harness for text, voice, and end-to-end voice loop.
- HuggingFace publishing of bundles to `elizaos/eliza-1` under
  `bundles/<tier>/`.
- Dataset preparation, deslop, and validation.

This package does NOT own:

- The runtime engine, downloader, or routing — those are
  `packages/app-core/src/services/local-inference/`.
- Kernels — those are `packages/inference/`.
- The build hook or kernel patches — that is
  `packages/app-core/scripts/build-llama-cpp-dflash.mjs`.

---

## 2. What we train, what we freeze

Per the inference contract (and the user mandate that weights remain
unchanged for now):

| Component       | Status                                        | Why                                  |
| --------------- | --------------------------------------------- | ------------------------------------ |
| Text backbone   | **Fine-tune** (Qwen3.5 0.8B / 2B / 4B)        | This is the primary product loop.    |
| DFlash drafter  | **Fine-tune to match the text checkpoint**    | Acceptance rate depends on alignment.|
| OmniVoice TTS   | **Frozen**                                    | No license to retrain; no eval lift. |
| ASR             | **Frozen**                                    | Same.                                |
| Vision (mmproj) | **Frozen** unless the text backbone moves     | Tied to backbone visual layers.      |

When the text backbone version bumps, the drafter must be retrained
to match. The publish script MUST refuse to bundle a drafter whose
training run did not target the same text-checkpoint hash recorded in
its metadata.

OmniVoice singing weights can ship in default Eliza-1 bundles under the
current non-commercial open-source mandate. The prior research-only gate
is lifted per `packages/inference/AGENTS.md`; if the project pivots to
commercial licensing, the CC-BY-NC-SA training-data lineage must be
re-evaluated before any commercial bundle is published.

---

## 3. Quantization (mandatory recipes)

Quantization is not optional for Eliza-1. Every published bundle MUST
flow through every applicable recipe. The required kernel set per
inference/AGENTS.md §3 dictates which recipes run.

Pipeline order (binding):

```
fp16/bf16 checkpoint
   │
   ├── TurboQuant Q3 or Q4 (text + drafter weights)
   │     scripts/quantization/turboquant_apply.py
   │     scripts/quantization/fused_turboquant_apply.py
   │
   ├── QJL projection matrices baked into KV-cache layout
   │     scripts/quantization/qjl_apply.py
   │
   ├── PolarQuant centroids + sign vectors baked into KV-cache layout
   │     scripts/quantization/polarquant_apply.py
   │
   └── (long-context-only) Trellis-coded TCQ on the largest variant
         scripts/quantization/turboquant_apply.py --trellis
```

Hard rules:

- Each recipe MUST emit a quantization manifest sidecar consumed by
  the inference manifest builder. The sidecar records: kernel target,
  block layout version, codebook hash, expected per-block tolerance.
- Each recipe MUST run its `test_*.py` against the produced artifact
  before exit. A failing test is a publish-blocking error.
- If a recipe is asked to run on weights that do not satisfy its
  preconditions (wrong layer count, wrong dtype, missing rotation), it
  MUST fail loudly. No silent passes, no skip-and-continue.

The reference implementations and on-device kernels live in
`packages/native-plugins/{qjl-cpu,polarquant-cpu}` and
`packages/inference/{vulkan,metal,reference}`. The Python recipes here
MUST stay byte-for-byte compatible with those references — when a
recipe's block layout, codebook, or sign-vector seed changes, the
references and kernels must be updated in lockstep, in the same PR.

---

## 4. Voice freeze + cache pipeline

We do not retrain voice. We do build artifacts that make voice mode
fast at runtime:

1. **Speaker preset extraction.** The default speaker embedding is
   computed once during publish and stored as
   `cache/voice-preset-default.bin` in the bundle. The runtime loads
   it directly; it does NOT re-extract from raw audio at startup.
2. **Phrase cache seed.** A small set of common assistant phrases
   ("Sure.", "One moment.", "I can't help with that.", a few dozen
   total) is pre-synthesized at publish time, encoded as PCM seeds,
   and stored alongside the speaker preset. The runtime warms the
   phrase cache from this seed; first-byte latency for these phrases
   approaches zero.
3. **Voice eval.** RTF (real-time factor), MOS proxy, ASR-roundtrip
   WER, and barge-in cancel latency are measured at publish time and
   recorded in the manifest's `evals.voiceRtf` block.

Frozen-voice rule: any change to voice weights, OmniVoice C++ source
vendor pin, or speaker preset format MUST bump the voice section's
manifest version and re-run all voice evals. A bundle whose voice
section version differs from the eval blob's recorded version is
broken — refuse to publish.

---

## 5. Pipeline entry points

These scripts under `packages/training/scripts/` are the canonical
entry points for training and publishing:

- `run_pipeline.py` — top-level training pipeline (text fine-tune).
- `train_local.py` / `train_dpo.py` / `train_grpo_verl.sh` — local /
  DPO / GRPO training entry points.
- `cloud_run.py` / `train_vast.sh` / `train_nebius.sh` — cloud training
  dispatchers.
- `quantization/*_apply.py` — quantization recipes (see §3).
- `eval_checkpoint.py` / `eval_loop.sh` / `benchmarks/` — eval harness.
- `push_model_to_hf.py` / `push_pipeline_to_hf.py` /
  `publish_pipeline_to_hf.py` / `publish_all_eliza1.sh` — HF publishing.
  These MUST be the *only* paths that push app-facing bundles to
  `elizaos/eliza-1`.
- `inference/serve_local.py` / `inference/serve_vllm.py` — eval-time
  serving harnesses (not production runtime — that is app-core).

When adding a new pipeline stage, prefer extending the existing
`run_pipeline.py` graph over inventing a parallel entry point. The
goal is one canonical command that goes from raw checkpoint to
published bundle.

---

## 6. Publishing to HuggingFace

Every Eliza-1 bundle published to `elizaos/eliza-1/bundles/<tier>` MUST go
through `publish_all_eliza1.sh` (or the per-tier publish script it
calls). That script:

1. Assembles files matching the layout in inference/AGENTS.md §2.
2. Runs every quantization recipe required for the tier.
3. Calls `make -C ../../inference/verify reference-test` and the
   relevant `metal_verify` / `vulkan_verify` runs against the
   quantized artifacts. **Hardware verification is required** — see
   inference/AGENTS.md §8.
4. Runs the eval harness: text-eval, voice-rtf, e2e-loop, 30-turn.
5. Generates `eliza-1.manifest.json` from the verification + eval
   results. Schema is defined in inference/AGENTS.md §6.
6. Generates `README.md` in the HF repo from the manifest (do not
   hand-edit the README on the HF side).
7. Pushes weights, manifest, README, licenses, and eval blobs.
8. Tags the local training repo with the released bundle ID +
   training commit hash.

Publish-blocking conditions (the script MUST exit non-zero):

- Any required kernel verification missing or failing on a backend
  the tier supports.
- Any required eval failing its tier-specific gate.
- Any quantization recipe test failing.
- Manifest schema validation failure.
- License blob missing or stale.

There is no "publish anyway with `defaultEligible: false`" path during
normal release. That flag is only set false by automated systems when
a previously-good bundle is later flagged broken — the act of *first
publishing* always requires green.

---

## 7. Datasets, deslop, validation

- Dataset preparation and deslop scripts already exist
  (`build_v2_corpus.py`, the `transform_*.py` family, `deslop_eval_splits.sh`,
  `validate_corpus.py`). The privacy filter is mandatory on every
  write path that touches real user trajectories — repo-wide
  `CLAUDE.md` enforces this; do not bypass.
- Native-tool-calling data prep is `prepare_native_tool_calling_data.py`
  with the schema at `config/native_tool_calling_record.schema.json`.
  Tool-calling cache optimization is part of the runtime contract;
  training data should match the cache-friendly call shape.
- New corpora MUST run through `validate_corpus.py` and the schema
  validators before being included in a training run. No raw scrape
  to fine-tune in one step.

---

## 8. Evaluation gates (per tier)

Every Eliza-1 publish MUST record these in the manifest's `evals`
block. Tier-specific gate values live in
`packages/training/benchmarks/` and are versioned alongside the
training pipeline:

- **Text quality.** Held-out eval at the bundle's quantized weights.
  No "evaluated at fp16, shipped at Q3" results.
- **Voice RTF.** Real-time factor under the bundle's quantization,
  measured on representative target hardware per tier (mobile tiers
  on actual phones, desktop on actual Macs/PCs, not just on a server).
- **ASR WER.** Transcription word-error rate on the standard eval set.
- **End-to-end voice loop.** Mic → ASR → text → TTS round trip,
  measuring first-token latency, first-audio latency, barge-in cancel
  latency, and 30-turn endurance.
- **DFlash acceptance rate.** Drafter token acceptance against the
  shipped target. A drafter whose acceptance rate drops below the
  tier's gate is publish-blocking.
- **Memory + thermal (mobile only).** Peak RSS under the bundle's
  context-length variants; thermal/battery profile across a 10-minute
  voice session.

The tier-specific gate values are part of the contract — changing a
gate means bumping the eval schema version and rebaselining every
shipped bundle.

---

## 9. Working style

- **Scope discipline.** Don't add a new training stage, a new dataset,
  or a new quantization recipe without checking what already exists
  under `scripts/`. The directory listing is large; reuse beats
  reinventing.
- **No defensive code.** Failing precondition checks, failing tests,
  failing eval gates are loud errors. Don't catch-and-continue. The
  whole point of the publish gate is that broken bundles never ship.
- **Reproducibility.** Every training run produces a manifest that
  records: dataset hashes, tokenizer hash, base-checkpoint hash,
  hyperparameters, training commit. The drafter's manifest records
  its target text checkpoint's hash.
- **Bit-exact with kernels.** When a quantization recipe and a kernel
  reference disagree, the kernel reference (`packages/inference/reference/`,
  `packages/native-plugins/{qjl-cpu,polarquant-cpu}`) is canonical.
  Update the recipe to match, not the other way around.
- **Branding.** Published HF repos and READMEs say `Eliza-1`. Internal
  training logs, dataset names, and source-checkpoint references may
  use upstream names — but anything users see (the HF README, the
  bundle name, the model card) says Eliza-1 and records lineage in
  the manifest, not in the marketing copy.

---

## 10. Files to read before making changes

- `packages/training/README.md` — pipeline overview.
- `packages/training/scripts/HF_PUBLISHING.md` — current HF publishing
  flow. When this and the AGENTS.md disagree, AGENTS.md is canonical;
  update HF_PUBLISHING.md to match.
- `packages/training/scripts/CLOUD_VAST.md`,
  `scripts/CHECKPOINT_SYNC.md`, `scripts/RL_TRAINING.md` — operational
  references for cloud training.
- `packages/training/scripts/quantization/README.md` — recipe-level
  reference.
- `packages/inference/AGENTS.md` — the inference-side contract
  (mandates, manifest, verification gates).
- `/Users/shawwalters/eliza-workspace/eliza/CLAUDE.md` and
  `/Users/shawwalters/eliza-workspace/eliza/AGENTS.md` — repo-wide
  conventions and cleanup mandate.
