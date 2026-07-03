# M6 — per-backend kernel decisions for Gemma-4 geometry (#11391 closure)

> Companion to [`M6-gemma-kv-geometry-and-fa.md`](M6-gemma-kv-geometry-and-fa.md)
> (the measured geometry + FA evidence). This doc records the **final
> per-backend kernel decision** (keep-stock vs re-parameterize) for Gemma-4's
> dual head dims (512 global / 256 SWA) + windowed-SWA + shared-KV, the §8
> 8/8 kernel-verify status per backend, the kokoro iSTFTNet dispatch decision,
> and the honest TurboQuant low-precision status.
>
> Measured 2026-07-02 on Apple M4 Max (macOS 26.2), fork submodule pin
> `58c0391eb` (= `2bdcef890` kokoro portable-fast + the two #11612 Metal
> nil-guard/bf16-gate fixes) — the exact gitlink `origin/develop` ships.
> Raw logs: `.github/issue-evidence/11391-kernel-verify/`.

## 1. Decision matrix

Geometry facts driving every row (measured in the companion doc): MQA
(1 KV head), 28/35 layers SWA window 512, 20/35 layers shared-KV (15 own KV),
dual head dims 512/256. The KV cache is already minimal before any KV-quant,
and the QJL (`QJL1_256`) / PolarQuant (`Q4_POLAR`) kernels were authored for
uniform head_dim=128 (Qwen line) — dimensionally inapplicable to Gemma.

