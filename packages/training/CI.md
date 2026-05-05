# Training Stack CI

Operator note for `.github/workflows/training-stack.yml` and the two
Dockerfiles that back it.

## What runs in CI

| Lane        | Trigger                              | Runner                          | Purpose                                                                 |
| ----------- | ------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| `cpu-smoke` | Every PR / push touching `training/**` | GitHub-hosted `ubuntu-22.04`    | Build `Dockerfile.cpu`, lint `training/scripts/`, import-probe registry |
| `gpu-build` | Every PR / push touching `training/**` | Self-hosted `gpu-cuda-12.6`     | Build full `Dockerfile`, exercise QJL nvcc compile + Triton JIT, run `test_qjl.py` |

The GPU lane validates the part of the stack that is most likely to
break on a fresh box: nvcc + python headers + torch CUDA arch list +
Triton compiler wiring. The CPU lane validates the part that is fast to
catch and trivial to reproduce locally.

## CUDA / torch / python pin

| Component | Pin                                  | Source                                    |
| --------- | ------------------------------------ | ----------------------------------------- |
| Base image | `nvidia/cuda:12.6.3-devel-ubuntu22.04` | `training/Dockerfile` `CUDA_IMAGE` ARG  |
| Python    | 3.12 (deadsnakes ppa for cuda image) | `training/Dockerfile`                     |
| torch     | `>=2.5.0,<2.11` → resolves to 2.10.0 | `training/pyproject.toml` `train` extra   |
| triton    | 3.6.0 (transitive)                   | `training/uv.lock`                        |
| TORCH_CUDA_ARCH_LIST | `8.0;8.9;9.0;10.0;12.0+PTX` | `training/Dockerfile` (covers Ampere → Blackwell) |

If `pyproject.toml` bumps the torch floor past a CUDA generation, bump
the `CUDA_IMAGE` tag in `Dockerfile` *and* the runner label in
`training-stack.yml` in the same PR.

## How to reproduce locally

GPU image (full stack, exercises the QJL nvcc compile):

```bash
docker build -f training/Dockerfile -t milady-training:dev training/
docker run --gpus all -it milady-training:dev bash
# inside:
python scripts/quantization/test_qjl.py
```

CPU image (lint / import probe / cheap tests):

```bash
docker build -f training/Dockerfile.cpu -t milady-training-cpu:dev training/
docker run --rm milady-training-cpu:dev \
  -c "python -c 'from training.model_registry import REGISTRY; print(list(REGISTRY))'"
```

For a non-Docker bare-metal box (Vast / Lambda / on-prem), install
`nvidia-cuda-toolkit` and `python3.12-dev` from your distro and run the
single shell wrapper:

```bash
bash training/scripts/build_quantization_extensions.sh
```

The wrapper builds QJL in-place and verifies `fused_turboquant_vendored`
imports under the active Python.

## If the GPU runner is offline

The `gpu-build` job is gated on a runner with the `gpu-cuda-12.6` label.
**If no such runner is online, GitHub queues the job — it does not fail
the workflow.** PRs are not blocked by GPU-runner availability; the
queued job simply waits (or times out at 60 minutes). The `cpu-smoke`
job is independent and always runs.

When the GPU runner is brought back up, queued jobs pick up
automatically. There is no manual re-queue step.

## Required system packages on the GPU runner host

If you are bringing up a new self-hosted GPU runner from scratch, the
only host requirements are:

- A working NVIDIA driver (CUDA 12.6 capable — driver 555+).
- `docker` + the `nvidia-container-toolkit` so `--gpus all` works.
- The GitHub Actions runner agent registered with the `gpu-cuda-12.6`
  label.

Everything else (nvcc, python, torch, triton, QJL build) lives inside
the image and is exercised by the workflow on every run.
