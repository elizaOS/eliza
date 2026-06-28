//===-- ElizaNpuOps.td - elizanpu operations --------------*- tablegen -*-===//
//
// Operations exposed by the `elizanpu` dialect. Each op corresponds to a
// concrete hardware capability declared in
// `docs/spec-db/e1-npu-runtime-contract.json`. The ops are deliberately
// thin wrappers around the descriptor ring submission ABI; high-level
// patterns (matmul, attention, layer-norm) are lowered to sequences of
// these ops by ElizaNpuPasses, not modeled as single ops.
//
//===----------------------------------------------------------------------===//

#ifndef ELIZANPU_OPS
#define ELIZANPU_OPS

include "elizanpu/IR/ElizaNpuDialect.td"
include "mlir/IR/BuiltinAttributes.td"
include "mlir/IR/BuiltinTypes.td"
include "mlir/IR/OpAsmInterface.td"
include "mlir/Interfaces/SideEffectInterfaces.td"
include "mlir/Interfaces/InferTypeOpInterface.td"

//===----------------------------------------------------------------------===//
// Types
//===----------------------------------------------------------------------===//

def ElizaNpu_ScratchType : ElizaNpu_Type<"Scratch", "scratch"> {
  let summary = "Opaque handle to the 64-byte NPU scratchpad";
  let description = [{
    A `!elizanpu.scratch` value tracks ownership of the 64-byte MMIO
    scratchpad across descriptor submissions. It carries no data, but its
    use-def chain enforces that DMA and execution ops are ordered correctly.
  }];
  let parameters = (ins);
  let assemblyFormat = "";
}

def ElizaNpu_DescriptorRingType : ElizaNpu_Type<"DescriptorRing", "ring"> {
  let summary = "Opaque handle to the 8-entry descriptor ring";
  let description = [{
    A `!elizanpu.ring` value tracks descriptor-ring ownership. Submit ops
    consume one entry per descriptor; the ring is asserted empty between
    independent IREE dispatch regions.
  }];
  let parameters = (ins);
  let assemblyFormat = "";
}

//===----------------------------------------------------------------------===//
// Attributes
//===----------------------------------------------------------------------===//

def ElizaNpu_Precision : I32EnumAttr<"Precision", "elizanpu data precision",
  [
    I32EnumAttrCase<"INT8",        0, "int8">,
    I32EnumAttrCase<"INT4_PACKED", 1, "int4_packed">,
    I32EnumAttrCase<"INT4_SPARSE_2_4", 2, "int4_sparse_2_4">,
    I32EnumAttrCase<"INT2",        3, "int2">,
    I32EnumAttrCase<"FP8_E4M3",    4, "fp8_e4m3">
  ]> {
  let genSpecializedAttr = 1;
  let cppNamespace = "::mlir::elizanpu";
}

def ElizaNpu_PrecisionAttr : EnumAttr<ElizaNpu_Dialect, ElizaNpu_Precision, "precision">;

//===----------------------------------------------------------------------===//
// Descriptor / DMA / submission primitives
//===----------------------------------------------------------------------===//

def ElizaNpu_AcquireRingOp : ElizaNpu_Op<"acquire_ring",
    [Pure]> {
  let summary = "Acquire descriptor ring ownership for a dispatch region";
  let description = [{
    Returns an `!elizanpu.ring` value. The ring is the SSA token threaded
    through every descriptor submission in a dispatch region. Acquiring the
    ring corresponds to programming `DESC_BASE` and reading `DESC_STATUS` to
    confirm the ring is empty.
  }];
  let arguments = (ins);
  let results = (outs ElizaNpu_DescriptorRingType:$ring);
  let assemblyFormat = "attr-dict `:` type($ring)";
}

