# `elizanpu` IREE backend specification

## Purpose

`elizanpu` is the MLIR dialect that lowers StableHLO / linalg / ExecuTorch
graphs into the e1 NPU descriptor-ring runtime defined in
[`docs/spec-db/e1-npu-runtime-contract.json`](../spec-db/e1-npu-runtime-contract.json).

It replaces the Python "lowering smoke" at
[`compiler/runtime/e1_npu_lowering.py`](../../compiler/runtime/e1_npu_lowering.py).
That file is now demoted to test oracle status: the parity test at
[`compiler/iree-eliza-npu/tests/test_descriptor_parity.py`](../../compiler/iree-eliza-npu/tests/test_descriptor_parity.py)
re-encodes 290 descriptors through both the Python oracle and the C runtime
to guarantee identical output. Production codegen ships through this
dialect, not through Python.

## Dialect surface (TableGen source of truth)

| Op | Hardware basis | Compile-time check | Lower from |
| --- | --- | --- | --- |
| `elizanpu.acquire_ring` | `DESC_BASE`/`DESC_STATUS` programming | none | `iree_hal.command_buffer.begin` |
| `elizanpu.tile_dma` | descriptor word0 `stream_to_scratch[8]` + word1 source addr | scratch_offset/byte_count 32-bit aligned, sum `<= 64` | linalg input tensor transfer |
| `elizanpu.submit_descriptor` | `submit_descriptors` MMIO sequence | `writeback_request == false`, opcode `[0, 15]`, scratch bounds | end of dispatch region |
| `elizanpu.gemm_s8` | `GEMM_S8 = 8` + `GEMM_CFG`/`GEMM_BASE`/`GEMM_STRIDE` | M<=3, N<=3, K<=7, scratch fit | `linalg.matmul` (int8) after tiling |
| `elizanpu.dot4_s8` | `DOT4_S8 = 4` | pure | packed INT8 dot in attention tiles |
| `elizanpu.dot8_s4` | `DOT8_S4 = 7` | pure | packed INT4 dot |
| `elizanpu.dot16_s2` | `DOT16_S2` (scalar contract only) | pure | INT2 BitNet (BLOCKED on RTL tensor path) |
| `elizanpu.dot4_fp8_e4m3` | `DOT4_FP8_E4M3` (scalar contract only) | pure | FP8 E4M3 LLM (BLOCKED on RTL tensor path) |
| `elizanpu.sparse_sdot4_s4_2_4` | `SDOT4_S4_2_4` | pure | 2:4 structured sparse INT4 |
| `elizanpu.vrelu` | `RELU4_S8` / `VRELU_S8` | pure | elementwise ReLU in INT8 epilogue |

## Pass pipeline

```
iree-compile \
  --iree-hal-target-backends=elizanpu \
  --iree-input-type=stablehlo \
  --iree-elizanpu-default-precision=int8 \
  --iree-llvmcpu-enable-inner-tiled \
  model.mlir -o model.vmfb
```

