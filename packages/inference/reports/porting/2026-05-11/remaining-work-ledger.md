# Eliza-1 Local Inference Remaining-Work Ledger - 2026-05-11

This ledger is the source-of-truth gap list after the Metal QJL graph-dispatch
smoke pass. It separates three states that previous reports occasionally mixed:

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

## Current Runtime Truth

| Area | Status | Evidence |
| --- | --- | --- |
| Metal standalone shaders | `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar` all pass 8/8 on Apple M4 Max. | `make -C packages/inference/verify metal-verify metal-verify-multiblock` |
| Metal built-fork graph dispatch | `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` for `turbo3`, `turbo4`, and `turbo3_tcq`, and `GGML_OP_ATTN_SCORE_POLAR` are runtime-ready. | `make -C packages/inference/verify dispatch-smoke` now covers the full Metal graph-dispatch set; Turbo4 routes through `kernel_turbo4_dot_multi` against the fork's four-record TBQ4 layout with max diff `1.907e-06`. `dispatch-smoke-implemented` remains the additive subset gate for already implemented routes. |
| Metal artifact gate | `darwin-arm64-metal` now passes the build-script capability gate. | `build-llama-cpp-dflash.mjs` reads `verify/metal-runtime-dispatch-evidence.json` and reports each Metal runtime capability true only when the matching shipped symbol and runtime-ready evidence are both present. A fresh `darwin-arm64-metal` build wrote `CAPABILITIES.json` with `dflash`, `turbo3`, `turbo4`, `turbo3_tcq`, `qjl_full`, and `polarquant` true. |
| Vulkan standalone shaders | All five pass on Apple M4 Max through MoltenVK; turbo* also passed earlier on Intel ARL + lavapipe. | `make -C packages/inference/verify vulkan-verify`. |
| Android Vulkan standalone runner | Tooling is installed and the runner is fail-closed for real-device validation. | Homebrew `android-platform-tools` + `android-commandlinetools` installed; SDK at `~/Library/Android/sdk`; `android_vulkan_smoke.sh` now resolves NDKs under `ANDROID_HOME` / `ANDROID_SDK_ROOT`, statically links libc++, and refuses emulators/software Vulkan unless `ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1` / `ELIZA_ALLOW_SOFTWARE_VULKAN=1` are set. Diagnostic emulator run passed all six fixtures on `llvmpipe`; this does **not** count as Adreno/Mali validation. |
| Vulkan built-fork graph dispatch | Not runtime-ready. | SPIR-V blobs can be staged and CAPABILITIES records `shippedKernels` diagnostics, but `ggml-vulkan.cpp` has no milady-native op dispatch. `vulkan_dispatch_smoke.cpp` now fails before compute unless ggml-vulkan advertises `GGML_OP_ATTN_SCORE_QJL` support, then numerically checks the packed-QJL output. |
| CUDA | API/preprocessor surface exists; no hardware run on this machine. | `nvcc` unavailable on macOS. |
| CUDA/GH200 hardware runners | Runnable, fail-closed entrypoints now exist for Linux x64 NVIDIA and GH200-like Linux aarch64. | `verify/cuda_runner.sh --report <path>` requires `nvcc` + `nvidia-smi` + `make cuda-verify` + `ELIZA_DFLASH_SMOKE_MODEL` graph smoke; `verify/gh200_runner.sh --report <path>` additionally requires arm64 Linux + Hopper/compute-capability-9.x. Skip modes exit non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| ROCm hardware runner | Runnable, fail-closed entrypoint now exists for AMD HIP hosts; fixture parity still needs a HIP harness. | `verify/rocm_runner.sh --report <path>` requires `hipcc` + `rocminfo` `gfx*` agent + model-backed graph smoke. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| Windows hardware runner | Runnable, fail-closed PowerShell entrypoint now exists for native Windows CUDA/Vulkan/CPU smoke. | `verify/windows_runner.ps1 -Report <path>` requires native Windows backend hardware/toolchain and a GGUF model; cross-built exe execution is not counted. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| iOS | Static archives and embedded metallib build for physical-device and simulator slices; physical-device smoke now reaches a connected iPhone and fails on missing runtime ABI symbols. | `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-metal` and `--target ios-arm64-simulator-metal` compile `libllama.a`, `libggml*.a`, headers, and `default.metallib`. `build-xcframework.mjs --verify` now passes the kernel-symbol audit but fails the runtime-symbol audit for missing Capacitor bridge symbols plus `eliza_inference_*`. `run-physical-device-smoke.mjs` was run on Shaw's iPhone (`00008130-001955E91EF8001C`, iOS 26.3.1) and records `missing-capacitor-bridge-and-voice-abi-symbols` in `ios-physical-device-smoke.json`. |
| Voice fusion | macOS production fused `libelizainference.dylib` now builds, symbol-verifies, and ABI-smokes; real TTS with real OmniVoice GGUF weights and merged HTTP routes remain open. | `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal-fused --jobs 10` links `omnivoice-core`, `libelizainference.dylib`, `llama-omnivoice-server`, and `default.metallib`; `make -C packages/app-core/scripts/omnivoice-fuse verify` proves ABI compatibility; Bun FFI smoke against the real dylib proves metadata-only `create`, lazy TTS `mmap_acquire`, structured GGUF-load failure, and `destroy`. |
| Eliza-1 bundles | Schema/catalog/publish gates and release-evidence gates exist; real release bundles do not. | `packages/training/scripts/publish/orchestrator.py` now requires `evidence/release.json`, `checksums/SHA256SUMS`, per-backend runtime dispatch reports, and target-keyed platform evidence before any dry-run/upload path can pass. Runtime-dispatch reports must prove model hash, kernel set, graph route, logs, commit, and device; platform reports cannot skip iOS voice ABI. No checked-in weight-derived manifests or HF upload evidence exist yet. |

