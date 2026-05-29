from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_window_execution_trace_linkage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_window_execution_trace_linkage.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X window execution-trace linkage" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_window_execution_trace_linkage.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["normal_total_cycles"] == 47_501_642_583
    assert summary["high_failure_total_cycles"] == 63_132_355_414
    assert summary["high_vs_normal_trace_cycle_ratio"] > 1.3
    assert summary["high_vs_normal_repair_hop_penalty_ratio"] > 8.0
    assert summary["window_high_vs_normal_extra_hop_ratio"] > 35.0
    assert summary["normal_output_checksum"] == 8_263_636_289_739_888_019
    assert summary["high_failure_output_checksum"] == 3_419_781_716_949_080_192
    assert summary["normal_route_checks"] == 4_096
    assert summary["high_failure_route_checks"] == 8_192
    assert (
        summary["high_failure_repair_rom_sha256"]
        == "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
    )
    assert summary["high_failure_window_remap_word_count"] == 24
    assert summary["high_failure_window_route_checksum"] == 3_111_431_909_571_140_830
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
