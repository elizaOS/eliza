# `verify/` harness extension roadmap

This is the implementation plan for taking the `verify/` harness from its
current state (Metal: 5/5 shaders verified on M4 Max; Vulkan: 3/5 turbo*
shaders verified on Intel ARL + lavapipe; QJL/Polar Vulkan + every other
backend: unverified) to full coverage of the device matrix declared in
[`../DEVICE_SUPPORT_GAP_2026-05-10.md`](../DEVICE_SUPPORT_GAP_2026-05-10.md).

For each unverified backend × kernel combo: the bind-set / fixture /
host change required, with file-path pointers and effort estimate.

The shape of a "verifier" in this directory is fixed:

1. Read a JSON fixture (kernel name, integer shape params, raw input
   buffers as JSON byte/float arrays, expected scalar output array).
2. Allocate device buffers matching the shader's bind-set.
3. Upload inputs.
4. Bind pipeline + descriptor set, push constants, dispatch.
5. Read back outputs.
6. Diff against `expected_scores` with the per-kernel tolerance
   (currently 1e-3 abs).
7. Print PASS/FAIL count and exit non-zero on any FAIL.

`gen_fixture.c` builds the fixtures by calling the C reference impls in
`../reference/turbo_kernels.c` and `qjl_polar_ref.c`. **Same C
references are the source of truth for every backend's fixtures** — so
"add backend X" is bind-set work, not new reference work.

---

## Extension 1 — Vulkan QJL bind-set

**Status:** blocks every Vulkan device for the QJL kernel.

**Current state.** `vulkan_verify.cpp:268–315` hard-codes:

- 3 storage buffers (4 if `kernel == "turbo3_tcq"` for the codebook),
- a single `TurboPushConstants{ uint head_dim; uint n_kv; uint blocks_per_kv; }`
  push range,
- workgroup count `= n_kv`.

The QJL shader [`../vulkan/qjl.comp`](../vulkan/qjl.comp) wants:

- `binding=0 q_sketch[n_heads * 256]` (fp32, host pre-projected)
- `binding=1 packed_k[n_kv_heads * n_tokens * 34_bytes]` as a uint stream
  (std430 forces 4-byte alignment; the 34-byte block is read byte-by-byte)
- `binding=2 scores[n_heads * n_tokens]` fp32 out
- push constant `Push { uint n_heads; uint n_kv_heads; uint n_tokens; uint proj_dim; }`
  (`proj_dim` MUST be 256)
- workgroup dispatch `= (n_heads, n_tokens, 1)` — one threadgroup per
  output cell, 32 lanes per group, shared-mem tree reduction.

**What to do.**

1. In `vulkan_verify.cpp`, branch the bind-set count, buffer sizes, push
   constant struct, and dispatch dimensions on `fx.kernel`. Three
   variants today (turbo / turbo_tcq / new-qjl); the cleanest shape is a
   small `KernelBindings` struct that the parser fills in based on
   `fx.kernel`.
2. Extend the JSON fixture schema with the new shape fields:
   `n_heads`, `n_kv_heads`, `n_tokens`, `proj_dim`, plus the input
   blobs `q_sketch` (float array of `n_heads*proj_dim`) and `packed_k`
   (byte array of `n_kv_heads*n_tokens*34`).
3. Extend `gen_fixture.c` to call `qjl_score_qk_ref` from
   `qjl_polar_ref.c` with deterministic seed inputs and emit the new
   fixture shape. (The function already exists; this is a `printf` JSON
   serializer, not new math.)
4. Tolerance: 1e-3 abs (matches current turbo path; the M4 Max Metal
   max diff was 1.1e-5, well inside).

**Effort:** S (3-4h: ~50 LOC of harness branching, ~80 LOC of fixture
serialization).

**Hosts:** runs on any Vulkan-capable host — Intel ARL +
Mesa/lavapipe gives the same coverage as the verified turbo* path. Same
host can drive Adreno/Mali via cross-compile + `adb push`.

---

## Extension 2 — Vulkan Polar bind-set

**Status:** blocks every Vulkan device for the PolarQuant kernel.

**Current state.** Same as #1 — bind-set hard-coded for turbo.

The Polar shader [`../vulkan/polar.comp`](../vulkan/polar.comp) wants:

- `binding=0 k_blocks[n_rows * 82_bytes]` as a uint stream (fp16 norm +
  64 nibble bytes + 16 QJL residual bytes per block)
- `binding=1 q[head_dim]` fp32
- `binding=2 y[n_rows]` fp32 out
- push constant `Push { uint n_rows; uint head_dim; uint use_qjl; }`
  (`head_dim` MUST be 128)
- workgroup dispatch `= (n_rows, 1, 1)`

**What to do.**

1. Add a third branch in the same `KernelBindings` switch from #1.
2. Extend the JSON fixture schema with `n_rows`, `head_dim`, `use_qjl`,
   `q` (`head_dim` floats), `k_blocks` (`n_rows*82` bytes).
3. Extend `gen_fixture.c` to call `polar_dot_ref` from
   `qjl_polar_ref.c` and emit two fixture variants:
   - `polar_no_qjl.json` (`use_qjl=0`, optional residual omitted)
   - `polar_with_qjl.json` (`use_qjl=1`, residual exercised)