def ElizaNpu_TileDmaOp : ElizaNpu_Op<"tile_dma",
    [DeclareOpInterfaceMethods<MemoryEffectsOpInterface>]> {
  let summary = "Stream an aligned 32-bit DRAM region into the 64-byte scratchpad";
  let description = [{
    Lowers to a descriptor with `stream_to_scratch[8]` set. The
    `source_addr` is a 32-bit aligned DRAM byte address; the `scratch_offset`
    is 32-bit aligned within [0, 64); `byte_count` is in (0, 64], 32-bit
    aligned; `scratch_offset + byte_count <= 64`. Hardware rejects all
    violations with `DESC_STATUS.error`.
  }];
  let arguments = (ins
    ElizaNpu_DescriptorRingType:$ring_in,
    ElizaNpu_ScratchType:$scratch_in,
    I32:$source_addr,
    I32Attr:$scratch_offset,
    I32Attr:$byte_count
  );
  let results = (outs
    ElizaNpu_DescriptorRingType:$ring_out,
    ElizaNpu_ScratchType:$scratch_out
  );
  let assemblyFormat = [{
    $ring_in `,` $scratch_in `,` $source_addr
    `,` `offset` `=` $scratch_offset
    `,` `bytes` `=` $byte_count
    attr-dict `:` `(` type($ring_in) `,` type($scratch_in) `,` type($source_addr) `)`
    `->` `(` type($ring_out) `,` type($scratch_out) `)`
  }];
  let hasVerifier = 1;
}

def ElizaNpu_SubmitDescriptorOp : ElizaNpu_Op<"submit_descriptor",
    [DeclareOpInterfaceMethods<MemoryEffectsOpInterface>]> {
  let summary = "Submit a single 4-word descriptor and wait for hardware completion";
  let description = [{
    Lowers to the `submit_descriptors` runtime ABI in
    `compiler/runtime/e1_npu_runtime.py`. Programs `DESC_BASE`, advances
    `DESC_HEAD`, asserts `CMD_PARAM[0]`, pulses `CTRL_STATUS.start`, and
    polls `DESC_STATUS` until `DONE` (success) or any error bit (fail).
    Software is forbidden from setting `writeback_request`; the hardware
    rejects it. This op is the only legal way for the dialect to exit a
    dispatch region.
  }];
  let arguments = (ins
    ElizaNpu_DescriptorRingType:$ring_in,
    I32Attr:$opcode,
    I32:$source_addr,
    I32Attr:$scratch_offset,
    I32Attr:$byte_count,
    I32:$op_b,
    I32:$acc,
    BoolAttr:$writeback_request
  );
  let results = (outs ElizaNpu_DescriptorRingType:$ring_out);
  let assemblyFormat = [{
    $ring_in `,` `opcode` `=` $opcode
    `,` `src` `=` $source_addr
    `,` `offset` `=` $scratch_offset
    `,` `bytes` `=` $byte_count
    `,` `op_b` `=` $op_b
    `,` `acc` `=` $acc
    attr-dict `:` `(` type($ring_in) `,` type($source_addr) `,` type($op_b) `,` type($acc) `)`
    `->` type($ring_out)
  }];
  let hasVerifier = 1;
}

//===----------------------------------------------------------------------===//
// Compute primitives (1:1 with hardware opcodes)
//===----------------------------------------------------------------------===//

def ElizaNpu_GemmS8Op : ElizaNpu_Op<"gemm_s8",
    [DeclareOpInterfaceMethods<MemoryEffectsOpInterface>]> {
  let summary = "Bounded INT8 GEMM tile (M<=3, N<=3, K<=7, scratchpad-resident)";
  let description = [{
    Emits the `GEMM_S8` opcode plus the `GEMM_CFG`/`GEMM_BASE`/`GEMM_STRIDE`
    register programming. Inputs and outputs live in the 64-byte scratchpad
    addressed by the tile DMA ops that precede this op. The accumulator type
    is int32; results are written back into the scratchpad.

    Use this op only inside the canonical lowering of `linalg.matmul`
    tiles; the lowering must ensure M, N, K obey the hardware bounds.
  }];
  let arguments = (ins
    ElizaNpu_DescriptorRingType:$ring_in,
    ElizaNpu_ScratchType:$scratch_in,
    I32Attr:$m,
    I32Attr:$n,
    I32Attr:$k,
    I32Attr:$a_base,
    I32Attr:$b_base,
    I32Attr:$c_base
  );
  let results = (outs
    ElizaNpu_DescriptorRingType:$ring_out,
    ElizaNpu_ScratchType:$scratch_out
  );
  let assemblyFormat = [{
    $ring_in `,` $scratch_in
    `,` `m` `=` $m `,` `n` `=` $n `,` `k` `=` $k
    `,` `a_base` `=` $a_base `,` `b_base` `=` $b_base `,` `c_base` `=` $c_base
    attr-dict
    `:` `(` type($ring_in) `,` type($scratch_in) `)`
    `->` `(` type($ring_out) `,` type($scratch_out) `)`
  }];
  let hasVerifier = 1;
}

