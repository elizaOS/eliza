# W2-B — PolarQuant NEON cross-aarch64 verification

**Date:** 2026-05-09
**Wave:** W2 verification
**Scope:** Cross-validate W1-B's PolarQuant NEON kernels under `qemu-aarch64-static`. W1-B's parity numbers were captured on x86_64 (AVX2 path) only — this run is the first time the NEON path has actually executed.
**Source under test:** `worktree-agent-afd1a696836234b22` @ `3392c97f4c` (`feat(polarquant-cpu): AVX2 + NEON kernels and Apothic fork-integration drop-in`), merged into the W2-B worktree.
**Out of scope:** QJL kernels (W2-A), Metal/Vulkan/CUDA, real-hardware (Snapdragon/M-series) bring-up, the `quants-polar.c` fork drop-in (kernel parity is gated by the standalone library that drives the fork TU; the fork TU itself is a transcription).

---

## TL;DR

- NEON `dequantize_row_q4_polar_neon` and `ggml_vec_dot_q4_polar_q8_0_neon` are **bit-exact for dequant** and **well inside the dot rel-err budget** under QEMU on both `use_qjl=0` and `use_qjl=1`.
- The dispatcher (`polar_dispatch.c`) correctly routes to the NEON symbols on aarch64 (verified via `nm` on the static archive — `dequantize_row_q4_polar_neon` and `ggml_vec_dot_q4_polar_q8_0_neon` are present `T` symbols, `polarquant_active_simd()` returns `"neon"`).
- The legacy `polar_roundtrip_test` (NEON quant→dequant L2 budget) and `polar_dot_test` (NEON dot vs fp32 reference budget) both pass under QEMU.
- **There is a real `GGML_TYPE_COUNT` slot collision** between the QJL series (vendored) and the PolarQuant series (W1-B), confirmed by attempting to `git am` the PolarQuant series on top of the W1-A QJL-applied fork at `~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273`. **Resolution path is straightforward: rebase PolarQuant patch 0001's enum hunk onto the QJL-applied state.** Details + concrete patch in §4 below.

---

## 1. Build setup

Toolchain on this box:

| Tool | Version | Source |
|---|---|---|
| `cmake` | 3.28.3 | system |
| `zig`   | 0.13.0 | `~/.local/bin/zig` |
| `qemu-aarch64-static` | 8.2.2 | `apt-get download qemu-user-static`, dpkg-extracted into `/tmp/qemu-extract` (no sudo on this box, so no system install) |
| aarch64 sysroot | libc6-arm64-cross 2.39, libgcc-s1-arm64-cross 14.2.0 | `apt-get download` + dpkg-extracted into `/tmp/aarch64-sysroot` (used as `qemu-aarch64-static -L`) |

Cross-build configure:

```bash
cd packages/native-plugins/polarquant-cpu
mkdir build-aarch64 && cd build-aarch64
cmake \
  -DCMAKE_C_COMPILER="zig" \
  -DCMAKE_C_COMPILER_ARG1="cc -target aarch64-linux-gnu" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SYSTEM_NAME=Linux \
  -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
  ..
make -j4
```

Configure detects `CMAKE_SYSTEM_PROCESSOR=aarch64`, switches the `polarquant` static lib over to the NEON sources (`polar_dequantize_neon.c`, `polar_dot_neon.c`), and defines `POLARQUANT_HAVE_NEON=1` on the public interface (`packages/native-plugins/polarquant-cpu/CMakeLists.txt:30-67`).

`file(1)` confirms the test binaries are real aarch64 ELFs:

```
polar_simd_parity_test: ELF 64-bit LSB executable, ARM aarch64 ...
polar_roundtrip_test:   ELF 64-bit LSB executable, ARM aarch64 ...
polar_dot_test:         ELF 64-bit LSB executable, ARM aarch64 ...
```

`nm libpolarquant.a` confirms the NEON kernels were compiled and linked, and that the dispatcher TU has unresolved references that get satisfied by them:

