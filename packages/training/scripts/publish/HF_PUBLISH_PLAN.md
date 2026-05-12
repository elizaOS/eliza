# Eliza-1 v1 — HuggingFace publish plan (model + datasets + results)

Companion to [`HF_PUBLISHING.md`](../HF_PUBLISHING.md) (the operator runbook) and
[`packages/inference/AGENTS.md`](../../../inference/AGENTS.md) §7 (the publishing
contract). This file is the **plan + card drafts** for the wave that publishes the
fine-tuned 0.8B model, the adapted SFT datasets, and the eval/bench results once
the DATASETS and FINETUNE workstreams produce them.

> Status (2026-05-12): **the conservative subset + the test-SFT candidate are
> published; the production `base-v1` / `recommended` weights are NOT.** Live HF
> state (all public, `elizaos` org):
> - **Model bundle repo** — `elizaos/eliza-1`: the single app-facing model repo.
>   Runtime bundles resolve under `bundles/<tier>/...`, e.g.
>   `bundles/2b/eliza-1.manifest.json` and
>   `bundles/2b/text/eliza-1-2b-32k.gguf`. This repo carries the upstream BASE
>   Qwen GGUF bundles first; the APOLLO fine-tuned release promotes new bundle
>   revisions only after the gates pass. Do not create per-tier model repos.
> - **Test-SFT candidate** — `elizaos/eliza-1-0_8b-sft-weights` (model): the
>   APOLLO test-SFT checkpoint (8000-row slice, `eval_loss 1.315`):
>   `model.safetensors` + config/tokenizer/chat-template +
>   `gguf/eliza-1-0_8b-sft-Q4_K_M.gguf`. Conditional-go (beats base on every
>   measured metric, regresses none, but `format_ok=0.20 <` the 0.5 smoke / 0.7
>   full publish floor). Published as a **candidate** — not `defaultEligible`,
>   not the `recommended` channel; the in-progress full-corpus SFT supersedes
>   it.
> - **Datasets** — `elizaos/eliza-1-0_8b-sft` (the 0.8B-tier SFT corpus),
>   `elizaos/eliza-1-training` (the broader SFT corpus).
> - **Results** — `elizaos/eliza-1-evals` (dataset): baseline-vs-test-SFT bench
>   tables, `eliza1_eval_suite.py` outputs, CUDA (RTX 5080) + Vulkan (Intel ANV)
>   + CPU kernel-verify evidence, throughput snapshots. Metal/iOS/Android
>   kernel-verify NOT there — no hardware.
> - **Voice/ASR/VAD** — `elizaos/eliza-1-assets` (frozen `2b` bytes),
>   unchanged.
>
> The fine-tuned `recommended`-channel model upload is still gated on the
> FINETUNE workstream's go/no-go (`gate_report.json` → `passed: true` and the
> finetuned bench beating baseline at the absolute floor). The existing
> `packages/training/checkpoints/eliza-1-{0_8b,2b}-apollo-*` runs are
> *smoke/slice-mode* and FAILED their absolute gates (`format_ok=0.2–0.33 <
> 0.5`); they are published only as the `eliza-1-0_8b-sft-weights` candidate.
> The fork-built `base-v1` weights for the bundle repos are gated on the
> hardware-evidence work — the orchestrator `--base-v1 --dry-run` exits at stage
> 2 today (see "Upload sequence" step 5 and `ELIZA_1_RELEASE_ASSET_STATUS.md`).
>
> **Backbone move (2026-05-12 owner decision):** the small tiers move to the
> Qwen3.5 family — `Qwen/Qwen3.5-0.8B` → new `eliza-1-0_8b` tier (the small
> default; published Hub base, no "substitute" caveat needed), `Qwen/Qwen3.5-2B`
> → `eliza-1-2b` (already in the registry). The DFlash drafter for the
> Qwen3.5/3.6 target tiers (`2b`/`9b`/`27b`/`27b-256k`/`27b-1m`) is distilled
> from `Qwen/Qwen3.5-0.8B`; it must share the targets' 248320-token Qwen3.5
> tokenizer, so the older text defaults `Qwen/Qwen3-{0.6B,1.7B}` are not valid
> for Eliza-1 text tiers. `Qwen3.5-0.8B` is the published small base;
> `Qwen3.5-2B` is the first-run default base.

---

## Repo plan

