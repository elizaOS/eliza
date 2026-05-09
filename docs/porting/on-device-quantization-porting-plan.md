# On-device quantization porting plan

> Status doc for the multi-week effort to land DFlash, TurboQuant, QJL, and
> PolarQuant on every realistic on-device runtime: Android (arm64 CPU,
> Hexagon DSP, NNAPI/EdgeTPU), iOS/macOS (Metal, Accelerate), and the
> Linux/CUDA training rig that already runs them.
>
> The on-device runtime is `bun:ffi` → `libllama.so` → forked llama.cpp
> (`Apothic-AI/llama.cpp-1bit-turboquant`, main-b8198-b2b5273). Anything
> shipped to a phone has to land in that fork as either:
>
> 1. a new `GGML_TYPE_*` quant block + dequant/dot kernel (per backend), OR
> 2. a new `llama_*` API surface re-exposed by `eliza_llama_shim.c`, OR
> 3. a separate dlopen-able .so the bun process loads alongside llama.cpp.
>
> Anything that can't land via one of those routes is not "on device" for
> the AOSP build, full stop.

## Current state on the AOSP image (verified 2026-05-09 on cuttlefish)

`milady_cf_x86_64_phone-trunk_staging-userdebug` boots, agent service runs,
but **end-to-end chat is currently broken** by a `Bun.build` cross-module
top-level-await bug — `init_runtime5` dispatches `init_eliza()` without
awaiting it, so `STATIC_ELIZA_PLUGINS["@elizaos/plugin-sql"]` is still
`undefined` when the resolver fires. The plugin is bundled, the load order
is wrong. Fix is in `eliza/packages/agent/src/runtime/eliza.ts` (replace
the top-level `await loadRequiredPluginSql()` with a lazy registration
hook called from `startEliza` before `loadSinglePlugin` runs). Tracked
separately; not a porting issue.

### Symbols verified in shipped libs

| Symbol family | Location (per ABI under `assets/agent/<abi>/`) | Notes |
|---|---|---|
| `quantize_tbq3_0`, `quantize_tbq4_0`, `dequantize_row_tbq{3,4}_0` | `libggml-base.so` | TBQ3_0=43, TBQ4_0=44. Active on x86_64 + arm64-v8a today. |
| `eliza_llama_context_params_set_type_k` / `_set_type_v` | `libeliza-llama-shim.so` | KV cache type configurable per call from JS. |
| `looksLikeBonsai(modelPath)` auto-routing | `aosp-llama-adapter.ts` | Any GGUF whose filename matches `/bonsai/i` auto-selects `{k:"tbq4_0", v:"tbq3_0"}`. |
| Speculative-decoding API | **not in shim** | `llama_*_draft` is in upstream llama.cpp but not in `eliza_llama_shim.c`. |
| QJL kernels | absent | Upstream is CUDA-only. |
| PolarQuant quant block | absent | Upstream emits a sidecar safetensors, not GGUF. |

## Target × technique matrix

`✓` = working today. `□` = realistic port. `▲` = research-grade / blocked
on upstream missing pieces. `✗` = not viable, won't be attempted.