4. Tolerance: 1e-3 abs. Metal max diff on M4 Max was 7.6e-6.

**Effort:** S (3-4h once #1's `KernelBindings` shape exists; <100 LOC
incremental).

**Hosts:** any Vulkan host. Same cross-compile path covers Adreno /
Mali / NVIDIA / AMD / Intel.

---

## Extension 3 — `cuda_verify` (new harness)

**Status:** blocks `desktop-9b`, `pro-27b`, `server-h200` from claiming
CUDA backend verification per AGENTS.md §8.

**Current state.** No CUDA verifier exists in `verify/`. The
v0.4.0-milady fork ships W4-B CUDA QJL/Polar/TBQ3_TCQ kernels, but no
parity check confirms they produce the same numbers as the C reference
or the Metal/Vulkan ports.

**What to do.**

1. New file `verify/cuda_verify.cu` — same JSON fixture parser
   (factor out of `vulkan_verify.cpp` into a tiny `fixture.h` header),
   `cudaMalloc` for each bind-set buffer, `cudaMemcpy`, kernel launch
   via the fork's CUDA entry points (`turbo-quant-cuda.cuh`,
   `qjl_quant_kernel.cu`, etc. — see
   [`../README.md` line 74, 84](../README.md) for the file pointers).
2. Add a `cuda` target to `verify/Makefile` keyed off `nvcc` presence.
3. Same JSON fixtures as the Vulkan/Metal harnesses — no new fixture
   files needed once #1 + #2 land.
4. Tolerance: 1e-3 abs initially; tighten once we have on-host runs.

