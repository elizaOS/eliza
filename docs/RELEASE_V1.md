# Releasing Eliza-1 v1 — the runbook

> **v1 = the upstream BASE models, GGUF-converted via the elizaOS/llama.cpp
> fork, and fully Eliza-optimized (every quant/kernel trick) — NOT
> fine-tuned.** Fine-tuning ships in v2. The v1 manifests/READMEs say so:
> `releaseState=base-v1`, `provenance.finetuned=false`, and a
> `provenance.sourceModels` map recording which upstream HF repo each
> bundle component comes from.

This document is "to release v1, run this." Every step lists the command
and which GPU (if any) it needs. Heavy GPU steps cannot run on a CPU-only
host — wire them, run what runs, and leave a `base-v1`-labelled placeholder
(never a fabricated hash) where a byte can't be produced yet.

References you must skim first:
`packages/inference/AGENTS.md` (§2 tier matrix / bundle layout, §3 mandatory
kernels, §6 manifest schema, §7 HF publishing/downloader, §8 verification
gates), `packages/training/AGENTS.md`, `ELIZA_1_GGUF_READINESS.md`,
`ELIZA_1_RELEASE_ASSET_STATUS.md`.

---

## 0. What v1 is, exactly

| Component | v1 source (upstream repo) | Conversion | Optimization | Notes |
|---|---|---|---|---|
| Text 0.8B | `Qwen/Qwen3.5-0.8B` (convert from safetensors or the matching GGUF once published) | `convert_hf_to_gguf.py` from the elizaOS/llama.cpp fork | TurboQuant Q3 (`turbo3`/`turbo4`) KV + QJL K-cache (`block_qjl1_256`) + PolarQuant V-cache (`block_q4_polar`) + fused-attn + DFlash | Smallest active Eliza-1 text tier |
| Text 2B | `Qwen/Qwen3.5-2B` (convert from safetensors or the matching GGUF once published) | same | TurboQuant Q3/Q4 + QJL + Polar + fused-attn + DFlash | Default mobile/desktop active tier |
| Text 9B | `unsloth/Qwen3.5-9B-GGUF` (`Qwen3.5-9B-Q4_K_M.gguf` source ref; reconvert from HF safetensors for Eliza types) | same | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` (≥64k) + fused-attn + DFlash | mmproj vision component too |
| Text 27B | `batiai/Qwen3.6-27B-GGUF` (`Qwen-Qwen3.6-27B-Q4_K_M.gguf` ref) | same | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` + fused-attn + DFlash | `27b-256k`, `27b-1m` are context variants of this tier |
| Voice (TTS) | `Serveurperso/OmniVoice-GGUF` (`omnivoice-base-<quant>.gguf` + `omnivoice-tokenizer-<quant>.gguf`) | already GGUF | fused-omnivoice runtime; quant per `VOICE_QUANT_BY_TIER` (Q4_K_M on 0.8B/2B, Q8_0 on 9B+) | non-commercial CC-compatible licensing per inference/AGENTS.md §1 |
| ASR | Eliza-1 ASR GGUF staged under the bundle's `asr/` region | already GGUF | tokenizer fused with the text backbone (zero re-tokenization) | `asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf` |
| VAD | Silero VAD v5.1.2 (MIT) | native GGML `vad/silero-vad-v5.1.2.ggml.bin` (the release path; legacy bundles may also carry the `vad/silero-vad-int8.onnx` ONNX fallback) | none (not a GGUF) | drives barge-in / silence gating |
| Embedding | Eliza-1 dedicated embedding GGUF (2B+ tiers) | GGUF | none beyond fork conversion | 0.8B tier may omit it and pool from the text backbone with `--pooling last` |
| Drafter (DFlash) | distilled (KD, NOT fine-tuning of the target) FROM each tier's base text model; published under `elizaos/eliza-1-<tier>` | `distill_dflash_drafter.py` → fork `convert_hf_to_gguf.py` | drafter GGUF stamps `dflash-draft.target_checkpoint_sha256` | `dflash/drafter-<tier>.gguf` + `dflash/target-meta.json` |
| Voice preset cache | placeholder from W13 until a real fused build emits one | n/a | n/a | `cache/voice-preset-default.bin` |

