# #9715 — on-device verification on the named Mali-G715 (Pixel 9a, Tensor G4)

The Android items of #9715 were filed as device-gated. They were run on the
real **Mali-G715** GPU (Pixel 9a, codename `tegu`, Vulkan 1.4.305, driver
r54p2) by cross-compiling the `native/verify` harness for arm64 (NDK r29) and
running it on-device under `/data/local/tmp/eliza-kernels`.

## Vulkan kernel correctness on Mali-G715 → `mali-g715-vulkan-verify.log`
`vulkan_verify` against the C reference (`native/reference/turbo_kernels.c`),
all at tol 1e-03:

| kernel | result |
|---|---|
| turbo3 / turbo4 / turbo3_tcq | 8/8 PASS each |
| qjl | 8/8 PASS |
| polar / polar + QJL-residual / polar pre-Hadamard | 8/8 PASS each |

**7/7 fixture families PASS, 0 FAIL** — the shipped TurboQuant / QJL / PolarQuant
score kernels are correct on Mali.

## Fused-attention determinism on Mali-G715 → `mali-g715-fused-attn-determinism.log`
The fused QJL-K + Polar attention kernel (the "fused-kernel route" #9715 names
as the clean alternative to the `FA-off` mitigation) run **3×**:

```
run 1/2/3: 1920/1920 PASS across 4 head configs — IDENTICAL max_diff
           (case0 2.980e-07, case1 2.682e-07, case2 4.768e-07, case3 6.258e-07)
```

Bit-for-bit identical across runs → the fused kernel is **deterministic on
Mali**, so it is a correctness-preserving alternative to the generic scalar-FA
path that the `VK_VENDOR_ID_ARM disable_subgroups` + `FA-off` default works
around.

## mul_mm prefill ceiling — root cause confirmed on-device → `mali-g715-prefill-bench-summary.log`
```
ggml_vulkan: 0 = Mali-G715 (Mali-G715) | uma:1 | fp16:1 | bf16:0 | warp size:16 | matrix cores: none
```
**`matrix cores: none`** — the Mali-G715 exposes no `VK_KHR_cooperative_matrix`,
which is exactly why prefill is `mul_mat`-bound (FA-on ≈ FA-off) on this GPU.
The Vulkan inference stack (`libggml-vulkan.so` + the 0.8B bundle) loads and
runs on `Vulkan0 (Mali-G715)`. A Mali-tuned warp-tile/f16-accumulate `mul_mm`
(or the GGML OpenCL/Adreno backend) remains the future perf path — now
confirmed against the device rather than inferred.

## Reproduce
```bash
NDK=$HOME/Android/Sdk/ndk/29.0.13113456
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64
$TC/bin/aarch64-linux-android28-clang  -O2 -std=c11   -I../reference -c ../reference/turbo_kernels.c -o turbo_kernels.arm64.o
$TC/bin/aarch64-linux-android28-clang  -O2 -std=c11   -I../reference -c qjl_polar_ref.c            -o qjl_polar_ref.arm64.o
$TC/bin/aarch64-linux-android28-clang++ -O2 -std=c++17 -I../reference -I. vulkan_verify.cpp \
  turbo_kernels.arm64.o qjl_polar_ref.arm64.o -lvulkan -lm -o vulkan_verify.arm64
# push vulkan_verify.arm64 + ../vulkan/*.spv + verify/fixtures/*.json + libc++_shared.so to /data/local/tmp,
# then: LD_LIBRARY_PATH=. ./vulkan_verify vulkan/<kernel>.spv fixtures/<fixture>.json
```

## mul_mm prefill optimization R&D — register blocking is the Mali win

`mul_mm_bench` (new, `native/verify/`) measures three cooperative-matrix-free
mul_mm variants vs the C-reference-checked scalar baseline, GPU-timed via VK
timestamps. Shaders: `native/vulkan/mul_mm_{scalar,tiled,reg}.comp`.

**Mali-G715 (`mali-g715-mul_mm-bench.log`)** — all variants bit-correct:

| shape | scalar | shared-tiled | **register-blocked** |
|---|---|---|---|
| 512³ | 31.0 GF/s | 0.91–1.20× | **2.25×** (69.8 GF/s) |
| 1024³ | 81.9 GF/s | 0.76× | **1.45×** (118.6 GF/s) |
| prefill-FFN 256×2048×2048 | 78.5 GF/s | 0.80× | **1.43×** (112.2 GF/s) |
| proj 2048×2048×256 | 80.5 GF/s | 0.76× | **1.72×** (138.8 GF/s) |

**Finding:** naive shared-memory tiling *regresses* on Mali (barriers + staging
cost > bandwidth saved; same arithmetic intensity as scalar, which Mali's UMA
cache already serves). **Register blocking** (4×4 per-thread micro-tile, 64×64
workgroup tile) is the real win — 8× the arithmetic intensity per shared load —
raising the mul_mat-bound prefill ceiling **1.4–2.3×** on the actual device.

**Per-platform, confirmed (`host-rtx5080-mul_mm-bench.log`):** the same
register-blocked kernel is *catastrophic* on the RTX 5080 (0.02–0.32× — register
spill; NVIDIA's scalar path hits 485 GF/s and the real backend uses
cooperative-matrix). So a register-blocked mul_mm must be **Mali-gated**, not a
universal path — exactly the "per-platform GPU optimization" #9584 is about. The
actionable next step is porting the register-blocked tiling into ggml-vulkan's
`mul_mm` behind a Mali/no-coopmat guard (further Mali tuning — larger micro-tiles,
f16 operands — is incremental on top of the 1.4–2.3× already shown).
