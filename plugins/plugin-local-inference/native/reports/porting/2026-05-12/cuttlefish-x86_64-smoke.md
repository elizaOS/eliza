# Cuttlefish (cvd) x86_64 smoke — `android-x86_64-cpu` target

> **Date:** 2026-05-12. **Host:** the WS-2 authoring box (x86_64 Linux, Ubuntu
> 24.04, kernel 6.17, KVM available — `crw-rw---- root kvm /dev/kvm`, the run
> user is in the `kvm` group). **cvd:** `cvd 1.53.0` (`cuttlefish-base` +
> `cuttlefish-user` 1.53.0 installed from `~/android-cuttlefish/`).
> **adb device:** `0.0.0.0:6520` (`ro.product.cpu.abi = x86_64`). **App on the
> cvd:** `ai.milady.milady` (a release-build privileged APK staged into the
> AOSP image by a prior `build-aosp.mjs --launch` run; this run did NOT
> rebuild the image — the cvd instance `cvd-1` was already up).

## What `android-x86_64-cpu` is

A real, runnable build target — added to `SUPPORTED_TARGETS` in
`build-llama-cpp-dflash.mjs` and to `kernel-contract.json` /
`PLATFORM_MATRIX.md` this wave. Use cases: Chromebooks (ChromeOS Android
subsystem / ARCVM), the Android x86_64 emulator, and the load-bearing one —
Cuttlefish (`cvd`) virtual devices, which run on an x86_64 Linux host under
KVM (no physical device, real ABI, real `adb`).

`cmakeFlagsForTarget` picks `-DANDROID_ABI=x86_64` for the `x86_64` arch
segment and forces `-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON
-DGGML_FMA=ON -DGGML_F16C=ON` (the x86_64 Android ABI baseline is SSE4.2; the
fork's QJL/Polar CPU kernels need AVX2, and cvd/ChromeOS x86_64 hosts are all
Haswell+).

## Build (this box) — PASS

```
ANDROID_NDK_HOME=~/Android/Sdk/ndk/29.0.13113456 \
  node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target android-x86_64-cpu
```

Output → `~/.eliza/local-inference/bin/dflash/android-x86_64-cpu/`:

| Artifact | Size | Note |
|---|---|---|
| `llama-server` | 89.7 MB | `ELF 64-bit LSB pie executable, x86-64, interpreter /system/bin/linker64, not stripped` — i.e. a real Android x86_64 binary |
| `llama-cli` | 82.4 MB | |
| `llama-bench` | 5.7 MB | |
| `llama-completion` | 64.8 MB | |
| `llama-speculative-simple` | 64.5 MB | |
| `libllama.so` | 33.7 MB | |
| `libggml-base.so` / `libggml-cpu.so` / `libggml.so` / `libmtmd.so` | — | |

`CAPABILITIES.json`: `forkCommit = 536ff214` (the WS-2 TBQ3_TCQ-type-traits
fork branch), `kernels.qjl_full = true`, `kernels.polarquant = true` (the
AVX2 QJL/Polar TUs compiled — `probeKernels` greps the `llama-server --help`
cache-type whitelist, which the `patchServerKvCacheTypeNames` patch populates,
so this works on a cross-build). `dflash/turbo3/turbo4/turbo3_tcq = false` and
`publishable = false` — expected: those are attention-score-op capabilities
that `probeKernels` can only confirm by *running a dispatch* on the target, and
this is a non-runnable cross-build; the §3-completeness gate stays failing by
design for an Android cross-target (same as `android-arm64-cpu`). The binary
itself carries all the CPU kernel code.

## Cuttlefish `cvd` 8-step smoke — 5/6 infra steps PASS, step 6 needs a staged model

```
node packages/app-core/scripts/aosp/smoke-cuttlefish.mjs
```

against the live `cvd-1` instance:

| Step | Result | Detail |
|---|---|---|
| 1. cvd / device reachable via adb | **PASS** | `0.0.0.0:6520` device |
| 2. `ai.milady.milady` installed | **PASS** | `abi = x86_64` |
| 3. `ElizaAgentService` start | **PASS** | service started |
| 4. `/api/health` responds (≤600s) | **PASS** | `agentState = running`, `runtime = ok` |
| 5. Per-boot bearer token readable | **PASS** | 64 hex chars (run-as → su 0 fallback) |
| 6. POST chat → `/v1/chat/completions` | **FAIL** | `fetch failed / cause = UND_ERR_SOCKET / "other side closed"` — the on-device runtime returned no completion |
| 7. (would assert non-empty reply) | — | not reached |
| 8. (would assert `/api/local-inference/active` = ready, not cloud-routed) | — | not reached |

**Why step 6 fails (honest):** the cvd instance is running a *release*-build
privileged APK that has no Eliza-1 model staged in it (the app's
local-inference active-model state is empty), and the cvd has no cloud
credentials configured — so a chat completion request has nothing to route to
and the socket closes. The smoke harness's chat round-trip needs the APK on the
cvd to ship (or have downloaded) a model. This run did **not** rebuild the AOSP
image with the new `android-x86_64-cpu` libllama + a bundled model — that's the
remaining step to get a full 8/8 pass.

The path to a full 8/8 (one command, on this box, with an AOSP checkout):

```
node packages/app-core/scripts/aosp/build-aosp.mjs --aosp-root <AOSP> --launch --boot-validate
# (rebuilds the image with the android-x86_64-cpu libllama + the bundled
#  eliza-1-smoke GGUF staged into the privileged APK)
node packages/app-core/scripts/aosp/smoke-cuttlefish.mjs   # → 8/8
```

or, once a device/cvd has the right app build, `node
packages/app-core/scripts/aosp/deploy-pixel.mjs --abi x86_64 --skip-libllama
--skip-aosp-build --voice`.

## Vulkan-on-Cuttlefish (`android-x86_64-vulkan`) — best-effort, no recordable evidence

cvd exposes a virtio-gpu Vulkan ICD that is **gfxstream** (host GPU passthrough
on a host with a real GPU) or **SwiftShader** (CPU software rasterizer)
depending on the cvd build flags. A SwiftShader path is software → per the
fail-closed evidence rule it produces no recordable graph-dispatch evidence
(`vulkan-dispatch-smoke` would reject it as a software ICD). gfxstream on a
host with a real GPU could in principle pass, but cvd's gfxstream Vulkan
support is partial and the host GPU here is the Intel ANV iGPU (already covered
natively by `linux-x64-vulkan`). So `android-x86_64-vulkan` graph dispatch
stays **needs-hardware** — it wants real ChromeOS x86_64 GPU silicon
(Adreno/Mali under ARCVM). The standalone `vulkan_verify` fixtures pass on the
host ANV iGPU; they would pass under SwiftShader too but that doesn't count.

## Status

- `android-x86_64-cpu`: **build verified-here** (real x86_64 Android ELF
  binaries + libs, fork commit `536ff214`); Cuttlefish cvd smoke **5/6 infra
  steps PASS** (cvd reachable, APK installed, service start, `/api/health`,
  bearer token); step 6 chat round-trip needs a model staged in the APK on the
  cvd — a `build-aosp.mjs --launch` rebuild away from full 8/8. Recorded as
  `compile-only` / `needs-runtime-smoke` in `kernel-contract.json` with this
  exact state in `nextGate`.
- `android-x86_64-vulkan`: cross-build configured; graph dispatch
  **needs-hardware** (real ChromeOS GPU; cvd's gfxstream/SwiftShader is not
  recordable evidence).
- `android-x86_64-cpu-fused`: target registered (fused libelizainference for
  cvd/Chromebook); device verify host-gated.
