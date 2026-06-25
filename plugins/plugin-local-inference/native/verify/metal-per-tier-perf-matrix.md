# Metal per-tier performance matrix — Apple M4 Max (#9580)

`PLATFORM_MATRIX.md` records the §8 **kernel-correctness** gate and a single
model-graph throughput point. This doc adds the missing **per-tier** Metal
throughput row #9580 asks for ("Metal per-tier (M-series) — produce the real
perf/overhead numbers per backend"), produced on real hardware and reproducible
with [`metal-perf-matrix.mjs`](metal-perf-matrix.mjs).

## Host

- **Apple M4 Max**, macOS 26.2 (Darwin 25.2.0), 128 GB unified memory.
- GPU: `MTLGPUFamilyApple9` / `Metal4`, unified memory, bfloat, residency sets,
  `recommendedMaxWorkingSetSize ≈ 115 GB`.
- `llama-bench`, all layers on GPU (`-ngl 99`), **flash attention on** (`-fa 1`),
  prefill `pp512`, decode `tg128`. Run date **2026-06-25**.
- Evidence: [`evidence/platform/darwin-arm64-metal-perf-matrix-2026-06-25.json`](evidence/platform/darwin-arm64-metal-perf-matrix-2026-06-25.json).

## Kernel-correctness gate (re-verified 2026-06-25, M4 Max)

| Gate | Result |
| --- | --- |
| `make metal-verify` | **8/8 PASS** on every scalar kernel — turbo3 / turbo4 / turbo3_tcq / qjl / polar (incl. polar pre-Hadamard + QJL-residual variants), max diff ≤ 7.6e-6 |
| `make metal-verify-fused` | **1536/1536 PASS** across 2 GQA/MQA cases (`n_kv_heads=2`) |
| `make metal-verify-multiblock` | **1920/1920 PASS** across 4 cases |

The §8 gate is correctness only; the numbers below are throughput.

## Per-tier throughput (staged Eliza-1 text bundles)

> **Arch labeling is honest.** The bundles currently staged on this host are the
> **Qwen3.5-era** Eliza-1 tiers (what `llama-bench` reports as the loaded arch),
> not the Gemma-4 cutover base. The Gemma-4 numbers (`gemma-4-E2B` pp512 636 /
> tg128 23, head_dim 512) in `PLATFORM_MATRIX.md` are a *different model* and are
> slower because Gemma-4's `head_dim=512` attention is much heavier than
> Qwen3.5's. Both are real; do not conflate them. Re-run this matrix once the
> Gemma-4 bundles are staged to get the per-tier Gemma numbers.

| tier | arch (as loaded) | quant | size (MiB) | params | **pp512 t/s** | **tg128 t/s** |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `0_6b` | qwen3 0.6B | Q8_0 | 604 | 596 M | **9307 ± 375** | **103.2 ± 13** |
| `0_8b` | qwen35 0.8B | Q4_K_M | 521 | 752 M | **7059 ± 255** | **91.8 ± 12** |
| `1_7b` | qwen3 1.7B | Q8_0 | 1744 | 1.72 B | **4017 ± 108** | **77.2 ± 6** |
| `2b` | qwen35 2B | Q4_K_M | 1201 | 1.88 B | **2872 ± 327** | **67.2 ± 6** |
| `4b` | qwen35 4B | Q4_K_M | 2728 | 4.21 B | **1030 ± 86** | **48.1 ± 3** |
| `9b` | qwen35 9B | Q4_K_M | 5407 | 8.95 B | **724 ± 43** | **40.8 ± 1** |

`27b` / `27b-256k` are stageable on the 128 GB host but were out of scope for
this pass (the matrix script picks them up automatically when present).

## Decode throughput vs context depth (tg128 @ depth)

KV-cache scaling on the Metal FA path (separate run; absolute numbers carry
run-to-run variance, the *trend* is the signal):

| tier | d=0 | d=4096 | d=16000 |
| --- | ---: | ---: | ---: |
| `0_8b` | 89.2 | 84.0 | 95.8 |
| `2b` | 83.7 | 78.0 | 67.8 |
| `4b` | 49.1 | 49.1 | 38.7 |

Decode stays well above real-time (≈ tens of tok/s) out to 16 k context on every
tier the desktop default would pick; the larger tiers fall off more steeply as
the KV cache grows, as expected.

## Reproduce

```bash
# kernel gate (correctness, no weights needed)
make -C plugins/plugin-local-inference/native/verify \
  metal-verify metal-verify-multiblock metal-verify-fused

# per-tier throughput (auto-discovers staged Eliza-1 bundles + llama-bench)
node plugins/plugin-local-inference/native/verify/metal-perf-matrix.mjs \
  --depths 0,4096,16000 --out plugins/plugin-local-inference/native/verify/reports

# explicit bench / models dir:
LLAMA_BENCH=/path/to/llama-bench \
  node …/metal-perf-matrix.mjs --models-dir ~/.eliza/local-inference/models
```

The harness resolves `llama-bench` from `--bench` / `$LLAMA_BENCH` / common
fork-build locations, discovers each `eliza-1-<tier>.bundle/text/*.gguf`, and
emits a markdown table + JSON report.

## iOS Metal (A18 Pro) — status

iOS Metal throughput is **not** measured by this CLI harness: the iOS runtime is
the static lib + `eliza_inference_*` ABI (no `llama-bench` on device, see
`PLATFORM_MATRIX.md` `ios-arm64-metal`). The kernel-symbol / structure / runtime
audits pass (`build-xcframework.mjs --verify`) and the XCTest device smoke passes
on iPhone 15 Pro; the remaining iOS perf gate is a weight-backed bundle smoke
from the Capacitor app shell (first-token / first-audio / peak-RSS / thermal),
which is device-app work, not a host CLI run.
