# Vulkan kernel optimization review - 2026-05-11

Scope: Vulkan/Android only. No shared source files were edited.

## Local environment

- Host: Darwin 25.2.0 arm64.
- Vulkan loader tools are present: `/opt/homebrew/bin/glslc`, `/opt/homebrew/bin/vulkaninfo`, `/opt/homebrew/bin/spirv-val`.
- MoltenVK is visible through `/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json`, pointing at Homebrew MoltenVK 1.4.1.
- `vulkaninfo --summary` enumerates Apple M4 Max through MoltenVK, API 1.4.334, vendor `0x106b`, device `0x1a020209`.
- Android tools are present: `/opt/homebrew/bin/adb`, Android Debug Bridge 37.0.0, NDKs `25.2.9519653` and `29.0.13113456`.
- `adb devices -l` reports no attached devices in `device` state, so no Adreno/Mali run was possible.

## Validation run

Commands were run from `/Users/shawwalters/eliza-workspace/eliza/eliza` or `packages/inference/verify` as appropriate.

- `./gen_fixture --self-test`: PASS. Turbo3, Turbo4, TCQ, QJL, Polar, Polar+QJL, and fused-attention reference outputs were finite.
- `node check_kernel_contract.mjs`: PASS, `kernels=6 targets=21 manifestNames=6`.
- `glslc --target-env=vulkan1.1 --target-spv=spv1.3 -fshader-stage=compute <shader> -o /dev/null` for every `packages/inference/vulkan/*.comp`: PASS.
- `spirv-val --target-env vulkan1.1` over existing `packages/inference/vulkan/*.spv`: PASS.
- MoltenVK standalone correctness:
  - `turbo3`: 8/8 PASS, max diff `3.815e-06`.
  - `turbo4`: 8/8 PASS, max diff `5.722e-06`.
  - `turbo3_tcq`: 8/8 PASS, max diff `4.768e-06`.
  - `qjl`: 8/8 PASS, max diff `7.629e-06`.
  - `polar`: 8/8 PASS, max diff `5.722e-06`.
  - `polar + QJL residual`: 8/8 PASS, max diff `4.768e-06`.
  - `polar_preht`: 8/8 PASS, max diff `7.629e-06`.
  - `polar_preht + QJL residual`: 8/8 PASS, max diff `4.351e-06`.
- MoltenVK multi-block variants:
  - `turbo3_multi`, `turbo4_multi`, `turbo3_tcq_multi`, and `qjl_multi` PASS for specialization values 1, 2, 4, and 8.
- MoltenVK fallback entrypoints:
  - `qjl_mul_mv`: 8/8 PASS, max diff `6.676e-06`.
  - `qjl_get_rows`: 128/128 PASS, max diff `0`.
  - `polar_get_rows`, `use_qjl=0`: 128/128 PASS, max diff `0`.
  - `polar_get_rows`, `use_qjl=1`: 128/128 PASS, max diff `0`.
- MoltenVK fused attention:
  - `fused_attn_qjl_tbq`: 1920/1920 outputs PASS across four cases, max diff `5.066e-07`.
  - `fused_attn_qjl_polar`: 1920/1920 outputs PASS across four cases, max diff `7.153e-07`.

Important limitation: this is MoltenVK standalone shader evidence. Per `packages/inference/verify/Makefile`, macOS/MoltenVK cannot flip Vulkan runtime-ready capability bits; native Linux Vulkan or Android graph-dispatch evidence is still required.

## Diagnostic benchmark

Short diagnostic run:

```bash
VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json \
DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib \
MESA_SHADER_CACHE_DISABLE=1 \
./vulkan_bench --runs 5 --warmup 2
```

Device: Apple M4 Max through MoltenVK, subgroup size 32, timestamp period 1 ns.

Selected timings:

