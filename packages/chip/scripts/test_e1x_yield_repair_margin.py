from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_yield_repair_margin_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_yield_repair_margin.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X yield repair margin" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_yield_repair_margin.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-yield-repair-margin"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["case_count"] == 2
    assert report["summary"]["normal_remapped_cores"] == 340
    assert report["summary"]["high_failure_remapped_cores"] == 3510
    assert report["summary"]["high_failure_spare_margin"] == 10_410
    assert report["summary"]["high_failure_spare_utilization"] < 0.5
    assert report["summary"]["high_failure_route_checks"] == 8192
    assert report["summary"]["high_vs_normal_remap_ratio"] > 10.0
