"""ExecuTorch backend for the e1 NPU descriptor ring.

The backend is the 13th entry in ExecuTorch's backend list. It partitions a
PyTorch ExportedProgram between CPU fallback (XNNPACK / native) and the
e1 NPU, lowering NPU-resident subgraphs through the elizanpu IREE dialect.

Status: skeleton only. Full lowering is BLOCKED until IREE is built inside
the canonical Linux container per docs/toolchain/iree-eliza-npu.md.
"""

from __future__ import annotations

from .eliza_op_support import NPU_OP_SUPPORT
from .ElizaPartitioner import ElizaPartitioner
from .ElizaPreprocessor import ElizaPreprocessor


class ElizaBackend:
    """Top-level ExecuTorch backend entry point.

    This class is the registration shim. The real lowering work lives in
    `ElizaPartitioner` (selects NPU-resident nodes) and `ElizaPreprocessor`
    (lowers through StableHLO + elizanpu).
    """

    name = "elizanpu"
    op_support = NPU_OP_SUPPORT

    @staticmethod
    def partitioner() -> ElizaPartitioner:
        return ElizaPartitioner()

    @staticmethod
    def preprocessor() -> ElizaPreprocessor:
        return ElizaPreprocessor()


__all__ = ["ElizaBackend", "ElizaPartitioner", "ElizaPreprocessor", "NPU_OP_SUPPORT"]
