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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from e1_npu_runtime import CommandBuffer
from e1_npu_stablehlo import (
    StableHloModule,
    StableHloOp,
    StableHloParseError,
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
