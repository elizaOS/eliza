# CUDA verification runbook

Status: harness rewritten as a **self-contained CUDA fixture-parity harness**
(no `libggml-cuda.so` link dependency). Full nvcc compile + fixture parity +
model-backed graph dispatch require a CUDA host. **Hardware result:
NEEDS-HARDWARE** until `cuda_runner.sh` exits zero on a real NVIDIA GPU and
the result lands in `packages/inference/README.md` + a JSON evidence file
under `hardware-results/`.

This is the sibling of `metal_verify` (Apple GPU) and `vulkan_verify`
(cross-vendor). Same contract: load the canonical fixtures from
`verify/fixtures/{turbo3,turbo4,turbo3_tcq,qjl,polar,polar_qjl}.json`
(`fused_attn_qjl_tbq.json` too, once the fused-attention-reference agent lands
it), run the corresponding kernel on the GPU, diff scalar scores against
`expected_scores` at tolerance 1e-3.

## What the harness verifies — and why it is self-contained

Like `metal_verify` / `vulkan_verify`, this harness ports **the C reference
algorithm** (`packages/inference/reference/turbo_kernels.c` +
`packages/inference/verify/qjl_polar_ref.c` — the same reference Metal and
Vulkan compare against) into CUDA `__device__` kernels that consume the
fixture byte images directly:

| Kernel       | CUDA dispatch                                              |
| ------------ | ---------------------------------------------------------- |
| `turbo3`     | `turbo34_score_kernel<32>` — 4×14B blocks/row, 3-bit centroid LUT in `__constant__`, 32-thread block, per-block dequant + double-acc dot. Mirrors `eliza_dot_q_turbo3`. |
| `turbo4`     | `turbo34_score_kernel<32>` (turbo4 path) — 4×18B blocks/row, 4-bit centroid LUT. Mirrors `eliza_dot_q_turbo4`. |
| `turbo3_tcq` | `turbo3_tcq_score_kernel` — 512-entry TCQ codebook in `__constant__` memory (the buun + Metal/Vulkan choice; generated from `reference/turbo_kernels.c` into `tbq3_tcq_codebook.inc`), 9-bit-window decode + dot. Mirrors `eliza_dequantize_turbo3_tcq_block` + `eliza_dot_q_turbo3_tcq`. |
| `qjl`        | `qjl_score_kernel` — one CUDA block per (head_q, token), 32-lane warp `__shfl_down_sync` reduction over the 256-dim sign-dot, GQA head sharing, `scl = sqrt(pi/2)/proj_dim`. Mirrors `eliza_qjl_score_qk`. |
| `polar`/`polar_qjl` | `polar_score_kernel` — per-row dequant: nibble unpack → optional xorshift32(seed=42) QJL residual → 128-element Hadamard butterfly in registers → `1/QK_POLAR` rescale → L2 rescale → dot. Mirrors `eliza_polar_dequantize_row` + `eliza_polar_mul_mv`. |

Why not link the fork's CUDA KV-cache kernels directly? The fork's
`ggml/src/ggml-cuda/{turbo-tcq,qjl,polarquant}.cuh` currently ship **header
declarations only** — no `.cu` implementations and no exported
`attn_score_qjl_cuda` / `dequantize_row_q4_polar_cuda` symbols. The fork's
`turboquant.cuh` decodes a *different* internal layout (3-bit packed, no
separate sign bytes) than the on-disk GGUF block layout the fixtures use, so
reinterpreting fixture bytes as `block_tbq3_0` would be wrong anyway. Fixture
parity therefore does not — and should not — depend on a `libggml-cuda.so`
build artifact, exactly as Metal/Vulkan parity does not depend on a built
`libggml-metal.dylib`.

When the fork's CUDA KV-cache `.cu` files land (exporting those symbols), this
harness can be extended to ALSO link `libggml-cuda.so` and cross-check the
exported production symbols against the same fixtures — but that is additive,
not a precondition for an 8/8 fixture pass.

`fused_attn_qjl_tbq.json` (QJL-K + TBQ-V fused attention) is run by
`make cuda-verify` if present; it is owned by the fused-attention-reference
agent. Until that fixture lands, the CUDA fused-attention kernel
(`ggml/src/ggml-cuda/qjl.cu`, when written) is verified against a hand-rolled
unit; see the agent handoff.

## Prereqs (CUDA host)

