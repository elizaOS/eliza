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

## Current Runtime Truth

| Area | Status | Evidence |
| --- | --- | --- |
| Metal standalone shaders | `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar` all pass 8/8 on Apple M4 Max. | `make -C packages/inference/verify metal-verify metal-verify-multiblock` |
| Metal built-fork graph dispatch | `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` for `turbo3`, `turbo4`, and `turbo3_tcq`, and `GGML_OP_ATTN_SCORE_POLAR` are runtime-ready. | `make -C packages/inference/verify dispatch-smoke` now covers the full Metal graph-dispatch set; Turbo4 routes through `kernel_turbo4_dot_multi` against the fork's four-record TBQ4 layout with max diff `4.768e-07`. `dispatch-smoke-implemented` is now an alias of the full dispatch smoke. |
| Metal artifact gate | `darwin-arm64-metal`, `darwin-arm64-metal-fused`, `ios-arm64-metal`, and `ios-arm64-simulator-metal` pass the build-script capability gate. | `build-llama-cpp-dflash.mjs` reads `verify/metal-runtime-dispatch-evidence.json` and reports each Metal runtime capability true only when the matching shipped symbol and runtime-ready evidence are both present. Fresh builds wrote `CAPABILITIES.json` with `dflash`, `turbo3`, `turbo4`, `turbo3_tcq`, `qjl_full`, `polarquant`, `lookahead`, and `ngramDraft` true. |
| Vulkan standalone shaders | All five pass on Apple M4 Max through MoltenVK; turbo* also passed earlier on Intel ARL + lavapipe. | `make -C packages/inference/verify vulkan-verify`. |
| Android Vulkan standalone runner | Pixel 6a Mali standalone validation is real-device ready; Adreno and graph-dispatch evidence remain open. | Homebrew `android-platform-tools` + `android-commandlinetools` installed; SDK at `~/Library/Android/sdk`; `android_vulkan_smoke.sh` resolves NDKs under `ANDROID_HOME` / `ANDROID_SDK_ROOT`, statically links libc++, refuses emulators/software Vulkan unless explicitly allowed, and no longer trips `pipefail` on `vulkaninfo` truncation. `make -C packages/inference/verify android-vulkan-smoke` passed all six fixtures on Pixel 6a / Mali-G78 (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`, `polar_qjl`; max diff <= `7.629e-06`) with evidence `verify/hardware-results/android-vulkan-smoke-20260511T062056Z.log`. |
| Vulkan built-fork graph dispatch | **Runtime-ready on native Linux Intel-ANV hardware.** A2 built `linux-x64-vulkan` from the fork and ran `vulkan-dispatch-smoke` → 6/6 graph routes PASS on real Intel Arc/Xe (Mesa ANV); `kernel-contract.json` `runtimeStatus.vulkan` is `runtime-ready` for `turbo3`/`turbo4`/`turbo3_tcq`/`qjl`/`polar` (commit e662143015) and `make -C packages/inference/verify kernel-contract` is green. | Evidence: `verify/vulkan-runtime-dispatch-evidence.json` (`runtimeReady: true`, all 5 kernels, `maxDiff` 2.7e-7…1.9e-6) + `verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log`. Caveat: single Intel-ANV device class — AMD-native, NVIDIA-native, and Android Adreno/Mali Vulkan graph dispatch still needed. `vulkan-kernels.mjs` stages SPIR-V blobs, patches `ggml-vulkan.cpp` for `GGML_OP_ATTN_SCORE_{QJL,TBQ,POLAR}` + `supports_op`; `vulkan_dispatch_smoke.cpp` drives all six numeric routes. |
| Fused attention (QJL-K + TBQ-V / Polar-V) | Vulkan fused compute shaders landed and standalone-verified on hardware; Metal kernel still pending; CUDA fixture-parity needs an NVIDIA host. C reference `eliza_fused_attn_qjl_tbq3` / `eliza_fused_attn_qjl_polar` are bit-exact to the fork's `GGML_OP_FUSED_ATTN_QJL_TBQ` CPU op; round-tripped by `make -C packages/inference/verify reference-test`. `vulkan/fused_attn_qjl_tbq.comp` + `vulkan/fused_attn_qjl_polar.comp` (one-pass online softmax, never materializes the score vector, driver-portable 32-thread shared-memory reduction) pass `make -C packages/inference/verify vulkan-verify-fused` 1920/1920 outputs on Intel ARL Mesa ANV (4 cases: n_kv 64/512/256/128, GQA 1/2/4; max diff 6.3e-7) and built-fork graph dispatch `GGML_OP_FUSED_ATTN_QJL_TBQ` passes via `vulkan-dispatch-smoke` (see `linux-vulkan-fork-build-a1-a2-d1-2026-05-11.json`). Metal: `make metal-verify-fused` fails by design — no `metal/fused_attn*.metal` kernel + `cases`-array path in `metal_verify` yet (`needs-runtime-smoke`; design in `metal-fused-attn-and-polar-preht-design.md`). CUDA: `cuda_verify` parses `fused_attn_qjl_tbq.json` but `needs-hardware`. Registered in `kernel-contract.json`'s `fusedAttn` section with capability key `fused_attn`; NOT yet a `requiredRuntimeCapabilityKey`/`manifestKernelName`. | `verify/fixtures/{fused_attn_qjl_tbq.json,fused_attn_qjl_polar.json,polar_preht.json}`; `reports/porting/2026-05-11/fused-attn-op-contract.md`; `reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`. |
| CPU SIMD paths | AVX-VNNI int8-QJL path (5.25× on this box), Polar pre-Hadamard SIMD, and ARM dotprod variants landed in `qjl-cpu`/`polarquant-cpu`. | `verify/bench_results/cpu_avxvnni_2026-05-11.json`; baseline `verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json`; `reports/porting/2026-05-11/this-machine-test-capability.md`. |
| Platform target matrix | `kernel-contract.json` tracks 21 build targets — added `linux-aarch64-{cpu,cuda}`, `windows-arm64-{cpu,vulkan}`, `windows-x64-vulkan` with cmake plumbing + CUDA arch pins (incl. Blackwell `sm_120`, GH200 `sm_90a`). All new targets `needs-hardware`. Intel Macs (`darwin-x64-metal`) are not a supported target — Apple Silicon `darwin-arm64-metal` only. A `27b-1m` (1M-context, CUDA-only-backend) tier is now in the catalog/schema/Python manifest/platform-plan; `defaultEligible` blocked on real GH200 verify. | `make -C packages/inference/verify kernel-contract` (`targets=21`). |
| CUDA | API/preprocessor surface exists; no hardware run on this machine. | `nvcc` unavailable on macOS. |
| CUDA/GH200 hardware runners | Runnable, fail-closed entrypoints now exist for Linux x64 NVIDIA and GH200-like Linux aarch64. | `verify/cuda_runner.sh --report <path>` requires `nvcc` + `nvidia-smi` + `make cuda-verify` + `ELIZA_DFLASH_SMOKE_MODEL` graph smoke; `verify/gh200_runner.sh --report <path>` additionally requires arm64 Linux + Hopper/compute-capability-9.x. Skip modes exit non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| ROCm hardware runner | Runnable, fail-closed entrypoint now exists for AMD HIP hosts; fixture parity still needs a HIP harness. | `verify/rocm_runner.sh --report <path>` requires `hipcc` + `rocminfo` `gfx*` agent + model-backed graph smoke. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| Windows hardware runner | Runnable, fail-closed PowerShell entrypoint now exists for native Windows CUDA/Vulkan/CPU smoke. | `verify/windows_runner.ps1 -Report <path>` requires native Windows backend hardware/toolchain and a GGUF model; cross-built exe execution is not counted. Skip mode exits non-zero and JSON must show `passRecordable: true` before a pass can be recorded. |
| iOS | Static archives, embedded metallib, Capacitor bridge symbols, and `eliza_inference_*` ABI v1 symbols package into a verified XCFramework for physical-device and simulator slices. Physical-device XCTest is now PASS; weight-backed Capacitor bundle smoke remains open. | `build-xcframework.mjs --verify` passes kernel-symbol, runtime-symbol, and structure audits. `packages/inference/verify/hardware-results/ios-device-smoke-2026-05-11.json` is `status: passed` on iPhone 15 Pro UDID `00008130-001955E91EF8001C`, with 3/3 XCTest cases passing and `--skip-voice-abi=false`. The old failure was a stale shim archive carrying an earlier TTS ABI shape; `build-xcframework.mjs` now refreshes the runtime shim before packaging. |
| Voice fusion | macOS production fused `libelizainference.dylib` now builds, symbol-verifies, lazy-loads real GGUF TTS and ASR assets, and completes real TTS + ASR synthesis/transcription in one fused process. **The merged HTTP route is now real:** the `*-fused` `llama-server` serves `POST /v1/audio/speech` (+ `/audio/speech`) in the same process as `/completion` + `/v1/chat/completions` + the DFlash spec loop, and `dflash-server.ts` prefers spawning that fused binary over the stock + `llama-omnivoice-server` two-process path. | `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal-fused --jobs 10` links `omnivoice-core`, `libelizainference.dylib`, `llama-omnivoice-server`, `libmtmd`, and `default.metallib`; `verify-symbols.mjs` reports `omnivoice=10 abi=8`; Bun FFI smoke against `~/.eliza/local-inference/models/eliza-1-1_7b.bundle` loads real OmniVoice Q4_K_M base/tokenizer GGUFs for TTS and Qwen3-ASR GGUF + qwen3a mmproj for ASR. TTS writes 31,680 samples for `hello`; ASR now normalizes punctuation, stops on sentence completion, and transcribes `/tmp/eliza-asr-hello.wav` to `Hello world.` in the latest smoke. Evidence: `reports/local-e2e/2026-05-11/fused-voice-ffi-smoke.json` and `reports/local-e2e/2026-05-11/asr-ffi-smoke-latest.json`. Merged-route: `linux-x64-cpu-fused` built on Intel x64, `OMNIVOICE_FUSE_VERIFY.json` `ok:true abi:18 omnivoice:10 llamaReexported:true`; the fused `llama-server` serves `/completion` (1-token) AND `/v1/audio/speech` from the same PID against a small dev substitute bundle (503 "not configured" — no `tts/` in the substitute); covered by `dflash-server-fused.integration.test.ts` + `dflash-server.test.ts` "fused-vs-two-process spawn selection". |
| Text-to-voice streaming handoff | JS runtime now streams accepted text deltas from llama-server into the active voice scheduler, supports explicit phrase prewarm, opportunistically reuses repeated generated phrase audio, and exposes the verifier-event callback shape needed by native DFlash. Native accept/reject event streaming is still open. | `dflash-server.generateWithUsage` switches to OpenAI-compatible SSE when `onTextChunk` or `onVerifierEvent` is supplied and synthesizes accept events from deltas until the native server emits exact verifier ranges. `LocalInferenceEngine.generate()` and `generateInConversation()` forward verifier events/chunks into `EngineVoiceBridge` while generation is still in flight and settle the scheduler at turn end without duplicate text delivery. `PhraseCache` is now an LRU-bounded cache (`128` entries, `8s` PCM cap per entry by default), `VoiceScheduler.prewarmPhrases()` caches common phrase audio, and live successful phrase/direct-TTS synthesis is cached only after it survives cancellation/rollback. Default voice chunks are capped at 8 tokens and `ELIZA_VOICE_MAX_IN_FLIGHT_PHRASES` bounds memory on small devices. The DFlash llama-server path also separates `kvOffload=cpu` from layer offload and exposes cache/batch tuning knobs for small-device profiles. Evidence: local-inference focused tests now pass 86/86 for backend/DFlash/voice streaming, and the iOS transport bridge test/typecheck pass after preserving `fetch.preconnect` through the local-agent fetch bridge. |
| Eliza-1 bundles | Local release-shaped bundles exist for all five tiers for runtime-layout smoke; they currently carry placeholder/substitute bytes (not yet built from the elizaOS/llama.cpp fork against the upstream base weights) and `releaseState` is not yet `base-v1`. **v1 = the upstream BASE models** (Qwen3.5/3.6 text + OmniVoice TTS + Qwen3-ASR + Silero VAD + Qwen3-Embedding), GGUF-converted via the fork with every §3 kernel optimization — NOT fine-tuned (fine-tuning is v2). The publish path: stage the upstream base weights → convert via the fork's `convert_hf_to_gguf.py` + `gguf_eliza1_apply.py` (Milady-typed GGUF, `--release-state base-v1`) → emit the real `quantization/*.json` sidecars from a real fork build → collect real per-backend `*_dispatch.json` + `*_verify.json` evidence on real hardware → run the base-v1 evals (text perplexity vs the upstream GGUF, voice RTF, ASR WER, VAD latency/boundary/endpoint, dflash acceptance, e2e loop, 30-turn) → write `evidence/release.json` with `releaseState=base-v1`, `finetuned=false`, the `sourceModels` map and `final.{hashes,evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=true` (`final.weights` need NOT be true for `base-v1` — the bytes are the upstream base GGUFs by design) → publish to `elizaos/eliza-1-*`. See `ELIZA_1_GGUF_READINESS.md` for the per-tier file/evidence checklist. | `stage_eliza1_bundle_assets.py --link-mode hardlink` and `stage_eliza1_source_weights.py` staged non-text assets plus source text/DFlash/vision candidates under `~/.eliza/local-inference/models/eliza-1-*.bundle`. `stage_local_eliza1_bundle.py --all-contexts --force` then hardlinked source/candidate bytes into local `text/`, `dflash/`, and `vision/` release-shaped paths, generated `quantization/{turboquant,fused_turboquant,qjl_config,polarquant_config}.json`, `eliza-1.manifest.json`, `checksums/SHA256SUMS`, and `evidence/release.json` for every tier. Full checksum validation is green for all five bundles. The remaining work is producing the real fork-built GGUF/quant-sidecar bytes, the on-hardware dispatch/verify evidence, the base-v1 evals, the release-reviewed license files, and the `elizaos` upload evidence — never a fabricated hash. |

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
   (Mesa ANV): `vulkan-dispatch-smoke` 7/7 PASS (5 score kernels + fused-attn),
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
     (batch TTS/ASR implemented; the streaming/verifier entries are honest
     stubs reporting `*_supported() == 0` until W7's fused decoder lands).
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
     (guarded `#ifdef MILADY_FUSE_OMNIVOICE`, backed by `omnivoice-core`'s
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
   real fork-built Milady-typed GGUF bytes (text/vision + the already-GGUF
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

## Performance Work Still Worth Doing

0. **Native DFlash verifier event stream.** The JS layer now starts TTS from
   streamed accepted text deltas and the backend callback already carries
   verifier-shaped accept events. For the fastest rollback-safe voice path, the
   fused native runtime still needs to expose exact target-accepted and
   rejected-token events directly, not only synthesized OpenAI deltas.
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

## Platform Matrix Remaining Work

| Platform class | Next required action |
| --- | --- |
| Apple Silicon Mac | Fused Metal voice smoke now passes against the staged Eliza-1 1.7B bundle for real GGUF-backed TTS + ASR through `libelizainference.dylib`. Remaining action is built-fork graph-dispatch smoke plus full text+DFlash+voice latency/RSS/thermal gates. |
| iPhone/iPad | XCFramework symbol/structure audit passes for physical-device and simulator slices, and physical XCTest now passes 3/3 on iPhone 15 Pro. Next required action is a real Eliza-1 bundle smoke from the Capacitor app shell that measures first token, first audio latency, peak RSS, and thermal state. The current iOS ABI bridge is fail-closed and symbol-ready; it is not a complete mobile text/voice generation path until real context + OmniVoice loading are wired. |
| Android Adreno | Cross-build `android-arm64-vulkan`, run Vulkan fixtures via `adb`, attach graph-dispatch evidence for `GGML_OP_ATTN_SCORE_QJL`, collect thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, `system_profiler SPUSBDataType` shows no Pixel/Android USB device, and `make -C packages/inference/verify android-vulkan-smoke` with explicit `ADB` correctly refused emulator evidence. |
| Android Mali | Standalone Pixel 6a / Mali-G78 fixture validation passes for all six kernels. Remaining action is built-fork/app graph-dispatch evidence plus thermal/RSS. Re-check at `2026-05-11T13:31:09Z`: local `adb` still lists only `emulator-5554`, so no new physical-device run was possible from this Mac; runner evidence log is `packages/inference/verify/hardware-results/android-vulkan-smoke-20260511T133109Z.log`. |
| Linux x64 CUDA | Run `make cuda` / `cuda_verify` on RTX/A100/H100/H200; pin arch flags where needed. `cuda_verify.cu` is now a self-contained fixture-parity harness (parses `fused_attn_qjl_tbq.json`); pending-evidence stub at `verify/hardware-results/cuda-linux-thismachine-2026-05-11.pending.json` (this box's dGPU is in D3cold, no kmod/nvcc). |
| Linux x64 Vulkan | **DONE on Intel-ANV** — `vulkan-dispatch-smoke` 6/6 PASS, evidence `verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log` + `verify/vulkan-runtime-dispatch-evidence.json`. Still need native AMD and NVIDIA Vulkan, not only MoltenVK/Intel-ANV. |
| Linux aarch64 CPU | Run CPU backend parity on an arm64 Linux host (`linux-aarch64-cpu` target, `needs-hardware`). |
| Linux aarch64 CUDA | Run `gh200_runner.sh` on a GH200/H100/H200 aarch64 CUDA host for the `27b-256k` and `27b-1m` tiers. |
| Windows x64 CPU/CUDA/Vulkan | Native Windows smoke and AVX2/driver validation required (`windows-x64-{cpu,cuda,vulkan}` targets). |
| Windows arm64 | Snapdragon X build + CPU/Vulkan smoke required (`windows-arm64-{cpu,vulkan}` targets). |
| Fused attention (Metal + CUDA) | Vulkan fused compute kernel + `cases`-array parser in `vulkan_verify` done and hardware-verified (`vulkan-verify-fused` 1920/1920 on Intel ARL Mesa ANV; built-fork `GGML_OP_FUSED_ATTN_QJL_TBQ` dispatch verified). Remaining: a Metal `fused_attn*.metal` kernel + `cases`-array path in `metal_verify` (design in `metal-fused-attn-and-polar-preht-design.md`), then `metal-verify-fused` on a Mac; and a CUDA host for the existing `cuda_verify` fused fixture parity. |

## Training And Publishing Remaining Work

- Keep base-lineage names internal to training. Public catalogs, manifests,
  model cards, and default UI must say Eliza-1. Internal registry keys may
  retain upstream lineage until checkpoint conversion is complete.
- For v1 (`base-v1`): convert each tier's upstream base text/vision model to a
  Milady-typed GGUF via the elizaOS/llama.cpp fork, and distill (KD, not
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
HF publish to `elizaos/eliza-1-*`. Verdict: **NOT publishable; no
non-default upload path exists either.** The text weights are
off-the-shelf Qwen3 0.6B/1.7B substitutes (documented stand-ins for the
unresolvable Qwen3.5-*), NOT fine-tuned — so the text-eval gate fails,
which means `defaultEligible` can never be `true` *and* the orchestrator
has no flag (`--base-v1` / `--allow-base-release` / similar — checked:
the only flags are `--tier`, `--bundle-dir`, `--repo-id`, `--public`,
`--metal-verification`, `--gates-path`, `--dry-run`) that would upload a
non-default release. `validate_release_evidence` hard-requires
`releaseState ∈ {upload-candidate, final}` and **every** `final.*` flag
true. So: leave `publishEligible=false`, do not upload, document below.

**Publish dry-run result (real bundles, 2026-05-11):**
`bash packages/training/scripts/publish_all_eliza1.sh --bundles-root
<root> --dry-run` (with `<root>/{0_6b,1_7b}` symlinked to
`~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle`) →
**stage 1 (bundle layout incl. license attestation + `license-manifest.json`
sidecar) PASSES** for `0_6b`; **stage 2 (release evidence) fails, exit
`16` (`EXIT_RELEASE_EVIDENCE_FAIL`)** for both tiers, blocking on:
`releaseState must be 'upload-candidate' or 'final'`; `final.evals must
be true`; `final.kernelDispatchReports must be true`;
`final.platformEvidence must be true`; `final.sizeFirstRepoIds must be
true`. Gate behaves correctly.

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
- Wake-word: the shipped `wake/hey-eliza.onnx` is the upstream
  openWakeWord `hey_jarvis` head renamed (it fires on "hey jarvis", not
  the Eliza-1 wake phrase). `isPlaceholderWakeWordHead` /
  `OPENWAKEWORD_PLACEHOLDER_HEADS = {hey-eliza, hey_jarvis}` mark it; the
  engine emits a one-time warning whenever a voice session enables a
  placeholder head. New doc
  [`wakeword-head-plan.md`](./wakeword-head-plan.md): steps to train a
  head on the approved Eliza-1 wake phrase via openWakeWord's
  TTS-augmented pipeline.
- Known pre-existing test breakage (NOT from this pass — introduced by
  the catch-all `89e4d49bc6 "updates to many things"` commit that added
  VAD eval-gate keys + changed manifest error-message text without
  updating the fixtures): `test_orchestrator.py::{test_dry_run_succeeds_on_fixture,
  test_real_publish_finalizes_and_uploads_hf_evidence,
  test_dry_run_tag_is_printed_not_executed, test_alias_opt_in_allows_publish_with_warning}`
  and `test_eliza1_manifest.py::test_default_eligible_requires_asr_and_vad_components`.
  Owner: the eval-suite agent — the orchestrator's runtime behaviour is
  correct (real-bundle dry-run gives the expected exit `16`).

## Known Non-Goals For This Wave

- A literal single GGUF containing text + TTS + ASR + vision + drafter. The
  current product artifact is a single logical Eliza-1 bundle with multiple
  files and one manifest. A true one-file container needs a separate `.eliza`
  container or GGUF extension.
- Running singing by default. Singing remains blocked on license review,
  conversion, and evals.
- Falling back to unoptimized kernels. Missing required kernels remain a hard
  error.
