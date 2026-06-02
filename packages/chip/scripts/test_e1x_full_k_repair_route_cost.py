from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_k_repair_route_cost_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_k_repair_route_cost.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_full_k_repair_route_cost.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-K repair route cost" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["rung_count"] == 4
    assert summary["hyper_dense_normal_remapped_rows"] == 44
    assert summary["hyper_dense_high_failure_remapped_rows"] == 760
    assert summary["hyper_dense_high_failure_total_remap_distance"] > (
        summary["hyper_dense_normal_total_remap_distance"] * 5
    )
    assert summary["hyper_dense_high_failure_max_remap_distance"] >= 300
    assert summary["hyper_dense_high_failure_average_remap_distance"] > 100.0
    assert summary["hyper_dense_high_vs_normal_remap_distance_ratio"] > 5.0
    assert (
        summary["route_cost_ladder_sha256"]
        == "0580b6c27b4aa4347ffcf0e167b251cb1b6c85444947fb58dda5989d2ba5e1dc"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
