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

**One-command prep.** `bun run release:v1:prep` runs every step below that
needs no GPU / Metal / Android / HF-write host (build-dflash dry-run, the
manifest/quant-recipe test suites, `py_compile` on the pipeline scripts, the
quant recipe `--dry-run`s, the DFlash synthetic smoke, the platform-plan
regeneration + idempotency check, gate-collect per tier with `needs-data`
placeholders, and the CPU C reference + kernel-contract check). It then prints
the remaining checklist — what's left and which hardware / network / HF
credentials each remaining step needs. Run that first; everything it does not
do is in the "What needs which GPU" table at the bottom and in
`ELIZA_1_TESTING_TODO.md` as `[hw]` lines. (`--quick` skips the slower steps;
`--json` for a machine-readable summary.)

References you must skim first:
`packages/inference/AGENTS.md` (§2 tier matrix / bundle layout, §3 mandatory
kernels, §6 manifest schema, §7 HF publishing/downloader, §8 verification
gates), `packages/training/AGENTS.md`, `ELIZA_1_GGUF_READINESS.md`,
`ELIZA_1_RELEASE_ASSET_STATUS.md`.

---

## 0. What v1 is, exactly

| Component | v1 source (upstream repo) | Conversion | Optimization | Notes |
|---|---|---|---|---|
| Text 0.6B | `Qwen/Qwen3-0.6B-GGUF` (`Qwen3-0.6B-Q8_0.gguf`) | `convert_hf_to_gguf.py` from the elizaOS/llama.cpp fork | TurboQuant Q3 (`turbo3`/`turbo4`) KV + QJL K-cache (`block_qjl1_256`) + PolarQuant V-cache (`block_q4_polar`) + fused-attn + DFlash | `Qwen3.5-0.6B` not published yet; uses `Qwen3-0.6B` until it is |
| Text 1.7B | `Qwen/Qwen3-1.7B-GGUF` (`Qwen3-1.7B-Q8_0.gguf`) | same | TurboQuant Q3/Q4 + QJL + Polar + fused-attn + DFlash | `Qwen3.5-1.7B` not published; uses `Qwen3-1.7B` |
| Text 9B | `unsloth/Qwen3.5-9B-GGUF` (`Qwen3.5-9B-Q4_K_M.gguf` source ref; reconvert from HF safetensors for Eliza types) | same | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` (≥64k) + fused-attn + DFlash | mmproj vision component too |
| Text 27B | `batiai/Qwen3.6-27B-GGUF` (`Qwen-Qwen3.6-27B-Q4_K_M.gguf` ref) | same | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` + fused-attn + DFlash | `27b-256k`, `27b-1m` are context variants of this tier |
| Voice (TTS) | `Serveurperso/OmniVoice-GGUF` (`omnivoice-base-<quant>.gguf` + `omnivoice-tokenizer-<quant>.gguf`) | already GGUF | fused-omnivoice runtime; quant per `VOICE_QUANT_BY_TIER` (Q4_K_M on 0.6B/1.7B, Q8_0 on 9B+) | non-commercial CC-compatible licensing per inference/AGENTS.md §1 |
| ASR | `ggml-org/Qwen3-ASR-0.6B-GGUF` (0.6B/1.7B/9B) / `ggml-org/Qwen3-ASR-1.7B-GGUF` (27B tiers) | already GGUF | tokenizer fused with the text backbone (zero re-tokenization) | `asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf` |
| VAD | Silero VAD v5.1.2 (MIT) | native GGML `vad/silero-vad-v5.1.2.ggml.bin` (the release path; legacy bundles may also carry the `vad/silero-vad-int8.onnx` ONNX fallback) | none (not a GGUF) | drives barge-in / silence gating |
| Embedding | `Qwen/Qwen3-Embedding-0.6B-GGUF` (1.7B+ tiers) | already GGUF | none beyond fork conversion | 0.6B tier omits it (pools from the text backbone with `--pooling last`) |
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
(inference/AGENTS.md §3). There is no "kernels-missing fallback build"
**for a publishable artifact**. There is, however, an opt-in, loudly-warned,
**non-publishable** "reduced-optimization local mode" so the voice pipeline
runs on backends that can't dispatch a required kernel yet (ROCm/HIP — the
*production* `.cu` kernels aren't `__HIP_PLATFORM_AMD__`-clean yet, though
`verify/hip_verify.cu` / `make -C packages/inference/verify hip-verify` now
gives a fixture-parity gate; CPU TBQ/Polar standalone score graph op):
`ELIZA_DFLASH_ALLOW_REDUCED_KERNELS=1` lets `build-llama-cpp-dflash.mjs`
finish such a target with `publishable: false` +
`reducedOptimizationLocalMode: true`, and `ELIZA_LOCAL_ALLOW_STOCK_KV=1`
makes the runtime load it with stock `f16` KV. Neither is a default, and
`defaultEligible` bundles still require the verified kernels per backend.

