from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_window_repair_rom_linkage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_window_repair_rom_linkage.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X window repair-ROM linkage" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_window_repair_rom_linkage.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_touched_core_count"] == 1_169
    assert summary["normal_window_remap_word_count"] == 2
    assert summary["high_failure_window_remap_word_count"] == 24
    assert (
        summary["normal_window_remap_words_sha256"]
        == "0fe16d68b1eb8fcb455a6e2268390b69e2180b988eda59f98d7d917c0565adf4"
    )
    assert (
        summary["high_failure_window_remap_words_sha256"]
        == "9c1b36917508a10a43b22210e13945a189a96f1571e4fcee06a92e4fc14af3c4"
    )
    assert (
        summary["normal_repair_rom_sha256"]
        == "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
    )
    assert (
        summary["high_failure_repair_rom_sha256"]
        == "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
    )
    assert summary["normal_rom_total_word_count"] == 412
    assert summary["high_failure_rom_total_word_count"] == 3_582
    assert summary["repair_rom_cocotb_testcases"] >= 16
    assert summary["boot_verified_rom_case_count"] == 3
    assert summary["window_route_high_failure_checksum"] == 3_111_431_909_571_140_830
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
