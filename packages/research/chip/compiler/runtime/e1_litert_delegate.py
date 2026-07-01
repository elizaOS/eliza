"""LiteRT (TFLite) delegate skeleton for the e1 NPU.

Status: PROTOTYPE. This module mirrors the C-style delegate surface declared
in ``e1_litert_delegate.h`` from Python, without importing the upstream LiteRT
package. LiteRT ingests StableHLO directly, so the delegate consumes the same
``e1_npu_stablehlo`` dataclass subset that the ExecuTorch delegate (B-2) uses
and shares the partitioner (B-5) for the supported-set decision.

The delegate artifact is the same JSON descriptor-spec payload that the
ExecuTorch delegate emits, encoded as bytes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from e1_npu_partitioner import PartitionEntry, partition_module
from e1_npu_stablehlo import (
    StableHloModule,
    StableHloOp,
    StableHloParseError,
    StableHloValidationError,
    parse_module,
    plan_op_lowering,
    validate_module,
)

SCHEMA = "eliza.e1_litert_delegate.v1"
BACKEND_ID = "LITERT_E1_NPU_DELEGATE"
STATUS = "PROTOTYPE"


@dataclass(frozen=True)
class LiteRtPartitionEntry:
    """Per-op partition record matching ``E1LiteRtPartitionEntry`` in the header."""

    op_name: str
    op_kind: str
    supported: bool
    reason: str
    runtime_api: str | None
    mapped_opcodes: tuple[str, ...] = ()

    @classmethod
    def from_partition_entry(cls, entry: PartitionEntry) -> LiteRtPartitionEntry:
        return cls(
            op_name=entry.op.name,
            op_kind=entry.op.op,
            supported=entry.supported,
            reason=entry.reason,
            runtime_api=entry.runtime_api,
            mapped_opcodes=entry.mapped_opcodes,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "op_name": self.op_name,
            "op_kind": self.op_kind,
            "supported": self.supported,
            "reason": self.reason,
            "runtime_api": self.runtime_api,
            "mapped_opcodes": list(self.mapped_opcodes),
        }


@dataclass(frozen=True)
class LiteRtPartitionResult:
    backend_id: str
    entries: tuple[LiteRtPartitionEntry, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "entries": [entry.as_dict() for entry in self.entries],
        }


@dataclass(frozen=True)
class LiteRtInvokeResult:
    backend_id: str
    blob: bytes
    descriptor_specs: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    command_buffer_batches: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    tensor_arena_plan: dict[str, Any] = field(default_factory=dict)
    runtime_binding_plan: dict[str, Any] = field(default_factory=dict)
    descriptor_staging_plan: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "blob_bytes": len(self.blob),
            "descriptor_specs": list(self.descriptor_specs),
            "command_buffer_batches": list(self.command_buffer_batches),
            "tensor_arena_plan": self.tensor_arena_plan,
            "runtime_binding_plan": self.runtime_binding_plan,
            "descriptor_staging_plan": self.descriptor_staging_plan,
        }


class E1LiteRtDelegate:
    """Python implementation of the C-style ``E1LiteRtDelegate`` handle."""

    backend_id = BACKEND_ID

    def partition(self, module: StableHloModule) -> LiteRtPartitionResult:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        entries = tuple(
            LiteRtPartitionEntry.from_partition_entry(entry)
            for entry in partition_module(module).entries
        )
        return LiteRtPartitionResult(backend_id=self.backend_id, entries=entries)

    def invoke(self, module: StableHloModule) -> LiteRtInvokeResult:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot invoke delegate on invalid StableHLO subset module: {rendered}"
            )
        partition_report = partition_module(module)
        specs = tuple(_descriptor_spec(op) for op in module.ops)
        command_buffer_batches = tuple(
            batch.as_dict() for batch in partition_report.command_buffer_batches
        )
        tensor_arena_plan = partition_report.tensor_arena_plan.as_dict()
        runtime_binding_plan = partition_report.runtime_binding_plan.as_dict()
        descriptor_staging_plan = partition_report.descriptor_staging_plan.as_dict()
        payload = {
            "schema": SCHEMA,
            "backend_id": self.backend_id,
            "status": STATUS,
            "module": module.name,
            "descriptor_specs": list(specs),
            "command_buffer_batches": list(command_buffer_batches),
            "tensor_arena_plan": tensor_arena_plan,
            "runtime_binding_plan": runtime_binding_plan,
            "descriptor_staging_plan": descriptor_staging_plan,
        }
        blob = json.dumps(payload, sort_keys=True).encode("utf-8")
        return LiteRtInvokeResult(
            backend_id=self.backend_id,
            blob=blob,
            descriptor_specs=specs,
            command_buffer_batches=command_buffer_batches,
            tensor_arena_plan=tensor_arena_plan,
            runtime_binding_plan=runtime_binding_plan,
            descriptor_staging_plan=descriptor_staging_plan,
        )

    def descriptor_command_buffer_image(
        self,
        module: StableHloModule,
        *,
        arena_base: int,
        descriptor_base: int,
        batch_index: int = 0,
    ) -> dict[str, Any]:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot materialize descriptors for invalid StableHLO subset module: {rendered}"
            )
        image = (
            partition_module(module)
            .descriptor_staging_plan.command_buffer_image(
                arena_base=arena_base,
                descriptor_base=descriptor_base,
                batch_index=batch_index,
            )
            .as_dict()
        )
        image["backend_id"] = self.backend_id
        image["module"] = module.name
        return image

    def execution_command_buffer_image(
        self,
        module: StableHloModule,
        *,
        arena_base: int,
        descriptor_base: int,
        execution_batch_index: int,
    ) -> dict[str, Any]:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot materialize descriptors for invalid StableHLO subset module: {rendered}"
            )
        image = (
            partition_module(module)
            .descriptor_staging_plan.execution_command_buffer_image(
                arena_base=arena_base,
                descriptor_base=descriptor_base,
                execution_batch_index=execution_batch_index,
            )
            .as_dict()
        )
        image["backend_id"] = self.backend_id
        image["module"] = module.name
        return image

    def prepared_descriptor_batch(
        self,
        module: StableHloModule,
        *,
        arena_base: int,
        descriptor_base: int,
        batch_index: int = 0,
    ) -> dict[str, Any]:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot prepare descriptors for invalid StableHLO subset module: {rendered}"
            )
        prepared = (
            partition_module(module)
            .prepared_descriptor_batch(
                arena_base=arena_base,
                descriptor_base=descriptor_base,
                batch_index=batch_index,
            )
            .as_dict()
        )
        prepared["backend_id"] = self.backend_id
        prepared["module"] = module.name
        return prepared

    def prepared_descriptor_execution_batch(
        self,
        module: StableHloModule,
        *,
        arena_base: int,
        descriptor_base: int,
        execution_batch_index: int,
    ) -> dict[str, Any]:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot prepare descriptors for invalid StableHLO subset module: {rendered}"
            )
        prepared = (
            partition_module(module)
            .prepared_descriptor_execution_batch(
                arena_base=arena_base,
                descriptor_base=descriptor_base,
                execution_batch_index=execution_batch_index,
            )
            .as_dict()
        )
        prepared["backend_id"] = self.backend_id
        prepared["module"] = module.name
        return prepared

    def prepared_descriptor_execution_batches(
        self,
        module: StableHloModule,
        *,
        arena_base: int,
        descriptor_base: int,
        descriptor_stride_bytes: int,
    ) -> dict[str, Any]:
        if not isinstance(module, StableHloModule):
            raise TypeError("module must be a StableHloModule")
        issues = validate_module(module)
        if issues:
            rendered = "; ".join(f"{issue.op_name}:{issue.code}" for issue in issues)
            raise StableHloValidationError(
                f"cannot prepare descriptors for invalid StableHLO subset module: {rendered}"
            )
        prepared = (
            partition_module(module)
            .prepared_descriptor_execution_batches(
                arena_base=arena_base,
                descriptor_base=descriptor_base,
                descriptor_stride_bytes=descriptor_stride_bytes,
            )
            .as_dict()
        )
        prepared["backend_id"] = self.backend_id
        prepared["module"] = module.name
        return prepared


def e1_litert_delegate_create() -> E1LiteRtDelegate:
    """C entry-point mirror: allocate a delegate handle."""
    return E1LiteRtDelegate()


def e1_litert_delegate_partition(
    delegate: E1LiteRtDelegate, module_json: str | bytes
) -> LiteRtPartitionResult:
    """C entry-point mirror: walk the StableHLO subset module and partition."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    try:
        module = parse_module(module_json)
    except StableHloParseError as exc:
        raise StableHloParseError(str(exc)) from exc
    return delegate.partition(module)