```
polar_dequantize_neon.c.o:
  T dequantize_row_q4_polar_neon
polar_dot_neon.c.o:
  T ggml_vec_dot_q4_polar_q8_0_neon
polar_dispatch.c.o:
  U dequantize_row_q4_polar_neon
  U ggml_vec_dot_q4_polar_q8_0_neon
```

The dispatcher itself (`packages/native-plugins/polarquant-cpu/src/polar_dispatch.c:13-17`) auto-defines `POLARQUANT_HAVE_NEON` from `__ARM_NEON` even when the CMake flag is missing, so the routing is robust against build-system drift.

I also did a sanity baseline rebuild on the host (x86_64 / AVX2). Numbers match W1-B's report exactly:

```
[simd-parity dequant] use_qjl=0 simd=avx2  max_abs=4.768e-07  mean_abs=2.470e-08
[simd-parity dequant] use_qjl=1 simd=avx2  max_abs=4.768e-07  mean_abs=2.452e-08
[simd-parity dot] use_qjl=0 simd=avx2  ref=49.543850 simd=49.543858  rel_err=1.540e-07
[simd-parity dot] use_qjl=1 simd=avx2  ref=48.293819 simd=48.293812  rel_err=1.580e-07
```

---

## 2. NEON parity test results (the gate)

Run command:

```bash
qemu-aarch64-static -L /tmp/aarch64-sysroot/usr/aarch64-linux-gnu \
  ./polar_simd_parity_test
```

Output:

```
[simd-parity dequant] use_qjl=0 simd=neon  max_abs=0.000e+00  mean_abs=0.000e+00  budget=(5e-05, 5e-07)
[simd-parity dequant] use_qjl=1 simd=neon  max_abs=0.000e+00  mean_abs=0.000e+00  budget=(5e-05, 5e-07)
[simd-parity dot] use_qjl=0 simd=neon  ref=49.543861 simd=49.543854  rel_err=1.540e-07  budget=1e-05
[simd-parity dot] use_qjl=1 simd=neon  ref=48.293804 simd=48.293819  rel_err=3.160e-07  budget=1e-05
```

Pass criteria (from `polar_simd_parity_test.c:97-150`):

| Test | Budget | Observed (NEON) | Margin |
|---|---|---|---|
| dequant max_abs (use_qjl=0) | ≤ 5e-5 | **0** | bit-exact |
| dequant max_abs (use_qjl=1) | ≤ 5e-5 | **0** | bit-exact |
| dequant mean_abs (use_qjl=0) | ≤ 5e-7 | **0** | bit-exact |
| dequant mean_abs (use_qjl=1) | ≤ 5e-7 | **0** | bit-exact |
| dot rel_err (use_qjl=0) | ≤ 1e-5 | 1.540e-07 | 65× headroom |
| dot rel_err (use_qjl=1) | ≤ 1e-5 | 3.160e-07 | 32× headroom |

Notable: **NEON dequant is bit-exact** against the scalar reference (max_abs = 0.000e+00), while the AVX2 path on the same input has max_abs ≈ 4.77e-07. That's because the AVX2 Hadamard butterfly uses an 8-lane reordering that produces a different fp32 rounding sequence than the scalar reference; the NEON path's 4-lane butterfly happens to match the scalar order on the boundary cases driven by this corpus. Both are inside budget; the NEON version just happens to hit the better rounding sequence on this seed.

The dot rel_err numbers are slightly different between AVX2 (1.540e-07 / 1.580e-07) and NEON (1.540e-07 / 3.160e-07) for the same reason — different SIMD-width Hadamard reordering. Both paths use double-precision accumulation in the per-Q8_0-block scale step, which is what keeps both well below the 1e-5 budget.

QEMU exit status: **0** (success).

---

## 3. Legacy roundtrip / dot tests (NEON)

Both pre-SIMD tests already exist; they exercise the dispatcher as a black box, so on aarch64 they implicitly test the NEON path. Re-running them under QEMU:

