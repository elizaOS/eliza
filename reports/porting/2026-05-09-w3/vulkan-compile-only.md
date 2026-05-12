# Wave-3 Agent E — Vulkan compile + lavapipe runtime baseline

**Date:** 2026-05-09
**Scope:** Install Vulkan shader toolchain on this Linux host, compile every
Vulkan compute shader in `local-inference/kernels/vulkan/`, run them on lavapipe
(Mesa CPU ICD) and Intel ARL (real iGPU), document per-shader status, and add
the missing QJL / PolarQuant `.comp` files the unified-fork strategy calls for.

## Tool versions

| Tool | Version | Source |
|---|---|---|
| `glslc` | shaderc v2022.3 ndk-r28 (target SPIR-V 1.0) | `~/Android/Sdk/ndk/29.0.13113456/shader-tools/linux-x86_64/glslc` (already on disk via the dflash NDK install — no apt-get needed) |
| `glslangValidator` | 11:15.1.0 (SPIR-V 1.6) | `apt-get download glslang-tools` then `dpkg-deb -x` to `/tmp/glslang-extract` (no root required) |
| `spirv-val` | spirv-tools v2022.4 ndk-r28 | bundled with the NDK shader-tools |
| `vulkaninfo` | from vulkan-tools 1.3.275 | `apt-get download vulkan-tools` + `dpkg-deb -x` to `/tmp/vulkan-tools-extract` |
| `libvulkan1` | 1.3.275.0-1build1 | already system-installed |
| `mesa-vulkan-drivers` | 25.2.8-0ubuntu0.24.04.1 | already system-installed (provides lvp_icd.json + intel_icd.json) |

`sudo` requires a password on this host, so the binary apt-get install path was
unavailable. Workaround: `apt-get download <pkg>` runs unprivileged and
`dpkg-deb -x` extracts the archive to `/tmp` without writing to system
locations. Either path produces the same binaries; the LunarG SDK is not
required.

## Available Vulkan ICDs

`vulkaninfo --summary` enumerates two devices:

| Device | Driver | Vendor | API | Conformance |
|---|---|---|---|---|
| Intel(R) Graphics (ARL) | DRIVER_ID_INTEL_OPEN_SOURCE_MESA (Mesa 25.2.8) | Intel iGPU | 1.4.318 | 1.4.0.0 |
| llvmpipe (LLVM 20.1.2, 256 bits) | DRIVER_ID_MESA_LLVMPIPE | CPU (lavapipe) | 1.4.318 | 1.3.1.1 |

ICD JSONs available under `/usr/share/vulkan/icd.d/`: `lvp_icd.json` (lavapipe,
the CPU-only ICD this report targets), `intel_icd.json`, plus
`asahi_icd.json`, `gfxstream_vk_icd.json`, `intel_hasvk_icd.json`,
`nouveau_icd.json`, `nvidia_icd.json`, `radeon_icd.json`, `virtio_icd.json` (no
matching hardware for those).

Force selection: `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json` (or
`intel_icd.json`).

Subgroup properties (relevant — see "Source-level findings" below):

| Property | Intel ARL | lavapipe |
|---|---|---|
| `subgroupSize` (default) | 32 | (not enumerated in summary) |
| `minSubgroupSize` / `maxSubgroupSize` | 8 / 32 | n/a |
| `VK_EXT_subgroup_size_control` | yes | yes |

## Per-shader compile status

Compile command (from the Makefile, applied to every `*.comp` in
`local-inference/kernels/vulkan/`):

```
glslc --target-env=vulkan1.1 --target-spv=spv1.3 \
      -fshader-stage=compute <shader.comp> -o <shader.spv>
spirv-val --target-env vulkan1.1 <shader.spv>
```

| Shader | Source | Compile | spirv-val (vulkan1.1) | SPV size |
|---|---|---|---|---|
| `turbo3.comp` | pre-existing (W1-D) | clean | clean | 7916 B |
| `turbo4.comp` | pre-existing (W1-D) | clean | clean | 7216 B |
| `turbo3_tcq.comp` | pre-existing (W1-D) | clean | clean | 7232 B |
| `qjl.comp` | NEW (this agent, ports `kernel_attn_score_qjl1_256` from `metal/qjl.metal`) | clean | clean | 6408 B |
| `qjl_get_rows.comp` | NEW (ports `kernel_get_rows_qjl1_256`) | clean | clean | 4392 B |
| `qjl_mul_mv.comp` | NEW (ports `kernel_mul_mv_qjl1_256_f32`) | clean | clean | 5640 B |
| `polar.comp` | NEW (ports `kernel_mul_mv_q4_polar_f32` from `metal/polar.metal`) | clean | clean | 11172 B |
| `polar_get_rows.comp` | NEW (ports `kernel_get_rows_q4_polar`) | clean | clean | 9104 B |

**Total: 8/8 compile clean, 8/8 validate clean.**

The Vulkan column entries in the unified-fork strategy table for QJL
(`☐ port to .comp`) and Q4_POLAR (`☐ port to .comp`) can now flip from
"☐ not ported" to "☐ source compiles, awaiting on-GPU verification" — same
state as the turbo* family.

