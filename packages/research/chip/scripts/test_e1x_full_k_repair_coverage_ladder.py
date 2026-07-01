from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_k_repair_coverage_ladder_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_k_repair_coverage_ladder.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_full_k_repair_coverage_ladder.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-K repair coverage ladder" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["rung_count"] == 4
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["full_mac_count"] == 13_015_864_320
    assert summary["max_repaired_full_k_row_count"] == 36_224
    assert summary["max_repaired_full_k_mac_count"] == 176_957_568
    assert 0.013 < summary["max_repaired_full_k_row_fraction"] < 0.014
    assert 0.013 < summary["max_repaired_full_k_mac_fraction"] < 0.014
    assert summary["missing_full_k_output_row_count"] == 2_572_416
    assert summary["missing_full_k_mac_count"] == 12_838_906_752
    assert summary["row_gain_vs_first_rung"] == 8.0
    assert summary["mac_gain_vs_first_rung"] == 8.0
    assert summary["max_touched_logical_core_count"] == 25_937
    assert summary["max_high_failure_touched_remapped_rows"] == 760
    assert (
        summary["rung_summary_sha256"]
        == "d9f0a9cffa3338ba27f2f4996bd9082c6a38d5bb7ccdb9fd6ee85eb8e2f9bcd9"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
