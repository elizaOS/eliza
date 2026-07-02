// Android arm64-v8a CPU SIMD floor for the elizaOS/llama.cpp fork builds.
//
// Problem this solves:
//   Every Android arm64 fork build sets GGML_NATIVE=OFF (correct for a
//   cross-compile — the build host's CPU is irrelevant). But with
//   GGML_CPU_ARM_ARCH and GGML_CPU_ALL_VARIANTS both unset, the fork's
//   ggml/src/ggml-cpu/CMakeLists.txt falls through to the no-`-march`
//   branch: the .so is built at the bare armv8-a baseline. That means:
//     - ggml's own dot-product / i8mm / fp16 NEON kernels stay off, and
//     - the eliza QJL NEON-dotprod kernels (qjl_score_dotprod.c, guarded on
//       __ARM_FEATURE_DOTPROD) compile to a DEAD body, so the QJL K-cache
//       attention-score dispatcher (qjl_dispatch.c) falls back to the scalar
//       reference path on every phone — including the Pixel 9a, whose Tensor
//       G4 (Cortex-A720/X4) has dotprod + i8mm + fp16 + bf16 + sve2.
//
// The fix (robust route, per native/AGENTS.md guidance):
//   Pin a fixed armv8.2-a+dotprod+fp16+i8mm floor via GGML_CPU_ARM_ARCH. The
//   `-march` flag makes the compiler define __ARM_FEATURE_DOTPROD /
//   __ARM_FEATURE_MATMUL_INT8 / __ARM_FEATURE_FP16_VECTOR_ARITHMETIC, which
//   lights up the live NEON-dotprod/i8mm/fp16 kernel bodies (ggml's and the
//   eliza QJL ones).
//
//   But the QJL *dispatcher* define QJL_HAVE_NEON_DOTPROD is gated separately
//   in ggml-cpu/CMakeLists.txt (`if (GGML_INTERNAL_DOTPROD OR GGML_USE_DOTPROD)`)
//   — those internal vars are only set inside the GGML_CPU_ALL_VARIANTS block,
//   which the GGML_CPU_ARM_ARCH route does NOT enter. So a `-march`-only build
//   would compile a live dotprod kernel body that the dispatcher never selects
//   (it only routes to QJL_SIMD_NEON_DOTPROD when QJL_HAVE_NEON_DOTPROD is
//   defined). We therefore also pass GGML_USE_DOTPROD=ON to flip the QJL
//   dispatch define on. The per-TU body still self-guards on
//   __ARM_FEATURE_DOTPROD, so this never produces an undefined symbol.
//
// Floor rationale:
//   armv8.2-a is the floor that introduced dotprod + fp16 vector arithmetic.
//   i8mm arrived at armv8.6-a and is NOT in the default floor. The
//   __ARM_FEATURE_* kernel self-guards are compile-time macros, not runtime
//   checks — `-march=...+i8mm` defines __ARM_FEATURE_MATMUL_INT8
//   unconditionally, so smmla lands ungated in the quantized matmul kernels.
//   Device-proven SIGILL (exit 132) on a physical Pixel 6a (Tensor G1 —
//   /proc/cpuinfo has asimddp, no i8mm): pure-CPU decode, the ASR q4_K matmul
//   path, and the clip/mmproj encoder all crash, i.e. every Tensor G1/G2
//   phone (Pixel 6/6a/6 Pro/7). The Pixel 9a (Tensor G4, has i8mm) is why
//   9a-only verification never caught it. Keep i8mm as an explicit opt-in
//   (ELIZA_ANDROID_ARM64_I8MM=1) for controlled perf runs on devices known to
//   support it. Devices below armv8.2-a (pre-2017 SoCs) are not a target; if
//   that changes, switch to the GGML_CPU_ALL_VARIANTS=ON + GGML_BACKEND_DL=ON
//   runtime-dispatch route (as the riscv64 build already does) instead of
//   lowering this floor.

/**
 * The fixed Android arm64-v8a SIMD architecture string passed to
 * `-DGGML_CPU_ARM_ARCH=`. Exported for tests / logging.
 */
export const ANDROID_ARM64_CPU_ARCH = "armv8.2-a+dotprod+fp16";
export const ANDROID_ARM64_CPU_ARCH_I8MM = "armv8.2-a+dotprod+fp16+i8mm";

/**
 * CMake `-D` flags that raise an Android arm64-v8a fork build from the bare
 * armv8-a baseline to the armv8.2-a+dotprod+fp16+i8mm floor AND turn on the
 * QJL NEON-dotprod dispatch define.
 *
 * Returns an empty array for any non-arm64 ABI so callers can splat it
 * unconditionally (mirrors the x86_64BuildFlags / riscv64BuildFlags pattern
 * in compile-libllama.mjs).
 *
 * @param {string} abi - Android ABI directory name ("arm64-v8a", "x86_64", "riscv64").
 * @returns {string[]}
 */
export function androidArm64SimdCmakeFlags(abi) {
  if (abi !== "arm64-v8a") return [];
  const arch =
    process.env.ELIZA_ANDROID_ARM64_I8MM?.trim() === "1"
      ? ANDROID_ARM64_CPU_ARCH_I8MM
      : ANDROID_ARM64_CPU_ARCH;
  return [
    `-DGGML_CPU_ARM_ARCH=${arch}`,
    // Flip the QJL_HAVE_NEON_DOTPROD dispatch define (ggml-cpu/CMakeLists.txt
    // ~L161). Without this the live dotprod kernel body compiles but the QJL
    // dispatcher never routes to it.
    "-DGGML_USE_DOTPROD=ON",
  ];
}