1. NVIDIA driver + GPU. `nvidia-smi -L` must show a device.
2. CUDA Toolkit ≥ 12.0 (provides `nvcc`). For the Blackwell mobile dGPU on
   this dev box (PCI 2c59, compute capability 12.0) the toolkit must be ≥
   12.8 to emit `sm_120` SASS. `apt install nvidia-cuda-toolkit` ships an
   older nvcc on Ubuntu 24.04 — install the official 12.8+ toolkit from
   https://developer.nvidia.com/cuda-downloads for `sm_120` device code
   (older toolkits still work via `compute_90` PTX JIT).
3. The fork checkout under `~/.cache/eliza-dflash/eliza-llama-cpp/` is needed
   only for the model-backed graph smoke step (`build:llama-dflash --target
   linux-x64-cuda`), not for `make cuda-verify`.

## End-to-end invocation

### Fixture parity only (fast — ~10s, no model)

```bash
cd packages/inference/verify
make cuda-verify          # builds cuda_verify, runs all six fixtures
```

Each fixture prints:
```
[cuda_verify] fixtures/<name>.json  kernel=<name>  outputs=8
[cuda_verify]   device: NVIDIA GeForce RTX 50xx (sm_120, NN.N GB)
  i=0 expected=... got=... diff=... PASS
  ...
[cuda_verify] PASS — 8/8 passed (tol=1e-03, max diff=N.Ne-NN)
```

### Full hardware gate (build fork + fixtures + GGUF graph dispatch)

```bash
cd packages/inference/verify
# pin Blackwell+Hopper SASS for the fork build if the platform-targets agent
# has not landed the CMAKE_CUDA_ARCHITECTURES pin yet:
ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_CUDA_ARCHITECTURES=120;90;89;86;80' \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
  ./cuda_runner.sh --report hardware-results/cuda-linux-thismachine-$(date +%Y-%m-%d).json
```

`cuda_runner.sh` is stricter than `make cuda-verify`:
1. Fails unless host is Linux, `nvcc` is present, and `nvidia-smi -L` reports a GPU.
2. Builds `linux-x64-cuda` (or `linux-aarch64-cuda`) unless `CUDA_BUILD_FORK=0`.
3. Runs `make cuda-verify` (all six fixtures including `polar_qjl.json`).
4. Requires `ELIZA_DFLASH_SMOKE_MODEL` and runs `runtime_graph_smoke.sh`,
   which drives `llama-cli --cache-type-k` for Turbo3, Turbo4, Turbo3-TCQ,
   QJL, and Polar aliases; the logs must contain CUDA/NVIDIA backend evidence.
5. With `--report <path>` writes JSON evidence (`status`, `passRecordable`,
   host OS/arch, target, GPU/driver, nvcc version, model path/hash, exit
   status). A skipped graph smoke or a failed report write means the run is
   NOT a recordable pass.

`CUDA_SKIP_GRAPH_SMOKE=1` is fixture-only bring-up; it exits non-zero so it
cannot be mistaken for a hardware pass.

### Driving a remote CUDA host from a non-CUDA dev box

```bash
CUDA_REMOTE=user@cuda-host CUDA_REMOTE_DIR=~/code/eliza \
ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf \
./cuda_runner.sh --report hardware-results/cuda-remote-evidence.json
```

GH200-class hosts use `./gh200_runner.sh` (requires arm64 Linux + Hopper/cc-9.x
GPU, pins `linux-aarch64-cuda` with `-DCMAKE_CUDA_ARCHITECTURES=90a`).

## Status on this dev box (2026-05-11)

- NVIDIA Blackwell-class mobile dGPU present (`lspci`: PCI device 2c59 rev a1).
- `nvidia-driver-580-open` packages installed (580.126.09) but the kernel
  module is **not loaded** (`lsmod | grep nvidia` → none; no `/dev/nvidia*`).
- No CUDA Toolkit / `nvcc`, no `/usr/local/cuda`.
- Therefore: `make cuda` / `make cuda-verify` correctly fail with the "CUDA
  toolchain not found" diagnostic; `cuda_runner.sh --report` exits non-zero
  and writes `status: fail` / `passRecordable: false`.
- **NEEDS-HARDWARE** for: full nvcc compile, fixture 8/8 PASS, model-backed
  CUDA graph dispatch smoke. Run `cuda_runner.sh` once the operator finishes
  loading the kernel module + installing the toolkit, then update
  `packages/inference/README.md` and add the JSON under `hardware-results/`.

## Where this lands in the verification matrix

When 8/8 PASS reproduces on a real CUDA host, update the table in
`packages/inference/README.md` from "NEEDS-HARDWARE" to a row mirroring the
Metal / Vulkan format (`8/8 PASS on <GPU> driver <ver> nvcc <ver>; max diff
<e>; graph-smoke cache aliases verified`).
