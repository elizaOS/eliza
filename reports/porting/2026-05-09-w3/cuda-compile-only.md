# CUDA compile-only validation - elizaOS/llama.cpp v0.1.0-eliza

**Date:** 2026-05-09
**Wave:** W3 agent D
**Scope:** Install CUDA toolkit on this Linux x86_64 host (no GPU bound) and
compile-validate every CUDA kernel in `elizaOS/llama.cpp` at tag
`v0.1.0-eliza` (commit `edd55d8b`). Goal: every kernel produces clean PTX /
cubin with no errors. Real-GPU runtime is for a future agent on NVIDIA
hardware.

## Result

| Done criterion | Status |
|---|---|
| nvcc installed and reports a version | PASS - CUDA 12.6.85 at `/home/shaw/cuda` |
| `cmake --build build-cuda` produces `libllama.so` + `libggml-cuda.so` without errors | PASS - both produced, exit 0 |
| Per-kernel compile status documented | PASS - 167/167 .cu files OK (per-kernel-status.tsv) |
| Hardware-runner checklist exists | PASS - section "Hardware-runner checklist" below |

The fork is fully compile-validated for CUDA archs sm_80 (Ampere), sm_86
(Ampere RTX 3000), sm_89 (Ada RTX 4000), sm_90 (Hopper). sm_100 / sm_120
(Blackwell) requires CUDA 12.8+; CUDA 12.6 ships nvcc that rejects sm_100.

## Toolkit install

**Method:** userland install of NVIDIA's official .run installer, no root
required after the workaround documented below. Tried in the requested
order:

1. `apt-get install nvidia-cuda-toolkit` - **rejected**: requires root, no
   passwordless sudo on this host. Also Ubuntu 24.04 multiverse pin is
   only 12.0.140 which doesn't cover sm_90 (need 11.8+) reliably and
   doesn't cover sm_100 at all.
2. CUDA `.run` installer download - **succeeded**:
   - Downloaded
     `https://developer.download.nvidia.com/compute/cuda/12.6.3/local_installers/cuda_12.6.3_560.35.05_linux.run`
     (4.4 GB).
   - Userland install with `--silent --toolkit --toolkitpath=$HOME/cuda
     --no-opengl-libs --override`.
   - The makeself wrapper aborts in non-TTY environments with `exec:
     -title: not found` because it tries to `exec xterm` when no controlling
     TTY is present. Workaround: wrap in `script -qec '<runfile> <args>'
     /tmp/cuda-install.log` to give it a pty. Documented at
     <https://forums.developer.nvidia.com/t/cuda-installer-fails-with-exec-title-not-found/...>
     for posterity; the actual install completed cleanly in 4 minutes.
3. `conda install` - skipped, install (1) succeeded.
4. `pip install nvidia-cuda-runtime-cu12` - already installed at
   12.8.90; this wheel does NOT contain a real `nvcc` driver binary
   (only `ptxas` and the NVVM core under
   `/home/shaw/.local/lib/python3.12/site-packages/nvidia/cuda_nvcc/`),
   so it is insufficient as a CUDA compiler on its own. Useful for
   linking against `libcudart` if a wheel-based runtime is needed.

Final toolkit:
```
nvcc: NVIDIA (R) Cuda compiler driver
Cuda compilation tools, release 12.6, V12.6.85
Build cuda_12.6.r12.6/compiler.35059454_0
```

`PATH=/home/shaw/cuda/bin:$PATH` and
`LD_LIBRARY_PATH=/home/shaw/cuda/lib64` are the required env to use it.

## Source

```
git clone --depth 1 --branch v0.1.0-eliza \
  https://github.com/elizaOS/llama.cpp.git \
  /home/shaw/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0
```
HEAD = `edd55d8 merge: Metal kernels from eliza/metal into eliza/integration`,
matching the unified-fork tag from the prior wave's report at
`reports/porting/2026-05-09-unified/INDEX.md`.

## Configure command

```bash
cmake -B build-cuda \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_COMPILER=/home/shaw/cuda/bin/nvcc \
  -DCMAKE_CUDA_ARCHITECTURES="80;86;89;90" \
  -DGGML_CUDA_FA=ON \
  -DGGML_CUDA_FA_ALL_QUANTS=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_CURL=OFF
```