| Target runtime | TurboQuant (KV cache) | DFlash (spec-decode) | QJL (K-side 1-bit) | PolarQuant (weight) |
|---|---|---|---|---|
| **Android arm64-v8a CPU** (NEON) | ✓ TBQ3_0/TBQ4_0 in libggml-base.so | □ port spec-decode entrypoint into shim | □ NEON port of JL-projection + sign-pack + GQA score kernel | □ new `block_q4_polar` GGML quant type + NEON dequant/dot |
| **Android x86_64 CPU** (cuttlefish + emu) | ✓ same | □ same shim wiring | □ AVX2 port of QJL kernel (cuttlefish smoke only) | □ same block_q4_polar; reuse generic SIMD path |
| **Pixel Tensor TPU / NNAPI** | ✗ KV-cache quant is a per-step custom op, can't fit static graph | ✗ spec-decode is a control-flow problem, NNAPI is a tensor graph | ✗ same constraint as TBQ | ▲ only the dense matmul is delegate-able; sidecar codes have to be unpacked CPU-side first. **Not worth it** unless we abandon llama.cpp for TFLite/MediaPipe — out of scope for this plan. |
| **Hexagon DSP (Snapdragon QDSP6)** | □ block-quant GEMM ports to HVX intrinsics; KV path needs careful threading | ▲ scheduling/control flow is hard on Hexagon; not high priority | □ JL projection is matmul + sign — a clean HVX target | □ same as android-arm64 but with HVX wide vectors |
| **iOS / macOS Metal** | □ MSL kernel for TBQ3_0/TBQ4_0 (port of NEON dot product) | □ same shim wiring; spec-decode is host-side, not GPU-side | □ MSL port of JL-projection + bit-pack + score | □ MSL kernel for `block_q4_polar` |
| **iOS / macOS Accelerate (CPU)** | ✓ falls back to CPU-NEON path automatically | □ same as Android arm64 | □ same | □ same |
| **Linux/Mac/Windows CUDA (host rig)** | ✓ via fused-turboquant Triton (training only today) | ✓ via stock llama.cpp speculative example | ✓ vendored CUDA C++ kernel works on Ampere/Hopper, sm_120 via PTX | ✓ via Python codes-only path |
| **WebGPU (browser, future)** | ▲ blocked on llama.cpp WebGPU backend maturity | ▲ same | ▲ same | ▲ same |

### Realistic deliverable order

Triaged by `(value × tractability) / (engineering days)`:

1. **TurboQuant Metal kernel** — the on-device savings already exist on Android, parity on iOS is the cheapest win. ~2-3 days.
2. **DFlash shim wiring** — spec-decode is already in upstream llama.cpp; we just need to expose `llama_decode` for a draft model + acceptance loop in the shim, and teach `aosp-llama-adapter.ts` to pair-load. ~3-5 days.
3. **QJL NEON kernel + GGML K-cache hook** — adds the K side of the long-context KV win that pairs with TBQ on V. The math is clean (JL matmul + sign + GQA score). ~5-7 days.
4. **PolarQuant `block_q4_polar` GGML quant type** — biggest engineering surface (new block format, dequant + dot per backend, GGUF converter). ~7-10 days.
5. **TurboQuant + QJL + PolarQuant Metal** — parity once each lands on CPU. ~+3 days each.
6. **Hexagon HVX paths** — only after Pixel-side priorities are clear. Starting cost ~5 days for first kernel; subsequent kernels ~2-3 days.

NNAPI / EdgeTPU / WebGPU are explicitly **out of scope** for this plan.
They're not viable for any of these techniques inside the existing
llama.cpp shim — see matrix.

## Per-port engineering notes

### 1. TurboQuant Metal kernel

Source of truth for the block format is in the fork at
`ggml/src/ggml-common.h` (block_tbq3_0, block_tbq4_0) and the reference
CPU dot/quantize is at `ggml/src/ggml-cpu/quants.c`. The Metal port
needs:

- New `.metal` shader in the fork's `ggml-metal.metal` for
  `kernel_get_rows_tbq{3,4}_0`, `kernel_mul_mv_tbq{3,4}_0_f32`,
  `kernel_cpy_f32_tbq{3,4}_0` (KV cache write path).
- Metadata entries in `ggml-metal.m` so the dispatcher routes the new
  types.
- Rebuild llama.cpp with `-DGGML_METAL=ON` and ship the resulting
  `libllama.dylib` (mac) / `libllama-cpp-ios.dylib` for the
  `@elizaos/llama-cpp-capacitor` iOS jniLibs equivalent.

### 2. DFlash spec-decode wiring

DFlash is the in-house brand for n-gram speculative decoding with a
small drafter model. Upstream llama.cpp ships
`examples/speculative/speculative.cpp` and `common/speculative.cpp` —
not used today because the shim only exposes single-model decode.

Two viable paths:

