//===-- ElizaNpuOps.cpp - elizanpu op verifiers --------------------------===//
//
// Hardware-bound verifiers. These enforce the same invariants the runtime
// enforces in `compiler/runtime/e1_npu_runtime.py` so we fail at compile time
// instead of runtime poll-and-reject.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"

#include "mlir/IR/Builders.h"
#include "mlir/IR/OpImplementation.h"

using namespace mlir;
using namespace mlir::elizanpu;

namespace {

constexpr int kScratchBytes = ElizaNpuDialect::kScratchBytes;
constexpr int kGemmMMax = ElizaNpuDialect::kGemmMMax;
constexpr int kGemmNMax = ElizaNpuDialect::kGemmNMax;
constexpr int kGemmKMax = ElizaNpuDialect::kGemmKMax;

LogicalResult verifyAlignedRange(Operation *op, StringRef field, int32_t offset,
                                 int32_t byteCount) {
  if (offset < 0 || offset >= kScratchBytes || (offset & 0x3))
    return op->emitOpError() << field
                             << " offset must be 32-bit aligned within "
                                "[0, 64)";
  if (byteCount <= 0 || byteCount > kScratchBytes || (byteCount & 0x3))
    return op->emitOpError() << field
                             << " byte_count must be a positive 32-bit-aligned "
                                "value <= 64";
  if (offset + byteCount > kScratchBytes)
    return op->emitOpError() << field
                             << " stream exceeds 64-byte NPU scratchpad";
  return success();
}

} // namespace

LogicalResult TileDmaOp::verify() {
  return verifyAlignedRange(*this, "tile_dma",
                            getScratchOffsetAttr().getInt(),
                            getByteCountAttr().getInt());
}

LogicalResult SubmitDescriptorOp::verify() {
  if (getWritebackRequest())
    return emitOpError(
        "writeback_request must be false; the e1 RTL rejects descriptors "
        "with writeback_request set");
  int32_t opcode = getOpcodeAttr().getInt();
  if (opcode < 0 || opcode > 0xF)
    return emitOpError("opcode must fit in 4 bits");
  return verifyAlignedRange(*this, "submit_descriptor",
                            getScratchOffsetAttr().getInt(),
                            getByteCountAttr().getInt());
}

LogicalResult GemmS8Op::verify() {
  int32_t m = getMAttr().getInt();
  int32_t n = getNAttr().getInt();
  int32_t k = getKAttr().getInt();
  if (m < 1 || m > kGemmMMax || n < 1 || n > kGemmNMax || k < 1 ||
      k > kGemmKMax)
    return emitOpError("GEMM dimensions exceed prototype limits "
                       "(M<=3, N<=3, K<=7)");
  int32_t aBase = getABaseAttr().getInt();
  int32_t bBase = getBBaseAttr().getInt();
  int32_t cBase = getCBaseAttr().getInt();
  if ((cBase & 0x3) != 0)
    return emitOpError("c_base must be word-aligned");
  int32_t cBytes = m * n * 4;
  if (aBase < 0 || bBase < 0 || cBase < 0 ||
      cBase + cBytes > kScratchBytes ||
      aBase + (m * k) > kScratchBytes ||
      bBase + (k * n) > kScratchBytes)
    return emitOpError("GEMM tile exceeds 64-byte NPU scratchpad");
  return success();
}

#define GET_OP_CLASSES
#include "elizanpu/IR/ElizaNpuOps.cpp.inc"