def e1_litert_delegate_invoke(
    delegate: E1LiteRtDelegate, module_json: str | bytes
) -> LiteRtInvokeResult:
    """C entry-point mirror: invoke the delegate against the partitioned subset."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.invoke(module)


def e1_litert_delegate_descriptor_command_buffer_image(
    delegate: E1LiteRtDelegate,
    module_json: str | bytes,
    *,
    arena_base: int,
    descriptor_base: int,
    batch_index: int = 0,
) -> dict[str, Any]:
    """C entry-point mirror: materialize descriptor words for one ready batch."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.descriptor_command_buffer_image(
        module,
        arena_base=arena_base,
        descriptor_base=descriptor_base,
        batch_index=batch_index,
    )


def e1_litert_delegate_execution_command_buffer_image(
    delegate: E1LiteRtDelegate,
    module_json: str | bytes,
    *,
    arena_base: int,
    descriptor_base: int,
    execution_batch_index: int,
) -> dict[str, Any]:
    """C entry-point mirror: materialize descriptor words for one execution sub-batch."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.execution_command_buffer_image(
        module,
        arena_base=arena_base,
        descriptor_base=descriptor_base,
        execution_batch_index=execution_batch_index,
    )


def e1_litert_delegate_prepared_descriptor_batch(
    delegate: E1LiteRtDelegate,
    module_json: str | bytes,
    *,
    arena_base: int,
    descriptor_base: int,
    batch_index: int = 0,
) -> dict[str, Any]:
    """C entry-point mirror: prepare metadata for one descriptor-ready batch."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.prepared_descriptor_batch(
        module,
        arena_base=arena_base,
        descriptor_base=descriptor_base,
        batch_index=batch_index,
    )


