from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_mesh_liveness_evidence_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_mesh_liveness_evidence.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X mesh liveness evidence" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_mesh_liveness_evidence.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["mesh_fabric_testcases"] >= 4
    assert report["summary"]["credit_router_testcases"] >= 8
    assert report["summary"]["formal_check_count"] >= 8
    assert report["summary"]["expected_mesh_test_count"] == 4
    assert report["summary"]["mesh_route_marker_count"] == 8
    assert report["summary"]["credit_route_marker_count"] == 6
    assert report["summary"]["formal_safety_marker_count"] == 6
    assert report["summary"]["residual_blocker"] == "full_formal_network_liveness_proof_missing"
    assert "not a full network-level formal liveness" in report["claim_boundary"]
