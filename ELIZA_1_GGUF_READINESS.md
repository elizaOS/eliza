# Eliza-1 GGUF Platform Readiness

This file is generated from the canonical platform plan. It is a
release-preparation view only; missing GGUFs are not fabricated.

## 0_6b

- Contexts: 32k
- Text quant: Q3_K_M
- Voice quant: Q4_K_M
- Required kernels: turboquant_q3, qjl, polarquant, dflash
- Supported backends: metal, vulkan, cpu

- Bundle status: missing 19 required file(s)
  - `text/eliza-1-0_6b-32k.gguf`
  - `tts/omnivoice-base-Q4_K_M.gguf`
  - `tts/omnivoice-tokenizer-Q4_K_M.gguf`
  - `dflash/drafter-0_6b.gguf`
  - `dflash/target-meta.json`
  - `cache/voice-preset-default.bin`
  - `asr/eliza-1-asr.gguf`
  - `vad/eliza-1-vad.onnx`
  - `licenses/LICENSE.text`
  - `licenses/LICENSE.voice`
  - `licenses/LICENSE.dflash`
  - `licenses/LICENSE.eliza-1`
  - `evals/aggregate.json`
  - `evidence/release.json`
  - `checksums/SHA256SUMS`
  - `text/turboquant.json`
  - `text/qjl_config.json`
  - `text/polarquant_config.json`
  - `dflash/fused_turboquant.json`

Required platform evidence:
- `darwin-arm64-metal` via `packages/inference/verify/metal-runtime-dispatch-evidence.json`
- `ios-arm64-metal` via `packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs`
- `linux-x64-vulkan` via `packages/inference/verify/linux_vulkan_smoke.sh`
- `android-adreno-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `android-mali-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `linux-x64-cpu` via `packages/inference/verify/runtime_graph_smoke.sh`
- `windows-x64-cpu` via `packages/inference/verify/windows_runner.ps1`
- `windows-x64-vulkan` via `packages/inference/verify/windows_runner.ps1`
- `windows-arm64-cpu` via `packages/inference/verify/windows_runner.ps1`
- `windows-arm64-vulkan` via `packages/inference/verify/windows_runner.ps1`

## 1_7b

- Contexts: 32k, 64k
- Text quant: Q4_K_M
- Voice quant: Q4_K_M
- Required kernels: turboquant_q4, qjl, polarquant, dflash
- Supported backends: metal, vulkan, cpu

- Bundle status: missing 21 required file(s)
  - `text/eliza-1-1_7b-32k.gguf`
  - `text/eliza-1-1_7b-64k.gguf`
  - `tts/omnivoice-base-Q4_K_M.gguf`
  - `tts/omnivoice-tokenizer-Q4_K_M.gguf`
  - `dflash/drafter-1_7b.gguf`
  - `dflash/target-meta.json`
  - `cache/voice-preset-default.bin`
  - `asr/eliza-1-asr.gguf`
  - `vad/eliza-1-vad.onnx`
  - `licenses/LICENSE.text`
  - `licenses/LICENSE.voice`
  - `licenses/LICENSE.dflash`
  - `licenses/LICENSE.eliza-1`
  - `evals/aggregate.json`
  - `evidence/release.json`
  - `checksums/SHA256SUMS`
  - `embedding/eliza-1-embedding-0_6b.gguf`
  - `text/turboquant.json`
  - `text/qjl_config.json`
  - `text/polarquant_config.json`
  - `dflash/fused_turboquant.json`

Required platform evidence:
- `darwin-arm64-metal` via `packages/inference/verify/metal-runtime-dispatch-evidence.json`
- `ios-arm64-metal` via `packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs`
- `linux-x64-vulkan` via `packages/inference/verify/linux_vulkan_smoke.sh`
- `android-adreno-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `android-mali-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `linux-x64-cpu` via `packages/inference/verify/runtime_graph_smoke.sh`
- `windows-x64-cpu` via `packages/inference/verify/windows_runner.ps1`
- `windows-x64-vulkan` via `packages/inference/verify/windows_runner.ps1`
- `windows-arm64-cpu` via `packages/inference/verify/windows_runner.ps1`
- `windows-arm64-vulkan` via `packages/inference/verify/windows_runner.ps1`

## 9b

- Contexts: 64k, 128k
- Text quant: Q4_K_M
- Voice quant: Q8_0
- Required kernels: turboquant_q4, qjl, polarquant, dflash, turbo3_tcq
- Supported backends: metal, vulkan, cuda, rocm, cpu

- Bundle status: missing 22 required file(s)
  - `text/eliza-1-9b-64k.gguf`
  - `text/eliza-1-9b-128k.gguf`
  - `tts/omnivoice-base-Q8_0.gguf`
  - `tts/omnivoice-tokenizer-Q8_0.gguf`
  - `dflash/drafter-9b.gguf`
  - `dflash/target-meta.json`
  - `cache/voice-preset-default.bin`
  - `asr/eliza-1-asr.gguf`
  - `vad/eliza-1-vad.onnx`
  - `licenses/LICENSE.text`
  - `licenses/LICENSE.voice`
  - `licenses/LICENSE.dflash`
  - `licenses/LICENSE.eliza-1`
  - `evals/aggregate.json`
  - `evidence/release.json`
  - `checksums/SHA256SUMS`
  - `vision/mmproj-9b.gguf`
  - `embedding/eliza-1-embedding-0_6b.gguf`
  - `text/turboquant.json`
  - `text/qjl_config.json`
  - `text/polarquant_config.json`
  - `dflash/fused_turboquant.json`

