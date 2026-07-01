#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_io_cell_contract.py"

spec = importlib.util.spec_from_file_location("check_io_cell_contract", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_io_cell_contract = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_io_cell_contract
spec.loader.exec_module(check_io_cell_contract)


def expect_error(report: dict, token: str) -> None:
    errors = check_io_cell_contract.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def test_report_emits_io_cell_findings() -> None:
    report = check_io_cell_contract.build_report()
    if report["status"] != "BLOCKED":
        raise AssertionError(report["status"])
    for key in (
        "foundry_io_cell_release_claim_allowed",
        "esd_latchup_signoff_claim_allowed",
        "ibis_si_claim_allowed",
        "padframe_tapeout_claim_allowed",
        "board_package_release_claim_allowed",
    ):
        if report.get(key) is not False:
            raise AssertionError(f"{key} must be false")
    findings = report.get("findings")
    if not isinstance(findings, list) or not findings:
        raise AssertionError("findings missing")
    codes = [finding["code"] for finding in findings]
    if not any(code.startswith("io_cell_class_blocked_") for code in codes):
        raise AssertionError(codes)
    print("PASS IO-cell blockers emit structured findings")


def test_missing_findings_fail_validation() -> None:
    report = check_io_cell_contract.build_report()
    mutated = copy.deepcopy(report)
    mutated["findings"] = []
    expect_error(mutated, "findings")
    print("PASS IO-cell blocker findings are required")


def test_claim_boundary_drift_fails() -> None:
    report = check_io_cell_contract.build_report()
    mutated = copy.deepcopy(report)
    mutated["claim_boundary"] = "IO cell scaffold only"
    expect_error(mutated, "claim boundary")
    print("PASS IO-cell claim boundary drift rejected")


def main() -> None:
    test_report_emits_io_cell_findings()
    test_missing_findings_fail_validation()
    test_claim_boundary_drift_fails()


if __name__ == "__main__":
    main()
