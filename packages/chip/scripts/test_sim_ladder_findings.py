#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts/run_sim_ladder.py"

spec = importlib.util.spec_from_file_location("run_sim_ladder", RUNNER_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {RUNNER_PATH}")
run_sim_ladder = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = run_sim_ladder
spec.loader.exec_module(run_sim_ladder)


def test_failed_step_emits_finding_and_missing_artifact() -> None:
    findings = run_sim_ladder.structured_findings(
        [
            {
                "name": "cocotb_cpu",
                "status": "fail",
                "command": ["make", "cocotb-cpu"],
                "returncode": 1,
                "missing_artifacts": ["build/reports/cocotb/cpu.xml"],
                "log_tail": ["failure"],
            }
        ]
    )
    codes = [finding["code"] for finding in findings]
    expected = {
        "sim_ladder_step_fail_cocotb_cpu",
        "sim_ladder_missing_artifact_cocotb_cpu_build_reports_cocotb_cpu_xml",
    }
    if set(codes) != expected:
        raise AssertionError(codes)
    print("PASS sim ladder failed step emits structured findings")


def test_all_pass_has_no_findings() -> None:
    findings = run_sim_ladder.structured_findings(
        [{"name": "cocotb_top", "status": "pass", "missing_artifacts": []}]
    )
    if findings:
        raise AssertionError(findings)
    print("PASS sim ladder pass has no findings")


def test_false_claim_flags_are_declared() -> None:
    for key, expected in run_sim_ladder.FALSE_CLAIM_FLAGS.items():
        if expected is not False:
            raise AssertionError(f"{key} should be a false claim flag")
    if run_sim_ladder.CLAIM_BOUNDARY != (
        "local_rtl_simulation_ladder_only_not_linux_or_android_chip_boot_evidence"
    ):
        raise AssertionError(run_sim_ladder.CLAIM_BOUNDARY)
    print("PASS sim ladder declares false claim flags")


def test_provenance_safe_value_sanitizes_host_local_paths() -> None:
    raw = {
        "log_tail": [
            f"g++ -I{run_sim_ladder.ROOT / 'external/oss-cad-suite/include'}",
            "Leaving directory '/tmp/e1-sim'",
            "scratch /var/tmp/e1-ladder",
        ]
    }

    sanitized = run_sim_ladder.provenance_safe_value(raw)
    encoded = str(sanitized)

    if str(run_sim_ladder.ROOT) in encoded:
        raise AssertionError(encoded)
    if "/tmp/" in encoded or "/var/tmp/" in encoded:
        raise AssertionError(encoded)
    if "<repo>/external/oss-cad-suite/include" not in encoded:
        raise AssertionError(encoded)
    if "<tmp>/e1-sim" not in encoded:
        raise AssertionError(encoded)
    if "<var-tmp>/e1-ladder" not in encoded:
        raise AssertionError(encoded)
    print("PASS sim ladder provenance sanitizer strips host-local paths")


def test_passing_step_drops_log_tail() -> None:
    completed = subprocess_result(stdout="PASS=1 FAIL=0\n", returncode=0)
    with mock.patch.object(run_sim_ladder.subprocess, "run", return_value=completed):
        result = run_sim_ladder.run_step(
            {
                "name": "fake",
                "command": ["true"],
                "required_artifacts": [],
            }
        )

    if result["status"] != "pass":
        raise AssertionError(result)
    if result["log_tail"] != []:
        raise AssertionError(result["log_tail"])
    print("PASS sim ladder drops passing log tails")


def subprocess_result(*, stdout: str, returncode: int):
    class Completed:
        def __init__(self) -> None:
            self.stdout: str = ""
            self.returncode: int = 0

    completed = Completed()
    completed.stdout = stdout
    completed.returncode = returncode
    return completed


def main() -> None:
    test_failed_step_emits_finding_and_missing_artifact()
    test_all_pass_has_no_findings()
    test_false_claim_flags_are_declared()
    test_provenance_safe_value_sanitizes_host_local_paths()
    test_passing_step_drops_log_tail()


if __name__ == "__main__":
    main()
