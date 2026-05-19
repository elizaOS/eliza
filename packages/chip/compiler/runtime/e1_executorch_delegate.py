"""ExecuTorch delegate skeleton for the e1 NPU.

Status: PROTOTYPE. This module models the ExecuTorch Python delegate surface
without importing the upstream ``executorch`` package. It consumes the
``e1_npu_stablehlo`` dataclass subset, runs the same tile/precision validation
that the runtime contract requires, and emits a placeholder descriptor-spec
blob that documents what an ExecuTorch backend would lower at runtime. No
binary kernel, no ahead-of-time codegen, and no ExecuTorch graph passes are
implemented; this is the partitioner/preprocess shape only, mirrored so the
B-5 partitioner and a future executorch backend can share a single Python
contract.

The interface mirrors the upstream contract:

* ``Partitioner.partition(edge_program)``    -> ``PartitionResult``
* ``Backend.preprocess(edge_program)``       -> ``PreprocessResult``

``edge_program`` is the validated ``StableHloModule`` from ``parse_module``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from e1_npu_partitioner import PartitionEntry, partition_module
from e1_npu_stablehlo import (
    StableHloModule,
    StableHloOp,
    StableHloValidationError,
    plan_op_lowering,
    validate_module,
)

SCHEMA = "eliza.e1_executorch_delegate.v1"
BACKEND_ID = "EXECUTORCH_E1_NPU_DELEGATE"
STATUS = "PROTOTYPE"


@dataclass(frozen=True)
class PartitionResult:
    """ExecuTorch-style partition outcome: per-op (node, supported, reason)."""

    backend_id: str
    entries: tuple[PartitionEntry, ...]

    def as_list(self) -> list[tuple[StableHloOp, bool]]:
        return [(entry.op, entry.supported) for entry in self.entries]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "entries": [entry.as_dict() for entry in self.entries],
        }


@dataclass(frozen=True)
class PreprocessResult:
    """ExecuTorch-style preprocess output: a placeholder backend blob."""

    backend_id: str
    blob: bytes
    descriptor_specs: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    command_buffer_batches: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "blob_bytes": len(self.blob),
            "descriptor_specs": list(self.descriptor_specs),
            "command_buffer_batches": list(self.command_buffer_batches),
        }


class Partitioner:
    """Skeleton partitioner with the same surface ExecuTorch expects."""

    backend_id = BACKEND_ID

    def partition(self, edge_program: StableHloModule) -> PartitionResult:
        if not isinstance(edge_program, StableHloModule):
            raise TypeError("edge_program must be a StableHloModule")
        entries = partition_module(edge_program).entries
        return PartitionResult(backend_id=self.backend_id, entries=entries)


class Backend:
    """Skeleton backend with the same preprocess surface ExecuTorch expects."""

    backend_id = BACKEND_ID

    def preprocess(self, edge_program: StableHloModule) -> PreprocessResult:
        if not isinstance(edge_program, StableHloModule):
            raise TypeError("edge_program must be a StableHloModule")
        issues = validate_module(edge_program)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot preprocess invalid StableHLO subset module: {rendered}"
            )
        partition_report = partition_module(edge_program)
        specs = tuple(_descriptor_spec(op) for op in edge_program.ops)
        command_buffer_batches = tuple(
            batch.as_dict() for batch in partition_report.command_buffer_batches
        )
        payload = {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "module": edge_program.name,
            "descriptor_specs": list(specs),
            "command_buffer_batches": list(command_buffer_batches),
        }
        blob = json.dumps(payload, sort_keys=True).encode("utf-8")
        return PreprocessResult(
            backend_id=self.backend_id,
            blob=blob,
            descriptor_specs=specs,
            command_buffer_batches=command_buffer_batches,
        )


def partition(edge_program: StableHloModule) -> list[tuple[StableHloOp, bool]]:
    """Module-level wrapper matching the documented brief signature."""
    return Partitioner().partition(edge_program).as_list()


def preprocess(edge_program: StableHloModule) -> bytes:
    """Module-level wrapper that returns the placeholder backend blob bytes."""
    return Backend().preprocess(edge_program).blob


def _descriptor_spec(op: StableHloOp) -> dict[str, Any]:
    plan = plan_op_lowering(op)
    return {
        "op_name": op.name,
        "source_op": plan.source_op,
        "source_precision": plan.source_precision,
        "runtime_api": plan.runtime_api,
        "schema": plan.schema,
        "lowering_precision": plan.lowering_precision,
        "input_shape": list(plan.input_shape),
        "output_shape": list(plan.output_shape),
        "required_graph_fields": list(plan.required_graph_fields),
        "claim_boundary": plan.claim_boundary,
    }
