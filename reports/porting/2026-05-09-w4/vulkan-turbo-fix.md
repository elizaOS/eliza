# Wave-4 Agent A — Vulkan turbo3 / turbo4 / turbo3_tcq hardware fix

**Date:** 2026-05-09
**Scope:** Fix the source-level subgroup-size assumption W3-E identified in
the three turbo* Vulkan shaders so they pass on real GPUs, then flip the
build-script patch hook default-on and update the verification matrix.

## TL;DR

| Kernel             | Pre-fix Intel ARL | Pre-fix lavapipe | Post-fix Intel ARL | Post-fix lavapipe |
|--------------------|-------------------|------------------|--------------------|-------------------|
| `turbo3.comp`      | 0/8 PASS          | 0/8 PASS         | **8/8 PASS**       | **8/8 PASS**      |
| `turbo4.comp`      | 0/8 PASS          | 0/8 PASS         | **8/8 PASS**       | **8/8 PASS**      |
| `turbo3_tcq.comp`  | 0/8 PASS          | 0/8 PASS         | **8/8 PASS**       | **8/8 PASS**      |

Maximum absolute diff on the post-fix runs is 6.7e-6 — well under the
1e-3 fixture tolerance, and consistent with single-precision rounding of
the same shared-memory-tree reduction pipeline.

## Tooling used

- `glslc` (NDK shaderc v2022.3) at `~/Android/Sdk/ndk/29.0.13113456/shader-tools/linux-x86_64/glslc`
- `spirv-val` (same NDK bundle) — clean for all 3 fixed shaders against `--target-env vulkan1.1`
- System `libvulkan.so.1` 1.3.275 + Mesa 25.2.8 ICDs (`intel_icd.json`, `lvp_icd.json`)
- `verify/vulkan_verify` built against `~/.cache/eliza-dflash/vulkan-headers/include` (the no-LunarG-SDK Linux fallback path the Makefile already supports)

`vulkaninfo --summary` enumerates two devices on this host:

| Device | Driver | API | Subgroup support |
|---|---|---|---|
| Intel(R) Graphics (ARL) | DRIVER_ID_INTEL_OPEN_SOURCE_MESA (Mesa 25.2.8) | 1.4.318 | min/max/default = 8 / 32 / 32, `VK_EXT_subgroup_size_control` available |
| llvmpipe (LLVM 20.1.2) | DRIVER_ID_MESA_LLVMPIPE | 1.4.318 | (varies by SPV) |

## Root cause (recap of W3-E's diagnosis)

All three turbo shaders ended with:

```glsl
layout(local_size_x = 32, ...) in;
...
float sum = subgroupAdd(acc);
if (tid == 0u) scores[...] = sum;
```

`subgroupAdd` reduces only within the *subgroup*, not the workgroup. With
no `VkPipelineShaderStageRequiredSubgroupSizeCreateInfo` and no
`local_size_x_id` + `SubgroupSize` SPIR-V decoration, the driver picks
the subgroup size at pipeline creation. On Intel ARL that range is
[8, 32] and the runtime can split the 32-lane workgroup into multiple
8- or 16-lane subgroups; lane 0 of subgroup 0 then sees a partial sum
and writes it to `scores[]`. Lavapipe makes a different choice and
produces a *different* set of wrong values from the same fixture, which
is the fingerprint of a driver-chosen subgroup size meeting source code
that assumed a single 32-lane subgroup.

The original author had clearly intended the tree-reduction path:
`turbo3.comp` already declared `shared float partials[32]` and wrote
`partials[tid] = acc; barrier();` — but never read it back. The fix
finishes that work.

## The fix

Replace the broken `subgroupAdd` epilogue with a driver-portable 32-thread
shared-memory tree reduction. Same pattern as the new W3-E QJL / Polar
shaders (`reduce_sum_32` in `qjl.comp`):

