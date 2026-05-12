# CPU/CUDA/Voice Optimization Review - 2026-05-11

Scope:
- Read `packages/inference/AGENTS.md` and `packages/training/AGENTS.md`.
- Reviewed `packages/native-plugins/*`, `packages/inference/verify/*bench*` plus adjacent voice harnesses, `packages/app-core/src/services/local-inference/voice`, and `packages/app-core/scripts/omnivoice-fuse`.
- Source was not edited. This report is the only artifact written.

## Correctness Gaps

1. Fused `libelizainference` generation reports ABI v2 while the runtime requires ABI v3.
   - `packages/app-core/scripts/omnivoice-fuse/prepare.mjs:480-484` generates `eliza_inference_abi_version()` returning `"2"`.
   - `packages/app-core/scripts/omnivoice-fuse/ffi.h:70-75` defines ABI version 3.
   - `packages/app-core/src/services/local-inference/voice/ffi-bindings.ts:36` and `:549-558` hard-fail unless the loaded library reports `3`.
   - Impact: a real fused artifact produced by this prepare script will be rejected by the JS voice bridge before ASR/TTS can arm.

2. Streaming TTS and native cancel are defined but not used by the scheduler path.
   - `VoiceScheduler.dispatchPhrase()` calls only `backend.synthesize()` at `packages/app-core/src/services/local-inference/voice/scheduler.ts:291-312`.
   - `FfiOmniVoiceBackend.synthesize()` routes streaming-capable builds through `ttsSynthesizeStream()` but then concatenates all chunks before returning at `packages/app-core/src/services/local-inference/voice/engine-bridge.ts:326-348`.
   - `VoiceScheduler.handleBargeIn()` flips JS cancel flags but never calls `FfiOmniVoiceBackend.cancelTts()` at `scheduler.ts:365-372`; the native hook exists at `engine-bridge.ts:439-442`.
   - Impact: first audio waits for whole-phrase completion, and a hard-stop does not interrupt an in-flight native TTS kernel at the ABI boundary.

3. Native verifier rejected ranges are off by one relative to JS rollback semantics.
   - C ABI documents `rejected_from/rejected_to` as half-open at `packages/app-core/scripts/omnivoice-fuse/ffi.h:219-226`.
   - `EngineVoiceBridge.subscribeNativeVerifier()` passes `toIndex: event.rejectedTo` directly at `packages/app-core/src/services/local-inference/voice/engine-bridge.ts:907-911`.
   - The JS rollback queue treats `toIndex` as inclusive at `packages/app-core/src/services/local-inference/voice/rollback-queue.ts:69-72`; the pipeline also emits inclusive ranges at `pipeline.ts:312-315`.
   - Impact: native reject events can cancel/rollback one token past the rejected tail, including an adjacent phrase boundary.

4. DFlash can silently degrade to target-only generation in the voice adapter.
   - `LlamaServerDraftProposer.propose()` returns `[]` when `runner.hasDrafter()` is false at `packages/app-core/src/services/local-inference/voice/pipeline-impls.ts:300-307`.
   - The inference charter requires DFlash to be present and wired, with only a loud developer kill-switch exception.
   - Impact: a missing drafter can continue as plain autoregressive voice output instead of failing fast.

5. The default live ASR adapter can fall back to whisper.cpp.
   - `createStreamingTranscriber()` defaults to `prefer: "auto"` and falls back to `WhisperCppStreamingTranscriber` at `packages/app-core/src/services/local-inference/voice/transcriber.ts:857-895`.
   - `EngineVoiceBridge.createStreamingTranscriber()` uses that default at `packages/app-core/src/services/local-inference/voice/engine-bridge.ts:980-991`.
   - The inference charter says Eliza-1 voice defaults to fused Qwen3-ASR and not whisper.cpp because whisper vendors a separate GGML.
   - Impact: production Eliza-1 voice can accidentally run a second GGML path with different tokenization and high subprocess latency.

6. OmniVoice fused HTTP route is still a placeholder 503.
   - `prepare.mjs` patches `/v1/audio/speech` to return a structured 503 at `packages/app-core/scripts/omnivoice-fuse/prepare.mjs:1525-1552`.
   - `cmake-graft.mjs` comments say `llama-server` is linked with `omnivoice-core` at `packages/app-core/scripts/omnivoice-fuse/cmake-graft.mjs:136-157`, but the route handler is not actually wired to `ov_synthesize`.
   - `e2e_loop_bench.mjs` assumes real `/v1/audio/speech` PCM at `packages/inference/verify/e2e_loop_bench.mjs:647-667`.
   - Impact: the one-process HTTP voice loop cannot pass through the fused server yet. Library FFI TTS can exist, but the server route required by the e2e harness is not real.