| Backend | Decision for Gemma-4 | Rationale (grounded in code at `58c0391eb`) | §8 8/8 kernel verify | Gemma-geometry checks |
|---|---|---|---|---|
| **CPU** | **Keep stock** `q8_0` KV + FA AUTO. Do **not** re-parameterize QJL/Polar. | KV already minimal (MQA+SWA+shared-KV); QJL/Polar head_dim=128-coupled; FA removes the dual-dim V-cache padding. TBQ KV types (`tbq3_0/tbq4_0/tbq3_tcq`, block 32/128 — dimensionally Gemma-compatible) run end-to-end but the quantized-KV prefill path is far too slow to ship (measured below). | `reference-test` clean (M4 Max 2026-07-02; Arrow Lake 2026-06-22); `cpu-dispatch-smoke` + `cpu-qjl-polar-attn-smoke` PASS (2026-06-25, PLATFORM_MATRIX) | FA engages for the 512 global dim, no `padding V cache` (companion doc); Gemma forward proven via `llama-bench` |
| **Metal** | **Keep stock** `q8_0` KV + FA AUTO. | FA AUTO **engages for both Gemma head dims on Metal** — proven 2026-07-02: `kernel_flash_attn_ext_f16_dk512_dv512` + `dk256_dv256` pipelines compile, `flash_attn = enabled`, **0** `padding V cache` lines with `-fa 1` vs **4** with `-fa 0`. TBQ KV is **not runnable** on Metal: `GGML_OP_SET_ROWS`/`GGML_OP_CPY` dst whitelists (`ggml-metal-device.m`) include `QJL1_256` but no TBQ type → `ggml-backend.cpp:974` abort ("buffer (MTL0) cannot run SET_ROWS") when forcing `-ctk tbq4_0`. | **8/8 PASS** M4 Max 2026-07-02 at pin `58c0391eb`: `metal-verify` + `metal-verify-shipped` (runtime-embedded kernels) + `metal-verify-fused` + `metal-verify-multiblock` + `dispatch-smoke` 9/9 graph routes against the built `libggml-metal.dylib` | `llama-bench` gemma4-E2B Q8_0 `-ngl 99`: pp512 **2828.6 t/s** / tg128 **89.7 t/s** (fa1) vs 2690 / 86.5 (fa0) — under heavy host load, ratios indicative |
| **Vulkan (desktop)** | **Keep stock** `q8_0` KV + FA AUTO. | Same geometry rationale; FA engages for 512 and prefill +14% (RTX 5080, companion doc §3). | **8/8 PASS** RTX 5080 2026-06-22 (companion doc §4) **and** MoltenVK/M4 Max 2026-07-02 (`device=Apple M4 Max api=1.2.334`, max diff ≤ 4.4e-6) | Gemma forward proven on RTX 5080 (pp512 1486 / tg128 123 for E2B), correct output |
| **Vulkan-Mali (Android)** | **Keep stock** `q8_0` KV, **FA off by policy** (device-verified scalar `flash_attn.comp` race on Mali → disabled, perf-neutral, `ELIZA_LLM_FLASH_ATTN` override). QJL/Polar on-device attention path (#8848) does **not** transfer to Gemma (head_dim=128). | Without FA, Mali pays the V-cache padding to 512 on E2B — acceptable at mobile context lengths; re-enabling FA on Mali requires fixing the kernel race first, which is not Gemma-specific. | Mali-device 8/8 **hardware-gated → #11734**. Prior adjacent evidence: `gen_fixture --self-test` bit-identical on Cuttlefish `android-x86_64-cpu` (NDK r29 cross-build, live cvd); SwiftShader 8/8 diagnostic-only (software ICD, fail-closed rule). | hardware-gated → #11734 |
| **CUDA** | **Keep stock** `q8_0` KV + FA AUTO. TBQ KV is mechanically complete on CUDA (unlike Metal): `set-rows.cu` covers `TBQ3_0`/`TBQ4_0`, plus `convert/getrows/cpy/fattn` coverage — but the Gemma decision is still stock KV (geometry ROI). | Fork carries full CUDA ports of all five kernels + fused-attn (`fused-attn-qjl-tbq.cu`, `polarquant.cu`). | **8/8 fixture parity VERIFIED** RTX 5080 sm_120, CUDA 12.8, 2026-06-25 (#9580, `CUDA_VERIFICATION.md`): turbo3/turbo4/turbo3_tcq/qjl/polar/polar_qjl 8/8 each + fused 1920/1920 & causal 1536/1536. Model-backed CUDA **graph-dispatch leg hardware-gated → #11734** (no CUDA-capable host in this session; M4 Max has no NVIDIA part). | Gemma forward on CUDA hardware-gated → #11734 |
| **NPU (LiteRT-LM: Tensor / QNN / NeuroPilot)** | **N/A by architecture — nothing to re-parameterize.** | The NPU path is the compiled-in LiteRT-LM backend running Google's pre-converted Gemma `.litertlm` bundles behind the same FFI pipe (#9033 §11). The eliza ggml kernels (TurboQuant/QJL/Polar) do not exist in that graph; LiteRT owns PLE-mmap/windowed-SWA/KV internally. There is no eliza kernel surface on NPU to verify. | N/A (no eliza kernels in the LiteRT graph) | on-device NPU delegate verification **hardware-gated → #11734** |

**Summary decision:** for Gemma-4, every llama.cpp backend keeps **stock
`q8_0` KV-cache + flash-attention AUTO** (the shipped runtime default —
`active-model.ts` sets `q8_0` with the opt-in f16 headroom upgrade), and the
head_dim=128 QJL/Polar KV kernels are **not re-parameterized** (they remain in
the tree, verified, for the legacy Qwen-shaped tiers). The five eliza kernels
stay §8-gated per backend so a regression is visible even though Gemma does
not dispatch them at runtime.

## 2. §8 kernel-verify matrix — runs at pin `58c0391eb` (2026-07-02, M4 Max)

The §8 gate (`native/AGENTS.md` §8) is the 8-check `metal-verify` /
`vulkan-verify` fixture-parity matrix: turbo3, turbo4, turbo3_tcq, qjl, polar,
polar+QJL-residual, polar-preHT, polar-preHT+QJL-residual.

| Gate | Result |
|---|---|
| `make reference-test` (CPU C reference) | PASS — all kernels finite, fused-attn + TBQ V-cache + split-K merge parity OK |
| `make metal-verify` | **8/8 PASS**, max diff ≤ 8.1e-6 (tol 1e-3) |
| `make metal-verify-shipped` (kernels embedded in the fork's `default.metallib` source) | **PASS** — runtime-embedded copies match the C reference |
| `make metal-verify-fused` | PASS — fused QJL-K+TBQ3-V / QJL-K+Q4_POLAR-V incl. causal, polar-preHT multi 2/3/4/8 |
| `make metal-verify-multiblock` | PASS — turbo3/turbo4/turbo3_tcq/qjl at blocks 2/3/4/8 |
| `make dispatch-smoke` (built `libggml-metal.dylib` graph routes) | **9/9 PASS** — ATTN_SCORE_QJL/TBQ×3/POLAR×2/POLAR_PREHT×2 + FUSED_ATTN_QJL_TBQ, max diff ≤ 3.8e-6 |
| `make vulkan-verify` (MoltenVK, `device=Apple M4 Max api=1.2.334`) | **8/8 PASS**, max diff ≤ 4.4e-6 |

CUDA and Vulkan-Mali rows: prior-hardware evidence + hardware-gated residue as
per the matrix in §1 (→ #11734).

## 3. Kokoro iSTFTNet dispatch — measured decision + RTF at the shipped pin

The 2026-07-02 profile (issue #11391) showed the iSTFTNet generator at 261.2 s
of a 301.7 s synth (RTF ≈ 64× slower than real-time). The acceptance line said
"Metal/GPU dispatch"; the **measured decision** that shipped is better for this
workload class:

- **Apple:** route the four hot primitives (conv1d / convtranspose1d / linear /
  lstm) through **Accelerate BLAS (AMX)** — fork commit `114eee08e`. Generator
  261,220 ms → 595 ms; synth 301,697 ms → 723 ms; **RTF 0.15** (~6.5× faster
  than real-time), audio Pearson 0.99959 vs pre-fix, identical transcript.
- **Non-Apple:** thread-pool + NEON portable fast path (`2bdcef890`,
  eliza PR #11584), 23/23 parity checks, ~100×-class conv speedup.
- A true ggml-graph Metal/GPU port remains an *optional* latency/energy
  optimization (every op it needs already exists in the fork's Metal backend);
  it is no longer a perf blocker on any platform.

**Re-verified at pin `58c0391eb` (2026-07-02, this host):** one real synth of
the same phrase/model/voice produced a **byte-identical WAV (md5
`c4b6de77…`) to the reviewed merged evidence** (`kokoro-metal-perf/after.wav`),
samples=112800 @ 24 kHz (4.7 s), peak 0.4195. Compute cost measured at
**0.90 s user CPU** (≈ **compute RTF 0.19**) — wall-clock on this run varied
1.9–6.7 s because the host was carrying a 70–135 load-average agent swarm;
the merged idle-host evidence stands at 723 ms wall (**RTF 0.15**).

## 4. TurboQuant low-precision — honest status at `58c0391eb`

TurboQuant in this tree is two different things; only one of them ships:

**(a) KV-cache / attention-score lane (ships, verified).** `GGML_TYPE_TBQ3_0` /
`TBQ4_0` (block 32) / `TBQ3_TCQ` (block 128) with CPU/Metal/Vulkan/CUDA
attn-score + fused-attn kernels — the exact kernels gated 8/8 in §2. Block
sizes divide Gemma's 512/256 head dims, so unlike QJL/Polar they are
*dimensionally* Gemma-compatible. Measured end-to-end on gemma4-E2B Q8_0:

- **CPU** (`-ctk tbq4_0 -ctv tbq4_0 -fa 1`): runs end-to-end — tg16
  **39.4 t/s**, pp64 **1.33 t/s** vs the f16-KV baseline's pp64 **2.13 t/s**
  measured back-to-back under the same (heavily contended, load ≈ 100–135)
  conditions — i.e. TBQ KV prefill ≈ **0.62×** baseline; absolute CPU numbers
  on this run are contention-bound and only the ratio is meaningful.
  **Quality: parity.** wikitext-2 (2 chunks, same seed/corpus): PPL
  **101.63 ± 24.55** (tbq4_0 KV) vs **103.54 ± 25.05** (f16 KV) — within
  noise.
- **Metal**: **hard abort** — `pre-allocated tensor (cache_k_l0 (view)) in a
  buffer (MTL0) that cannot run the operation (SET_ROWS)`. Root cause:
  the Metal `GGML_OP_SET_ROWS` / `GGML_OP_CPY` dst-type whitelists include
  `QJL1_256` but **no TBQ type**, while CUDA's `set-rows.cu` covers
  TBQ3_0/TBQ4_0. TBQ KV is therefore CUDA/CPU-only as of this pin.
- Decision unchanged: Gemma ships stock `q8_0` KV (§1); TBQ KV stays a
  verified-kernel capability, not a Gemma runtime path.

**(b) Weight-quant lane (does NOT exist end-to-end at this pin).** The #9033
plan kept "TurboQuant *weight* quant" for Gemma, and `native/AGENTS.md` §3
lists it in the Gemma mandatory set — but at `58c0391eb`:

- There is **no `LLAMA_FTYPE_MOSTLY_TBQ*`** — `llama-quantize` cannot target
  TBQ as a file type (grep: no TBQ in `include/llama.h` /
  `src/llama-quant.cpp`).
- The upstream-style weight types `TBQ3_K`/`TBQ4_K` (QK_K layout, `q8_K`
  vec_dot) have **CPU-only** trait entries — zero Metal/Vulkan mul_mat
  kernels (grep: no TBQ3_K/TBQ4_K under `ggml/src/ggml-metal/` or
  `ggml-vulkan/`).
- The per-tensor override path (`llama-quantize --tensor-type
  ffn_up=tbq4_k …`) parses and quantizes, then **fails hard**:
  `ggml_validate_row_data: invalid type 50` →
  `llama_model_quantize: failed to quantize: quantized data validation
  failed` (`ggml_validate_row_data` has no TBQ3_K/TBQ4_K case). Measured
  2026-07-02 against the shipped gemma4-E2B Q8_0 weights; the rejected
  partial output does not load.
- What actually ships for Gemma weights is standard K-quants: the published
  eliza-1-2b bundle is **Q8_0** (this host), and a `Q4_K_M` requant of it
  measures wikitext-2 (8-chunk) PPL **204.05** vs **184.07** for the Q8_0
  source on Metal (+10.9%).

**Residual (recorded, not larped):** making TurboQuant a real *weight* format
requires (1) `ggml_validate_row_data` cases for TBQ3_K/TBQ4_K, (2) an ftype or
blessed per-tensor recipe, and (3) Metal/Vulkan mul_mat kernels before any GPU
platform can ship it. Until an owner decides that work is wanted, the
`native/AGENTS.md` §3 "Gemma mandatory set includes TurboQuant (weight-quant)"
line describes intent, not the shipped tree — the shipped Gemma quantization
is K-quants for weights + `q8_0` KV.
