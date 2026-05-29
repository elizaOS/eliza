from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_power_thermal_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_power_thermal.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X power/thermal" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_power_thermal.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-power-thermal"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["logical_cores"] == 175_104
    assert report["summary"]["local_sram_mib"] == 8208.0
    assert 0.0 < report["summary"]["model_required_vs_sram"] < 1.0
    assert report["summary"]["peak_int8_tops"] > 5000.0
    assert report["summary"]["peak_package_power_w"] < report["summary"]["cooling_envelope_w"]
    assert report["summary"]["peak_power_density_w_per_mm2"] < 0.5
    assert 0.0 < report["summary"]["schedule_energy_j"] < 1.0
    assert 0.0 < report["summary"]["schedule_average_power_w"] < report["summary"]["peak_package_power_w"]