- Long-context score kernels at `n=32768`:
  - `turbo3`: `73.83 us`; best multi-block observed: `38.25 us` at `multi=4`.
  - `turbo4`: `61.62 us`; best multi-block observed: `30.79 us` at `multi=4`.
  - `turbo3_tcq`: `61.00 us`; best multi-block observed: `29.96 us` at `multi=4`.
  - `qjl`: `459.96 us`; best multi-block observed: `144.04 us` at `multi=16`.
  - `polar`: `109.25 us`.
  - `polar_preht`: `60.83 us`.
- Fused attention:
  - `fused_attn_qjl_tbq`: `1.395 ms` at `n_kv=512`, `10.915 ms` at `4096`, `90.300 ms` at `32768`.
  - `fused_attn_qjl_polar`: `1.549 ms` at `n_kv=512`, `12.155 ms` at `4096`, `104.924 ms` at `32768`.

Treat these as directional only. They measure MoltenVK on Apple GPU through the standalone harness, not Android Vulkan runtime memory, scheduling, thermals, or driver codegen.

## Performance opportunities

1. **Make fused attention token-tiled for mobile.**
   The current fused shaders use one workgroup per `(q_head, q_pos)` and loop over every KV token inside that workgroup. This is correct, but it serializes the token axis within one workgroup and becomes the dominant long-context cost. The existing `kv_tile` push constant documents the intended subdivision, but the shader still treats `0` as the full range and does not implement tiled partial combine. For Adreno/Mali, the next major kernel optimization should split KV into tiles, emit partial `(m, l, out[128])`, and run a second combine pass using the FlashAttention online-softmax merge rule.

2. **Add Android-specific specialization policy for multi-block kernels.**
   The `_multi` variants are already correct. MoltenVK timings suggest large gains at long context, especially QJL (`459.96 us` to `144.04 us` at `n_tok=32768`). The right specialization value is device dependent: this needs Adreno/Mali sweeps rather than one hardcoded value.

3. **Prefer Polar pre-Hadamard where the graph can supply `H*q`.**
   `polar_preht` avoids the per-row 128-element shared-memory Hadamard and was consistently faster in the diagnostic run (`109.25 us` to `60.83 us` at `n_rows=32768`). It is only valid when the caller supplies `q_preht = H*q`; routing it behind a raw-query Polar dispatch would be incorrect.

4. **Revisit fused-attention final stores after Android hardware tests.**
   Both fused shaders currently let `tid == 0` write all 128 output floats serially because Mesa ANV showed intermittent zero readbacks with all-thread strided SSBO stores. That conservative choice is portable. On Adreno/Mali, a parallel store path may be safe and faster, but it should be gated by device evidence.

5. **Keep the 32-thread shared-reduction baseline until native data justifies subgroup variants.**
   The current code deliberately avoids subgroup assumptions after the earlier subgroup-size failure. Adreno and Mali subgroup behavior differs by generation and driver; any subgroup path should be a device-specialized alternate pipeline, not a replacement for the portable baseline.

## Adreno/Mali blockers

- No Android device is attached. `adb devices -l` returned an empty device list, so I could not run `android_vulkan_smoke.sh` or collect Adreno/Mali correctness, perf, thermal, or graph-dispatch evidence.
- The Android smoke script requires a physical device by default and rejects emulators unless explicitly allowed. It runs the eight standalone fixture checks on-device, then requires `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE`; standalone SPIR-V success alone is not enough to mark runtime Vulkan ready.
- Native graph-dispatch evidence is still required. The Makefile explicitly says MoltenVK validates standalone SPIR-V only and cannot flip runtime-ready Vulkan capability bits.
- No Adreno/Mali device-policy table can be signed off yet. Required unknowns include subgroup size/behavior, best `_multi` specialization value, whether parallel SSBO output stores are reliable, fused-attention tile size, timestamp support, memory-type performance, sustained thermals, and app/runtime graph dispatch.

## Current state

The local Vulkan shader sources compile, existing SPIR-V validates, and MoltenVK standalone correctness is clean across required, additive, fallback, and fused-attention shaders. The strongest optimization target for Android is fused-attention token tiling; the strongest ready-to-policy tune is `_multi` specialization per GPU family. Adreno/Mali remain blocked on physical-device access and runtime graph evidence.