## P0 Blockers

1. **iOS runtime ABI packaging**

   Metal graph dispatch is now runtime-ready for QJL, Turbo3, Turbo4,
   Turbo3-TCQ, and PolarQuant on Apple Silicon. The remaining iOS publish
   blocker is that the produced `LlamaCpp.xcframework` slice does not export
   the Capacitor bridge symbols or the `eliza_inference_*` voice ABI symbols
   required by the physical-device smoke.

   Acceptance:
   - `build-xcframework.mjs --verify` passes both kernel-symbol and
     runtime-symbol audits for the iOS arm64 and simulator slices.
   - `run-physical-device-smoke.mjs` passes on a connected iPhone/iPad without
     skipping the voice ABI check.

2. **Metal PolarQuant graph dispatch**

   `GGML_OP_ATTN_SCORE_POLAR` now reaches `kernel_mul_mv_q4_polar_f32`
   through real Metal graph execution. The smoke covers both `use_qjl=0` and
   `use_qjl=1`.

   Acceptance:
   - Built fork smoke covers `use_qjl=0` and `use_qjl=1`. Covered by
     `dispatch-smoke-implemented`.
   - `CAPABILITIES.json.kernels.polarquant=true` when the shipped Metal symbol
     and runtime evidence are present.

3. **Vulkan graph dispatch**

   The Vulkan shaders and fixtures are verified, but the fork runtime has no
   op-level dispatch path for QJL, Polar, or TurboQuant. The Vulkan backend
   must get milady-native descriptors/push constants instead of trying to
   reuse generic binary/mat-vec push layouts.

   Acceptance:
   - Native `linux-x64-vulkan` build contains the SPIR-V blobs and graph
     routing.
   - Smoke tests run on at least Intel/AMD/NVIDIA desktop Vulkan and one
     Android Vulkan device class.
   - `make -C packages/inference/verify vulkan-native-smoke` passes on native
     Linux hardware without `ELIZA_ALLOW_SOFTWARE_VULKAN=1`; the runner now
     writes `hardware-results/linux-vulkan-smoke-*.log`, refuses stale prebuilts
     unless explicitly allowed, dumps `CAPABILITIES.json`, and stops on
     symbol-only build output.
   - `make -C packages/inference/verify android-vulkan-smoke` passes on one
     Adreno and one Mali device with `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE`
     pointing at a built-fork/app graph-dispatch report. Standalone fixture
     success alone exits non-zero and remains evidence only.

4. **Fused voice runtime**

   The product goal is not two independent model processes. The next runtime
   milestone is one fused binary/shared library with one GGML pin and one
   scheduler. Text, DFlash, ASR, and TTS may keep separate weights inside the
   bundle, but they must share the runtime lifecycle and memory budget.

   Acceptance:
   - `libelizainference` exports ABI v1 symbols and passes FFI smoke tests
     under Bun/Electrobun. ABI compatibility smoke and real macOS dylib ABI
     smoke are covered; real TTS synthesis against actual OmniVoice GGUF
     weights is still required before this item is product-ready.
   - Voice mode starts without IPC to a second model process.
   - Voice-off mode does not mmap or page TTS/ASR/voice-preset regions.
   - The fused HTTP server is not product-ready until the compatibility
     `llama-omnivoice-server` route is replaced by one process serving both
     text/DFlash and `/v1/audio/speech`.