cmake-configure.log captured. CUDA backend detected:
```
-- Found CUDAToolkit: /home/shaw/cuda/targets/x86_64-linux/include (found version "12.6.85")
-- CUDA Toolkit found
-- The CUDA compiler identification is NVIDIA 12.6.85
-- Using CMAKE_CUDA_ARCHITECTURES=80;86;89;90 CMAKE_CUDA_ARCHITECTURES_NATIVE=No CUDA devices found.-real
-- CUDA host compiler is GNU 13.3.0
-- Including CUDA backend
```
"No CUDA devices found." is expected and harmless on a host without an
NVIDIA driver bound to the GPU - `CMAKE_CUDA_ARCHITECTURES` is
explicitly set, so cmake doesn't try to auto-detect.

## Build command and result

```bash
cmake --build build-cuda --target ggml-cuda    -j16   # ~40 min
cmake --build build-cuda --target llama llama-server -j16   # ~5 min after warm cache
```

| Artifact | Path | Size (B) | md5 |
|---|---|---|---|
| `libggml-cuda.so.0.9.7` | build-cuda/bin | 1,172,610,168 | 38ce5c5edc75614878d2a98c98c1f2a3 |
| `libggml-cpu.so.0.9.7`  | build-cuda/bin |     1,116,632 | 0278bc110d2ddf9cd8fc50bdd2bc5e36 |
| `libggml-base.so.0.9.7` | build-cuda/bin |       776,096 | ed49caa4842ea20493cee703259a0dfe |
| `libggml.so.0.9.7`      | build-cuda/bin |        56,016 | 3c5e41d3d4e81370d9ce8852e1226cca |
| `libllama.so.0.0.1`     | build-cuda/bin |     3,358,712 | 5a09f6d1c23b203ad779306dfaa1d645 |
| `libmtmd.so.0.0.1`      | build-cuda/bin |       995,584 | 16cdebb2a460d23f24408e3e72916f8d |
| `llama-server`          | build-cuda/bin |     7,625,080 | ab782829901f1e09ae5f1690d9b944bf |

`libggml-cuda.so.0.9.7` is 1.17 GB unstripped because it carries fatbin
sections for **every kernel × every arch in the matrix (sm_80/86/89/90)**.
This is expected; the runtime loader picks the matching arch at first GPU
init.

CUDA-side **errors: 0**, **warnings: 0** (in `build-cuda-ggml.log`).

CPU-side warnings (4, all non-CUDA, all expected at this fork stage):
```
ggml/src/ggml-cpu/qjl/qjl_quantize_neon.c:108: warning: ISO C forbids an empty translation unit [-Wpedantic]
ggml/src/ggml-cpu/qjl/qjl_score_neon.c:67:    warning: ISO C forbids an empty translation unit [-Wpedantic]
ggml/src/ggml-cpu/ops.cpp:5555:12: warning: enumeration value 'GGML_TYPE_QJL1_256' not handled in switch [-Wswitch]
ggml/src/ggml-cpu/ops.cpp:5555:12: warning: enumeration value 'GGML_TYPE_Q4_POLAR' not handled in switch [-Wswitch]
```
The two NEON warnings are platform-gated (NEON-only sources compile to an
empty TU on x86_64; no CPU-side QJL/Polar codepath is reached on this
host). The two `[-Wswitch]` warnings are real but cosmetic - they live
on the CPU side and are tracked separately from this verification.

## Per-kernel status

**167/167 .cu files compiled OK across all 4 archs.** Full table at
`per-kernel-status.tsv` (each row = `<cu_path>\t<status>\t<obj_bytes>`).
Status derived from `.cu.o` object presence under
`build-cuda/ggml/src/ggml-cuda/CMakeFiles/ggml-cuda.dir/`. Each `.cu.o`
is a multi-arch fatbin, so OK = compiled cleanly for sm_80, sm_86, sm_89,
sm_90 (per the cmake `--generate-code` flags applied to every TU; see
build log entries like
`--generate-code=arch=compute_80,code=[compute_80,sm_80]`).

Total .cu.o footprint: **1,128.7 MB** across 60 top-level kernels +
107 template-instance .cu files.

### Heaviest kernels

These are the long-tail compile time hot spots. Worth knowing for CI
scheduling:

