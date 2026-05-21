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
      ElizaNpuPasses.td                   passes: elizanpu-assign-scratch,
                                          elizanpu-legalize-ring
      ElizaNpuPasses.h                    pass C++ declarations
  lib/
    IR/                                   dialect runtime
      ElizaNpuDialect.cpp
      ElizaNpuOps.cpp                     op verifiers (mirror the Python
                                          oracle's runtime checks at compile
                                          time)
    Transforms/                           lowering pass implementations
      AssignScratch.cpp
      LegalizeDescriptorRing.cpp
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

An elizanpu-dialect module (descriptor SSA tokens: `acquire_ring`,
`tile_dma`, `gemm_s8`, `submit_descriptor`) is legalized through the
following passes before the HAL command-buffer emitter consumes it:

1. **`elizanpu-assign-scratch`** walks the dispatch region and checks that
   every `tile_dma` / `gemm_s8` keeps its `scratch_offset` / `byte_count`
   within the 64-byte scratchpad budget enforced by the op verifiers.
2. **`elizanpu-legalize-ring`** rejects any region that submits more than
   8 in-flight descriptors, enforcing the 8-entry descriptor ring.

Descriptor serialization is performed directly by the HAL command-buffer
encode path (`hal/elizanpu/command_buffer.c`), which produces calls into
`eliza_npu_submit_descriptors`. The `linalg.matmul -> elizanpu.gemm_s8`
front-end lowering and a standalone descriptor-table emit pass are not
implemented: the hardware C-writeback DMA path they depend on is not in
the RTL yet, so authoring those tokens directly (as the roundtrip and
descriptor-parity tests do) is the only correct path today.

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
- **Front-end tiling lowering is not implemented.** The `linalg.matmul` ->
  3x3x7 INT8 GEMM tiling front-end is blocked on the hardware C-writeback
  DMA path and is planned for P1 (Q1-Q2 2027) per the
  [2028 integrated report](../../docs/architecture-optimization/2028-sota-integrated-report.md).
  The shipped passes (`elizanpu-assign-scratch`, `elizanpu-legalize-ring`)
  enforce the 64-byte scratch budget and 8-entry ring on hand-authored
  dialect IR.
- **C runtime + Python parity test pass.** `test_descriptor_parity.py` runs
  290 parameterized cases against the Python oracle.
- **Tiny-model descriptor-stream parity (micro_model_rtl_simulator_only).**
  ``compiler/runtime/test_e1_npu_tiny_mlp_e2e.py`` drives one 3x3x3 INT8
  GEMM and a two-layer MLP (host-side bias_add + ReLU between layers)
  through ``lower_matmul_smoke`` and the stream-to-scratchpad descriptor
  path on the Python behavioral simulator. ``verify/cocotb/npu/test_iree_tiny_mlp_e2e.py``
  runs the same descriptors against the e1_npu RTL via verilator and
  verifies byte-exact match against ``golden_gemm_s8``. Descriptor
  count: 1 per GEMM. CPU fallback: 0% (activation composite runs
  host-side as ``host_broadcasts_bias`` / ``host_saturates_int8``, not
  as a CPU partition).

## Evidence gate

[`docs/evidence/compiler/iree-backend-evidence.yaml`](../../docs/evidence/compiler/iree-backend-evidence.yaml)
is fail-closed and lists the artifacts the IREE backend must produce
before any NPU compiler claim is accepted.
