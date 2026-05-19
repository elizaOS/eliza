"""Tests for the LiteRT (TFLite) delegate skeleton (B-3).

The skeleton mirrors the C-style entry points declared in
``e1_litert_delegate.h`` from Python and shares the StableHLO subset validator
and partitioner with the ExecuTorch delegate (B-2).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e1_litert_delegate import (
    BACKEND_ID,
    SCHEMA,
    STATUS,
    E1LiteRtDelegate,
    LiteRtInvokeResult,
    LiteRtPartitionResult,
    e1_litert_delegate_create,
    e1_litert_delegate_destroy,
    e1_litert_delegate_invoke,
    e1_litert_delegate_partition,
)
from e1_npu_stablehlo import StableHloParseError, StableHloValidationError


def _supported_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "litert_smoke",
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
                "op": "stablehlo.bias_add",
                "name": "bias0",
                "input_type": {"shape": [2, 2], "dtype": "int8"},
                "bias_type": {"shape": [2], "dtype": "int8"},
                "result_type": {"shape": [2, 2], "dtype": "int8"},
                "precision": "int8",
            },
        ],
    }


def _oversize_payload() -> dict:
    return {
        "schema": "eliza.e1_npu_stablehlo_subset.v1",
        "name": "litert_oversize",
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


def test_delegate_create_returns_handle() -> None:
    delegate = e1_litert_delegate_create()
    assert isinstance(delegate, E1LiteRtDelegate)
    assert delegate.backend_id == BACKEND_ID
    e1_litert_delegate_destroy(delegate)


def test_partition_marks_each_op_supported_when_inside_tile_bounds() -> None:
    delegate = e1_litert_delegate_create()
    result = e1_litert_delegate_partition(delegate, json.dumps(_supported_payload()))

    assert isinstance(result, LiteRtPartitionResult)
    assert result.backend_id == BACKEND_ID
    assert len(result.entries) == 2
    assert all(entry.supported for entry in result.entries)
    payload = result.as_dict()
    assert payload["schema"] == SCHEMA
    assert payload["status"] == STATUS


def test_partition_marks_oversize_dot_as_cpu_fallback() -> None:
    delegate = e1_litert_delegate_create()
    result = e1_litert_delegate_partition(delegate, json.dumps(_oversize_payload()))

    assert len(result.entries) == 1
    entry = result.entries[0]
    assert entry.supported is False
    assert entry.reason.startswith("TILE_")


def test_partition_rejects_invalid_payload() -> None:
    delegate = e1_litert_delegate_create()
    with pytest.raises(StableHloParseError):
        e1_litert_delegate_partition(delegate, "{ not a module")


def test_invoke_returns_placeholder_blob_with_descriptor_specs() -> None:
    delegate = e1_litert_delegate_create()
    result = e1_litert_delegate_invoke(delegate, json.dumps(_supported_payload()))

    assert isinstance(result, LiteRtInvokeResult)
    assert result.backend_id == BACKEND_ID
    payload = json.loads(result.blob.decode("utf-8"))
    assert payload["schema"] == SCHEMA
    assert payload["status"] == STATUS
    assert payload["module"] == "litert_smoke"
    assert {entry["op_name"] for entry in payload["descriptor_specs"]} == {"dot0", "bias0"}
    assert payload["command_buffer_batches"] == [
        {
            "batch_index": 0,
            "op_names": ["dot0", "bias0"],
            "runtime_apis": ["lower_matmul_smoke", "lower_bias_add_smoke"],
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
    assert payload["runtime_binding_plan"]["ops"][0]["inputs"][0]["graph_field"] == "lhs"
    assert payload["runtime_binding_plan"]["ops"][0]["descriptor_codegen_ready"] is True
    assert payload["runtime_binding_plan"]["ops"][1]["inputs"][1]["tensor_name"] == "bias0.bias"
    assert payload["descriptor_staging_plan"]["schema"] == (
        "eliza.e1_npu_descriptor_staging_plan.v1"
    )
    assert payload["descriptor_staging_plan"]["ops"][0]["descriptor_opcode_name"] == "OP_GEMM_S8"
    assert payload["descriptor_staging_plan"]["ops"][1]["blocking_reasons"] == [
        "runtime_api_not_supported_by_descriptor_staging_plan"
    ]


def test_invoke_rejects_invalid_module_through_validator() -> None:
    delegate = e1_litert_delegate_create()
    with pytest.raises(StableHloValidationError):
        e1_litert_delegate_invoke(delegate, json.dumps(_oversize_payload()))


def test_delegate_create_partition_invoke_destroy_match_header_lifecycle() -> None:
    delegate = e1_litert_delegate_create()
    partition_result = e1_litert_delegate_partition(delegate, json.dumps(_supported_payload()))
    invoke_result = e1_litert_delegate_invoke(delegate, json.dumps(_supported_payload()))
    e1_litert_delegate_destroy(delegate)

    assert partition_result.backend_id == invoke_result.backend_id == BACKEND_ID
    assert invoke_result.descriptor_specs[0]["op_name"] == "dot0"
    assert invoke_result.descriptor_specs[0]["runtime_api"] == "lower_matmul_smoke"
    assert invoke_result.command_buffer_batches[0]["op_names"] == ["dot0", "bias0"]
    assert invoke_result.tensor_arena_plan["alignment_bytes"] == 4
    assert invoke_result.runtime_binding_plan["ops"][1]["runtime_api"] == "lower_bias_add_smoke"
    assert invoke_result.descriptor_staging_plan["ops"][0]["input_stream_ready"] is True


def test_partition_and_invoke_reject_non_delegate_handle() -> None:
    with pytest.raises(TypeError, match="E1LiteRtDelegate"):
        e1_litert_delegate_partition(object(), json.dumps(_supported_payload()))
    with pytest.raises(TypeError, match="E1LiteRtDelegate"):
        e1_litert_delegate_invoke(object(), json.dumps(_supported_payload()))
    with pytest.raises(TypeError, match="E1LiteRtDelegate"):
        e1_litert_delegate_destroy(object())


def test_partition_and_invoke_accept_byte_payload() -> None:
    delegate = e1_litert_delegate_create()
    payload = json.dumps(_supported_payload()).encode("utf-8")

    partition_result = e1_litert_delegate_partition(delegate, payload)
    invoke_result = e1_litert_delegate_invoke(delegate, payload)

    assert len(partition_result.entries) == 2
    assert len(invoke_result.descriptor_specs) == 2
    assert len(invoke_result.command_buffer_batches) == 1
    assert invoke_result.tensor_arena_plan["total_bytes"] > 0
    assert len(invoke_result.runtime_binding_plan["ops"]) == 2
    assert len(invoke_result.descriptor_staging_plan["ops"]) == 2


def test_header_file_exists_and_declares_expected_entry_points() -> None:
    header_path = Path(__file__).resolve().parent / "e1_litert_delegate.h"
    text = header_path.read_text(encoding="utf-8")
    for symbol in (
        "e1_litert_delegate_create",
        "e1_litert_delegate_partition",
        "e1_litert_delegate_invoke",
        "e1_litert_delegate_destroy",
        "E1_LITERT_DELEGATE_BACKEND_ID",
    ):
        assert symbol in text, f"missing C entry point declaration: {symbol}"
