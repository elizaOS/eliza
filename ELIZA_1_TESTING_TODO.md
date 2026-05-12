# Eliza-1 v1 - testing / QA checklist

Every eval, kernel-verify, and smoke that must pass before publishing Eliza-1
v1 (`releaseState=base-v1`). For the publish runbook see [`RELEASE_V1.md`](RELEASE_V1.md);
for the per-backend hardware catalog see
[`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md);
for the live gap state see
[`packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`](packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md).

Legend: `[x]` done in this checkout, `[ ]` pending, `[hw]` pending and needs GPU / reference hardware.

> v1 is the upstream BASE models, GGUF-converted via the `elizaOS/llama.cpp`
> fork with all section 3 kernel optimizations, not fine-tuned. The text eval
> is perplexity-vs-the-upstream-GGUF parity, not a fine-tuned-quality threshold.
> The 0.55 / 0.60 `text_eval` floors in `eliza1_gates.yaml` are the v2
> fine-tuned gate, not the v1 gate.

## A. Host-side / CPU (no GPU, runs in CI)

- [x] `make -C packages/inference/verify reference-test` - C reference clean, `gen_fixture --self-test` finite, including fused-attn + TBQ V-cache parity.
- [x] `make -C packages/inference/verify kernel-contract` - manifest names / capability keys / fixture set / Makefile targets / target list in sync (`OK kernels=6 targets=23 manifestNames=6`).
- [x] `python3 -m pytest packages/training/scripts/manifest/` - bundle staging, manifest build, platform plan, source-weights staging, evidence finalizer.
- [x] `python packages/training/scripts/quantization/test_recipes_smoke.py` - TurboQuant / QJL / Polar recipe parity + codebook-hash / block-layout pins.
- [x] `uv run --extra train python packages/training/scripts/distill_dflash_drafter.py --tier 1_7b --synthetic-smoke ...` - DFlash distill pipeline + GGUF metadata write (no torch / GPU).
- [x] CPU SIMD self-tests on x86_64 - `qjl_int8_smoke`, `qjl_avxvnni_smoke`; `ctest --test-dir build` in `polarquant-cpu` (5/5).
- [x] `bun run test` / `bun run verify` for `packages/app-core/src/services/local-inference/` - engine, downloader, dflash-server, voice streaming, verify-on-device.
- [ ] `python3 packages/training/scripts/manifest/eliza1_platform_plan.py --out ... --readiness-md ...` and `node .../render-ios-smoke-report.mjs` regenerate cleanly and idempotently on every status change.
- [hw] `make -C packages/inference/verify cuda-preprocess-check` - host-side CUDA API/layout surface check. Requires the fork's CUDA headers staged via `build-llama-cpp-dflash.mjs --target linux-x64-cuda --no-build`; no `nvcc` needed.

## B. Kernel verification (per supported backend, against shipped quantized bytes)

- [x] `make -C packages/inference/verify metal-verify metal-verify-multiblock` - 8/8 PASS on Apple M4 Max (turbo3/turbo4/turbo3_tcq/qjl/polar incl. polar pre-Hadamard, both residual modes).
- [x] `make -C packages/inference/verify vulkan-verify vulkan-verify-fallbacks vulkan-verify-fused` - 8/8 on Intel ARL Mesa ANV (+ lavapipe / MoltenVK for parts); fused-attn 1920/1920 on Intel ARL.
- [x] `make -C packages/inference/verify dispatch-smoke` (Metal built-fork graph dispatch) - `GGML_OP_ATTN_SCORE_{QJL,TBQ,POLAR}` runtime-ready on Apple M4 Max.
- [x] `make -C packages/inference/verify vulkan-native-smoke` / `vulkan-dispatch-smoke` - Vulkan built-fork graph dispatch runtime-ready on Intel Arc/Xe (Mesa ANV); evidence `verify/vulkan-runtime-dispatch-evidence.json`.
- [x] `make -C packages/inference/verify metal-verify-fused` - Metal fused-attn standalone hardware verify on Apple M4 Max.
- [hw] Metal fused built-fork graph dispatch smoke before `fusedAttn.runtimeStatus.metal` can flip runtime-ready.
- [hw] `verify/cuda_runner.sh --report <path>` - CUDA fixture parity + GGUF graph smoke on desktop NVIDIA (Ampere/Ada/Blackwell); `verify/gh200_runner.sh` for GH200/Hopper aarch64 (`27b-256k` / `27b-1m`).
- [hw] `verify/rocm_runner.sh --report <path>` - ROCm/HIP graph smoke on an AMD GPU (MI250/MI300); a `hip_verify` fixture-parity harness is still an open decision.
- [hw] `verify/windows_runner.ps1 -Backend <cpu|cuda|vulkan> -Report <path>` - native Windows x64 smoke; same for `windows-arm64-{cpu,vulkan}` on a Snapdragon X device.
- [hw] `make -C packages/inference/verify android-vulkan-smoke` with `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE=<built-fork/app graph-dispatch report>` - one Adreno + one Mali device; standalone-fixture success alone is not enough.
- [hw] `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <each target>` - the fork actually builds and the post-build capability gate is green for the bundle's `dtype` on each supported backend. The build must fail if any required section 3 kernel is missing.

## C. `base-v1` evals (run on the base weights; gate publish)

For each tier (`0_6b`, `1_7b`, `9b`, `27b`, `27b-256k`, `27b-1m`), against the exact shipped quantized bundle bytes:

- [hw] Text perplexity vs the upstream GGUF (parity, not a quality floor) -> `evals/text-eval.json` / `evals/aggregate.json`.
- [hw] Voice RTF (real-time factor) -> `evals/voice-rtf.json`.
- [hw] ASR WER -> `evals.asrWer` / `evals/aggregate.json`.
- [hw] VAD latency / boundary / endpoint / false-barge-in -> `evals.vadLatencyMs` plus the related VAD slots.
- [hw] DFlash acceptance rate + speedup -> `evals.dflash` (bench via `packages/inference/.../dflash_drafter_runtime_smoke.mjs --bench`).
- [hw] E2E voice loop (mic/file -> ASR -> text -> TTS -> audio) -> `evals.e2eLoopOk`.
- [hw] 30-turn endurance (no crash, no leak, under `manifest.ramBudgetMb.recommended`) -> `evals.thirtyTurnOk`.
- [hw] Peak RSS / thermal / battery (mobile) recorded in the manifest `evals` block.
- [hw] Gate thresholds applied: `uv run python -m packages.training.benchmarks.eliza1_gates <aggregate.json>` against `packages/training/benchmarks/eliza1_gates.yaml`; collected by `packages/inference/verify/eliza1_gates_collect.mjs`. Any red gate forces `defaultEligible=false`.
- [ ] Fine-tuned text quality is not a v1 gate; it ships in v2 (`releaseState=finetuned-v2`).

## D. Platform-dispatch + on-device evidence

- [hw] For every `evidence/platform/<target>.json` a tier requires (see [`ELIZA_1_GGUF_READINESS.md`](ELIZA_1_GGUF_READINESS.md) per-tier "Required platform evidence"): the graph-dispatch smoke on the real device records `runtimeReady: true` with full graph-dispatch metadata.
- [x] iOS device runtime smoke (symbol resolution + Metal availability + `libelizainference` ABI shape) - PASS on iPhone 15 Pro / iOS 26.3.1, 3/3 XCTest; `node packages/inference/reports/porting/2026-05-11/render-ios-smoke-report.mjs` regenerates `ios-physical-device-smoke.md` from `ios-physical-device-smoke-latest.json`.
- [hw] iOS weight-backed Capacitor bundle smoke - loads the exact release `eliza-1-*.bundle`, records first-token latency, first-audio latency, peak RSS, thermal state, a minimal text response, a minimal TTS/voice response, and voice-off mode proving the TTS/ASR mmap regions stay unmapped.
- [hw] Apple Silicon Mac: built-fork graph-dispatch smoke + full text+DFlash+voice latency/RSS/thermal gates. The fused Metal voice FFI smoke against a staged 1.7B bundle already passes.
- [hw] Android Adreno + Mali: cross-build `android-*-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence, collect thermal/RSS.

## E. Downloader / runtime contract (device-side)

- [x] `runBundleJob` reads the manifest first, then before any weight byte is fetched checks the RAM budget (`ramBudgetMb.min`) and that at least one of the tier's supported backends has a `pass` verify report on this device; aborts with a structured `BundleIncompatibleError` otherwise. Schema-version enforced via Zod literal on `$schema`. Tests: `packages/app-core/src/services/local-inference/downloader.test.ts`.
- [x] `verifyOnDevice` hook wired from the engine (`service.ts` -> `verify-on-device.ts`): text load + 1-token gen always, 1-phrase TTS + barge-in cancel when `manifest.files.voice` is non-empty, unload at the end; a bundle that fails verify stays registered but does not auto-fill an empty default slot. Tests: `verify-on-device.test.ts`.
- [x] OpenWakeWord wired into the voice loop (opt-in, local-mode only); silently inert when the bundle ships no openWakeWord ONNX graphs.
- [ ] Surface `BundleIncompatibleError` distinctly in the UI; have the recommendation engine call `canSetAsDefault` (consults `manifest.kernels.verifiedBackends` against the device). It exists but is not yet called everywhere it should be.

## F. Publish gates (only after every C/D/E gate is green)

- [hw] `evidence/release.json` is `releaseState=base-v1`, `finetuned=false`, the `sourceModels` map present, `final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=true` (`final.weights` need not be true for `base-v1`), `publishEligible=true`. `checksums/SHA256SUMS` derived from the exact shipped bytes; no fabricated hashes.
- [hw] `licenses/` embeds verbatim SPDX text + `license-manifest.json` sidecar per component (`Serveurperso/OmniVoice-GGUF` non-commercial CC terms, `ggml-org/Qwen3-ASR-*`, Silero MIT, etc.); the publish orchestrator refuses upload otherwise.
- [hw] `bash packages/training/scripts/publish_all_eliza1.sh` - per-tier publish summary, aborts on first failing tier, propagates the structured exit code. Dry-run first; real upload needs `HF_TOKEN` with write access to `elizaos/*` (operator's, not CI).
- [hw] Upload commit/URL preserved in `evidence/release.json` (`hf.uploadEvidence`).

## G. Local M4 Max evidence and optimization follow-ups

- Metal standalone kernel verification on Apple M4 Max: Turbo3, Turbo4, Turbo3-TCQ, QJL, Polar, Polar+QJL, Polar-preHT, and Polar-preHT+QJL all pass fixture parity.
- Metal built-fork graph dispatch: `dispatch_smoke` passes QJL, Turbo3, Turbo4, Turbo3-TCQ, raw Polar (`use_qjl=0/1`), and explicit pre-Hadamard Polar (`use_qjl=0/1`).
- Metal runtime tuning knobs: QJL/TBQ defaults remain conservative, but `ELIZA_METAL_*_PER_TG` overrides pass the graph smoke and are ready for per-device autotune.
- MoltenVK standalone/multiblock/fused smoke is useful local parity evidence, but it is not native Vulkan publish evidence.
- Per-device Metal autotune should keep sweeping QJL tokens-per-threadgroup and TBQ blocks-per-threadgroup across median, p95, p99, and cancellation latency. Persist chosen values in release evidence for each device class.
- Polar preHT graph selection should route only through `ggml_attn_score_polar_preht()` when the graph explicitly constructs `H*q`; raw-q graphs must keep the raw Polar route.
- Fused attention should keep benchmarking score -> online softmax -> V mix against the current standalone score path at 4k, 32k, 64k, 128k, and 256k contexts.
- Voice-mode scheduling should keep command-buffer batching disabled for interactive voice. Evaluate short graph tiles instead; barge-in/cancel latency is the primary metric.
- CPU plugin sweeps should measure AVX2/AVX-VNNI/NEON/dotprod QJL and Polar preHT paths at 1, 4, 8, 16, and max practical thread counts under low-load conditions.
