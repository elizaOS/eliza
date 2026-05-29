#!/usr/bin/env python3
"""Build and validate the local e1-NPU coverage summary."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import hashlib
import importlib.util
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
DEFAULT_COCOTB_COVERAGE = ROOT / "build/reports/npu_cocotb_coverage.json"
DEFAULT_COCOTB_RESULTS = ROOT / "verify/cocotb/results/e1_npu_test_e1_npu.xml"
DEFAULT_OUT = ROOT / "build/reports/npu_coverage_summary.json"

REQUIRED_DIRECTED_TESTS: dict[str, tuple[str, ...]] = {
    "opcode_runtime_contract": (
        "npu_runtime_abi_sequence_matches_rtl_and_writes_coverage",
    ),
    "invalid_programming": (
        "npu_gemm_invalid_config_reports_error_without_touching_scratch",
        "npu_descriptor_timeout_engine_faults_stalled_memory_fetch",
        "npu_descriptor_empty_and_unaligned_base_report_specific_status",
        "npu_descriptor_requires_valid_owner_bit_and_rejects_malformed_writeback_request",
        "npu_dot16_ternary_rejects_reserved_encoding",
    ),
    "descriptor_tensor_paths": (
        "npu_descriptor_fetch_launches_scalar_op_and_advances_tail",
        "npu_descriptor_streams_tensor_tile_into_scratchpad_and_runs_gemm",
        "npu_descriptor_streams_gemm_and_writes_result_back_to_dram",
    ),
    "irq_paths": (
        "npu_exp2_opcode_completes_and_clears_done_irq",
        "npu_descriptor_timeout_engine_faults_stalled_memory_fetch",
    ),
    "saturation_and_vector_paths": (
        "npu_runtime_abi_sequence_matches_rtl_and_writes_coverage",
        "npu_perf_scratch_bytes_increments_on_vrelu",
    ),
    "counter_paths": (
        "npu_perf_scratch_bytes_increments_on_vrelu",
        "npu_perf_scratch_bytes_increments_on_gemm_s8",
        "npu_perf_stall_cycles_counts_descriptor_memory_wait",
        "npu_perf_thermal_throttle_increments_on_host_writes",
    ),
}

SOFTWARE_FALLBACK_TESTS = (
    "compiler/runtime/test_e1_npu_tiny_mlp_e2e.py::test_mobilenet_first_conv2d_partitioner_emits_cpu_fallback_set",
)
CLAIM_BOUNDARY = {
    "allowed_current_claims": [
        "Local RTL/cocotb/runtime ABI coverage for the e1 NPU.",
        "Validated descriptor, counter, invalid-programming, IRQ, and software-fallback boundary coverage.",
    ],
    "blocked_claims": [
        "DMA-backed tensor execution readiness.",
        "Android NNAPI acceleration readiness.",
        "Phone-class TOPS, latency, throughput, or perf/W readiness.",
        "Hardware benchmark, silicon, product, tapeout, or release evidence.",
    ],
    "nnapi_acceleration": False,
    "dma_backed_tensor_execution": False,
    "phone_class_tops": False,
    "hardware_benchmark": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_runtime_class():
    spec = importlib.util.spec_from_file_location("e1_npu_runtime", RUNTIME)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {RUNTIME}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.E1NpuRuntime


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must contain a JSON object")
    return data


def artifact(path: Path) -> dict[str, Any]:
    item: dict[str, Any] = {"path": rel(path), "exists": path.is_file()}
    if path.is_file():
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        item.update({"bytes": path.stat().st_size, "sha256": digest.hexdigest()})
    return item


def load_passed_cocotb_testcases(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    tree = ET.parse(path)
    passed: set[str] = set()
    for testcase in tree.iter("testcase"):
        name = testcase.get("name")
        if not name:
            continue
        failed = any(child.tag in {"failure", "error", "skipped"} for child in testcase)
        if not failed:
            passed.add(name)
    return passed


def fallback_test_sources() -> dict[str, bool]:
    sources: dict[str, bool] = {}
    for test_id in SOFTWARE_FALLBACK_TESTS:
        raw_path, _, test_name = test_id.partition("::")
        path = ROOT / raw_path
        sources[test_id] = path.is_file() and test_name in path.read_text(encoding="utf-8")
    return sources


def build_summary(
    cocotb_path: Path, results_path: Path = DEFAULT_COCOTB_RESULTS
) -> dict[str, Any]:
    runtime_cls = load_runtime_class()
    contract = load_json(CONTRACT)
    cocotb = load_json(cocotb_path)
    opcodes = contract.get("opcodes", {})
    required_opcode_ids = sorted(opcodes.values())
    covered_opcode_ids = sorted(cocotb.get("covered_opcodes", []))
    runtime = runtime_cls(lambda _addr: 0, lambda _addr, _value: None)
    passed_tests = load_passed_cocotb_testcases(results_path)
    directed_tests = {
        category: {
            "required": list(required),
            "passed": sorted(name for name in required if name in passed_tests),
            "all_passed": all(name in passed_tests for name in required),
        }
        for category, required in REQUIRED_DIRECTED_TESTS.items()
    }

    summary = {
        "schema": "eliza.npu_local_coverage_summary.v1",
        "status": "unchecked",
        "generated_utc": utc_now(),
        "source": rel(cocotb_path),
        "coverage_kind": "local_rtl_runtime_only",
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "production_accelerator_claim_allowed": False,
        "nnapi_claim_allowed": False,
        "performance_claim_allowed": False,
        "artifacts": {
            "cocotb_coverage": artifact(cocotb_path),
            "cocotb_results": artifact(results_path),
            "runtime": artifact(RUNTIME),
            "runtime_contract": artifact(CONTRACT),
        },
        "claim_boundary": CLAIM_BOUNDARY,
        "opcodes": {
            "required": opcodes,
            "covered_ids": covered_opcode_ids,
            "covered_names": cocotb.get("covered_opcode_names", []),
            "all_required_covered": covered_opcode_ids == required_opcode_ids,
        },
        "precision_modes": runtime.precision_matrix(),
        "descriptor_fail_closed_paths": cocotb.get("descriptor_queue", {}),
        "counters": {
            "required": [
                "unsupported_ops",
                "cycles",
                "macs",
                "ops",
                "errors",
                "desc_read_beats",
                "desc_write_beats",
                "stall_cycles",
                "scratch_bytes",
                "thermal_throttle",
            ],
            "covered": cocotb.get("perf_counters", []),
        },
        "errors": {
            "status_bits": cocotb.get("status_bits", []),
            "unsupported_ops_counter_covered": "unsupported_ops"
            in set(cocotb.get("perf_counters", [])),
            "error_counter_covered": "errors" in set(cocotb.get("perf_counters", [])),
        },
        "gemm_shapes": cocotb.get("gemm_shapes", []),
        "gemm_s4_shapes": cocotb.get("gemm_s4_shapes", []),
        "vector_shapes": cocotb.get("vector_shapes", []),
        "directed_tests": directed_tests,
        "saturation_cases": cocotb.get("saturation_cases", {}),
        "invalid_programming_cases": cocotb.get("invalid_programming_cases", {}),
        "irq_paths": cocotb.get("irq_paths", {}),
        "software_fallback_cases": {
            "source_tests": fallback_test_sources(),
            "unsupported_ops_accounted": ["softmax", "layer_norm"],
            "cpu_fallback_boundary_reported": True,
            "rtl_cocotb_executes_cpu_fallback": False,
        },
    }
    errors = validate_summary(summary)
    summary["status"] = "pass" if not errors else "fail"
    summary["validation_errors"] = errors
    return summary


def validate_summary(summary: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for claim in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "production_accelerator_claim_allowed",
        "nnapi_claim_allowed",
        "performance_claim_allowed",
    ):
        if summary.get(claim) is not False:
            errors.append(f"{claim} must be false")

    boundary = summary.get("claim_boundary", {})
    for claim in (
        "nnapi_acceleration",
        "dma_backed_tensor_execution",
        "phone_class_tops",
        "hardware_benchmark",
    ):
        if boundary.get(claim) is not False:
            errors.append(f"claim_boundary.{claim} must be false")

    opcodes = summary.get("opcodes", {})
    if opcodes.get("all_required_covered") is not True:
        errors.append("not all runtime contract opcodes are covered")
    if "gemm_s8" not in opcodes.get("covered_names", []):
        errors.append("GEMM_S8 coverage is missing")
    if "gemm_s4" not in opcodes.get("covered_names", []):
        errors.append("GEMM_S4 coverage is missing")

    precision = {
        entry.get("precision"): entry.get("state")
        for entry in summary.get("precision_modes", [])
        if isinstance(entry, dict)
    }
    for mode in ("INT8", "INT4", "FP16", "BF16", "FP8"):
        if mode not in precision:
            errors.append(f"precision matrix missing {mode}")
    prototype_modes = ("FP16", "BF16", "FP8")
    for mode in prototype_modes:
        if precision.get(mode) not in {"supported", "supported_prototype"}:
            errors.append(f"precision {mode} must remain scalar/prototype-supported")
    for entry in summary.get("precision_modes", []):
        if not isinstance(entry, dict) or entry.get("precision") not in prototype_modes:
            continue
        path = str(entry.get("path", "")).lower()
        if "no tensor" not in path or "compiler path" not in path:
            errors.append(
                f"precision {entry.get('precision')} must retain no-tensor/compiler boundary"
            )

    descriptor = summary.get("descriptor_fail_closed_paths", {})
    for flag in (
        "empty_queue_rejects",
        "unaligned_base_rejects",
        "valid_owner_bit_required",
        "malformed_writeback_request_fails_closed",
        "descriptor_streams_gemm_s8",
        "descriptor_writeback_gemm_s8",
        "descriptor_bytes_read_covered",
        "descriptor_bytes_written_covered",
        "descriptor_read_beats_covered",
        "descriptor_write_beats_covered",
    ):
        if descriptor.get(flag) is not True:
            errors.append(f"descriptor fail-closed coverage missing {flag}")
    if not (
        descriptor.get("reserved_submission_rejects") is True
        or descriptor.get("missing_descriptor_response_times_out") is True
    ):
        errors.append("descriptor fail-closed coverage missing rejected or timed-out submission")
    if descriptor.get("dma_backed_tensor_execution") is not False:
        errors.append("descriptor coverage must not claim DMA-backed tensor execution")

    counters = summary.get("counters", {})
    covered_counters = set(counters.get("covered", []))
    for counter in counters.get("required", []):
        if counter not in covered_counters:
            errors.append(f"counter coverage missing {counter}")

    error_info = summary.get("errors", {})
    if "error" not in error_info.get("status_bits", []):
        errors.append("error status bit coverage is missing")
    if error_info.get("unsupported_ops_counter_covered") is not True:
        errors.append("unsupported_ops counter coverage is missing")
    if error_info.get("error_counter_covered") is not True:
        errors.append("error counter coverage is missing")
    if not summary.get("gemm_shapes"):
        errors.append("GEMM_S8 shape coverage is missing")
    if not summary.get("gemm_s4_shapes"):
        errors.append("GEMM_S4 shape coverage is missing")
    if not summary.get("vector_shapes"):
        errors.append("vector shape coverage is missing")

    for category, result in summary.get("directed_tests", {}).items():
        if not isinstance(result, dict) or result.get("all_passed") is not True:
            missing = set(result.get("required", [])) - set(result.get("passed", []))
            errors.append(f"directed cocotb tests missing for {category}: {sorted(missing)}")

    saturation = summary.get("saturation_cases", {})
    for case in ("relu4_negative_lanes_zeroed", "vrelu_negative_lanes_zeroed"):
        if saturation.get(case) is not True:
            errors.append(f"saturation coverage missing {case}")

    invalid = summary.get("invalid_programming_cases", {})
    for case in (
        "gemm_zero_dimensions",
        "descriptor_timeout",
        "empty_queue",
        "unaligned_base",
        "missing_valid_owner",
        "malformed_writeback_request",
        "ternary_reserved_encoding",
    ):
        if invalid.get(case) is not True:
            errors.append(f"invalid-programming coverage missing {case}")

    irq_paths = summary.get("irq_paths", {})
    for case in (
        "done_irq_asserted",
        "done_irq_clear_deasserts",
        "error_irq_asserted",
        "error_irq_clear_deasserts",
    ):
        if irq_paths.get(case) is not True:
            errors.append(f"IRQ coverage missing {case}")

    fallback = summary.get("software_fallback_cases", {})
    for test_id, present in fallback.get("source_tests", {}).items():
        if present is not True:
            errors.append(f"software fallback source test missing {test_id}")
    if fallback.get("cpu_fallback_boundary_reported") is not True:
        errors.append("software fallback boundary accounting is missing")
    if fallback.get("rtl_cocotb_executes_cpu_fallback") is not False:
        errors.append("RTL cocotb must not claim CPU fallback execution")
    return errors


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coverage-json", type=Path, default=DEFAULT_COCOTB_COVERAGE)
    parser.add_argument("--results-xml", type=Path, default=DEFAULT_COCOTB_RESULTS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cocotb_path = (
        args.coverage_json if args.coverage_json.is_absolute() else ROOT / args.coverage_json
    )
    results_path = args.results_xml if args.results_xml.is_absolute() else ROOT / args.results_xml
    out = args.out if args.out.is_absolute() else ROOT / args.out
    if not cocotb_path.is_file():
        print(f"NPU coverage summary check failed: missing {rel(cocotb_path)}")
        print("Run `COCOTB_MODULE=test_e1_npu COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh` first.")
        return 2

    summary = build_summary(cocotb_path, results_path)
    errors = validate_summary(summary)
    if summary.get("status") != ("pass" if not errors else "fail"):
        errors.append("status does not match validation result")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        print("NPU coverage summary check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"NPU coverage summary check passed: wrote {rel(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
