#!/usr/bin/env python3
"""Regression test for the aggregate SOTA parity audit."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/sota_parity_audit.json"


def run_audit(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", "scripts/check_sota_parity_audit.py", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def main() -> int:
    normal = run_audit()
    assert normal.returncode == 0, normal.stdout[-4000:]
    assert "STATUS: BLOCKED sota_parity" in normal.stdout

    data = json.loads(REPORT.read_text(encoding="utf-8"))
    assert data["schema"] == "eliza.sota_parity_audit.v1"
    assert data["status"] == "blocked"
    assert data["generated_utc"].endswith("Z")
    flags = {key: value for key, value in data.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    assert data["summary"]["ready_for_sota_claim"] is False
    assert data["summary"]["blocked_domain_count"] == data["summary"]["domain_count"]
    domain_ids = {domain["id"] for domain in data["parity_domains"]}
    findings = data.get("findings")
    assert isinstance(findings, list)
    assert len(findings) == data["summary"]["blocked_domain_count"]
    finding_codes = {finding["code"] for finding in findings}
    for domain_id in {
        "cpu_ap",
        "npu",
        "memory_uma",
        "software_bsp_android_linux",
        "benchmarks_efficiency",
        "sustained_power_thermal",
        "product_package_board_pd",
        "security",
        "radios_sensors_pmic",
        "gpu_display_isp",
        "manufacturing_tapeout",
    }:
        assert domain_id in domain_ids
        assert f"sota_parity_domain_blocked_{domain_id}" in finding_codes

    strict = run_audit("--strict")
    assert strict.returncode == 2, strict.stdout[-4000:]
    assert "STATUS: BLOCKED sota_parity" in strict.stdout
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