def e1_litert_delegate_prepared_descriptor_execution_batch(
    delegate: E1LiteRtDelegate,
    module_json: str | bytes,
    *,
    arena_base: int,
    descriptor_base: int,
    execution_batch_index: int,
) -> dict[str, Any]:
    """C entry-point mirror: prepare metadata for one execution sub-batch."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.prepared_descriptor_execution_batch(
        module,
        arena_base=arena_base,
        descriptor_base=descriptor_base,
        execution_batch_index=execution_batch_index,
    )


def e1_litert_delegate_prepared_descriptor_execution_batches(
    delegate: E1LiteRtDelegate,
    module_json: str | bytes,
    *,
    arena_base: int,
    descriptor_base: int,
    descriptor_stride_bytes: int,
) -> dict[str, Any]:
    """C entry-point mirror: prepare metadata for all execution sub-batches."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")
    module = parse_module(module_json)
    return delegate.prepared_descriptor_execution_batches(
        module,
        arena_base=arena_base,
        descriptor_base=descriptor_base,
        descriptor_stride_bytes=descriptor_stride_bytes,
    )


def e1_litert_delegate_destroy(delegate: E1LiteRtDelegate) -> None:
    """C entry-point mirror: free the delegate handle."""
    if not isinstance(delegate, E1LiteRtDelegate):
        raise TypeError("delegate must be an E1LiteRtDelegate")


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