```glsl
// 32-thread tree reduction over a workgroup-shared scratch. Driver-portable:
// does NOT depend on any specific subgroup size, unlike subgroupAdd (which is
// only correct when a single 32-lane subgroup covers the whole workgroup).
shared float partials[32];

float reduce_sum_32(float v, uint tid) {
    partials[tid] = v;
    barrier();
    for (uint stride = 16u; stride > 0u; stride >>= 1) {
        if (tid < stride) {
            partials[tid] += partials[tid + stride];
        }
        barrier();
    }
    return partials[0];
}
```

Costs 5 barriers vs 0, ~negligible (32 threads, one workgroup per
score, the per-thread decode/dot work dominates). Drops the
`#extension GL_KHR_shader_subgroup_arithmetic : require` line in all three
files (no longer needed).

## Diff (turbo3.comp, representative)

```diff
-#extension GL_KHR_shader_subgroup_arithmetic : require
-
 layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;

@@
-shared float partials[32];
+// 32-thread tree reduction over a workgroup-shared scratch. Driver-portable:
+// does NOT depend on any specific subgroup size, unlike subgroupAdd (which is
+// only correct when a single 32-lane subgroup covers the whole workgroup).
+// On Intel ARL minSubgroupSize=8, so subgroupAdd would silently under-reduce.
+shared float partials[32];
+
+float reduce_sum_32(float v, uint tid) {
+    partials[tid] = v;
+    barrier();
+    for (uint stride = 16u; stride > 0u; stride >>= 1) {
+        if (tid < stride) {
+            partials[tid] += partials[tid + stride];
+        }
+        barrier();
+    }
+    return partials[0];
+}

@@
-    partials[tid] = acc;
-    barrier();
-
-    // Subgroup reduction (assumes single warp = single workgroup of 32).
-    float sum = subgroupAdd(acc);
+    float sum = reduce_sum_32(acc, tid);
     if (tid == 0u) {
         scores[push.q_head * push.n_kv + kv_idx] = sum;
     }
```

`turbo4.comp` and `turbo3_tcq.comp` get the same treatment minus the
already-present `partials[32]` line (they didn't have the leftover
half-implementation).

## Pre-fix numerical baseline (the fingerprint)

Same fixture, same harness, same SPIR-V — different ICDs, different wrong
values. This is what proves it's source-side, not driver-side.

```
===== INTEL ARL (default) =====
turbo3 kv=0 expected=-5.811116 got=-7.542235 diff=1.731e+00 FAIL
turbo3 kv=1 expected=+8.761609 got=+3.726599 diff=5.035e+00 FAIL
turbo3 kv=5 expected=+13.341910 got=+1.805638 diff=1.154e+01 FAIL
turbo3 kv=7 expected=-0.558941 got=-2.723733 diff=2.165e+00 FAIL
[vulkan_verify] FAIL — 0/8 passed (tol=1e-03)

===== LAVAPIPE =====
turbo3 kv=0 expected=-5.811116 got=-0.804180 diff=5.007e+00 FAIL
turbo3 kv=1 expected=+8.761609 got=-2.039641 diff=1.080e+01 FAIL
turbo3 kv=5 expected=+13.341910 got=-2.150286 diff=1.549e+01 FAIL
turbo3 kv=7 expected=-0.558941 got=+8.032246 diff=8.591e+00 FAIL
[vulkan_verify] FAIL — 0/8 passed (tol=1e-03)
```

Full pre-fix output: `baseline-pre-fix.txt`.

## Post-fix numerical results

```
===== INTEL ARL (default) =====
turbo3:     [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 4.8e-06
turbo4:     [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 5.7e-06
turbo3_tcq: [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 6.7e-06

===== LAVAPIPE =====
turbo3:     [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 4.8e-06
turbo4:     [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 5.7e-06
turbo3_tcq: [vulkan_verify] PASS — 8/8 passed (tol=1e-03)  max diff 6.7e-06
```

Full post-fix output: `post-fix.txt`.

The two ICDs converge on the same numerical answer because they're now
running the same fully-deterministic reduction tree — there is no
driver-chosen subgroup width left in the kernel.

## Reproduction recipe

