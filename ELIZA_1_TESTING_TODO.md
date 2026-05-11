# Eliza-1 Hardware Testing TODO

Status as of 2026-05-11 on this workspace:

- macOS/Metal desktop graph dispatch has runtime evidence in `packages/inference/verify/metal-runtime-dispatch-evidence.json`.
- **Native Linux Vulkan graph dispatch now PASSES on real hardware** (Intel Arc/Xe via Mesa ANV). `vulkan-dispatch-smoke` reported 6/6 graph routes pass against `libggml-vulkan` built from the milady-llama-cpp fork; evidence `packages/inference/verify/vulkan-runtime-dispatch-evidence.json` (`runtimeReady: true`, all 5 kernels, `maxDiff` 2.7e-7…1.9e-6) + `packages/inference/verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log`. `kernel-contract.json`'s `runtimeStatus.vulkan` is `runtime-ready` for turbo3/turbo4/turbo3_tcq/qjl/polar; `make -C packages/inference/verify kernel-contract` is green. Standalone Vulkan SPIR-V fixtures also still pass on Apple Silicon through MoltenVK.
- `adb devices -l` currently shows only `emulator-5554`; emulator Vulkan is diagnostic only and is not recordable Eliza-1 hardware evidence. Adreno/Mali/AMD/NVIDIA-native Vulkan graph dispatch still needed.
- Physical iOS XCFramework smoke now passes on `Shaw's iPhone (26.3.1)` / iPhone 15 Pro UDID `00008130-001955E91EF8001C`; simulator results remain non-recordable for release bundle evidence.
- CUDA, ROCm, GH200, and native Windows runners are present and fail closed, but no host in this workspace can provide recordable target hardware evidence (the dGPU on this box is in D3cold with no kmod / nvcc; pending-evidence stub at `packages/inference/verify/hardware-results/cuda-linux-thismachine-2026-05-11.pending.json`).
- New `SUPPORTED_TARGETS` / `kernel-contract.json` platform targets (23 total): `linux-aarch64-{cpu,cuda}`, `windows-arm64-{cpu,vulkan}`, `windows-x64-vulkan`, `darwin-x64-metal` with cmake plumbing + CUDA arch pins (incl. Blackwell `sm_120`, GH200 `sm_90a`). All `needs-hardware`.
- CPU: AVX-VNNI int8-QJL path (5.25× on this box) + Polar pre-Hadamard SIMD + ARM dotprod variants landed in `qjl-cpu`/`polarquant-cpu`; bench `packages/inference/verify/bench_results/cpu_avxvnni_2026-05-11.json`, baseline `packages/inference/verify/hardware-results/linux-thismachine-cpu-baseline-2026-05-11.json`.
- Fused-attention foundation: C reference (`eliza_fused_attn_qjl_tbq3`, bit-exact to the fork's CPU op) + fixtures `verify/fixtures/{fused_attn_qjl_tbq.json,fused_attn_qjl_polar.json,polar_preht.json}` + contract doc `reports/porting/2026-05-11/fused-attn-op-contract.md`. Registered in `kernel-contract.json`'s `fusedAttn` section with `fused_attn` capability key (`needs-runtime-smoke` for vulkan/metal — no fused shader+harness path yet; `needs-hardware` for cuda — `cuda_verify` parses the fixture but no NVIDIA host has run it). NOT yet a `requiredRuntimeCapabilityKey`/`manifestKernelName`.
- A `27b-1m` (1M-context, CUDA-only-backend) tier is now in the catalog/schema/Python manifest/platform-plan; needs real GH200 verify before `defaultEligible`.
- Local release-shaped Eliza-1 bundles exist for all five shipping tiers with source/candidate stand-ins, quantization sidecars, checksums, manifests, and fail-closed `evidence/release.json`; no final Eliza-1 release bundle exists yet with final weights, passing evals, release licenses, platform evidence, and Hugging Face upload evidence.

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

- **DONE for native Linux Intel-ANV:** `vulkan-dispatch-smoke` 6/6 PASS on Intel Arc/Xe (Mesa ANV); evidence `packages/inference/verify/vulkan-runtime-dispatch-evidence.json` + `hardware-results/linux-vulkan-smoke-20260511T145056Z.log`. `kernel-contract.json` `runtimeStatus.vulkan` = `runtime-ready` for the 5 score kernels.
- Still need: native AMD and NVIDIA desktop Vulkan smoke (Intel-ANV is one device class), and physical Android Adreno + Mali graph dispatch.
- Fused-attention on Vulkan/Metal: no fused compute shader + `cases`-array harness path yet — `make -C packages/inference/verify vulkan-verify-fused` / `metal-verify-fused` fail by design; `fusedAttn.runtimeStatus.{vulkan,metal}` = `needs-runtime-smoke`. CUDA: `cuda_verify` parses `fused_attn_qjl_tbq.json` but needs an NVIDIA host (`cuda-verify` gated behind `cuda_runner.sh`).
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

- XCFramework physical-device smoke is PASS as of 2026-05-11:
  `packages/inference/verify/hardware-results/ios-device-smoke-2026-05-11.json`
  reports 3/3 XCTest cases passing without `--skip-voice-abi`.
- The fixed runner treats CoreDevice `connected` state as connected, and
  `build-xcframework.mjs` refreshes the runtime ABI shim before packaging so
  stale shim archives cannot reintroduce the old TTS ABI crash.
- Remaining iOS blocker: run a real Eliza-1 bundle smoke from the Capacitor app
  shell with final text + DFlash + TTS + ASR payloads and record first token,
  first audio, peak RSS, thermal state, and at least one local voice route.
- Simulator runs do not count as physical iOS evidence.

## Release Bundle Evidence

Before publishing any Eliza-1 bundle to Hugging Face:

- Generate final GGUF weights and fused bundle manifest.
- Keep VAD as the required `vad/silero-vad-int8.onnx` sidecar; do not
  treat every release payload as GGUF-only.
- Record SHA-256 for every payload file.
- Include license manifests for text, voice, ASR, VAD, vision, DFlash,
  and kernel sidecars.
- Run tier evals and hardware smoke for the target platform class.
- Upload to the `elizaos` Hugging Face org and preserve upload logs/artifact URLs.

Current local bundles under `/Users/shawwalters/.eliza/local-inference/models/eliza-1-*.bundle`
are complete enough for runtime-layout smoke: every tier has required local
`text/`, `tts/`, `asr/`, `vad/`, `dflash/`, `cache/`, `quantization/`,
`checksums/`, `licenses/`, and `evidence/` paths, and every
`checksums/SHA256SUMS` has been revalidated. They are not recordable release
artifacts because `evidence/release.json` is intentionally
`releaseState=local-standin` and `publishEligible=false`.

Note (this checkout / Linux x64, 2026-05-11): no staged Eliza-1 bundle exists
in this checkout's state dir and no HF write token is present, so no upload
was attempted. A publish dry-run against a hand-built
`releaseState=upload-candidate` stand-in bundle exits `16`
(`EXIT_RELEASE_EVIDENCE_FAIL`) at stage 2 — the orchestrator correctly
refuses it. The publish-pipeline machinery is covered by
`pytest packages/training/scripts/{test_hf_publish.py,publish/test_orchestrator.py,manifest/test_eliza1_*.py,manifest/test_stage_local_eliza1_bundle.py}`
(97 passed, 1 skipped).

### Device-side downloader contract (§7)

The §7 device-side download contract is exercised by
`bun test packages/app-core/src/services/local-inference/downloader.test.ts`:
manifest-first read, schema-version rejection (via `parseManifestOrThrow`),
RAM-budget abort before any weight byte, no-overlapping-verified-backend
abort before any weight byte, per-file sha256 + resume, and the
`verifyOnDevice` hook gating readiness / default-slot fill. Remaining:
the engine has not yet wired the real `verifyOnDevice` smoke (load →
1-token text → 1-phrase voice → barge-in cancel) into `service.ts`, and the
recommendation engine does not yet call `canSetAsDefault` against the
device's available backends.