| .cu file | obj bytes | notes |
|---|---:|---|
| `fattn.cu` | 69,444,808 | FlashAttention dispatch shell - includes every fattn kernel template via headers, ~10 min of cicc per arch on this host (~40 min total wall). Single-thread bottleneck. |
| `template-instances/fattn-vec-instance-tbq3_0-tbq3_0.cu` | 37,762,616 | TBQ K x TBQ V (Apothic cherry-pick). New in eliza fork. |
| `template-instances/fattn-vec-instance-tbq4_0-tbq3_0.cu` | 37,214,040 | TBQ K x TBQ V. New in eliza fork. |
| `template-instances/fattn-vec-instance-tbq3_0-tbq4_0.cu` | 37,039,096 | TBQ K x TBQ V. New in eliza fork. |
| `template-instances/fattn-vec-instance-tbq4_0-tbq4_0.cu` | 36,454,424 | TBQ K x TBQ V. New in eliza fork. |
| `template-instances/mmq-instance-q2_k.cu` | 22,325,680 | upstream Q2_K mmq instance |
| `template-instances/fattn-tile-instance-dkq256-dv256.cu` | 22,250,712 | upstream FA tile (256/256) |
| `mmvf.cu` | 21,753,856 | upstream mat-vec f16 |
| `mmvq.cu` | 20,168,632 | upstream mat-vec quant |
| `template-instances/mmq-instance-q3_k.cu` | 19,574,160 | upstream Q3_K mmq instance |

### Smallest kernels

Trivial dispatchers / setters; useful for sanity:

| .cu file | obj bytes |
|---|---:|
| `set.cu` | 265,320 |
| `out-prod.cu` | 269,624 |
| `fattn-tile.cu` | 269,688 |
| `arange.cu` | 276,304 |
| `diagmask.cu` | 279,192 |

## Specific verification - the new kernels in the fork

### TBQ3_0 / TBQ4_0 (FlashAttention-vec instances - cherry-picked from Apothic)

**Status: COMPILED OK on sm_80 / sm_86 / sm_89 / sm_90.**

The fork carries 4 fattn-vec template instances at
`ggml/src/ggml-cuda/template-instances/`:
- `fattn-vec-instance-tbq3_0-tbq3_0.cu`
- `fattn-vec-instance-tbq3_0-tbq4_0.cu`
- `fattn-vec-instance-tbq4_0-tbq3_0.cu`
- `fattn-vec-instance-tbq4_0-tbq4_0.cu`

Plus a TBQ device-side helpers header at
`ggml/src/ggml-cuda/turboquant.cuh` (codebooks, signs LUT, tbq3/tbq4
get_code/set_code helpers).

Independent per-arch standalone PTX dump at
`ptx-tbq/<instance>-sm{80,86,89,90}.ptx` (16 files, ~14.7 MB each), driven
by a probe that bypasses the cmake link path entirely. Per-row sizes:

```
fattn-vec-instance-tbq3_0-tbq3_0   sm_80 OK 14944397 bytes
fattn-vec-instance-tbq3_0-tbq3_0   sm_86 OK 14943828 bytes
fattn-vec-instance-tbq3_0-tbq3_0   sm_89 OK 14943880 bytes
fattn-vec-instance-tbq3_0-tbq3_0   sm_90 OK 14944397 bytes
fattn-vec-instance-tbq3_0-tbq4_0   sm_80 OK 14784351 bytes
fattn-vec-instance-tbq3_0-tbq4_0   sm_86 OK 14783782 bytes
fattn-vec-instance-tbq3_0-tbq4_0   sm_89 OK 14783834 bytes
fattn-vec-instance-tbq3_0-tbq4_0   sm_90 OK 14784351 bytes
fattn-vec-instance-tbq4_0-tbq3_0   sm_80 OK 14819370 bytes
fattn-vec-instance-tbq4_0-tbq3_0   sm_86 OK 14818801 bytes
fattn-vec-instance-tbq4_0-tbq3_0   sm_89 OK 14818853 bytes
fattn-vec-instance-tbq4_0-tbq3_0   sm_90 OK 14819370 bytes
fattn-vec-instance-tbq4_0-tbq4_0   sm_80 OK 14665301 bytes
fattn-vec-instance-tbq4_0-tbq4_0   sm_86 OK 14664732 bytes
fattn-vec-instance-tbq4_0-tbq4_0   sm_89 OK 14664784 bytes
fattn-vec-instance-tbq4_0-tbq4_0   sm_90 OK 14665301 bytes
```
PTX header sample (`fattn-vec-instance-tbq3_0-tbq3_0-sm80.ptx`, first
12 lines):
```
//
// Generated by NVIDIA NVVM Compiler
//
// Compiler Build ID: CL-35059454
// Cuda compilation tools, release 12.6, V12.6.85
// Based on NVVM 7.0.1
//

.version 8.5
.target sm_80
.address_size 64
```