```bash
# Build SPV + harness (one-time per checkout):
export PATH="$HOME/Android/Sdk/ndk/29.0.13113456/shader-tools/linux-x86_64:$PATH"
cd packages/inference/verify
make vulkan-spirv
make vulkan

# Default ICD (whichever vulkaninfo lists first; on this host: Intel ARL):
./vulkan_verify ../vulkan/turbo3.spv     fixtures/turbo3.json
./vulkan_verify ../vulkan/turbo4.spv     fixtures/turbo4.json
./vulkan_verify ../vulkan/turbo3_tcq.spv fixtures/turbo3_tcq.json

# Force lavapipe (Mesa CPU ICD):
VK_LOADER_DRIVERS_SELECT=lvp_icd.json ./vulkan_verify ../vulkan/turbo3.spv fixtures/turbo3.json

# Force Intel ARL explicitly:
VK_LOADER_DRIVERS_SELECT=intel_icd.json ./vulkan_verify ../vulkan/turbo3.spv fixtures/turbo3.json
```

## Build-script wiring

`packages/app-core/scripts/build-llama-cpp-dflash.mjs::patchVulkanKernels`
flipped from opt-in (`ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1`) to default-on
(`ELIZA_DFLASH_PATCH_VULKAN_KERNELS=0` to silence the log). The function
itself is still a no-op tracking placeholder — the milady-ai/llama.cpp
fork consumes the same source-of-truth shaders in
`packages/inference/vulkan/`, so this hook just confirms they're in sync.
The `warn-on-mismatch guard` shape (sentinel-based idempotent layout
check) is documented in the function's comment so the next agent who
turns this into a real patcher (e.g. when the fork's vulkan-shaders/
tree drifts) can attach one easily, mirroring `patchGgmlBaseForWindowsQjl`.

## Hardware-runner checklist (NVIDIA / AMD verification)

W3-E's per-vendor checklist still applies in full; W4-A only ran the
Intel ARL + lavapipe legs. Outstanding work:

### NVIDIA (Ampere / Ada / Blackwell)

- [ ] `vulkaninfo --summary` confirms `subgroupSize=32` and Mesa 25.x or NVIDIA 555+ driver
- [ ] Build harness: prefer LunarG SDK for full validation layers
      (`VULKAN_SDK=/opt/vulkan-sdk make vulkan`); the no-SDK
      `~/.cache/eliza-dflash/vulkan-headers/include` fallback also works
- [ ] Run `./vulkan_verify ../vulkan/turbo{3,4,3_tcq}.spv fixtures/...` — expect 8/8 PASS for all three (the tree reduction is subgroup-size-agnostic, so an NVIDIA wave32 should land in the same numerical regime as Intel ARL)
- [ ] Compare per-element diffs against the Intel ARL baseline in `post-fix.txt`. Expect agreement to ~1e-5; any larger drift is a fp32 reduction-order delta, not a correctness bug
- [ ] Optional perf sanity: time the 8-fixture loop. The 5 barriers add a sub-ms hit per dispatch on Intel ARL; NVIDIA's faster shared memory should make the gap vs the (broken) subgroupAdd version smaller still

### AMD (RDNA2 / RDNA3 / RDNA4 — wave32 + wave64 mix)

- [ ] `vulkaninfo --summary` confirms subgroup size (wave64 default on older RDNA without explicit control); `VK_EXT_subgroup_size_control` should be present
- [ ] Both AMDVLK and RADV should work; prefer RADV since it ships with Mesa
- [ ] Run vulkan_verify against turbo3 / turbo4 / turbo3_tcq; expect 8/8 PASS
      regardless of native wave size, because the workgroup-shared tree
      reduction sidesteps subgroup width entirely
- [ ] AMD-specific risk that's now neutralized: wave64 means a single
      subgroup is *wider* than the workgroup — `subgroupAdd` in the old
      code would over-reduce or stall on non-participating lanes. The
      tree reduction has no such failure mode

### Intel (ARL / Battlemage / future ARC)

