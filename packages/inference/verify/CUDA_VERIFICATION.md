# CUDA verification runbook

Status: harness compiles (preprocessor-clean on M4 Max) — full nvcc compile
and 8/8 PASS verification require a CUDA host. **Hardware result:
NEEDS-HARDWARE** until the runbook below is executed against a real NVIDIA
GPU and the result lands in `packages/inference/README.md`.

This is the sibling of `metal_verify` (Apple GPU) and `vulkan_verify`
(cross-vendor). It loads the canonical fixtures from
`verify/fixtures/{turbo3,turbo4,turbo3_tcq,qjl,polar}.json`, dispatches the
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

# (b) Run all five fixtures.
make cuda-verify

# Or the wrapper:
./cuda_runner.sh
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
./cuda_runner.sh
```

The runner ssh-runs `make cuda-verify` on the remote and streams output
back. The remote must already have the eliza checkout at
`$CUDA_REMOTE_DIR` and the prereqs above.

## Verification on this M4 Max (what was actually checked)

A. `nvcc --version` — **absent** on Darwin. The Makefile gate emits the
   expected diagnostic ("CUDA toolchain not found — install via
   `apt install nvidia-cuda-toolkit` (Linux) or download the CUDA Toolkit
   (macOS not supported).") and exits non-zero on `make cuda` /
   `make cuda-verify`. Source-level correct, runtime gated.

B. `make cuda-preprocess-check` — **PASS** when the milady-llama-cpp
   checkout is present at `~/.cache/eliza-dflash/milady-llama-cpp`. The
   target runs `c++ -E` over `cuda_verify.cu` with `-D__CUDACC__` and the
   in-fork header search paths. This catches missing headers, mistyped
   API names, and ABI drift between the harness and `*.cuh` without
   needing nvcc.

C. Full nvcc compile + runtime 8/8 PASS — **NEEDS-HARDWARE**. Run on a
   CUDA host and update `packages/inference/README.md`'s verification
   matrix CUDA column with the result + driver version + GPU model + max
   diff per kernel.

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