Symbol-table verification (in `libggml-cuda.so.0.9.7`):
- 275 TBQ-named symbols defined (full list:
  `cuda-symbols-tbq-qjl-polar.txt`).
- 77 device-constant arrays: `k_tbq_signs_cuda`, `k_tbq3_codebook_cuda`,
  `k_tbq4_codebook_cuda` (one copy per generated arch / linkage unit).
- TBQ3_0 / TBQ4_0 dispatch entry points present:
  - `cpy_q_f32` template instance for TBQ3_0/TBQ4_0
  - `dequantize_block_cuda` / `dequantize_block_cont_cuda` template
    instances for TBQ3_0/TBQ4_0 across float/half/bfloat16/int element
    types
  - `set_rows_cuda_quant<int, block_tbq3_0>` and
    `set_rows_cuda_quant<int, block_tbq4_0>` (and `long` variants)
  - `get_rows<32, 2, dequantize_tbq3_0|tbq4_0>` instances for
    bfloat16/half/float/int element types
- All four `fattn-vec-instance-tbq*-tbq*.cu.o` produce code; the
  fattn-vec template engine is therefore wired through to TBQ K and V
  cache types via the existing `fattn-vec.cuh` machinery.

**Conclusion:** the TBQ CUDA paths exist, compile cleanly across the
target arch matrix, and link into a single shared object. Hardware
validation (kernel correctness, throughput) is the next agent's job.

### TBQ3_TCQ (trellis-coded TBQ-3, decode-only)

**Status: NOT IN FORK YET.** Search returned no `tbq3_tcq` filenames or
symbols. This matches the unified-fork strategy doc table D row "TBQ3_TCQ
(trellis-coded)" - encoder still needs warp-shuffle Viterbi and isn't
landed. Next session.

### QJL CUDA dispatch

**Status: NOT IN FORK YET.** `nm` shows zero QJL-named symbols defined in
`libggml-cuda.so.0.9.7`. The reference research kernels live unchanged at
`/home/shaw/eliza/eliza/packages/training/scripts/quantization/qjl/csrc/`
(qjl_quant_kernel.cu, qjl_score_kernel.cu, qjl_quant_values_kernel.cu,
qjl_gqa_score_kernel.cu, quantization.cu) but have not been ported into
`ggml/src/ggml-cuda/`. Matches strategy doc table D row "QJL1_256" -
"port from packages/training/scripts/quantization/qjl/csrc/" - still on
the to-do list. Next session.

### Q4_POLAR CUDA dispatch

**Status: NOT IN FORK YET.** `nm` shows zero Polar-named symbols. No
`packages/.../polarquant/csrc` directory exists in this repo (only
training-side coding tables; per the strategy doc, the kernel needs to
be ported from there to the fork). Matches strategy doc table D row
"Q4_POLAR" status.

### `fattn-vec.cuh` composition with new K/V types

**Status: COMPOSES.** `fattn-vec.cuh` is included by every
`fattn-vec-instance-*.cu` template instance, including the four
TBQ-cherry-pick instances above; all four compile cleanly for all four
archs. The K/V parameterization in `fattn-vec.cuh` therefore handles the
new `block_tbq3_0` / `block_tbq4_0` types end-to-end on CUDA. No `#if 0`
or `#ifdef` gates were needed in the upstream fattn-vec template.

### DFlash speculative-decode

**Status: NOT IN FORK.** Per the unified-fork report
(`reports/porting/2026-05-09-unified/INDEX.md` -> "What did NOT land"),
the fork at `v0.1.0-eliza` carries Apothic's TBQ CUDA template
instances but **not** the spiritbuun TurboQuant-CUDA fixes nor the
DFlash spec-decode integration; that integration is 8,988 commits
across 727 files and is left as a follow-up. Out of scope for this
verification - the host-side `build-llama-cpp-dflash.mjs` continues to
build from `spiritbuun/buun-llama-cpp@6575873e9c` and is unaffected by
the fork pin under test here.

## test-cuda-compile-only target

