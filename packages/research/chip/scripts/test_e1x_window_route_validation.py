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
    flags = {key: value for key, value in report.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_touched_core_count"] == 151_367
    assert summary["window_neighbor_edge_count"] == 301_949
    assert summary["normal_window_extra_repair_hops"] == 167_619
    assert summary["high_failure_window_extra_repair_hops"] == 1_809_664
    assert summary["normal_window_max_repaired_neighbor_hops"] == 342
    assert summary["high_failure_window_max_repaired_neighbor_hops"] == 355
    assert summary["normal_window_remapped_neighbor_edges"] > 0
    assert summary["high_failure_window_remapped_neighbor_edges"] > 0
    assert summary["normal_window_route_checksum"] == 3_286_450_877_122_388_120
    assert summary["high_failure_window_route_checksum"] == 8_141_847_437_961_269_241
    assert summary["high_vs_normal_window_extra_hop_ratio"] > 10.0
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
