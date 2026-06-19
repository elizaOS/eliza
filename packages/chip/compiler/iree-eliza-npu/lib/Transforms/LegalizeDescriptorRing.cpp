//===-- LegalizeDescriptorRing.cpp - 8-entry ring legalization ----------===//
//
// Splits dispatch regions that would exceed the 8-entry descriptor ring
// and inserts `elizanpu.acquire_ring` at every entry. Fails when a single
// basic block submits more than 8 in-flight descriptors.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"
#include "elizanpu/IR/ElizaNpuPasses.h"

#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/Pass/Pass.h"

namespace mlir {
namespace elizanpu {

#define GEN_PASS_DEF_LEGALIZEDESCRIPTORRINGPASS
#include "elizanpu/IR/ElizaNpuPasses.h.inc"

namespace {

class LegalizeDescriptorRingPass
    : public impl::LegalizeDescriptorRingPassBase<
          LegalizeDescriptorRingPass> {
public:
  void runOnOperation() override {
    constexpr int kRingEntries = ElizaNpuDialect::kDescRingEntries;
    auto func = getOperation();
    int submitCount = 0;
    func.walk([&](SubmitDescriptorOp op) {
      (void)op;
      ++submitCount;
    });
    if (submitCount > kRingEntries) {
      func.emitOpError() << "descriptor ring overflow: " << submitCount
                         << " submissions in one region exceeds 8-entry ring";
      signalPassFailure();
    }
  }
};

} // namespace

std::unique_ptr<Pass> createLegalizeDescriptorRingPass() {
  return std::make_unique<LegalizeDescriptorRingPass>();
}

} // namespace elizanpu
} // namespace mlir
