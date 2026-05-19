//===-- ElizaNpuDialect.td - elizanpu dialect definition --*- tablegen -*-===//
//
// Dialect description for the e1 NPU. The `elizanpu` dialect is the lowering
// surface between IREE host-side StableHLO / linalg and the e1 NPU MMIO
// descriptor ring contract (compiler/runtime/e1_npu_runtime.py,
// docs/spec-db/e1-npu-runtime-contract.json).
//
// Operations in this dialect represent things the descriptor ring can actually
// execute: descriptor submissions, tile DMA into the 64-byte scratchpad, and
// bounded GEMM/dot kernels in the precisions the hardware supports today
// (INT8 dense, INT4 packed dot, sparse 2:4 INT4, INT2, FP8 E4M3). Anything
// the hardware does NOT support (FP16/BF16 GEMM, full softmax, full layer-norm)
// is intentionally absent: passes must lower those through linalg fallback to
// the CPU, not invent a fake elizanpu op.
//
//===----------------------------------------------------------------------===//

#ifndef ELIZANPU_DIALECT
#define ELIZANPU_DIALECT

include "mlir/IR/OpBase.td"
include "mlir/IR/AttrTypeBase.td"

def ElizaNpu_Dialect : Dialect {
  let name = "elizanpu";
  let cppNamespace = "::mlir::elizanpu";
  let summary = "e1 NPU descriptor-ring dialect for IREE lowering";
  let description = [{
    The `elizanpu` dialect models the e1 NPU descriptor ring as a first-class
    MLIR target. It is consumed by IREE backends that partition StableHLO /
    linalg graphs into NPU-resident regions and CPU fallback regions.

    The dialect is intentionally narrow: every op corresponds to a concrete
    descriptor submission or an existing MMIO opcode in `e1_npu.sv`. There is
    no abstract `matmul` or `attention` op in elizanpu; those are decomposed
    into tile-sized submissions during lowering.
  }];

  let useDefaultTypePrinterParser = 1;
  let useDefaultAttributePrinterParser = 1;

  let extraClassDeclaration = [{
    /// Hardware contract constants mirroring docs/spec-db/e1-npu-runtime-contract.json.
    static constexpr int kScratchBytes = 64;
    static constexpr int kDescRingEntries = 8;
    static constexpr int kGemmMMax = 3;
    static constexpr int kGemmNMax = 3;
    static constexpr int kGemmKMax = 7;
  }];
}

class ElizaNpu_Op<string mnemonic, list<Trait> traits = []>
    : Op<ElizaNpu_Dialect, mnemonic, traits>;

class ElizaNpu_Type<string name, string typeMnemonic, list<Trait> traits = []>
    : TypeDef<ElizaNpu_Dialect, name, traits> {
  let mnemonic = typeMnemonic;
}

class ElizaNpu_Attr<string name, string attrMnemonic, list<Trait> traits = []>
    : AttrDef<ElizaNpu_Dialect, name, traits> {
  let mnemonic = attrMnemonic;
}

#endif // ELIZANPU_DIALECT