7. PolarQuant AVX2 pre-Hadamard source does not compile on x86.
   - Helper signature requires `(qs4, clo, chi)` at `packages/native-plugins/polarquant-cpu/src/polar_dot_preht_avx2.c:40`.
   - Four call sites pass only the pointer at `polar_dot_preht_avx2.c:86-89`.
   - `packages/native-plugins/polarquant-cpu/CMakeLists.txt:28-32` includes this TU on x86_64/amd64.
   - Verification: local ARM64 CMake build passed because AVX2 is excluded; `clang -target x86_64-apple-macos12 -D__AVX2__ -mavx2 -fsyntax-only .../polar_dot_preht_avx2.c` failed with four "too few arguments" errors.

8. Verification harnesses still have non-measured gates for barge-in and 30-turn voice.
   - `bargein_latency_harness.mjs` records `available: false` until assembled voice wiring lands at `packages/inference/verify/bargein_latency_harness.mjs:99-119`.
   - `thirty_turn_endurance_harness.mjs` keeps `voiceLoopExercised = false` at `packages/inference/verify/thirty_turn_endurance_harness.mjs:118-176`.
   - `e2e_loop_bench.mjs` has a stronger assembled flow, but it depends on the placeholder `/v1/audio/speech` route above.
   - Impact: publish-grade barge-in cancel latency and 30-turn leak/RSS gates are not yet covered by a passing real voice path.

## Performance Opportunities

1. Wire streaming TTS end to end.
   - Scheduler should call a streaming backend seam when available, write PCM chunks to `PcmRingBuffer` immediately, and cache the assembled phrase only after completion.
   - This removes full-phrase latency from `firstAudioFromTokenMs` and makes cancel boundaries meaningful.

2. Replace sample-by-sample PCM ring writes with bulk copy.
   - `PcmRingBuffer.write()` loops per sample at `packages/app-core/src/services/local-inference/voice/ring-buffer.ts:33-48`.
   - `flushToSink()` allocates and copies every flush at `ring-buffer.ts:55-65`.
   - Streaming chunks will amplify this overhead unless the ring buffer gets wraparound bulk copy and sink-facing chunk views.

3. Keep Eliza-1 ASR on the fused path by default.
   - The whisper adapter accumulates buffers with repeated copies and shells out per decode window (`transcriber.ts:416-522`, `:566-573`, `:743-793`).
   - If kept for development, make it explicit and outside the Eliza-1 production preset.

4. Reduce VAD allocation and partial-ASR polling overhead.
   - ONNX Silero creates tensors per 512-sample window at `packages/app-core/src/services/local-inference/voice/vad.ts:177-199`.
   - `VadDetector.pushFrame()` merges pending + frame into a fresh `Float32Array` at `vad.ts:504-531` and slices windows at `:558-566`.
   - `FfiStreamingTranscriber.onFrame()` polls `asrStreamPartial()` after every frame at `transcriber.ts:299-369`.
   - Use native VAD when available, pool fixed-size scratch buffers for JS VAD, and decimate partial reads to 100-200 ms or VAD boundary events.

5. Move QJL hot scoring to int8/DP4A/VNNI paths in measured runtime code.
   - CPU dispatch has a distinct `qjl_score_qk_i8()` path for AVX-VNNI/NEON dotprod at `packages/native-plugins/qjl-cpu/src/qjl_dispatch.c:97-115`.
   - The generic fp32 score dispatch routes AVX-VNNI machines to the AVX2 fp32 scorer at `qjl_dispatch.c:74-94`.
   - `packages/inference/verify/cpu_bench.c:129-140` measures only the reference `eliza_qjl_score_qk`/`eliza_polar_mul_mv` path, not the native plugin SIMD/VNNI path.

6. Prefer pre-Hadamard PolarQuant dot in attention hot paths.
   - `polar_dot_avx2.c:60-65` decodes each block to a 128-float scratch buffer before dotting.
   - The pre-Hadamard AVX2 kernel avoids inverse Hadamard and scratch, but must first be fixed for x86 compilation.

