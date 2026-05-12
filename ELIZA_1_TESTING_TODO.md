# Eliza-1 Testing TODO

Last updated: 2026-05-11.

This file tracks publish-blocking platform evidence that cannot be inferred
from source review or standalone shader verification. A result is publishable
only when it is produced by the final Eliza-1 bundle bytes for that tier.

## Done On This Mac

- Metal standalone kernel verification on Apple M4 Max:
  Turbo3, Turbo4, Turbo3-TCQ, QJL, Polar, Polar+QJL, Polar-preHT, and
  Polar-preHT+QJL all pass fixture parity.
- Metal built-fork graph dispatch:
  `dispatch_smoke` passes QJL, Turbo3, Turbo4, Turbo3-TCQ, raw Polar
  (`use_qjl=0/1`), and explicit pre-Hadamard Polar (`use_qjl=0/1`).
- Metal runtime tuning knobs:
  QJL/TBQ defaults remain conservative, but `ELIZA_METAL_*_PER_TG` overrides
  pass the graph smoke and are ready for per-device autotune.
- MoltenVK standalone/multiblock/fused smoke is useful local parity evidence,
  but it is not native Vulkan publish evidence.

## Required Before Release

- Final Eliza-1 GGUFs for every release tier:
  text, DFlash drafter, voice/TTS, ASR, vision/mmproj when included, tokenizer
  assets, quantization sidecars, checksums, release-reviewed licenses, eval
  JSON, and `evidence/release.json`.
- Hugging Face upload evidence under the `elizaos` organization:
  model repo URL, commit hash, uploaded file list, SHA256SUMS, model card,
  license review, and signed publish report.
- Weight-backed fused voice smoke:
  one process serves text completion and `/v1/audio/speech`, loads the final
  tier's real TTS assets, reports first token, first audio, peak RSS, and
  cancellation latency.
- iOS physical-device app smoke with final bundle:
  XCTest/Capacitor app shell loads the exact iOS artifact and final bundle,
  records first token, first audio, peak RSS, thermal state, and no cloud
  fallback.
- Native Vulkan graph-dispatch evidence:
  at minimum AMD desktop, NVIDIA desktop, Android Adreno, and Android Mali
  with built-fork/app graph execution, not only standalone SPIR-V fixtures.
- CUDA/Hopper/GH200:
  CUDA fixture parity, fused-attention smoke, model-backed graph dispatch,
  and long-context run on real NVIDIA hardware. GH200 must be arm64 Linux with
  Hopper-class compute capability.
- ROCm:
  HIP/ROCm source build, fixture parity or equivalent graph smoke, and
  model-backed run on real AMD GPU hardware.
- Windows:
  native Windows x64 CUDA/Vulkan/CPU smoke, plus Windows ARM64 CPU/Vulkan
  smoke when hardware is available. Cross-built binaries do not count.

## Optimization Experiments To Keep Running

- Per-device Metal autotune:
  sweep QJL tokens-per-threadgroup and TBQ blocks-per-threadgroup across
  median, p95, p99, and cancellation latency. Persist the chosen values in the
  release evidence for each device class.
- Polar preHT graph selection:
  route only through `ggml_attn_score_polar_preht()` when the graph explicitly
  constructs `H*q`; raw-q graphs must keep the raw Polar route.
- Fused attention:
  score -> online softmax -> V mix should be benchmarked against the current
  standalone score path at 4k, 32k, 64k, 128k, and 256k contexts.
- Voice-mode scheduling:
  keep command-buffer batching disabled for interactive voice. Evaluate short
  graph tiles instead; barge-in/cancel latency is the primary metric.
- CPU plugin sweeps:
  measure AVX2/AVX-VNNI/NEON/dotprod QJL and Polar preHT paths at 1, 4, 8,
  16, and max practical thread counts under low-load conditions.
