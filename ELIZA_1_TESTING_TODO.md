# Eliza-1 Hardware Testing TODO

Status as of 2026-05-11 on this workspace:

- macOS/Metal desktop graph dispatch has runtime evidence in `packages/inference/verify/metal-runtime-dispatch-evidence.json`.
- Standalone Vulkan SPIR-V fixtures pass on this Apple Silicon host through MoltenVK, including TurboQuant, QJL, PolarQuant, and Polar+QJL residual.
- Built-fork Vulkan graph dispatch source wiring now exists for `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_ATTN_SCORE_TBQ` (`turbo3`, `turbo4`, `turbo3_tcq`), and `GGML_OP_ATTN_SCORE_POLAR` (`use_qjl=0/1`), but runtime-ready capability bits stay false until native Vulkan graph smoke passes on physical hardware.
- `adb devices -l` currently shows only `emulator-5554`; emulator Vulkan is diagnostic only and is not recordable Eliza-1 hardware evidence.
- `xcrun xctrace list devices` currently shows `Shaw's iPhone (26.3.1)` offline even though `xcrun devicectl list devices` sees the iPhone 15 Pro as paired/available; simulator results are not physical iOS evidence.
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
The graph smoke links against the managed output directory by default (`$ELIZA_STATE_DIR/local-inference/bin/dflash/linux-x64-vulkan`) and fails closed if `libggml-vulkan.so` is missing. On pass it writes `packages/inference/verify/vulkan-runtime-dispatch-evidence.json` and rebuilds once so `CAPABILITIES.json` can flip Vulkan runtime capabilities without the smoke-only bootstrap override.

Android Vulkan on a physical Adreno/Mali device:

```bash
cd packages/inference/verify
make android-vulkan-smoke
```

Expected: rejects emulator/software Vulkan by default, cross-compiles the standalone verifier through the Android NDK, runs all six fixture routes on-device, then requires `ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE` proving full app/built-fork graph dispatch before runtime-ready capability bits may flip.

Current Vulkan blockers:

- Need physical Linux Intel/AMD/NVIDIA Vulkan smoke, not MoltenVK.
- Need physical Android Adreno and Mali smoke.
- This Mac cannot produce the native `libggml-vulkan.so` graph runtime evidence; `make -C packages/inference/verify vulkan-dispatch-smoke` is expected to fail closed here until run on physical Linux Vulkan hardware or supplied with real Android graph evidence.
- Current graph source patch advertises only the single-batch contiguous shapes covered by `vulkan_dispatch_smoke.cpp`; batched `ne[2]/ne[3]` support needs a separate graph smoke before it can be enabled.
- Android graph evidence must cover all six routes or the five runtime capability keys with finite `maxDiff`.

## CUDA

Native Linux NVIDIA:

```bash
cd packages/inference/verify
HOST_ID=$(hostname -s 2>/dev/null || hostname)
REPORT="hardware-results/cuda-linux-x64-${HOST_ID}.json"
mkdir -p hardware-results
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
ELIZA_DFLASH_HARDWARE_REPORT_DIR=hardware-results \
  ./cuda_runner.sh --report "$REPORT"
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!(r.status==="pass" && r.passRecordable && r.evidence?.gpuInfo && r.evidence?.toolchainInfo && r.evidence?.modelSha256)) { console.error(JSON.stringify(r,null,2)); process.exit(1); }' "$REPORT"
```

Remote NVIDIA host from a non-CUDA machine:

```bash
cd packages/inference/verify
REPORT=hardware-results/cuda-remote-linux-x64.json
CUDA_REMOTE=user@cuda-host \
CUDA_REMOTE_DIR=/path/to/eliza \
CUDA_REMOTE_REPORT=hardware-results/cuda-remote-linux-x64.json \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
ELIZA_DFLASH_HARDWARE_REPORT_DIR=hardware-results \
  ./cuda_runner.sh --report "$REPORT"
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!(r.status==="pass" && r.passRecordable && r.evidence?.gpuInfo && r.evidence?.toolchainInfo && r.evidence?.modelSha256)) { console.error(JSON.stringify(r,null,2)); process.exit(1); }' "$REPORT"
```

Current CUDA blockers:

- Requires Linux with `nvcc`, `nvidia-smi`, and a real NVIDIA GPU.
- Requires a real GGUF smoke model; fixture-only runs do not count.
- Remote collection must copy back the target-generated report; a local wrapper report with missing `gpuInfo`, `toolchainInfo`, or `modelSha256` is not recordable.
- Need at least one x64 CUDA pass and one aarch64 Hopper/GH200-class pass.

## ROCm

Native Linux AMD:

```bash
cd packages/inference/verify
HOST_ID=$(hostname -s 2>/dev/null || hostname)
REPORT="hardware-results/rocm-${HOST_ID}.json"
mkdir -p hardware-results
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
ELIZA_DFLASH_HARDWARE_REPORT_DIR=hardware-results \
ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_HIP_ARCHITECTURES=gfx942' \
  ./rocm_runner.sh --report "$REPORT"
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!(r.status==="pass" && r.passRecordable && r.evidence?.gpuInfo && r.evidence?.toolchainInfo && r.evidence?.modelSha256)) { console.error(JSON.stringify(r,null,2)); process.exit(1); }' "$REPORT"
```