The catalog's per-tier `sourceModel` block
(`packages/shared/src/local-inference/catalog.ts` → `sourceModelForTier`)
records all of this; it must agree with the tier's manifest
`provenance.sourceModels`.

---

## 1. The fork is in-tree; build it

The patched llama.cpp (`elizaOS/llama.cpp @ v1.0.0-eliza`, upstream base
`b8198` — adds the Eliza GGML types `TBQ3_0`, `TBQ4_0`, `QJL1_256`,
`Q4_POLAR`, the fused attention/omnivoice patches, and the split
`tools/server/server-{task,common,context,http}.cpp` with `grammar_lazy` /
`json_schema` / `response_format` / structured output already present) ships
in-tree as a git submodule at `packages/inference/llama.cpp` — `bun install`
runs `git submodule update --init --recursive`. The converter we use is
`packages/inference/llama.cpp/convert_hf_to_gguf.py`. (A rebase of the fork
onto current upstream is a separate, deferred effort — see
`docs/porting/upstream-rebase-plan.md` — and does NOT block the
structured-output path, which is already in the fork.)

```bash
# CPU host is fine for the converter; the build needs the target backend
# (Metal / CUDA / Vulkan / ...) — see packages/inference/AGENTS.md §8.
export LLAMA_CPP_DIR=$PWD/packages/inference/llama.cpp   # used by gguf_eliza1_apply.py / distill_dflash_drafter.py (both also fall back to the in-repo submodule)
node packages/app-core/scripts/build-llama-cpp-dflash.mjs          # kernel patches + build (per supported backend)
make -C packages/inference/verify reference-test                   # CPU host: must be clean
```

The build MUST fail if any required kernel patch is missing
(inference/AGENTS.md §3). There is no "kernels-missing fallback build".

---

## 2. Acquire the base weights (network host)

```bash
# Per-tier source weights into a bundle's source/ dir, with SHA-256 evidence.
uv run python packages/training/scripts/manifest/stage_eliza1_source_weights.py --tier 9b   --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle
uv run python packages/training/scripts/manifest/stage_eliza1_bundle_assets.py  --tier 9b   --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle --link-mode hardlink
# ...repeat per tier: 0_8b, 2b, 9b, 27b, 27b-256k, 27b-1m
```

These stage TTS (`Serveurperso/OmniVoice-GGUF`), ASR (the Eliza-1 ASR GGUF),
VAD (`onnx-community/silero-vad`), embedding (the Eliza-1 embedding GGUF),
and the upstream text/vision GGUFs/safetensors into `source/`.

---

## 3. Convert each base model to a Eliza-typed GGUF (CPU-safe)

The converter is pure Python. For tiers where you have HF safetensors (9B/27B
via `unsloth/Qwen3.5-9B-GGUF` / `batiai/Qwen3.6-27B-GGUF` companion repos, or
the original Qwen safetensors), run the fork's `convert_hf_to_gguf.py` to
produce the base GGUF, then apply the Eliza metadata wrapper:

```bash
# Direct converter:
uv run python packages/inference/llama.cpp/convert_hf_to_gguf.py <hf-checkpoint-dir> \
  --outtype q4_k_m --outfile out/eliza-1-9b/text/eliza-1-9b-64k.gguf

# Or, with the Eliza type wrapper + provenance recording (CPU-safe, idempotent):
uv run python packages/training/scripts/quantization/gguf_eliza1_apply.py \
  --checkpoint <hf-checkpoint-dir-with-polarquant-codes> \
  --output     out/eliza-1-9b/text/eliza-1-9b-64k.gguf \
  --llama-cpp-dir packages/inference/llama.cpp \
  --outtype q4_polar \
  --release-state base-v1 \
  --source-repo  unsloth/Qwen3.5-9B-GGUF
# → writes <file>.eliza.json (ext metadata) and <file>.provenance.json
#   ({"releaseState":"base-v1","finetuned":false,"sourceRepo":...}).
# Re-running is a no-op unless --force.
```