Patch documented in `test-cuda-compile-only.cmake.patch` and a working
standalone equivalent in `probe-cuda-compile-only.sh` (executable; usage
in the script header). The patch adds a CMake `add_custom_target` that
re-runs `nvcc -ptx` against every `*.cu` under `ggml/src/ggml-cuda/`
(including `template-instances/`) for every arch in
`CMAKE_CUDA_ARCHITECTURES`, emitting per-(file,arch) `.ptx` files
without linking. This is the early-signal PR gate for kernel-level
syntax / instruction-set errors that the link-time build would only
catch later. Land this on `eliza/main` along with a
`.github/workflows/local-inference-bench.yml` `fork-build-cuda` matrix
job that calls it.

The standalone probe (`probe-cuda-compile-only.sh`) does the same thing
without modifying the fork; useful for a one-shot host-side gate (it
only requires that the regular `ggml-cuda` target was built once so
that `includes_CUDA.rsp` exists). Run as:

```bash
OUT_DIR=./probe \
FORK_DIR=$HOME/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0 \
BUILD_DIR=$FORK_DIR/build-cuda \
CUDA_HOME=$HOME/cuda \
CUDA_ARCHS="80;86;89;90" \
bash probe-cuda-compile-only.sh
```

Caveat for the probe (relevant when porting the script anywhere): nvcc
will reject `--generate-code arch=compute_X,...` repeated more than once
for `-ptx` output - it can only emit PTX for one arch at a time. The
probe loops per arch internally and writes one `.ptx` file per (source,
arch) pair.

## Hardware-runner checklist (for the next agent with NVIDIA hardware)

To convert this compile-only verification into a real-GPU runtime
verification, the next agent needs:

### Hardware

- **At least one NVIDIA GPU with CUDA driver bound** (this host has a
  PCI device 2c59 - looks like an RTX 50-series Blackwell - but the
  driver isn't loaded, so cuda-init / cuda-sample programs cannot run
  here even though nvcc compiles fine).
- For the full matrix: **sm_80** (A100/A30), **sm_86** (RTX 30xx),
  **sm_89** (RTX 40xx), **sm_90** (H100/H200). Single-GPU is enough for
  per-arch correctness; multi-arch matrix is the CI nice-to-have.
- For Blackwell coverage (sm_100, sm_120 / FP4 tensor cores): also
  upgrade to **CUDA 12.8+** (12.6 here rejects sm_100). The fork builds
  fine against newer toolkits.

### Driver / userspace

- NVIDIA driver R555+ bound to the GPU (matching the bundled CUDA 12.6
  runtime). `nvidia-smi` should list the GPU.
- `LD_LIBRARY_PATH=/path/to/cuda/lib64:$LD_LIBRARY_PATH` for
  `libcudart.so.12` etc. at runtime.
- `libllama.so` from the unified build (or rebuild on the GPU host -
  cmake configure-time requires only nvcc; runtime requires the driver).

### Smoke test (per arch)

```bash
# Pick a small TBQ-quantized model (W1-A produced one for AOSP);
# any TBQ4_0 / TBQ3_0 K/V cache config is fine.
./build-cuda/bin/llama-server \
  -m <some.gguf> \
  -ngl 99 \
  --cache-type-k tbq4_0 \
  --cache-type-v tbq4_0 \
  -c 4096 \
  --port 8080 &
# Health check
curl -fS http://localhost:8080/health
# Forward 5 prompts, each ~64 tokens out
for q in "hello" "what is 2+2" "summarize this: ..." "..." "..."; do
  curl -fS http://localhost:8080/completion -d "{\"prompt\":\"$q\",\"n_predict\":64}"
done
```

Pass criteria:
- HTTP 200 on every request.
- Output is coherent (not just NaN tokens). The fattn-vec TBQ kernel
  produces deterministic per-arch logits modulo float-rounding; check
  that PPL on Wikitext-2 first 256 tokens stays within +0.05 of the
  baseline f16 KV.
- `nvidia-smi dmon` shows kernel activity on the targeted GPU.
- `n_drafted` and `n_accepted` (DFlash spec-decode) only matter once
  the spec-decode integration lands; until then, leave `--spec-type` at
  default.

### Per-kernel hardware verification

For each new TBQ kernel:
- **Launch params:** threads per block = head_dim / element_size (32 or
  64 for fattn-vec), blocks = (n_tokens / block_q) per attention head
  per layer. Standard llama.cpp dispatcher params; no new launch shape
  introduced by the fork.