## Per-shader lavapipe + Intel ARL runtime status

The Vulkan harness `verify/vulkan_verify` was built against the cached Khronos
headers at `~/.cache/eliza-dflash/vulkan-headers/include` and the system
`libvulkan.so.1` (the no-LunarG-SDK Linux path the Makefile already supports).
It loads `*.spv`, dispatches the kernel against the JSON fixture, and compares
scalar output to the reference (tolerance 1e-3 absolute).

Only the three turbo shaders have JSON fixtures today
(`fixtures/turbo3.json`, `turbo4.json`, `turbo3_tcq.json`); the harness expects
the existing turbo bind-set (Q + KBuf + ScoresOut + push constants), so qjl /
polar would need a harness extension and fixture-format addition before
runtime execution. They are compile-only at this snapshot.

```
./vulkan_verify ../vulkan/<kernel>.spv fixtures/<kernel>.json
```

| Shader | Default ICD (Intel ARL) | Lavapipe (`lvp_icd.json`) | Intel ARL (`intel_icd.json`) |
|---|---|---|---|
| `turbo3.spv`     | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong |
| `turbo4.spv`     | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong |
| `turbo3_tcq.spv` | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong | 0/8 PASS — dispatch ok, scores wrong |
| `qjl.spv`            | n/a (no fixture / no harness wiring yet) | n/a | n/a |
| `qjl_get_rows.spv`   | n/a | n/a | n/a |
| `qjl_mul_mv.spv`     | n/a | n/a | n/a |
| `polar.spv`          | n/a | n/a | n/a |
| `polar_get_rows.spv` | n/a | n/a | n/a |

Sample miss magnitudes (turbo3 against lavapipe): expected -5.81 / +8.76 / ...
got -0.80 / -2.04 / ...; absolute diff 0.94 ... 15.49. Same shader against
Intel ARL produces a *different* set of wrong values (-7.54 / +3.73 / ...),
which is consistent with the source-level subgroup-size assumption documented
below — under-reduction under one driver vs another.

The 0/8 PASS on lavapipe matches the W1-D / W1-E baseline. The 0/8 PASS on
the **real Intel ARL iGPU** (with very different wrong values from lavapipe)
is a new data point: it confirms the bug is in the shader source, not a
known-bad-driver artifact of llvmpipe. A real-GPU agent on NVIDIA / AMD will
likely see yet another set of wrong values until the source is fixed.

## Source-level findings (no fix applied — needs hardware to verify)

