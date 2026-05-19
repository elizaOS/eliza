"""StableHLO subset partitioner for the e1 NPU.

The partitioner walks an ``e1_npu_stablehlo`` module, classifies each op as
NPU-supported or CPU-fallback against the runtime contract opcode table, and
emits a structured report. The B-2 ExecuTorch delegate and B-3 LiteRT delegate
both consume this report so they share one supported-set definition.

CLI: ``python3 -m compiler.runtime.e1_npu_partitioner <module.json>`` prints a
JSON report including ``cpu_fallback_percent``.

The supported set is driven by the StableHLO subset validators plus the
opcode + tile-bound table loaded from
``docs/spec-db/e1-npu-runtime-contract.json``. A contract entry must declare
its mapped opcodes and tile shape limit; otherwise the precision is treated as
unsupported. This keeps the partitioner and the runtime contract in lockstep.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

from e1_npu_runtime import CommandBuffer, E1NpuRuntime
from e1_npu_stablehlo import (
    StableHloModule,
    StableHloOp,
    StableHloParseError,
    TensorType,
    parse_module,
    plan_op_lowering,
    validate_op,
)

SCHEMA = "eliza.e1_npu_partition_report.v1"

CONTRACT_PATH = (
    Path(__file__).resolve().parents[2] / "docs" / "spec-db" / "e1-npu-runtime-contract.json"
)


@dataclass(frozen=True)
class SupportEntry:
    """Per-op + precision support record loaded from the runtime contract."""

    source_op: str
    precision: str
    runtime_api: str
    mapped_opcodes: tuple[str, ...]
    tile_limit_m: int
    tile_limit_n: int
    tile_limit_k: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_op": self.source_op,
            "precision": self.precision,
            "runtime_api": self.runtime_api,
            "mapped_opcodes": list(self.mapped_opcodes),
            "tile_limit": {
                "m": self.tile_limit_m,
                "n": self.tile_limit_n,
                "k": self.tile_limit_k,
            },
        }


@dataclass(frozen=True)
class PartitionEntry:
    """Partitioner outcome for a single op walked from a subset module."""

    op: StableHloOp
    supported: bool
    reason: str
    runtime_api: str | None = None
    mapped_opcodes: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "op_name": self.op.name,
            "op_kind": self.op.op,
            "supported": self.supported,
            "reason": self.reason,
            "runtime_api": self.runtime_api,
            "mapped_opcodes": list(self.mapped_opcodes),
        }


@dataclass(frozen=True)
class PartitionCommandBufferBatch:
    """Contiguous supported-op run that fits the local CommandBuffer window."""

    batch_index: int
    op_names: tuple[str, ...]
    runtime_apis: tuple[str, ...]
    descriptor_slots: int
    command_buffer_max_entries: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "batch_index": self.batch_index,
            "op_names": list(self.op_names),
            "runtime_apis": list(self.runtime_apis),
            "descriptor_slots": self.descriptor_slots,
            "command_buffer_max_entries": self.command_buffer_max_entries,
            "claim_boundary": (
                "partitioner_command_buffer_batching_smoke_only_not_dependency_scheduler"
            ),
        }


@dataclass(frozen=True)
class TensorArenaAllocation:
    """Deterministic metadata-only tensor arena allocation."""

    tensor_name: str
    op_name: str
    role: str
    shape: tuple[int, ...]
    dtype: str
    storage_dtype: str
    byte_size: int
    offset: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "tensor_name": self.tensor_name,
            "op_name": self.op_name,
            "role": self.role,
            "shape": list(self.shape),
            "dtype": self.dtype,
            "storage_dtype": self.storage_dtype,
            "byte_size": self.byte_size,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class TensorArenaPlan:
    """Linear tensor arena metadata for delegate preprocessing."""

    allocations: tuple[TensorArenaAllocation, ...]
    total_bytes: int
    alignment_bytes: int = 4

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": "eliza.e1_npu_tensor_arena_plan.v1",
            "alignment_bytes": self.alignment_bytes,
            "total_bytes": self.total_bytes,
            "claim_boundary": ("tensor_arena_metadata_only_not_lifetime_allocator_or_dma_planner"),
            "allocations": [allocation.as_dict() for allocation in self.allocations],
        }


@dataclass(frozen=True)
class RuntimeTensorBinding:
    """Graph-field to tensor-arena binding for one runtime descriptor input/output."""

    graph_field: str
    tensor_name: str
    op_name: str
    role: str
    shape: tuple[int, ...]
    dtype: str
    storage_dtype: str
    byte_size: int
    offset: int

    @classmethod
    def from_allocation(
        cls, graph_field: str, allocation: TensorArenaAllocation
    ) -> RuntimeTensorBinding:
        return cls(
            graph_field=graph_field,
            tensor_name=allocation.tensor_name,
            op_name=allocation.op_name,
            role=allocation.role,
            shape=allocation.shape,
            dtype=allocation.dtype,
            storage_dtype=allocation.storage_dtype,
            byte_size=allocation.byte_size,
            offset=allocation.offset,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "graph_field": self.graph_field,
            "tensor_name": self.tensor_name,
            "op_name": self.op_name,
            "role": self.role,
            "shape": list(self.shape),
            "dtype": self.dtype,
            "storage_dtype": self.storage_dtype,
            "byte_size": self.byte_size,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class RuntimeUnresolvedBinding:
    """Required graph field that cannot yet be mapped to the tensor arena."""

    graph_field: str
    op_name: str
    op_kind: str
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {
            "graph_field": self.graph_field,
            "op_name": self.op_name,
            "op_kind": self.op_kind,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class RuntimeBindingOp:
    """Descriptor binding record for one supported partitioned op."""

    op_name: str
    op_kind: str
    runtime_api: str
    schema: str
    command_buffer_batch_index: int
    inputs: tuple[RuntimeTensorBinding, ...]
    output: RuntimeTensorBinding
    unresolved_inputs: tuple[RuntimeUnresolvedBinding, ...] = ()

    @property
    def descriptor_codegen_ready(self) -> bool:
        return not self.unresolved_inputs

    def as_dict(self) -> dict[str, Any]:
        return {
            "op_name": self.op_name,
            "op_kind": self.op_kind,
            "runtime_api": self.runtime_api,
            "schema": self.schema,
            "command_buffer_batch_index": self.command_buffer_batch_index,
            "descriptor_codegen_ready": self.descriptor_codegen_ready,
            "inputs": [binding.as_dict() for binding in self.inputs],
            "output": self.output.as_dict(),
            "unresolved_inputs": [binding.as_dict() for binding in self.unresolved_inputs],
        }


@dataclass(frozen=True)
class RuntimeBindingPlan:
    """Metadata-only descriptor staging map derived from the partition report."""

    ops: tuple[RuntimeBindingOp, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": "eliza.e1_npu_runtime_binding_plan.v1",
            "claim_boundary": (
                "runtime_binding_metadata_only_not_dma_or_binary_descriptor_codegen"
            ),
            "ready_ops": sum(1 for op in self.ops if op.descriptor_codegen_ready),
            "blocked_ops": sum(1 for op in self.ops if not op.descriptor_codegen_ready),
            "ops": [op.as_dict() for op in self.ops],
        }


@dataclass(frozen=True)
class RuntimeDescriptorInput:
    """Tensor input placement inside a descriptor-streamed scratch span."""

    graph_field: str
    tensor_name: str
    arena_offset: int
    byte_size: int
    scratch_offset: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "graph_field": self.graph_field,
            "tensor_name": self.tensor_name,
            "arena_offset": self.arena_offset,
            "byte_size": self.byte_size,
            "scratch_offset": self.scratch_offset,
        }


@dataclass(frozen=True)
class RuntimeDescriptorStagingOp:
    """Metadata-only descriptor staging template for one runtime op."""

    op_name: str
    runtime_api: str
    command_buffer_batch_index: int
    descriptor_opcode: int | None
    descriptor_opcode_name: str | None
    input_stream_ready: bool
    writeback_ready: bool
    source_arena_offset: int | None
    stream_byte_count: int | None
    scratch_output_offset: int | None
    required_output_bytes: int | None
    output_arena_offset: int | None
    output_allocation_bytes: int | None
    inputs: tuple[RuntimeDescriptorInput, ...]
    mmio_preamble: dict[str, int]
    blocking_reasons: tuple[str, ...]

    @property
    def descriptor_codegen_ready(self) -> bool:
        return self.input_stream_ready and self.writeback_ready and not self.blocking_reasons

    def as_dict(self) -> dict[str, Any]:
        return {
            "op_name": self.op_name,
            "runtime_api": self.runtime_api,
            "command_buffer_batch_index": self.command_buffer_batch_index,
            "descriptor_opcode": self.descriptor_opcode,
            "descriptor_opcode_name": self.descriptor_opcode_name,
            "descriptor_codegen_ready": self.descriptor_codegen_ready,
            "input_stream_ready": self.input_stream_ready,
            "writeback_ready": self.writeback_ready,
            "source_arena_offset": self.source_arena_offset,
            "stream_byte_count": self.stream_byte_count,
            "scratch_output_offset": self.scratch_output_offset,
            "required_output_bytes": self.required_output_bytes,
            "output_arena_offset": self.output_arena_offset,
            "output_allocation_bytes": self.output_allocation_bytes,
            "inputs": [input_binding.as_dict() for input_binding in self.inputs],
            "mmio_preamble": self.mmio_preamble,
            "blocking_reasons": list(self.blocking_reasons),
        }


@dataclass(frozen=True)
class RuntimeDescriptorStagingPlan:
    """Descriptor stream templates derived from runtime bindings."""

    ops: tuple[RuntimeDescriptorStagingOp, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": "eliza.e1_npu_descriptor_staging_plan.v1",
            "claim_boundary": (
                "descriptor_staging_metadata_only_not_binary_codegen_or_dma_runtime"
            ),
            "ready_ops": sum(1 for op in self.ops if op.descriptor_codegen_ready),
            "blocked_ops": sum(1 for op in self.ops if not op.descriptor_codegen_ready),
            "ops": [op.as_dict() for op in self.ops],
        }


@dataclass(frozen=True)
class PartitionReport:
    """Aggregate partitioner report for a subset module."""

    module: str
    entries: tuple[PartitionEntry, ...]

    @property
    def total_ops(self) -> int:
        return len(self.entries)

    @property
    def supported_ops(self) -> int:
        return sum(1 for entry in self.entries if entry.supported)

    @property
    def cpu_fallback_ops(self) -> int:
        return self.total_ops - self.supported_ops

    @property
    def cpu_fallback_percent(self) -> float:
        if not self.total_ops:
            return 0.0
        return 100.0 * self.cpu_fallback_ops / self.total_ops

    @property
    def command_buffer_batches(self) -> tuple[PartitionCommandBufferBatch, ...]:
        batches: list[PartitionCommandBufferBatch] = []
        current: list[PartitionEntry] = []

        def flush() -> None:
            nonlocal current
            while current:
                chunk = current[: CommandBuffer.MAX_ENTRIES]
                del current[: CommandBuffer.MAX_ENTRIES]
                batches.append(
                    PartitionCommandBufferBatch(
                        batch_index=len(batches),
                        op_names=tuple(entry.op.name for entry in chunk),
                        runtime_apis=tuple(entry.runtime_api or "" for entry in chunk),
                        descriptor_slots=len(chunk),
                        command_buffer_max_entries=CommandBuffer.MAX_ENTRIES,
                    )
                )

        for entry in self.entries:
            if entry.supported:
                current.append(entry)
            else:
                flush()
        flush()
        return tuple(batches)

    @property
    def tensor_arena_plan(self) -> TensorArenaPlan:
        allocations: list[TensorArenaAllocation] = []
        offset = 0
        for entry in self.entries:
            for role, tensor_type in _op_tensor_types(entry.op):
                byte_size = _allocation_nbytes(entry.op, role, tensor_type)
                offset = _align(offset, 4)
                allocations.append(
                    TensorArenaAllocation(
                        tensor_name=f"{entry.op.name}.{role}",
                        op_name=entry.op.name,
                        role=role,
                        shape=tensor_type.shape,
                        dtype=tensor_type.dtype,
                        storage_dtype=_allocation_storage_dtype(entry.op, role),
                        byte_size=byte_size,
                        offset=offset,
                    )
                )
                offset += byte_size
        return TensorArenaPlan(allocations=tuple(allocations), total_bytes=_align(offset, 4))

    @property
    def runtime_binding_plan(self) -> RuntimeBindingPlan:
        allocations = {
            allocation.tensor_name: allocation for allocation in self.tensor_arena_plan.allocations
        }
        batch_indexes: dict[str, int] = {}
        for batch in self.command_buffer_batches:
            for op_name in batch.op_names:
                batch_indexes[op_name] = batch.batch_index

        ops: list[RuntimeBindingOp] = []
        for entry in self.entries:
            if not entry.supported:
                continue
            plan = plan_op_lowering(entry.op)
            inputs: list[RuntimeTensorBinding] = []
            unresolved_inputs: list[RuntimeUnresolvedBinding] = []
            for graph_field in plan.required_graph_fields:
                tensor_name = f"{entry.op.name}.{_binding_role(entry.op.op, graph_field)}"
                allocation = allocations.get(tensor_name)
                if allocation is None:
                    unresolved_inputs.append(
                        RuntimeUnresolvedBinding(
                            graph_field=graph_field,
                            op_name=entry.op.name,
                            op_kind=entry.op.op,
                            reason="no_tensor_arena_allocation_for_required_graph_field",
                        )
                    )
                    continue
                inputs.append(RuntimeTensorBinding.from_allocation(graph_field, allocation))
            output_allocation = allocations[f"{entry.op.name}.result"]
            ops.append(
                RuntimeBindingOp(
                    op_name=entry.op.name,
                    op_kind=entry.op.op,
                    runtime_api=plan.runtime_api,
                    schema=plan.schema,
                    command_buffer_batch_index=batch_indexes[entry.op.name],
                    inputs=tuple(inputs),
                    output=RuntimeTensorBinding.from_allocation("result", output_allocation),
                    unresolved_inputs=tuple(unresolved_inputs),
                )
            )
        return RuntimeBindingPlan(ops=tuple(ops))

    @property
    def descriptor_staging_plan(self) -> RuntimeDescriptorStagingPlan:
        entries = {entry.op.name: entry for entry in self.entries}
        ops: list[RuntimeDescriptorStagingOp] = []
        for binding in self.runtime_binding_plan.ops:
            entry = entries[binding.op_name]
            plan = plan_op_lowering(entry.op)
            ops.append(_descriptor_staging_op(entry.op, plan.lowering_precision, binding))
        return RuntimeDescriptorStagingPlan(ops=tuple(ops))

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "module": self.module,
            "total_ops": self.total_ops,
            "supported_ops": self.supported_ops,
            "cpu_fallback_ops": self.cpu_fallback_ops,
            "cpu_fallback_percent": self.cpu_fallback_percent,
            "command_buffer_max_entries": CommandBuffer.MAX_ENTRIES,
            "command_buffer_batches": [batch.as_dict() for batch in self.command_buffer_batches],
            "tensor_arena_plan": self.tensor_arena_plan.as_dict(),
            "runtime_binding_plan": self.runtime_binding_plan.as_dict(),
            "descriptor_staging_plan": self.descriptor_staging_plan.as_dict(),
            "entries": [entry.as_dict() for entry in self.entries],
        }


_OP_CONTRACT_KEYS: dict[str, str] = {
    "stablehlo.dot_general": "matmul_lowering_smoke",
    "stablehlo.dot": "matmul_lowering_smoke",
    "stablehlo.batch_matmul": "matmul_lowering_smoke",
    "stablehlo.convolution": "conv2d_lowering_smoke",
    "stablehlo.add": "residual_add_lowering_smoke",
    "stablehlo.residual_add": "residual_add_lowering_smoke",
    "stablehlo.bias_add": "bias_add_lowering_smoke",
    "stablehlo.mlp": "mlp_lowering_smoke",
    "stablehlo.attention_qk": "attention_qk_lowering_smoke",
    "stablehlo.attention_av": "attention_av_lowering_smoke",
    "stablehlo.transformer_block": "transformer_block_lowering_smoke",
}

_PRECISION_OVERRIDES: dict[str, str] = {
    "sparse_int4_2_4": "sparse_int4_matmul_lowering_smoke",
    "int4_group_scaled": "group_scaled_int4_matmul_lowering_smoke",
    "group_scaled_int4": "group_scaled_int4_matmul_lowering_smoke",
    "w4a8_gs": "group_scaled_int4_matmul_lowering_smoke",
    "int2": "int2_matmul_lowering_smoke",
    "bitnet_int2": "int2_matmul_lowering_smoke",
    "fp8_e4m3": "fp8_matmul_lowering_smoke",
    "fp16": "fp16_matmul_lowering_smoke",
    "float16": "fp16_matmul_lowering_smoke",
    "bf16": "bf16_matmul_lowering_smoke",
    "bfloat16": "bf16_matmul_lowering_smoke",
}


def load_support_table(contract_path: Path | None = None) -> dict[tuple[str, str], SupportEntry]:
    """Load the supported (source_op, precision) -> SupportEntry table."""
    path = contract_path or CONTRACT_PATH
    contract = json.loads(path.read_text(encoding="utf-8"))
    table: dict[tuple[str, str], SupportEntry] = {}
    for source_op, contract_key in _OP_CONTRACT_KEYS.items():
        entry = contract.get(contract_key)
        if not isinstance(entry, dict):
            continue
        for precision in entry.get("supported_precisions", []):
            override_key = _PRECISION_OVERRIDES.get(precision)
            resolved = contract.get(override_key) if override_key else entry
            if not isinstance(resolved, dict):
                resolved = entry
            tile_limit = _resolve_tile_limit(resolved)
            table[(source_op, precision)] = SupportEntry(
                source_op=source_op,
                precision=precision,
                runtime_api=str(resolved.get("runtime_api", "")),
                mapped_opcodes=tuple(resolved.get("mapped_opcodes", [])),
                tile_limit_m=tile_limit[0],
                tile_limit_n=tile_limit[1],
                tile_limit_k=tile_limit[2],
            )
    for precision, override_key in _PRECISION_OVERRIDES.items():
        override = contract.get(override_key)
        if not isinstance(override, dict):
            continue
        tile_limit = _resolve_tile_limit(override)
        for source_op in (
            "stablehlo.dot_general",
            "stablehlo.dot",
            "stablehlo.batch_matmul",
        ):
            table.setdefault(
                (source_op, precision),
                SupportEntry(
                    source_op=source_op,
                    precision=precision,
                    runtime_api=str(override.get("runtime_api", "")),
                    mapped_opcodes=tuple(override.get("mapped_opcodes", [])),
                    tile_limit_m=tile_limit[0],
                    tile_limit_n=tile_limit[1],
                    tile_limit_k=tile_limit[2],
                ),
            )
    return table


def partition_module(
    module: StableHloModule,
    *,
    support_table: dict[tuple[str, str], SupportEntry] | None = None,
) -> PartitionReport:
    """Walk a parsed module and emit the per-op support decision report."""
    table = support_table if support_table is not None else load_support_table()
    entries: list[PartitionEntry] = []
    for op in module.ops:
        entries.append(_classify_op(op, table))
    return PartitionReport(module=module.name, entries=tuple(entries))


def _classify_op(op: StableHloOp, table: dict[tuple[str, str], SupportEntry]) -> PartitionEntry:
    issues = validate_op(op)
    precision = getattr(op, "precision", None)
    if not isinstance(precision, str):
        return PartitionEntry(
            op=op,
            supported=False,
            reason="OP_HAS_NO_PRECISION_FIELD",
        )
    key = (op.op, precision)
    support = table.get(key)
    if support is None:
        return PartitionEntry(
            op=op,
            supported=False,
            reason=f"NO_CONTRACT_ENTRY_FOR_{op.op}_{precision}",
        )
    if issues:
        first = issues[0]
        return PartitionEntry(
            op=op,
            supported=False,
            reason=first.code,
            runtime_api=support.runtime_api,
            mapped_opcodes=support.mapped_opcodes,
        )
    plan = plan_op_lowering(op)
    return PartitionEntry(
        op=op,
        supported=True,
        reason="SUPPORTED",
        runtime_api=plan.runtime_api,
        mapped_opcodes=support.mapped_opcodes,
    )


def _resolve_tile_limit(entry: dict[str, Any]) -> tuple[int, int, int]:
    tile_shape = entry.get("tile_shape_limit")
    if isinstance(tile_shape, dict):
        return (
            int(tile_shape.get("m", 0)),
            int(tile_shape.get("n", 0)),
            int(tile_shape.get("k", 0)),
        )
    return (3, 3, 7)


def _op_tensor_types(op: StableHloOp) -> tuple[tuple[str, TensorType], ...]:
    tensors: list[tuple[str, TensorType]] = []
    for field_info in fields(op):
        value = getattr(op, field_info.name)
        if isinstance(value, TensorType):
            role = (
                "result"
                if field_info.name == "result_type"
                else field_info.name.removesuffix("_type")
            )
            tensors.append((role, value))
    return tuple(tensors)


def _binding_role(op_kind: str, graph_field: str) -> str:
    aliases = {
        ("stablehlo.attention_av", "attention"): "weights",
    }
    return aliases.get((op_kind, graph_field), graph_field)


def _descriptor_staging_op(
    op: StableHloOp, lowering_precision: str, binding: RuntimeBindingOp
) -> RuntimeDescriptorStagingOp:
    opcode, opcode_name = _descriptor_opcode(lowering_precision)
    blocking_reasons: list[str] = []
    if binding.unresolved_inputs:
        blocking_reasons.append("unresolved_required_graph_fields")
    if binding.runtime_api != "lower_matmul_smoke":
        blocking_reasons.append("runtime_api_not_supported_by_descriptor_staging_plan")
    if opcode is None or opcode_name is None:
        blocking_reasons.append("precision_not_supported_by_descriptor_staging_plan")
    if len(binding.inputs) < 2:
        blocking_reasons.append("descriptor_staging_requires_two_input_bindings")

    if blocking_reasons:
        return RuntimeDescriptorStagingOp(
            op_name=binding.op_name,
            runtime_api=binding.runtime_api,
            command_buffer_batch_index=binding.command_buffer_batch_index,
            descriptor_opcode=opcode,
            descriptor_opcode_name=opcode_name,
            input_stream_ready=False,
            writeback_ready=False,
            source_arena_offset=None,
            stream_byte_count=None,
            scratch_output_offset=None,
            required_output_bytes=None,
            output_arena_offset=binding.output.offset,
            output_allocation_bytes=binding.output.byte_size,
            inputs=(),
            mmio_preamble={},
            blocking_reasons=tuple(blocking_reasons),
        )

    source_arena_offset = min(input_binding.offset for input_binding in binding.inputs)
    source_end = max(
        input_binding.offset + input_binding.byte_size for input_binding in binding.inputs
    )
    stream_byte_count = _align(source_end - source_arena_offset, 4)
    descriptor_inputs = tuple(
        RuntimeDescriptorInput(
            graph_field=input_binding.graph_field,
            tensor_name=input_binding.tensor_name,
            arena_offset=input_binding.offset,
            byte_size=input_binding.byte_size,
            scratch_offset=input_binding.offset - source_arena_offset,
        )
        for input_binding in binding.inputs
    )
    input_stream_ready = (
        source_arena_offset >= 0
        and source_arena_offset & 0x3 == 0
        and 0 < stream_byte_count <= 63
        and stream_byte_count & 0x3 == 0
    )
    if not input_stream_ready:
        blocking_reasons.append("input_stream_span_not_representable_by_descriptor_abi")

    shape = _matmul_shape(op)
    if shape is None:
        blocking_reasons.append("op_shape_not_supported_by_descriptor_staging_plan")
        required_output_bytes = None
        scratch_output_offset = None
        mmio_preamble: dict[str, int] = {}
    else:
        m, n, k = shape
        required_output_bytes = _align(m * n * 4, 4)
        scratch_output_offset = _align(stream_byte_count, 4)
        mmio_preamble = {
            "GEMM_CFG": m | (n << 8) | (k << 16),
            "GEMM_BASE": _scratch_offset(descriptor_inputs, "lhs")
            | (_scratch_offset(descriptor_inputs, "rhs") << 8)
            | (scratch_output_offset << 16),
            "GEMM_STRIDE": k | (n << 8) | (n * 4 << 16),
        }
        if scratch_output_offset + required_output_bytes > E1NpuRuntime.SCRATCH_BYTES:
            blocking_reasons.append("scratch_layout_exceeds_64_byte_descriptor_window")

    writeback_ready = (
        required_output_bytes is not None
        and binding.output.byte_size >= required_output_bytes
        and binding.output.offset & 0x3 == 0
    )
    if not writeback_ready:
        blocking_reasons.append("output_arena_allocation_not_descriptor_writeback_sized")

    return RuntimeDescriptorStagingOp(
        op_name=binding.op_name,
        runtime_api=binding.runtime_api,
        command_buffer_batch_index=binding.command_buffer_batch_index,
        descriptor_opcode=opcode,
        descriptor_opcode_name=opcode_name,
        input_stream_ready=input_stream_ready,
        writeback_ready=writeback_ready,
        source_arena_offset=source_arena_offset,
        stream_byte_count=stream_byte_count,
        scratch_output_offset=scratch_output_offset,
        required_output_bytes=required_output_bytes,
        output_arena_offset=binding.output.offset,
        output_allocation_bytes=binding.output.byte_size,
        inputs=descriptor_inputs,
        mmio_preamble=mmio_preamble,
        blocking_reasons=tuple(blocking_reasons),
    )


def _descriptor_opcode(lowering_precision: str) -> tuple[int | None, str | None]:
    if lowering_precision == "int8":
        return E1NpuRuntime.OP_GEMM_S8, "OP_GEMM_S8"
    if lowering_precision == "int4":
        return E1NpuRuntime.OP_GEMM_S4, "OP_GEMM_S4"
    return None, None


def _matmul_shape(op: StableHloOp) -> tuple[int, int, int] | None:
    lhs_type = getattr(op, "lhs_type", None)
    rhs_type = getattr(op, "rhs_type", None)
    if not isinstance(lhs_type, TensorType) or not isinstance(rhs_type, TensorType):
        return None
    if len(lhs_type.shape) != 2 or len(rhs_type.shape) != 2:
        return None
    m, k = lhs_type.shape
    rhs_k, n = rhs_type.shape
    if k != rhs_k:
        return None
    return m, n, k


def _scratch_offset(inputs: tuple[RuntimeDescriptorInput, ...], graph_field: str) -> int:
    for input_binding in inputs:
        if input_binding.graph_field == graph_field:
            return input_binding.scratch_offset
    return 0


def _tensor_type_nbytes(tensor_type: TensorType) -> int:
    elements = 1
    for dimension in tensor_type.shape:
        elements *= dimension
    bits_per_element = {
        "int2": 2,
        "bitnet_int2": 2,
        "int4": 4,
        "sparse_int4_2_4": 4,
        "int4_group_scaled": 4,
        "group_scaled_int4": 4,
        "w4a8_gs": 4,
        "int8": 8,
        "fp8_e4m3": 8,
        "fp16": 16,
        "float16": 16,
        "bf16": 16,
        "bfloat16": 16,
    }.get(tensor_type.dtype, 8)
    return max(1, (elements * bits_per_element + 7) // 8)


def _allocation_nbytes(op: StableHloOp, role: str, tensor_type: TensorType) -> int:
    if _allocation_storage_dtype(op, role) == "int32_accumulator":
        elements = 1
        for dimension in tensor_type.shape:
            elements *= dimension
        return elements * 4
    return _tensor_type_nbytes(tensor_type)


def _allocation_storage_dtype(op: StableHloOp, role: str) -> str:
    if role == "result" and _matmul_shape(op) is not None:
        precision = getattr(op, "precision", None)
        if precision in {"int8", "int4"}:
            return "int32_accumulator"
    return "logical"


def _align(value: int, alignment: int) -> int:
    return ((value + alignment - 1) // alignment) * alignment


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="e1_npu_partitioner")
    parser.add_argument(
        "module_path",
        type=Path,
        help="path to a serialised StableHLO subset module (JSON or YAML)",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=None,
        help="optional override for the runtime contract path",
    )
    args = parser.parse_args(argv)

    payload = args.module_path.read_text(encoding="utf-8")
    try:
        module = parse_module(payload)
    except StableHloParseError as exc:
        print(f"FAIL: parse error: {exc}", file=sys.stderr)
        return 2
    report = partition_module(
        module,
        support_table=load_support_table(args.contract) if args.contract else None,
    )
    json.dump(report.as_dict(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
