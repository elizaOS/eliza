#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_npu_accelerator.py"
MAKEFILE = ROOT / "Makefile"


def load_gate():
    spec = importlib.util.spec_from_file_location("check_npu_accelerator", CHECK_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError(f"unable to import {CHECK_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def assert_false_flags(report: dict) -> None:
    for key in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "production_accelerator_release_claim_allowed",
        "nnapi_claim_allowed",
        "performance_claim_allowed",
    ):
        if report.get(key) is not False:
            raise AssertionError(f"{key} must be exactly false")


def test_report_records_non_release_boundaries() -> None:
    gate = load_gate()
    checks = [
        {"id": "lint", "status": "pass", "detail": "ok"},
        {"id": "nnapi", "status": "blocked", "detail": "target proof missing"},
    ]
    report = gate.build_report(checks)
    if report["status"] != "BLOCKED":
        raise AssertionError(report)
    assert_false_flags(report)
    boundary = report["claim_boundary"]
    for token in (
        "does NOT prove SoC-fabric wiring",
        "NNAPI/VTS",
        "Linux/Android driver",
        "phone-class throughput",
    ):
        if token not in boundary:
            raise AssertionError(f"claim boundary missing {token!r}")
    print("PASS npu accelerator report keeps release claims false")


def test_makefile_wires_npu_accelerator_targets() -> None:
    makefile = MAKEFILE.read_text(encoding="utf-8")
    if ".PHONY: npu-accelerator-check npu-accelerator-gate-test" not in makefile:
        raise AssertionError("missing npu accelerator .PHONY targets")
    if "\nnpu-accelerator-check:\n\t@$(PYTHON) scripts/check_npu_accelerator.py" not in makefile:
        raise AssertionError("npu-accelerator-check target not wired")
    if (
        "\nnpu-accelerator-gate-test:\n\t@$(PYTHON) scripts/test_npu_accelerator_gate.py"
        not in makefile
    ):
        raise AssertionError("npu-accelerator-gate-test target not wired")
    print("PASS Makefile wires npu accelerator check targets")


def main() -> None:
    test_report_records_non_release_boundaries()
    test_makefile_wires_npu_accelerator_targets()


if __name__ == "__main__":
    main()
