"""Tests for the StableHLO subset partitioner (B-5).

The partitioner consumes the dataclass subset from ``e1_npu_stablehlo`` and
maps each op to ``supported`` / ``cpu_fallback`` based on the runtime contract
opcode + tile-bound table. ExecuTorch (B-2) and LiteRT (B-3) delegates share
this report so both backends agree on the same supported-set.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_npu_partitioner import (
    PartitionCommandBufferBatch,
    PartitionEntry,
    PartitionReport,
    RuntimeBindingPlan,
    RuntimeDescriptorBatch,
    RuntimeDescriptorCommandBufferImage,
    RuntimeDescriptorExecutionBatch,
    RuntimeDescriptorStagingPlan,
    RuntimePreparedDescriptorBatch,
    SupportEntry,
    TensorArenaPlan,
    load_support_table,
    partition_module,
)
from e1_npu_stablehlo import parse_module


def _dot_payload(precision: str = "int8") -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{precision}_dot_smoke",
        "ops": [
            {
                "op": "stablehlo.dot_general",
                "name": "dot0",
                "lhs_type": {"shape": [2, 3], "dtype": precision},
                "rhs_type": {"shape": [3, 2], "dtype": precision},
                "result_type": {"shape": [2, 2], "dtype": precision},
                "precision": precision,
            }
        ],
    }


def _conv_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "conv_smoke",
        "ops": [
            {
                "op": "stablehlo.convolution",
                "name": "conv0",
                "input_type": {"shape": [1, 3, 3, 1], "dtype": "int8"},
                "filter_type": {"shape": [2, 2, 1, 2], "dtype": "int8"},
                "result_type": {"shape": [1, 2, 2, 2], "dtype": "int8"},
                "precision": "int8",
                "padding": "VALID",
                "stride": 1,
                "dilation": 1,
            }
        ],
    }


def _mixed_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "mixed",
        "ops": [
            _dot_payload("int8")["ops"][0] | {"name": "dot_supported"},
            {
                "op": "stablehlo.dot_general",
                "name": "dot_oversize",
                "lhs_type": {"shape": [4, 7], "dtype": "int8"},
                "rhs_type": {"shape": [7, 2], "dtype": "int8"},
                "result_type": {"shape": [4, 2], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }


def _many_dots_payload(count: int) -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": f"{count}_dot_command_buffer_smoke",
        "ops": [
            _dot_payload("int8")["ops"][0] | {"name": f"dot_{index}"} for index in range(count)
        ],
    }


def _mismatched_dot_batch_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "mismatched_dot_command_buffer_smoke",
        "ops": [
            _dot_payload("int8")["ops"][0] | {"name": "dot0"},
            {
                "op": "stablehlo.dot_general",
                "name": "dot1",
                "lhs_type": {"shape": [2, 2], "dtype": "int8"},
                "rhs_type": {"shape": [2, 3], "dtype": "int8"},
                "result_type": {"shape": [2, 3], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }


def _dot_add_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "dot_add_command_buffer_smoke",
        "ops": [
            _dot_payload("int8")["ops"][0],
            {
                "op": "stablehlo.add",
                "name": "add0",
                "lhs_type": {"shape": [2, 2], "dtype": "int8"},
                "rhs_type": {"shape": [2, 2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }


def test_load_support_table_includes_int8_and_int4_dot_entries() -> None:
    table = load_support_table()

    int8_entry = table[("stablehlo.dot_general", "int8")]
    int4_entry = table[("stablehlo.dot_general", "int4")]

    assert isinstance(int8_entry, SupportEntry)
    assert int8_entry.runtime_api == "lower_matmul_smoke"
    assert "GEMM_S8" in int8_entry.mapped_opcodes
    assert int8_entry.tile_limit_m == 3
    assert int8_entry.tile_limit_n == 3
    assert int8_entry.tile_limit_k == 7
    assert int4_entry.runtime_api == "lower_matmul_smoke"
    assert "GEMM_S4" in int4_entry.mapped_opcodes


def test_load_support_table_includes_specialised_precision_overrides() -> None:
    table = load_support_table()

    assert ("stablehlo.dot_general", "int2") in table
    assert ("stablehlo.dot_general", "fp8_e4m3") in table
    assert ("stablehlo.dot_general", "sparse_int4_2_4") in table
    int2 = table[("stablehlo.dot_general", "int2")]
    assert int2.runtime_api == "lower_int2_matmul_smoke"
    assert "DOT16_S2" in int2.mapped_opcodes


def test_partition_module_marks_supported_dot_general() -> None:
    module = parse_module(_dot_payload("int8"))
    report = partition_module(module)

    assert isinstance(report, PartitionReport)
    assert report.total_ops == 1
    assert report.supported_ops == 1
    assert report.cpu_fallback_ops == 0
    assert report.cpu_fallback_percent == 0.0
    entry = report.entries[0]
    assert isinstance(entry, PartitionEntry)
    assert entry.supported is True
    assert entry.reason == "SUPPORTED"
    assert entry.runtime_api == "lower_matmul_smoke"


def test_partition_module_marks_convolution_supported() -> None:
    module = parse_module(_conv_payload())
    report = partition_module(module)

    assert report.supported_ops == 1
    assert report.entries[0].runtime_api == "lower_conv2d_smoke"


def test_partition_module_falls_back_on_tile_bound_violation() -> None:
    module = parse_module(_mixed_payload())
    report = partition_module(module)

    assert report.total_ops == 2
    assert report.supported_ops == 1
    assert report.cpu_fallback_ops == 1
    assert report.cpu_fallback_percent == 50.0
    fallback = next(entry for entry in report.entries if not entry.supported)
    assert fallback.op.name == "dot_oversize"
    assert fallback.reason.startswith("TILE_")
    assert [batch.op_names for batch in report.command_buffer_batches] == [("dot_supported",)]


def test_partition_module_emits_report_dict_with_cpu_fallback_metric() -> None:
    module = parse_module(_mixed_payload())
    report = partition_module(module)

    payload = report.as_dict()
    assert payload["schema"] == "eliza.e1_npu_partition_report.v1"
    assert payload["module"] == "mixed"
    assert payload["cpu_fallback_percent"] == 50.0
    assert payload["command_buffer_max_entries"] == 7
    assert payload["command_buffer_batches"][0]["op_names"] == ["dot_supported"]
    assert payload["tensor_arena_plan"]["schema"] == "eliza.e1_npu_tensor_arena_plan.v1"
    assert payload["tensor_arena_plan"]["total_bytes"] > 0
    assert payload["runtime_binding_plan"]["schema"] == "eliza.e1_npu_runtime_binding_plan.v1"
    assert payload["runtime_binding_plan"]["ops"][0]["op_name"] == "dot_supported"
    assert payload["entries"][0]["op_name"] == "dot_supported"


def test_partition_report_groups_contiguous_supported_ops_into_command_buffer_batches() -> None:
    module = parse_module(_many_dots_payload(8))
    report = partition_module(module)

    batches = report.command_buffer_batches

    assert all(isinstance(batch, PartitionCommandBufferBatch) for batch in batches)
    assert [batch.descriptor_slots for batch in batches] == [7, 1]
    assert batches[0].op_names == tuple(f"dot_{index}" for index in range(7))
    assert batches[1].op_names == ("dot_7",)
    assert batches[0].runtime_apis == ("lower_matmul_smoke",) * 7
    assert batches[0].command_buffer_max_entries == 7


def test_partition_report_emits_deterministic_tensor_arena_plan() -> None:
    module = parse_module(_dot_payload("int8"))
    report = partition_module(module)

    arena = report.tensor_arena_plan

    assert isinstance(arena, TensorArenaPlan)
    assert arena.alignment_bytes == 4
    assert arena.total_bytes == 32
    assert [allocation.as_dict() for allocation in arena.allocations] == [
        {
            "tensor_name": "dot0.result",
            "op_name": "dot0",
            "role": "result",
            "shape": [2, 2],
            "dtype": "int8",
            "storage_dtype": "int32_accumulator",
            "byte_size": 16,
            "offset": 0,
        },
        {
            "tensor_name": "dot0.lhs",
            "op_name": "dot0",
            "role": "lhs",
            "shape": [2, 3],
            "dtype": "int8",
            "storage_dtype": "logical",
            "byte_size": 6,
            "offset": 16,
        },
        {
            "tensor_name": "dot0.rhs",
            "op_name": "dot0",
            "role": "rhs",
            "shape": [3, 2],
            "dtype": "int8",
            "storage_dtype": "logical",
            "byte_size": 6,
            "offset": 24,
        },
    ]


def test_partition_report_tensor_arena_uses_packed_low_precision_sizes() -> None:
    module = parse_module(_dot_payload("int4"))
    arena = partition_module(module).tensor_arena_plan

    assert arena.total_bytes == 24
    assert [allocation.byte_size for allocation in arena.allocations] == [16, 3, 3]
    assert arena.allocations[0].storage_dtype == "int32_accumulator"


def test_partition_report_emits_runtime_binding_plan_from_arena_offsets() -> None:
    module = parse_module(_dot_payload("int8"))
    report = partition_module(module)

    binding_plan = report.runtime_binding_plan

    assert isinstance(binding_plan, RuntimeBindingPlan)
    assert binding_plan.as_dict() == {
        "schema": "eliza.e1_npu_runtime_binding_plan.v1",
        "claim_boundary": "runtime_binding_metadata_only_not_dma_or_binary_descriptor_codegen",
        "ready_ops": 1,
        "blocked_ops": 0,
        "ops": [
            {
                "op_name": "dot0",
                "op_kind": "stablehlo.dot_general",
                "runtime_api": "lower_matmul_smoke",
                "schema": "eliza.e1_npu_matmul_smoke.v1",
                "command_buffer_batch_index": 0,
                "descriptor_codegen_ready": True,
                "inputs": [
                    {
                        "graph_field": "lhs",
                        "tensor_name": "dot0.lhs",
                        "op_name": "dot0",
                        "role": "lhs",
                        "shape": [2, 3],
                        "dtype": "int8",
                        "storage_dtype": "logical",
                        "byte_size": 6,
                        "offset": 16,
                    },
                    {
                        "graph_field": "rhs",
                        "tensor_name": "dot0.rhs",
                        "op_name": "dot0",
                        "role": "rhs",
                        "shape": [3, 2],
                        "dtype": "int8",
                        "storage_dtype": "logical",
                        "byte_size": 6,
                        "offset": 24,
                    },
                ],
                "output": {
                    "graph_field": "result",
                    "tensor_name": "dot0.result",
                    "op_name": "dot0",
                    "role": "result",
                    "shape": [2, 2],
                    "dtype": "int8",
                    "storage_dtype": "int32_accumulator",
                    "byte_size": 16,
                    "offset": 0,
                },
                "unresolved_inputs": [],
            }
        ],
    }


def test_partition_report_runtime_binding_plan_records_unresolved_metadata_fields() -> None:
    module = parse_module(_dot_payload("sparse_int4_2_4"))
    report = partition_module(module)

    payload = report.runtime_binding_plan.as_dict()
    op = payload["ops"][0]

    assert payload["ready_ops"] == 0
    assert payload["blocked_ops"] == 1
    assert op["runtime_api"] == "lower_sparse_int4_matmul_smoke"
    assert op["descriptor_codegen_ready"] is False
    assert [binding["graph_field"] for binding in op["inputs"]] == ["lhs"]
    assert op["unresolved_inputs"] == [
        {
            "graph_field": "rhs_nonzero",
            "op_name": "dot0",
            "op_kind": "stablehlo.dot_general",
            "reason": "no_tensor_arena_allocation_for_required_graph_field",
        },
        {
            "graph_field": "rhs_positions",
            "op_name": "dot0",
            "op_kind": "stablehlo.dot_general",
            "reason": "no_tensor_arena_allocation_for_required_graph_field",
        },
    ]


def test_partition_report_emits_descriptor_staging_plan_for_ready_input_streams() -> None:
    module = parse_module(_dot_payload("int8"))
    report = partition_module(module)

    staging_plan = report.descriptor_staging_plan
    op = staging_plan.as_dict()["ops"][0]

    assert isinstance(staging_plan, RuntimeDescriptorStagingPlan)
    assert staging_plan.as_dict()["schema"] == "eliza.e1_npu_descriptor_staging_plan.v1"
    assert staging_plan.as_dict()["ready_ops"] == 1
    assert staging_plan.as_dict()["blocked_ops"] == 0
    assert all(
        isinstance(batch, RuntimeDescriptorBatch) for batch in staging_plan.descriptor_batches
    )
    assert staging_plan.as_dict()["descriptor_batches"] == [
        {
            "batch_index": 0,
            "op_names": ["dot0"],
            "descriptor_slots": 1,
            "descriptor_codegen_ready": True,
            "blocked_ops": [],
        }
    ]
    assert op["descriptor_opcode_name"] == "OP_GEMM_S8"
    assert op["descriptor_opcode"] == 8
    assert op["input_stream_ready"] is True
    assert op["writeback_ready"] is True
    assert op["descriptor_codegen_ready"] is True
    assert op["source_arena_offset"] == 16
    assert op["stream_byte_count"] == 16
    assert op["scratch_output_offset"] == 16
    assert op["required_output_bytes"] == 16
    assert op["output_arena_offset"] == 0
    assert op["output_allocation_bytes"] == 16
    assert op["inputs"] == [
        {
            "graph_field": "lhs",
            "tensor_name": "dot0.lhs",
            "arena_offset": 16,
            "byte_size": 6,
            "scratch_offset": 0,
        },
        {
            "graph_field": "rhs",
            "tensor_name": "dot0.rhs",
            "arena_offset": 24,
            "byte_size": 6,
            "scratch_offset": 8,
        },
    ]
    assert op["mmio_preamble"] == {
        "GEMM_CFG": 2 | (2 << 8) | (3 << 16),
        "GEMM_BASE": 0 | (8 << 8) | (16 << 16),
        "GEMM_STRIDE": 3 | (2 << 8) | (8 << 16),
    }
    assert op["descriptor_word_template"] == {
        "word0": 0xD0000108,
        "word1": "arena_base + source_arena_offset",
        "word1_arena_offset": 16,
        "word2": "arena_base + output_arena_offset",
        "word2_arena_offset": 0,
        "word3": 0,
        "requires_arena_base": True,
    }
    assert staging_plan.ops[0].descriptor_words(0x8000_0000) == (
        0xD0000108,
        0x8000_0010,
        0x8000_0000,
        0,
    )
    assert op["blocking_reasons"] == []


def test_partition_report_descriptor_word_materialization_is_fail_closed() -> None:
    ready_op = partition_module(parse_module(_dot_payload("int8"))).descriptor_staging_plan.ops[0]
    blocked_op = partition_module(
        parse_module(_dot_payload("sparse_int4_2_4"))
    ).descriptor_staging_plan.ops[0]

    with pytest.raises(ValueError, match="32-bit aligned"):
        ready_op.descriptor_words(0x8000_0002)
    with pytest.raises(ValueError, match="not codegen-ready"):
        blocked_op.descriptor_words(0x8000_0000)


def test_descriptor_staging_plan_materializes_ready_command_buffer_image() -> None:
    staging_plan = partition_module(parse_module(_many_dots_payload(2))).descriptor_staging_plan

    image = staging_plan.command_buffer_image(
        arena_base=0x8000_0000,
        descriptor_base=0x2000,
        batch_index=0,
    )

    assert isinstance(image, RuntimeDescriptorCommandBufferImage)
    assert image.as_dict() == {
        "schema": "eliza.e1_npu_descriptor_command_buffer_image.v1",
        "claim_boundary": (
            "descriptor_command_buffer_image_only_not_dma_submission_or_tensor_population"
        ),
        "batch_index": 0,
        "arena_base": 0x8000_0000,
        "descriptor_base": 0x2000,
        "op_names": ["dot_0", "dot_1"],
        "descriptor_words": [
            [0xD0000108, 0x8000_0010, 0x8000_0000, 0],
            [0xD0000108, 0x8000_0030, 0x8000_0020, 0],
        ],
        "descriptor_image": {
            "0x00002000": 0xD0000108,
            "0x00002004": 0x8000_0010,
            "0x00002008": 0x8000_0000,
            "0x0000200c": 0,
            "0x00002010": 0xD0000108,
            "0x00002014": 0x8000_0030,
            "0x00002018": 0x8000_0020,
            "0x0000201c": 0,
        },
        "submission": {"base": 0x2000, "head": 0, "tail": 2},
    }


def test_descriptor_staging_plan_command_buffer_image_is_fail_closed() -> None:
    mixed_plan = partition_module(parse_module(_dot_add_payload())).descriptor_staging_plan
    ready_plan = partition_module(parse_module(_dot_payload("int8"))).descriptor_staging_plan
    mismatched_plan = partition_module(
        parse_module(_mismatched_dot_batch_payload())
    ).descriptor_staging_plan

    with pytest.raises(ValueError, match="32-bit aligned"):
        ready_plan.command_buffer_image(arena_base=0x8000_0000, descriptor_base=0x2002)
    with pytest.raises(ValueError, match="non-codegen-ready ops: add0"):
        mixed_plan.command_buffer_image(arena_base=0x8000_0000, descriptor_base=0x2000)
    with pytest.raises(ValueError, match="incompatible GEMM MMIO preambles"):
        mismatched_plan.command_buffer_image(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
    with pytest.raises(ValueError, match="no descriptor staging ops"):
        ready_plan.command_buffer_image(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
            batch_index=1,
        )


def test_descriptor_staging_plan_splits_execution_batches_by_mmio_preamble() -> None:
    staging_plan = partition_module(
        parse_module(_mismatched_dot_batch_payload())
    ).descriptor_staging_plan

    execution_batches = staging_plan.descriptor_execution_batches

    assert all(isinstance(batch, RuntimeDescriptorExecutionBatch) for batch in execution_batches)
    assert [batch.as_dict() for batch in execution_batches] == [
        {
            "batch_index": 0,
            "execution_batch_index": 0,
            "op_names": ["dot0"],
            "descriptor_slots": 1,
            "descriptor_codegen_ready": True,
            "shared_mmio_preamble": {
                "GEMM_CFG": 0x0003_0202,
                "GEMM_BASE": 0x0010_0800,
                "GEMM_STRIDE": 0x0008_0203,
            },
            "blocked_ops": [],
        },
        {
            "batch_index": 0,
            "execution_batch_index": 1,
            "op_names": ["dot1"],
            "descriptor_slots": 1,
            "descriptor_codegen_ready": True,
            "shared_mmio_preamble": {
                "GEMM_CFG": 0x0002_0302,
                "GEMM_BASE": 0x000C_0400,
                "GEMM_STRIDE": 0x000C_0302,
            },
            "blocked_ops": [],
        },
    ]
    assert staging_plan.as_dict()["descriptor_execution_batches"] == [
        batch.as_dict() for batch in execution_batches
    ]


def test_descriptor_staging_plan_materializes_execution_batch_images() -> None:
    staging_plan = partition_module(
        parse_module(_mismatched_dot_batch_payload())
    ).descriptor_staging_plan

    first = staging_plan.execution_command_buffer_image(
        arena_base=0x8000_0000,
        descriptor_base=0x2000,
        execution_batch_index=0,
    )
    second = staging_plan.execution_command_buffer_image(
        arena_base=0x8000_0000,
        descriptor_base=0x2100,
        execution_batch_index=1,
    )

    assert first.as_dict() == {
        "schema": "eliza.e1_npu_descriptor_command_buffer_image.v1",
        "claim_boundary": (
            "descriptor_command_buffer_image_only_not_dma_submission_or_tensor_population"
        ),
        "batch_index": 0,
        "arena_base": 0x8000_0000,
        "descriptor_base": 0x2000,
        "op_names": ["dot0"],
        "descriptor_words": [[0xD0000108, 0x8000_0010, 0x8000_0000, 0]],
        "descriptor_image": {
            "0x00002000": 0xD0000108,
            "0x00002004": 0x8000_0010,
            "0x00002008": 0x8000_0000,
            "0x0000200c": 0,
        },
        "submission": {"base": 0x2000, "head": 0, "tail": 1},
        "execution_batch_index": 0,
    }
    assert second.as_dict() == {
        "schema": "eliza.e1_npu_descriptor_command_buffer_image.v1",
        "claim_boundary": (
            "descriptor_command_buffer_image_only_not_dma_submission_or_tensor_population"
        ),
        "batch_index": 0,
        "arena_base": 0x8000_0000,
        "descriptor_base": 0x2100,
        "op_names": ["dot1"],
        "descriptor_words": [[0xCC000108, 0x8000_0038, 0x8000_0020, 0]],
        "descriptor_image": {
            "0x00002100": 0xCC000108,
            "0x00002104": 0x8000_0038,
            "0x00002108": 0x8000_0020,
            "0x0000210c": 0,
        },
        "submission": {"base": 0x2100, "head": 0, "tail": 1},
        "execution_batch_index": 1,
    }


def test_descriptor_staging_plan_execution_batch_image_is_fail_closed() -> None:
    staging_plan = partition_module(parse_module(_dot_add_payload())).descriptor_staging_plan

    with pytest.raises(ValueError, match="no descriptor execution batch"):
        staging_plan.execution_command_buffer_image(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
            execution_batch_index=7,
        )
    with pytest.raises(ValueError, match="non-codegen-ready ops: add0"):
        staging_plan.execution_command_buffer_image(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
            execution_batch_index=1,
        )


def test_partition_report_prepares_descriptor_batch_with_mmio_preamble() -> None:
    report = partition_module(parse_module(_dot_payload("int8")))

    prepared = report.prepared_descriptor_batch(
        arena_base=0x8000_0000,
        descriptor_base=0x2000,
        batch_index=0,
    )

    prepared_dict = prepared.as_dict()
    assert isinstance(prepared, RuntimePreparedDescriptorBatch)
    assert {
        key: prepared_dict[key]
        for key in (
            "schema",
            "claim_boundary",
            "batch_index",
            "arena_base",
            "descriptor_base",
            "arena_total_bytes",
            "arena_alignment_bytes",
            "required_runtime_steps",
            "op_mmio_preamble",
            "descriptor_command_buffer_image",
        )
    } == {
        "schema": "eliza.e1_npu_prepared_descriptor_batch.v1",
        "claim_boundary": (
            "prepared_descriptor_batch_metadata_only_not_mmio_execution_or_dma_submission"
        ),
        "batch_index": 0,
        "arena_base": 0x8000_0000,
        "descriptor_base": 0x2000,
        "arena_total_bytes": 32,
        "arena_alignment_bytes": 4,
        "required_runtime_steps": [
            "populate_tensor_arena",
            "program_mmio_preamble",
            "stage_descriptor_image",
            "submit_command_buffer",
        ],
        "op_mmio_preamble": [
            {
                "op_name": "dot0",
                "runtime_api": "lower_matmul_smoke",
                "mmio_preamble": {
                    "GEMM_CFG": 0x0003_0202,
                    "GEMM_BASE": 0x0010_0800,
                    "GEMM_STRIDE": 0x0008_0203,
                },
            }
        ],
        "descriptor_command_buffer_image": {
            "schema": "eliza.e1_npu_descriptor_command_buffer_image.v1",
            "claim_boundary": (
                "descriptor_command_buffer_image_only_not_dma_submission_or_tensor_population"
            ),
            "batch_index": 0,
            "arena_base": 0x8000_0000,
            "descriptor_base": 0x2000,
            "op_names": ["dot0"],
            "descriptor_words": [[0xD0000108, 0x8000_0010, 0x8000_0000, 0]],
            "descriptor_image": {
                "0x00002000": 0xD0000108,
                "0x00002004": 0x8000_0010,
                "0x00002008": 0x8000_0000,
                "0x0000200c": 0,
            },
            "submission": {"base": 0x2000, "head": 0, "tail": 1},
        },
    }
    assert prepared_dict["host_runtime_sequence"] == {
        "schema": "eliza.e1_npu_host_runtime_sequence.v1",
        "claim_boundary": (
            "host_runtime_sequence_metadata_only_not_tensor_population_or_execution"
        ),
        "mmio_preamble_writes": [
            {
                "op_name": "dot0",
                "writes": [
                    {"register": "GEMM_CFG", "address": "0x10020020", "value": 0x0003_0202},
                    {"register": "GEMM_BASE", "address": "0x10020024", "value": 0x0010_0800},
                    {
                        "register": "GEMM_STRIDE",
                        "address": "0x10020028",
                        "value": 0x0008_0203,
                    },
                ],
            }
        ],
        "descriptor_memory_writes": [
            {"address": "0x00002000", "value": 0xD0000108},
            {"address": "0x00002004", "value": 0x8000_0010},
            {"address": "0x00002008", "value": 0x8000_0000},
            {"address": "0x0000200c", "value": 0},
        ],
        "submission_mmio_writes": [
            {"register": "DESC_BASE", "address": "0x10020040", "value": 0x2000},
            {"register": "DESC_HEAD", "address": "0x10020044", "value": 0},
            {"register": "DESC_TAIL", "address": "0x10020048", "value": 1},
            {"register": "CMD_PARAM", "address": "0x10020030", "value": 1},
            {"register": "CTRL_STATUS", "address": "0x1002000c", "value": 2},
            {"register": "CTRL_STATUS", "address": "0x1002000c", "value": 1},
        ],
        "completion_poll": {
            "register": "DESC_STATUS",
            "address": "0x1002004c",
            "requires_done_bit": True,
            "rejects_error_bit": True,
        },
    }


def test_partition_report_prepares_descriptor_execution_batch() -> None:
    report = partition_module(parse_module(_mismatched_dot_batch_payload()))

    prepared = report.prepared_descriptor_execution_batch(
        arena_base=0x8000_0000,
        descriptor_base=0x2100,
        execution_batch_index=1,
    ).as_dict()

    assert prepared["schema"] == "eliza.e1_npu_prepared_descriptor_batch.v1"
    assert prepared["batch_index"] == 0
    assert prepared["descriptor_command_buffer_image"]["execution_batch_index"] == 1
    assert prepared["descriptor_command_buffer_image"]["op_names"] == ["dot1"]
    assert prepared["descriptor_command_buffer_image"]["descriptor_words"] == [
        [0xCC000108, 0x8000_0038, 0x8000_0020, 0]
    ]
    assert prepared["op_mmio_preamble"] == [
        {
            "op_name": "dot1",
            "runtime_api": "lower_matmul_smoke",
            "mmio_preamble": {
                "GEMM_CFG": 0x0002_0302,
                "GEMM_BASE": 0x000C_0400,
                "GEMM_STRIDE": 0x000C_0302,
            },
        }
    ]
    assert prepared["host_runtime_sequence"]["mmio_preamble_writes"] == [
        {
            "op_name": "dot1",
            "writes": [
                {"register": "GEMM_CFG", "address": "0x10020020", "value": 0x0002_0302},
                {"register": "GEMM_BASE", "address": "0x10020024", "value": 0x000C_0400},
                {
                    "register": "GEMM_STRIDE",
                    "address": "0x10020028",
                    "value": 0x000C_0302,
                },
            ],
        }
    ]


def test_partition_report_prepared_descriptor_batch_is_fail_closed() -> None:
    mixed_report = partition_module(parse_module(_dot_add_payload()))
    ready_report = partition_module(parse_module(_dot_payload("int8")))
    mismatched_report = partition_module(parse_module(_mismatched_dot_batch_payload()))

    with pytest.raises(ValueError, match="non-codegen-ready ops: add0"):
        mixed_report.prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
    with pytest.raises(ValueError, match="incompatible GEMM MMIO preambles"):
        mismatched_report.prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
        )
    with pytest.raises(ValueError, match="no descriptor staging ops"):
        ready_report.prepared_descriptor_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
            batch_index=1,
        )
    with pytest.raises(ValueError, match="no descriptor execution batch"):
        ready_report.prepared_descriptor_execution_batch(
            arena_base=0x8000_0000,
            descriptor_base=0x2000,
            execution_batch_index=7,
        )


def test_descriptor_staging_plan_reports_batch_level_blockers() -> None:
    staging_plan = partition_module(parse_module(_dot_add_payload())).descriptor_staging_plan

    assert staging_plan.as_dict()["descriptor_batches"] == [
        {
            "batch_index": 0,
            "op_names": ["dot0", "add0"],
            "descriptor_slots": 2,
            "descriptor_codegen_ready": False,
            "blocked_ops": [
                {
                    "op_name": "add0",
                    "blocking_reasons": ["runtime_api_not_supported_by_descriptor_staging_plan"],
                }
            ],
        }
    ]


def test_partition_report_descriptor_staging_plan_blocks_unresolved_inputs() -> None:
    module = parse_module(_dot_payload("sparse_int4_2_4"))
    report = partition_module(module)

    op = report.descriptor_staging_plan.as_dict()["ops"][0]

    assert op["input_stream_ready"] is False
    assert op["writeback_ready"] is False
    assert op["descriptor_codegen_ready"] is False
    assert op["descriptor_opcode"] is None
    assert op["descriptor_word_template"] is None
    assert op["blocking_reasons"] == [
        "unresolved_required_graph_fields",
        "runtime_api_not_supported_by_descriptor_staging_plan",
        "precision_not_supported_by_descriptor_staging_plan",
        "descriptor_staging_requires_two_input_bindings",
    ]


def test_partition_report_does_not_batch_across_cpu_fallback_ops() -> None:
    payload = _mixed_payload()
    payload["ops"].append(_dot_payload("int8")["ops"][0] | {"name": "dot_after_fallback"})
    module = parse_module(payload)
    report = partition_module(module)

    assert [batch.op_names for batch in report.command_buffer_batches] == [
        ("dot_supported",),
        ("dot_after_fallback",),
    ]


def test_partition_module_marks_unknown_precision_as_unsupported() -> None:
    payload = _dot_payload("int8")
    payload["ops"][0]["lhs_type"]["dtype"] = "bf16"
    payload["ops"][0]["rhs_type"]["dtype"] = "bf16"
    payload["ops"][0]["result_type"]["dtype"] = "bf16"
    payload["ops"][0]["precision"] = "bf16"
    module = parse_module(payload)

    report = partition_module(module)
    entry = report.entries[0]
    assert entry.supported is True
    assert entry.runtime_api == "lower_bf16_matmul_smoke"


def test_partition_cli_prints_json_report(tmp_path: Path) -> None:
    module_path = tmp_path / "module.json"
    module_path.write_text(json.dumps(_dot_payload("int8")))
    runtime_dir = Path(__file__).resolve().parent

    result = subprocess.run(
        [sys.executable, "e1_npu_partitioner.py", str(module_path)],
        cwd=runtime_dir,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["schema"] == "eliza.e1_npu_partition_report.v1"
    assert payload["total_ops"] == 1
    assert payload["cpu_fallback_percent"] == 0.0


def test_partition_cli_returns_non_zero_on_parse_error(tmp_path: Path) -> None:
    module_path = tmp_path / "broken.json"
    module_path.write_text(textwrap.dedent("{ not valid json"))
    runtime_dir = Path(__file__).resolve().parent

    result = subprocess.run(
        [sys.executable, "e1_npu_partitioner.py", str(module_path)],
        cwd=runtime_dir,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "FAIL" in result.stderr


def test_partition_report_handles_empty_module() -> None:
    module = parse_module(
        {
            "schema": "eliza.e1_npu_stablehlo_subset.v1",
            "name": "empty",
            "ops": [],
        }
    )
    report = partition_module(module)
    assert report.total_ops == 0
    assert report.cpu_fallback_percent == 0.0


def test_partition_entry_reports_runtime_api_for_supported_op() -> None:
    module = parse_module(_dot_payload("int8"))
    report = partition_module(module)
    payload = report.entries[0].as_dict()

    assert payload["supported"] is True
    assert payload["runtime_api"] == "lower_matmul_smoke"
    assert "GEMM_S8" in payload["mapped_opcodes"]


@pytest.mark.parametrize("precision", ["int8", "int4", "int2", "fp8_e4m3"])
def test_partition_supports_known_precisions(precision: str) -> None:
    module = parse_module(_dot_payload(precision))
    report = partition_module(module)
    assert report.entries[0].supported is True
