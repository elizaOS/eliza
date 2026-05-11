# Eliza-1 Release Asset Status

> **The v1 plan (project owner's decision): Eliza-1 v1 = the upstream BASE
> models — GGUF-converted via the elizaOS/llama.cpp fork and fully
> Milady-optimized (every quant/kernel trick in `packages/inference/AGENTS.md`
> §3) — but NOT fine-tuned.** Fine-tuning ships in v2. v1 manifests and READMEs
> must be honest about this: `releaseState=base-v1`, `provenance.finetuned=false`,
> and a `provenance.sourceModels` map recording which upstream HF repo each
> bundle component comes from. The catalog's previous "stand-in = upstream Qwen
> hardlinks" is the **correct source** for v1 — what was missing was (a)
> treating it as a legit release rather than a publish-blocker, (b) actually
> running the GGUF-conversion + Milady-quant + drafter-distillation, (c) the
> release artifacts. The runbook to do (b)+(c) is [`RELEASE_V1.md`](RELEASE_V1.md).

This is a release-prep ledger, not a release approval. A bundle is publishable
only when every eval gate, every supported-backend kernel verify, and every
platform-dispatch report is green for the **exact shipped bytes** (real GGUFs
from a real fork build, real quant sidecars from the real bytes), and
`evidence/release.json` is `releaseState=base-v1`, `finetuned=false`,
`publishEligible=true`. No fabricated hashes; not-yet-built tiers stay
`publishEligible=false` with the specific missing artifact named.

## Release-state semantics (`base-v1`)

A new release state, `base-v1`, means "base model, GGUF + fully optimized,
NOT fine-tuned" and is `publishEligible` when:

- the real GGUFs from a real fork build are present (text/vision/embedding via
  the fork's `convert_hf_to_gguf.py` + the Milady type wrapper; TTS/ASR/VAD/
  embedding staged at the right quant),
- the real quant sidecars (`quantization/{turboquant,fused_turboquant,qjl_config,
  polarquant_config}.json`) are present, generated from the real bytes, each
  carrying the complete §3 `kernel_manifest` block (`kernel_target`,
  `block_layout_version`, `codebook_hash`, `per_block_tolerance` — see
  `packages/training/scripts/quantization/AUDIT_2026-05-10.md`, findings 1–4
  RESOLVED; the recipes are idempotent + deterministic),
- the per-platform dispatch evidence is present (`evidence/platform/<target>.json`,
  `runtimeReady:true`),
- and the eval JSONs that **are runnable on base weights** are present and
  pass — text **perplexity vs the upstream GGUF** (NOT a "fine-tuned text
  quality" eval), voice RTF, ASR WER, VAD latency, DFlash acceptance, e2e
  loop, 30-turn endurance — but NOT a fine-tuned-text-quality eval.

Wired through:

- `packages/training/scripts/manifest/eliza1_manifest.py` — `ELIZA_1_RELEASE_STATES`
  (incl. `base-v1`, `finetuned-v2`), `ELIZA_1_PUBLISHABLE_RELEASE_STATES`,
  `ELIZA_1_PROVENANCE_SLOTS`; the manifest validator accepts an optional
  `provenance` block (`{releaseState, finetuned, sourceModels}`), requires
  `finetuned=false` for `base-v1`, and requires per-component provenance
  coverage for every shipped component on a `base-v1` manifest. A `base-v1`
  manifest with all required kernels/backends/runnable-on-base evals passing
  validates as `defaultEligible: true`.
- `packages/app-core/src/services/local-inference/manifest/{schema.ts,validator.ts,
  types.ts,index.ts}` + `eliza-1.manifest.v1.json` — mirror: `ELIZA_1_RELEASE_STATES`,
  `ELIZA_1_PROVENANCE_SLOTS`, `Eliza1ProvenanceSchema`, the JSON-Schema
  `provenance` block + `$defs/sourceModelEntry`, and the runtime
  contract-validator's `base-v1` provenance-coverage check.
- `packages/training/scripts/manifest/eliza1_platform_plan.py` —
  `release_status_blockers()` recognizes `base-v1` as a satisfiable release
  shape: `final.weights` need NOT be `true` for `base-v1` (the bytes are the
  upstream base GGUFs by design, recorded via `sourceModels`); everything else
  (`final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,
  sizeFirstRepoIds}`) still must be `true`, plus `finetuned=false` and a
  non-empty `sourceModels`. `ELIZA_1_GGUF_PLATFORM_PLAN.json` /
  `ELIZA_1_GGUF_READINESS.md` regenerated; the readiness ledger documents the
  v1 release shape.
- `packages/shared/src/local-inference/catalog.ts` / `types.ts` — each
  `eliza-1-<tier>` catalog entry carries a `sourceModel` block
  (`{finetuned: false, components: {...}}`) recording the upstream repo per
  component (see the table below). Must agree with the tier manifest's
  `provenance.sourceModels`. `darwin-x64-metal` is not (and stays not) in the
  catalog — WF3 owns that target list.
- `packages/training/scripts/quantization/gguf_milady_apply.py` — `--release-state
  base-v1` writes a `<file>.provenance.json` (`{releaseState, finetuned:false,
  sourceRepo, convertedVia, outtype, ggmlTypeSlots}`); the run is idempotent
  (the converter is skipped if the output GGUF already exists; `--force`
  overrides).
- `packages/training/scripts/distill_dflash_drafter.py` — gained the `27b-1m`
  tier (`DEFAULT_STUDENT_BASE` + `ACCEPTANCE_GATE`).
- `packages/training/scripts/push_model_to_hf.py` — `--release-state base-v1`
  records the lineage in the model card (a "base model, not fine-tuned"
  banner) and the preflight refuses to push a `base-v1` checkpoint whose
  `*.provenance.json` disagrees.

## v1 source repos per tier / component

| Tier | Text source (base) | Vision (mmproj) | ASR | TTS | VAD | Embedding | Drafter |
|---|---|---|---|---|---|---|---|
| `0_6b` | `Qwen/Qwen3-0.6B-GGUF` (`Qwen3-0.6B-Q8_0.gguf`) — `Qwen3.5-0.6B` not published yet | — | `ggml-org/Qwen3-ASR-0.6B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` (MIT) | (none — pools from text backbone) | distilled from base text → `elizaos/eliza-1-0_6b` |
| `1_7b` | `Qwen/Qwen3-1.7B-GGUF` (`Qwen3-1.7B-Q8_0.gguf`) — `Qwen3.5-1.7B` not published yet | — | `ggml-org/Qwen3-ASR-0.6B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `elizaos/eliza-1-1_7b` |
| `9b` | `unsloth/Qwen3.5-9B-GGUF` (`Qwen3.5-9B-Q4_K_M.gguf` ref; reconvert from HF for Milady types) | `unsloth/Qwen3.5-9B-GGUF` (`mmproj-F16.gguf`) | `ggml-org/Qwen3-ASR-0.6B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `elizaos/eliza-1-9b` |
| `27b` | `batiai/Qwen3.6-27B-GGUF` (`Qwen-Qwen3.6-27B-Q4_K_M.gguf` ref) | `batiai/Qwen3.6-27B-GGUF` (`mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf`) | `ggml-org/Qwen3-ASR-1.7B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `elizaos/eliza-1-27b` |
| `27b-256k` | same as `27b` | same as `27b` | `ggml-org/Qwen3-ASR-1.7B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `elizaos/eliza-1-27b-256k` |
| `27b-1m` | same as `27b` (a Qwen3.6 27b-1m variant if one lands in the catalog) | (no separate vision component in the 1m bundle layout) | `ggml-org/Qwen3-ASR-1.7B-GGUF` | `Serveurperso/OmniVoice-GGUF` | `onnx-community/silero-vad` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `elizaos/eliza-1-27b-1m` |

Notes:
- The K-cache of the long-context variants (`27b-256k`, `27b-1m`, and any
  ≥64k variant) rides the trellis path (`turbo3_tcq`) — pass `--trellis` /
  `--context-length` to `turboquant_apply.py`.
- The drafter is **distilled** (KD on the base target's top-k logits), NOT
  fine-tuned, and stamps `dflash-draft.target_checkpoint_sha256` = the sha256
  of the shipped text GGUF it tracks.
- Voice (OmniVoice) ships under CC-compatible non-commercial terms per
  `packages/inference/AGENTS.md` §1.
- VAD is intentionally a sidecar ONNX (`vad/silero-vad-int8.onnx`), not a GGUF.

## What is done in this checkout

- Release-state semantics + `provenance` block (Python validator, TS schema/
  validator/types, JSON-Schema), `base-v1` recognized by the platform-plan
  blocker check, catalog `sourceModel` provenance per tier, `gguf_milady_apply.py`
  `--release-state base-v1` + idempotency, `distill_dflash_drafter.py` `27b-1m`
  tier, `push_model_to_hf.py` `--release-state base-v1`. Tests:
  `packages/training/scripts/manifest/test_eliza1_manifest.py` (incl. base-v1
  provenance), `test_eliza1_platform_plan.py` (incl. base-v1 acceptance),
  `packages/app-core/src/services/local-inference/manifest/*.test.ts`, the
  catalog/recommendation vitest suites — all pass.
- The conversion → quant → drafter → bundle pipeline is wired with correct
  invocations (`RELEASE_V1.md`). The CPU-safe steps (fork converter wrapper,
  sidecar generation, bundle staging, checksums, manifest build, platform-plan
  regen, drafter synthetic smoke / `--stamp-only`) are implemented and tested.

## What still needs a GPU / target hardware (NOT runnable here)

- The fork build with the kernel patches (per supported backend) and the
  kernel-verify gates (`metal_verify` / `vulkan_verify` / `cuda_verify` /
  `rocm_verify` 8/8 PASS against the shipped quantized bytes).
- PolarQuant weight-code generation, TurboQuant skip-layer calibration, and
  DFlash drafter distillation (all need a GPU big enough for the tier).
- The runnable-on-base eval gates against the real bytes (text perplexity vs
  the upstream GGUF, voice RTF, ASR WER, VAD latency, DFlash acceptance, e2e
  loop, 30-turn endurance).
- Per-platform dispatch evidence on real devices (incl. GH200-class
  aarch64+CUDA for `27b-1m`).
- The HF upload itself (needs an `HF_TOKEN` with write access to `elizaos/*`;
  `huggingface-cli` not installed in this environment; not this agent's call).

Until those run, every tier's `evidence/release.json` stays
`releaseState=local-standin` (or a clearly-labelled `base-v1` placeholder with
the real source provenance and `publishEligible=false`), and the publish
orchestrator rejects it — by design.
