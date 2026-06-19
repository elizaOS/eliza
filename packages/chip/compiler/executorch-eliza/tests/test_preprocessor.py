from __future__ import annotations

import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
PARENT = THIS_DIR.parents[1]
if str(PARENT) not in sys.path:
    sys.path.insert(0, str(PARENT))

from backend.ElizaPartitioner import GraphNode, Partition, PartitionResult  # noqa: E402
from backend.ElizaPreprocessor import ElizaPreprocessor  # noqa: E402


def test_preprocessor_emits_deterministic_partition_metadata() -> None:
    result = PartitionResult(
        npu_partitions=(
            Partition(
                nodes=(
                    GraphNode(
                        name="mm0",
                        target="aten.mm.default",
                        inputs=("x", "w0"),
                    ),
                    GraphNode(
                        name="relu0",
                        target="aten.relu.default",
                        inputs=("mm0",),
                    ),
                ),
                inputs=("x", "w0"),
                outputs=("relu0",),
            ),
        ),
        cpu_nodes=(GraphNode(name="view0", target="aten.view.default"),),
    )

    preprocessed = ElizaPreprocessor().preprocess(result)

    assert "func.func @partition_0()" in preprocessed.elizanpu_mlir
    assert "op_0: mm0 target=aten.mm.default inputs=x, w0" in preprocessed.elizanpu_mlir
    assert "op_1: relu0 target=aten.relu.default inputs=mm0" in preprocessed.elizanpu_mlir
    assert preprocessed.iree_vmfb_path is None
    assert preprocessed.cpu_fallback_op_names == ("aten.view.default",)
    assert preprocessed.blocked_reason is not None
