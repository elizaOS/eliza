from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_dft_cocotb_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_dft_cocotb.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X DFT cocotb" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_dft_cocotb.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    # 4 ECC tests + 3 MBIST tests.
    assert report["summary"]["testcases"] == 7
    assert report["summary"]["failures"] == 0
    assert report["summary"]["errors"] == 0


def test_e1x_dft_strategy_doc_complete() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_dft_strategy.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: e1x-dft strategy doc" in result.stdout
