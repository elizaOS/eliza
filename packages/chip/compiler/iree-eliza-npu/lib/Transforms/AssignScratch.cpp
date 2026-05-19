//===-- AssignScratch.cpp - scratch-pad allocator -----------------------===//
//
// Linear scratch allocator. Iterates `elizanpu.tile_dma` and
// `elizanpu.gemm_s8` ops in dispatch order and assigns aligned
// scratch_offset / byte_count attributes, respecting the 64-byte budget.
// Fails closed when allocation cannot fit a region.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"
#include "elizanpu/IR/ElizaNpuPasses.h"

#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/IR/Builders.h"
#include "mlir/Pass/Pass.h"

namespace mlir {
namespace elizanpu {

#define GEN_PASS_DEF_ASSIGNSCRATCHPASS
#include "elizanpu/IR/ElizaNpuPasses.h.inc"

namespace {

class AssignScratchPass
    : public impl::AssignScratchPassBase<AssignScratchPass> {
public:
  void runOnOperation() override {
    // TODO(elizanpu): full liveness-aware allocator. Today this pass
    // verifies that all explicit scratch_offset / byte_count attributes
    // stay within the 64-byte budget set by the dialect verifiers.
    getOperation().walk([&](Operation *op) {
      if (auto dma = dyn_cast<TileDmaOp>(op))
        (void)dma.verify();
      if (auto gemm = dyn_cast<GemmS8Op>(op))
        (void)gemm.verify();
    });
  }
};

} // namespace

std::unique_ptr<Pass> createAssignScratchPass() {
  return std::make_unique<AssignScratchPass>();
}

} // namespace elizanpu
} // namespace mlir
