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

#endif // ELIZANPU_PASSES