Per the task scope ("don't try to fix the broken turbo* shaders without a real
GPU"), I did not patch the turbo shaders, but the following observations were
made while compiling and dispatching them. They are the most likely
root-cause(s) of the 0/8 baseline and a starting checklist for the real-GPU
agent.

### 1. `subgroupAdd` with no enforced subgroup size (highest confidence)

All three turbo shaders end with:

```glsl
layout(local_size_x = 32, ...) in;
...
float sum = subgroupAdd(acc);
if (tid == 0u) scores[...] = sum;
```

This assumes the entire 32-thread workgroup is a single subgroup. On Intel
ARL, `minSubgroupSize=8` / `maxSubgroupSize=32` and the *default* subgroup
size is driver-chosen — without a `VkPipelineShaderStageRequiredSubgroupSizeCreateInfo`
or the `local_size_x_id`+`SubgroupSize` SPIR-V decoration, you can get an 8-
or 16-lane subgroup. `subgroupAdd` only sums within the subgroup, so `tid==0`
sees a partial sum.

Lavapipe and Intel return *different* wrong values, which is exactly the
fingerprint of "subgroup size is driver-chosen and the shader doesn't enforce
one".

This is a Vulkan-portability bug in the shader source. Two fixes:

  - **Driver-portable fix**: replace `subgroupAdd` with a 32-element shared-
    memory tree reduction (the pattern used in the new `qjl.comp` /
    `qjl_mul_mv.comp` / `polar.comp` files). Costs 5 barriers vs 0, but works
    on every Vulkan driver regardless of subgroup size.
  - **Subgroup-aware fix**: declare `VK_EXT_subgroup_size_control` support in
    the harness, set `requiredSubgroupSize = 32` at pipeline creation, and
    keep `subgroupAdd`. Faster on hardware that natively does 32-lane
    subgroups (most NVIDIA, Apple), suboptimal on AMD wave64 / Intel that
    prefer 16.

The existing `partials[32]` shared array in `turbo3.comp` is a leftover from a
half-implemented tree reduction (it's written under a barrier and never
read) — strong evidence the original author intended the tree-reduction path
and didn't finish.

### 2. AMD wave size (medium confidence — requires AMD hardware to verify)

On AMD GCN/RDNA the wave size may be 32 or 64. Even with a forced subgroup
size, AMD compilers may need `subgroupSize` queries to pick the right ISA.
Vulkan-portable tree reduction sidesteps this entirely.

### 3. fp16 path (low confidence — currently uses manual decode)

`turbo3.comp` and `polar.comp` both contain a hand-written `fp16_to_fp32`
routine that walks subnormals via a `while` loop. On hardware with native
`GL_EXT_shader_explicit_arithmetic_types_float16`, replacing this with
`uint16BitsToHalf` + auto-promotion would be cleaner and might help drivers
optimize. Not a correctness bug.

## Hardware-runner checklist

When a real-GPU agent picks this up:

### NVIDIA (Ampere / Ada / Blackwell — primary target)
- [ ] vulkaninfo: `subgroupSize=32`, `VK_EXT_subgroup_size_control` available
- [ ] Build harness: `VULKAN_SDK=/opt/vulkan-sdk make vulkan` (LunarG SDK preferred for full validation layers)
- [ ] Run `./vulkan_verify ../vulkan/turbo3.spv fixtures/turbo3.json` — expect 0/8 → 8/8 once subgroup-size fix lands
- [ ] Run same against turbo4, turbo3_tcq
- [ ] Extend harness for qjl / polar (new fixture format that matches their bind sets), regenerate fixtures from the C reference, run
- [ ] If subgroup-size fix is the tree-reduction variant: verify performance is within 1.5× of the subgroup-aware variant before committing

### AMD (RDNA2 / RDNA3 / RDNA4 — wave32 + wave64 mix)
- [ ] vulkaninfo: confirm subgroup size (likely 64 on RDNA without explicit control); `VK_EXT_subgroup_size_control` available
- [ ] Build harness same way; AMDVLK and RADV both supported
- [ ] Run vulkan_verify against all 8 shaders; expect 0/8 until tree reduction or 32-lane required subgroup enforced
- [ ] AMD-specific risk: wave64 means a single subgroup is wider than the workgroup — `subgroupAdd` would over-reduce or stall on non-participating lanes. Tree reduction is the safer path.

### Intel (ARL / Battlemage / future ARC)
- [ ] vulkaninfo: `subgroupSize=32` default, `min/max=8/32`
- [ ] **Already verified on this host (Intel ARL iGPU)**: 8/8 compile, 0/8 numerical — same baseline as lavapipe but with different wrong values. Confirms the bug is shader-side, not driver-side.
- [ ] After fix: rerun vulkan_verify on Intel ARL to confirm parity with NVIDIA / AMD numbers

### Adreno (Qualcomm — Snapdragon mobile, Android Vulkan target)
- [ ] vulkaninfo on a Pixel / Galaxy: subgroup size typically 64 or 128 depending on Adreno generation
- [ ] Cross-compile harness via NDK r26 + Khronos headers (path 2 in the Makefile)
- [ ] `adb push` SPV + fixtures + binary; run on-device
- [ ] Adreno-specific risk: very strict alignment requirements on storage buffer reads — the byte-stream-reinterpret-as-uint pattern in turbo3/turbo4 may need re-checking

### Mali (ARM — Pixel 6+ Tensor, Galaxy non-US)
- [ ] vulkaninfo: subgroup support varies by generation; older Mali-G7x had limited subgroup ops
- [ ] If `VK_KHR_shader_subgroup_arithmetic` is missing, the current shaders won't even create a pipeline — tree reduction is mandatory
- [ ] Same NDK cross-compile path as Adreno

## Source modifications committed in this round

- `local-inference/kernels/vulkan/qjl.comp` (new)
- `local-inference/kernels/vulkan/qjl_get_rows.comp` (new)
- `local-inference/kernels/vulkan/qjl_mul_mv.comp` (new)
- `local-inference/kernels/vulkan/polar.comp` (new)
- `local-inference/kernels/vulkan/polar_get_rows.comp` (new)
- `local-inference/kernels/verify/Makefile` — extended `VULKAN_SHADERS` list to cover the new files

The new QJL / Polar shaders use the **driver-portable shared-memory tree
reduction** pattern intentionally, on the principle that "new code should not
inherit a known portability bug". If on hardware the subgroup-aware variant
turns out 1.5× faster, swap them once the harness exposes a subgroup-size
control switch.

No turbo shader sources were modified — the source-level subgroup-size
finding is documented for the real-GPU agent but the fix is left for them
because verifying the fix requires hardware that lavapipe / Intel ARL cannot
substitute for.

## What remains for the real-GPU agent

1. Fix the turbo* subgroup-size assumption (likely tree reduction, possibly
   required-subgroup-size).
2. Extend `vulkan_verify.cpp` to cover the qjl / polar bind sets (different
   buffer layouts, different push-constant struct).
3. Generate matching JSON fixtures from the C reference — currently only the
   3 turbo shaders have fixtures. The qjl / polar reference is at
   `verify/qjl_polar_ref.{c,h}` and the Metal harness already exercises it.
4. Once the harness reports 8/8 PASS on the per-vendor matrix, flip the
   `ELIZA_DFLASH_PATCH_VULKAN_KERNELS` opt-in in `build-llama-cpp-dflash.mjs`
   to always-on.