5. **Real release artifacts**

   The repo has schema/publish machinery, not real Eliza-1 release bundles.
   Publishing is blocked until each tier has text, drafter, voice, ASR,
   vision/mmproj if enabled, checksums, license files, eval JSON, and
   kernel-verification reports derived from the exact quantized artifact.

## Voice On/Off Architecture

The lowest-duplication design is lazy regional loading from one bundle:

- **Voice off:** load text weights, DFlash drafter, tokenizer, and required
  KV kernels only. Do not mmap TTS/ASR pages or duplicate model parameters.
  `libelizainference` may be loaded lazily, but voice regions remain unmapped.
- **Voice on:** acquire `tts` and, when present, `asr` regions; preload
  `voice-preset-default.bin`; start phrase chunking and PCM ring buffer.
  TTS-only bundles may synthesize without ASR, but local transcription must
  hard-fail instead of silently calling cloud or another model. Rejected DFlash
  ranges cancel pending TTS chunks before they reach the audio sink.
- **Shared, not duplicated:** one tokenizer service where compatible, one
  scheduler, one memory budget, one telemetry stream, one lifecycle. KV cache
  memory is not shared between text and voice models unless the architecture
  actually has identical layers; scheduling and mmap policy are shared.
- **Hard failure:** if any required voice region or kernel is missing in voice
  mode, startup fails. Voice-off mode may run without mapping voice assets only
  if the selected mode explicitly disables voice.

## Performance Work Still Worth Doing

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
6. **CPU spill policy for >64k context.** The catalog requires CPU-offloaded
   KV when RAM is insufficient. The runtime still needs a measurable spill
   policy and a failure mode for devices where spill would miss latency gates.

## Platform Matrix Remaining Work

| Platform class | Next required action |
| --- | --- |
| Apple Silicon Mac | Run fused Metal smoke against a full Eliza-1 bundle after graph-dispatch smoke. |
| Intel/AMD Mac | Build `darwin-x64-metal` and run the standalone + built-fork smoke suite on real hardware. |
| iPhone/iPad | Wire the Capacitor bridge archive and real OmniVoice-backed `eliza_inference_*` ABI into both iOS slices, rerun `build-xcframework.mjs --verify`, rerun `run-physical-device-smoke.mjs` on the connected device, then run a real Eliza-1 bundle smoke that measures first audio latency and peak RSS. |
| Android Adreno | Cross-build `android-arm64-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence for `GGML_OP_ATTN_SCORE_QJL`, collect thermal/RSS. |
| Android Mali | Same as Adreno; do not transfer Adreno results to Mali without a run. |
| Linux x64 CUDA | Run `make cuda` / `cuda_verify` on RTX/A100/H100/H200; pin arch flags where needed. |
| Linux x64 Vulkan | Run `make -C packages/inference/verify vulkan-native-smoke` on Intel/AMD/NVIDIA, not only MoltenVK. |
| Linux x64 ROCm | Build and run on MI300/MI250/RDNA; HIP parity is unproven. |
| Linux aarch64 CUDA | Run on GH200-class host for the `27b-256k` tier. |
| Windows x64 CPU/CUDA/Vulkan | Native Windows smoke and AVX2/driver validation required. |
| Windows arm64 | Snapdragon X build + CPU/Vulkan smoke required. |

## Training And Publishing Remaining Work

- Keep base-lineage names internal to training. Public catalogs, manifests,
  model cards, and default UI must say Eliza-1. Internal registry keys may
  retain upstream lineage until checkpoint conversion is complete.
- Train/fine-tune the text model and drafter for each tier.
- Freeze voice weights, generate the speaker preset, and record voice cache
  format/version in the manifest.
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
- Upload only to `elizalabs/eliza-1-*` repos. Any red gate forces
  `defaultEligible=false`.

## Known Non-Goals For This Wave

- A literal single GGUF containing text + TTS + ASR + vision + drafter. The
  current product artifact is a single logical Eliza-1 bundle with multiple
  files and one manifest. A true one-file container needs a separate `.eliza`
  container or GGUF extension.
- Running singing by default. Singing remains blocked on license review,
  conversion, and evals.
- Falling back to unoptimized kernels. Missing required kernels remain a hard
  error.