def ElizaNpu_Dot4S8Op : ElizaNpu_Op<"dot4_s8", [Pure]> {
  let summary = "Four packed signed INT8 dot products plus signed accumulator";
  let description = [{
    Mirrors hardware opcode `DOT4_S8 = 4`. Both operands are 32-bit packed
    SIMD INT8 quartets; result is a signed 32-bit dot product.
  }];
  let arguments = (ins I32:$a_packed, I32:$b_packed, I32:$acc);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed `,` $b_packed `,` $acc attr-dict `:` type($result)";
}

def ElizaNpu_Dot8S4Op : ElizaNpu_Op<"dot8_s4", [Pure]> {
  let summary = "Eight packed signed INT4 dot products plus signed accumulator";
  let description = [{
    Mirrors hardware opcode `DOT8_S4 = 7`. Operands are 32-bit packed SIMD
    INT4 octets.
  }];
  let arguments = (ins I32:$a_packed, I32:$b_packed, I32:$acc);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed `,` $b_packed `,` $acc attr-dict `:` type($result)";
}

def ElizaNpu_Dot16S2Op : ElizaNpu_Op<"dot16_s2", [Pure]> {
  let summary = "Sixteen packed signed INT2 dot products plus signed accumulator";
  let description = [{
    Targets `DOT16_S2`. Currently scalar-only in the contract enforcer.
    Tensor execution remains BLOCKED until the RTL datapath is implemented.
  }];
  let arguments = (ins I32:$a_packed, I32:$b_packed, I32:$acc);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed `,` $b_packed `,` $acc attr-dict `:` type($result)";
}

def ElizaNpu_Dot4Fp8E4M3Op : ElizaNpu_Op<"dot4_fp8_e4m3", [Pure]> {
  let summary = "Four packed FP8 E4M3 dot products plus FP32 accumulator (scalar contract)";
  let description = [{
    Targets the FP8 E4M3 scalar opcode. Tensor execution and full FP8 GEMM
    remain BLOCKED until the RTL datapath is implemented.
  }];
  let arguments = (ins I32:$a_packed, I32:$b_packed, I32:$acc);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed `,` $b_packed `,` $acc attr-dict `:` type($result)";
}

def ElizaNpu_SparseSdot4S4_2_4Op : ElizaNpu_Op<"sparse_sdot4_s4_2_4", [Pure]> {
  let summary = "2:4 structured sparse INT4 dot product";
  let description = [{
    Mirrors the sparse INT4 dot opcode used by the structured-sparse path.
    Inputs are the packed INT4 values plus a 4-bit mask byte indicating which
    two of every four positions are non-zero.
  }];
  let arguments = (ins I32:$a_packed, I32:$b_packed, I32:$mask, I32:$acc);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed `,` $b_packed `,` $mask `,` $acc attr-dict `:` type($result)";
}

def ElizaNpu_VReluOp : ElizaNpu_Op<"vrelu", [Pure]> {
  let summary = "Packed INT8 element-wise ReLU (per-lane saturating max(0, x))";
  let description = [{
    Targets the packed RELU4_S8 / VRELU_S8 opcode group. Operand is a 32-bit
    packed INT8 quartet; result preserves layout.
  }];
  let arguments = (ins I32:$a_packed);
  let results = (outs I32:$result);
  let assemblyFormat = "$a_packed attr-dict `:` type($result)";
}

#endif // ELIZANPU_OPS
