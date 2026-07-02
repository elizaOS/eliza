# #9508 — Mali flash-attn mitigation: Pixel 6a (Mali-G78) device verify + shipped-APK proof

Close-out evidence for the reopened #9508. Captured 2026-07-01/02 on the attached
**Pixel 6a** (`27051JEGR10034`, Tensor GS101, **Mali-G78**, Valhall — covered by the
same `VK_VENDOR_ID_ARM` `get_fa_tuning_params_scalar` branch as the Pixel 9a's
G715 where the crash was originally reproduced).

## 1. Rebuilt fused Vulkan set carries the mitigation

Built from a clean `origin/develop` worktree (llama.cpp submodule gitlink
`ba598f562`, which contains `4dd84dca5` — the `VK_VENDOR_ID_ARM
disable_subgroups` branch + marker; `git merge-base --is-ancestor 0864259 HEAD`
= yes):

```
$ node packages/app-core/scripts/stage-elizavoice-lib.mjs --abi arm64-v8a --variant vulkan
[stage-elizavoice-lib] staged 8 libs (dynamic-Vulkan): libelizainference.so, libggml.so,
  libggml-base.so, libggml-cpu.so, libggml-vulkan.so, libllama.so, libllama-common.so, libmtmd.so

$ strings jniLibs/arm64-v8a/libggml-vulkan.so | grep -c GGML_VK_FA_ALLOW_SUBGROUPS
1     # every pre-existing lib on the host had 0 (stale) — see gate-bypass note below
```

## 2. 12× forced-flash-attention Vulkan generate: 0 SIGABRT

The #9508 repro loop (pre-fix: up to ~84 aborts on Mali): eliza-1-2b
(`eliza-1-2b-128k.gguf`, qwen35 2B Q4_K), `-ngl 99 -fa on`, 48 tokens ×12:

```
run 1 exit=0 ... run 12 exit=0
ABORTS=0/12
```

Offload to the GPU is proven, not assumed (the completion tool's default log
level hides the backend banner — an earlier read of these logs mistook that for
a CPU fallback):

```
$ ./llama-completion -m model.gguf -ngl 99 -fa on -v ...
load_tensors: layer   0 assigned to device Vulkan0, is_swa = 0
load_tensors: layer   1 assigned to device Vulkan0, is_swa = 0   (… all layers)

$ ./llama-completion --list-devices
Available devices:
  Vulkan0: Mali-G78 (5689 MiB, 5689 MiB free)
```

`llama-bench` on the same libs (`build: ba598f562 (10043)`):

| model | backend | ngl | fa | test | t/s |
|---|---|--:|--:|--|--:|
| qwen35 2B Q4_K Medium (1.17 GiB) | Vulkan | 99 | 1 | pp32 | 2.60 |
| qwen35 2B Q4_K Medium | Vulkan | 99 | 1 | tg32 | 6.85 |

Honest caveat: sustained back-to-back runs thermal-throttle the 6a hard
(tg 9.09 → 0.52 → 3.39 → 4.71 t/s across the loop; per-run logs
`run1..12.log` in `/data/local/tmp/eliza-9508/`). Stability (0 aborts), not
throughput, is the acceptance metric here.

## 3. Shipped-APK proof (close criterion a)

`bun run --cwd packages/app build:android` from the same tree, then:

```
$ unzip -l app-debug.apk | grep libggml-vulkan
 35315488  lib/arm64-v8a/libggml-vulkan.so
$ unzip -p app-debug.apk lib/arm64-v8a/libggml-vulkan.so | strings | grep -c GGML_VK_FA_ALLOW_SUBGROUPS
1
```

Installed on the Pixel 6a (`adb install -r -d` → Success, lastUpdateTime
advanced).

## 4. The two gaps that had kept this open (fixed in PR #11173)

- **CI lane red:** `build-llama-ffi-android.yml` → `compile-libllama.mjs` never
  satisfied the fork's `find_package(SPIRV-Headers REQUIRED)` — 5/5 develop
  runs died at cmake configure. Fixed by resolving/shimming the SPIRV-Headers
  package config + `-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH` (mirrors the
  working `stage-elizavoice-lib.mjs` flags).
- **Gate bypass on the shipping path:** `stage-elizavoice-lib.mjs` populated
  jniLibs without running `assertVulkanMaliMitigation` — proven exploitable by
  a 2026-06-24 stale zero-marker build on this host. The stage script now
  gates fail-closed; negative test: pointing the gate at that stale lib throws
  `lacks the 'GGML_VK_FA_ALLOW_SUBGROUPS' Mali flash-attn mitigation marker`.

## 5. eliza-archive prebuilt disposition (close criterion b)

The `eliza-archive` prebuilt fused-lib artifact path is **obsolete for this
surface**: nothing downloads a prebuilt Android `libggml-vulkan.so` /
`libelizainference.so` anymore. The libs are built from the in-repo fork
submodule at build time — locally by `stage-elizavoice-lib.mjs` (now gated),
in CI by `.github/workflows/build-llama-ffi-android.yml` (unbroken by PR
#11173; uploads the `libelizainference-android-arm64-vulkan-fused` Actions
artifact). `packages/scripts/sync-artifacts.mjs` (the `ELIZA_SKIP_ARTIFACT_SYNC`
bundle) carries no Android GPU libs.
