from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_credit_router_cocotb_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_credit_router_cocotb.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X credit-router cocotb" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_credit_router_cocotb.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-credit-router-cocotb"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["testcases"] == 8
    assert report["summary"]["failures"] == 0
    assert report["summary"]["errors"] == 0
