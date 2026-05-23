#!/usr/bin/env python3
"""Regression tests for script-owned structured release blocker reports."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_report(path: str) -> dict:
    report = ROOT / path
    if not report.is_file():
        raise AssertionError(f"missing report: {path}")
    payload = json.loads(report.read_text(encoding="utf-8"))
    if payload.get("status") != "blocked":
        raise AssertionError(f"{path} status is not blocked: {payload}")
    if payload.get("summary", {}).get("release_ready") is not False:
        raise AssertionError(f"{path} must not claim release_ready: {payload}")
    findings = payload.get("findings")
    if not isinstance(findings, list) or not findings:
        raise AssertionError(f"{path} missing structured findings: {payload}")
    return payload


def assert_blocked_report(
    name: str,
    command: list[str],
    report_path: str,
    expected_codes: set[int],
) -> None:
    result = run(command)
    if result.returncode not in expected_codes:
        raise AssertionError(
            f"{name}: exit {result.returncode} not in {sorted(expected_codes)}\n{result.stdout}"
        )
    load_report(report_path)
    print(f"PASS {name} writes {report_path}")


def test_blocked_reports() -> None:
    assert_blocked_report(
        "release archive",
        ["python3", "scripts/check_release_archive.py", "build/missing-release-archive.tar.gz"],
        "build/reports/release_archive.json",
        {1},
    )
    assert_blocked_report(
        "manufacturing artifacts release",
        ["python3", "scripts/check_manufacturing_artifacts.py", "--release"],
        "build/reports/manufacturing_artifacts.json",
        {1},
    )
    assert_blocked_report(
        "PD signoff artifacts",
        ["python3", "scripts/check_pd_signoff.py"],
        "build/reports/pd_signoff.json",
        {1},
    )
    assert_blocked_report(
        "antenna metadata release",
        ["python3", "scripts/check_antenna_metadata.py", "--release"],
        "build/reports/antenna_metadata.json",
        {1},
    )
    assert_blocked_report(
        "PDN workload signoff",
        ["python3", "scripts/check_pdn_workload_signoff.py", "--allow-blocked"],
        "build/reports/pdn_workload_signoff.json",
        {0},
    )
    assert_blocked_report(
        "FPGA release",
        ["python3", "scripts/check_fpga_release.py", "--release"],
        "build/reports/fpga_release.json",
        {1},
    )


def main() -> None:
    test_blocked_reports()


if __name__ == "__main__":
    main()
