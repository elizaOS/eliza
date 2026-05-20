//===-- ElizaNpuPasses.td - elizanpu pass declarations ----*- tablegen -*-===//
//
// Passes that lower upstream MLIR (StableHLO / linalg) into the `elizanpu`
// dialect plus CPU fallback. These passes are consumed by the IREE backend
// at `iree-compile --iree-hal-target-backends=elizanpu`.
//
//===----------------------------------------------------------------------===//

#ifndef ELIZANPU_PASSES
#define ELIZANPU_PASSES

include "mlir/Pass/PassBase.td"

def ConvertLinalgToElizaNpuPass : Pass<"convert-linalg-to-elizanpu", "::mlir::ModuleOp"> {
  let summary = "Lower linalg.matmul / conv / softmax / layer-norm into elizanpu descriptors";
  let description = [{
    Partitions an MLIR module between elizanpu-resident ops and CPU
    fallback. Tiling rules:

      * `linalg.matmul` -> tiled into M<=3, N<=3, K<=7 blocks, each emitted
        as `elizanpu.gemm_s8` after explicit per-tensor scaling.
      * `linalg.conv_2d_nhwc_hwio` -> im2col + tiled matmul.
      * `linalg.softmax`, `linalg.fill`, layer-norm, gelu, swiglu -> CPU
        fallback. The hardware does not implement them today.
      * Attention QK / AV / softmax -> tiled matmuls plus CPU softmax. The
        compiler emits explicit `iree_input.tensor.transfer` ops at the
        boundary so the runtime can route them through the host.

    Any op outside this list is left untouched for downstream CPU lowering.
  }];
  let constructor = "::mlir::elizanpu::createConvertLinalgToElizaNpuPass()";
  let options = [
    Option<"defaultPrecision", "precision", "std::string", "\"int8\"",
           "Default precision for matmul lowering (int8, int4_packed, "
           "int4_sparse_2_4, int2, fp8_e4m3)">,
    Option<"allowFallback", "allow-fallback", "bool", "true",
           "Permit CPU fallback for unsupported ops; if false, fail closed">
  ];
}

def AssignScratchPass : Pass<"elizanpu-assign-scratch", "::mlir::func::FuncOp"> {
  let summary = "Linearly allocate the 64-byte scratchpad across descriptor lifetimes";
  let description = [{
    Walks the dispatch region and assigns concrete `scratch_offset` /
    `byte_count` values to every `elizanpu.tile_dma` and `elizanpu.gemm_s8`
    op, preserving liveness ordering. Fails if any single dispatch region
    requires more than 64 bytes of live storage.
  }];
  let constructor = "::mlir::elizanpu::createAssignScratchPass()";
}

def LegalizeDescriptorRingPass : Pass<"elizanpu-legalize-ring", "::mlir::func::FuncOp"> {
  let summary = "Enforce DESC_RING_ENTRIES=8 single-producer ordering";
  let description = [{
    Splits dispatch regions that would exceed the 8-entry descriptor ring
    and inserts `elizanpu.acquire_ring` at every region entry. Errors if a
    single basic block submits more than 8 in-flight descriptors.
  }];
  let constructor = "::mlir::elizanpu::createLegalizeDescriptorRingPass()";
}

def EmitDescriptorTablePass : Pass<"elizanpu-emit-descriptor-table",
                                   "::mlir::ModuleOp"> {
  let summary = "Serialize submitted descriptors into a flatbuffer table for the runtime";
  let description = [{
    Final lowering step. Replaces every `elizanpu.submit_descriptor` with a
    runtime call into the C ABI declared in
    `compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h`. The serialized
    table is consumed by IREE's HAL command-buffer emitter.
  }];
  let constructor = "::mlir::elizanpu::createEmitDescriptorTablePass()";
}

#endif // ELIZANPU_PASSES
