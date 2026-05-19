//===-- EmitDescriptorTable.cpp - serialize submissions to runtime ------===//
//
// Final lowering: replaces `elizanpu.submit_descriptor` with calls into the
// C ABI in `compiler/iree-eliza-npu/runtime/eliza_npu_runtime.h`. The
// serialized table feeds IREE's HAL command-buffer emitter.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"
#include "elizanpu/IR/ElizaNpuPasses.h"

#include "mlir/Pass/Pass.h"

namespace mlir {
namespace elizanpu {

#define GEN_PASS_DEF_EMITDESCRIPTORTABLEPASS
#include "elizanpu/IR/ElizaNpuPasses.h.inc"

namespace {

class EmitDescriptorTablePass
    : public impl::EmitDescriptorTablePassBase<EmitDescriptorTablePass> {
public:
  void runOnOperation() override {
    // TODO(elizanpu): emit a flatbuffer + linker symbol pointing at
    // `eliza_npu_runtime_submit_descriptor_table`. Until then the pass is a
    // no-op; the in-tree IREE backend uses the dialect's runtime API
    // directly through the linker.
  }
};

} // namespace

std::unique_ptr<Pass> createEmitDescriptorTablePass() {
  return std::make_unique<EmitDescriptorTablePass>();
}

} // namespace elizanpu
} // namespace mlir
