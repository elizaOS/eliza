"""ExecuTorch preprocessor: lower partitioned subgraphs through elizanpu.

The preprocessor takes a `PartitionResult` from `ElizaPartitioner` and
produces an elizanpu MLIR module per NPU partition. The module is fed to
`iree-compile --iree-hal-target-backends=elizanpu` to produce a `.vmfb`
blob, which is then wrapped into an ExecuTorch `.pte` along with CPU
fallback nodes.

Status: skeleton. The actual `iree-compile` invocation is BLOCKED until
the IREE build runs inside the canonical Linux container.
"""

from __future__ import annotations

from dataclasses import dataclass

from .ElizaPartitioner import PartitionResult


@dataclass(frozen=True)
class PreprocessResult:
    elizanpu_mlir: str
    iree_vmfb_path: str | None
    cpu_fallback_op_names: tuple[str, ...]
    blocked_reason: str | None = None


class ElizaPreprocessor:
    """Translate a PartitionResult into an elizanpu MLIR module."""

    def preprocess(self, result: PartitionResult) -> PreprocessResult:
        # Emit one elizanpu function per partition with deterministic op
        # metadata. IREE compilation remains blocked on the canonical Linux
        # container, but this artifact is stable input for that flow.
        lines: list[str] = ["// elizanpu module emitted by ElizaPreprocessor"]
        for index, partition in enumerate(result.npu_partitions):
            lines.append(f"func.func @partition_{index}() {{")
            lines.append(f"  // inputs: {', '.join(partition.inputs)}")
            lines.append(f"  // outputs: {', '.join(partition.outputs)}")
            lines.append("  %ring = elizanpu.acquire_ring : !elizanpu.ring")
            for node_index, node in enumerate(partition.nodes):
                input_names = ", ".join(node.inputs) if node.inputs else "<none>"
                lines.append(
                    f"  // op_{node_index}: {node.name} target={node.target} inputs={input_names}"
                )
            lines.append("  return")
            lines.append("}")

        return PreprocessResult(
            elizanpu_mlir="\n".join(lines),
            iree_vmfb_path=None,
            cpu_fallback_op_names=tuple(n.target for n in result.cpu_nodes),
            blocked_reason=(
                "iree-compile invocation blocked until LLVM/IREE built in "
                "canonical Linux container per docs/toolchain/iree-eliza-npu.md"
            ),
        )
