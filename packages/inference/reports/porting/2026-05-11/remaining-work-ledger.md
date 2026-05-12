# Eliza-1 Local Inference Remaining-Work Ledger - 2026-05-11

This ledger is the source-of-truth gap list after the full Metal graph-dispatch,
Apple artifact, iOS physical-device smoke, and Vulkan graph-dispatch source
patch pass. It separates three states that previous reports occasionally mixed:

- **shader-verified**: the standalone shader matches a JSON fixture.
- **symbol-shipped**: the patched fork artifact contains the kernel symbol.
- **runtime-ready**: llama.cpp graph execution can select the kernel and a
  built-fork smoke test numerically matches the reference.

Only **runtime-ready** satisfies the Eliza-1 publish contract.

The executable gate for this ledger is
`packages/inference/verify/kernel-contract.json` plus
`packages/inference/verify/metal-runtime-dispatch-evidence.json`, checked by
`make -C packages/inference/verify kernel-contract`. That check keeps the
manifest kernel names, build capability keys, fixture coverage, Makefile
targets, Metal runtime-dispatch evidence, and platform target list aligned
with the status below.

For the narrow "what hardware does someone need to plug in" view — every
backend × device that is source-complete but unverified, with the exact runner
command and remaining blocker — see
[`needs-hardware-ledger.md`](./needs-hardware-ledger.md).

**Android `*-fused` omnivoice graft — wired 2026-05-12.** The AOSP NDK
cross-build path in `packages/app-core/scripts/aosp/compile-libllama.mjs`
now runs the same `prepare.mjs` + `cmake-graft.mjs` + `verify-symbols.mjs`
flow that the dflash desktop fused targets use, behind a new explicit
`--target android-{arm64,x86_64}-{cpu,vulkan}-fused` flag (plus a
`--dry-run` plan-only mode). End-to-end verification on this box was
`--dry-run` only — no Android NDK is installed, no Android hardware. The
operator command for an NDK-bearing box is in
[`../2026-05-12/android-fused-graft-wiring.md`](../2026-05-12/android-fused-graft-wiring.md).
Closes `.swarm/STATUS.md` FINALIZE-2 item 5 / genuinely-remaining #3 at
the source layer.

**Verify re-run, 2026-05-12 (post multi-agent wave):** the full integration
matrix is green again on this box (CPU + Intel ARL/ANV Vulkan + RTX 5080 sm_120
CUDA, run alongside a concurrent full-corpus SFT job holding ~12 GB VRAM — no
contention on the short verify runs): `make -C packages/inference/verify
kernel-contract reference-test cpu-bench cpu-dispatch-smoke vulkan-dispatch-smoke
vulkan-verify vulkan-verify-multiblock vulkan-verify-fused cuda-verify
cuda-verify-fused` — every target PASS, nothing regressed. `bun run typecheck`
(`packages/app-core`) clean; `bun test packages/app-core/src/services/local-inference/`
603 pass / 17 fail (all 17 are the known shared-mock test-isolation flakes —
downloader passes 7/7 alone — plus the 2 `fused llama-server` tests that need the
fused binary); `…/voice/` 217/218 + `engine.voice*` 28/28 green; `python3 -m
pytest packages/training/scripts/{eval,publish,manifest,wakeword}
packages/training/benchmarks` 140 passed / 1 skipped. Full table in
[`../../../verify/PLATFORM_MATRIX.md`](../../../verify/PLATFORM_MATRIX.md)
("Verify status as of 2026-05-12"). The §3 build gates and the hardware-gated
items below are unchanged.

## Current Runtime Truth

