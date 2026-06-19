from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_repair_capacity_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_repair_capacity.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X repair capacity" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_repair_capacity.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-repair-capacity"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["rom_case_count"] == 3
    assert report["summary"]["max_remap_entries"] == 3510
    assert report["summary"]["max_route_entries"] == 64
    assert report["summary"]["max_total_words"] == 3582
    assert report["summary"]["production_fuse_window_words"] == 4096
    assert report["summary"]["production_remap_entries"] == 4096
    assert report["summary"]["production_route_entries"] == 64
    assert report["summary"]["production_dedicated_repair_sram_bytes"] <= 48 * 1024