| Repo | Type | Purpose | Exists? |
|---|---|---|---|
| `elizaos/eliza-1` | model | The single canonical Eliza-1 **bundle** repo. Each tier uploads to `bundles/<tier>/` with the manifest-internal layout (`text/ tts/ asr/ vad/ dflash/ cache/ evals/ licenses/ evidence/ checksums/` + `eliza-1.manifest.json`). The app catalog stores internal paths like `text/eliza-1-2b-32k.gguf` plus `hfPathPrefix: bundles/2b`; download URLs are assembled from those two fields. Pushed by `scripts/publish/publish_eliza1_model_repo.py` for staged base GGUF bundles and by the gated orchestrator for promoted fine-tuned/recommended revisions. | **yes** / target repo. Missing or gate-blocked tiers stay pending in the model-card matrix until their staged bundle exists and validates. |
| `elizaos/eliza-1-0_8b-sft` | model | Raw fine-tune artifact repo (TRL `final/` safetensors + `config.json` + `tokenizer*` + the trainer's auto README + `gate_report.json` + `pipeline-summary.json`). This is the **un-quantized, un-bundled** checkpoint — useful for re-quantizing / re-converting / auditing, distinct from the device bundle above. Pushed by `scripts/push_model_to_hf.py` / `scripts/publish_eliza1_model.py`. | **yes** as `elizaos/eliza-1-0_8b-sft-weights` (model — the APOLLO test-SFT checkpoint: `model.safetensors` + config/tokenizer/chat-template + `gguf/eliza-1-0_8b-sft-Q4_K_M.gguf`). Published as a **candidate** — NOT `defaultEligible`, NOT the `recommended` channel. Superseded by the in-progress full-corpus SFT. |
| `elizaos/eliza-1-training` | dataset | The canonical SFT corpus (`train.jsonl` / `val.jsonl` / `test.jsonl` + `scambench/` + `synthesized/` + `manifest.json` + README). Already exists; the DATASETS workstream's adapted SFT JSONL + upload manifest extend/refresh it (`scripts/publish_dataset_to_hf.py --dataset training --repo-id elizaos/eliza-1-training`). | **yes** (already populated) |
| `elizaos/eliza-1-sft-0_8b` | dataset | The **0.8B-tier-specific** adapted SFT split (the DATASETS workstream's `packages/training/datasets/eliza1-sft-0_8b/` output — currently an empty staged dir). Only created if the DATASETS upload manifest names a tier-specific repo distinct from `eliza-1-training`; otherwise these files go into `elizaos/eliza-1-training` under a `0_8b/` prefix. | **yes** as `elizaos/eliza-1-0_8b-sft` (dataset — the 0.8B-tier SFT corpus, privacy-filtered, `Qwen/Qwen3.5-0.8B` chat template). |
| `elizaos/eliza-1-evals` | dataset | The eval/bench **results** repo: the baseline-vs-finetuned side-by-side table, the `eliza1_eval_suite.py` outputs (`evals/aggregate.json`, per-axis JSON), the kernel-verify evidence we DO have (CPU `reference-test`, Vulkan Intel-ANV + RTX 5080, CUDA RTX 5080), `gate_report.json`, `pipeline-summary.json`, and `THROUGHPUT.md` / `OPTIMIZATIONS_ROLLUP.md` snapshots. If the FINETUNE go/no-go is NO, this repo still gets published with the negative result documented. Pushed via `huggingface_hub.HfApi.upload_folder`. | **yes** (created 2026-05-12; baseline-vs-test-SFT bench tables, `eliza1_eval_suite.py` outputs, CUDA RTX 5080 + Vulkan Intel-ANV + CPU kernel-verify evidence, throughput snapshots, `MODELS_STATUS.md`). |
| `elizaos/eliza-1-assets` | model | Already exists — frozen voice/ASR/VAD bytes for `2b`. Not part of this wave; left as-is. | **yes** |

`huggingface-cli whoami` with the wave token → user `shawmakesmagic`, **write access to the `elizaos` org**. (`hf-transfer-eliza1.sh` covers the legacy `milady-ai/*` → `elizaos/*` transfers separately — not in scope here.)

---

## Card drafts

### `elizaos/eliza-1` (model bundle)

The bundle README is **auto-rendered** by the orchestrator from
`scripts/publish/templates/README.md.j2` + `eliza-1.manifest.json` — do not hand-write
it. The `base-v1` channel banner ("upstream base models, fully kernel-optimized, NOT
the fine-tuned Eliza-1, not a recommended device default") and the provenance table are
emitted automatically. For the **fine-tuned** publish (the `recommended` channel), the
template drops the `base-v1` banner; the card must then state honestly:

- This is the fine-tuned Eliza-1 0.8B. Text backbone: `Qwen/Qwen3.5-0.8B`
  (recorded in `lineage.text.base`).
- Voice = OmniVoice 0.6B (`Serveurperso/OmniVoice-GGUF`), ASR = `ggml-org/Qwen3-ASR-0.6B-GGUF`,
  VAD = Silero v5.1.2 — all *frozen* (not fine-tuned), licenses in `licenses/`.
- **Verified:** the kernel matrix the manifest records (`kernels.verifiedBackends`) — at
  the time of writing that is CPU + Vulkan (Intel ARL Mesa ANV; RTX 5080) + CUDA (RTX
  5080). **Not verified:** Metal / iOS / Android kernel-verify (no hardware), the full
  platform-evidence set, voice-RTF ≤0.5, ASR-WER ≤0.1, the runnable-on-base evals
  (VAD / e2e / 30-turn). The card must say so.
- Release state: **`base-v1-candidate`** (or `finetuned-v2-candidate`) — **NOT
  `defaultEligible`** — until those gates are green. The recommendation engine never
  surfaces a candidate-state bundle.

### `elizaos/eliza-1-0_8b-sft` (raw fine-tune)

```markdown
---
license: apache-2.0
base_model: Qwen/Qwen3.5-0.8B
library_name: transformers
tags: [eliza, elizaos, eliza-1, sft, trl]
---

# eliza-1-0_8b-sft

Raw SFT fine-tune of the Eliza-1 0.8B text backbone (TRL APOLLO + Liger, full-parameter).

- **Base:** `Qwen/Qwen3.5-0.8B`.
- **Data:** `elizaos/eliza-1-training` (SFT split) — see that dataset card.
- **What this is NOT:** not the device bundle (that's `elizaos/eliza-1-0_8b`, which adds
  the GGUF conversion via the elizaOS/llama.cpp fork + TurboQuant/QJL/Polar/DFlash kernel
  stack + the frozen voice/ASR/VAD sections). This repo is the un-quantized checkpoint for
  re-conversion / audit.
- **Verified:** `gate_report.json` (in this repo) — pass/fail per gate against the
  baseline. `pipeline-summary.json` records the base-vs-finetuned bench. **Not verified:**
  held-out text-quality at the `recommended` bar; on-device latency; voice/ASR evals (those
  belong to the bundle, not this checkpoint).

## Eval

See `gate_report.json` and `pipeline-summary.json` in this repo, and
`elizaos/eliza-1-evals` for the full side-by-side benchmark table + the kernel-verify
evidence.
```

### `elizaos/eliza-1-sft-0_8b` (dataset, if distinct) / `elizaos/eliza-1-training` (refresh)

```markdown
---
license: apache-2.0
tags: [eliza, elizaos, eliza-1, sft, instruction-tuning]
task_categories: [text-generation]
---

# eliza-1-training — SFT corpus for the Eliza-1 0.8B fine-tune

Adapted SFT data for the `0_8b` tier: `train.jsonl` / `val.jsonl` / `test.jsonl` (chat-format,
privacy-filtered per `packages/training/scripts/privacy_filter_trajectories.py`), plus
`scambench/` (held-out scam-classification eval) and `synthesized/` (action-pair / core-prompt
synthetic examples). `manifest.json` records the per-split row counts, the source mix, and the
privacy-filter pass.

- **Provenance:** synthesized + curated agent trajectories; no raw user PII (privacy filter is
  mandatory on every write path — repo `CLAUDE.md`).
- **Verified:** `validate_corpus.py` clean; privacy filter applied. **Not verified:** nothing
  about downstream model quality is claimed by this card — see `elizaos/eliza-1-evals`.
- **Lineage note:** the data targets the `Qwen/Qwen3.5-0.8B` chat template.
```

### `elizaos/eliza-1-evals` (dataset, results)

```markdown
---
license: apache-2.0
tags: [eliza, elizaos, eliza-1, evaluation, benchmark]
---

# eliza-1-evals — baseline-vs-finetuned benchmarks + kernel-verify evidence

Honest results record for the Eliza-1 0.8B line.

## Contents
- `bench/0_8b/base-vs-finetuned.json` — the side-by-side table (format_ok, native-tool-call
  accuracy, eliza_bench axes) for `Qwen/Qwen3.5-0.8B` (baseline) vs the SFT fine-tune.
- `bench/0_8b/gate_report.json`, `bench/0_8b/pipeline-summary.json` — the gate verdict +
  per-stage exit codes from `scripts/run_pipeline.py`.
- `evals/0_8b/aggregate.json` + per-axis JSON — `scripts/eval/eliza1_eval_suite.py` outputs.
- `kernel-verify/` — the kernel-verification evidence that EXISTS: CPU `make -C
  packages/inference/verify reference-test` (clean), Vulkan `vulkan_verify.json` (Intel ARL
  Mesa ANV; RTX 5080), CUDA `cuda_verify.json` (RTX 5080). **Metal / iOS / Android are NOT
  here — no hardware yet.**
- `throughput/` — `THROUGHPUT.md` / `OPTIMIZATIONS_ROLLUP.md` snapshots.

## What is verified vs not
- **Verified:** the bench numbers reproduce the recorded runs; the CPU/Vulkan/CUDA kernel
  verifies pass 8/8 against the shipped quantized bytes on those backends.
- **NOT verified:** Metal/iOS/Android kernel-verify; full per-platform dispatch evidence;
  voice-RTF ≤0.5; ASR-WER ≤0.1; the 30-turn endurance loop; held-out text-quality at the
  `recommended` bar. The bundle is therefore `base-v1-candidate` / not `defaultEligible`.
- **If the fine-tune did NOT beat baseline:** `bench/0_8b/base-vs-finetuned.json` records the
  negative result and `bench/0_8b/gate_report.json` shows `passed: false` — published anyway,
  honestly. The model bundle is NOT published in that case.
```

---

## Upload sequence (when FINETUNE signals GO)

1. **Base model bundles** — `python scripts/publish/publish_eliza1_model_repo.py --repo-id elizaos/eliza-1 --bundles-root ~/.eliza/local-inference/models --allow-missing` uploads every staged, manifest-valid raw/base Qwen GGUF bundle into `bundles/<tier>/` and refreshes the single repo card. Use `--dry-run --report <json>` before the upload.
2. **Fine-tuned/recommended bundle** — `python -m scripts.publish.orchestrator --tier 0_8b --bundle-dir <fine-tuned bundle> --base-v1` (or the `recommended` channel if FINETUNE produces a fork-built, eval-green bundle). The orchestrator does layout-validate → release-evidence → kernel-verify → eval-gate → manifest → README → HF push → git tag. It **refuses** to promote a recommended revision if any required gate fails — do not bypass.
3. **Raw fine-tune** — `python scripts/push_model_to_hf.py --model-dir packages/training/checkpoints/<run>/final --repo-id elizaos/eliza-1-0_8b-sft` (include `gate_report.json` + `pipeline-summary.json`).
4. **Datasets** — per the DATASETS workstream's upload manifest: `python scripts/publish_dataset_to_hf.py --dataset training --repo-id elizaos/eliza-1-training` (refresh) and, if the manifest names a tier-specific repo, the `eliza1-sft-0_8b/` files to `elizaos/eliza-1-sft-0_8b`.
5. **Results** — `huggingface_hub.HfApi.upload_folder(folder_path=<staged eliza-1-evals tree>, repo_id="elizaos/eliza-1-evals", repo_type="dataset")` with the bench table + eval-suite outputs + the CPU/Vulkan/CUDA kernel-verify evidence.
6. **Re-run** `python -m scripts.publish.orchestrator --tier 0_8b --bundle-dir <bundle> --base-v1 --dry-run` and record which gates still block a promoted fine-tuned/recommended publish (realistically: Metal/iOS/Android kernel-verify, full platform evidence, voice-RTF/ASR-WER, 30-turn). Update `ELIZA_1_RELEASE_ASSET_STATUS.md`, `ELIZA_1_GGUF_READINESS.md`, `RELEASE_V1.md`, and `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md` with the post-publish state + the live HF URLs.

## Conservative subset (if FINETUNE go/no-go is NO, or anything is ambiguous)

Publish **only**: the datasets (`elizaos/eliza-1-training` refresh + `elizaos/eliza-1-sft-0_8b` if distinct) and the results (`elizaos/eliza-1-evals`, including the negative result). **Do not** publish a model bundle whose gate did not pass. Report that the model was not published and why. An HF upload is a public, hard-to-undo action — when in doubt, ship the conservative subset and report rather than guessing.