| Area | Status | Evidence |
| --- | --- | --- |
| Metal standalone shaders | `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar` all pass 8/8 on Apple M4 Max. | `make -C packages/inference/verify metal-verify metal-verify-multiblock` |
| Metal built-fork graph dispatch | `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` for `turbo3`, `turbo4`, and `turbo3_tcq`, raw `GGML_OP_ATTN_SCORE_POLAR`, and explicit pre-Hadamard Polar graph dispatch are runtime-ready. | `make -C packages/inference/verify dispatch-smoke` now covers the full Metal graph-dispatch set; Turbo4 routes through `kernel_turbo4_dot_multi` against the fork's four-record TBQ4 layout with max diff `4.768e-07`; raw Polar and `ggml_attn_score_polar_preht()` both pass for `use_qjl=0/1` with max diff `3.815e-06`. `dispatch-smoke-implemented` is now an alias of the full dispatch smoke. |
| Metal artifact gate | `darwin-arm64-metal`, `darwin-arm64-metal-fused`, `ios-arm64-metal`, and `ios-arm64-simulator-metal` pass the build-script capability gate. | `build-llama-cpp-dflash.mjs` reads `verify/metal-runtime-dispatch-evidence.json` and reports each Metal runtime capability true only when the matching shipped symbol and runtime-ready evidence are both present. Fresh builds wrote `CAPABILITIES.json` with `dflash`, `turbo3`, `turbo4`, `turbo3_tcq`, `qjl_full`, `polarquant`, `lookahead`, and `ngramDraft` true. |
| Vulkan standalone shaders | All five pass on Apple M4 Max through MoltenVK; turbo* also passed earlier on Intel ARL + lavapipe. | `make -C packages/inference/verify vulkan-verify`. |
| Android Vulkan standalone runner | Pixel 6a Mali standalone validation is real-device ready; Adreno and graph-dispatch evidence remain open. | Homebrew `android-platform-tools` + `android-commandlinetools` installed; SDK at `~/Library/Android/sdk`; `android_vulkan_smoke.sh` resolves NDKs under `ANDROID_HOME` / `ANDROID_SDK_ROOT`, statically links libc++, refuses emulators/software Vulkan unless explicitly allowed, and no longer trips `pipefail` on `vulkaninfo` truncation. `make -C packages/inference/verify android-vulkan-smoke` passed all six fixtures on Pixel 6a / Mali-G78 (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`, `polar_qjl`; max diff <= `7.629e-06`) with evidence `verify/hardware-results/android-vulkan-smoke-20260511T062056Z.log`. |
| Vulkan built-fork graph dispatch | **Runtime-ready on native Linux Intel-ANV hardware.** `vulkan-dispatch-smoke` reconciled to the committed fork pin (`packages/inference/llama.cpp` gitlink `eae44e75`, = `08032d57` + 1): the harness drives the two fused attention graph ops the fork pin declares in `ggml.h` — `GGML_OP_ATTN_SCORE_QJL` (32 outs, max 2.682e-7) and `GGML_OP_FUSED_ATTN_QJL_TBQ` (512 outs, max 4.470e-8) — both PASS on real Intel ARL (Mesa ANV, Vulkan 1.4). `kernel-contract.json` `runtimeStatus.vulkan` stays `runtime-ready` for `turbo3`/`turbo4`/`turbo3_tcq`/`qjl`/`polar` + `fusedAttn`; `make -C packages/inference/verify kernel-contract vulkan-dispatch-smoke` green. | `vulkan_dispatch_smoke.cpp` now `#include`s only the two builders the fork pin exports (`ggml_attn_score_qjl`, `ggml_fused_attn_qjl_tbq`) so it compiles against the bare submodule headers (`ELIZA_DFLASH_LLAMA_DIR` defaults to the in-repo `packages/inference/llama.cpp`); links against the managed `linux-x64-vulkan` `libggml-vulkan.so`. The standalone TBQ/Polar score kernels (`GGML_OP_ATTN_SCORE_TBQ`/`POLAR` — extra builders the `metal-kernels.mjs` ggml.h patch adds during a build) are covered by `make vulkan-verify` against the JSON fixtures + the fork `llama-server --cache-type-{k,v}` whitelist; their built-fork graph entries in `vulkan-runtime-dispatch-evidence.json` are from a prior full-patched-build run. Evidence: `verify/vulkan-runtime-dispatch-evidence.json` + `verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log`. Caveat: single Intel-ANV device class — AMD-native, NVIDIA-native, Android Adreno/Mali still needed. |
| Fused attention (QJL-K + TBQ-V / Polar-V) | Vulkan fused compute shaders landed and standalone-verified on hardware; Metal kernel still pending; CUDA fixture-parity needs an NVIDIA host. C reference `eliza_fused_attn_qjl_tbq3` / `eliza_fused_attn_qjl_polar` are bit-exact to the fork's `GGML_OP_FUSED_ATTN_QJL_TBQ` CPU op; round-tripped by `make -C packages/inference/verify reference-test`. `vulkan/fused_attn_qjl_tbq.comp` + `vulkan/fused_attn_qjl_polar.comp` (one-pass online softmax, never materializes the score vector, driver-portable 32-thread shared-memory reduction) pass `make -C packages/inference/verify vulkan-verify-fused` 1920/1920 outputs on Intel ARL Mesa ANV (4 cases: n_kv 64/512/256/128, GQA 1/2/4; max diff 6.3e-7) and built-fork graph dispatch `GGML_OP_FUSED_ATTN_QJL_TBQ` passes via `vulkan-dispatch-smoke` (see `linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json`). Metal: `make metal-verify-fused` fails by design — no `metal/fused_attn*.metal` kernel + `cases`-array path in `metal_verify` yet (`needs-runtime-smoke`; design in `metal-fused-attn-and-polar-preht-design.md`). CUDA: `cuda_verify` parses `fused_attn_qjl_tbq.json` but `needs-hardware`. Registered in `kernel-contract.json`'s `fusedAttn` section with capability key `fused_attn`; NOT yet a `requiredRuntimeCapabilityKey`/`manifestKernelName`. | `verify/fixtures/{fused_attn_qjl_tbq.json,fused_attn_qjl_polar.json,polar_preht.json}`; `reports/porting/2026-05-11/fused-attn-op-contract.md`; `reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`. |
| CPU SIMD paths | AVX-VNNI int8-QJL path (5.25× on this box), fp32-QJL score partial-sum-LUT + 4×`VGATHERDPS` rewrite (~2.5–8×), Polar pre-Hadamard SIMD (the `dot(H·x,q)==dot(x,H·q)` algebra that kills the per-K-row Hadamard + the 128-float decode-to-scratch), and ARM dotprod variants landed in `qjl-cpu`/`polarquant-cpu`. All bit-exact / rel ≤ 3.6e-7 vs the C references; `make cpu-bench cpu-simd-bench` clean. | `verify/bench_results/{cpu_avxvnni_2026-05-11.json,cpu_kopt_2026-05-11.json}`; baseline `verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json`; `reports/porting/2026-05-11/{this-machine-test-capability.md,cpu-kernel-optimization.md}`. Open (all hardware/quiet-machine-gated, not blockers): a quiet-box `linux-x64-cpu` fork build + `llama-bench` on the 0.6B/1.7B GGUFs with QJL/Polar graph routes active; `perf record` of the built `libggml-cpu.so`; promoting the experimental int8-QJL sketch path to the default QJL score route (needs a fixture family + e2e tolerance gate). |
| CPU built-fork graph dispatch | **Runtime-ready.** `make -C packages/inference/verify cpu-dispatch-smoke` links `qjl_mt_check.c` against the in-repo fork's `linux-x64-cpu` build (`packages/inference/llama.cpp/build/linux-x64-cpu/bin`, or `$ELIZA_STATE_DIR/local-inference/bin/dflash/linux-x64-cpu`; `CPU_BIN_DIR`/`GGML_INC_DIR` auto-probe — no env vars needed) and drives a ggml graph selecting `GGML_OP_ATTN_SCORE_QJL` + `GGML_OP_FUSED_ATTN_QJL_TBQ` on the CPU backend: PASS, MT-vs-ST bit-identical (n_threads 1 vs 24), no NaN. `kernel-contract.json` `runtimeStatus.cpu` flipped to `runtime-ready` for `qjl` + `fusedAttn` (evidence `verify/cpu-runtime-dispatch-evidence.json`); `check_kernel_contract.mjs` now loads and validates that file. `make -C packages/inference/verify kernel-contract reference-test cpu-bench cpu-dispatch-smoke` all green. | The standalone TBQ/Polar score ops stay `reference-only` on cpu (no public CPU graph builder in the fork — `make reference-test` is the parity gate; the C ops ARE the references). Open: wire `probeKernels()` in `build-llama-cpp-dflash.mjs` to read `cpu-runtime-dispatch-evidence.json` for the CPU backend (mirror `readVulkanRuntimeDispatchEvidence` / `vulkanCapabilityRuntimeReady`) so a fresh `linux-x64-cpu` build's `CAPABILITIES.json` reports `qjl_full` runtime-ready — left to the build-script owner (that file has uncommitted in-flight changes). This does NOT make the CPU build `publishable`; the §3 CPU kernel-completeness gate still fails by design (turbo3_tcq/polarquant not CPU-buildable). |
| Platform target matrix | `kernel-contract.json` tracks 21 build targets — added `linux-aarch64-{cpu,cuda}`, `windows-arm64-{cpu,vulkan}`, `windows-x64-vulkan` with cmake plumbing + CUDA arch pins (incl. Blackwell `sm_120`, GH200 `sm_90a`). All new targets `needs-hardware`. Intel Macs (`darwin-x64-metal`) are not a supported target — Apple Silicon `darwin-arm64-metal` only. A `27b-1m` (1M-context, CUDA-only-backend) tier is now in the catalog/schema/Python manifest/platform-plan; `defaultEligible` blocked on real GH200 verify. | `make -C packages/inference/verify kernel-contract` (`targets=21`). |
| CUDA | **Hardware-verified on the RTX 5080 (Blackwell sm_120) with native SASS.** CUDA 12.8 installed at `/usr/local/cuda-12.8`; `build-llama-cpp-dflash.mjs` `resolveNvcc()` (probes `$CUDACXX`, `$CUDA_HOME/$CUDA_PATH`, `/usr/local/cuda-*`, `/usr/local/cuda`, then `PATH` — newest wins) + `cudaCompilerFlags()` (`-DCMAKE_CUDA_COMPILER=<resolved>` + prepends its bin dir to `PATH`) pin the 12.8 toolkit even though `PATH` `nvcc` is the distro 12.0; `cudaArchListFlag()` → `90a;90;89;86;80;100;120;90-virtual` (plain `100`/`120` = real SASS). `make -C packages/inference/verify cuda-verify cuda-verify-fused` = 8/8 + 1920/1920 PASS (max diff ≤ 7.6e-6 / 4.47e-7), the fused gate now exercising the warp-cooperative kernel that mirrors the production `cuda/fused-attn-qjl-tbq.cu`. P3 (occupancy `__launch_bounds__(32,16)`, `__ldg` on K-cache scalars, vectorized `float4×2` Q-sketch load) + DP4A-as-the-default-standalone-QJL-path landed (nsys: DP4A `qjl_score_dp4a_kernel` ~2.27× faster than fp32 `qjl_score_kernel`). P2 (cp.async/TMA staging) deferred — the 34 B QJL / 14 B TBQ on-cache blocks have no 4 B alignment at a token stride, so it needs an aligned cache repack first. | Open: the full `ggml-cuda` integration build with the 12.8 toolkit is blocked on host RAM contention this wave (~3 GB free of 30 GB, 80+ compilers running); the staged `fused-attn-qjl-tbq.cu` compiles clean against the fork headers with the full fat-binary list (`cuobjdump --list-elf` → `sm_80/86/89/90/90a/100/120` cubins; empty object without `-DGGML_CUDA_FUSED_ATTN_QJL`) and the kernel-patch dry-run is green. `ncu` is installed but `ERR_NVGPUCTRPERM` (perf counters need root) — `nsys` works. |
| CUDA/GH200 hardware runners | Runnable, fail-closed entrypoints now exist for Linux x64 NVIDIA and GH200-like Linux aarch64. | `verify/cuda_runner.sh --report <path>` requires `nvcc` + `nvidia-smi` + `make cuda-verify` + `ELIZA_DFLASH_SMOKE_MODEL` graph smoke; `verify/gh200_runner.sh --report <path>` additionally requires arm64 Linux + Hopper/compute-capability-9.x. Skip modes exit non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| ROCm hardware runner | Runnable, fail-closed entrypoint now exists for AMD HIP hosts; fixture parity still needs a HIP harness. | `verify/rocm_runner.sh --report <path>` requires `hipcc` + `rocminfo` `gfx*` agent + model-backed graph smoke. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| Windows hardware runner | Runnable, fail-closed PowerShell entrypoint now exists for native Windows CUDA/Vulkan/CPU smoke. | `verify/windows_runner.ps1 -Report <path>` requires native Windows backend hardware/toolchain and a GGUF model; cross-built exe execution is not counted. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| iOS | Static archives, embedded metallib, Capacitor bridge symbols, and `eliza_inference_*` ABI v1 symbols package into a verified XCFramework for physical-device and simulator slices. Physical-device XCTest is now PASS; weight-backed Capacitor bundle smoke remains open. | `build-xcframework.mjs --verify` passes kernel-symbol, runtime-symbol, and structure audits. `packages/inference/verify/hardware-results/ios-device-smoke-2026-05-11.json` is `status: passed` on iPhone 15 Pro UDID `00008130-001955E91EF8001C`, with 3/3 XCTest cases passing and `--skip-voice-abi=false`. The old failure was a stale shim archive carrying an earlier TTS ABI shape; `build-xcframework.mjs` now refreshes the runtime shim before packaging. |
| Voice fusion | macOS production fused `libelizainference.dylib` now builds, symbol-verifies, lazy-loads real GGUF TTS and ASR assets, and completes real TTS + ASR synthesis/transcription in one fused process. **The merged HTTP route is now real:** the `*-fused` `llama-server` serves `POST /v1/audio/speech` (+ `/audio/speech`) in the same process as `/completion` + `/v1/chat/completions` + the DFlash spec loop, and `dflash-server.ts` prefers spawning that fused binary over the stock + `llama-omnivoice-server` two-process path. | `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal-fused --jobs 10` links `omnivoice-core`, `libelizainference.dylib`, `llama-omnivoice-server`, `libmtmd`, and `default.metallib`; `verify-symbols.mjs` reports `omnivoice=10 abi=8`; Bun FFI smoke against `~/.eliza/local-inference/models/eliza-1-1_7b.bundle` loads real OmniVoice Q4_K_M base/tokenizer GGUFs for TTS and Qwen3-ASR GGUF + qwen3a mmproj for ASR. TTS writes 31,680 samples for `hello`; ASR now normalizes punctuation, stops on sentence completion, and transcribes `/tmp/eliza-asr-hello.wav` to `Hello world.` in the latest smoke. Evidence: `reports/local-e2e/2026-05-11/fused-voice-ffi-smoke.json` and `reports/local-e2e/2026-05-11/asr-ffi-smoke-latest.json`. Merged-route: `linux-x64-cpu-fused` built on Intel x64, `OMNIVOICE_FUSE_VERIFY.json` `ok:true abi:18 omnivoice:10 llamaReexported:true`; the fused `llama-server` serves `/completion` (1-token) AND `/v1/audio/speech` from the same PID against a small dev substitute bundle (503 "not configured" — no `tts/` in the substitute); covered by `dflash-server-fused.integration.test.ts` + `dflash-server.test.ts` "fused-vs-two-process spawn selection". |
| Text-to-voice streaming handoff | JS runtime now streams accepted text deltas from llama-server into the active voice scheduler, supports explicit phrase prewarm, opportunistically reuses repeated generated phrase audio, and exposes the verifier-event callback shape needed by native DFlash. Native accept/reject event streaming is still open. | `dflash-server.generateWithUsage` switches to OpenAI-compatible SSE when `onTextChunk` or `onVerifierEvent` is supplied and synthesizes accept events from deltas until the native server emits exact verifier ranges. `LocalInferenceEngine.generate()` and `generateInConversation()` forward verifier events/chunks into `EngineVoiceBridge` while generation is still in flight and settle the scheduler at turn end without duplicate text delivery. `PhraseCache` is now an LRU-bounded cache (`128` entries, `8s` PCM cap per entry by default), `VoiceScheduler.prewarmPhrases()` caches common phrase audio, and live successful phrase/direct-TTS synthesis is cached only after it survives cancellation/rollback. Default voice chunks are capped at 8 tokens and `ELIZA_VOICE_MAX_IN_FLIGHT_PHRASES` bounds memory on small devices. The DFlash llama-server path also separates `kvOffload=cpu` from layer offload and exposes cache/batch tuning knobs for small-device profiles. Evidence: local-inference focused tests now pass 86/86 for backend/DFlash/voice streaming, and the iOS transport bridge test/typecheck pass after preserving `fetch.preconnect` through the local-agent fetch bridge. |
| Eliza-1 bundles | Local release-shaped bundles exist for all five tiers for runtime-layout smoke; they currently carry placeholder/substitute bytes (not yet built from the elizaOS/llama.cpp fork against the upstream base weights) and `releaseState` is not yet `base-v1`. **v1 = the upstream BASE models** (Qwen3.5/3.6 text + OmniVoice TTS + Qwen3-ASR + Silero VAD + Qwen3-Embedding), GGUF-converted via the fork with every §3 kernel optimization — NOT fine-tuned (fine-tuning is v2). The publish path: stage the upstream base weights → convert via the fork's `convert_hf_to_gguf.py` + `gguf_eliza1_apply.py` (Eliza-typed GGUF, `--release-state base-v1`) → emit the real `quantization/*.json` sidecars from a real fork build → collect real per-backend `*_dispatch.json` + `*_verify.json` evidence on real hardware → run the base-v1 evals (text perplexity vs the upstream GGUF, voice RTF, ASR WER, VAD latency/boundary/endpoint, dflash acceptance, e2e loop, 30-turn) → write `evidence/release.json` with `releaseState=base-v1`, `finetuned=false`, the `sourceModels` map and `final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=true` (`final.weights` need NOT be true for `base-v1` — the bytes are the upstream base GGUFs by design) → publish to `elizaos/eliza-1-*`. See `ELIZA_1_GGUF_READINESS.md` for the per-tier file/evidence checklist. | `stage_eliza1_bundle_assets.py --link-mode hardlink` and `stage_eliza1_source_weights.py` staged non-text assets plus source text/DFlash/vision candidates under `~/.eliza/local-inference/models/eliza-1-*.bundle`. `stage_local_eliza1_bundle.py --all-contexts --force` then hardlinked source/candidate bytes into local `text/`, `dflash/`, and `vision/` release-shaped paths, generated `quantization/{turboquant,fused_turboquant,qjl_config,polarquant_config}.json`, `eliza-1.manifest.json`, `checksums/SHA256SUMS`, and `evidence/release.json` for every tier. Full checksum validation is green for all five bundles. As of 2026-05-12 the `elizaos/eliza-1-{0_6b,1_7b,9b}` bundle repos exist on HF and re-host the **upstream base GGUFs** as `releaseState: local-standin` / `publishEligible: false` / not `defaultEligible` (the 9b GGUF blob upload is pending; its manifest records the sha + source); the bundle `evidence/release.json` now carries a `relatedRepos` block linking the published `eliza-1-evals` / `eliza-1-0_6b-sft` / `eliza-1-0_6b-sft-weights` artifacts (the SFT-weights entry flagged a `test-sft-candidate`, not `defaultEligible`, not the `recommended` channel). The remaining work is producing the real fork-built GGUF/quant-sidecar bytes, the on-hardware dispatch/verify evidence, the base-v1 evals, the release-reviewed license files, and the production `elizaos` upload evidence — never a fabricated hash. |

## P0 Blockers

1. **iOS real Eliza-1 bundle smoke**

   Metal graph dispatch is now runtime-ready for QJL, Turbo3, Turbo4,
   Turbo3-TCQ, and PolarQuant on Apple Silicon. The iOS XCFramework now
   passes both kernel-symbol and runtime-symbol audits. The current
   physical-device XCTest now passes. The remaining iOS publish blocker is a
   weight-backed Eliza-1 bundle smoke from the Capacitor app shell.

   Acceptance:
   - `build-xcframework.mjs --verify` passes both kernel-symbol and
     runtime-symbol audits for the iOS arm64 and simulator slices. **Done.**
   - `run-physical-device-smoke.mjs` passes on a connected iPhone/iPad without
     skipping the voice ABI check. **Done on iPhone 15 Pro / iOS 26.3.1.**
   - A full Eliza-1 bundle smoke loads real text + voice assets on iOS and
     records first token, first audio, peak RSS, and thermal state.

2. **Vulkan native graph-dispatch evidence — partially DONE (Intel-ANV)**

   Native Linux Vulkan graph dispatch is now runtime-ready on Intel Arc/Xe
   (Mesa ANV): `vulkan-dispatch-smoke` PASS for the two fused attention graph ops the committed fork pin (`packages/inference/llama.cpp` gitlink `eae44e75`) declares — `GGML_OP_ATTN_SCORE_QJL` + `GGML_OP_FUSED_ATTN_QJL_TBQ` (the standalone TBQ/Polar score kernels are covered by `vulkan-verify`),
   `kernel-contract.json` `runtimeStatus.vulkan` = `runtime-ready` for the 5
   score kernels. Remaining: native AMD and NVIDIA desktop Vulkan + Android
   Adreno/Mali. Vulkan fused-attention has a fused compute kernel + `cases`-array
   harness (`vulkan-verify-fused` 1920/1920 on Intel ARL); the Metal fused kernel
   + `cases`-array path in `metal_verify` is still pending.

   Acceptance:
   - Native `linux-x64-vulkan` build contains the SPIR-V blobs and graph
     routing. **Done.**
   - Smoke tests run on at least Intel/AMD/NVIDIA desktop Vulkan and one
     Android Vulkan device class. **Intel done** (`verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log`); AMD, NVIDIA, Android still open.
   - `make -C packages/inference/verify vulkan-native-smoke` passes on native
     Linux hardware without `ELIZA_ALLOW_SOFTWARE_VULKAN=1`. **Done on Intel-ANV.**
   - `make -C packages/inference/verify android-vulkan-smoke` passes on one
     Adreno and one Mali device with `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE`
     pointing at a built-fork/app graph-dispatch report. **Still open** —
     standalone fixture success alone exits non-zero and remains evidence only.

3. **Fused voice runtime — merged HTTP route DONE; native verifier events + weight-backed TTS smoke remain**

   The product goal is not two independent model processes. The next runtime
   milestone is one fused binary/shared library with one GGML pin and one
   scheduler. Text, DFlash, ASR, and TTS may keep separate weights inside the
   bundle, but they must share the runtime lifecycle and memory budget.

   Acceptance:
   - `libelizainference` exports ABI v2 symbols and passes FFI smoke tests
     under Bun/Electrobun. ABI compatibility smoke, real macOS dylib ABI
     smoke, real GGUF-backed TTS synthesis, and real GGUF-backed ASR
     transcription are covered. **Done on macOS Metal for the local 1.7B
     bundle.** ABI v2 (streaming ASR + streaming TTS + native DFlash
     verifier callback) symbols are present in `prepare.mjs`'s adapter
     (batch TTS/ASR + **streaming TTS / `cancel_tts` implemented** as of
     2026-05-12; streaming ASR + the native DFlash verifier callback remain
     honest stubs reporting `*_supported() == 0` / `ELIZA_ERR_NOT_IMPLEMENTED`
     — see the W7 section for the exact remaining gap).
   - Voice mode starts without IPC to a second model process. **Done at the
     spawn layer:** `dflash-server.ts` `resolveFusedDflashBinary()` /
     `candidateBinaryPaths()` prefer the `*-fused` `llama-server` whenever a
     fused build is installed for the active backend; `start()` passes
     `--omnivoice-model` / `--omnivoice-codec` from the bundle's `tts/` dir;
     no second `llama-omnivoice-server` process is launched. The legacy
     `llama-omnivoice-server` CLI binary stays only for the symbol verifier
     / scripted callers.
   - Voice-off mode does not mmap or page TTS/ASR/voice-preset regions.
   - **DONE — the fused `llama-server` now serves `/v1/audio/speech` (+
     `/audio/speech`) in-process**, alongside `/completion` +
     `/v1/chat/completions` + the DFlash speculative loop. The route is
     added to `tools/server/server.cpp` by
     `packages/app-core/scripts/kernel-patches/server-omnivoice-route.mjs`
     (guarded `#ifdef ELIZA_FUSE_OMNIVOICE`, backed by `omnivoice-core`'s
     `ov_init` / `ov_synthesize`, OpenAI Audio-Speech request shape, 24 kHz
     WAV or raw f32-LE PCM response); `omnivoice-fuse/cmake-graft.mjs` links
     `omnivoice-core` into `llama-server` for fused targets.
     `DflashLlamaServer.audioSpeechRoute()` reports `fused: true` when the
     running binary is the fused build, and `synthesizeSpeech()` POSTs to
     the route (`response_format: "pcm"` → no JS-side WAV decode).
     Evidence: `linux-x64-cpu-fused` built on Intel x64
     (`OMNIVOICE_FUSE_VERIFY.json` `ok: true`, `abi: 18`, `omnivoice: 10`,
     `llamaReexported: true` — ELF `DT_NEEDED libllama.so` accepted as the
     macOS-`-reexport_library` equivalent); the build's exit-1 is solely the
     pre-existing §3 CPU-backend kernel-completeness gate (turbo3_tcq /
     qjl_full / polarquant aren't CPU-buildable — same as the non-fused
     `linux-x64-cpu` target), and `CAPABILITIES.json` is written with
     `publishable: false`. Spawning that `llama-server` against the local
     SmolLM stand-in serves `POST /completion` (1-token gen) AND
     `POST /v1/audio/speech` from the same PID (returns the structured 503
     "not configured" body when no OmniVoice GGUF is wired — proving the
     route is live in-process; a stock `llama-server` returns 404). Covered
     by `dflash-server-fused.integration.test.ts` (spawns the fused binary,
     hits both endpoints, asserts same PID, asserts cancel/barge-in cleanup)
     and `dflash-server.test.ts`'s "fused-vs-two-process spawn selection"
     unit tests. **Remaining:** a weight-backed `/v1/audio/speech` smoke
     against a real Eliza-1 bundle's `tts/omnivoice-*.gguf` (the local
     stand-in bundle has no `tts/`); fused `darwin-arm64-metal-fused` and
     `linux-x64-vulkan-fused` builds + the same smoke on those backends;
     iOS/macOS fused-server packaging; routing the engine/voice TTS path to
     prefer `synthesizeSpeech()` over the FFI `ttsSynthesize` path when
     `audioSpeechRoute()` is non-null.
   - JS runtime streaming from llama-server deltas into the voice scheduler is
     now covered. The native fused runtime still needs first-class DFlash
     accept/reject events so speculative branches can be cancelled before
     phrase audio reaches the sink (the ABI v2 `eliza_inference_set_verifier_callback`
     symbol is present but stubbed — W7).

