//===-- ElizaNpuPasses.h - elizanpu pass declarations -----------*- C++ -*-===//
#ifndef ELIZANPU_IR_ELIZANPUPASSES_H
#define ELIZANPU_IR_ELIZANPUPASSES_H

#include "mlir/Pass/Pass.h"

namespace mlir {
namespace func {
class FuncOp;
} // namespace func
namespace elizanpu {

std::unique_ptr<::mlir::Pass> createAssignScratchPass();
std::unique_ptr<::mlir::Pass> createLegalizeDescriptorRingPass();

#define GEN_PASS_REGISTRATION
#include "elizanpu/IR/ElizaNpuPasses.h.inc"

} // namespace elizanpu
} // namespace mlir

#endif // ELIZANPU_IR_ELIZANPUPASSES_H
