#!/usr/bin/env python3
"""Build and validate the local e1-NPU coverage summary."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
DEFAULT_COCOTB_COVERAGE = ROOT / "build/reports/npu_cocotb_coverage.json"
DEFAULT_OUT = ROOT / "build/reports/npu_coverage_summary.json"


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


def build_summary(cocotb_path: Path) -> dict[str, Any]:
    runtime_cls = load_runtime_class()
    contract = load_json(CONTRACT)
    cocotb = load_json(cocotb_path)
    opcodes = contract.get("opcodes", {})
    required_opcode_ids = sorted(opcodes.values())
    covered_opcode_ids = sorted(cocotb.get("covered_opcodes", []))
    runtime = runtime_cls(lambda _addr: 0, lambda _addr, _value: None)

    summary = {
        "schema": "eliza.npu_local_coverage_summary.v1",
        "status": "unchecked",
        "source": rel(cocotb_path),
        "coverage_kind": "local_rtl_runtime_only",
        "artifacts": {
            "cocotb_coverage": artifact(cocotb_path),
            "runtime": artifact(RUNTIME),
            "runtime_contract": artifact(CONTRACT),
        },
        "claim_boundary": {
            "nnapi_acceleration": False,
            "dma_backed_tensor_execution": False,
            "phone_class_tops": False,
            "hardware_benchmark": False,
        },
        "opcodes": {
            "required": opcodes,
            "covered_ids": covered_opcode_ids,
            "covered_names": cocotb.get("covered_opcode_names", []),
            "all_required_covered": covered_opcode_ids == required_opcode_ids,
        },
        "precision_modes": runtime.precision_matrix(),
        "descriptor_fail_closed_paths": cocotb.get("descriptor_queue", {}),
        "counters": {
            "required": ["unsupported_ops", "cycles", "macs", "ops", "errors"],
            "covered": cocotb.get("perf_counters", []),
        },
        "errors": {
            "status_bits": cocotb.get("status_bits", []),
            "unsupported_ops_counter_covered": "unsupported_ops"
            in set(cocotb.get("perf_counters", [])),
            "error_counter_covered": "errors" in set(cocotb.get("perf_counters", [])),
        },
        "gemm_shapes": cocotb.get("gemm_shapes", []),
    }
    errors = validate_summary(summary)
    summary["status"] = "pass" if not errors else "fail"
    summary["validation_errors"] = errors
    return summary


def validate_summary(summary: dict[str, Any]) -> list[str]:
    errors: list[str] = []
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
    for flag in ("empty_queue_rejects", "unaligned_base_rejects"):
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
        errors.append("GEMM shape coverage is missing")
    return errors


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coverage-json", type=Path, default=DEFAULT_COCOTB_COVERAGE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cocotb_path = (
        args.coverage_json if args.coverage_json.is_absolute() else ROOT / args.coverage_json
    )
    out = args.out if args.out.is_absolute() else ROOT / args.out
    if not cocotb_path.is_file():
        print(f"NPU coverage summary check failed: missing {rel(cocotb_path)}")
        print("Run `COCOTB_MODULE=test_e1_npu COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh` first.")
        return 2

    summary = build_summary(cocotb_path)
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