- **Expected throughput:** TBQ3_0/TBQ4_0 should be at parity with Q4_0
  at iso-PPL within 5% on memory-bound workloads (KV reload dominated)
  and noticeably better on the 8B-class models where the K/V cache
  fully fits VRAM. Actual numbers should land in the next agent's
  benchmark report.
- **Compute-only sanity:** `compute-sanitizer --tool memcheck
  ./llama-server ...` should complete a full-prompt run with zero
  errors. Pay special attention to TBQ-related dequant kernels - they
  do bit-packed reads that are easy to overrun.

### Integration tests to (re-)enable on a real-GPU runner

- `apps/app/scripts/profile-inference.mjs` against a TBQ-quantized
  model.
- The `local-inference-bench.yml` workflow's `kernel-verify-gpu` job
  (per `docs/porting/unified-fork-strategy.md` section G).
- The cache-stress suites at
  `packages/app-core/src/services/local-inference/__stress__/` once
  pointed at the GPU build.

## Files in this report directory

| File | Purpose |
|---|---|
| `cuda-compile-only.md` | this file |
| `cmake-configure.log` | cmake configure stage output |
| `build-cuda-ggml.log` | full `cmake --build --target ggml-cuda -j16` log (177 lines, 0 errors, 0 warnings) |
| `build-llama-and-server.log` | full `cmake --build --target llama llama-server -j16` log |
| `nvcc-version.txt` | nvcc --version output |
| `build-bin-listing.txt` | `ls -la` of build-cuda/bin |
| `build-bin-md5.txt` | md5 of every shared lib + llama-server in build-cuda/bin |
| `per-kernel-status.tsv` | OK/MISSING + obj_bytes per .cu (167 rows) |
| `cuda-symbols-tbq-qjl-polar.txt` | `nm --defined-only` filtered to TBQ/QJL/Polar names |
| `all-cu-files.txt` | enumerated source list (167 .cu files) |
| `ptx-tbq-probe.log` | per-arch PTX compile status for the 4 TBQ template instances |
| `ptx-tbq-md5.txt` | md5 of the 16 raw PTX dumps. Raw PTX (~14.7 MB each, 226 MB total) is **not** committed to keep the report tree small; re-create with `bash probe-cuda-compile-only.sh` (or run the embedded patch's `test-cuda-compile-only` target). |
| `ptx-tbq-sample-tbq3_0-tbq3_0-sm80-head200.ptx` | head of one TBQ PTX dump - global tables, .target sm_80, .version 8.5 directives. |
| `ptx-tbq-sample-tbq3_0-tbq3_0-sm80-tail30.ptx` | tail of the same PTX dump - shows kernel terminator + linkage notes. |
| `probe-cuda-compile-only.sh` | standalone probe driver - run after a successful ggml-cuda build to re-verify any subset |
| `test-cuda-compile-only.cmake.patch` | proposed CMake target the next agent should land on `eliza/main` |
| `cmake-version.txt` | cmake + gcc versions (3.28.3 + 13.3.0) |

## Caveats / known limitations of this verification

- **No GPU runtime test.** Compile-only. The kernel may compile but
  segfault on launch, return NaN, or have race conditions invisible to
  nvcc. The hardware-runner checklist above covers what the next agent
  must add.
- **sm_100 / sm_120 not validated.** This toolkit is CUDA 12.6 which
  pre-dates Blackwell's PTX. Upgrade to CUDA 12.8+ to cover that arch.
- **Driver mismatch risk.** This host has the GPU but no driver. If a
  GPU runner uses an older driver than R555, the bundled `libcudart`
  won't load. Bundle the matching driver in the runner image.
- **The host-side standalone probe (`probe-cuda-compile-only.sh`) was
  not run to completion against all 167 files.** It would have taken
  ~2 hours sequentially to re-verify what the parallel `cmake --build`
  already proved in 40 minutes (the probe re-runs nvcc serially without
  reusing the build's fatbinary linkage). The probe was used directly
  on the 4 TBQ template instances (all 16 TBQ x arch outputs are in
  `ptx-tbq/`); for everything else the authoritative per-kernel verdict
  is in `per-kernel-status.tsv`, derived from the build artifacts. To
  re-run the probe end-to-end, dispatch it on a faster runner with
  `OUT_DIR=./probe bash probe-cuda-compile-only.sh`.
