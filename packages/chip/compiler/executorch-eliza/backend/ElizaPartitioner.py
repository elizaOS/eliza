"""ExecuTorch partitioner: select NPU-resident nodes from an ExportedProgram.

The partitioner walks the ExportedProgram graph and tags each node as
NPU-resident or CPU-resident based on the elizanpu op whitelist. It emits a
partition manifest (JSON) consumed by `ElizaPreprocessor` for the actual
StableHLO/IREE lowering.

Status: skeleton. The full integration requires `executorch` and `torch`
installed; a unit test on a 2-layer MLP runs without those imports by
using a small fake graph data structure (see tests/test_partition.py).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field

from .eliza_op_support import is_supported


@dataclass(frozen=True)
class GraphNode:
    """Minimal graph-node abstraction used by the partitioner test harness."""

    name: str
    target: str  # aten op name, e.g. "aten.mm.default"
    inputs: tuple[str, ...] = ()
    meta: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Partition:
    """A contiguous slice of NPU-resident nodes."""

    nodes: tuple[GraphNode, ...]
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]
    boundary_kind: str = "iree_input.tensor.transfer"


@dataclass(frozen=True)
class PartitionResult:
    npu_partitions: tuple[Partition, ...]
    cpu_nodes: tuple[GraphNode, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": "eliza.executorch_partition.v1",
            "npu_partitions": [
                {
                    "nodes": [n.target for n in p.nodes],
                    "inputs": list(p.inputs),
                    "outputs": list(p.outputs),
                    "boundary_kind": p.boundary_kind,
                }
                for p in self.npu_partitions
            ],
            "cpu_nodes": [n.target for n in self.cpu_nodes],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True)


class ElizaPartitioner:
    """Walk an ExportedProgram and group NPU-resident nodes into partitions.

    The real ExecuTorch interface takes an `ExportedProgram` and returns a
    `PartitionResult` with `NodeSet` instances. This skeleton accepts an
    iterable of `GraphNode` so the test harness can exercise the logic
    without torch installed.
    """

    def partition_nodes(self, nodes: Iterable[GraphNode]) -> PartitionResult:
        npu_partitions: list[Partition] = []
        cpu_nodes: list[GraphNode] = []
        current_partition: list[GraphNode] = []

        def flush() -> None:
            if not current_partition:
                return
            inputs: list[str] = []
            partition_names = {n.name for n in current_partition}
            for n in current_partition:
                for inp in n.inputs:
                    if inp not in partition_names:
                        inputs.append(inp)
            outputs = tuple(n.name for n in current_partition)
            npu_partitions.append(
                Partition(
                    nodes=tuple(current_partition),
                    inputs=tuple(dict.fromkeys(inputs)),
                    outputs=outputs,
                )
            )
            current_partition.clear()

        for node in nodes:
            if is_supported(node.target):
                current_partition.append(node)
            else:
                flush()
                cpu_nodes.append(node)
        flush()

        return PartitionResult(
            npu_partitions=tuple(npu_partitions),
            cpu_nodes=tuple(cpu_nodes),
        )
