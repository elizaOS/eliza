# #9508 — Mali flash-attn fix: device verification + build-time mitigation gate

## Root cause (confirmed)
On-device text generate via the bionic Vulkan host intermittently `ggml_abort`s
(SIGABRT) mid-decode on Mali GPUs (Pixel 9a / Tensor G4 / Mali-G715). The cause is
the scalar flash-attention subgroup race: nothing sets `flash_attn`, so it defaults
to AUTO → FA on, and Mali (no cooperative-matrix) takes the scalar path whose
`subgroupShuffleXor` reduction reads the wrong lanes when the runtime subgroup size
diverges from the compiled size.

The mitigation already exists in the llama.cpp fork at `0864259` (the
`VK_VENDOR_ID_ARM` branch → `disable_subgroups=true`, the deterministic
shared-memory reduction, overridable with `GGML_VK_FA_ALLOW_SUBGROUPS`). The bug
was that the **prebuilt fused-lib artifact shipped stale** — built before that
landed, so its `libggml-vulkan.so` had zero mitigation markers.

## Device verification (real Pixel 9a, Mali-G715)
Rebuilt `libggml-vulkan.so` from develop's fork source (which carries the ARM
mitigation), pushed `llama-completion` + the rebuilt fused lib set + a Q4 GGUF to
the device, and ran `-fa on -ngl 99` (Mali Vulkan, flash-attn forced on) 12×:

```
run 1  exit=0 aborts=0 paris=1
run 2  exit=0 aborts=0 paris=1
...
run 12 exit=0 aborts=0 paris=1
ALL_DONE
```

**12/12 clean, 0 SIGABRT, correct generation every run** (`The capital of France
is → Paris`, ~20 t/s, `n_ctx=32768, n_predict=48` on the Mali GPU). The pre-fix
lib aborted up to ~84× in some runs with identical config.

Marker proof:
- rebuilt arm64 `libggml-vulkan.so` → `GGML_VK_FA_ALLOW_SUBGROUPS` markers: **1**
- stale prebuilt `libggml-vulkan.so` → markers: **0**

## What this PR changes
A **fail-closed build-time gate** in `verify-fused-symbols.mjs` (run post-build by
`compile-libllama.mjs`): for any Vulkan fused target, the sibling
`libggml-vulkan.so` MUST carry the `GGML_VK_FA_ALLOW_SUBGROUPS` marker, or the
build throws. The marker only exists in source with the `VK_VENDOR_ID_ARM`
`disable_subgroups` branch, so its presence proves the GPU backend was compiled
from mitigated source rather than copied from a stale prebuilt — the stale lib can
never silently pass fused-symbol verification again.

Validated locally: the gate **passes** on the rebuilt (mitigated) backend and
**throws** on the stale one.

## Follow-up (not in this PR)
The structural completion is to have the local-agent Android release build
**compile the fused Vulkan lib from source** (`compile-libllama.mjs --target
android-arm64-vulkan-fused`) so the freshly-built, mitigated `.so` is baked into
the released APK — no prebuilt artifact, no HF/archive download. The gate added
here is the enforcement that makes a stale GPU backend a hard build failure.
