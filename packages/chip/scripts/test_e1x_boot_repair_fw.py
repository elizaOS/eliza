from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_boot_repair_fw_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_boot_repair_fw.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X boot repair fw" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_boot_repair_fw.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["blocked_check_count"] == 0
    assert report["summary"]["native_verification_passed"] is True
    assert report["summary"]["verified_rom_case_count"] == 3
    cases = {case["case"]: case for case in report["summary"]["rom_cases"]}
    assert cases["scaled_high_failure"]["route_count"] == 64
    assert cases["real_graph_normal"]["rom_word_count"] == 412
    assert cases["real_graph_high_failure"]["rom_word_count"] == 3582
