# Eliza-1 Hardware Testing TODO

Status as of 2026-05-11 on this workspace:

- macOS/Metal desktop graph dispatch has runtime evidence in `packages/inference/verify/metal-runtime-dispatch-evidence.json`.
- Standalone Vulkan SPIR-V fixtures pass on this Apple Silicon host through MoltenVK, including TurboQuant, QJL, PolarQuant, and Polar+QJL residual.
- Built-fork Vulkan graph dispatch source wiring now exists for `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` (`turbo3`, `turbo4`, `turbo3_tcq`), and `GGML_OP_ATTN_SCORE_POLAR` (`use_qjl=0/1`), but runtime-ready capability bits stay false until native Vulkan graph smoke passes on physical hardware.
- `adb devices -l` currently shows only `emulator-5554`; emulator Vulkan is diagnostic only and is not recordable Eliza-1 hardware evidence.
- `xcrun xctrace list devices` currently shows `Shaw's iPhone (26.3.1)` offline; simulator results are not physical iOS evidence.
- CUDA, ROCm, GH200, and native Windows runners are present and fail closed, but this Mac cannot provide recordable target hardware evidence.
- No final Eliza-1 release bundles exist yet with final weights, hashes, eval outputs, license manifests, and Hugging Face upload evidence.

## Pass Criteria

A platform result is recordable only when all of these are true:

- Runner exits with `exitCode=0`, `status=pass`, and `passRecordable=true`.
- The runner records hardware/toolchain metadata and model SHA-256.
- Graph dispatch is exercised through the built fork or app runtime, not only standalone shader symbols.
- Numeric fixture routes report finite `maxDiff` where a fixture harness is available.
- Software Vulkan, emulators, simulators, and skipped graph smoke are explicitly diagnostic only.

## Vulkan

Native Linux Vulkan:

```bash
cd packages/inference/verify
./linux_vulkan_smoke.sh
```

Expected: rejects non-Linux/MoltenVK and software ICDs unless explicitly allowed, runs `make reference-test kernel-contract vulkan-verify`, builds `linux-x64-vulkan`, dumps `CAPABILITIES.json`, then runs `make vulkan-dispatch-smoke`.
On pass it writes `packages/inference/verify/vulkan-runtime-dispatch-evidence.json` and rebuilds once so `CAPABILITIES.json` can flip Vulkan runtime capabilities without the smoke-only bootstrap override.

Android Vulkan on a physical Adreno/Mali device:

```bash
cd packages/inference/verify
make android-vulkan-smoke
```

Expected: rejects emulator/software Vulkan by default, cross-compiles the standalone verifier through the Android NDK, runs all six fixture routes on-device, then requires `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE` proving full app/built-fork graph dispatch before runtime-ready capability bits may flip.

Current Vulkan blockers:

- Need physical Linux Intel/AMD/NVIDIA Vulkan smoke, not MoltenVK.
- Need physical Android Adreno and Mali smoke.
- Current graph source patch advertises only the single-batch contiguous shapes covered by `vulkan_dispatch_smoke.cpp`; batched `ne[2]/ne[3]` support needs a separate graph smoke before it can be enabled.
- Android graph evidence must cover all six routes or the five runtime capability keys with finite `maxDiff`.

## CUDA

Native Linux NVIDIA:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
  ./cuda_runner.sh --report hardware-results/cuda-$(hostname).json
```

Remote NVIDIA host from a non-CUDA machine:

```bash
cd packages/inference/verify
CUDA_REMOTE=user@cuda-host \
CUDA_REMOTE_DIR=/path/to/eliza \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
  ./cuda_runner.sh --report hardware-results/cuda-remote.json
```

Current CUDA blockers:

- Requires Linux with `nvcc`, `nvidia-smi`, and a real NVIDIA GPU.
- Requires a real GGUF smoke model; fixture-only runs do not count.
- Need at least one x64 CUDA pass and one aarch64 Hopper/GH200-class pass.

## ROCm

Native Linux AMD:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
  ./rocm_runner.sh --report hardware-results/rocm-$(hostname).json
```

Current ROCm blockers:

- Requires x86_64 Linux with `hipcc`, `rocminfo`, and a `gfx*` AMD GPU agent.
- No standalone HIP fixture harness exists yet; this runner is model-backed graph smoke only.
- Need at least one MI250/MI300-class pass and one RDNA3/RDNA4 consumer pass if those are target devices.

## GH200 / H200 / H100 Aarch64 CUDA

Native GH200/Hopper aarch64 Linux:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
  ./gh200_runner.sh --report hardware-results/gh200-$(hostname).json
```

Current GH200 blockers:

- Requires aarch64 Linux userspace and H100/H200/GH200-class GPU or compute capability 9.x.
- Delegates to `cuda_runner.sh` with `CUDA_TARGET=linux-aarch64-cuda` and `-DCMAKE_CUDA_ARCHITECTURES=90a`.
- Needs real server hardware; this Mac cannot verify it.

## Windows

Native Windows CUDA:

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cuda `
  -Model C:\models\eliza-1-smoke.gguf `
  -Report C:\temp\eliza-cuda.json
```

Native Windows Vulkan:

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend vulkan `
  -Model C:\models\eliza-1-smoke.gguf `
  -Report C:\temp\eliza-vulkan.json
```

Native Windows CPU:

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cpu `
  -Model C:\models\eliza-1-smoke.gguf `
  -Report C:\temp\eliza-cpu.json
```

Current Windows blockers:

- Must run on native Windows; Wine/VM/syntax-only parse is not recordable.
- CUDA path needs `nvcc` and `nvidia-smi`.
- Vulkan path needs `vulkaninfo` and a real Windows Vulkan device.
- CPU path verifies native execution but not GPU dispatch.

## iOS

Physical iOS smoke:

```bash
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs
```

Current iOS blockers:

- The only iPhone currently visible to Xcode is offline.
- Simulator runs do not count as physical iOS evidence.
- Physical smoke must validate the embedded Metal library, Capacitor bridge load, and at least one real local-inference route from the app shell.

## Release Bundle Evidence

Before publishing any Eliza-1 bundle to Hugging Face:

- Generate final GGUF weights and fused bundle manifest.
- Record SHA-256 for every payload file.
- Include license manifests for text, voice, ASR, vision, DFlash, and kernel sidecars.
- Run tier evals and hardware smoke for the target platform class.
- Upload to the `elizalabs` Hugging Face org and preserve upload logs/artifact URLs.

No final Eliza-1 release bundle is recordable until these artifacts exist.
