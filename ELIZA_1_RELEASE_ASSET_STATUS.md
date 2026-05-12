# Eliza-1 v1 — release asset status

What is done in this checkout, what still needs which GPU / reference hardware,
and where each component's bytes come from. This is the **status doc**. For the
step-by-step "run these commands to ship v1" sequence see [`RELEASE_V1.md`](RELEASE_V1.md).

> **v1 = the upstream BASE models, GGUF-converted via the `elizaOS/llama.cpp`
> fork with every Eliza kernel optimization (every quant/kernel trick in
> [`packages/inference/AGENTS.md`](packages/inference/AGENTS.md) §3), NOT
> fine-tuned.** The intended release shape is `releaseState=base-v1` with
> `provenance.finetuned=false` and a `provenance.sourceModels` map (which
> upstream HF repo each bundle component comes from). It is `publishEligible`
> once it has real fork-built GGUF/quant-sidecar bytes, real per-backend
> dispatch/verify evidence on real hardware, the `base-v1` evals, the
> release-reviewed license files, and the `elizaos/eliza-1-*` upload evidence —
> never a fabricated hash. Fine-tuned text quality ships in **v2**
> (`releaseState=finetuned-v2`); it is not a v1 blocker.

---

## Document map

| Doc | Role |
|---|---|
| [`RELEASE_V1.md`](RELEASE_V1.md) | The **runbook** — to ship Eliza-1 v1, run these commands, in this order, on these hosts. |
| [`ELIZA_1_RELEASE_ASSET_STATUS.md`](ELIZA_1_RELEASE_ASSET_STATUS.md) (this file) | The **status doc** — what's done in-checkout, what needs which GPU / reference HW, the per-tier-per-component source-model table. |
| [`ELIZA_1_GGUF_READINESS.md`](ELIZA_1_GGUF_READINESS.md) | **Generated** by `packages/training/scripts/manifest/eliza1_platform_plan.py` — per-tier required files + required platform evidence (a release checklist, not hardware evidence). Do not hand-edit; regenerate. |
| [`ELIZA_1_GGUF_PLATFORM_PLAN.json`](ELIZA_1_GGUF_PLATFORM_PLAN.json) | **Generated** by the same script — the machine-readable per-tier plan + (when `--bundle-root` is given) the release-status blockers. Do not hand-edit; regenerate. |
| [`ELIZA_1_TESTING_TODO.md`](ELIZA_1_TESTING_TODO.md) | The **QA checklist** — every eval / verify / smoke that must pass for v1, with the runner command and the hardware it needs. |
| [`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md) | The canonical **"what hardware does someone need to plug in"** catalog — per backend × device, with runner commands + blockers. |
| [`packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`](packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md) | The **gap source-of-truth** — current runtime truth table + P0 blockers + remaining work. |
| [`packages/inference/reports/porting/2026-05-11/kernel-optimization-review.md`](packages/inference/reports/porting/2026-05-11/kernel-optimization-review.md) | The **kernel-perf backlog** — fused attention, multi-block routing, pre-Hadamard, int-dot, device sweeps. |
| [`packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md`](packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md) | The **iOS smoke status** — generated from `ios-physical-device-smoke-latest.json` by `render-ios-smoke-report.mjs`. |
| [`packages/inference/PRECACHE.md`](packages/inference/PRECACHE.md) | The **precache strategy** doc — text-side KV pre-warm: what's warmed, when, how it's keyed, how it's invalidated. |
| [`packages/inference/AGENTS.md`](packages/inference/AGENTS.md) | The **canonical contract** for the on-device inference stack (tier matrix, bundle layout, mandatory kernels, manifest schema, publishing, verification gates). The durable "current state" facts live here and in this status doc. |
| [`ELIZA_1_VOICE_SWARM.md`](ELIZA_1_VOICE_SWARM.md) | **Historical record** of the voice swarm wave plan — COMPLETE. Not an active plan; the durable facts moved to `packages/inference/AGENTS.md` and this doc. |
| [`docs/porting/upstream-rebase-plan.md`](docs/porting/upstream-rebase-plan.md) | The **deferred** plan to rebase the fork onto current upstream llama.cpp. NOT a v1 blocker — the fork already carries `grammar_lazy` / `json_schema` / structured output. |

---

## Build targets (what platforms ship)

Apple Silicon `darwin-arm64-metal` (+ `-fused`), `ios-arm64-metal` /
`ios-arm64-simulator-metal`, `linux-x64-{cpu,vulkan,cuda,rocm}`,
`linux-aarch64-{cpu,cuda}`, `windows-x64-{cpu,vulkan,cuda}`,
`windows-arm64-{cpu,vulkan}`, `android-{adreno,mali}-vulkan`. **Intel Macs
(`darwin-x64-metal`) are no longer a supported target** — Intel Mac dGPUs are
AMD Radeon Pro / Intel Iris, a different GPU family from Apple Silicon with
different SIMD-group sizes and `simd_sum` semantics, so the Apple Silicon Metal
result does not transfer. The full target list is `SUPPORTED_TARGETS` in
`packages/app-core/scripts/build-llama-cpp-dflash.mjs` and the
`kernel-contract.json` target list (`make -C packages/inference/verify kernel-contract`).

---

## Per-tier source models (v1 base, upstream repos)

The catalog's per-tier `sourceModel` block
(`packages/shared/src/local-inference/catalog.ts` → `sourceModelForTier`)
records this; it must agree with the tier's manifest `provenance.sourceModels`,
and `eliza-1.manifest.json`'s `lineage.*` records the upstream license per
component.

| Component | v1 source (upstream HF repo) | In bundle as | Optimization on top |
|---|---|---|---|
| Text 0.6B | `Qwen/Qwen3-0.6B-GGUF` (until `Qwen3.5-0.6B` is published) | `text/eliza-1-0_6b-32k.gguf` | TurboQuant Q3 + QJL K-cache + PolarQuant V-cache + fused-attn + DFlash |
| Text 1.7B | `Qwen/Qwen3-1.7B-GGUF` (until `Qwen3.5-1.7B` is published) | `text/eliza-1-1_7b-{32k,64k}.gguf` | TurboQuant Q3/Q4 + QJL + Polar + fused-attn + DFlash |
| Text 9B | `unsloth/Qwen3.5-9B-GGUF` (reconvert from HF safetensors for Eliza types) | `text/eliza-1-9b-{64k,128k}.gguf` + `vision/mmproj-9b.gguf` | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` (≥64k) + fused-attn + DFlash |
| Text 27B (`27b`, `27b-256k`, `27b-1m`) | `batiai/Qwen3.6-27B-GGUF` (reconvert for Eliza types) | `text/eliza-1-27b-{128k,256k,1m}.gguf` + `vision/mmproj-27b*.gguf` | TurboQuant Q4 + QJL + Polar + `turbo3_tcq` + fused-attn + DFlash |
| Voice (TTS) | `Serveurperso/OmniVoice-GGUF` | `tts/omnivoice-base-<quant>.gguf` + `tts/omnivoice-tokenizer-<quant>.gguf` | fused-omnivoice runtime; quant = `Q4_K_M` on 0.6B/1.7B, `Q8_0` on 9B+ (`VOICE_QUANT_BY_TIER`); non-commercial CC-compatible licensing per `packages/inference/AGENTS.md` §1 |
| ASR | `ggml-org/Qwen3-ASR-0.6B-GGUF` (0.6B/1.7B/9B) / `ggml-org/Qwen3-ASR-1.7B-GGUF` (27B tiers) | `asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf` | tokenizer fused with the text backbone (zero re-tokenization) |
| VAD | Silero VAD v5.1.2 (MIT) | `vad/silero-vad-v5.1.2.ggml.bin` (native GGML; legacy bundles may also carry the `vad/silero-vad-int8.onnx` fallback — not the release path) | none |
| Embedding | `Qwen/Qwen3-Embedding-0.6B-GGUF` (1.7B+ tiers) | `embedding/...gguf` | none beyond fork conversion; the `0_6b` tier omits it (pools from the text backbone with `--pooling last`) |
| Drafter (DFlash) | distilled (KD, NOT fine-tuning of the target) from each tier's base text model; published under `elizaos/eliza-1-<tier>` | `dflash/drafter-<tier>.gguf` + `dflash/target-meta.json` | drafter GGUF stamps `dflash-draft.target_checkpoint_sha256` |
| Voice preset cache | placeholder until a real fused build emits one | `cache/voice-preset-default.bin` | n/a |

---

## What is done in this checkout (no GPU / reference HW needed)

- The patched fork (`elizaOS/llama.cpp @ v1.0.0-eliza`, upstream base `b8198`)
  ships in-tree as a git submodule at `packages/inference/llama.cpp`; `bun
  install` initializes it. It carries TurboQuant (`turbo3`/`turbo4`/`turbo3_tcq`),
  QJL (`block_qjl1_256`, `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_FUSED_ATTN_QJL_TBQ`),
  PolarQuant (`block_q4_polar`, `Q4_POLAR=47`), the Metal/Vulkan/CUDA kernels,
  DFlash spec-decode (`--spec-type dflash`, the `dflash-draft` GGUF arch), and
  the post-refactor `llama-server` (`server-{task,common,context,http}.cpp` with
  `grammar_lazy` / `json_schema` / `response_format` / `prefill_assistant`).
- The Metal and Vulkan kernel patch hooks do real work: they stage the verified
  standalone shaders into the fork, patch the metallib `add_custom_command` /
  the Vulkan shader-gen + pipeline-creation, and add op-level dispatch. They run
  unconditionally on every matching target (no env-var opt-in); the old
  `ELIZA_DFLASH_PATCH_*` knobs were decorative log toggles and have been removed.
- CPU C reference + fixtures: `make -C packages/inference/verify reference-test`
  is clean; `make kernel-contract` is green. The CPU SIMD paths (AVX2 / AVX-VNNI
  for QJL/Polar, scalar references for the int8-sketch and ARM dotprod variants)
  build clean and self-test on x86_64 here.
- The training/manifest/publish machinery: the quant recipes
  (`packages/training/scripts/quantization/`), the converter wrapper
  (`gguf_eliza1_apply.py`, `--release-state base-v1`), the DFlash distiller
  (`distill_dflash_drafter.py`, `--synthetic-smoke` runs offline), the bundle
  stagers (`packages/training/scripts/manifest/stage_*.py`), the manifest builder
  (`eliza1_manifest.py`), the platform-plan generator (`eliza1_platform_plan.py`),
  and the publish orchestrator (gates on `releaseState ∈ {base-v1, upload-candidate,
  final}` + the `final.*` flags + `finetuned=false` + the `sourceModels` map).
- The publish channel split: the manifest carries `releaseChannel` (`"recommended"`
  | `"base-v1"`); the orchestrator + `publish_all_eliza1.sh` take `--base-v1`
  (alias `--release-channel base-v1`). The `base-v1` channel forces
  `defaultEligible: false`, emits the mandatory `provenance` block + the
  README "upstream-base, NOT the fine-tuned Eliza-1, not a recommended default"
  banner, relaxes `final.weights` + the held-out text-quality gate — and
  enforces **every other gate** (kernel verify on every supported backend,
  every required platform-dispatch report, the runnable-on-base evals, every
  license attestation) exactly as on the `recommended` channel. The
  fine-tuned `recommended` release ships in v2.
- Local release-shaped bundles exist for all five tiers for runtime-layout smoke
  (placeholder/substitute bytes — not yet fork-built from the upstream base
  weights; `releaseState` is `weights-staged`, not `base-v1`).
- **`--base-v1 --dry-run` verdict (`eliza-1-0_6b` / `eliza-1-1_7b`):** BLOCKED
  with `EXIT_RELEASE_EVIDENCE_FAIL` (16) — see each bundle's
  `evidence/base-v1-dry-run-*.log`. Blockers: `releaseState=weights-staged`
  (substitute bytes, not a real fork build); `final.evals` false (`voice_rtf`
  ≈6–9× vs ≤0.5 and `asr_wer` 1.0 vs ≤0.1 fail even with text-quality relaxed;
  VAD/e2e/30-turn missing); `final.kernelDispatchReports` false (Metal/iOS/
  Android pending); `final.platformEvidence` false (all stubs);
  `final.sizeFirstRepoIds` false; no `finetuned`/`sourceModels` in the
  evidence. No upload was performed — the kernel-verification + license gates
  AGENTS.md §7 forbids bypassing are not yet satisfiable. `RELEASE_V1.md`
  §10 lists the exact prerequisites.

## What still needs a GPU or reference hardware

See [`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md)
for the per backend × device catalog with runner commands. In summary:

- **Verified on hardware:** Metal standalone + built-fork graph dispatch (Apple
  M4 Max); Vulkan standalone score/fallback/fused-attn (Intel ARL Mesa ANV;
  also lavapipe + MoltenVK for parts) and Vulkan built-fork graph dispatch on
  Intel-ANV; Android Vulkan standalone fixtures (Pixel 6a / Mali-G78); iOS
  device runtime smoke (iPhone 15 Pro / iOS 26.3.1 — symbol/Metal-availability/ABI
  shape, 3/3 XCTest); CPU SIMD self-tests (Intel Arrow Lake AVX2 + AVX-VNNI).
- **Needs hardware:** AMD / NVIDIA native Vulkan graph dispatch; Android Adreno
  + Mali built-fork graph-dispatch evidence; CUDA (desktop NVIDIA + GH200/Hopper
  aarch64); ROCm/HIP; native Windows x64/arm64 smoke; the weight-backed iOS
  Capacitor bundle smoke; ARM CPU SIMD bench; the Metal fused-attn kernel
  hardware verify; and — for each tier — the real fork build, the per-backend
  dispatch/verify evidence, the `base-v1` evals, and the `elizaos/eliza-1-*`
  upload (operator's `HF_TOKEN`).

---

## Regenerating the generated artifacts

```bash
python3 packages/training/scripts/manifest/eliza1_platform_plan.py \
  --out ELIZA_1_GGUF_PLATFORM_PLAN.json \
  --readiness-md ELIZA_1_GGUF_READINESS.md
# add --bundle-root <staged-bundles-dir> to also emit the release-status blockers.

node packages/inference/reports/porting/2026-05-11/render-ios-smoke-report.mjs
# regenerates packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md
```

Both are idempotent. `python3 -m pytest packages/training/scripts/manifest/test_eliza1_platform_plan.py` covers the generator.