- **(a) llama-server route.** Cross-compile `llama-server` for
  android-arm64 musl using the same `compile-libllama.mjs` toolchain,
  ship it next to `bun`. Have `ElizaAgentService` spawn it with
  `--draft <drafter.gguf> --model <target.gguf>`. Bun talks to it over
  loopback OpenAI-shaped HTTP (already what the host-side
  `dflash-server.ts` does). **Pro:** zero new shim symbols. **Con:**
  doubles the resident process count and adds cold-start cost. ~2 days.

- **(b) Shim entrypoint route.** Add `eliza_llama_create_speculative`,
  `eliza_llama_decode_speculative` to `llama-shim/eliza_llama_shim.c`
  that wrap the `common_speculative_*` helpers. Drafter and target
  share the same llama.cpp process. Bun:ffi-binds the new entrypoints
  in `aosp-llama-adapter.ts`. **Pro:** single process, lower cold start.
  **Con:** new wire format work in `eliza_llama_shim.c`, need to expose
  acceptance-rate telemetry. ~5 days.

Path (a) is cheaper to validate; path (b) is the production answer.
Doing (a) first to land a perf number, then (b) as the durable wiring,
is the recommended order.

### 3. QJL NEON kernel + GGML K-cache hook

QJL = K-side compression: store `sign(Π·k)` packed 8-per-byte plus
per-token bf16 norm. K-cache `head_dim=128` blocks → one JL matmul
(`Π ∈ R^{128×s}` with `s=256` canonical) → one NEON `vcgtq_f32` for
sign extraction → 32-element bit pack via `vshrn_n_u16`/`vorr_u8`. The
GQA score kernel rebuilds the inner product as
`||k|| * Π^T · sign · q_proj` per attention step.

Steps:

- Add `block_qjl1_256` (256 sign bits = 32 bytes + bf16 norm) to
  `ggml-common.h`.
- Implement `quantize_row_qjl1_256` (NEON) + `dequantize_row_qjl1_256`
  (used for decode; the score kernel works directly on packed signs)
  in `ggml-cpu/quants-qjl.c` (new file).
- Add a custom op `GGML_OP_ATTN_SCORE_QJL` that consumes packed K +
  query and emits unscaled scores; dispatched in `ggml-cpu.c`. The
  upstream graph builder hooks it via a llama.cpp build flag
  `LLAMA_QJL_KCACHE`.
- Plumb cache type `qjl1_256` through `eliza_llama_context_params_set_type_k`
  so the existing shim setter works without a new symbol.
- TurboQuant V + QJL K composes: same model, different per-side cache
  type. The runtime can opt into both via env
  `ELIZA_LLAMA_CACHE_TYPE_K=qjl1_256 ELIZA_LLAMA_CACHE_TYPE_V=tbq3_0`.

The reference CUDA kernel at
`packages/training/scripts/quantization/qjl/qjl_kernel/csrc/` is a clean
spec for what the NEON port has to compute. No CUDA-isms (warp
shuffles, sm_80 mma) leak into the reference math; it's all
projection + sign + bit-pack + dot product.

### 4. PolarQuant `block_q4_polar` GGML quant type

PolarQuant emits codes-only safetensors today
(`packages/training/scripts/quantization/polarquant/`). The Python loader
reconstructs fp16 weights with `LUT[code] / sqrt(d) · H · ||block||`.
The on-device path needs to consume the codes directly inside a GEMM
kernel.

Block layout (proposed, `block_q4_polar`):

```c
#define QK_POLAR 128
typedef struct {
  ggml_fp16_t d;          // per-block L2 norm (fp16)
  uint8_t qs[QK_POLAR/2]; // 4-bit codes, 2 per byte
  uint8_t qjl[QK_POLAR/8]; // optional 1-bit QJL residual sign
} block_q4_polar;
```

Kernels needed:

- `quantize_row_q4_polar_ref` (reference C) + NEON-optimized
  `quantize_row_q4_polar`. Accepts a Walsh-Hadamard-rotated row;
  rotation is precomputed in the GGUF converter so dequant is
  rotation-free.
