# CUDA verification runbook

Status: harness compiles (preprocessor-clean on M4 Max) — full nvcc compile,
fixture parity, and model-backed graph dispatch require a CUDA host.
**Hardware result: NEEDS-HARDWARE** until `cuda_runner.sh` exits zero on a
real NVIDIA GPU and the result lands in `packages/inference/README.md`.

This is the sibling of `metal_verify` (Apple GPU) and `vulkan_verify`
(cross-vendor). It loads the canonical fixtures from
`verify/fixtures/{turbo3,turbo4,turbo3_tcq,qjl,polar,polar_qjl}.json`, dispatches the
in-fork CUDA kernels (v0.4.0-milady) against the same input bytes, and diffs
output against the reference at tolerance 1e-3.

## What the harness verifies

| Kernel       | CUDA path exercised                                                        | Production-path? |
| ------------ | -------------------------------------------------------------------------- | ---------------- |
| `turbo3`     | `tbq_decode_block_cuda(block_tbq3_0)` (turboquant.cuh) via thin wrapper    | YES — same device function shipped fattn / mul_mat_q calls |
| `turbo4`     | `tbq_decode_block_cuda(block_tbq4_0)` (turboquant.cuh) via thin wrapper    | YES — same device function shipped fattn / mul_mat_q calls |
| `turbo3_tcq` | `dequantize_row_tbq3_tcq_cuda(...)` linked from libggml-cuda.so + host dot | YES — exported symbol |
| `qjl`        | `attn_score_qjl_cuda(...)` linked from libggml-cuda.so                     | YES — exported symbol, direct fixture match |
| `polar`      | `dequantize_row_q4_polar_cuda(...)` linked from libggml-cuda.so + host dot | YES — exported symbol |

The fork ships **no** exported `turbo3_score` / `turbo4_score` symbol — the
shipped CUDA path consumes `tbq_decode_block_cuda` from inside fattn and
mul_mat_q. The harness instantiates the smallest possible `__global__`
wrapper around the SAME device-side helper to give the per-block fixture an
end-to-end dispatch surface to test. Wrapper source: `cuda_verify.cu` →
`tbq_score_kernel<TBlock>`. This is verifying the same decode bits, not a
re-implementation.

## What the fixture bytes encode

Each fixture is a JSON record produced by `gen_fixture` (CPU reference) and
contains:

- `kernel`: one of turbo3 / turbo4 / turbo3_tcq / qjl / polar.
- input bytes: `q` (fp32 query) or `q_sketch` (qjl), plus `k_blocks`
  (raw byte image of the corresponding `block_*` struct array).
- `expected_scores`: fp32 per-output reference from `qjl_polar_ref.c` /
  `turbo_kernels.c` — the same reference Metal and Vulkan match.

The CUDA path must accept the **exact same `k_blocks` byte image** because
the in-fork CUDA `block_*` layouts in `ggml-common.h` are byte-identical to
the layouts the CPU reference encodes. If a mismatch appears it indicates
the CUDA fork has drifted from `ggml-common.h`, not a fixture bug.

`polar_qjl.json` is mandatory coverage for PolarQuant's QJL residual branch.
A CUDA run that only covers `polar.json` is incomplete.

## Prereqs (CUDA host)

1. NVIDIA driver + GPU. `nvidia-smi` must show a device.
2. CUDA Toolkit ≥ 12.0 (provides `nvcc`).
   - Ubuntu/Debian: `sudo apt install nvidia-cuda-toolkit`
   - Or download from: https://developer.nvidia.com/cuda-downloads
3. Built `libggml-cuda.so` from the Milady fork. Easiest path:
   ```bash
   cd path/to/eliza
   bun run build:llama-dflash -- --target linux-x64-cuda
   ```
   This populates `~/.cache/eliza-dflash/milady-llama-cpp/` and the build
   under `build-cuda/`.

## End-to-end invocation

### Local CUDA host

```bash
cd packages/inference/verify

# (a) Build CPU reference object + the harness.
make $(QJL_POLAR_OBJ:=)        # gets the qjl_polar_ref.o dependency
CUDA_HOME=/usr/local/cuda \
ELIZA_DFLASH_LLAMA_DIR=$HOME/.cache/eliza-dflash/milady-llama-cpp \
ELIZA_DFLASH_LIBGGML_CUDA=$HOME/.cache/eliza-dflash/milady-llama-cpp/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so \
make cuda

# (b) Run all six fixtures.
make cuda-verify

# (c) Full hardware gate: build fork, run fixtures, then run graph dispatch
#     through a real GGUF model with --cache-type-k for every advertised
#     Turbo/QJL/Polar family.
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf ./cuda_runner.sh
```

