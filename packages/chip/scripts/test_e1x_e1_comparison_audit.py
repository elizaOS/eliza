from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_e1_comparison_audit_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_e1_comparison_audit.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_e1_comparison_audit.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X/E1 comparison audit" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["e1_comparison_basis"] == "open_2028_sota_160tops"
    assert summary["e1_baseline_local_sram_mib"] == 64.0
    assert summary["e1x_local_sram_mib"] == 8208.0
    assert summary["e1x_vs_e1_sram_ratio"] == 128.25
    assert summary["real_graph_model_required_mib"] == 7070.44775390625
    assert summary["model_required_vs_e1_sram"] == 110.47574615478516
    assert 0.86 < summary["model_required_vs_e1x_sram"] < 0.87
    assert summary["normal_total_cycles"] == 47_501_642_583
    assert summary["high_failure_total_cycles"] == 63_132_355_414
    assert summary["high_vs_normal_cycle_ratio"] == 1.3290562595533055
    assert summary["normal_decode_tokens_per_second"] == 41.22942668787203
    assert summary["high_failure_decode_tokens_per_second"] == 31.021324368584207
    assert 0.75 < summary["high_vs_normal_decode_tps_ratio"] < 0.76
    assert summary["peak_package_power_w"] == 4261.330943999999
    assert summary["peak_power_density_w_per_mm2"] == 0.0921867159329367
    assert summary["schedule_power_density_w_per_mm2"] < 0.001
    assert (
        summary["comparison_tuple_sha256"]
        == "1ae2297132e3a59f826898b9e5dd85cbe82f25b16c438b127a60bb53075fa082"
    )
    assert summary["residual_blocker"] == "comparison_is_architecture_model_not_silicon_benchmark"