> **`turbo3_tcq` is now a real K/V cache type** (2026-05-12): the fork's
> `ggml.c` has the `[GGML_TYPE_TBQ3_TCQ]` type-traits entry (`to_float` =
> sliding-9-bit-window codebook lookup, `from_float_ref` = host-side
> 512-state Viterbi encoder in the orthogonal WHT basis; codebook in
> `ggml/src/ggml-tcq-codebook.h`) + the ggml-cpu `from_float`;
> `patchServerKvCacheTypeNames` appends `GGML_TYPE_TBQ3_TCQ` to
> `common/arg.cpp`'s `kv_cache_types`, so `--cache-type-k tbq3_tcq`
> resolves — this unblocks the 27b / 27b-256k / 27b-1m tiers
> (`requiredKernelsForContext` adds `turbo3_tcq` at `ctx >= 65536`). Fork
> branch `elizaOS/llama.cpp` `eliza/ws2-tbq3-tcq-traits` @ `536ff214`;
> `packages/inference/llama.cpp` gitlink bumped to it (WS-4 merges the
> decode-loop / streaming source on that branch, then tags). The
> `android-x86_64-cpu` target (Cuttlefish/cvd) is real + built (cvd smoke
> 5/6 infra steps PASS); the Android in-process voice path adds the
> "path b" `common_speculative` shim (`aosp/llama-shim/eliza_llama_shim_speculative.cpp`)
> + the `android-arm64-{cpu,vulkan}-fused` AAR build + Capacitor mic/audio/
> ONNX-VAD bridges + `aosp/deploy-pixel.mjs`. MLX (`mlx_lm.server`,
> `ELIZA_LOCAL_MLX=1`) is an opt-in Apple-Silicon text-only convenience
> path — never `defaultEligible`, never the voice path. TPU/NPU is not a
> target this wave (verdict documented).

### Per-platform voice support matrix

