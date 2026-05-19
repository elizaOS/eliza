//===-- ConvertLinalgToElizaNpu.cpp - linalg -> elizanpu lowering ---------===//
//
// Skeleton lowering pass. The full lowering walks each `linalg.matmul`,
// `linalg.conv_2d_nhwc_hwio`, `linalg.softmax`, `linalg.fill`, and attention
// pattern and decomposes it into elizanpu descriptor submissions plus CPU
// fallback. The Python oracle in `compiler/runtime/e1_npu_lowering.py` is the
// reference for tiling shape and host-side fix-up; this pass is the
// production codegen path that replaces it once IREE is plumbed.
//
//===----------------------------------------------------------------------===//

#include "elizanpu/IR/ElizaNpuDialect.h"
#include "elizanpu/IR/ElizaNpuPasses.h"

#include "mlir/Dialect/Linalg/IR/Linalg.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/IR/PatternMatch.h"
#include "mlir/Pass/Pass.h"
#include "mlir/Transforms/GreedyPatternRewriteDriver.h"

namespace mlir {
namespace elizanpu {

#define GEN_PASS_DEF_CONVERTLINALGTOELIZANPUPASS
#include "elizanpu/IR/ElizaNpuPasses.h.inc"

namespace {

// Lowering of `linalg.matmul` -> tiled elizanpu.gemm_s8 sequence.
// Tiling rule: M tiles of `kGemmMMax`, N tiles of `kGemmNMax`,
// K reduction tiles of `kGemmKMax`. Inside each tile we emit:
//   1. tile_dma for A operand
//   2. tile_dma for B operand
//   3. gemm_s8
//   4. tile_dma for C writeback (BLOCKED: hardware writeback not implemented;
//      the lowering must emit a CPU fallback for the C copy until the RTL
//      writeback DMA path lands).
struct MatmulToElizaNpuPattern : public OpRewritePattern<linalg::MatmulOp> {
  using OpRewritePattern<linalg::MatmulOp>::OpRewritePattern;

  LogicalResult matchAndRewrite(linalg::MatmulOp op,
                                PatternRewriter &rewriter) const override {
    // TODO(elizanpu): Implement full tiling. This pass currently leaves
    // linalg.matmul untouched; the IREE backend falls back to upstream
    // linalg-to-cpu lowering. Wire-up unblocks once the dialect is built
    // inside an IREE source tree.
    (void)op;
    (void)rewriter;
    return failure();
  }
};

class ConvertLinalgToElizaNpuPass
    : public impl::ConvertLinalgToElizaNpuPassBase<
          ConvertLinalgToElizaNpuPass> {
public:
  using impl::ConvertLinalgToElizaNpuPassBase<
      ConvertLinalgToElizaNpuPass>::ConvertLinalgToElizaNpuPassBase;

  void runOnOperation() override {
    RewritePatternSet patterns(&getContext());
    patterns.add<MatmulToElizaNpuPattern>(&getContext());
    if (failed(applyPatternsAndFoldGreedily(getOperation(),
                                            std::move(patterns))))
      signalPassFailure();
  }
};

} // namespace

std::unique_ptr<Pass> createConvertLinalgToElizaNpuPass() {
  return std::make_unique<ConvertLinalgToElizaNpuPass>();
}

} // namespace elizanpu
} // namespace mlir
