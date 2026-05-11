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
./cuda_runner.sh
```

Fixture-only bring-up is allowed but must not be recorded as runtime-ready:

```bash
CUDA_SKIP_GRAPH_SMOKE=1 ./cuda_runner.sh
```

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

## Recording a real pass

Only after a runner exits zero on matching hardware:

1. Save the full `hardware-results/` directory under
   `packages/inference/reports/porting/<date>/`.
2. Record host, OS, driver, toolkit, GPU model, target, model hash, command
   line, and max fixture diff where applicable.
3. Update `packages/inference/README.md` and
   `packages/inference/verify/kernel-contract.json` from `needs-hardware` to a
   narrower status only for the exact backend/device class observed.

Do not transfer a CUDA result to ROCm, a Windows result to Linux, or a GH200
result to x64 H100 without a separate run.
