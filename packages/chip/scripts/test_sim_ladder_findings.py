#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

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


def main() -> None:
    test_failed_step_emits_finding_and_missing_artifact()
    test_all_pass_has_no_findings()


if __name__ == "__main__":
    main()
