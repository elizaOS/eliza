#!/usr/bin/env python3
"""Regression tests for the product release status report artifact."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/product_release_status.json"


def run_product_check(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", "scripts/product_check.py", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_report() -> dict[str, object]:
    return json.loads(REPORT.read_text(encoding="utf-8"))


def assert_blocked_report(report: dict[str, object], *, release_mode: bool) -> None:
    assert report["schema"] == "eliza.product_release_status.v1"
    assert report["status"] == "blocked"
    assert report["release_mode"] is release_mode
    assert isinstance(report["release_blockers"], list)
    assert report["release_blockers"]
    assert report["claim_boundary"]
    findings = report.get("findings")
    assert isinstance(findings, list)
    assert findings
    codes = [finding["code"] for finding in findings if isinstance(finding, dict)]
    assert any(code.startswith("product_release_blocker_") for code in codes)

    detail_checks = report["detail_checks"]
    assert isinstance(detail_checks, dict)
    assert "pd_signoff" in detail_checks
    assert "manufacturing_release" in detail_checks
    assert "release_checks" in detail_checks


def main() -> int:
    scaffold = run_product_check()
    assert scaffold.returncode == 0, scaffold.stdout[-4000:]
    assert "release blockers remain documented" in scaffold.stdout
    assert_blocked_report(load_report(), release_mode=False)

    release = run_product_check("--release")
    assert release.returncode == 1, release.stdout[-4000:]
    assert "product release check failed" in release.stdout
    assert_blocked_report(load_report(), release_mode=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