**Effort:** M (1-2 days: harness scaffolding ~200 LOC, plus glue to
the fork's launch wrappers).

**Hosts:** any L4/T4/A10G EC2 instance, or a developer workstation
with an RTX 30/40-series card. CI-runnable via GitHub-Actions
GPU-runner or the existing device-lab.

---

## Extension 4 — Adreno on-device runner

**Status:** blocks `mobile-1_7b` Vulkan claim on Snapdragon devices
(Pixel 8/9, Galaxy S23/24/25).

**Current state.** No on-device runner. `vulkan_verify` is a
desktop/lavapipe binary; cross-compile against the NDK Vulkan headers
already works (the cmake flags in
[`../../app-core/scripts/build-llama-cpp-dflash.mjs:670–689`](../../app-core/scripts/build-llama-cpp-dflash.mjs)
do exactly this for `android-arm64-vulkan`), but the `verify/Makefile`
doesn't have an `android-vulkan` recipe.

**What to do.**

1. Add an `android-vulkan` recipe to `verify/Makefile` that
   cross-compiles `vulkan_verify` against the NDK toolchain
   (`$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake`).
2. Document the `adb push` steps:
   `adb push vulkan_verify *.spv fixtures/ /data/local/tmp/eliza-kernels/`
   then `adb shell "cd /data/local/tmp/eliza-kernels && ./vulkan_verify
   qjl.spv fixtures/qjl.json"`.
3. Same SPIR-V, same fixtures — Adreno's vendor Vulkan driver consumes
   identical SPV.

**Effort:** S (1 day, half is procuring a device).

**Hosts:** Pixel 8/9 (Adreno 730/740) or Galaxy S24/25 (Adreno 750/830).

---

## Extension 5 — Mali on-device runner

**Status:** blocks `mobile-1_7b` Vulkan claim on Tensor / non-Snapdragon
Galaxy / MediaTek devices.

**Current state.** Same as #4. Mali's subgroup behavior differs from
Adreno; W4-A's shared-mem tree reduction is supposed to sidestep that,
but it has not been observed on Mali.

**What to do.** Identical to #4 — same binary, same fixtures, different
phone.

**Effort:** S (same as #4).

**Hosts:** Pixel 6/7 (Tensor G1/G2 — Mali-G78/G710), or any
Exynos-based Galaxy.

---

## Extension 6 — iOS on-device runner

**Status:** blocks `lite-0_6b` and `mobile-1_7b` Metal claim on iOS
hardware. **Has a hard prerequisite:** the `ios-arm64-metal` archive
must actually be linked into the app first (see
[`../DEVICE_SUPPORT_GAP_2026-05-10.md`](../DEVICE_SUPPORT_GAP_2026-05-10.md)
blocker #1).

**Current state.** `metal_verify.mm` is a CLI binary that links
`-framework Metal` — it does not run on iOS where there is no shell.

**What to do.**

1. Once blocker #1 is fixed, create a tiny iOS XCTest target that
   embeds the same `metal_verify` logic as a unit test:
   `verify/ios-xctest/MetalVerifyTests.m` (or .swift).
2. Reuse the JSON fixtures verbatim — bundle them into the test target.
3. Run via `xcodebuild test -scheme MetalVerifyTests
   -destination "platform=iOS,name=…"`.

**Effort:** M (2-3 days assuming someone else has fixed blocker #1).

**Hosts:** any iPhone 14 / iPad M-series.

---

## Extension 7 — `linux-aarch64-cuda` (GH200) target + verify

**Status:** blocks `server-h200` tier entirely (no target exists today).

**Current state.** `SUPPORTED_TARGETS` in
[`../../app-core/scripts/build-llama-cpp-dflash.mjs:82`](../../app-core/scripts/build-llama-cpp-dflash.mjs)
has no `linux-aarch64-*` triple. `parseTarget` would happily split
`linux-aarch64-cuda` into the right shape, but the array doesn't
include it.

**What to do.**

1. Add `"linux-aarch64-cuda"` and `"linux-aarch64-cpu"` to
   `SUPPORTED_TARGETS`.
2. In `cmakeFlagsForTarget`, the cuda branch needs
   `-DCMAKE_SYSTEM_PROCESSOR=aarch64` (when arch=aarch64) and
   `-DCMAKE_CUDA_ARCHITECTURES=90a` (Hopper / H100/H200) — today there
   is no `CMAKE_CUDA_ARCHITECTURES` pin at all, so the build picks
   whatever the build host has, which on a non-GPU host is `sm_52`.
3. Once the target builds, run the new `cuda_verify` (#3) on the GH200.

**Effort:** M for the build target (1-2 days), S for the verify run
once the binary exists. The GH200 itself is the rate-limiter.

**Hosts:** any aarch64 host with H100/H200 (GH200 superchip, or any
Grace + Hopper PCIe board).

---

## Extension 8 — AMD ROCm verify

**Status:** blocks `desktop-9b`, `pro-27b` from claiming ROCm parity
even on hosts where the build target compiles.

**Current state.** `linux-x64-rocm` builds when `hipcc`/`rocminfo` is
present, but the W4-B QJL/Polar/TBQ3_TCQ kernels are CUDA-only — they
hipify on the fly via the standard llama.cpp HIP machinery, but no
parity check confirms the hipified versions match the CUDA originals.

**What to do.**

1. Hipify `cuda_verify.cu` from #3 (one `hipify-perl` invocation).
2. Add a `rocm` recipe to `verify/Makefile`.
3. Same JSON fixtures.
4. Add `-DCMAKE_HIP_ARCHITECTURES="gfx942;gfx1100"` (MI300 + RX 7900)
   to the rocm branch in `cmakeFlagsForTarget` — currently no arch
   pin.

**Effort:** S once #3 exists (~1 day). M of "find an MI300 host."

**Hosts:** AMD MI250/MI300 (cloud rentable), or RX 7900 XTX (any
Strix-class workstation).

---

## Extension 9 — Windows on-device runner (x64 + arm64)

**Status:** blocks `desktop-9b` claim on the Windows half of the
desktop tier.

**Current state.** `windows-x64-cpu` and `windows-x64-cuda` cross-build
from Linux via mingw, but the produced `.exe` has never been observed
running on Windows. `windows-arm64-*` doesn't exist as a triple.

**What to do.**

1. Run the existing `vulkan_verify.exe` (cross-compiled from the
   `windows-x64-vulkan` target — also doesn't exist yet, add it) on a
   Windows host with any GPU.
2. For arm64: add `windows-arm64-cpu` and `windows-arm64-vulkan` to
   `SUPPORTED_TARGETS`, run on a Snapdragon X Elite Copilot+ PC.

**Effort:** S for x64 (1 day if a Windows box is available); M for
arm64 (toolchain wiring + device).

**Hosts:** any Windows 11 box for x64; Surface Pro 11 / Galaxy Book4
Edge for arm64.

---

## Extension 10 — WebGPU port (out of scope for ship-1)

**Status:** no shaders, no harness, no target. Listed for completeness.

**What it would take:** WGSL ports of all five kernels (turbo3, turbo4,
turbo3_tcq, qjl, polar), a Dawn-based or browser-side fixture runner,
and a new "webgpu" backend in the manifest backend matrix. Scope:
weeks-to-months. Defer until upstream llama.cpp WebGPU lands and a
product driver appears.

---

## Sequencing recommendation

The cheapest order that unlocks the most tier×backend cells:

1. **#1 + #2** (Vulkan QJL/Polar bind-set) — half a day each, unblocks
   every non-Metal backend's qjl + polar verification on the existing
   Intel-ARL + lavapipe host.
2. **#4 + #5** (Adreno + Mali on-device) — once #1 + #2 are green,
   pushing the same binaries to a phone is mostly device-procurement
   time.
3. **#3** (`cuda_verify`) — unlocks the entire CUDA half of the matrix
   in one sweep.
4. **#7** (`linux-aarch64-cuda`) — depends on #3.
5. **#8** (ROCm) — depends on #3 (hipified copy).
6. **iOS blocker #1 in DEVICE_SUPPORT_GAP_2026-05-10.md, then #6** —
   higher product impact than #4/#5 but blocked on the build-script
   plumbing that isn't a `verify/` change.
7. **#9** (Windows) and **#10** (WebGPU) — defer.

Total wall-clock to "every cell in the matrix has at least a verify
result on real hardware" is roughly **3–4 weeks** of harness +
device-lab work, gated by hardware availability not by harness
complexity. The harness itself is small.
