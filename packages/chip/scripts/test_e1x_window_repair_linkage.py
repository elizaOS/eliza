from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_window_repair_linkage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_window_repair_linkage.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X window-repair linkage" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_window_repair_linkage.json").read_text())
    assert report["status"] == "PASS"
    flags = {key: value for key, value in report.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_touched_core_count"] == 151_367
    assert (
        summary["window_touched_core_sha256"]
        == "fc1928d24739ad1ee15f2c5d866850aa12cec35555fcc11109917898e42b0e6b"
    )
    assert summary["normal_window_remapped_core_count"] == 279
    assert summary["high_failure_window_remapped_core_count"] == 3_012
    assert summary["normal_window_direct_core_count"] == 151_088
    assert summary["high_failure_window_direct_core_count"] == 148_355
    assert summary["normal_total_remapped_core_count"] == 340
    assert summary["high_failure_total_remapped_core_count"] == 3_510
    assert summary["window_high_vs_normal_remap_ratio"] > 10.0
    assert summary["routed_window_checksum"] == 4_718_384_912_712_357_942
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