Required platform evidence:
- `darwin-arm64-metal` via `packages/inference/verify/metal-runtime-dispatch-evidence.json`
- `ios-arm64-metal` via `packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs`
- `linux-x64-vulkan` via `packages/inference/verify/linux_vulkan_smoke.sh`
- `android-adreno-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `android-mali-vulkan` via `packages/inference/verify/android_vulkan_smoke.sh`
- `linux-x64-cuda` via `packages/inference/verify/cuda_runner.sh`
- `linux-x64-rocm` via `packages/inference/verify/rocm_runner.sh`
- `windows-x64-cuda` via `packages/inference/verify/windows_runner.ps1`
- `windows-x64-vulkan` via `packages/inference/verify/windows_runner.ps1`
- `linux-x64-cpu` via `packages/inference/verify/runtime_graph_smoke.sh`
- `windows-x64-cpu` via `packages/inference/verify/windows_runner.ps1`

## 27b

- Contexts: 128k, 256k
- Text quant: Q4_K_M
- Voice quant: Q8_0
- Required kernels: turboquant_q4, qjl, polarquant, dflash, turbo3_tcq
- Supported backends: metal, vulkan, cuda, rocm, cpu

- Bundle status: missing 22 required file(s)
  - `text/eliza-1-27b-128k.gguf`
  - `text/eliza-1-27b-256k.gguf`
  - `tts/omnivoice-base-Q8_0.gguf`
  - `tts/omnivoice-tokenizer-Q8_0.gguf`
  - `dflash/drafter-27b.gguf`
  - `dflash/target-meta.json`
  - `cache/voice-preset-default.bin`
  - `asr/eliza-1-asr.gguf`
  - `vad/eliza-1-vad.onnx`
  - `licenses/LICENSE.text`
  - `licenses/LICENSE.voice`
  - `licenses/LICENSE.dflash`
  - `licenses/LICENSE.eliza-1`
  - `evals/aggregate.json`
  - `evidence/release.json`
  - `checksums/SHA256SUMS`
  - `vision/mmproj-27b.gguf`
  - `embedding/eliza-1-embedding-0_6b.gguf`
  - `text/turboquant.json`
  - `text/qjl_config.json`
  - `text/polarquant_config.json`
  - `dflash/fused_turboquant.json`

Required platform evidence:
- `darwin-arm64-metal` via `packages/inference/verify/metal-runtime-dispatch-evidence.json`
- `linux-x64-vulkan` via `packages/inference/verify/linux_vulkan_smoke.sh`
- `linux-x64-cuda` via `packages/inference/verify/cuda_runner.sh`
- `linux-x64-rocm` via `packages/inference/verify/rocm_runner.sh`
- `windows-x64-cuda` via `packages/inference/verify/windows_runner.ps1`
- `windows-x64-vulkan` via `packages/inference/verify/windows_runner.ps1`
- `linux-x64-cpu` via `packages/inference/verify/runtime_graph_smoke.sh`

## 27b-256k

- Contexts: 256k
- Text quant: Q4_K_M
- Voice quant: Q8_0
- Required kernels: turboquant_q4, qjl, polarquant, dflash, turbo3_tcq
- Supported backends: metal, vulkan, cuda, rocm, cpu

- Bundle status: missing 21 required file(s)
  - `text/eliza-1-27b-256k.gguf`
  - `tts/omnivoice-base-Q8_0.gguf`
  - `tts/omnivoice-tokenizer-Q8_0.gguf`
  - `dflash/drafter-27b-256k.gguf`
  - `dflash/target-meta.json`
  - `cache/voice-preset-default.bin`
  - `asr/eliza-1-asr.gguf`
  - `vad/eliza-1-vad.onnx`
  - `licenses/LICENSE.text`
  - `licenses/LICENSE.voice`
  - `licenses/LICENSE.dflash`
  - `licenses/LICENSE.eliza-1`
  - `evals/aggregate.json`
  - `evidence/release.json`
  - `checksums/SHA256SUMS`
  - `vision/mmproj-27b-256k.gguf`
  - `embedding/eliza-1-embedding-0_6b.gguf`
  - `text/turboquant.json`
  - `text/qjl_config.json`
  - `text/polarquant_config.json`
  - `dflash/fused_turboquant.json`

Required platform evidence:
- `darwin-arm64-metal` via `packages/inference/verify/metal-runtime-dispatch-evidence.json`
- `linux-aarch64-cuda` via `packages/inference/verify/gh200_runner.sh`
- `linux-x64-cuda` via `packages/inference/verify/cuda_runner.sh`
- `linux-x64-rocm` via `packages/inference/verify/rocm_runner.sh`
- `linux-x64-vulkan` via `packages/inference/verify/linux_vulkan_smoke.sh`
- `linux-x64-cpu` via `packages/inference/verify/runtime_graph_smoke.sh`