Do this for every text variant per tier (`text/eliza-1-<tier>-<ctx>.gguf`),
the vision mmproj on 9B+ (`vision/mmproj-<tier>.gguf`), and the embedding on
2B+ (`embedding/...gguf`). TTS/ASR/VAD are already GGUF/ONNX — just stage
the right quant (`omnivoice-base-<quant>.gguf` etc.).

**Needs a GPU?** No — `convert_hf_to_gguf.py` and `gguf_eliza1_apply.py` are
CPU-only. They DO need the safetensors/checkpoint on disk and the fork
checkout.

---

## 4. Apply the Eliza quant recipes (GPU for calibration; sidecars CPU-safe)

The five Eliza quant recipes live in
`packages/training/scripts/quantization/`. PolarQuant produces the int8
weight codes that `gguf_eliza1_apply.py` packs as `Q4_POLAR` blocks;
TurboQuant + QJL are runtime KV-cache compressors — they emit the
`quantization/*.json` sidecars the fork's runtime quantizer consumes (with
the complete §3 `kernel_manifest` block: `kernel_target`,
`block_layout_version`, `codebook_hash`, `per_block_tolerance` — see
`packages/training/scripts/quantization/AUDIT_2026-05-10.md`, findings
1–4 RESOLVED).

```bash
# PolarQuant 4-bit weight codes (GPU recommended; calibration is fast):
uv run --extra train python packages/training/scripts/quantization/polarquant_apply.py \
  --model <hf-checkpoint-or-base-repo> --output out/eliza-1-9b/quant/polarquant --device cuda
# → polarquant_config.json + polarquant_artifacts.safetensors (the int8 codes)

# TurboQuant KV (GPU for skip-layer calibration; --calibration optional):
uv run --extra train python packages/training/scripts/quantization/turboquant_apply.py \
  --model <...> --output out/eliza-1-9b/quant/turboquant --nbits 4 --device cuda
# Long-context variant (27b-256k / 27b-1m): add --trellis (or --context-length 1048576)
# → records turbo3_tcq as the K-cache type.

# Fused TurboQuant + QJL config sidecars (same pattern; QJL is metadata-only):
uv run --extra train python packages/training/scripts/quantization/fused_turboquant_apply.py --model <...> --output ...
uv run --extra train python packages/training/scripts/quantization/qjl_apply.py --model <...> --output ...
```

Each recipe is deterministic for a fixed input (sorted-key sidecars, pinned
seeds=42, pinned Lloyd-Max niter=100). The recipe parity tests
(`scripts/quantization/test_recipes_smoke.py`) pin the codebook hashes /
block layouts byte-for-byte against the C kernel references.

**Needs a GPU?** PolarQuant code generation + TurboQuant skip-layer
calibration want a GPU (the model has to forward-pass). On CPU you can still
`--dry-run` and emit the sidecars (which are data, not GPU output). Per
`packages/inference/AGENTS.md` §3 "base model" does NOT mean "skip the quant
tricks" — every required kernel for the tier must be in the optimized GGUF.

---

## 5. Distill the DFlash drafter (GPU for the real run)

The drafter is KD'd (forward-KL on the target's top-k logits + a CE floor)
FROM the tier's base text model — this is NOT fine-tuning of the target, it
just makes the drafter's distribution track the base target's so spec-decode
accepts.

```bash
# Synthetic smoke (no torch, no GPU): exercises pipeline + GGUF metadata write.
uv run --extra train python packages/training/scripts/distill_dflash_drafter.py \
  --tier 2b --synthetic-smoke --out-dir /tmp/dflash-smoke

# Real run (GPU): student = a smaller Qwen3 from the same family.
uv run --extra train python packages/training/scripts/distill_dflash_drafter.py \
  --tier 2b \
  --target-checkpoint <hf-dir-of-the-base-2B> \
  --target-gguf out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
  --student-base Qwen/Qwen3.5-0.8B \
  --dataset data/distill/eliza1-distill.jsonl \
  --epochs 1 --batch-size 8 --grad-accum 4 \
  --out-dir out/eliza-1-2b/dflash
# → drafter-<tier>.gguf (general.architecture="dflash-draft", dflash_fc.weight /
#   dflash_hidden_norm.weight tensors, dflash-draft.dflash.{block_size,
#   mask_token_id,target_layer_ids,n_target_features} metadata, and
#   dflash-draft.target_checkpoint_sha256 == sha256 of the text GGUF) plus
#   drafter-<tier>.distill.json. Tiers: 0_8b, 2b, 9b, 27b, 27b-256k, 27b-1m.
```

