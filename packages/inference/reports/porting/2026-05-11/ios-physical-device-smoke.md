# iOS Physical-Device Runtime Smoke - 2026-05-11

> This file is generated from `ios-physical-device-smoke-latest.json` by
> `render-ios-smoke-report.mjs` (same directory). Do not hand-edit; re-run the
> generator after a fresh smoke.

## Status

**PASS** — on-device XCTest succeeded on iPhone 15 Pro (iPhone16,1), iOS 26.3.1.

Executed 2 XCTest case(s), 0 failure(s):
- `testLlamaKernelAndVoiceSymbolsResolve` — passed (0.001s)
- `testMetalDeviceIsAvailableOnPhysicalIos` — passed (0.004s)

## Run Metadata

- Device: iPhone 15 Pro (iPhone16,1) — id `C9130C48-48F1-5DC3-98E9-8BACE231D047`, state `available (paired)`
- iOS: 26.3.1
- Xcode / xctrace: Xcode 26.4.1 / Build version 17E202; xctrace xctrace version 16.0 (17E202)
- Started: 2026-05-11 05:12:01Z · Finished: 2026-05-11 05:16:09Z · 248s wall (most of it waiting for the device to be unlocked)
- xcframework device slice: `ios-arm64` (arm64), `LlamaCpp.framework`
- xcodebuild exit status: 0

## Runnable Entrypoint

```sh
ELIZA_IOS_DEVELOPMENT_TEAM=<Apple Team ID> \
  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
    --build-if-missing \
    --report packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke-latest.json
```

It is physical-device only: it rejects simulators and exits non-zero when no
connected, unlocked, trusted iPhone/iPad is available. Fail-closed flags in this run:
- `physicalDeviceOnly`: true
- `requiresIosArm64XcframeworkSlice`: true
- `requiresRuntimeSymbols`: true
- `requiresVoiceAbi`: true
- `capturesXcodebuildOutput`: true

## What This Smoke Actually Verified

On the physical device, the XCTest runner asserted that:

- `MTLCreateSystemDefaultDevice()` returns a non-nil Metal device with a non-empty name (`testMetalDeviceIsAvailableOnPhysicalIos`).
- Every required Eliza-1 runtime symbol resolves via `dlsym(RTLD_DEFAULT, …)` at runtime (`testLlamaKernelAndVoiceSymbolsResolve`) — the LlamaCpp bridge symbols, the QJL / PolarQuant kernel symbols, and the `libelizainference` ABI v1 voice symbols.
- The same `LlamaCpp.xcframework` consumed by `llama-cpp-capacitor` (`ios-arm64` slice) links into the hosted XCTest runner and survives code-signing + on-device launch.

Required-symbol manifest used by the run:

- `llama`: `llama_init_context`, `llama_release_context`, `llama_completion`, `llama_stop_completion`, `llama_get_formatted_chat`, `llama_toggle_native_log`, `llama_embedding`, `llama_embedding_register_context`, `llama_embedding_unregister_context`, `llama_get_model_info`, `llama_get_context_ptr`, `llama_get_last_error`, `llama_free_string`
- `kernels`: `ggml_attn_score_qjl`, `ggml_compute_forward_attn_score_qjl`, `dequantize_row_qjl1_256`, `quantize_qjl1_256`, `dequantize_row_q4_polar`, `quantize_q4_polar`, `llama_decode`
- `voiceAbi`: `eliza_inference_abi_version`, `eliza_inference_create`, `eliza_inference_destroy`, `eliza_inference_mmap_acquire`, `eliza_inference_mmap_evict`, `eliza_inference_tts_synthesize`, `eliza_inference_asr_transcribe`, `eliza_inference_free_string`

## What It Does NOT Claim

This is a **symbol-resolution + xcframework-structure + Metal-availability** check on
device. It is not a numerical model-generation pass:

- No Eliza-1 weights are staged into the temporary XCTest package.
- No tokens are generated; no TTS/ASR audio is produced.
- No latency, RSS, or thermal numbers are measured.

A release-quality iOS pass still requires the follow-up weight-backed Capacitor
bundle smoke that loads the exact release artifact and records: first token latency,
first audio latency, peak RSS, thermal state, a minimal text response, a minimal
TTS/voice response, and voice-off mode proving the TTS/ASR mmap regions stay unmapped.
That bundle smoke is tracked in `needs-hardware-ledger.md`.

