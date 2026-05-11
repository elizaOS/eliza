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
| Metal built-fork graph dispatch | `GGML_OP_ATTN_SCORE_QJL` is runtime-ready; TurboQuant and PolarQuant are not. | `make -C packages/inference/verify dispatch-smoke` passes 32 QJL scores, max diff `2.384e-07`. |
| Metal artifact gate | Desktop/iOS artifacts still fail the publish gate. | `CAPABILITIES.json`: `dflash=true`, `qjl_full=true`, `turbo3=false`, `turbo4=false`, `turbo3_tcq=false`, `polarquant=false`; `runtimeDispatch.kernels` records QJL as runtime-ready and Turbo/Polar as symbol-shipped only. |
| Vulkan standalone shaders | All five pass on Apple M4 Max through MoltenVK; turbo* also passed earlier on Intel ARL + lavapipe. | `make -C packages/inference/verify vulkan-verify`. |
| Vulkan built-fork graph dispatch | Not runtime-ready. | SPIR-V blobs can be staged, but `ggml-vulkan.cpp` has no milady-native op dispatch. |
| CUDA | API/preprocessor surface exists; no hardware run on this machine. | `nvcc` unavailable on macOS. |
| iOS | Static archives and embedded metallib can be built; no physical-device runtime run. | `ios-arm64-simulator-metal` diagnostics show shipped symbols, but graph capability bits still block publish. |
| Voice fusion | JS lifecycle/FFI scaffold exists; production fused `libelizainference` is not complete. | `voice/ffi-bindings.ts` expects ABI v1; real omnivoice-backed library still needs build/runtime verification. |
| Eliza-1 bundles | Schema/catalog/publish gates exist; real release bundles do not. | No checked-in weight-derived manifests, hashes, evals, or HF upload evidence. |

## P0 Blockers

1. **Metal TurboQuant graph dispatch**

   Required for `turbo3`, `turbo4`, and `turbo3_tcq` runtime capability bits.
   The standalone kernels are attention-score kernels, not generic
   `MUL_MAT`/`GET_ROWS` kernels. The correct path is a dedicated graph op, or
   a fused attention op that consumes the pre-rotated query and packed K/V
   layout directly. Do not revive the old generic `MILADY-DISPATCH-V1` route.

   Acceptance:
   - Built fork exposes dispatch functions for all three TurboQuant variants.
   - Smoke test drives actual Metal backend graph execution.
   - `CAPABILITIES.json.kernels.{turbo3,turbo4,turbo3_tcq}=true`.

2. **Metal PolarQuant graph dispatch**

   The standalone `kernel_mul_mv_q4_polar_f32` and
   `kernel_get_rows_q4_polar` are shader-verified, including the QJL residual
   fixture. They are not yet reachable from a real graph route. This needs
   either a dedicated Polar dot/get-rows op with exact shape constraints, or
   a fused attention route that avoids materializing decoded rows.

   Acceptance:
   - Built fork smoke covers `use_qjl=0` and `use_qjl=1`.
   - `CAPABILITIES.json.kernels.polarquant=true`.

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

4. **Fused voice runtime**

   The product goal is not two independent model processes. The next runtime
   milestone is one fused binary/shared library with one GGML pin and one
   scheduler. Text, DFlash, ASR, and TTS may keep separate weights inside the
   bundle, but they must share the runtime lifecycle and memory budget.

   Acceptance:
   - `libelizainference` exports ABI v1 symbols and passes FFI smoke tests
     under Bun/Electrobun.
   - Voice mode starts without IPC to a second model process.
   - Voice-off mode does not mmap or page TTS/ASR/voice-preset regions.

5. **Real release artifacts**

   The repo has schema/publish machinery, not real Eliza-1 release bundles.
   Publishing is blocked until each tier has text, drafter, voice, ASR,
   vision/mmproj if enabled, checksums, license files, eval JSON, and
   kernel-verification reports derived from the exact quantized artifact.

## Voice On/Off Architecture

The lowest-duplication design is lazy regional loading from one bundle:

- **Voice off:** load text weights, DFlash drafter, tokenizer, and required
  KV kernels only. Do not initialize OmniVoice, ASR, VAD, speaker preset, or
  phrase cache. `libelizainference` may be loaded, but voice regions remain
  unmapped.
- **Voice on:** acquire `tts`, `asr`, and `dflash` regions; preload
  `voice-preset-default.bin`; start phrase chunking and PCM ring buffer.
  Rejected DFlash ranges cancel pending TTS chunks before they reach the audio
  sink.
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
| Apple Silicon Mac | Finish Metal Turbo/Polar graph dispatch, then rerun `dispatch-smoke`, `metal-verify`, and a real Eliza-1 bundle smoke. |
| Intel/AMD Mac | Build `darwin-x64-metal` and run the standalone + built-fork smoke suite on real hardware. |
| iPhone/iPad | Build xcframework, run XCTest/Capacitor smoke on physical iPhone/iPad, measure first audio latency and peak RSS. |
| Android Adreno | Cross-build `android-arm64-vulkan`, run Vulkan verify + runtime smoke via `adb`, collect thermal/RSS. |
| Android Mali | Same as Adreno; do not transfer Adreno results to Mali without a run. |
| Linux x64 CUDA | Run `make cuda` / `cuda_verify` on RTX/A100/H100/H200; pin arch flags where needed. |
| Linux x64 Vulkan | Run native Vulkan graph smoke on Intel/AMD/NVIDIA, not only MoltenVK. |
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