Each fixture should print:
```
[cuda_verify] kernel=<name> outputs=8
  i=0 expected=... got=... diff=... PASS
  ...
[cuda_verify] PASS — 8/8 passed (tol=1e-03)
```

### Driving a remote CUDA host from a non-CUDA dev box

```bash
# From an M4 Max / any host without a GPU:
CUDA_REMOTE=user@cuda-host \
CUDA_REMOTE_DIR=~/code/eliza \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
./cuda_runner.sh
```

The runner ssh-runs `make cuda-verify` on the remote and streams output
back. The remote must already have the eliza checkout at
`$CUDA_REMOTE_DIR` and the prereqs above.

## What `cuda_runner.sh` now enforces

`cuda_runner.sh` is stricter than `make cuda-verify`:

1. It fails unless the host is Linux, `nvcc` is present, and `nvidia-smi`
   reports an NVIDIA GPU.
2. It builds the fork target (`linux-x64-cuda` or `linux-aarch64-cuda`) unless
   `CUDA_BUILD_FORK=0`.
3. It runs `make cuda-verify`, which covers all six fixtures including
   `polar_qjl.json`.
4. It requires `ELIZA_DFLASH_SMOKE_MODEL` and runs
   `runtime_graph_smoke.sh`, which drives `llama-cli --cache-type-k` for
   Turbo3, Turbo4, Turbo3-TCQ, QJL, and Polar aliases. The logs must contain
   CUDA/NVIDIA backend evidence.

`CUDA_SKIP_GRAPH_SMOKE=1` is permitted only for fixture-only bring-up. It must
not be recorded as runtime-ready graph dispatch.

GH200-class hosts should use `./gh200_runner.sh`, which requires arm64 Linux
userspace plus Hopper/compute-capability-9.x GPU evidence and pins
`linux-aarch64-cuda` with `-DCMAKE_CUDA_ARCHITECTURES=90a`.

The cross-backend runner doc is `HARDWARE_VERIFICATION.md`.

## Verification on this M4 Max (what was actually checked)

A. `nvcc --version` — **absent** on Darwin. The Makefile gate emits the
   expected diagnostic ("CUDA toolchain not found — install via
   `apt install nvidia-cuda-toolkit` (Linux) or download the CUDA Toolkit
   (macOS not supported).") and exits non-zero on `make cuda` /
   `make cuda-verify`. Source-level correct, runtime gated.

B. `make cuda-preprocess-check` — **PASS** when the milady-llama-cpp
   checkout is present at `~/.cache/eliza-dflash/milady-llama-cpp`. The
   target asserts that every CUDA API symbol cuda_verify.cu calls
   (`tbq_decode_block_cuda`, `dequantize_row_tbq3_tcq_cuda`,
   `attn_score_qjl_cuda`, `dequantize_row_q4_polar_cuda`) is declared in
   the matching `*.cuh` header, and that all five `block_*` layouts
   (`block_tbq3_0`, `block_tbq4_0`, `block_tbq3_tcq`, `block_qjl1_256`,
   `block_q4_polar`) exist in `ggml-common.h`. Catches name/signature
   drift between the harness and the v0.4.0-milady fork without needing
   the CUDA Toolkit.

C. Full nvcc compile + fixture runtime 8/8 PASS — **NEEDS-HARDWARE**.

D. Model-backed CUDA graph dispatch smoke through `llama-cli --cache-type-k`
   — **NEEDS-HARDWARE** and a real smoke GGUF model. Run `cuda_runner.sh`
   on a CUDA host and update `packages/inference/README.md` with driver
   version, GPU model, max fixture diff per kernel, graph-smoke cache aliases,
   and the exact model hash used.

## Failure modes to expect

- **`undefined reference to attn_score_qjl_cuda`** — `libggml-cuda.so` was
  built without `-DGGML_CUDA_QJL=ON`. Re-run `build:llama-dflash --target
  linux-x64-cuda` (the dflash script enables all three feature flags).
- **`block_qjl1_256` size mismatch** — `static_assert` will fire at compile.
  Indicates `ggml-common.h` in the harness include path drifted from the
  one libggml-cuda.so was built with. Make sure you point
  `ELIZA_DFLASH_LLAMA_DIR` at the same checkout that built the .so.
- **`diff=2.34e-01 FAIL` on every kernel** — driver/runtime mismatch (e.g.
  CUDA 12 toolkit + 11.x driver). Check `nvcc --version` against
  `nvidia-smi`'s "CUDA Version".

## Where this lands in the verification matrix

When 8/8 PASS reproduces on a real CUDA host, update the table in
`packages/inference/README.md` from "NEEDS-HARDWARE" to a row mirroring the
Metal / Vulkan format (`8/8 PASS on <GPU> driver <ver>; max diff <e>`).
