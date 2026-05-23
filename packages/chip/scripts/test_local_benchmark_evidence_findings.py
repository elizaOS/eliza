#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts/run_local_benchmark_evidence.py"

spec = importlib.util.spec_from_file_location("run_local_benchmark_evidence", RUNNER_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {RUNNER_PATH}")
run_local_benchmark_evidence = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = run_local_benchmark_evidence
spec.loader.exec_module(run_local_benchmark_evidence)


def test_timeout_and_no_passes_emit_findings() -> None:
    findings = run_local_benchmark_evidence.structured_findings(
        [
            {
                "name": "coremark",
                "status": "timeout",
                "elapsed_seconds": 2.0,
                "artifacts": {"raw_output": "build/reports/coremark.log"},
                "claim_boundary": "local host execution only",
            }
        ],
        [],
    )
    codes = [finding["code"] for finding in findings]
    expected = {
        "local_host_benchmark_timeout_coremark",
        "local_host_benchmark_no_parseable_passes",
    }
    if set(codes) != expected:
        raise AssertionError(codes)
    print("PASS local benchmark timeout/no-pass findings emitted")


def test_passed_benchmark_has_no_finding() -> None:
    findings = run_local_benchmark_evidence.structured_findings(
        [{"name": "coremark", "status": "passed"}],
        ["coremark"],
    )
    if findings:
        raise AssertionError(findings)
    print("PASS local benchmark pass does not emit blocker finding")


def main() -> None:
    test_timeout_and_no_passes_emit_findings()
    test_passed_benchmark_has_no_finding()


if __name__ == "__main__":
    main()
