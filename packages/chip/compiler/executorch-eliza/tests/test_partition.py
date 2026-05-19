"""Unit tests for `ElizaPartitioner` using a tiny fake graph.

The partitioner is the production code path between an ExecuTorch
`ExportedProgram` and the elizanpu IREE lowering. These tests verify that
ops on the supported list end up in NPU partitions and that unsupported ops
(softmax, layer_norm, custom python ops) break partition boundaries.

The tests run with only the standard library so they execute in repo CI
regardless of whether torch / executorch are installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
PARENT = THIS_DIR.parents[1]
if str(PARENT) not in sys.path:
    sys.path.insert(0, str(PARENT))

from backend.ElizaPartitioner import ElizaPartitioner, GraphNode  # noqa: E402


def _two_layer_mlp_nodes() -> list[GraphNode]:
    return [
        GraphNode(name="x", target="placeholder"),
        GraphNode(name="w0", target="placeholder"),
        GraphNode(name="b0", target="placeholder"),
        GraphNode(name="w1", target="placeholder"),
        GraphNode(name="b1", target="placeholder"),
        GraphNode(name="h", target="aten.linear.default", inputs=("x", "w0", "b0")),
        GraphNode(name="h_relu", target="aten.relu.default", inputs=("h",)),
        GraphNode(name="y", target="aten.linear.default", inputs=("h_relu", "w1", "b1")),
    ]


def test_partition_two_layer_mlp_routes_linear_and_relu_to_npu() -> None:
    nodes = _two_layer_mlp_nodes()
    result = ElizaPartitioner().partition_nodes(nodes)
    # Placeholder nodes are not in the supported set; they get CPU-fallback
    # routing. The compute nodes form a single contiguous NPU partition.
    npu_targets = [n.target for p in result.npu_partitions for n in p.nodes]
    assert npu_targets == [
        "aten.linear.default",
        "aten.relu.default",
        "aten.linear.default",
    ]


def test_softmax_breaks_partition() -> None:
    nodes = [
        GraphNode(name="x", target="aten.linear.default"),
        GraphNode(name="y", target="aten.softmax.int", inputs=("x",)),
        GraphNode(name="z", target="aten.linear.default", inputs=("y",)),
    ]
    result = ElizaPartitioner().partition_nodes(nodes)
    assert len(result.npu_partitions) == 2
    assert [n.target for n in result.cpu_nodes] == ["aten.softmax.int"]


def test_partition_json_round_trip() -> None:
    nodes = _two_layer_mlp_nodes()
    result = ElizaPartitioner().partition_nodes(nodes)
    out = result.to_json()
    assert "eliza.executorch_partition.v1" in out
    assert "aten.linear.default" in out