If the GGUF conversion step needs a host you don't have, the recipe still
writes the HF student dir and tells you to re-run with `--stamp-only
--drafter-gguf <gguf> --target-gguf <text gguf>` once the converter is
available.

**Needs a GPU?** The real distillation run yes. The synthetic smoke and the
`--stamp-only` post-step do not.

---

## 6. Stage the bundle (CPU-safe)

```bash
uv run python packages/training/scripts/manifest/stage_local_eliza1_bundle.py \
  --tier 9b --all-contexts --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle
```

This assembles the exact layout (`text/`, `tts/` + tokenizer, `asr/` +
mmproj, `vad/silero-vad-v5.1.2.ggml.bin`, `vision/mmproj-*` on 9B+,
`dflash/drafter-*.gguf` + `dflash/target-meta.json`,
`cache/voice-preset-default.bin`, `evals/*.json`, `licenses/*`,
`checksums/SHA256SUMS`, `evidence/release.json`, `quantization/*.json`).
For a not-yet-built byte it stages a `base-v1`-labelled placeholder with the
real source provenance — **never a fabricated SHA256**, and
`evidence/release.json` stays honest (`publishEligible:false` with the
specific missing artifact named).

When the real bytes exist, regenerate `evidence/release.json` with
`releaseState=base-v1`, `finetuned=false`, the `sourceModels` map, and
`final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=true`
(`final.weights` need NOT be true for `base-v1` — the bytes are the upstream
base GGUFs by design). The manifest builder
(`packages/training/scripts/manifest/eliza1_manifest.py` → `build_manifest(...,
provenance={...})`) writes `provenance` into `eliza-1.manifest.json`; the
runtime validator (`packages/app-core/.../manifest/validator.ts`) requires
per-component provenance coverage for `base-v1`.

---

## 7. Run the evals that ARE runnable on base weights (GPU + reference HW)

`base-v1` evals — these run on the base weights and gate publish:

- **text perplexity** vs the upstream GGUF (not a "fine-tuned text quality"
  eval — that lands in v2): `evals/text-eval.json` / `evals/aggregate.json`.
- **voice RTF**: `evals/voice-rtf.json`.
- **ASR WER**: `evals.asrWer` in the manifest / `evals/aggregate.json`.
- **VAD latency**: `evals.vadLatencyMs`.
- **DFlash acceptance + speedup**: `evals.dflash` (the W11 manifest slot;
  bench via `packages/inference/.../dflash_drafter_runtime_smoke.mjs --bench`).
- **e2e voice loop** + **30-turn endurance**: `evals.e2eLoopOk` /
  `evals.thirtyTurnOk`.
- gate thresholds: `packages/training/benchmarks/eliza1_gates.yaml`,
  collected by `packages/inference/verify/eliza1_gates_collect.mjs`.

```bash
uv run python -m packages.training.benchmarks.eliza1_gates <aggregate.json>   # applies the gates
# kernel verify (per supported backend, against the SHIPPED quantized bytes):
make -C packages/inference/verify metal_verify    # 8/8 PASS for turbo3/turbo4/turbo3_tcq/qjl/polar
make -C packages/inference/verify vulkan_verify   # 8/8 PASS
# ... cuda / rocm / cpu reference per tier (inference/AGENTS.md §8)
```

---

## 8. Platform-dispatch evidence (per supported backend / OS)

For every `evidence/platform/<target>.json` the tier requires (see
`ELIZA_1_GGUF_READINESS.md` per-tier "Required platform evidence"), run the
graph-dispatch smoke on the real device and record `runtimeReady: true`.
`base-v1` does not skip this — the kernels must be runtime-ready, not just
compiled.

Regenerate the readiness ledger after staging:

```bash
uv run python packages/training/scripts/manifest/eliza1_platform_plan.py \
  --bundle-root ~/.eliza/local-inference/models \
  --out ELIZA_1_GGUF_PLATFORM_PLAN.json \
  --readiness-md ELIZA_1_GGUF_READINESS.md
# Publish-blocking status now recognizes releaseState=base-v1 as satisfiable
# when the base-v1 final.* flags + sourceModels + finetuned=false are present.
```

---

## 9. Checksums + release evidence (only after every gate is green)

```bash
# stage_local_eliza1_bundle.py rewrites checksums/SHA256SUMS at the end of each
# run; validate:
uv run python -c "from packages.training.scripts.manifest.stage_local_eliza1_bundle import validate_checksum_manifest; from pathlib import Path; print(validate_checksum_manifest(Path('~/.eliza/local-inference/models/eliza-1-9b.bundle').expanduser()))"
```

`evidence/release.json` for a not-yet-built tier stays `publishEligible:false`
with the specific missing artifact named. Do not fabricate hashes; do not flip
flags green without the evidence.

---

## 10. Publish to HuggingFace (`elizaos/eliza-1-<tier>`)

The publish orchestrator (`packages/training/scripts/publish/orchestrator.py`,
driven by `packages/training/scripts/publish_all_eliza1.sh`) gates on
`releaseState ∈ {base-v1, upload-candidate, final}` and the `final.*` flags.
For uploading a single component checkpoint:

```bash
# Dry-run (safe; no network):
uv run python packages/training/scripts/push_model_to_hf.py \
  --registry-key eliza-1-9b \
  --checkpoint out/eliza-1-9b/text \
  --release-state base-v1 \
  --repo-id elizaos/eliza-1-9b \
  --dry-run
# → model card gets a "base model, not fine-tuned" banner; preflight checks any
#   *.provenance.json next to the checkpoint agrees with --release-state.

# Real upload (needs HF_TOKEN with write access to elizaos/*; not done in CI):
HF_TOKEN=hf_xxx uv run python packages/training/scripts/push_model_to_hf.py \
  --registry-key eliza-1-9b --checkpoint out/eliza-1-9b/text \
  --release-state base-v1 --repo-id elizaos/eliza-1-9b --public

# Or the whole-bundle orchestrator path:
bash packages/training/scripts/publish_all_eliza1.sh   # aborts on first failing tier; propagates exit code
```

Do NOT upload until every eval gate, every supported-backend kernel verify,
and every platform-dispatch report is green for the exact shipped bytes, and
`evidence/release.json` is `releaseState=base-v1`, `finetuned=false`,
`publishEligible=true`. Preserve the upload commit/URL in
`evidence/release.json` (`hf.uploadEvidence`) to flip to `final`-equivalent.

---

## What needs which GPU (summary)

| Step | Host |
|---|---|
| Fork converter (`convert_hf_to_gguf.py`), `gguf_eliza1_apply.py`, sidecar generation, bundle staging, checksums, platform-plan regen, manifest build, `distill_dflash_drafter.py --synthetic-smoke`, `--stamp-only` | CPU host (the fork is in-tree at `packages/inference/llama.cpp`; this environment can run these once the source weights are present) |
| Fork build with kernel patches, `metal_verify` / `vulkan_verify` / `cuda_verify` / `rocm_verify`, platform-dispatch smokes | the target backend's hardware (Metal Mac, CUDA NVIDIA, Vulkan Linux/Android, ROCm AMD; GH200-class aarch64+CUDA for the `27b-1m` tier) |
| PolarQuant code generation, TurboQuant skip-layer calibration, DFlash distillation, text perplexity / RTF / WER / VAD / dflash / e2e / 30-turn evals | a GPU big enough for the tier (consumer GPU for 0.8B/2B; ≥24 GB for 9B; ≥48 GB / multi-GPU for 27B) |

This environment is CPU-only with no source weights staged yet, so the GPU/HW
rows are wired (correct invocations above) but not executed here. Everything in
the CPU row is implemented and tested (`python -m pytest packages/training/scripts/manifest/`,
`packages/training/scripts/quantization/test_recipes_smoke.py`).
