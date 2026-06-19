"""Whitelist of PyTorch / aten ops the elizanpu backend can execute.

Each entry maps an aten op name to (precision_list, lowering_hint). Anything
not in this table is left for CPU fallback. The table mirrors the dialect
op surface in `compiler/iree-eliza-npu/include/elizanpu/IR/ElizaNpuOps.td`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OpSupport:
    aten_op: str
    precisions: tuple[str, ...]
    elizanpu_lowering: str
    notes: str = ""


# Precision strings match `elizanpu.precision` attribute in the dialect.
NPU_OP_SUPPORT: tuple[OpSupport, ...] = (
    OpSupport(
        aten_op="aten.mm.default",
        precisions=("int8", "int4_packed", "int4_sparse_2_4"),
        elizanpu_lowering="tile -> elizanpu.gemm_s8 (with rescale for non-int8)",
    ),
    OpSupport(
        aten_op="aten.matmul.default",
        precisions=("int8", "int4_packed", "int4_sparse_2_4"),
        elizanpu_lowering="tile -> elizanpu.gemm_s8 (with rescale for non-int8)",
    ),
    OpSupport(
        aten_op="aten.bmm.default",
        precisions=("int8",),
        elizanpu_lowering="batch tile -> repeated elizanpu.gemm_s8",
    ),
    OpSupport(
        aten_op="aten.linear.default",
        precisions=("int8", "int4_packed"),
        elizanpu_lowering="canonicalize to mm, then tile -> elizanpu.gemm_s8",
    ),
    OpSupport(
        aten_op="aten.relu.default",
        precisions=("int8",),
        elizanpu_lowering="elizanpu.vrelu on packed quartets",
    ),
    OpSupport(
        aten_op="aten.conv2d.default",
        precisions=("int8",),
        elizanpu_lowering="im2col + tile -> elizanpu.gemm_s8",
        notes="NHWC layout enforced before lowering",
    ),
    # The following are CPU-fallback by intent. Listed so the partitioner can
    # emit explicit boundary nodes rather than silently dropping unsupported ops.
    OpSupport(
        aten_op="aten.softmax.int",
        precisions=(),
        elizanpu_lowering="CPU fallback (hardware has no softmax datapath)",
        notes="BLOCKED on hardware; do not lower",
    ),
    OpSupport(
        aten_op="aten.layer_norm.default",
        precisions=(),
        elizanpu_lowering="CPU fallback",
        notes="BLOCKED on hardware; do not lower",
    ),
)


SUPPORTED_OPS: frozenset[str] = frozenset(op.aten_op for op in NPU_OP_SUPPORT if op.precisions)


def is_supported(aten_op: str) -> bool:
    return aten_op in SUPPORTED_OPS
