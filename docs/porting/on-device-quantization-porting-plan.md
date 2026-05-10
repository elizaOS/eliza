# On-device quantization porting plan

> Status doc for the multi-week effort to land DFlash, TurboQuant, QJL, and
> PolarQuant on every realistic on-device runtime: Android (arm64 CPU,
> Hexagon DSP, NNAPI/EdgeTPU), iOS/macOS (Metal, Accelerate), and the
> Linux/CUDA training rig that already runs them.
>
> **The unified Milady fork now exists** at
> [`milady-ai/llama.cpp`](https://github.com/milady-ai/llama.cpp) @
> `v0.1.0-milady` (commit `edd55d8b`). It composes TBQ3_0 / TBQ4_0 from
> apothic, QJL1_256 from W1-A, Q4_POLAR (slot bumped from 45 to 47) from
> W1-B, and the Metal kernel sources from W1-D onto upstream b8198. The
> AOSP path's `compile-libllama.mjs` is now pinned at this fork —
> vendored patches under `scripts/aosp/llama-cpp-patches/` are
> deprecated archival drops. See
> [`docs/porting/unified-fork-strategy.md`](./unified-fork-strategy.md)
> for the full migration story and
> [`reports/porting/2026-05-09-unified/`](../../reports/porting/2026-05-09-unified/)
> for the post-pin verification snapshot. The companion
> [`milady-ai/node-llama-cpp`](https://github.com/milady-ai/node-llama-cpp)
> @ `v3.18.1-milady.1` extends `experimentalKvCacheKey/ValueType` to
> accept the new lowercase aliases (`"tbq3_0"`, `"tbq4_0"`,
> `"qjl1_256"`, `"q4_polar"`) so the desktop path stops rejecting them
> at `createContext()`.
>
> The on-device runtime is `bun:ffi` → `libllama.so` → forked llama.cpp
> ([`milady-ai/llama.cpp`](https://github.com/milady-ai/llama.cpp) @
> `v0.1.0-milady`). Anything shipped to a phone has to land in that
> fork as either:
>
> 1. a new `GGML_TYPE_*` quant block + dequant/dot kernel (per backend), OR
> 2. a new `llama_*` API surface re-exposed by `eliza_llama_shim.c`, OR
> 3. a separate dlopen-able .so the bun process loads alongside llama.cpp.
>
> Anything that can't land via one of those routes is not "on device" for
> the AOSP build, full stop.

## Current state on the AOSP image (last verified 2026-05-09 post-fork-unifier)

`milady_cf_x86_64_phone-trunk_staging-userdebug` boots, Milady priv-app
installs at `/system/priv-app/Milady/`, and `ElizaAgentService` spawns
`bun + libllama.so + agent-bundle.js` correctly. The native libs in
the APK are now produced from the unified
[`milady-ai/llama.cpp @ v0.1.0-milady`](https://github.com/milady-ai/llama.cpp)
fork (commit `edd55d8b`); the May-5-era hot-patch workaround
(`s/init_eliza()/await init_eliza()/` against the agent bundle, plus a
vendored Apothic + 5 floating-patch series for QJL / Polar / Metal) is
gone. `compile-libllama.mjs` is pinned at the unified fork ref;
`scripts/aosp/llama-cpp-patches/` is a one-release archival
deprecation per
[`docs/porting/unified-fork-strategy.md`](./unified-fork-strategy.md).

**Bundle build (W1-G).** `bun run --cwd packages/agent build:mobile`
emits a fresh `agent-bundle.js` (md5
`cbea0f4a066536d6fcd9e6b4e6a1e6ef`, ~31.4 MB on develop @ HEAD as of
2026-05-09) with no hot-patching required. Five script fixes plus two
TLA deferrals from W1-G are upstream:

  1. `packages/agent/scripts/build-mobile-bundle.mjs` — dedupe target
     for `@elizaos/plugin-sql` corrected from
     `plugins/plugin-sql/typescript/index.node.ts` (the file the script
     was looking for) to `plugins/plugin-sql/src/index.node.ts` (the
     file that actually exists). Same one-letter fix for the
     pglite-private-node_modules candidate.
  2. `llama-cpp-capacitor` stubbed
     (`packages/agent/scripts/mobile-stubs/llama-cpp-capacitor.cjs`).
     The bun-side AOSP agent uses `bun:ffi` against `libllama.so`
     directly via `aosp-llama-adapter.ts`, never the Capacitor JNI
     binding (that's WebView-side only).
  3. `zlib-sync` stubbed
     (`packages/agent/scripts/mobile-stubs/zlib-sync.cjs`). discord.js
     pulls it in for compressed gateway frames; no AOSP prebuild
     ships, and discord.js falls back to uncompressed transport when
     the binding throws.
  4. `initdb.wasm` made optional in the asset copy step. plugin-sql
     pins `@electric-sql/pglite ^0.3.3`; the 0.3.x layout embeds the
     init step into `pglite.wasm` and ships no separate
     `initdb.wasm`. The script previously hard-required it.
  5. `packages/core/src/testing/{real-connector,live-provider}.ts` —
     replaced module-init `await import("dotenv")` with memoized
     `ensureDotenvLoaded()` helpers called from each test entry point.
     Bun.build's mobile bundler refuses to `require()` any module
     transitively reachable from a TLA, so deferring dotenv loading is
     necessary for the entire `@elizaos/core` testing subtree to
     bundle.

The plugin-sql top-level-await race is fixed at the **source** level
on develop (commit `12bfccb481`, originally landed on
`worktree-agent-a1402895150138b18` as `b123b08cb9`): lazy memoized
plugin loaders called from `startEliza`'s
`ensureCoreStaticPluginsRegistered()`. The fresh bundle's
`init_eliza`, `init_eliza2`, and `init_eliza_plugin` are all sync
`__esm(() => {...})` emitters with no transitive TLA, so the
init-order bug that triggered the hot-patch is unreachable by
construction.

PGlite db corruption from prior crash-loops is bypassed by wiping
`/data/user/0/ai.milady.milady/files/.eliza/workspace/.eliza/.elizadb`
between runs. Improved `PGliteClientManager.formatError` handles
non-Error throwables (was returning `"[object Object]"`, hiding the
real error message; commit on `worktree-agent-af5238436024dfb1d` —
already on develop).

**Native libs (fork-unifier + W1/W2/W3).** The unified fork bakes in
TBQ3_0 / TBQ4_0 (Apothic), QJL1_256 (W1-A), Q4_POLAR (W1-B; slot
bumped from 45 to 47 to keep 45 as a hole for back-compat), and the
Metal kernel sources (W1-D, source-only — dispatcher wiring still
pending Apple Silicon hardware). Symbol counts in the post-pin AOSP
build (`reports/porting/2026-05-09-unified/symbol-counts.txt`):

| Symbol family | arm64-v8a count | x86_64 count | Notes |
|---|---|---|---|
| TBQ (`*tbq*`) | 8 | 8 | TBQ3_0=43, TBQ4_0=44 in `libggml-base.so` |
| QJL (`*qjl*`) | 19 | 15 (pre-W3-H) / 19 (post-W3-H) | NEON variants on arm64; AVX2 variants on x86_64 after the W3-H per-source `-mavx2 -mfma` flag fix |
| Polar (`*polar*`) | 4 | 4 | Q4_POLAR=47 in `libggml-base.so` |

Cross-architecture validation (W2-A, W2-B): the cross-built
`libggml-cpu.so` for aarch64 was exercised under
`qemu-aarch64-static` and the QJL NEON path matches the standalone
reference 100/100 (signs + norms + full block). PolarQuant NEON
dequant is bit-exact and the dot kernel rel-err is well inside
budget for both `use_qjl=0` and `use_qjl=1`.

DFlash hardening landed in W1-G:

  - `tokenizerFamily` field on every `CatalogModel`, with the test
    guard `it("DFlash pairs share a tokenizer family", ...)` enforcing
    drafter-target vocab parity at edit time.
  - Acceptance-rate telemetry: llama-server's `--metrics` Prometheus
    endpoint is scraped after every `generate()` and logged as
    `[DFlash] acceptance_rate=X.XX (drafted=N, accepted=M, decoded=K)`.
    `DflashLlamaServer.getMetrics()` is public for diagnostic surfaces.
  - `runDflashDoctor()` now reports per-pair tokenizer-family parity
    and (when a server is loaded) the most recent acceptance rate.
  - `maybeRepairDflashDrafter` and its bundled Python `gguf` shim
    deleted — every catalog DFlash pair now shares a tokenizerFamily,
    so the merge-injection workaround is unreachable. See
    `docs/porting/dflash-drafter-strategy.md`.

**node-llama-cpp gap.** The desktop binding is now forked at
[`milady-ai/node-llama-cpp @ v3.18.1-milady.1`](https://github.com/milady-ai/node-llama-cpp);
`GgmlType` accepts `tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar`. The
consumer side still pulls upstream `node-llama-cpp@3.18.1` because
the milady fork ships only TS sources (no `dist/`); the unblock is to
publish `@milady-ai/node-llama-cpp` to npm (path (b) in
`reports/porting/2026-05-09-unified/INDEX.md` "What did NOT land").

### Symbols verified in shipped libs

| Symbol family | Location | Notes |
|---|---|---|
| `quantize_row_tbq3_0`, `quantize_row_tbq4_0`, `dequantize_row_tbq{3,4}_0` | `libggml-base.so` + `libggml-cpu.so` (x86_64 + arm64-v8a in APK) | TBQ3_0=43, TBQ4_0=44. Active on cuttlefish + real arm64 phones today. |
| `quantize_row_qjl1_256`, `dequantize_row_qjl1_256`, `qjl_quantize_row_neon`, `qjl_score_qk_neon` | `libggml-cpu.so` (arm64-v8a) | NEON path verified 100/100 vs reference under QEMU (W2-A). |
| `qjl_quantize_row_avx2`, `qjl_score_qk_avx2` | `libggml-cpu.so` (x86_64) | AVX2 path. **Post-W3-H only** — pre-W3-H the cuttlefish x86_64 build was missing these because `GGML_NATIVE=OFF` left `__AVX2__` undefined and the kernels `#if-out`'d to `_ref` only. |
| `block_q4_polar`, `dequantize_row_q4_polar`, `dequantize_row_q4_polar_neon`, `ggml_vec_dot_q4_polar_q8_0_neon` | `libggml-base.so` + `libggml-cpu.so` | Q4_POLAR=47 (slot bumped from 45). NEON dequant bit-exact under QEMU (W2-B). |
| `ggml_attn_score_qjl` + `GGML_OP_ATTN_SCORE_QJL` op dispatch | `libggml-cpu.so` | Custom op; QJL packed-K + query → unscaled scores. |
| `eliza_llama_context_params_set_type_k` / `_set_type_v` | `libeliza-llama-shim.so` | KV cache type configurable per call from JS. |
| `looksLikeBonsai(modelPath)` auto-routing | `aosp-llama-adapter.ts` | Any GGUF whose filename matches `/bonsai/i` auto-selects `{k:"tbq4_0", v:"tbq3_0"}`. |
| `looksLikeQjl(modelPath)` + `qjl1_256` cache type | `aosp-llama-adapter.ts` | Set `ELIZA_LLAMA_CACHE_TYPE_K=qjl1_256` to compose with TBQ V. Auto-detect QJL > Bonsai precedence. |
| Speculative-decoding wiring | source landed (`aosp-dflash-adapter.ts`, llama-server cross-compile in `compile-libllama.mjs`) | Bundle builds; `llama-server` arm64-v8a/musl artifact pending the next CI rebuild. |
| Capacitor Android local-agent runtime | source landed (worktree-agent-a58ffa46f33215b6a) | ElizaAgentService gated on AOSP_BUILD; in-WebView local-agent kernel (`local-agent-kernel.ts`) generalized for both iOS and Android; shared TBQ resolver across adapters. |
| Catalog `tokenizerFamily` field + DFlash pair guard | source landed on develop (W1-G commit) | Backfilled across every catalog entry. `maybeRepairDflashDrafter` deleted (dead). |
| QJL standalone kernel library | `packages/native-plugins/qjl-cpu/` | 1100 LOC, scalar+AVX2+NEON, 100/100 bit-parity vs Python ref. The kernel sources are also vendored under `ggml/src/ggml-cpu/qjl/` in the unified fork. |
| PolarQuant standalone kernel library | `packages/native-plugins/polarquant-cpu/` | 1871 LOC (C+Python), scalar + AVX2 + NEON kernels + safetensors→GGUF converter. The kernel sources land at `ggml/src/ggml-cpu/quants-polar.c` in the unified fork. |
| Benchmark harness | `scripts/benchmark/profile-inference.mjs` | 48-combo matrix, stub-validated. CI wired in `.github/workflows/local-inference-bench.yml`. |
| iOS / macOS Metal dispatcher | source-only on the fork (`ggml/src/ggml-metal/milady-kernels/`); needs Apple Silicon | W3-G shipped a ready-to-run kit. The dispatcher patch (`ggml-metal.metal` updates so TBQ/QJL/Polar route to the new shaders) lands as soon as a self-hosted `apple-m3-pro` runner is available. |

For the per-cell artifact status (build command, expected exported
symbols, verification command, hardware required, and current
verification state) across every (platform, ABI, GPU-backend) cell,
see [`docs/porting/build-matrix.md`](./build-matrix.md). That doc is
the canonical place to look up "is target X built and how do I
verify it" — this section is the AOSP-image-specific summary.

## Target × technique matrix

`✓` = shipped on the unified fork (`milady-ai/llama.cpp @ v0.1.0-milady`)
and verified per
[`docs/porting/build-matrix.md`](./build-matrix.md). `⚠` = artifact
exists, runtime verification on matching silicon still pending. `□` =
source landed in fork, not built / not wired yet. `▲` = research-grade
or blocked on upstream missing pieces. `✗` = not viable, won't be
attempted.

| Target runtime | TurboQuant (KV cache) | DFlash (spec-decode) | QJL (K-side 1-bit) | PolarQuant (weight) |
|---|---|---|---|---|
| **Android arm64-v8a CPU** (NEON) | ✓ TBQ3_0/TBQ4_0 in libggml-base.so + libggml-cpu.so | ⚠ source landed; `llama-server` arm64-v8a/musl artifact pending next CI build | ⚠ NEON kernel shipped in `libggml-cpu.so` (`qjl_quantize_row_neon`, `qjl_score_qk_neon`); 100/100 QEMU parity (W2-A); needs cuttlefish-arm64 / Pixel runtime gate | ⚠ Q4_POLAR=47 + NEON dequant/dot in `libggml-cpu.so`; bit-exact under QEMU (W2-B); needs real-hardware runtime gate |
| **Android x86_64 CPU** (cuttlefish + emu) | ✓ same | ⚠ same DFlash status | ⚠ AVX2 path (`qjl_quantize_row_avx2`, `qjl_score_qk_avx2`) — present in unified-fork build **post-W3-H** only (pre-W3-H the cuttlefish x86_64 build was missing them; see "Symbols verified" note above) | ⚠ Q4_POLAR slot + ref dequant/dot; AVX2-vec-dot landing as a follow-up |
| **Pixel Tensor TPU / NNAPI** | ✗ KV-cache quant is a per-step custom op, can't fit static graph | ✗ spec-decode is a control-flow problem, NNAPI is a tensor graph | ✗ same constraint as TBQ | ▲ only the dense matmul is delegate-able; sidecar codes have to be unpacked CPU-side first. **Not worth it** unless we abandon llama.cpp for TFLite/MediaPipe — out of scope for this plan. |
| **Hexagon DSP (Snapdragon QDSP6)** | □ block-quant GEMM ports to HVX intrinsics; KV path needs careful threading | ▲ scheduling/control flow is hard on Hexagon; not high priority | □ JL projection is matmul + sign — a clean HVX target | □ same as android-arm64 but with HVX wide vectors |
| **iOS / macOS Metal** | □ TBQ3/TBQ4 `.metal` shaders staged on the fork at `ggml/src/ggml-metal/milady-kernels/` (W1-D); dispatcher wiring needs Apple Silicon (W3-G has the ready-to-run kit) | □ host-side spec-decode, no Metal-side work | □ QJL `.metal` staged; dispatcher needs Apple Silicon | □ Polar `.metal` staged; dispatcher needs Apple Silicon |
| **iOS / macOS Accelerate (CPU)** | ⚠ inherits CPU-NEON path; needs Apple Silicon runtime gate | ⚠ same as Android arm64 once `llama-server` cross-builds for arm64 darwin | ⚠ NEON path inherits | ⚠ same |
| **Linux/Mac/Windows CUDA (host rig)** | ✓ TBQ CUDA template instances inherited from apothic; W3-D walked the configure | ✓ via stock llama.cpp speculative example | □ port from `packages/training/scripts/quantization/qjl/csrc/` | □ port from `polarquant/csrc/` (codes-only training-side reference) |
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

## AOSP CI vs cuttlefish manual gate

GitHub-hosted runners cannot host Cuttlefish (KVM-required). CI splits
into two tiers:

- **Automatic on every PR (`mobile-build-smoke.yml`):** runs
  `bun run --cwd packages/agent build:mobile` against the workspace,
  asserts the resulting `agent-bundle.js` exists, and verifies
  `init_eliza` is emitted as a sync `__esm` initializer (regression
  guard for the May-5 cross-module TLA bug). Then runs the Android
  Gradle debug build to confirm the Capacitor APK pipeline still
  packages the bundle correctly. This catches every regression that
  previously required manual hot-patching.

- **Manual gate (`elizaos-cuttlefish.yml`, `workflow_dispatch` on a
  self-hosted KVM runner):** boots `milady_cf_x86_64_phone-trunk_staging-userdebug`,
  installs the priv-app, and runs `packages/app-core/scripts/aosp/smoke-cuttlefish.mjs`
  for the full `/api/health` + `/api/messages` round-trip per the
  commands below. Operator runs this at every release tag and after
  any merge that touches `packages/agent`, `packages/core`,
  `packages/app-core`, `plugins/plugin-sql`, or the AOSP scripts.

For real arm64 device verification (`ZL8325M37K` reference in the
symbols table), the same script runs against an `adb` device path
without further changes — operator-driven, one-shot.

## AOSP bundle verification commands

These are the cuttlefish commands used by the `worktree-agent-af5238436024dfb1d`
baseline after `bun run --cwd packages/agent build:mobile` produced
`packages/agent/dist-mobile/agent-bundle.js`.

```bash
adb -s 0.0.0.0:6520 shell am force-stop ai.milady.milady
adb -s 0.0.0.0:6520 shell pkill -9 -f bun
sleep 2
adb -s 0.0.0.0:6520 push packages/agent/dist-mobile/agent-bundle.js \
  /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell chmod 600 /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell chown u0_a36:u0_a36 /data/data/ai.milady.milady/files/agent/agent-bundle.js
adb -s 0.0.0.0:6520 shell rm -rf /data/user/0/ai.milady.milady/files/.eliza/workspace/.eliza/.elizadb
adb -s 0.0.0.0:6520 shell rm -f /data/data/ai.milady.milady/files/agent/agent.log
adb -s 0.0.0.0:6520 shell monkey -p ai.milady.milady -c android.intent.category.LAUNCHER 1
adb -s 0.0.0.0:6520 logcat -d | grep ElizaAgent | tail -30
```

Once the API server binds, forward the port and verify health plus a
non-empty chat reply:

```bash
adb -s 0.0.0.0:6520 forward tcp:31337 tcp:31337
curl localhost:31337/api/health
curl -X POST localhost:31337/api/messages -H 'Content-Type: application/json' \
  -d '{"text":"hi"}'
```

## Out of scope (explicit)

- NNAPI / EdgeTPU delegates. KV-cache compressors and per-step bit
  packing don't fit the static-graph delegate model. Pixel Tensor TPU
  is not a target unless we adopt MediaPipe LLM Inference instead of
  llama.cpp.
- WebGPU. llama.cpp WebGPU backend is not yet stable enough; revisit
  when ggml-webgpu lands TBQ.
- Training-time-only paths (PolarQuant calibration, TurboQuant
  calibration loop). Those stay in `packages/training/`.