7. CUDA verification has correctness parity coverage but not exported-kernel performance coverage.
   - `cuda_verify.cu` ports fixture algorithms into self-contained kernels and even cross-checks a DP4A QJL path at `packages/inference/verify/cuda_verify.cu:566-625` and `:807-843`.
   - `cuda_runner.sh` correctly requires Linux, `nvcc`, `nvidia-smi`, fixtures, and graph smoke before `passRecordable` at `packages/inference/verify/cuda_runner.sh:87-141` and `:206-246`.
   - Next optimization work still needs timing/occupancy evidence for the actual fork-exported CUDA kernels or graph operators, not just fixture parity.

## Concrete Next Patches

1. ABI/fusion unblocker:
   - Change generated `eliza_inference_abi_version()` in `prepare.mjs` to return `ELIZA_INFERENCE_ABI_VERSION` / `"3"`.
   - Add a prepare-script unit/smoke check that generated `eliza-inference-ffi.cpp` and `ffi.h` agree.
   - Re-run `verify-symbols.mjs` against a fused artifact and an FFI loader smoke.

2. Streaming/cancel TTS patch:
   - Add a scheduler-side interface check for `synthesizeStream()` and `cancelTts()`.
   - In `dispatchPhrase()`, stream PCM chunks into the ring buffer as they arrive, commit/cache the phrase after final, and preserve rollback tracking for not-yet-played chunks.
   - In `handleBargeIn()` and `cancelPendingTts()`, call native cancel in addition to JS cancel flags.
   - Add tests asserting first chunk reaches the sink before final completion and `cancelTts()` is invoked on hard-stop.

3. Rejected-range semantics patch:
   - Document `RejectedTokenRange` as inclusive in `types.ts`, or migrate all JS use to half-open. The smaller patch is to keep JS inclusive.
   - Convert native `event.rejectedTo` to `event.rejectedTo - 1` in `subscribeNativeVerifier()` and ignore empty half-open ranges.
   - Add adjacency tests: reject `[2, 4)` should rollback tokens 2 and 3 only, not token 4.

4. DFlash hard-fail patch:
   - Replace `return []` in `LlamaServerDraftProposer.propose()` with a startup/voice error unless `MILADY_DFLASH_DISABLE=1` is set.
   - Ensure `runVoiceTurn()` and live voice startup assert `hasDrafter()` before constructing the pipeline.

5. ASR default patch:
   - For Eliza-1 voice sessions, call `createStreamingTranscriber({ prefer: "fused", ... })`.
   - Move whisper to an explicit developer/interim flag or non-Eliza custom mode.
   - Add a regression test that missing fused ASR fails hard instead of selecting whisper in Eliza-1 mode.

6. Fused HTTP route patch:
   - Replace the 503 `/v1/audio/speech` handler with a handler that calls `eliza_inference_tts_synthesize_stream()` or `ov_synthesize` in the same `llama-server` process.
   - Return streaming PCM/RIFF chunks with sample-rate headers expected by `e2e_loop_bench.mjs`.
   - Add a route smoke that rejects placeholder 503 responses.

7. PolarQuant CPU patch:
   - Pass `clo, chi` to the four `unpack8_centroids()` call sites.
   - Mirror the fix into any fork copy under `packages/inference/llama.cpp` if present.
   - Run x86 syntax/build, `polar_preht_simd_parity_test`, and `polar_bench`.

8. CPU/CUDA benchmark patch:
   - Add a native CPU bench target that links `qjl-cpu` and `polarquant-cpu`, records active SIMD (`qjl_active_simd`, `polar_active_simd`), and times fp32 QJL, i8 QJL, polar scratch, and polar pre-Hadamard paths.
   - Add CUDA graph/operator timing to complement `cuda_verify.cu` fixture parity, with the same report schema used by `cuda_runner.sh`.

## Verification Notes

- Ran an isolated ARM64 build of `packages/native-plugins/polarquant-cpu`; it passed because AVX2 files are not compiled on this host.
- Ran x86_64 syntax checking of `polar_dot_preht_avx2.c`; it failed exactly on the four missing `clo, chi` arguments.
- Did not run CUDA hardware gates; this host is macOS/ARM64 and the CUDA runner requires Linux plus NVIDIA hardware.
