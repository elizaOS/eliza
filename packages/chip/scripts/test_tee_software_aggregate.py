#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_tee_software_aggregate.py"

spec = importlib.util.spec_from_file_location("check_tee_software_aggregate", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_tee_software_aggregate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_tee_software_aggregate
spec.loader.exec_module(check_tee_software_aggregate)


def test_blocked_hardware_gates_emit_findings() -> None:
    findings = check_tee_software_aggregate.structured_findings(
        [{"id": "software-floor", "status": "pass", "returncode": 0, "script": "check.py"}],
        check_tee_software_aggregate.BLOCKED_HARDWARE_GATES,
    )
    codes = [finding["code"] for finding in findings]
    if len(codes) != len(check_tee_software_aggregate.BLOCKED_HARDWARE_GATES):
        raise AssertionError(codes)
    if not all(code.startswith("tee_software_missing_hardware_gate_") for code in codes):
        raise AssertionError(codes)
    print("PASS blocked TEE hardware gates emit structured findings")


def test_failed_software_check_emits_finding() -> None:
    findings = check_tee_software_aggregate.structured_findings(
        [{"id": "quote-serializer", "status": "fail", "returncode": 1, "script": "check.py"}],
        [],
    )
    codes = [finding["code"] for finding in findings]
    if codes != ["tee_software_check_failed_quote_serializer"]:
        raise AssertionError(codes)
    print("PASS failed TEE software checker emits structured finding")


def test_run_checker_sanitizes_host_local_output() -> None:
    completed = check_tee_software_aggregate.subprocess.CompletedProcess(
        args=["python3", "check.py"],
        returncode=1,
        stdout=(
            "TEE policy valid: "
            "/home/shaw/milady/eliza/packages/chip/docs/spec-db/tee-core-target.yaml\n"
        ),
        stderr="",
    )
    with mock.patch.object(check_tee_software_aggregate.subprocess, "run", return_value=completed):
        row = check_tee_software_aggregate.run_checker("core-target", "check.py")

    encoded = str(row)
    if "/home/shaw" in encoded:
        raise AssertionError(encoded)
    if "packages/chip/docs/spec-db/tee-core-target.yaml" not in encoded:
        raise AssertionError(encoded)
    print("PASS TEE aggregate sanitizes checker output")


def main() -> None:
    test_blocked_hardware_gates_emit_findings()
    test_failed_software_check_emits_finding()
    test_run_checker_sanitizes_host_local_output()


if __name__ == "__main__":
    main()