The full mic → VAD → ASR → forced-grammar LLM (DFlash) → streaming TTS →
audio-out loop must run on **every platform regardless of GPU
architecture**. The current state per `{platform × GPU backend}` —
runtime path (`llama-server` spawn vs in-process FFI), kernel coverage,
mic + player, VAD runtime, TTS/ASR backend, and verified vs
needs-hardware/needs-SDK — is the table in
[`docs/voice-interactive.md` § "Cross-platform voice support matrix"](docs/voice-interactive.md#cross-platform-voice-support-matrix),
generated live by `bun run voice:interactive -- --platform-report`, with
the per-row evidence in
[`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md).
Summary: Metal (Apple Silicon, all 5 kernels graph-dispatched) and the
CUDA fork binary are the fully-optimized desktop targets; Linux/Windows
CPU + Vulkan run via the same `llama-server` path with the kernel patches
applied (CPU advertises `dflash`/`turbo3`/`turbo4`/`qjl_full`/`polarquant`,
`turbo3_tcq` only matters for the 27b-256k tiers); iOS/Android run via the
in-process FFI path (`@elizaos/llama-cpp-capacitor` /
`@elizaos/plugin-aosp-local-inference`) and need an Xcode / Android-Studio
build for the on-device fused lib (`ios-arm64-metal-fused`,
`android-arm64-{cpu,vulkan}-fused` — to add).

---

## 2. Acquire the base weights (network host)

```bash
# Per-tier source weights into a bundle's source/ dir, with SHA-256 evidence.
uv run python packages/training/scripts/manifest/stage_eliza1_source_weights.py --tier 9b   --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle
uv run python packages/training/scripts/manifest/stage_eliza1_bundle_assets.py  --tier 9b   --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle --link-mode hardlink
# ...repeat per tier: 0_6b, 1_7b, 9b, 27b, 27b-256k, 27b-1m
```

These stage TTS (`Serveurperso/OmniVoice-GGUF`), ASR (`ggml-org/Qwen3-ASR-*`),
VAD (`onnx-community/silero-vad`), embedding (`Qwen/Qwen3-Embedding-0.6B-GGUF`),
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
1.7B+ (`embedding/...gguf`). TTS/ASR/VAD are already GGUF/ONNX — just stage
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
  --tier 1_7b --synthetic-smoke --out-dir /tmp/dflash-smoke

# Real run (GPU): student = a smaller Qwen3 from the same family.
uv run --extra train python packages/training/scripts/distill_dflash_drafter.py \
  --tier 1_7b \
  --target-checkpoint <hf-dir-of-the-base-1.7B> \
  --target-gguf out/eliza-1-1_7b/text/eliza-1-1_7b-32k.gguf \
  --student-base Qwen/Qwen3-0.6B \
  --dataset data/distill/eliza1-distill.jsonl \
  --epochs 1 --batch-size 8 --grad-accum 4 \
  --out-dir out/eliza-1-1_7b/dflash
# → drafter-<tier>.gguf (general.architecture="dflash-draft", dflash_fc.weight /
#   dflash_hidden_norm.weight tensors, dflash-draft.dflash.{block_size,
#   mask_token_id,target_layer_ids,n_target_features} metadata, and
#   dflash-draft.target_checkpoint_sha256 == sha256 of the text GGUF) plus
#   drafter-<tier>.distill.json. Tiers: 0_6b, 1_7b, 9b, 27b, 27b-256k, 27b-1m.
```

If the GGUF conversion step needs a host you don't have, the recipe still
writes the HF student dir and tells you to re-run with `--stamp-only
--drafter-gguf <gguf> --target-gguf <text gguf>` once the converter is
available.

**Needs a GPU?** The real distillation run yes. The synthetic smoke and the
`--stamp-only` post-step do not.

---

## 6. Stage the bundle (CPU-safe; needs the non-text source assets present)

```bash
# First: stage the non-text source assets (TTS / ASR / VAD / embedding / vision)
# from HF into the bundle dir (network host) — stage_local_eliza1_bundle.py reads
# them from `tts/`, `asr/`, `vad/`, `cache/` etc.; it does NOT synthesize voice
# GGUF placeholders, so those dirs must be populated first:
uv run python packages/training/scripts/manifest/stage_eliza1_source_weights.py  --tier 9b --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle
uv run python packages/training/scripts/manifest/stage_eliza1_bundle_assets.py   --tier 9b --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle --link-mode hardlink
# Then: complete the release-shaped layout (text/dflash/vision standins + evals/
# evidence/quantization sidecars/checksums):
uv run python packages/training/scripts/manifest/stage_local_eliza1_bundle.py \
  --tier 9b --all-contexts --bundle-dir ~/.eliza/local-inference/models/eliza-1-9b.bundle \
  --release-state base-v1
```

This assembles the exact layout (`text/`, `tts/` + tokenizer, `asr/` +
mmproj, `vad/silero-vad-v5.1.2.ggml.bin`, `vision/mmproj-*` on 9B+,
`dflash/drafter-*.gguf` + `dflash/target-meta.json`,
`cache/voice-preset-default.bin`, `evals/*.json`, `licenses/*`,
`checksums/SHA256SUMS`, `evidence/release.json`, `quantization/*.json`).
For a not-yet-built text/drafter/vision byte it stages a local stand-in (a
real GGUF from the local model cache) with the source provenance — **never a
fabricated SHA256** — and `evidence/release.json` stays honest
(`publishEligible:false` with the specific missing artifact named). Without the
non-text source assets staged first, the manifest validator rejects the bundle
(`files.voice / files.cache: at least one entry required`) — that's intentional,
not a fabricated-placeholder fallback.

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
  `evals.thirtyTurnOk`. For a human-driven interactive end-to-end voice turn
  (send a voice message, get a voice response — VAD, force-stop/barge-in, and
  all optimizations on): `bun run voice:interactive` (prereqs, modes, keyboard
  controls, and the latency-trace lines in `docs/voice-interactive.md`).
  Headless: `bun test packages/app-core/src/services/local-inference/voice/interactive-session.e2e.test.ts`.
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

### Release channels — `recommended` vs `base-v1`

The manifest carries an optional `releaseChannel` field (`"recommended"` |
`"base-v1"`):

- **`recommended`** (default, ships in **v2**) — the *fine-tuned* Eliza-1.
  This is the device default the recommendation engine surfaces. Accepts
  `releaseState ∈ {upload-candidate, final}` and enforces every gate
  (incl. the held-out text-quality eval).
- **`base-v1`** — the *upstream-base + kernel-optimized* release: every
  quant/kernel trick applied (TurboQuant Q3/Q4 KV, QJL K-cache, PolarQuant
  V-cache, fused attention, DFlash), but the text weights are the upstream
  base GGUFs (not the fine-tuned Eliza-1). Run the orchestrator (or
  `publish_all_eliza1.sh`) with `--base-v1` (alias `--release-channel
  base-v1`). On this channel:
  - `defaultEligible` is **forced `false`** — never a device default
    (inference/AGENTS.md §6); a `base-v1`-channel manifest with
    `defaultEligible: true` is rejected by both the Zod schema and the
    Python validator.
  - the manifest carries a mandatory `provenance` block
    (`releaseState: "base-v1"`, `finetuned: false`, `sourceModels` →
    upstream HF repo per shipped component), sourced from the
    `evidence/release.json` `sourceModels` map.
  - the README gets a prominent banner: "upstream base models, fully
    kernel-optimized, NOT the fine-tuned Eliza-1, not a recommended device
    default" plus the per-component provenance table.
  - `final.weights` need **not** be `true` (the text bytes ARE the upstream
    base GGUFs by design); the held-out *text-quality* gate is **N/A**.
  - **EVERYTHING else stays enforced**: `final.{hashes,evals,licenses,
    kernelDispatchReports,platformEvidence,sizeFirstRepoIds}` all `true`;
    every supported-backend kernel verify 8/8 PASS against the shipped
    bytes; every required platform-dispatch report `runtimeReady: true`
    (incl. `darwin-arm64-metal` / `ios-arm64-metal` / `android-*-vulkan`);
    every runnable-on-base eval (voice RTF, ASR WER, VAD, e2e loop,
    30-turn, dflash bench) passing its tier gate; every license attestation
    present and verbatim. `base-v1` is **not** "skip the kernel/license
    gates" — it is "the text weights are upstream-base, but the bundle is
    still the fully-optimized, fully-verified runtime artifact".

`base-v1-candidate` is the in-progress state of a base-v1 bundle before
those gates are green — it is **not publishable** (it's the explicit "base-v1
plan declared, gates not yet met" state).

### Current status — a `base-v1` upload is NOT yet possible

**HF repos exist (as of 2026-05-12), but only with pre-release content:** the
[`elizaos/eliza-1-{0_6b,1_7b,9b}`](https://huggingface.co/elizaos/eliza-1-0_6b)
bundle repos are public and hold the **upstream BASE GGUFs** (Qwen3-0.6B-Q8_0 /
Qwen3-1.7B-Q8_0 — the 9b GGUF blob upload is pending; its `manifest.json`
records the sha + the `unsloth/Qwen3.5-9B-GGUF` source) + `manifest.json`
(`releaseState: local-standin`, `publishEligible: false`, **not
`defaultEligible`**) + an honest card. The test-SFT *candidate* lives at
[`elizaos/eliza-1-0_6b-sft-weights`](https://huggingface.co/elizaos/eliza-1-0_6b-sft-weights)
— APOLLO, 8000-row slice, conditional-go (`format_ok=0.20 <` the publish
floor) — published as a **candidate** only, **not `defaultEligible`, not the
`recommended` channel**, superseded by the in-progress full-corpus SFT. SFT
corpora are at [`elizaos/eliza-1-0_6b-sft`](https://huggingface.co/datasets/elizaos/eliza-1-0_6b-sft)
+ [`elizaos/eliza-1-training`](https://huggingface.co/datasets/elizaos/eliza-1-training);
the bench tables + kernel-verify evidence at
[`elizaos/eliza-1-evals`](https://huggingface.co/datasets/elizaos/eliza-1-evals);
the frozen `1_7b` voice/ASR/VAD bytes at
[`elizaos/eliza-1-assets`](https://huggingface.co/elizaos/eliza-1-assets). **No
fork-built `base-v1` weights, and no fine-tuned `recommended`-channel weights,
have been pushed to any `elizaos/eliza-1-<tier>` main revision** — the
orchestrator refuses to do that until the gates below clear.

`bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir>
--base-v1 --dry-run` (and the per-bundle `python -m scripts.publish.orchestrator
--tier <t> --bundle-dir <bundle> --base-v1 --dry-run`) **fail with
`EXIT_RELEASE_EVIDENCE_FAIL` (16)** at stage 2 on the staged `0_6b` and `1_7b`
bundles. The blockers (all recorded in each bundle's `evidence/release.json`
`publishBlockingReasons`; logs under `evidence/base-v1-dry-run-*.log`):

1. `releaseState` is `weights-staged` (the bundles carry placeholder/
   substitute bytes, not a real fork build of the upstream base weights).
2. `final.evals` is `false` — even with the text-quality gate relaxed for
   base-v1, the **`voice_rtf`** gate (≈6–9× vs ≤0.5) and the **`asr_wer`**
   gate (1.0 vs ≤0.1) fail; VAD / e2e / 30-turn measurements are missing.
   These are runnable-on-base evals — base-v1 does not skip them.
3. `final.kernelDispatchReports` is `false` — kernels verify runtime-ready on
   CPU + Vulkan (Intel ANV, RTX 5080) + CUDA (RTX 5080), but **Metal / iOS /
   Android are pending** (no hardware). The kernel-verification gate is one
   of the gates AGENTS.md §7 forbids bypassing.
4. `final.platformEvidence` is `false` — every required `evidence/platform/*`
   report is still a "not-run" stub.
5. `final.sizeFirstRepoIds` is `false` (set by the HF-push stage, which
   never runs because of 1–4).
6. `evidence/release.json` carries no `finetuned: false` / `sourceModels`
   map (the provenance the base-v1 channel requires).

**Prerequisites to flip to a real `base-v1` upload** (in order): (a) acquire
the upstream base weights and run the fork's `convert_hf_to_gguf.py` +
`gguf_eliza1_apply.py --release-state base-v1` to produce the real
Milady-typed GGUFs (CPU-safe — §2/§3); (b) run the quant recipes + DFlash
distill on a GPU (§4/§5); (c) re-stage the bundle and regenerate
`evidence/release.json` with `releaseState=base-v1`, `finetuned=false`, the
`sourceModels` map; (d) run the runnable-on-base evals on a GPU + reference
HW until `voice_rtf` / `asr_wer` / VAD / e2e / 30-turn pass their tier gates
(§7); (e) run `metal_verify` / `vulkan_verify` / `cuda_verify` 8/8 PASS
against the shipped quantized bytes on each backend's hardware, and the
platform-dispatch smoke on every required device (§7/§8); (f) only then
`HF_TOKEN=… bash packages/training/scripts/publish_all_eliza1.sh
--bundles-root <dir> --base-v1 --public`. Then capture the upload commit/URL
in `evidence/release.json` (`hf.uploadEvidence`). The `recommended`
(fine-tuned) release adds the held-out text-quality gate on top and ships
in v2.

```bash
# Dry-run (safe; no network) — exercises every check:
bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir> --base-v1 --dry-run
python -m scripts.publish.orchestrator --tier 9b --bundle-dir <bundle> --base-v1 --dry-run

# Real upload (needs HF_TOKEN with write access to elizaos/*; not done in CI):
HF_TOKEN=hf_xxx bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir> --base-v1 --public

# Single component checkpoint:
uv run python packages/training/scripts/push_model_to_hf.py \
  --registry-key eliza-1-9b --checkpoint out/eliza-1-9b/text \
  --release-state base-v1 --repo-id elizaos/eliza-1-9b --dry-run
```

Do NOT upload until every eval gate, every supported-backend kernel verify,
and every platform-dispatch report is green for the exact shipped bytes, and
`evidence/release.json` is `releaseState=base-v1`, `finetuned=false`,
`publishEligible=true`. Preserve the upload commit/URL in
`evidence/release.json` (`hf.uploadEvidence`) to flip to `final`-equivalent.

### 10a. HF org transfer (`milady-ai/*` → `elizaos/*`)

The code/docs publish to `elizaos/eliza-1-<tier>`, but the *pre-rename
pipeline's* uploaded repos still live under the old `milady-ai` HF namespace
(the `-milady-optimized` / `-milady-drafter` per-tier bundles + the
`*-optimized` / `*-drafter` base-model variants; inventory in
`packages/inference/reports/porting/2026-05-10/eliza-1-repos/`). HF preserves
git history + download stats across a `repo move`, so move (don't re-upload):

```bash
# Dry-run first (prints every move/create; touches nothing):
bash scripts/hf-transfer-eliza1.sh
# Then, with an HF_TOKEN that has WRITE access to BOTH `milady-ai` and `elizaos`:
HF_TOKEN=hf_xxx bash scripts/hf-transfer-eliza1.sh --execute
# → `huggingface-cli repo move milady-ai/<old> elizaos/<new>` per legacy repo
#   + `huggingface-cli repo create elizaos/eliza-1-<tier> --exist-ok` for the
#     canonical per-tier bundle repos (created empty; the publish path fills them).
```

Then refresh the catalog:
`uv run python packages/training/scripts/sync_catalog_from_hf.py --org elizaos --out packages/inference/reports/porting/$(date -u +%Y-%m-%d)/catalog-diff.json`.

---

## What needs which GPU (summary)

| Step | Host | `release:v1:prep` runs it? |
|---|---|---|
| Fork converter (`convert_hf_to_gguf.py`), `gguf_eliza1_apply.py`, sidecar generation, bundle staging (when the source weights are present), checksums, platform-plan regen, manifest build, `distill_dflash_drafter.py --synthetic-smoke`, `--stamp-only`, quant recipe `--dry-run`s, CPU C reference + kernel-contract | CPU host (the fork is in-tree at `packages/inference/llama.cpp`) | yes — the no-HW step set (`bun run release:v1:prep`). Full bundle staging needs the source GGUFs/safetensors downloaded first (network host); the prep command reports that as a remaining `[needs-data]` step. |
| Fork build with kernel patches, `metal_verify` / `vulkan_verify` / `cuda_verify` / `rocm_verify`, platform-dispatch smokes (`verify/{cuda,rocm,gh200}_runner.sh`, `windows_runner.ps1`) | the target backend's hardware (Metal Mac, CUDA NVIDIA, Vulkan Linux/Android, ROCm AMD; GH200-class aarch64+CUDA for the `27b-1m` tier) | no — listed in the prep checklist as `[hw]`. |
| PolarQuant code generation, TurboQuant skip-layer calibration, DFlash distillation, text perplexity / RTF / WER / VAD / dflash / e2e / 30-turn / mobile RSS+thermal evals | a GPU big enough for the tier (consumer GPU for 0.6B/1.7B; ≥24 GB for 9B; ≥48 GB / multi-GPU for 27B) + reference devices for the mobile/voice rows | no — listed in the prep checklist as `[hw]`. |
| HF publish (`publish_all_eliza1.sh`) + the `milady-ai → elizaos` org transfer (`scripts/hf-transfer-eliza1.sh --execute`) | an `HF_TOKEN` with write access to `elizaos/*` (publish) / to both `milady-ai` and `elizaos` (transfer) | no — listed in the prep checklist; dry-run paths are safe to run anywhere. |

`bun run release:v1:prep` is the authoritative "to ship v1, do this" command:
it runs every no-HW step (16–19 checks, all green in this checkout) and prints
the remaining hardware / network / HF list above. Everything in the no-HW set
is implemented and tested (`python -m pytest packages/training/scripts/manifest/`,
`packages/training/scripts/quantization/test_recipes_smoke.py`,
`make -C packages/inference/verify reference-test kernel-contract`).
