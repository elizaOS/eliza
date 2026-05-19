# elizanpu IREE backend

`elizanpu` is the MLIR dialect and IREE backend that lowers StableHLO /
linalg / ExecuTorch graphs into the e1 NPU descriptor-ring runtime
defined in [`docs/spec-db/e1-npu-runtime-contract.json`](../../docs/spec-db/e1-npu-runtime-contract.json).

The Python oracle at [`compiler/runtime/e1_npu_lowering.py`](../runtime/e1_npu_lowering.py)
is the **test oracle** for tiling shape and descriptor encoding. It is NOT
the production codegen path. Real codegen lives here.

## Layout

```
compiler/iree-eliza-npu/
  CMakeLists.txt                          standalone + IREE-in-tree build
  include/elizanpu/
    IR/
      ElizaNpuDialect.td                  dialect definition (TableGen)
      ElizaNpuDialect.h                   public C++ headers
      ElizaNpuOps.td                      operations: submit_descriptor,
                                          tile_dma, gemm_s8, dot4_s8,
                                          dot8_s4, dot16_s2,
                                          dot4_fp8_e4m3,
                                          sparse_sdot4_s4_2_4, vrelu
      ElizaNpuPasses.td                   passes: convert-linalg-to-elizanpu,
                                          elizanpu-assign-scratch,
                                          elizanpu-legalize-ring,
                                          elizanpu-emit-descriptor-table
      ElizaNpuPasses.h                    pass C++ declarations
  lib/
    IR/                                   dialect runtime
      ElizaNpuDialect.cpp
      ElizaNpuOps.cpp                     op verifiers (mirror the Python
                                          oracle's runtime checks at compile
                                          time)
    Transforms/                           lowering pass implementations
      ConvertLinalgToElizaNpu.cpp
      AssignScratch.cpp
      LegalizeDescriptorRing.cpp
      EmitDescriptorTable.cpp
  runtime/
    eliza_npu_runtime.h                   C ABI for the runtime (mirrors the
                                          Python oracle's `submit_descriptors`
                                          contract; this is the linker boundary
                                          between IREE-emitted code and the
                                          kernel NPU driver)
    eliza_npu_runtime.c                   reference C implementation
  tests/
    roundtrip.mlir                        FileCheck IR roundtrip
    legalize_ring.mlir                    8-entry ring overflow rejection
    test_descriptor_parity.py             pytest parity vs Python oracle
                                          (runs in CI without MLIR built)
```

## How to build

### Standalone dialect smoke

Requires MLIR + LLVM installed (e.g. inside the canonical Linux container
built from `packages/chip/Dockerfile`, with the LLVM-trunk pin from
[`llvm-trunk-pin.md`](../../docs/toolchain/llvm-trunk-pin.md)):

```sh
cmake -G Ninja -S compiler/iree-eliza-npu -B build/elizanpu-standalone \
  -DELIZANPU_BUILD_STANDALONE=ON \
  -DMLIR_DIR=$LLVM_STAGE2/lib/cmake/mlir \
  -DLLVM_DIR=$LLVM_STAGE2/lib/cmake/llvm
ninja -C build/elizanpu-standalone elizanpu-opt
```

### In-tree IREE integration

`scripts/build_iree_eliza_npu.sh` clones a pinned IREE SHA, registers this
directory as an external dialect under
`compiler/plugins/target/elizanpu/`, and builds the IREE compiler + runtime
with the elizanpu backend selectable via
`iree-compile --iree-hal-target-backends=elizanpu`.

The pin file is [`compiler/iree-eliza-npu/iree-pin.json`](iree-pin.json).

## Lowering contract

A StableHLO / linalg module enters the backend at module scope and is
lowered through the following pipeline:

1. **`convert-linalg-to-elizanpu`** decomposes `linalg.matmul`,
   `linalg.conv_2d_nhwc_hwio`, attention QK/AV/softmax, layer-norm,
   gelu/swiglu, RMSNorm, RoPE. Hardware-supported tiles become
   `elizanpu.gemm_s8` (and packed-dot variants). Hardware-unsupported ops
   (softmax, layer-norm, full FP16 matmul) are left for CPU fallback via
   IREE's host emitter.
2. **`elizanpu-assign-scratch`** linearly allocates the 64-byte scratchpad
   across `tile_dma` / `gemm_s8` lifetimes per dispatch region. Fails if a
   region requires more than 64 bytes live.
3. **`elizanpu-legalize-ring`** splits regions that would exceed the
   8-entry descriptor ring and inserts `acquire_ring` ops. Fails if any
   basic block submits more than 8 in-flight descriptors.
4. **`elizanpu-emit-descriptor-table`** serializes submissions into a
   table consumed by IREE's HAL command buffer emitter. The emitter
   produces direct calls into `eliza_npu_submit_descriptors`.

## Hardware-bound verifiers

Every op verifier in `ElizaNpuOps.cpp` mirrors a runtime check in
`compiler/runtime/e1_npu_runtime.py`:

| Op | Compile-time check | Mirrored runtime check |
| --- | --- | --- |
| `tile_dma` | `scratch_offset` 32-bit aligned, `byte_count` in `(0, 64]` 32-bit aligned, sum `<= 64` | `write_scratch` bounds + `pack_stream_descriptor_word0` validation |
| `submit_descriptor` | `writeback_request == false`, `opcode` in `[0, 15]`, same scratch bounds | `submit_descriptors` + RTL `DESC_STATUS_WRITEBACK_UNSUPPORTED` rejection |
| `gemm_s8` | `M<=3`, `N<=3`, `K<=7`, scratch tile fits 64 B, `c_base` word aligned | `gemm_s8` Python bounds + RTL `PERF_ERRORS` |

This guarantees compile-time fail-closed parity with the runtime fail-closed
contract.

## Status

- **Dialect TableGen + C++ skeleton committed.** Build requires LLVM/MLIR
  inside the canonical Linux container; standalone host builds are blocked
  on the LLVM SHA pin.
- **Lowering passes are skeletons.** Real tiling for `linalg.matmul` ->
  3x3x7 INT8 GEMM tiles is planned for P1 (Q1-Q2 2027) per the
  [2028 integrated report](../../docs/architecture-optimization/2028-sota-integrated-report.md).
- **C runtime + Python parity test pass.** `test_descriptor_parity.py` runs
  290 parameterized cases against the Python oracle.

## Evidence gate

[`docs/evidence/compiler/iree-backend-evidence.yaml`](../../docs/evidence/compiler/iree-backend-evidence.yaml)
is fail-closed and lists the artifacts the IREE backend must produce
before any NPU compiler claim is accepted.