Use `-DCMAKE_HIP_ARCHITECTURES=gfx90a` for MI250, `gfx942` for MI300, and
`gfx1100;gfx1101;gfx1102` for RDNA3-class consumer coverage. For RDNA4, pin
the exact `gfx*` agent reported by `rocminfo` before recording evidence.

Current ROCm blockers:

- Requires x86_64 Linux with `hipcc`, `rocminfo`, and a `gfx*` AMD GPU agent.
- No standalone HIP fixture harness exists yet; this runner is model-backed graph smoke only.
- Need at least one MI250/MI300-class pass and one RDNA3/RDNA4 consumer pass if those are target devices.

## GH200 / H200 / H100 Aarch64 CUDA

Native GH200/Hopper aarch64 Linux:

```bash
cd packages/inference/verify
HOST_ID=$(hostname -s 2>/dev/null || hostname)
REPORT="hardware-results/gh200-${HOST_ID}.json"
CUDA_REPORT="${REPORT%.json}.cuda.json"
mkdir -p hardware-results
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
ELIZA_DFLASH_HARDWARE_REPORT_DIR=hardware-results \
  ./gh200_runner.sh --report "$REPORT"
node -e 'const fs=require("node:fs"); for (const p of process.argv.slice(1)) { const r=JSON.parse(fs.readFileSync(p,"utf8")); if (!(r.status==="pass" && r.passRecordable && r.evidence?.gpuInfo && r.evidence?.modelSha256)) { console.error(p); console.error(JSON.stringify(r,null,2)); process.exit(1); } }' "$REPORT" "$CUDA_REPORT"
```

Current GH200 blockers:

- Requires aarch64 Linux userspace and H100/H200/GH200-class GPU or compute capability 9.x.
- Delegates to `cuda_runner.sh` with `CUDA_TARGET=linux-aarch64-cuda` and `-DCMAKE_CUDA_ARCHITECTURES=90a`.
- Save both the GH200 wrapper report and the delegated CUDA report (`${REPORT%.json}.cuda.json` by default).
- Needs real server hardware; this Mac cannot verify it.

## Windows

Native Windows CUDA:

```powershell
$ReportDir = "C:\temp\eliza-hardware-results"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$Report = Join-Path $ReportDir "windows-cuda-$env:COMPUTERNAME.json"
$env:ELIZA_DFLASH_HARDWARE_REPORT_DIR = $ReportDir
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cuda `
  -Model C:\models\eliza-1-smoke.gguf `
  -ReportDir $ReportDir `
  -Report $Report
$r = Get-Content $Report | ConvertFrom-Json
if (-not ($r.status -eq "pass" -and $r.passRecordable -and $r.evidence.gpuInfo -and $r.evidence.toolchainInfo -and $r.evidence.modelSha256)) { $r | ConvertTo-Json -Depth 8; throw "CUDA evidence is not recordable" }
```

Native Windows Vulkan:

```powershell
$ReportDir = "C:\temp\eliza-hardware-results"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$Report = Join-Path $ReportDir "windows-vulkan-$env:COMPUTERNAME.json"
$env:ELIZA_DFLASH_HARDWARE_REPORT_DIR = $ReportDir
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend vulkan `
  -Model C:\models\eliza-1-smoke.gguf `
  -ReportDir $ReportDir `
  -Report $Report
$r = Get-Content $Report | ConvertFrom-Json
if (-not ($r.status -eq "pass" -and $r.passRecordable -and $r.evidence.gpuInfo -and $r.evidence.modelSha256)) { $r | ConvertTo-Json -Depth 8; throw "Vulkan evidence is not recordable" }
```

Native Windows CPU:

```powershell
$ReportDir = "C:\temp\eliza-hardware-results"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$Report = Join-Path $ReportDir "windows-cpu-$env:COMPUTERNAME.json"
$env:ELIZA_DFLASH_HARDWARE_REPORT_DIR = $ReportDir
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cpu `
  -Model C:\models\eliza-1-smoke.gguf `
  -ReportDir $ReportDir `
  -Report $Report
$r = Get-Content $Report | ConvertFrom-Json
if (-not ($r.status -eq "pass" -and $r.passRecordable -and $r.evidence.modelSha256)) { $r | ConvertTo-Json -Depth 8; throw "CPU evidence is not recordable" }
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

- The physical iPhone is visible to CoreDevice as paired/available, but `xctrace` still lists UDID `00008130-001955E91EF8001C` as offline.
- Retrying with the CoreDevice identifier reached an interactive `Password:` prompt before XCTest output; do not enter credentials inside the runner.
- Simulator runs do not count as physical iOS evidence.
- Physical smoke must validate the embedded Metal library, Capacitor bridge load, and at least one real local-inference route from the app shell.

## Release Bundle Evidence

Before publishing any Eliza-1 bundle to Hugging Face:

- Generate final GGUF weights and fused bundle manifest.
- Keep VAD as the required `vad/silero-vad-int8.onnx` sidecar; do not
  treat every release payload as GGUF-only.
- Record SHA-256 for every payload file.
- Include license manifests for text, voice, ASR, VAD, vision, DFlash,
  and kernel sidecars.
- Run tier evals and hardware smoke for the target platform class.
- Upload to the `elizalabs` Hugging Face org and preserve upload logs/artifact URLs.

No final Eliza-1 release bundle is recordable until these artifacts exist.