- [x] **Verified on this host (Intel ARL iGPU, Mesa 25.2.8):** 8/8 PASS for all three turbo shaders
- [ ] Optional: rerun on Battlemage discrete (subgroupSize default 16 there) to confirm tree reduction holds; expected to pass
- [ ] Verify the Vulkan QJL / Polar shaders once the harness gets a QJL/Polar bind-set (out of scope for W4-A — see `verify/vulkan_verify.cpp` line 269 hard-coding `n_bindings = needs_codebook ? 4 : 3`)

### Adreno (Qualcomm — Snapdragon mobile, Android Vulkan target)

- [ ] `vulkaninfo` on a Pixel / Galaxy: subgroup size typically 64 or 128 depending on Adreno generation
- [ ] Cross-compile harness via NDK r26 + Khronos headers (path 2 in the Makefile)
- [ ] `adb push` SPV + fixtures + binary; run on-device
- [ ] Adreno-specific risk that **is not addressed by W4-A**: very
      strict alignment requirements on storage buffer reads — the
      byte-stream-reinterpret-as-uint pattern in turbo3/turbo4 may need
      re-checking. The reduction fix is orthogonal to that

### Mali (ARM — Pixel 6+ Tensor, Galaxy non-US)

- [ ] `vulkaninfo`: subgroup support varies by generation; older Mali-G7x had limited subgroup ops
- [ ] Old code couldn't even create a pipeline on Mali without `VK_KHR_shader_subgroup_arithmetic`; W4-A's tree reduction drops that requirement, so pipeline creation should succeed even on older Mali
- [ ] Same NDK cross-compile path as Adreno

## What W4-A did NOT touch

- The new QJL / Polar Vulkan shaders W3-E added — they already use the
  shared-memory tree reduction (W3-E ported them defensively on the
  principle that "new code should not inherit a known portability bug").
- The Vulkan harness (`verify/vulkan_verify.cpp`). It still hard-codes
  the turbo bind-set; extending it to QJL / Polar bind-sets and
  regenerating fixtures from `qjl_polar_ref.c` is its own work item.
- CUDA kernels (W4-B's scope).
- Metal kernels (no `xcrun metal` on this Linux host).
- AMD / NVIDIA verification (no compatible hardware on this host —
  checklist above).
- The `subgroup-aware` alternative fix path (require subgroupSize=32 via
  `VK_EXT_subgroup_size_control`) — not pursued because the tree
  reduction is universally portable, the workload is per-thread heavy
  enough that the 5 barriers don't dominate, and the QJL/Polar shaders
  already commit to the same pattern.

## Files changed

- `packages/inference/vulkan/turbo3.comp` — drop `GL_KHR_shader_subgroup_arithmetic`, add `reduce_sum_32`, replace `subgroupAdd` epilogue, refresh DRAFT comment header to "hardware-verified"
- `packages/inference/vulkan/turbo4.comp` — same shape, plus add `partials[32]` declaration (turbo3 already had it)
- `packages/inference/vulkan/turbo3_tcq.comp` — same shape as turbo4
- `packages/app-core/scripts/build-llama-cpp-dflash.mjs::patchVulkanKernels` — flip default-on, update log message
- `packages/inference/README.md` — verification matrix (turbo* Vulkan rows flip to PASS), feature-flag table (default ON), top banner, item 4 in "Algorithmic deltas vs CUDA" (Vulkan tree reduction)
- `reports/porting/2026-05-09-w4/{baseline-pre-fix.txt, post-fix.txt, vulkan-turbo-fix.md}` — this report and its raw output

## Commits

Per AGENTS.md "commit per kernel-fix + commit per matrix update":

1. `fix(inference/vulkan): replace subgroupAdd with shared-mem tree reduction in turbo3`
2. `fix(inference/vulkan): replace subgroupAdd with shared-mem tree reduction in turbo4`
3. `fix(inference/vulkan): replace subgroupAdd with shared-mem tree reduction in turbo3_tcq`
4. `chore(inference): flip patchVulkanKernels default-on, refresh README verification matrix, add W4-A report`
