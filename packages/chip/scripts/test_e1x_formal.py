from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_formal_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_formal.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X formal" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_formal.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-formal"
    assert report["status"] == "PASS"
    assert report["generated_utc"].endswith("Z")
    assert report["summary"]["failing_check_count"] == 0
    # Mesh router + credit router + repair-route-table + repair-state,
    # each with bmc and k-induction.
    assert report["summary"]["check_count"] == 8
    assert all(c["status"] == "pass" for c in report["checks"])
    check_ids = {c["id"] for c in report["checks"]}
    assert "e1x_formal_credit_router_bmc" in check_ids
    assert "e1x_formal_credit_router_prove" in check_ids
    modes = {c["mode"] for c in report["checks"]}
    assert modes == {"bmc", "k-induction"}
