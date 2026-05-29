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
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_touched_core_count"] == 1_169
    assert (
        summary["window_touched_core_sha256"]
        == "1e05a2dbd9ff2b80f93060da822e8cc8cddcebde7ec6f3be11634e22774374a3"
    )
    assert summary["normal_window_remapped_core_count"] == 2
    assert summary["high_failure_window_remapped_core_count"] == 24
    assert summary["normal_window_direct_core_count"] == 1_167
    assert summary["high_failure_window_direct_core_count"] == 1_145
    assert summary["normal_total_remapped_core_count"] == 340
    assert summary["high_failure_total_remapped_core_count"] == 3_510
    assert summary["window_high_vs_normal_remap_ratio"] == 12.0
    assert summary["routed_window_checksum"] == 15_818_110_737_476_397_592
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
