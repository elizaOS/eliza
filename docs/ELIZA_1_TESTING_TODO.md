# Eliza-1 v1 - testing / QA checklist

Every eval, kernel-verify, and smoke that must pass before publishing Eliza-1
v1 (`releaseState=base-v1`). For the publish runbook see [`RELEASE_V1.md`](RELEASE_V1.md);
for the per-backend hardware catalog see
[`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md);
for the live gap state see
[`packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`](packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md).

Legend: `[x]` done in this checkout, `[ ]` pending, `[hw]` pending and needs GPU / reference hardware.

> **`bun run release:v1:prep`** runs every `[x]` line in section A in one command
> (build-dflash dry-run, the manifest + quant-recipe test suites, `py_compile` on
> the pipeline scripts, the quant `--dry-run`s, the DFlash synthetic smoke, the
> platform-plan regen + idempotency check, gate-collect per tier, CPU C reference
> + kernel-contract) and prints the `[hw]` lines below as the remaining checklist
> with the host + command per step. See `RELEASE_V1.md`.

> v1 is the upstream BASE models, GGUF-converted via the `elizaOS/llama.cpp`
> fork with all section 3 kernel optimizations, not fine-tuned. The text eval
> is perplexity-vs-the-upstream-GGUF parity, not a fine-tuned-quality threshold.
> The 0.55 / 0.60 `text_eval` floors in `eliza1_gates.yaml` are the v2
> fine-tuned gate, not the v1 gate.

## A. Host-side / CPU (no GPU, runs in CI)

- [x] `make -C packages/inference/verify reference-test` - C reference clean, `gen_fixture --self-test` finite, including fused-attn + TBQ V-cache parity.
- [x] `make -C packages/inference/verify kernel-contract` - manifest names / capability keys / fixture set / Makefile targets / target list in sync (`OK kernels=6 targets=21 manifestNames=6`).
- [x] `python3 -m pytest packages/training/scripts/manifest/` - bundle staging, manifest build, platform plan, source-weights staging, evidence finalizer.
- [x] `python packages/training/scripts/quantization/test_recipes_smoke.py` - TurboQuant / QJL / Polar recipe parity + codebook-hash / block-layout pins.
- [x] `uv run --extra train python packages/training/scripts/distill_dflash_drafter.py --tier 1_7b --synthetic-smoke ...` - DFlash distill pipeline + GGUF metadata write (no torch / GPU).
- [x] CPU SIMD self-tests on x86_64 - `qjl_int8_smoke`, `qjl_avxvnni_smoke`; `ctest --test-dir build` in `polarquant-cpu` (5/5).
- [x] `bun run test` / `bun run verify` for `packages/app-core/src/services/local-inference/` - engine, downloader, dflash-server, voice streaming, verify-on-device.
- [x] `python3 packages/training/scripts/manifest/eliza1_platform_plan.py --out ELIZA_1_GGUF_PLATFORM_PLAN.json --readiness-md ELIZA_1_GGUF_READINESS.md` regenerates cleanly and idempotently (asserted by `bun run release:v1:prep`); `node .../render-ios-smoke-report.mjs` regenerates `ios-physical-device-smoke.md` from the latest JSON. Both must be re-run + committed on every status change.
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
- [hw] E2E voice loop (mic/file -> ASR -> text -> TTS -> audio) -> `evals.e2eLoopOk`. Interactive driver for a human to send a voice message and get a voice response back (VAD + force-stop/barge-in + all optimizations wired on): `bun run voice:interactive` — see [`docs/voice-interactive.md`](docs/voice-interactive.md) for the prereqs (built dflash binary with the required kernels, the `eliza-1-1_7b` bundle, the fused `libelizainference` / whisper.cpp, Silero VAD, a mic), modes (`--say` / `--wav` / `--no-audio` / `--no-dflash` / `--list-active`), keyboard controls (`s`=force-stop, `m`=mute, `p`=histogram, `q`=quit), and the latency-trace lines. Headless e2e: `bun test packages/app-core/src/services/local-inference/voice/interactive-session.e2e.test.ts` (wiring/cancel/shape asserted unconditionally with stub backends; real-output assertions `it.skipIf(!realBackendPresent)`).
- [hw] 30-turn endurance (no crash, no leak, under `manifest.ramBudgetMb.recommended`) -> `evals.thirtyTurnOk`.
- [hw] Peak RSS / thermal / battery (mobile) recorded in the manifest `evals` block.
- [hw] Gate thresholds applied: `uv run python -m packages.training.benchmarks.eliza1_gates <aggregate.json>` against `packages/training/benchmarks/eliza1_gates.yaml`; collected by `packages/inference/verify/eliza1_gates_collect.mjs`. Any red gate forces `defaultEligible=false`.
- [ ] Fine-tuned text quality is not a v1 gate; it ships in v2 (`releaseState=finetuned-v2`).

## D. Platform-dispatch + on-device evidence

- [hw] For every `evidence/platform/<target>.json` a tier requires (see [`ELIZA_1_GGUF_READINESS.md`](ELIZA_1_GGUF_READINESS.md) per-tier "Required platform evidence"): the graph-dispatch smoke on the real device records `runtimeReady: true` with full graph-dispatch metadata.
- [x] iOS device runtime smoke (symbol resolution + Metal availability + `libelizainference` ABI shape) - PASS on awake physical iPhone 15 Pro / iOS 26.3.1; evidence `packages/inference/reports/porting/2026-05-12/ios-physical-device-smoke-awake-20260512.json` and `packages/inference/verify/hardware-results/ios-device-smoke-awake-2026-05-12.json`.
- [hw] iOS 0_6b weight-backed text TPS - attempted on the same awake iPhone with `eliza-1-0_6b-32k.gguf`, but CPU and Metal both fail at `llama_init_context` because this XCFramework slice reports `iOS static bridge is link-ready but real llama context wiring is not enabled in this slice`; evidence `packages/inference/reports/porting/2026-05-12/ios-physical-device-tps-awake-0_6b-20260512.json`.
- [hw] iOS weight-backed Capacitor bundle smoke - loads the exact release `eliza-1-*.bundle`, records first-token latency, first-audio latency, peak RSS, thermal state, a minimal text response, a minimal TTS/voice response, and voice-off mode proving the TTS/ASR mmap regions stay unmapped.
- [hw] Apple Silicon Mac: built-fork graph-dispatch smoke + full text+DFlash+voice latency/RSS/thermal gates. The fused Metal voice FFI smoke against a staged 1.7B bundle already passes.
- [hw] Android Adreno + Mali: cross-build `android-*-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence, collect thermal/RSS.

## E. Downloader / runtime contract (device-side)

- [x] `runBundleJob` reads the manifest first, then before any weight byte is fetched checks the RAM budget (`ramBudgetMb.min`) and that at least one of the tier's supported backends has a `pass` verify report on this device; aborts with a structured `BundleIncompatibleError` otherwise. Schema-version enforced via Zod literal on `$schema`. Tests: `packages/app-core/src/services/local-inference/downloader.test.ts`.
- [x] `verifyOnDevice` hook wired from the engine (`service.ts` -> `verify-on-device.ts`): text load + 1-token gen always, 1-phrase TTS + barge-in cancel when `manifest.files.voice` is non-empty, unload at the end; a bundle that fails verify stays registered but does not auto-fill an empty default slot. Tests: `verify-on-device.test.ts`.
- [x] OpenWakeWord wired into the voice loop (opt-in, local-mode only); silently inert when the bundle ships no openWakeWord ONNX graphs.
- [ ] Surface `BundleIncompatibleError` distinctly in the UI; have the recommendation engine call `canSetAsDefault` (consults `manifest.kernels.verifiedBackends` against the device). It exists but is not yet called everywhere it should be.

## F. Publish gates (only after every C/D/E gate is green)

Release channel: `--base-v1` (alias `--release-channel base-v1`) publishes the
upstream-base + kernel-optimized release (manifest `releaseChannel: "base-v1"`,
forced `defaultEligible: false`, mandatory `provenance` block + the README
"NOT the fine-tuned Eliza-1, not a recommended default" banner). It relaxes
`final.weights` + the held-out text-quality gate — and enforces every other
gate (C/D/E above) exactly as the default `recommended` channel. The fine-tuned
`recommended` release adds the text-quality gate and ships in v2.

- [x] `python -m scripts.publish.orchestrator --tier <t> --bundle-dir <bundle> --base-v1 --dry-run` and `bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir> --base-v1 --dry-run` — wired; re-run 2026-05-12 on the staged `0_6b` **and** `1_7b` bundles, both exit `EXIT_RELEASE_EVIDENCE_FAIL` (16) at stage 2 because `releaseState=weights-staged` (substitute bytes, not a real fork build), `final.{evals,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}` are not true, and `evidence.finetuned`/`evidence.sourceModels` are absent (see each bundle's `evidence/base-v1-dry-run-*.log`). Manifest schema (Zod + JSON Schema) carry `releaseChannel`; covered by `manifest.test.ts` ("releaseChannel" describe) + `test_orchestrator.py` (base-v1 channel tests) + `eliza1_gates`/`eliza1_manifest` test suites.
- [x] HF repos created (2026-05-12): `elizaos/eliza-1-{0_6b,1_7b,9b}` (model — upstream base GGUFs + `manifest.json` `releaseState: local-standin` + honest cards; 9b GGUF blob upload pending), `elizaos/eliza-1-0_6b-sft-weights` (model — APOLLO test-SFT checkpoint, published as a **candidate**: not `defaultEligible`, not the `recommended` channel), `elizaos/eliza-1-0_6b-sft` + `elizaos/eliza-1-training` (dataset — SFT corpora), `elizaos/eliza-1-evals` (dataset — bench tables + CUDA/Vulkan/CPU kernel-verify evidence), `elizaos/eliza-1-assets` (frozen 1_7b voice/ASR/VAD). **No fork-built `base-v1` or fine-tuned `recommended` weights pushed to any `elizaos/eliza-1-<tier>` main revision** — gated on the items below.
- [hw] `evidence/release.json` is `releaseState=base-v1`, `finetuned=false`, the `sourceModels` map present, `final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=true` (`final.weights` need not be true for `base-v1`), `publishEligible=true`. `checksums/SHA256SUMS` derived from the exact shipped bytes; no fabricated hashes.
- [hw] `licenses/` embeds verbatim SPDX text + `license-manifest.json` sidecar per component (`Serveurperso/OmniVoice-GGUF` non-commercial CC terms, `ggml-org/Qwen3-ASR-*`, Silero MIT, etc.); the publish orchestrator refuses upload otherwise.
<<<<<<< HEAD
- [hw] `HF_TOKEN=… bash packages/training/scripts/publish_all_eliza1.sh --bundles-root <dir> --base-v1 --public` - per-tier publish summary, aborts on first failing tier, propagates the structured exit code. Real upload needs `HF_TOKEN` with write access to `elizaos/*` (operator's, not CI).
=======
- [ ] Local release-evidence validation is now stricter: `evalReports` must enumerate every shipped `evals/*` file, `checksums/SHA256SUMS` must reference real files with matching SHA-256 bytes, and `hf.uploadEvidence.uploadedPaths` must cover the exact payload commit (`eliza-1.manifest.json`, `README.md`, weights, licenses, evals, evidence, and checksums). Keep this green before any real HF push.
- [hw] `bash packages/training/scripts/publish_all_eliza1.sh` - per-tier publish summary, aborts on first failing tier, propagates the structured exit code. Dry-run first; real upload needs `HF_TOKEN` with write access to `elizaos/*` (operator's, not CI).
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
- [hw] Upload commit/URL preserved in `evidence/release.json` (`hf.uploadEvidence`).
- [hw] `bash scripts/hf-transfer-eliza1.sh --execute` - move the legacy `milady-ai/*` HF model repos (the per-tier `*-optimized`/`*-drafter` bundles) into `elizaos/*` and `repo create elizaos/eliza-1-<tier>` for the canonical bundle repos. Dry-run (`bash scripts/hf-transfer-eliza1.sh`) is safe anywhere; `--execute` needs an `HF_TOKEN` with write access to BOTH `milady-ai` and `elizaos`. Then `sync_catalog_from_hf.py --org elizaos`.

## G. Local M4 Max evidence and optimization follow-ups

- Metal standalone kernel verification on Apple M4 Max: Turbo3, Turbo4, Turbo3-TCQ, QJL, Polar, Polar+QJL, Polar-preHT, and Polar-preHT+QJL all pass fixture parity.
- Metal built-fork graph dispatch: `dispatch_smoke` passes QJL, Turbo3, Turbo4, Turbo3-TCQ, raw Polar (`use_qjl=0/1`), and explicit pre-Hadamard Polar (`use_qjl=0/1`).
- Vision smoke now runs on Mac Metal: 9B passes from the installed managed `llama-mtmd-cli`; 27B passes from the build-tree `llama-mtmd-cli`. Release still needs broader image evals and the Metal `UPSCALE` fallback optimized or budgeted.
- DFlash smoke is fail-closed, not green: the local target is `gpt2`/`qwen2` with 151936 tokens while the drafter is `gpt2`/`qwen35` with 248320 tokens, so drafting remains inactive with zero drafted/accepted tokens.
- Self-labelled TTS->ASR loopback exists and is useful for regressions: current M4 Max Metal run is WER 0.171 over 8 synthesized utterances, ASR RTF 3.98, mean round trip 4.75s. It is not a release ASR WER pass.
- Metal runtime tuning knobs: QJL/TBQ defaults remain conservative, but `ELIZA_METAL_*_PER_TG` overrides pass the graph smoke and are ready for per-device autotune.
- MoltenVK standalone/multiblock/fused smoke is useful local parity evidence, but it is not native Vulkan publish evidence.
- Per-device Metal autotune should keep sweeping QJL tokens-per-threadgroup and TBQ blocks-per-threadgroup across median, p95, p99, and cancellation latency. Persist chosen values in release evidence for each device class.
- Polar preHT graph selection should route only through `ggml_attn_score_polar_preht()` when the graph explicitly constructs `H*q`; raw-q graphs must keep the raw Polar route.
- Fused attention should keep benchmarking score -> online softmax -> V mix against the current standalone score path at 4k, 32k, 64k, 128k, and 256k contexts.
- Voice-mode scheduling should keep command-buffer batching disabled for interactive voice. Evaluate short graph tiles instead; barge-in/cancel latency is the primary metric.
- CPU plugin sweeps should measure AVX2/AVX-VNNI/NEON/dotprod QJL and Polar preHT paths at 1, 4, 8, 16, and max practical thread counts under low-load conditions.
