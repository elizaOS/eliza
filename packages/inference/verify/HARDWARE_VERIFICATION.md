# Hardware Verification Runners

Status: these are runnable entrypoints, not pass claims. Every runner fails
closed when hardware, toolchain, built fork artifact, or graph-smoke model is
missing.

The required distinction:

- `make metal-verify` / `make vulkan-verify` / `make cuda-verify` prove fixture
  parity for standalone or thin-wrapper kernels.
- The hardware runners below also run `llama-cli` with `--cache-type-k` through
  a real GGUF model, then grep the backend log. That is the minimum acceptable
  runtime graph-dispatch smoke until a deeper per-op profiler is wired.

## Shared graph-smoke contract

All GPU runners require a small GGUF model:

```bash
export ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf
```

By default the smoke resolves and runs every advertised cache family:

- `turbo3`: `tbq3_0` or `turbo3`
- `turbo4`: `tbq4_0` or `turbo4`
- `turbo3_tcq`: `tbq3_tcq`, `turbo3_tcq`, or `turbo3-tcq`
- `qjl`: `qjl1_256`, `qjl_full`, or `qjl`
- `polar`: `q4_polar`, `polarquant`, or `polar`

Override only for bring-up:

```bash
export ELIZA_DFLASH_SMOKE_CACHE_TYPES="tbq3_0 qjl1_256"
export ELIZA_DFLASH_SMOKE_TOKENS=4
export ELIZA_DFLASH_SMOKE_NGL=99
```

Logs land under `packages/inference/verify/hardware-results/` unless
`ELIZA_DFLASH_HARDWARE_REPORT_DIR` is set.

Every runner also supports machine-readable evidence:

```bash
./cuda_runner.sh --report hardware-results/cuda-evidence.json
./gh200_runner.sh --report hardware-results/gh200-evidence.json
./rocm_runner.sh --report hardware-results/rocm-evidence.json
```

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cuda `
  -Model C:\models\eliza-1-smoke.gguf `
  -Report hardware-results\windows-cuda-evidence.json
```

The JSON report includes `status`, `passRecordable`, host OS/arch, target,
required hardware/toolchain gates, model path/hash where available, and backend
evidence. A report with `passRecordable: false`, a skipped graph smoke, or a
non-zero runner exit is not publishable hardware evidence.

When `--report` / `-Report` is provided, report generation is part of the
gate. A runner pass without the requested JSON file is not recordable.

## CUDA Linux x64

Prereqs:

- Linux x86_64.
- NVIDIA driver with `nvidia-smi -L` showing at least one GPU.
- CUDA Toolkit with `nvcc` on `PATH`.
- GGUF smoke model in `ELIZA_DFLASH_SMOKE_MODEL`.

Run:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf ./cuda_runner.sh
```

The runner:

1. Fails if `nvcc`, `nvidia-smi`, or a GPU is missing.
2. Builds `linux-x64-cuda` unless `CUDA_BUILD_FORK=0`.
3. Runs `make cuda-verify` against all six fixtures, including
   `polar_qjl.json`.
4. Runs model-backed graph smoke for every cache family and requires CUDA /
   NVIDIA backend evidence in the log.

Remote CUDA host:

```bash
cd packages/inference/verify
CUDA_REMOTE=user@cuda-host \
CUDA_REMOTE_DIR=~/code/eliza \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
./cuda_runner.sh --report hardware-results/cuda-remote-evidence.json
```

Fixture-only bring-up is allowed but must not be recorded as runtime-ready:

```bash
CUDA_SKIP_GRAPH_SMOKE=1 ./cuda_runner.sh
```

That skip mode exits non-zero by design. Use it only to inspect preflight or
fixture failures, not in CI/pass collection.

For remote collection, `--report` is the local destination. The runner asks the
remote host to write `CUDA_REMOTE_REPORT` or, by default, a same-basename JSON
under the remote checkout's `packages/inference/verify/hardware-results/`, then
copies that target-generated report back. Do not record a local wrapper report
that lacks remote GPU/toolchain evidence.

## GH200 / Linux aarch64 CUDA

Prereqs:

- Linux aarch64/arm64 userspace.
- H100/H200/GH200-class GPU, or compute capability 9.x visible via
  `nvidia-smi`.
- CUDA Toolkit with `nvcc`.
- GGUF smoke model.

