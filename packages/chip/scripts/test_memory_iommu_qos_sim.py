#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_memory_iommu_qos_sim.py"
SIM = ROOT / "benchmarks/sim/run_memory_iommu_qos_sim.py"
MEMORY_SPEC = ROOT / "docs/spec-db/memory-2028-target.yaml"

spec = importlib.util.spec_from_file_location("check_memory_iommu_qos_sim", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_memory_iommu_qos_sim = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_memory_iommu_qos_sim
spec.loader.exec_module(check_memory_iommu_qos_sim)


def load_valid_report() -> tuple[dict[str, Any], dict[str, Any]]:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "memory-iommu-qos-sim.json"
        subprocess.run(
            [sys.executable, str(SIM), "--out", str(out)],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        )
        data = check_memory_iommu_qos_sim.load_json_object(out)
    spec_data = yaml.safe_load(MEMORY_SPEC.read_text(encoding="utf-8"))
    if not isinstance(spec_data, dict):
        raise AssertionError("memory spec must be a mapping")
    return data, spec_data


def expect_error(mutated: dict[str, Any], spec_data: dict[str, Any], token: str) -> None:
    errors = check_memory_iommu_qos_sim.validate_report(mutated, spec_data)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def test_valid_report_passes() -> None:
    data, spec_data = load_valid_report()
    errors = check_memory_iommu_qos_sim.validate_report(data, spec_data)
    if errors:
        raise AssertionError(errors)
    print("PASS valid memory IOMMU/QoS report")


def test_claim_boundary_drift_fails() -> None:
    data, spec_data = load_valid_report()
    data["claim_boundary"] = "modeled only"
    expect_error(data, spec_data, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_false_claim_flags_are_required() -> None:
    data, spec_data = load_valid_report()
    mutated = copy.deepcopy(data)
    mutated["release_claim_allowed"] = True
    mutated.pop("phone_claim_allowed", None)
    expect_error(mutated, spec_data, "phone_claim_allowed")
    expect_error(mutated, spec_data, "release_claim_allowed")
    print("PASS false claim flag drift rejected")


def test_missing_fault_field_fails() -> None:
    data, spec_data = load_valid_report()
    mutated = copy.deepcopy(data)
    del mutated["iommu_faults"][0]["syndrome_status"]
    expect_error(mutated, spec_data, "missing fields")
    print("PASS missing IOMMU fault field rejected")


def test_display_underflow_fails() -> None:
    data, spec_data = load_valid_report()
    data["summary"]["display_underflow_count"] = 1
    expect_error(data, spec_data, "display underflow")
    print("PASS display underflow rejected")


def test_stream_drift_fails() -> None:
    data, spec_data = load_valid_report()
    data["qos_streams"] = data["qos_streams"][:-1]
    expect_error(data, spec_data, "stream IDs")
    print("PASS stream drift rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_false_claim_flags_are_required()
    test_missing_fault_field_fails()
    test_display_underflow_fails()
    test_stream_drift_fails()


if __name__ == "__main__":
    main()
