from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_window_route_validation_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_window_route_validation.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X window route validation" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_window_route_validation.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_touched_core_count"] == 1_169
    assert summary["window_neighbor_edge_count"] == 963
    assert summary["normal_window_extra_repair_hops"] == 185
    assert summary["high_failure_window_extra_repair_hops"] == 6_571
    assert summary["normal_window_max_repaired_neighbor_hops"] == 68
    assert summary["high_failure_window_max_repaired_neighbor_hops"] == 336
    assert summary["normal_window_remapped_neighbor_edges"] == 3
    assert summary["high_failure_window_remapped_neighbor_edges"] == 36
    assert summary["normal_window_route_checksum"] == 3_872_734_020_467_319_908
    assert summary["high_failure_window_route_checksum"] == 3_111_431_909_571_140_830
    assert summary["high_vs_normal_window_extra_hop_ratio"] > 35.0
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
