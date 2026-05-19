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
    SupportEntry,
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
