from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_real_weight_coverage_ladder_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_real_weight_coverage_ladder.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_real_weight_coverage_ladder.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X real-weight coverage ladder" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["component_count"] == 7
    assert summary["represented_layer_count"] == 283
    assert summary["represented_output_row_count"] == 2_608_640
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["represented_row_coverage_fraction"] == 1.0
    assert summary["executed_real_weight_mac_count"] == 83_317_760
    assert summary["represented_full_k_mac_count"] == 13_015_864_320
    assert summary["full_mac_count"] == 13_015_864_320
    assert 0.006 < summary["executed_mac_coverage_fraction"] < 0.007
    assert summary["represented_full_k_mac_fraction"] == 1.0
    assert summary["missing_full_k_real_weight_mac_count"] == 12_932_546_560
    assert summary["repaired_touched_logical_core_count"] == 151_367
    assert summary["repaired_high_failure_remapped_rows"] == 54_211
    assert (
        summary["coverage_components_sha256"]
        == "e0b869c2f4976674d9bd0570f3b7b2be879cdc91169d524002bd46df44e73938"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