`--iree-llvmcpu-enable-inner-tiled` is required for the LLVMCPU fallback
dispatches that elizanpu emits for unsupported ops to pick up the inner-tiled
vector-contract path. The flag was merged upstream via
[iree-org/iree#24219](https://github.com/iree-org/iree/pull/24219) and is
recorded as the default in
[`scripts/build_iree_eliza_npu.sh`](../../scripts/build_iree_eliza_npu.sh)
under `IREE_COMPILE_DEFAULT_FLAGS` (written out to
`build/reports/compiler/iree-compile-default-flags.txt`).

Internally:

1. `convert-linalg-to-elizanpu` — decompose matmul / conv / attention into
   tile-shaped `gemm_s8` + tile DMA, plus CPU fallback for unsupported ops
   (softmax, layer-norm, FP16 matmul).
2. `elizanpu-assign-scratch` — concrete `scratch_offset` / `byte_count`
   attribute assignment per dispatch region. Fails closed when 64-byte
   budget is exceeded.
3. `elizanpu-legalize-ring` — 8-entry descriptor-ring fragmentation.
   Fails closed if any region submits more than 8 in-flight descriptors.
4. `elizanpu-emit-descriptor-table` — final flatbuffer + linker symbol
   pointing at `eliza_npu_runtime_submit_descriptor_table`.

## Build environments

### Standalone dialect-only build

For dialect-level FileCheck testing (no IREE in tree):

```sh
make iree-build STAGE=standalone
# equivalently:
cmake -G Ninja -S compiler/iree-eliza-npu -B build/elizanpu-standalone \
  -DELIZANPU_BUILD_STANDALONE=ON \
  -DMLIR_DIR=$LLVM_STAGE2/lib/cmake/mlir \
  -DLLVM_DIR=$LLVM_STAGE2/lib/cmake/llvm
ninja -C build/elizanpu-standalone elizanpu-opt
```

### In-tree IREE integration

`scripts/build_iree_eliza_npu.sh`:

1. Clones the IREE SHA pinned in
   [`compiler/iree-eliza-npu/iree-pin.json`](../../compiler/iree-eliza-npu/iree-pin.json)
   under `external/iree/`.
2. Symlinks `compiler/iree-eliza-npu` into the IREE tree at
   `compiler/plugins/target/elizanpu`.
3. Builds the IREE compiler with `-DIREE_TARGET_BACKEND_ELIZANPU=ON`,
   pointing MLIR/LLVM at `build/llvm-stage2`.

## C ABI

The IREE-emitted code calls into the C ABI declared in
[`compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h`](../../compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h).
The ABI mirrors the Python oracle's `submit_descriptors` and
`pack_stream_descriptor_word0` byte-for-byte; the parity test ensures any
divergence is caught at PR review time.

## Reproducibility pinning

- LLVM SHA: `compiler/llvm-build/llvm-pin.json`.
- IREE SHA: `compiler/iree-eliza-npu/iree-pin.json` (last audited 2026-05-20).
- Container base: `packages/chip/Dockerfile` `UBUNTU_DIGEST`.
- Python parity: in repo CI, runs without MLIR built.

### Upstream patches

Patches in `compiler/iree-eliza-npu/patches/` are applied after the pinned
SHA is checked out, before the cmake configure step. The build script does
not yet apply them automatically; record any patch added here under
`applied_patches` (or `pending_patches` if not yet apply-verified) in
`iree-pin.json` so the audit trail is durable.

| Patch | Upstream PR | State | Apply state on pinned tree | Why we want it |
| --- | --- | --- | --- | --- |
| `001-riscv-rvv-int8-vcontract.patch` | [iree-org/iree#23734](https://github.com/iree-org/iree/pull/23734) | OPEN (approved, awaiting final RISC-V sign-off; CI green 2026-04-20) | **Applied** to pinned tree `d9a3dd15` on 2026-05-20 (`git apply --check` rc=0; `git apply` rc=0; +42 insertions across 7 modified files plus new 146-line ukernel `mmt4d_riscv_64_v_i8.c`). Patch sha256: `f12083c1…51ec`. | Adds RVV widening i8*i8->i32 mmt4d ukernel (`iree_uk_mmt4d_tile_s8s8s32_*_riscv_64_v`) and `enumerateMatmulTileRiscv64` widening-i8 entries. Direct match for `elizanpu.gemm_s8` shape constraints (M<=3, N<=3, K<=7). Hardware-validated on SpacemiT X60. 285 lines, 8 files. |

Apply patches manually before building (the script will be taught to
auto-apply once the patch lands upstream or is rebased):

```sh
git -C external/iree apply \
  $REPO/compiler/iree-eliza-npu/patches/001-riscv-rvv-int8-vcontract.patch
```

## Status

- Dialect TableGen and C++ skeleton: committed.
- Pass implementations: skeletons; full lowering planned for P1 (Q1-Q2 2027).
- `patches/001-riscv-rvv-int8-vcontract.patch`: **apply-verified** against
  pinned IREE `d9a3dd15` on 2026-05-20. New ukernel file and tile-size
  table entries land at the expected paths. Binary build of the patched
  tree still **BLOCKED** on `build/llvm-stage2` (LLVM stage2 cmake exports
  absent). Run `scripts/build_llvm_riscv.sh` in the canonical Linux
  container first, then re-run `scripts/build_iree_eliza_npu.sh` to
  produce `iree-compile` / `libIREECompilerElizaNpu.a` and capture the
  `nm` witness for `iree_uk_mmt4d_tile_s8s8s32_*_riscv_64_v` symbols.
- Standalone or in-tree IREE build: **BLOCKED** until the LLVM-trunk pin
  SHA is built into `build/llvm-stage2` and the build script is executed
  inside the canonical Linux container.
- Python parity test: passes 290 parameterized cases in repo CI today.

## Evidence gate

[`docs/evidence/compiler/iree-backend-evidence.yaml`](../evidence/compiler/iree-backend-evidence.yaml)
fails closed unless every artifact in the gate file is present.