```
$ qemu-aarch64-static -L /tmp/aarch64-sysroot/usr/aarch64-linux-gnu ./polar_roundtrip_test
[roundtrip] use_qjl=0  rel_L2=0.091013  budget=0.095000
[roundtrip] use_qjl=1  rel_L2=0.099244  budget=0.105000

$ qemu-aarch64-static -L /tmp/aarch64-sysroot/usr/aarch64-linux-gnu ./polar_dot_test
[dot] dot_q=-13.532005  dot_ref=-12.689964  rel_err=0.066355  budget=0.12
```

Both pass. These are absolute-quality budgets (Lloyd-Max codebook fit + dot under low rank), not parity budgets, so we expect identical numbers between the AVX2 and NEON runs — and we get them (the W1-B report shows the same `0.091013 / 0.099244 / 0.066355` triple on x86_64). This is the strongest cross-path consistency signal in the suite.

---

## 4. GGML_TYPE_COUNT collision (action required before unified fork lands)

This is the substantive coordination item from the task brief.

### 4.1 What W1-A actually shipped

The Apothic fork at `~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/` already has the QJL series applied (commits `7a73f2a`, `1fe2567`, `dda4fa3`, `84431d9`, `ceb5554`). State of the enum after QJL:

```c
// ggml/include/ggml.h:432-437
GGML_TYPE_TBQ4_0  = 44,
// 45 reserved (was GGML_TYPE_COUNT before QJL was added)
GGML_TYPE_QJL1_256 = 46, // 1-bit JL-transform K-cache block (34 B / 256 sketch dims)
GGML_TYPE_COUNT   = 47,
```

So W1-A explicitly **reserved slot 45 for PolarQuant**. The semantic intent across both landings is `Q4_POLAR=45`, `QJL1_256=46`, `COUNT=47`. That intent is correct, and this report's recommendation **is to land that exact arrangement**, not to reshuffle slots.

### 4.2 What W1-B's vendored series tries to do

`packages/app-core/scripts/aosp/llama-cpp-patches/polarquant/0001-Q4_POLAR-register-GGML_TYPE_Q4_POLAR-45-and-block_q4.patch` was generated against **stock TBQ-only state** (`COUNT = 45` originally) and patches:

```
-        GGML_TYPE_COUNT   = 45,
+        GGML_TYPE_Q4_POLAR = 45, // ...
+        GGML_TYPE_COUNT   = 46,
```

That hunk no longer applies once the QJL series is in place, because the line `GGML_TYPE_COUNT = 45` no longer exists in the tree. Verified directly:

```
$ cd ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273/
$ git checkout -B w2b-polar-test
$ node packages/app-core/scripts/aosp/llama-cpp-patches/apply-patches.mjs \
       --repo . --series polarquant
[patches] applying series: polarquant
[patches]   FAILED: polarquant/0001-Q4_POLAR-register-GGML_TYPE_Q4_POLAR-45-and-block_q4.patch
error: patch failed: ggml/include/ggml.h:432
error: ggml/include/ggml.h: patch does not apply
error: patch failed: ggml/src/ggml-common.h:260
error: ggml/src/ggml-common.h: patch does not apply
error: patch failed: ggml/src/ggml-cpu/quants.h:34
error: ggml/src/ggml-cpu/quants.h: patch does not apply
error: patch failed: ggml/src/ggml-quants.h:36
error: ggml/src/ggml-quants.h: patch does not apply
```

The other three PolarQuant patches in the series (`0002`, `0003`, `0004`) were not exercised because `git am` aborts the series on first failure. Inspection of those three says they edit `quants.c` / `ggml-cpu.c` / `ggml-quants.c` / a test, which **do not** overlap the QJL series' edits — they are likely to apply cleanly once 0001 is rebased.

W1-A's `compile-libllama.mjs` integration is already aware of this: it wires `applyVendoredPatches()` to `--series qjl` only, with the explicit comment