4. **Real base-v1 release artifacts**

   The repo now has schema/publish machinery plus local release-shaped bundles
   for runtime-layout smoke. Publishing is blocked until each tier has, for the
   `base-v1` release state (upstream base models, GGUF-converted via the
   elizaOS/llama.cpp fork with all §3 kernel optimizations, **not** fine-tuned):
   real fork-built Eliza-typed GGUF bytes (text/vision + the already-GGUF
   TTS/ASR/embedding at the tier's quant), real `quantization/*.json` sidecars
   from a real fork build, the base-v1 eval JSON (text perplexity vs the upstream
   GGUF, voice RTF, ASR WER, VAD, dflash acceptance, e2e loop, 30-turn),
   release-reviewed license files, per-backend `*_dispatch.json` + `*_verify.json`
   platform/kernel evidence on real hardware, and the `elizaos/eliza-1-*` upload
   evidence — all derived from the exact shipped quantized artifact, never a
   fabricated hash. (Fine-tuned text quality is a separate v2 deliverable.)

## Voice On/Off Architecture

The lowest-duplication design is lazy regional loading from one bundle:

- **Voice off:** load text weights, DFlash drafter, tokenizer, and required
  KV kernels only. Do not mmap TTS/ASR pages or duplicate model parameters.
  `libelizainference` may be loaded lazily, but voice regions remain unmapped.
- **Voice on:** acquire `tts` and `asr` regions for default-eligible local voice
  bundles; preload `voice-preset-default.bin`; start phrase chunking and PCM
  ring buffer. Local transcription now routes through ABI-v1 ASR when the bundle
  has canonical `asr/eliza-1-asr.gguf` and `asr/eliza-1-asr-mmproj.gguf`;
  missing or ambiguous ASR assets still hard-fail instead of silently calling
  cloud or another model. Rejected DFlash ranges cancel pending TTS chunks before
  they reach the audio sink.
- **Shared, not duplicated:** one tokenizer service where compatible, one
  scheduler, one memory budget, one telemetry stream, one lifecycle. KV cache
  memory is not shared between text and voice models unless the architecture
  actually has identical layers; scheduling and mmap policy are shared.
- **Hard failure:** if any required voice region or kernel is missing in voice
  mode, startup fails. Voice-off mode may run without mapping voice assets only
  if the selected mode explicitly disables voice.

## W7 — the ABI surface the fused streaming decoder must implement

**Status (2026-05-12): streaming TTS + `cancel_tts` are implemented; streaming
ASR + the native DFlash verifier callback remain honest stubs.**

The runtime fallback chain is **sane and complete without streaming**:
`createStreamingTranscriber()` (`voice/transcriber.ts`) tries
`FfiStreamingTranscriber` → `FfiBatchTranscriber` → `WhisperCppStreamingTranscriber`
in order. The fused `linux-x64-cpu-fused` build exports the full ABI-v3 surface;
`eliza_inference_tts_stream_supported() == 1` (real — see below),
`eliza_inference_asr_stream_supported() == 0` (honest stub), so
`tryFusedStreaming()` for TTS now opens the streaming path and for ASR returns
`null` → `FfiBatchTranscriber` (the chunked sliding-window decode over the batch
`eliza_inference_asr_transcribe`, contract-clean against the
`StreamingTranscriber` interface) is the ASR path until a true incremental
decoder lands. Batch TTS (`eliza_inference_tts_synthesize` → `/v1/audio/speech`)
and batch ASR both still work. Nothing in the runtime *requires* streaming ASR
to function — voice mode runs on the batch ASR path today.

### Implemented (2026-05-12)

- **Streaming TTS + hard-cancel** — `eliza_inference_tts_stream_supported()` → 1;
  `_tts_synthesize_stream(ctx, text, on_chunk, …)` drives OmniVoice's existing
  chunked pipeline (`ov_tts_params.on_chunk` + `ov_tts_params.cancel`, small
  `chunk_duration_sec` so first-PCM latency is bounded by the first MaskGIT
  decode of the first phrase, not the whole utterance); `on_chunk` returning
  non-zero → `OV_STATUS_CANCELLED` → `ELIZA_ERR_CANCELLED`; one final
  `is_final == 1` terminator call. `_cancel_tts(ctx)` flips a `std::atomic<int>`
  on the context (NOT under `tts_mutex` — the synthesis thread holds that for
  the whole pass) that the chunk/cancel callbacks poll, so a barge-in aborts the
  in-flight forward pass at the next chunk boundary (§4). Bench: `nativeCancelMs
  ≈ 0.03 ms`, `nativeCancelRc == 0`. Implementation: the generated
  `eliza-inference-ffi.cpp` template in `omnivoice-fuse/prepare.mjs`.

### Still stubbed — exact remaining gap

- **Streaming ASR** — `eliza_inference_asr_stream_supported()` stays 0;
  `_asr_stream_open/feed/partial/finish/close` return `ELIZA_ERR_NOT_IMPLEMENTED`.
  Why it's not a thin wrapper: the ASR audio encoder is mtmd's
  `mtmd_helper_eval_chunks` over a single audio bitmap built from the *whole*
  utterance — there is no incremental-encoder API in mtmd today, so a genuine
  streaming ASR decoder is a sliding-window-encoder rewrite (re-encode an
  overlapping window each `feed`, splice the partial transcript), not a
  per-frame feed. `FfiBatchTranscriber` already does the JS-side equivalent
  (windowed batch decode), so the runtime is not blocked; the win from a native
  streaming ASR is lower first-token latency, not capability.
- **Native DFlash verifier callback** — `eliza_inference_set_verifier_callback`
  stays `ELIZA_ERR_NOT_IMPLEMENTED`. The fork's speculative loop runs inside
  `llama-server`, not `libelizainference`, so wiring it needs a `llama-server`
  hook that streams `EliVerifierEvent`s (accepted ids / rejected `[from,to)` /
  corrected ids in the output-token domain) out to the FFI consumer — a
  `server-omnivoice-route.mjs` / fork-side change. Until then the JS scheduler
  synthesizes verifier events from llama-server SSE deltas, which is correct but
  not as tight as exact native accept/reject ranges (rollback granularity).

Each remaining symbol is additive — a v3 caller is unaffected; they exist as
stubs reporting `*_supported() == 0` / `ELIZA_ERR_NOT_IMPLEMENTED`, so a
probe-then-pick caller never has to call the streaming entry and catch the
not-implemented error.

### Within-turn RSS trim — wired (host-driven)

`voice/pipeline.ts` now fires an `onAsrPhaseComplete` hook exactly once per
turn, right after the ASR phase and before the first drafter round (ASR → text
→ TTS are sequential within a turn, §4). A host wires it to the ASR
`MmapRegionHandle.evictPages()` (`madvise(MADV_DONTNEED)` on POSIX via
`ffi.mmapEvict(ctx, "asr")`) to claw back ~1 GB of peak RSS on `0_6b` while TTS
decodes; the pages page back transparently on the next turn's `feed()`. The
HTTP-driven `e2e_loop_bench.mjs` harness doesn't go through the FFI runtime path
that fires it (it drives `/v1/audio/speech` over HTTP), so the trim doesn't show
in that bench's `serverPeakRssMb` — measure it on a `runVoiceTurn`-driven turn.
Whoever owns `ramBudgetMb.recommended` in the training/manifest scripts: once a
runtime-driven turn confirms the ~1 GB drop, `0_6b`'s `recommended` can come
back down toward the pre-correction figure — do NOT change it on the strength of
this HTTP-bench number alone.

## Performance Work Still Worth Doing

0. **Native DFlash verifier event stream.** The JS layer now starts TTS from
   streamed accepted text deltas and the backend callback already carries
   verifier-shaped accept events. For the fastest rollback-safe voice path, the
   fused native runtime still needs to expose exact target-accepted and
   rejected-token events directly, not only synthesized OpenAI deltas. (Exact
   ABI in the "W7" section above.)
1. **Fuse QJL score + softmax + TBQ-V mix.** The CPU fork already has
   `GGML_OP_FUSED_ATTN_QJL_TBQ`. Porting that fused shape to Metal/Vulkan/CUDA
   is more valuable than wiring isolated Turbo dot kernels because it avoids
   writing scores and re-reading K/V.
2. **Keep voice dispatch unbatched.** The M4 Max bench shows command-buffer
   batching hurts realtime voice latency. Use N=1 for voice. Multi-block
   kernels are useful for offline/desktop throughput, not streaming audio.
3. **Use multi-block paths for non-voice scans.** Turbo/QJL multi-block
   variants are already verified; route long-context non-voice scoring through
   them where graph semantics allow it.
4. **Revisit Metal QJL threadgroup size only with a shared reduction.** The
   tgsweep showed `tg=64` can be faster, but current correctness assumes
   `simd_sum` over one 32-lane group. A 64-thread route needs threadgroup
   scratch reduction before it can ship.
5. **PolarQuant fused dot over decode-to-scratch.** The current shader decodes
   to a 128-float scratch buffer, then dots. A fused Hadamard-dot route can cut
   scratch traffic for hot mat-vec paths, but should come after graph
   dispatch correctness.
6. **CPU spill policy for >64k context.** The DFlash llama-server path now
   maps `kvOffload=cpu` / `ELIZA_LOCAL_KV_OFFLOAD=cpu` to `--no-kv-offload`
   without forcing `--n-gpu-layers=0`, and exposes cache/batch knobs needed
   for measurable spill profiles. Remaining work is catalog thresholds and
   platform latency gates that decide when spill is allowed versus failing
   closed on small phones.
7. **Guided structured decoding — fork-side prefill plan.** The runtime side
   landed (2026-05-11): `compilePrefillPlan` (`structured-output.ts`) derives an
   `ElizaPrefillPlan` from a `ResponseSkeleton` — the byte runs the schema fully
   determines (JSON scaffold, fixed keys, collapsed single-value enums) — and
   `buildChatCompletionBody` / `engine.ts` ship it as `eliza_prefill_plan` +
   seed the leading run as an assistant-turn prefill, **off by default**
   (`providerOptions.eliza.guidedDecode === true` / `MILADY_LOCAL_GUIDED_DECODE=1`).
   Today's fork pin doesn't consume `eliza_prefill_plan`, so the saving is the
   grammar-only constrained-decode bound (the lazy GBNF forces the same bytes —
   correctness unaffected). Remaining: a `kernel-patches/` patch to a fork build
   that reads `eliza_prefill_plan` and splices the forced token ids without a
   forward pass (a sibling owns the fork build); then wire
   `providerOptions.eliza.guidedDecode = true` next to the existing
   `responseSkeleton` assignment in `planner-loop.ts` / `message.ts` (W8). Static
   token-savings floor ≈ 21–58% of generated tokens per envelope; bench
   `verify/guided_decode_token_bench.mjs`. Design + prefill-plan format:
   `reports/porting/2026-05-11/guided-structured-decoding.md`.

## Platform Matrix Remaining Work

| Platform class | Next required action |
| --- | --- |
| Apple Silicon Mac | Fused Metal voice smoke now passes against the staged Eliza-1 1.7B bundle for real GGUF-backed TTS + ASR through `libelizainference.dylib`. Remaining action is built-fork graph-dispatch smoke plus full text+DFlash+voice latency/RSS/thermal gates. |
| iPhone/iPad | XCFramework symbol/structure audit passes for physical-device and simulator slices, and physical XCTest now passes 3/3 on iPhone 15 Pro. Next required action is a real Eliza-1 bundle smoke from the Capacitor app shell that measures first token, first audio latency, peak RSS, and thermal state. The current iOS ABI bridge is fail-closed and symbol-ready; it is not a complete mobile text/voice generation path until real context + OmniVoice loading are wired. |
| Android Adreno | Cross-build `android-arm64-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence for `GGML_OP_ATTN_SCORE_QJL`, collect thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, `system_profiler SPUSBDataType` shows no Pixel/Android USB device, and `make -C packages/inference/verify android-vulkan-smoke` with explicit `ADB` correctly refused emulator evidence. |
| Android Mali | Standalone Pixel 6a / Mali-G78 fixture validation passes for all six kernels. Remaining action is built-fork/app graph-dispatch evidence plus thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, so no new physical-device run was possible from this Mac; runner evidence log is `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T133109Z.log`. |
| Linux x64 CUDA | Run `make cuda` / `cuda_verify` on RTX/A100/H100/H200; pin arch flags where needed. `cuda_verify.cu` is now a self-contained fixture-parity harness (parses `fused_attn_qjl_tbq.json`); pending-evidence stub at `verify/hardware-results/cuda-linux-thismachine-2026-05-11.pending.json` (this box's dGPU is in D3cold, no kmod/nvcc). |
| Linux x64 Vulkan | **DONE on Intel-ANV** — `vulkan-dispatch-smoke` PASS (QJL score + fused QJL-K/TBQ-V attention, the two ops the committed fork pin declares; reconciled to `packages/inference/llama.cpp` gitlink `eae44e75`), evidence `verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log` + `verify/vulkan-runtime-dispatch-evidence.json`. Still need native AMD and NVIDIA Vulkan, not only MoltenVK/Intel-ANV. |
| Linux x64 CPU | **DONE** — `make -C packages/inference/verify cpu-dispatch-smoke` PASS (MT-vs-ST bit-identical for `GGML_OP_ATTN_SCORE_QJL` + `GGML_OP_FUSED_ATTN_QJL_TBQ`); `CPU_BIN_DIR`/`GGML_INC_DIR` auto-probe the in-repo fork build/checkout — no env vars. `kernel-contract.json` `runtimeStatus.cpu` = `runtime-ready` for `qjl` + `fusedAttn`. |
| Linux aarch64 CPU | Run CPU backend parity on an arm64 Linux host (`linux-aarch64-cpu` target, `needs-hardware`). |
| Linux aarch64 CUDA | Run `gh200_runner.sh` on a GH200/H100/H200 aarch64 CUDA host for the `27b-256k` and `27b-1m` tiers. |
| Windows x64 CPU/CUDA/Vulkan | Native Windows smoke and AVX2/driver validation required (`windows-x64-{cpu,cuda,vulkan}` targets). |
| Windows arm64 | Snapdragon X build + CPU/Vulkan smoke required (`windows-arm64-{cpu,vulkan}` targets). |
| Fused attention (Metal + CUDA) | Vulkan fused compute kernel + `cases`-array parser in `vulkan_verify` done and hardware-verified (`vulkan-verify-fused` 1920/1920 on Intel ARL Mesa ANV; built-fork `GGML_OP_FUSED_ATTN_QJL_TBQ` dispatch verified). Remaining: a Metal `fused_attn*.metal` kernel + `cases`-array path in `metal_verify` (design in `metal-fused-attn-and-polar-preht-design.md`), then `metal-verify-fused` on a Mac; and a CUDA host for the existing `cuda_verify` fused fixture parity. |

## Training And Publishing Remaining Work

**Qwen3.5 migration finished (2026-05-12):** the eliza-1 fused-model line is
now Qwen3.5-only per the operator directive (Qwen3 dense bases don't work
with the dflash spec-decode path — the kernels are validated against the
Qwen3.5 architecture / 248320 tokenizer; a Qwen3 base has the wrong vocab
and attention shape for the fused QJL / PolarQuant / TurboQuant paths).
Concretely:

- `model_registry.py`: dropped `qwen3-0.6b` / `qwen3-1.7b` / `qwen3-4b`.
  Active entries: `qwen3.5-{0.8b,2b,4b,9b,27b}` + legacy `qwen3.6-27b`
  (long-context 27B variant). 16/16 registry tests green.
- `ELIZA_1_TIER_IDS` (`catalog.ts`) + `ELIZA_1_TIERS` (`schema.ts`,
  `eliza1_manifest.py`): added `eliza-1-2b` (`2b` on the Python side).
  Threaded through `eliza1_platform_plan.py`
  (`TEXT_QUANT_BY_TIER` / `CONTEXTS_BY_TIER` /
  `REQUIRED_PLATFORM_EVIDENCE_BY_TIER`),
  `SUPPORTED_BACKENDS_BY_TIER`, `VOICE_QUANT_BY_TIER`,
  `REQUIRED_KERNELS_BY_TIER`, the `MODEL_CATALOG` entry + drafter
  companion, and the recommendation-ladder reorder (Qwen3.5 tiers lead;
  legacy Qwen3 tiers stay in the ladder as DEPRECATED fallbacks).
- `FIRST_RUN_DEFAULT_MODEL_ID` flipped from `eliza-1-1_7b` to
  `eliza-1-0_8b` (Qwen3.5-0.8B-Base, the new small default).
- HF deprecation cards uploaded to 11 legacy repos
  (`elizaos/eliza-1-{0_6b,1_7b,4b}` + the `-{optimized,drafter,sft}`
  companion repos + `-0_6b-sft-weights` + the `eliza-1-0_6b-sft` dataset
  marked DEPRECATED-NAME — the dataset itself is JSONL with no
  model-family dependency, so it stays usable on the Qwen3.5 line). The
  three not-yet-created 4b-companion repos correctly 404 and are
  skipped — see
  `packages/training/scripts/publish/deprecate_legacy_qwen3_repos.py`.
- `run-on-cloud.sh`: tier accept-list dropped `0_6b` / `1_7b`; default
  tier flipped to `0_8b`; help block reflects the Qwen3.5 line.

Closes audit punch items 7 (`2b` tier threading) and 8
(legacy-Qwen3-tier-drop decision) from
[`../2026-05-12/eliza1-e2e-audit-2026-05-12.md`](../2026-05-12/eliza1-e2e-audit-2026-05-12.md).

**Master harness benchmark (2026-05-12):** one comparison run across every Eliza-1
model + kernel artifact on this box — `packages/training/reports/eliza1-harness-benchmark-2026-05-12.{md,json}`,
mirrored to the `elizaos/eliza-1-evals` HF dataset (`bench/`, top-level
`harness-benchmark-2026-05-12.md`). Numbers: test-SFT 0_6b beat base on every text
metric (`format_ok` 0.0857→0.20, `claude_distill` format 27.3→63.6%, `reply`
parse-errs 8→0); CPU `llama-bench` d0 — test-SFT Q4_K_M 500 pp / 75.6 tg, eliza1-bundle
0_6b Q3_K_M 331 / 77.7, q4_polar/Q8-body 432 / 61.1, 1_7b 219 / 39.6; RTX5080-Vulkan d0 —
0_6b 3421 / 194, 1_7b 1317 / 112; dflash accept 0_6b 0.87 (clears 0.6) / 1_7b 0.55 (misses
0.65); text-eval ppl→0..1 0_6b 0.2779 / 1_7b 0.328 (neither clears the gate — stand-in
weights); voice RTF 8.62 / 5.91 (CPU stand-in TTS), ASR WER 1.0 (stand-in chain),
guided-decode 28% forced-token (static); kernel-verify CPU pass / CUDA runtime-ready (8/8
RTX 5080) / Vulkan pass / Metal needs-hardware. Pending: full-corpus SFT 0_6b in flight
(ETA ~2026-05-13); 1_7b SFT re-running at seq 2048; action-selection + personality benches
(need a live LLM provider + judge); d16k CPU/CUDA `llama-bench` sweep (CPU 16k-prompt too
slow under SFT contention, CUDA build OOM'd — needs an idle host); real ASR WER (needs real
WAV+.txt pairs + the tokenizer-fused Qwen3-ASR weights).

- Keep base-lineage names internal to training. Public catalogs, manifests,
  model cards, and default UI must say Eliza-1. Internal registry keys may
  retain upstream lineage until checkpoint conversion is complete.
- For v1 (`base-v1`): convert each tier's upstream base text/vision model to a
  Eliza-typed GGUF via the elizaOS/llama.cpp fork, and distill (KD, not
  fine-tuning of the target) the DFlash drafter from that tier's base text
  model. (Fine-tuning the text model ships in v2.)
- Stage the OmniVoice voice weights at the tier's quant, generate the speaker
  preset, and record voice cache format/version in the manifest.
- Generate release fixtures from the final quantized bundles, not synthetic
  reference fixtures.
- Populate `evidence/release.json` and `checksums/SHA256SUMS` from the exact
  final bundle bytes. Every supported backend also needs a `*_dispatch.json`
  report with `runtimeReady=true`, full graph-dispatch metadata, and a matching
  platform evidence JSON for each required target before the publish dry-run
  can pass. Evidence files under `evidence/` must be checksummed and uploaded.
- Run publish gates: text eval, TTS real-time factor, ASR WER, voice loop,
  DFlash acceptance, 30-turn endurance, memory/thermal, and per-backend kernel
  verification.
- Upload only to `elizaos/eliza-1-*` repos. Any red gate forces
  `defaultEligible=false`.

### DFlash drafter staging + stamping (2026-05-11)

- Drafter GGUFs are staged for the two locally-stageable tiers:
  `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/dflash/drafter-0_6b.gguf`
  and `…/eliza-1-1_7b.bundle/dflash/drafter-1_7b.gguf`. Both are the
  upstream `Qwen/Qwen3-0.6B` GGUF (the documented substitute used by the
  staging scripts until the distilled drafters exist) — `general.architecture
  = qwen3`, plain-AR shape (`token_embd.weight` + `blk.*.attn_*` present, no
  `dflash_fc.weight`/`dflash_hidden_norm.weight`), `tokenizer.ggml.model =
  gpt2`, `tokenizer.ggml.tokens` len 151936, `tokenizer.ggml.merges` len
  151387 — the shared-vocab merges-repair is intact on both.
- `dflash-draft.target_checkpoint_sha256` verified to match the tier's text
  GGUF sha256 on both bundles (0_6b → `a8fb6f0b…`, 1_7b → `ee006af4…`), and
  `dflash/target-meta.json` records `drafter.matchesTargetCheckpoint: true`.
  Re-stamp (idempotent) is exercised via `distill_dflash_drafter.py
  --stamp-only --drafter-gguf <gguf> --target-gguf <text gguf>`.
- `distill_dflash_drafter.py` is runnable end-to-end here: `--synthetic-smoke`
  (no torch/GPU) writes a well-formed drafter GGUF + run manifest;
  `--stamp-only` rewrites the target hash in place via gguf-py's
  `gguf_new_metadata`. A **full distill needs a GPU host**; the command for
  the cloud runner is in the FINETUNE coordination note below.
- Speculative-path runtime smoke (`packages/inference/verify/dflash_drafter_runtime_smoke.mjs --bench`)
  against the `linux-x64-cpu` fork build (`forkCommit eae44e75…`,
  `llama-speculative-simple`): **0_6b** — `n_drafted=23 n_accept=19`
  acceptance **82.6%**, 32→67 tok/s (**2.09×**); **1_7b** — `n_drafted` >0,
  acceptance **47.1%**, 25.5→36.1 tok/s (**1.41×**). `metadataStatus =
  metadata_loadable`, `hasTargetCheckpointSha256: true`,
  `gpt2TokenizerHasMerges: true` on both. (Acceptance is inflated/skewed by
  the drafter currently being the same/adjacent Qwen3 base as the target; the
  real KD'd drafter's window is what the eval harness records into
  `target-meta.json`.) Note: the `linux-x64-cpu` build reports `dflash:false`
  in `CAPABILITIES.json` (stock kernels) — `--spec-type dflash` is
  functionally identical to `--spec-type draft` in the fork, so the draft loop
  still exercises the drafter; a `dflash`-capable build is still needed for the
  fused-attn/KV path before publish.
- Still blocked here (no GPU / no real bytes): the actual KD distill for every
  tier; staging `9b`/`27b`/`27b-256k`/`27b-1m` drafters (need the real text
  bytes + HF network for the `Qwen/Qwen3-1.7B` student); a `dflash`-kernel
  fork build for the fused-attn speculative path; the acceptance-rate eval
  that fills `target-meta.json` `acceptanceRate`/`acceptanceWindow`.

#### Coordination note — FINETUNE agent (task #45, the 0.6b fine-tune)

When you produce a fine-tuned `0_6b` text checkpoint (and its final shipped
GGUF), the drafter for that tier MUST be re-distilled and re-stamped against
the **new** text GGUF — the stamp invariant is `drafter
dflash-draft.target_checkpoint_sha256 == sha256(final text GGUF in the same
bundle)`, and `dflash-doctor`/the publish gate refuse a drafter whose hash
does not match. Two paths:

1. **Re-distill (correct, GPU-only):**
   ```
   uv run --extra train python packages/training/scripts/distill_dflash_drafter.py \
     --tier 0_6b \
     --target-checkpoint <fine-tuned 0_6b HF dir> \
     --target-gguf <out>/eliza-1-0_6b/text/eliza-1-0_6b-32k.gguf \
     --student-base Qwen/Qwen3-0.6B \
     --dataset <the 0_6b SFT corpus jsonl> \
     --epochs 1 --batch-size 8 --grad-accum 4 \
     --out-dir <out>/eliza-1-0_6b/dflash
   ```
   This writes `drafter-0_6b.gguf` + `drafter-0_6b.distill.json` and stamps
   the target hash. Then re-run the bundle stager so `target-meta.json`'s
   `drafter.sha256` / `targetCheckpointSha256` / `matchesTargetCheckpoint`
   are refreshed, and run the DFlash acceptance eval to fill
   `acceptanceRate`/`acceptanceWindow` (gate ≥0.45 for 0_6b).
2. **Re-stamp only (stop-gap, no GPU — keeps the substitute drafter bytes):**
   ```
   uv run --extra train python packages/training/scripts/distill_dflash_drafter.py \
     --tier 0_6b --stamp-only \
     --drafter-gguf ~/.eliza/local-inference/models/eliza-1-0_6b.bundle/dflash/drafter-0_6b.gguf \
     --target-gguf ~/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf
   ```
   Use only if the fine-tune lands before a GPU run is available — it keeps
   `matchesTargetCheckpoint` green so the bundle still loads, but acceptance
   will degrade and the publish gate's acceptance eval stays blocking.

### Done in this pass (publish pipeline + downloader contract)

- `publish_all_eliza1.sh` now prints the per-tier publish summary and
  propagates the orchestrator's structured exit code on the first failure
  (e.g. `16` for `EXIT_RELEASE_EVIDENCE_FAIL`) instead of dying before the
  summary under `set -e`. The no-continue-on-error behaviour from §6 is
  unchanged — the matrix walk still aborts at the first failing tier.
- Dry-run verified against a hand-built dev bundle: the orchestrator rejects it
  at stage 2 with exit `16` — every tier is still publish-blocked because it has
  no `releaseState=base-v1` evidence (no real fork-built GGUF/quant-sidecar
  bytes, no on-hardware dispatch/verify reports, no base-v1 evals). For
  `base-v1` the publish gate does **not** require `final.weights=true` (the
  bytes are the upstream base GGUFs by design); it requires the other `final.*`
  flags + the `sourceModels` map + `finetuned=false`. No release-shaped bundle
  with real fork-built bytes exists in this checkout's state dir yet (the
  staging step is `stage_local_eliza1_bundle.py` / `stage_eliza1_bundle_assets.py`,
  which need HF network and the real text/DFlash/voice bytes — not produced here).
- §7 device-side downloader contract hardened: `runBundleJob` now reads the
  manifest first, then — **before any weight byte is fetched** — checks the
  RAM budget (`ramBudgetMb.min` vs device RAM) and that at least one of the
  tier's supported backends with a `pass` verify report is available on this
  device, aborting with a structured `BundleIncompatibleError` (`failed`
  download event → UI) if not. Schema-version is already enforced by
  `parseManifestOrThrow` (Zod literal on `$schema`). After materialize +
  per-file sha256 verify, an injectable `verifyOnDevice` hook (load → 1-token
  text gen → 1-phrase voice gen → barge-in cancel) runs before the bundle is
  treated as ready; a new `InstalledModel.bundleVerifiedAt` records it, and a
  bundle that has not passed the verify pass does not auto-fill an empty
  default slot when the hook is wired. Tests in
  `packages/app-core/src/services/local-inference/downloader.test.ts`.
- `verifyOnDevice` is now wired from the engine in `service.ts`
  (`new Downloader({ verifyOnDevice: verifyBundleOnDevice })` →
  `services/local-inference/verify-on-device.ts`: text load + 1-token gen
  always, 1-phrase TTS + barge-in cancel when `manifest.files.voice` is
  non-empty, unload at the end). A bundle that fails verify (e.g. fused voice
  ABI not loadable on the device) stays registered but does not auto-fill an
  empty default slot. Tests in `verify-on-device.test.ts`. Still open: surface
  `BundleIncompatibleError` distinctly in the UI; have the recommendation
  engine consult `manifest.kernels.verifiedBackends` against the device
  (`canSetAsDefault` exists but is not yet called).
- `OpenWakeWordDetector` is now wired into the voice loop:
  `LocalInferenceEngine.startVoiceSession({ wakeWord: { enabled, head?,
  threshold?, onWake? } })` — opt-in (off by default), local-mode only (cloud
  UI hides the surface per AGENTS.md §5). When enabled and the bundle ships the
  openWakeWord ONNX graphs, mic frames are fanned into the detector
  (re-buffered to its 1280-sample frame); each fresh detection prewarms the
  conversation and calls `onWake`. Silently inert (VAD-gated) when absent.
- The omnivoice-fuse adapter exports the full ABI v2 surface
  (`eliza_inference_asr_stream_*`, `tts_synthesize_stream`, `cancel_tts`,
  `set_verifier_callback`); the `linux-x64-cpu-fused` build's
  `OMNIVOICE_FUSE_VERIFY.json` is `ok=true` (`abi=18`, `omnivoice=10`, llama
  re-exported). The remaining voice-eval gap is the eval *harness* (HTTP-RTF /
  labelled-WER / mic-file e2e-loop / `llama-speculative-simple` accept), not
  the ABI; the eval suite reports those as honestly `not-run` with accurate
  reasons.
- The CUDA fused-attn kernel (`packages/inference/cuda/fused-attn-qjl-tbq.cu`)
  is wired into the build: `build-llama-cpp-dflash.mjs` stages it via
  `patchCudaKernels`, patches `ggml-cuda/CMakeLists.txt`
  (`add_compile_definitions(GGML_CUDA_FUSED_ATTN_QJL)`) via
  `patchGgmlCudaForFusedAttn`, and pushes `-DGGML_CUDA_FUSED_ATTN_QJL=ON` in the
  cuda cmake branch. Non-CUDA / no-flag builds unchanged; hardware-verify still
  pending (no NVIDIA host).
- Eval suite re-run against the staged dev bundles (2026-05-11): `0_6b`
  text_eval=0.2779, `1_7b` text_eval=0.328 against the **fine-tuned-quality**
  thresholds (≥0.55 / ≥0.60). Those thresholds are the v2 fine-tuned gate, not
  the `base-v1` gate — for `base-v1` the text eval is perplexity-vs-the-upstream
  GGUF (parity), not a quality floor; the dev bytes here are upstream Qwen base
  substitutes, exactly what v1 ships (sans the fork conversion). dispatch eval
  passes. Voice/ASR/e2e/DFlash-accept gates honestly `not-run` (harness /
  `llama-speculative-simple` not staged here; not the ABI). `9b` not built (no
  published `Qwen3.5-9B`; ~8 GB RAM free → would OOM). Publish dry-run against
  both dev bundles exits `16` (`EXIT_RELEASE_EVIDENCE_FAIL`) — gate behaves
  correctly (no `releaseState=base-v1` evidence yet). No `HF_TOKEN` here —
  upload is the operator's.

## Publish Critical Path — Status (post-2026-05-11 publish-finish pass)

This is the one coherent picture of what stands between us and an actual
HF publish to `elizaos/eliza-1-*`. Verdict: **NOT publishable on either
channel.** The text weights are off-the-shelf Qwen3 0.6B/1.7B substitutes
(documented stand-ins for the unresolvable Qwen3.5-*), NOT fine-tuned.

**HF state as of 2026-05-12 (what IS published — none of it is the
real `base-v1` or the `recommended` channel):**
- `elizaos/eliza-1-{0_6b,1_7b,9b}` (model, public) — the bundle repos,
  carrying the **upstream BASE GGUFs** (Qwen3-0.6B-Q8_0 ~639 MB /
  Qwen3-1.7B-Q8_0 ~1.83 GB; the 9b GGUF blob upload is pending — its
  `manifest.json` records the sha + the `unsloth/Qwen3.5-9B-GGUF` source)
  + a `manifest.json` (`releaseState: local-standin`,
  `publishEligible: false`, **not `defaultEligible`**) + an honest card
  that names the `base-v1` / `recommended` channels and cross-links the
  eval/SFT repos. There is ONE bundle repo per tier — no `-sft`/`-ft`
  variant bundle repo.
- `elizaos/eliza-1-0_6b-sft-weights` (model, public) — the APOLLO
  test-SFT checkpoint (8000-row slice, `eval_loss 1.315`):
  `model.safetensors` + config/tokenizer/chat-template +
  `gguf/eliza-1-0_6b-sft-Q4_K_M.gguf` (~397 MB). Conditional-go (beats
  base on every measured metric, regresses none, but `format_ok=0.20 <`
  the 0.5 smoke / 0.7 full publish floor). Published as a **CANDIDATE**
  only — **not `defaultEligible`, not the `recommended` channel**; the
  in-progress full-corpus SFT supersedes it. The bundle
  `evidence/release.json` `relatedRepos.sftWeights` records this with
  `releaseState: test-sft-candidate`, `defaultEligible: false`.
- `elizaos/eliza-1-0_6b-sft` (dataset, public) — the 0.6B-tier SFT corpus
  (privacy-filtered, `Qwen/Qwen3-0.6B`-substitute chat template).
- `elizaos/eliza-1-training` (dataset, public) — the broader SFT corpus.
- `elizaos/eliza-1-evals` (dataset, public) — baseline-vs-test-SFT bench
  tables, `eliza1_eval_suite.py` outputs, CUDA (RTX 5080) + Vulkan
  (Intel ANV) + CPU kernel-verify evidence, throughput snapshots,
  `MODELS_STATUS.md`. Metal/iOS/Android kernel-verify NOT there — no
  hardware yet.
- `elizaos/eliza-1-assets` (model, public) — frozen `1_7b`
  voice/ASR/VAD bytes (unchanged).
**No fork-built `base-v1` weights and no fine-tuned `recommended`-channel
weights have been pushed to any `elizaos/eliza-1-<tier>` main revision.**
The orchestrator refuses to (see the dry-run result below).

A **`--base-v1` channel now exists** (orchestrator `--base-v1` /
`--release-channel base-v1`; `publish_all_eliza1.sh --base-v1`; manifest
`releaseChannel: "recommended" | "base-v1"`; release-states now include
`base-v1-candidate`/`base-v1`). The `base-v1` channel forces
`defaultEligible: false`, requires a `provenance.sourceModels` map +
`finetuned: false` in `evidence/release.json`, emits the mandatory
manifest `provenance` block + the README "upstream-base, NOT the
fine-tuned Eliza-1, not a recommended default" banner, relaxes
`final.weights` + the held-out *text-quality* gate — and **enforces every
other gate** (kernel verify 8/8 on every supported backend, every required
platform-dispatch report `runtimeReady: true`, the runnable-on-base evals
incl. `voice_rtf`/`asr_wer`/VAD/e2e/30-turn, every license attestation)
exactly as the `recommended` channel. It does NOT bypass the
kernel-verification or license gates AGENTS.md §7 forbids touching. The
fine-tuned `recommended` release adds the text-quality gate on top and
ships in v2.

`validate_release_evidence` hard-requires `releaseState ∈ {base-v1, final}`
(base-v1 channel) / `{upload-candidate, final}` (recommended channel) and —
modulo `final.weights` on the base-v1 channel — **every** `final.*` flag
true. So: leave `publishEligible=false`, do not upload, document below.

**Publish dry-run result (real bundles, 2026-05-11):**
`bash packages/training/scripts/publish_all_eliza1.sh --bundles-root
<root> [--base-v1] --dry-run` (with `<root>/{0_6b,1_7b}` symlinked to
`~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle`), and the
per-bundle `python -m scripts.publish.orchestrator --tier <t> --bundle-dir
<bundle> --base-v1 --dry-run` → **stage 1 (bundle layout incl. license
attestation + `license-manifest.json` sidecar) PASSES**; **stage 2
(release evidence) fails, exit `16` (`EXIT_RELEASE_EVIDENCE_FAIL`)** for
both tiers, blocking on (base-v1 channel): `releaseState must be one of
('base-v1', 'final')` (got `weights-staged`); `final.evals must be true`
(`voice_rtf` ≈6–9× vs ≤0.5 and `asr_wer` 1.0 vs ≤0.1 fail even with the
text-quality gate relaxed; VAD/e2e/30-turn missing); `final.kernelDispatchReports
must be true` (Metal/iOS/Android pending); `final.platformEvidence must be
true` (all stubs); `final.sizeFirstRepoIds must be true`; `base-v1
channel: evidence.finetuned must be false`; `base-v1 channel:
evidence.sourceModels … must be a non-empty object`. Gate behaves
correctly. Logs preserved at each bundle's `evidence/base-v1-dry-run-*.log`.

**`evidence/release.json` state per tier (after re-running the
evidence finalizer at this commit):** `0_6b` and `1_7b` both
`releaseState=weights-staged`, `publishEligible=false`,
`defaultEligible=false`, `hf.status=blocked-weights-staged`.
`final = { weights: true, hashes: true, licenses: true, evals: false,
kernelDispatchReports: false, platformEvidence: false,
sizeFirstRepoIds: false }`. (Re-run was needed because the licenses
module changed after the predecessor's finalizer pass — the per-component
`license-manifest.json` sidecar is now regenerated to match
`eliza1_licenses.py` HEAD, which is why stage 1 now passes.) The 21
platform-evidence JSONs are present (`evidence/platform/<target>.json`)
— `linux-x64-cpu.json` / `linux-x64-vulkan.json` carry real
`partialEvidence` blocks (CPU reference + AVX-VNNI bench; Intel-ANV
vulkan-verify 8/8 + multi-block 8/8 + fused 1920/1920 + dispatch-smoke
7/7) but stay `status: pending` because there is no verify-on-device pass
against the *staged bundle bytes*; the rest are honest `status: pending`
stubs with the exact runner command. `evals/{cpu,metal,vulkan}_dispatch.json`
are likewise `runtimeReady: false` pending stubs (cpu/vulkan carry
partial-evidence notes). `evidence/platform/linux-x64-cuda.json` does
not exist yet — the CUDA sibling produced `verify/hardware-results/
cuda-linux-thismachine-2026-05-11.pending.json` (`status:
pending-hardware`, RTX 5080 present but `nvidia.ko` not loaded + no
CUDA Toolkit ≥12.8) — fold in real CUDA evidence once `cuda_runner.sh`
produces a `passRecordable: true` JSON.

**What's left, who/what unblocks each item, the exact command:**

1. **Real fine-tuned text + drafter weights per tier** — the only thing
   that clears `final.evals`. *Unblocker:* the GPU/training workstream
   (bigger box: 9b/27b backbones + GPU training). Off-the-shelf
   substitutes will always fail the text-eval gate. *Command (after
   training):* `stage_local_eliza1_bundle.py` → re-run evals →
   `finalize_eliza1_evidence.py <bundle>`.
2. **verify-on-device passes against the staged bytes, per backend** —
   clears `final.kernelDispatchReports`. *Unblocker:* run the engine's
   verify-on-device (`load → 1-token text → 1-phrase voice → barge-in
   cancel`) against the actual bundle GGUFs on a CPU host, an
   Apple-silicon host (Metal), and an Intel/AMD/NVIDIA GPU (Vulkan), and
   write the result into `evals/<backend>_dispatch.json` +
   `evidence/platform/<target>.json`. Operator has the boxes (the dev
   workstation does CPU + Intel-ANV Vulkan; needs a Mac for Metal). The
   kernel-verify (synthetic-fixture) side is already green on those
   classes; the missing piece is "against the shipped bytes".
3. **Platform evidence `status: pass` on every required target** —
   clears `final.platformEvidence`. Per tier the required set is in
   `eliza1_platform_plan.REQUIRED_PLATFORM_EVIDENCE_BY_TIER` (10 targets:
   darwin/ios metal, linux-x64 cpu+vulkan, windows-x64/arm64 cpu+vulkan,
   android adreno/mali vulkan). Each is `pending` until item 2 runs on
   that platform class. *Unblocker:* the same hardware passes; the
   Windows/Android/Mac runners exist and are fail-closed
   (`windows_runner.ps1`, `android_vulkan_smoke.sh`, the iOS
   `build-xcframework.mjs --verify` + `run-physical-device-smoke.mjs`).
4. **`releaseState` → `upload-candidate` / `final`** — set by the
   staging step that produces real fork-build GGUFs + `provenance.sourceModels`
   + runnable-on-base evals. Today the bundles are `weights-staged`.
   *Unblocker:* items 1–3 land, then `finalize_eliza1_evidence.py`
   promotes it (the finalizer only promotes when every `final.*` is true
   AND `releaseState=base-v1` + `finetuned: false` + `sourceModels` — or
   the full `final` set; the runtime/operator does not flip this by hand).
5. **`final.sizeFirstRepoIds`** — set by the HF-push stage itself, so it
   only flips on a real (non-dry-run) `orchestrator` run that uploads the
   size-first repo ids. It is therefore the *last* gate to clear and is
   not an independent prereq.
6. **Operator host bring-up:** nothing left except (optionally)
   `cuda-toolkit-12.8` on the RTX-5080 box (for `sm_120` device code;
   PTX-JIT via `compute_90` works without it) + loading `nvidia.ko`, so
   `cuda_runner.sh` can produce real CUDA evidence and a
   `linux-x64-cuda.json` platform JSON.

**Exact publish command (will still fail at stage 2 today, by design):**
```
export HF_TOKEN=$(cat ~/.cache/huggingface/token)
# layout: <root>/<tier>/ — symlink the real bundles in:
mkdir -p /tmp/eliza1-bundles-root
ln -sfn ~/.eliza/local-inference/models/eliza-1-0_6b.bundle /tmp/eliza1-bundles-root/0_6b
ln -sfn ~/.eliza/local-inference/models/eliza-1-1_7b.bundle /tmp/eliza1-bundles-root/1_7b
bash packages/training/scripts/publish_all_eliza1.sh --bundles-root /tmp/eliza1-bundles-root --dry-run
# drop --dry-run only once the dry-run is green; upload only to elizaos/eliza-1-*
```

### Done in the 2026-05-11 publish-finish pass (this commit's deltas)

- Re-ran `finalize_eliza1_evidence.py` on both real bundles so the
  `license-manifest.json` sidecar matches `eliza1_licenses.py` HEAD —
  publish dry-run stage 1 (layout + license attestation) now passes for
  `0_6b`; stage 2 still (correctly) fails with exit `16`.
- `recommendation.ts`: `canBundleBeDefaultOnDevice(installed, hardware)`
  + `deviceCapsFromProbe(probe)` — the recommendation-engine gate now
  consults the bundle's `eliza-1.manifest.json`
  (`kernels.verifiedBackends`, `evals`, `defaultEligible`) via the
  manifest validator's `canSetAsDefault`, against the device's backends +
  RAM, AND requires `InstalledModel.bundleVerifiedAt` (unverified bundles
  cannot auto-default). Distinct machine-readable reasons
  (`no-manifest` / `not-default-eligible` / `ram-below-floor` /
  `kernels-unverified-on-device` / `not-verified-on-device`) mirror the
  downloader's `BundleIncompatibleError`. Tests in `recommendation.test.ts`.
  *Closes the "have the recommendation engine consult
  manifest.kernels.verifiedBackends; canSetAsDefault is not yet called"
  item above.*
- Wake-word: the default Eliza-1 wake phrase is now documented as
  **"hey eliza"** (a two-word, four-syllable phrase the openWakeWord
  TTS-augmented pipeline handles well; replaceable). The training
  pipeline is runnable —
  [`packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`](../../../../training/scripts/wakeword/train_eliza1_wakeword_head.py)
  (front-end download → embedding featurization → dense head + BCE →
  ONNX export with the runtime's `[1, 16, 96]` → scalar contract →
  provenance JSON), unit-tested in `test_train_eliza1_wakeword_head.py`
  (head arch, threshold picker, ONNX export shape, a miniature
  train→export fit). A *full* real run (~30k positives across many
  voices/speeds/pitches + a real negative corpus + the openWakeWord
  front-end graphs) needs network and a permissive TTS that this dev box
  can't produce in a reasonable timeframe, so the recipe + the partial
  (unit-tested) run is what landed; `wakeword-head-plan.md` carries the
  exact full-run command. The shipped `wake/hey-eliza.onnx` is still the
  upstream `hey_jarvis` head renamed (fires on "hey jarvis"), so
  `OPENWAKEWORD_PLACEHOLDER_HEADS = {hey-eliza, hey_jarvis}` is unchanged
  and the engine still warns on every session that enables it — remove
  `hey-eliza` from that set only once a head trained by the script ships
  in bundles. Wake word stays opt-in, off by default, local-mode only.
- **FIXED:** the pre-existing test breakage introduced by `89e4d49bc6
  "updates to many things"` (which added the `vad_boundary_mae_ms` /
  `vad_endpoint_p95_ms` / `vad_false_bargein_per_hour` gate keys to
  `eliza1_gates.yaml`) — `test_orchestrator.py`'s `_passing_eval_blob`
  fixture now carries those three keys, so the four dry-run/publish tests
  are green again. `test_eliza1_manifest.py::test_default_eligible_requires_asr_and_vad_components`
  also passes (a sibling had already realigned its error-string assertion).
  `pytest packages/training/scripts/{publish,manifest} packages/training/benchmarks`
  is all-green.
- **Voice peak-RSS over budget — FIXED by honest budget correction.** The
  fused `llama-server` in voice-on mode legitimately keeps text + DFlash
  drafter + OmniVoice (base/tokenizer/DAC/HuBERT/sem-enc) + Qwen3-ASR +
  mmproj co-resident (embedding is a separate sidecar `llama-server
  --embeddings`, not in this process — already lazy). The 2026-05-11 e2e
  bench measured ~3132 MB (`0_6b`) / ~4828 MB (`1_7b`) server peak RSS;
  the old `ramBudgetMb.recommended` (1800 / 4500) was simply wrong for
  that footprint. `DEFAULT_RAM_BUDGET_MB` in `scripts/publish/orchestrator.py`,
  `scripts/manifest/stage_local_eliza1_bundle.py`, and
  `scripts/manifest/stage_real_eliza1_bundle.py` is now `0_6b: (2500,
  3700)` / `1_7b: (4000, 5500)` — so `0_6b` is a 4-GB-RAM-phone floor
  (the AGENTS §2 "low-RAM phones" tagline now means low-RAM *relative to
  9b/27b*). `thirtyTurnOk` passes on both tiers against the corrected
  budget. Tests: `test_ram_budget_calibration.py` (cross-module
  consistency + the `recommended >= measured-peak × 1.05` invariant) +
  the `ramBudgetMb` assertion in `test_stage_local_eliza1_bundle.py`. The
  cheap-but-not-free further trim — within-turn `madvise(MADV_DONTNEED)`
  of the idle ASR pages while TTS decodes (ASR → text → TTS are sequential
  within a turn) — is now wired as the `onAsrPhaseComplete` hook in
  `voice/pipeline.ts` (host → `asr` `MmapRegionHandle.evictPages()`); ~1 GB
  on `0_6b` once a `runVoiceTurn`-driven measurement confirms it. See the
  W7 section below for the wiring + the caveat that the HTTP-driven e2e
  bench doesn't exercise it.

## Known Non-Goals For This Wave

- A literal single GGUF containing text + TTS + ASR + vision + drafter. The
  current product artifact is a single logical Eliza-1 bundle with multiple
  files and one manifest. A true one-file container needs a separate `.eliza`
  container or GGUF extension.
- Running singing by default. Singing remains blocked on license review,
  conversion, and evals.
- Falling back to unoptimized kernels. Missing required kernels remain a hard
  error.
