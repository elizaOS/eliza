from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_reduction_merge_cocotb_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_reduction_merge_cocotb.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X reduction-merge cocotb" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_reduction_merge_cocotb.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["testcases"] == 5
    assert summary["expected_test_count"] == 5
    assert summary["failures"] == 0
    assert summary["errors"] == 0
    assert summary["missing_expected_tests"] == 0
    assert summary["failing_check_count"] == 0
    assert summary["residual_blocker"] == "vectorized_full_tensor_fabric_executor_missing"