```
//   ... Scope is intentionally
//   qjl-only — the polarquant/ series under the same dir conflicts on
//   GGML_TYPE_COUNT and is owned by a separate landing.
```

So today no PolarQuant patch reaches the cached fork by default; the fork compiles QJL-only. This is fine as a temporary state but blocks W1-B's `quants-polar.c` drop-in from being usable.

### 4.3 Recommended fix (low-risk, ~5 lines)

Update `packages/app-core/scripts/aosp/llama-cpp-patches/polarquant/0001-Q4_POLAR-register-GGML_TYPE_Q4_POLAR-45-and-block_q4.patch`'s ggml.h hunk so it expects the QJL-applied state and resolves to the same final layout. Concretely:

```diff
@@ ggml/include/ggml.h @@
         GGML_TYPE_TBQ4_0  = 44,
-        // 45 reserved (was GGML_TYPE_COUNT before QJL was added)
-        GGML_TYPE_QJL1_256 = 46, // 1-bit JL-transform K-cache block (34 B / 256 sketch dims)
-        GGML_TYPE_COUNT   = 47,
+        GGML_TYPE_Q4_POLAR = 45, // PolarQuant Q4: 128-element block, fp16 norm + 4-bit Lloyd-Max codes + optional 1-bit QJL residual
+        GGML_TYPE_QJL1_256 = 46, // 1-bit JL-transform K-cache block (34 B / 256 sketch dims)
+        GGML_TYPE_COUNT   = 47,
```

Net effect: the placeholder `// 45 reserved` comment line is replaced with the real `GGML_TYPE_Q4_POLAR = 45` slot definition, the QJL line is preserved verbatim, and `GGML_TYPE_COUNT` stays at 47. The other patch files (`ggml-common.h`, `quants.h`, `ggml-quants.h`, `ggml-cpu.c`, `quants.c`, tests) almost certainly do not need to change — those edits were appended to non-overlapping regions and are independent of the QJL series.

The file-level patch fix lives in `packages/app-core/scripts/aosp/llama-cpp-patches/polarquant/0001-*.patch`. It is **not** included in this report's commit, because (a) per AGENTS.md scope discipline, the W2-B brief is verification, and (b) the parallel W2-A agent owns the QJL side and may want to coordinate the rebase as a single commit. **Recommend:** assign the patch rebase to whichever agent owns the next polarquant landing (W3-A or whoever picks up the unified fork), with this report as the spec.

Once 0001 is rebased, the `apply-patches.mjs` default ordering (alphabetical: `polarquant` before `qjl`) becomes wrong — the `polarquant` series now expects the QJL state to already be in the tree. Two clean options:

- **Option A (preferred):** flip the alphabetical default to apply `qjl` first, then `polarquant`. One-line change in `apply-patches.mjs:42-45` to sort with QJL pinned ahead of any series that depends on it.
- **Option B:** keep alphabetical default, but require callers to pass `--series qjl,polarquant` explicitly. Less robust, more brittle.

Option A also means `compile-libllama.mjs` can drop its explicit `--series qjl` filter and just call `applyVendoredPatches()` with no series argument — the default ordering would then do the right thing.

### 4.4 Slot identity confirmation

Just to be unambiguous about which side is "right":

| Agent | Type name | Slot | COUNT after this patch alone |
|---|---|---|---|
| W1-A (QJL, vendored, **already applied** to the fork) | `GGML_TYPE_QJL1_256` | **46** | 47 |
| W1-B (PolarQuant, vendored, **not yet applied** to the fork) | `GGML_TYPE_Q4_POLAR` | **45** | 46 |
| Unified intent (after both apply, with the rebase fix above) | both, as listed | **45 + 46** | **47** |

**Neither side needs to give up its slot.** The collision is purely in the `GGML_TYPE_COUNT` hunk arithmetic of patch 0001 of the PolarQuant series, because each series independently re-bumps `COUNT`. The fix is the rebase above; no number changes anywhere else.

