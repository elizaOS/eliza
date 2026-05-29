from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_repair_fuse_reader_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_repair_fuse_reader.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X repair fuse reader" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_repair_fuse_reader.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-repair-fuse-reader"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["rom_case_count"] == 3
    assert report["summary"]["production_fuse_window_words"] == 4096
    assert report["summary"]["max_streamed_word_count"] == 3582
    assert report["summary"]["max_streamed_word_count_vs_window"] < 1.0
    assert report["summary"]["rtl_marker_count"] == 10
    assert report["summary"]["loader_marker_count"] == 5
    assert report["summary"]["verilator_lint_clean"] is True
    assert report["summary"]["residual_blocker"] == "silicon_fuse_burning_and_foundry_otp_macro_missing"
    assert "not silicon fuse burning" in report["claim_boundary"]
