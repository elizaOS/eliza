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

## Current Runtime Truth

| Area | Status | Evidence |
| --- | --- | --- |
| Metal standalone shaders | `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar` all pass 8/8 on Apple M4 Max. | `make -C packages/inference/verify metal-verify metal-verify-multiblock` |
| Metal built-fork graph dispatch | `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` for `turbo3`, `turbo4`, and `turbo3_tcq`, and `GGML_OP_ATTN_SCORE_POLAR` are runtime-ready. | `make -C packages/inference/verify dispatch-smoke` now covers the full Metal graph-dispatch set; Turbo4 routes through `kernel_turbo4_dot_multi` against the fork's four-record TBQ4 layout with max diff `4.768e-07`. `dispatch-smoke-implemented` is now an alias of the full dispatch smoke. |
| Metal artifact gate | `darwin-arm64-metal`, `darwin-arm64-metal-fused`, `ios-arm64-metal`, and `ios-arm64-simulator-metal` pass the build-script capability gate. | `build-llama-cpp-dflash.mjs` reads `verify/metal-runtime-dispatch-evidence.json` and reports each Metal runtime capability true only when the matching shipped symbol and runtime-ready evidence are both present. Fresh builds wrote `CAPABILITIES.json` with `dflash`, `turbo3`, `turbo4`, `turbo3_tcq`, `qjl_full`, `polarquant`, `lookahead`, and `ngramDraft` true. |
| Vulkan standalone shaders | All five pass on Apple M4 Max through MoltenVK; turbo* also passed earlier on Intel ARL + lavapipe. | `make -C packages/inference/verify vulkan-verify`. |
| Android Vulkan standalone runner | Pixel 6a Mali standalone validation is real-device ready; Adreno and graph-dispatch evidence remain open. | Homebrew `android-platform-tools` + `android-commandlinetools` installed; SDK at `~/Library/Android/sdk`; `android_vulkan_smoke.sh` resolves NDKs under `ANDROID_HOME` / `ANDROID_SDK_ROOT`, statically links libc++, refuses emulators/software Vulkan unless explicitly allowed, and no longer trips `pipefail` on `vulkaninfo` truncation. `make -C packages/inference/verify android-vulkan-smoke` passed all six fixtures on Pixel 6a / Mali-G78 (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`, `polar_qjl`; max diff <= `7.629e-06`) with evidence `verify/hardware-results/android-vulkan-smoke-20260511T062056Z.log`. |
| Vulkan built-fork graph dispatch | Source-patched, pending native hardware smoke. | `vulkan-kernels.mjs` now stages the SPIR-V blobs, creates milady Vulkan pipelines, patches `ggml-vulkan.cpp` with milady-native runtime dispatch for `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ`, and `GGML_OP_ATTN_SCORE_POLAR`, and patches `supports_op`. `vulkan_dispatch_smoke.cpp` now drives all QJL, Turbo3, Turbo4, Turbo3-TCQ, Polar, and Polar+QJL graph routes numerically. This is not runtime-ready until `make -C packages/inference/verify vulkan-dispatch-smoke` passes on a native Vulkan build and Android graph-dispatch evidence is attached. |
| CUDA | API/preprocessor surface exists; no hardware run on this machine. | `nvcc` unavailable on macOS. |
| CUDA/GH200 hardware runners | Runnable, fail-closed entrypoints now exist for Linux x64 NVIDIA and GH200-like Linux aarch64. | `verify/cuda_runner.sh --report <path>` requires `nvcc` + `nvidia-smi` + `make cuda-verify` + `ELIZA_DFLASH_SMOKE_MODEL` graph smoke; `verify/gh200_runner.sh --report <path>` additionally requires arm64 Linux + Hopper/compute-capability-9.x. Skip modes exit non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| ROCm hardware runner | Runnable, fail-closed entrypoint now exists for AMD HIP hosts; fixture parity still needs a HIP harness. | `verify/rocm_runner.sh --report <path>` requires `hipcc` + `rocminfo` `gfx*` agent + model-backed graph smoke. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| Windows hardware runner | Runnable, fail-closed PowerShell entrypoint now exists for native Windows CUDA/Vulkan/CPU smoke. | `verify/windows_runner.ps1 -Report <path>` requires native Windows backend hardware/toolchain and a GGUF model; cross-built exe execution is not counted. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| iOS | Static archives, embedded metallib, Capacitor bridge symbols, and `eliza_inference_*` ABI v1 symbols package into a verified XCFramework for physical-device and simulator slices. Physical-device XCTest is now PASS; weight-backed Capacitor bundle smoke remains open. | `build-xcframework.mjs --verify` passes kernel-symbol, runtime-symbol, and structure audits. `packages/inference/verify/hardware-results/ios-device-smoke-2026-05-11.json` is `status: passed` on iPhone 15 Pro UDID `00008130-001955E91EF8001C`, with 3/3 XCTest cases passing and `--skip-voice-abi=false`. The old failure was a stale shim archive carrying an earlier TTS ABI shape; `build-xcframework.mjs` now refreshes the runtime shim before packaging. |
| Voice fusion | macOS production fused `libelizainference.dylib` now builds, symbol-verifies, lazy-loads real GGUF TTS and ASR assets, and completes real TTS + ASR synthesis/transcription in one fused process. The merged HTTP route remains open. | `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal-fused --jobs 10` links `omnivoice-core`, `libelizainference.dylib`, `llama-omnivoice-server`, `libmtmd`, and `default.metallib`; `verify-symbols.mjs` reports `omnivoice=10 abi=8`; Bun FFI smoke against `/Users/shawwalters/.eliza/local-inference/models/eliza-1-1_7b.bundle` loads real OmniVoice Q4_K_M base/tokenizer GGUFs for TTS and Qwen3-ASR GGUF + qwen3a mmproj for ASR. TTS writes 31,680 samples for `hello`; ASR now normalizes punctuation, stops on sentence completion, and transcribes `/tmp/eliza-asr-hello.wav` to `Hello world.` in the latest smoke. Evidence: `reports/local-e2e/2026-05-11/fused-voice-ffi-smoke.json` and `reports/local-e2e/2026-05-11/asr-ffi-smoke-latest.json`. |
| Text-to-voice streaming handoff | JS runtime now streams accepted text deltas from llama-server into the active voice scheduler and supports explicit phrase prewarm. Native accept/reject event streaming is still open. | `dflash-server.generateWithUsage` switches to OpenAI-compatible SSE when `onTextChunk` is supplied; `LocalInferenceEngine.generate()` and `generateInConversation()` forward chunks into `EngineVoiceBridge` while generation is still in flight and settle the scheduler at turn end. `VoiceScheduler.prewarmPhrases()` caches common phrase audio; default voice chunks are capped at 8 tokens and `ELIZA_VOICE_MAX_IN_FLIGHT_PHRASES` bounds memory on small devices. Evidence: `reports/local-e2e/2026-05-11/voice-streaming-optimization.json`; root local-inference Vitest now passes 25 files / 275 tests / 1 skipped. |
| Eliza-1 bundles | Local release-shaped bundles are complete for all five tiers, but they are explicitly non-publishable stand-ins. No final release bundle is publishable yet. | `stage_eliza1_bundle_assets.py --link-mode hardlink` and `stage_eliza1_source_weights.py` staged non-text assets plus source text/DFlash/vision candidates under `/Users/shawwalters/.eliza/local-inference/models/eliza-1-*.bundle`. `stage_local_eliza1_bundle.py --all-contexts --force` then hardlinked source/candidate bytes into local `text/`, `dflash/`, and `vision/` release-shaped paths, generated `quantization/{turboquant,fused_turboquant,qjl_config,polarquant_config}.json`, `eliza-1.manifest.json`, `checksums/SHA256SUMS`, and `evidence/release.json` for every tier. Full checksum validation is green for all five bundles. Every release evidence file remains `releaseState=local-standin`, `publishEligible=false`, and `final.weights=false`; final Eliza-1 trained weights, passing eval/platform evidence, release-reviewed licenses, and `elizaos` upload evidence remain required before publish. |

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

2. **Vulkan native graph-dispatch evidence**

   The Vulkan shaders and fixtures are verified, and the fork runtime patcher
   now installs milady-native descriptors/push constants for QJL, TurboQuant,
   and PolarQuant graph routes. The remaining blocker is native hardware
   evidence from the built fork; MoltenVK fixture success is useful but does
   not prove Linux/Android runtime dispatch.

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

3. **Fused voice runtime**

   The product goal is not two independent model processes. The next runtime
   milestone is one fused binary/shared library with one GGML pin and one
   scheduler. Text, DFlash, ASR, and TTS may keep separate weights inside the
   bundle, but they must share the runtime lifecycle and memory budget.

   Acceptance:
   - `libelizainference` exports ABI v1 symbols and passes FFI smoke tests
     under Bun/Electrobun. ABI compatibility smoke, real macOS dylib ABI
     smoke, real GGUF-backed TTS synthesis, and real GGUF-backed ASR
     transcription are covered. **Done on macOS Metal for the local 1.7B
     bundle.**
   - Voice mode starts without IPC to a second model process.
   - Voice-off mode does not mmap or page TTS/ASR/voice-preset regions.
   - The fused HTTP server is not product-ready until the compatibility
     `llama-omnivoice-server` route is replaced by one process serving both
     text/DFlash and `/v1/audio/speech`.
   - JS runtime streaming from llama-server deltas into the voice scheduler is
     now covered. The native fused runtime still needs first-class DFlash
     accept/reject events so speculative branches can be cancelled before
     phrase audio reaches the sink.

4. **Real release artifacts**

   The repo now has schema/publish machinery plus local release-shaped bundles
   for runtime-layout smoke. Publishing is still blocked until each tier has
   final trained text/drafter bytes, eval JSON, release-reviewed license files,
   platform evidence, and kernel-verification reports derived from the exact
   final quantized artifact.

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

## Performance Work Still Worth Doing

0. **Native DFlash verifier event stream.** The JS layer now starts TTS from
   streamed accepted text deltas, which cuts the old "wait for full response,
   then synthesize" path. For the fastest rollback-safe voice path, the fused
   native runtime still needs to expose target-accepted and rejected-token
   events directly, not only final OpenAI deltas.
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
| Apple Silicon Mac | Fused Metal voice smoke now passes against the staged Eliza-1 1.7B bundle for real GGUF-backed TTS + ASR through `libelizainference.dylib`. Remaining action is built-fork graph-dispatch smoke plus full text+DFlash+voice latency/RSS/thermal gates. |
| Intel/AMD Mac | Build `darwin-x64-metal` and run the standalone + built-fork smoke suite on real hardware. |
| iPhone/iPad | XCFramework symbol/structure audit passes for physical-device and simulator slices, and physical XCTest now passes 3/3 on iPhone 15 Pro. Next required action is a real Eliza-1 bundle smoke from the Capacitor app shell that measures first token, first audio latency, peak RSS, and thermal state. The current iOS ABI bridge is fail-closed and symbol-ready; it is not a complete mobile text/voice generation path until real context + OmniVoice loading are wired. |
| Android Adreno | Cross-build `android-arm64-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence for `GGML_OP_ATTN_SCORE_QJL`, collect thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, `system_profiler SPUSBDataType` shows no Pixel/Android USB device, and `make -C packages/inference/verify android-vulkan-smoke` with explicit `ADB` correctly refused emulator evidence. |
| Android Mali | Standalone Pixel 6a / Mali-G78 fixture validation passes for all six kernels. Remaining action is built-fork/app graph-dispatch evidence plus thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, so no new physical-device run was possible from this Mac; runner evidence log is `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T133109Z.log`. |
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
- Upload only to `elizaos/eliza-1-*` repos. Any red gate forces
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