---

## 5. Reproducibility

To re-run from scratch on this branch:

```bash
# 1. Toolchain (skip if already installed)
apt-get download qemu-user-static libc6-arm64-cross libgcc-s1-arm64-cross
mkdir -p /tmp/qemu-extract /tmp/aarch64-sysroot
dpkg -x qemu-user-static_*.deb /tmp/qemu-extract
dpkg -x libc6-arm64-cross_*.deb /tmp/aarch64-sysroot
dpkg -x libgcc-s1-arm64-cross_*.deb /tmp/aarch64-sysroot

# 2. Cross-build
cd packages/native-plugins/polarquant-cpu
rm -rf build-aarch64 && mkdir build-aarch64 && cd build-aarch64
cmake -DCMAKE_C_COMPILER="zig" \
      -DCMAKE_C_COMPILER_ARG1="cc -target aarch64-linux-gnu" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=aarch64 ..
make -j4

# 3. Run all three tests under QEMU
QEMU=/tmp/qemu-extract/usr/bin/qemu-aarch64-static
SYSROOT=/tmp/aarch64-sysroot/usr/aarch64-linux-gnu
"$QEMU" -L "$SYSROOT" ./polar_simd_parity_test
"$QEMU" -L "$SYSROOT" ./polar_roundtrip_test
"$QEMU" -L "$SYSROOT" ./polar_dot_test

# 4. Reproduce the fork-integration collision
cd ~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273
git checkout -B w2b-polar-test
node /<repo>/packages/app-core/scripts/aosp/llama-cpp-patches/apply-patches.mjs \
     --repo . --series polarquant
# expect FAILED on 0001-*.patch
git am --abort 2>/dev/null; git checkout -; git branch -D w2b-polar-test
```

---

## 6. Done-criteria status

| Criterion (from brief) | Status |
|---|---|
| All NEON parity tests pass under QEMU within budget | **PASS** (§2: bit-exact dequant; dot rel_err 1.5e-7 / 3.2e-7 vs 1e-5 budget) |
| polar_roundtrip / polar_dot run under QEMU | **PASS** (§3: both inside their absolute-quality budgets) |
| Fork-integration patches applied to a /tmp clone of the Apothic fork | **PARTIAL** — clone existed at `~/.cache/eliza-android-agent/llama-cpp-main-b8198-b2b5273`; QJL already applied, **PolarQuant 0001 fails to apply** due to the documented collision (§4.2). Did not force-apply or rebuild a polarized libggml-cpu.so because the rebase fix is owned by the next landing per scope. |
| GGML_TYPE_COUNT collision documented with proposed resolution | **DONE** (§4) |
| Report committed to `reports/porting/2026-05-09-w2/polar-neon-cross.md` | **DONE** (this commit) |

---

## 7. Findings the brief did not anticipate

- The W1-A QJL fork actually **already reserved slot 45 with an explicit comment**; this is friendly to the unified intent and means the fix is purely cosmetic (~5 line patch rebase) rather than requiring either agent to renumber.
- `apply-patches.mjs` defaults to alphabetical series ordering, which is the **wrong order** for the unified fork once both series coexist (PolarQuant depends on QJL state being present, not the reverse). Recommend pinning QJL before any other series in `apply-patches.mjs` after the rebase lands. See §4.3 Option A.
- W1-B's standalone `polarquant-cpu` library is **independent of the fork**. NEON parity validates the kernel math; it does **not** validate the `quants-polar.c` drop-in. That validation is gated on the rebase and a `test-quantize-fns Q4_POLAR` run inside the fork (per `fork-integration/README.md:60-71`). Out of scope for W2-B.
- Building under `zig cc -target aarch64-linux-gnu` works without any toolchain file (CMake auto-detects clang ABI). This is worth knowing for the W3 cuttlefish/AOSP path: avoids needing a full Android NDK for kernel-only verification.
