from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_clustered_repair_stress_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_clustered_repair_stress.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_clustered_repair_stress.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X clustered repair stress" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["logical_rows"] == 512
    assert summary["logical_cols"] == 342
    assert summary["spare_rows"] == 16
    assert summary["spare_cols"] == 16
    assert summary["spare_cores"] == 13_920
    assert summary["case_count"] == 5
    assert summary["repairable_case_count"] == 3
    assert summary["overload_case_count"] == 2
    assert summary["cross_stripe_remapped_cores"] == 13_408
    assert summary["cross_stripe_spare_margin"] == 512
    assert 0.96 < summary["cross_stripe_spare_utilization"] < 0.97
    assert summary["cross_stripe_vs_high_failure_remap_ratio"] > 3.8
    assert summary["high_failure_remapped_cores"] == 3_510
    assert (
        summary["stress_case_sha256"]
        == "3fc4dfdc8cecb4a182cef27b4dd9b72f72982041494c1f5a87a571a86786cd06"
    )
    assert summary["residual_blocker"] == "clustered_stress_is_architecture_model_not_foundry_yield"