Run:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf ./gh200_runner.sh
```

The runner pins:

```bash
CUDA_TARGET=linux-aarch64-cuda
ELIZA_DFLASH_CMAKE_FLAGS=-DCMAKE_CUDA_ARCHITECTURES=90a
```

It then delegates to `cuda_runner.sh`, so the same fixture and graph-smoke
requirements apply.

When `--report hardware-results/gh200-evidence.json` is used, the wrapper also
writes delegated CUDA evidence to
`hardware-results/gh200-evidence.cuda.json` unless `GH200_DELEGATE_REPORT` is
set. Both JSON files should be saved with the raw graph-smoke logs.

## ROCm Linux x64

Prereqs:

- Linux x86_64.
- ROCm/HIP with `hipcc` and `rocminfo` on `PATH`.
- `rocminfo` must list at least one `gfx*` GPU agent.
- GGUF smoke model.

Run:

```bash
cd packages/inference/verify
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf ./rocm_runner.sh
```

The runner:

1. Fails if `hipcc`, `rocminfo`, or a `gfx*` AMD GPU agent is missing.
2. Builds `linux-x64-rocm` unless `ROCM_BUILD_FORK=0`.
3. Runs model-backed graph smoke for every cache family and requires HIP /
   ROCm backend evidence in the log.

Default ROCm arch pin:

```bash
ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_HIP_ARCHITECTURES=gfx90a;gfx942;gfx1100;gfx1101;gfx1102'
```

There is still no standalone HIP fixture harness equivalent to
`cuda_verify.cu`; ROCm cannot be marked fixture-parity verified until that
exists and passes on MI250/MI300/RDNA hardware.

`ROCM_SKIP_GRAPH_SMOKE=1` exits non-zero by design because it does not produce
runtime dispatch evidence.

## Vulkan Linux x64

Prereqs:

- Native Linux x86_64 host. macOS/MoltenVK does not satisfy this runner.
- Vulkan runtime/SDK with `vulkaninfo` showing a hardware Intel, AMD, or
  NVIDIA Vulkan device. Software ICDs are rejected unless
  `ELIZA_ALLOW_SOFTWARE_VULKAN=1` is set for diagnostics.

Run:

```bash
cd packages/inference/verify
./linux_vulkan_smoke.sh
```

The runner writes a timestamped evidence log under `hardware-results/`, runs
the standalone fixture gate, builds `linux-x64-vulkan`, dumps
`CAPABILITIES.json`, and then runs `make vulkan-dispatch-smoke` against the
managed output directory
`$ELIZA_STATE_DIR/local-inference/bin/dflash/linux-x64-vulkan` unless
`ELIZA_DFLASH_VULKAN_BIN_DIR` is explicitly set. If the build only produces
symbol/pipeline staging or exits through the required-kernel publish gate, the
runner stops there and refuses to use stale binaries.

Direct `make vulkan-dispatch-smoke` is a native Linux graph-dispatch gate. It
rejects macOS/MoltenVK by default, prints both the managed output and build-tree
artifact candidates, and requires a directory containing `libggml-vulkan.so`.

`ELIZA_DFLASH_SKIP_BUILD=1` is only accepted with
`ELIZA_DFLASH_ALLOW_PREBUILT_VULKAN_SMOKE=1` and an existing
`CAPABILITIES.json`; the graph-dispatch smoke still has to pass.

## Android Vulkan

Prereqs:

- Android NDK with shader tools (`glslc`).
- `adb` and a physical Adreno/Mali-class Android device. Emulators are rejected
  unless `ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1` is set for diagnostics.

Run:

```bash
cd packages/inference/verify
./android_vulkan_smoke.sh
```

The runner cross-compiles `vulkan_verify`, pushes the verifier, SPIR-V, and
fixtures through `adb`, records device/Vulkan evidence, and runs all six
canonical fixtures on device. Standalone fixture success is not enough for a
runtime-ready claim: the script fails closed unless
`ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE` points at a built-fork/app graph-dispatch
report with `backend=vulkan`, `platform=android`, `runtimeReady=true`, and
finite `maxDiff` evidence for either all six graph routes
(`GGML_OP_ATTN_SCORE_QJL`, the three `GGML_OP_ATTN_SCORE_TBQ/*` routes, and
both `GGML_OP_ATTN_SCORE_POLAR/use_qjl=*` routes) or the five runtime
capability keys (`turbo3`, `turbo4`, `turbo3_tcq`, `qjl_full`,
`polarquant`).

## Windows

Prereqs:

- Native Windows host. Cross-built `.exe` files do not satisfy this runner.
- PowerShell 7+ (`pwsh`) recommended.
- For CUDA: `nvidia-smi`, `nvcc`, and an NVIDIA GPU.
- For Vulkan: Vulkan runtime/SDK with `vulkaninfo` showing a device.
- GGUF smoke model.

Run CUDA:

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend cuda `
  -Model C:\models\eliza-1-smoke.gguf
```

Run Vulkan:

```powershell
pwsh -File packages/inference/verify/windows_runner.ps1 `
  -Backend vulkan `
  -Model C:\models\eliza-1-smoke.gguf
```

Windows ARM64 uses `windows-arm64-vulkan` or `windows-arm64-cpu`; CUDA is not
declared for that target.

The script builds the native target unless `WINDOWS_BUILD_FORK=0`, then runs
the same `--cache-type-k` graph-smoke family loop. It fails if backend evidence
is missing from the logs.

`WINDOWS_SKIP_GRAPH_SMOKE=1` exits non-zero by design because it does not
produce runtime dispatch evidence.

## Recording a real pass

Only after a runner exits zero on matching hardware:

1. Save the full `hardware-results/` directory under
   `packages/inference/reports/porting/<date>/`.
2. Save the runner `--report` JSON beside the raw logs. It must show
   `status: "pass"` and `passRecordable: true`.
3. Record host, OS, driver, toolkit, GPU model, target, model hash, command
   line, and max fixture diff where applicable.
4. Update `packages/inference/README.md` and
   `packages/inference/verify/kernel-contract.json` from `needs-hardware` to a
   narrower status only for the exact backend/device class observed.

Do not transfer a CUDA result to ROCm, a Windows result to Linux, or a GH200
result to x64 H100 without a separate run.