- `dequantize_row_q4_polar` (NEON): centroid LUT lookup, undo Hadamard
  via butterfly, scale by `d / sqrt(QK_POLAR)`. Centroid LUT is the
  precomputed Lloyd-Max for `N(0,1)`, fixed at compile time.
- `ggml_vec_dot_q4_polar_q8_0` (NEON FMA) — the hot path. Mirrors the
  shape of `ggml_vec_dot_q4_K_q8_K`.
- GGUF converter: a Python script that takes the polarquant safetensors
  sidecar and produces a GGUF whose tensors are typed `Q4_POLAR=45`,
  preserving the per-block norms and rotation seed.

Same shape ports to Metal (MSL), AVX2 (cuttlefish), and (later) Hexagon
HVX. The PolarQuant paper (`arXiv:2603.29078`) is the spec; the Python
reference in `polarquant/polar_quant.py` is the bit-exact target.

### 5. PolarQuant + QJL + TurboQuant Metal

Once the CPU implementations are correct, Metal versions are mostly
mechanical translations. The biggest non-trivial bit is the Metal
threadgroup layout for the JL projection — `head_dim=128` × `s=256`
fits in one threadgroup with shared-memory tiling, but TurboQuant V's
per-token RHT needs a different layout (`head_dim=128` butterfly per
thread, no cross-thread reduction). Both ship in the same `.metal`
file.

### 6. Hexagon HVX paths

Only meaningful for Pixel-or-equivalent SoCs that route `MatMul` and
custom ops to QDSP6 via the Qualcomm SNPE / Hexagon NN runtime.
Engineering cost is high (HVX ISA + Hexagon scheduler), payoff is
real on long contexts (HVX is wider than NEON for int8/int4 ops).
Do **not** start this until the NEON ports are validated and
shipped on phones — premature otherwise.

## Validation matrix (per port)

Each kernel must come with three tests, all run on every supported
runtime that exposes the port:

1. **Bit-exact reference parity.** The new kernel and a Python
   reference (PyTorch on CUDA host) compute the same quantized blocks
   for a fixed seed input. Tolerance: 0 ULP for integer codes, ≤ 1
   ULP for fp16 norms.
2. **Perplexity smoke.** Wikitext-2 first 64 chunks, baseline FP16 vs
   the quantized path. Acceptance: PPL Δ ≤ +0.05 for TurboQuant 4-bit,
   ≤ +0.10 for QJL 1-bit, ≤ +0.05 for PolarQuant Q4.
3. **End-to-end agent chat.** Inside cuttlefish (Android x86_64) and
   on a connected real arm64 device (`ZL8325M37K`), exercise
   `/api/health` + a 5-prompt chat round-trip with each cache/weight
   config. Acceptance: every prompt returns a non-empty,
   non-degenerate reply; tok/s recorded.

For Metal/iOS, the (3) gate runs against the iOS Capacitor build via
`@elizaos/llama-cpp-capacitor` once the dylib lands.

## What gets logged where

- Per-kernel benchmark JSON: `reports/porting/<technique>/<runtime>/<date>.json`.
- Per-build smoke + chat tok/s: `reports/aosp-sim/<date>/report.json`
  (extends the existing sim runner output).
- Cross-port comparison table: regenerated nightly into
  `docs/porting/on-device-quantization-porting-plan.md` (this file)
  once the runners are wired up.

## Out of scope (explicit)

- NNAPI / EdgeTPU delegates. KV-cache compressors and per-step bit
  packing don't fit the static-graph delegate model. Pixel Tensor TPU
  is not a target unless we adopt MediaPipe LLM Inference instead of
  llama.cpp.
- WebGPU. llama.cpp WebGPU backend is not yet stable enough; revisit
  when ggml-webgpu lands TBQ.
- Training-time-only paths (PolarQuant calibration, TurboQuant
  calibration loop). Those stay in `packages/training/`.
