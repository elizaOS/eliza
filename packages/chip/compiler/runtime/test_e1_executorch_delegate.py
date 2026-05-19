"""Tests for the ExecuTorch delegate skeleton (B-2).

The skeleton mocks the ExecuTorch partitioner / preprocess surface without
importing ``executorch`` and consumes the dataclass subset from
``e1_npu_stablehlo``. The placeholder backend blob is JSON-serialised
descriptor-spec metadata, not real binary kernels.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_executorch_delegate import (
    BACKEND_ID,
    SCHEMA,
    STATUS,
    Backend,
    Partitioner,
    PartitionResult,
    PreprocessResult,
    partition,
    preprocess,
)
from e1_npu_stablehlo import StableHloValidationError, parse_module


def _supported_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "executorch_smoke",
        "ops": [
            {
                "op": "stablehlo.dot_general",
                "name": "dot0",
                "lhs_type": {"shape": [2, 3], "dtype": "int8"},
                "rhs_type": {"shape": [3, 2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "precision": "int8",
            },
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


def _oversize_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "executorch_oversize",
        "ops": [
            {
                "op": "stablehlo.dot_general",
                "name": "dot0",
                "lhs_type": {"shape": [4, 7], "dtype": "int8"},
                "rhs_type": {"shape": [7, 2], "dtype": "int8"},
                "result_type": {"shape": [4, 2], "dtype": "int8"},
                "precision": "int8",
            }
        ],
    }


def test_partitioner_returns_per_op_supported_records() -> None:
    module = parse_module(_supported_payload())
    result = Partitioner().partition(module)

    assert isinstance(result, PartitionResult)
    assert result.backend_id == BACKEND_ID
    assert len(result.entries) == 2
    assert all(entry.supported for entry in result.entries)
    payload = result.as_dict()
    assert payload["schema"] == SCHEMA
    assert payload["status"] == STATUS


def test_partitioner_marks_oversize_dot_as_cpu_fallback() -> None:
    module = parse_module(_oversize_payload())
    result = Partitioner().partition(module)

    assert len(result.entries) == 1
    assert result.entries[0].supported is False
    assert result.entries[0].reason.startswith("TILE_")


def test_partition_module_wrapper_returns_node_supported_pairs() -> None:
    module = parse_module(_supported_payload())
    pairs = partition(module)

    assert len(pairs) == 2
    assert all(supported for _, supported in pairs)


def test_partitioner_rejects_non_module_input() -> None:
    with pytest.raises(TypeError, match="StableHloModule"):
        Partitioner().partition({"op": "stablehlo.dot_general"})


def test_backend_preprocess_returns_placeholder_descriptor_spec_blob() -> None:
    module = parse_module(_supported_payload())
    result = Backend().preprocess(module)

    assert isinstance(result, PreprocessResult)
    assert result.backend_id == BACKEND_ID
    assert len(result.descriptor_specs) == 2
    payload = json.loads(result.blob.decode("utf-8"))
    assert payload["schema"] == SCHEMA
    assert payload["status"] == STATUS
    assert payload["module"] == "executorch_smoke"
    assert {entry["op_name"] for entry in payload["descriptor_specs"]} == {"dot0", "add0"}
    assert payload["command_buffer_batches"] == [
        {
            "batch_index": 0,
            "op_names": ["dot0", "add0"],
            "runtime_apis": ["lower_matmul_smoke", "lower_residual_add_smoke"],
            "descriptor_slots": 2,
            "command_buffer_max_entries": 7,
            "claim_boundary": (
                "partitioner_command_buffer_batching_smoke_only_not_dependency_scheduler"
            ),
        }
    ]
    assert payload["tensor_arena_plan"]["schema"] == "eliza.e1_npu_tensor_arena_plan.v1"
    assert payload["tensor_arena_plan"]["total_bytes"] > 0
    assert payload["tensor_arena_plan"]["allocations"][0]["tensor_name"] == "dot0.result"
    assert payload["runtime_binding_plan"]["schema"] == "eliza.e1_npu_runtime_binding_plan.v1"
    assert payload["runtime_binding_plan"]["ready_ops"] == 2
    assert payload["runtime_binding_plan"]["blocked_ops"] == 0
    assert payload["runtime_binding_plan"]["ops"][0]["op_name"] == "dot0"
    assert payload["runtime_binding_plan"]["ops"][0]["descriptor_codegen_ready"] is True
    assert payload["runtime_binding_plan"]["ops"][0]["inputs"][0]["offset"] == 16
    assert payload["runtime_binding_plan"]["ops"][0]["unresolved_inputs"] == []
    assert payload["runtime_binding_plan"]["ops"][1]["command_buffer_batch_index"] == 0
    assert payload["descriptor_staging_plan"]["schema"] == (
        "eliza.e1_npu_descriptor_staging_plan.v1"
    )
    assert payload["descriptor_staging_plan"]["ops"][0]["input_stream_ready"] is True
    assert payload["descriptor_staging_plan"]["ops"][0]["stream_byte_count"] == 16
    assert payload["descriptor_staging_plan"]["ops"][0]["writeback_ready"] is True
    dot_entry = next(entry for entry in payload["descriptor_specs"] if entry["op_name"] == "dot0")
    assert dot_entry["runtime_api"] == "lower_matmul_smoke"
    assert dot_entry["lowering_precision"] == "int8"
    assert dot_entry["input_shape"] == [2, 3]
    assert dot_entry["output_shape"] == [2, 2]


def test_backend_preprocess_rejects_invalid_module() -> None:
    module = parse_module(_oversize_payload())
    with pytest.raises(StableHloValidationError):
        Backend().preprocess(module)


def test_preprocess_wrapper_returns_blob_bytes() -> None:
    module = parse_module(_supported_payload())
    blob = preprocess(module)
    assert isinstance(blob, bytes)
    assert json.loads(blob.decode("utf-8"))["backend_id"] == BACKEND_ID


def test_preprocess_result_summary_records_blob_size_and_status() -> None:
    module = parse_module(_supported_payload())
    result = Backend().preprocess(module)
    summary = result.as_dict()
    assert summary["status"] == STATUS
    assert summary["blob_bytes"] == len(result.blob)
    assert summary["schema"] == SCHEMA
    assert summary["command_buffer_batches"][0]["op_names"] == ["dot0", "add0"]
    assert summary["tensor_arena_plan"]["alignment_bytes"] == 4
    assert summary["runtime_binding_plan"]["ops"][0]["runtime_api"] == "lower_matmul_smoke"
    assert summary["descriptor_staging_plan"]["ops"][0]["descriptor_opcode_name"] == "OP_GEMM_S8"
