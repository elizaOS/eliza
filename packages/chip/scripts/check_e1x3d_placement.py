#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_placement_model import build_placement_report  # noqa: E402

REPORT = ROOT / "build/reports/e1x3d_placement.json"
EVIDENCE = ROOT / "benchmarks/results/e1x3d-placement-feasibility.json"


def main() -> int:
    artifact = build_placement_report()
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    block = artifact["tier_splits"]["block_sram_on_logic"]
    fine = artifact["tier_splits"]["fine_logic_fold"]
    checks = [
        {
            "id": "e1x3d_placement_gate_pass",
            "status": "pass" if artifact["gate"]["status"] == "PASS" else "fail",
            "detail": "; ".join(artifact["gate"]["reasons"]) or "placement feasibility gate passed",
        },
        {
            "id": "e1x3d_block_split_shrinks_xy",
            "status": "pass" if float(block["xy_footprint_shrink"]) >= 0.30 else "fail",
            "detail": f"block SRAM-on-logic XY footprint shrink {block['xy_footprint_shrink']}",
        },
        {
            "id": "e1x3d_block_split_fits_hybrid_bond",
            "status": "pass" if artifact["findings"]["block_fits_hybrid_bond"] else "fail",
            "detail": f"recommended bonding {block['recommended_bonding']} at "
            f"{block['required_via_density_per_mm2']}/mm2",
        },
        {
            "id": "e1x3d_fine_fold_has_feasible_bonding",
            "status": "pass" if fine["feasible_bondings"] else "fail",
            "detail": f"fine logic fold recommended bonding {fine['recommended_bonding']} at "
            f"{fine['required_via_density_per_mm2']}/mm2",
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-placement",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x3d",
        "claim_boundary": (
            "E1X3D analytic 3D-placement feasibility only: tier-partition XY footprint shrink, "
            "inter-tier via-density vs a bonding catalog, and Open3DBench wirelength delta. "
            "Not a placed layout, not 3D DRC/LVS, not electrothermal/SI-PI signoff. Real "
            "prototype path is Open3DBench / ORFS-Research; signoff is commercial-only and "
            "fails closed (see blocked_signoff_path in the evidence artifact)."
        ),
        "evidence_paths": [
            "compiler/runtime/e1x3d_placement_model.py",
            "benchmarks/results/e1x3d-placement-feasibility.json",
            "research/threed_ic_2026/02_analysis/3d_placement_benchmarks_yield_thermal.md",
        ],
        "checks": checks,
        "summary": {
            "block_xy_footprint_shrink": float(block["xy_footprint_shrink"]),
            "block_recommended_bonding": str(block["recommended_bonding"]),
            "block_required_via_density_per_mm2": float(block["required_via_density_per_mm2"]),
            "fine_recommended_bonding": str(fine["recommended_bonding"]),
            "fine_required_via_density_per_mm2": float(fine["required_via_density_per_mm2"]),
            "wirelength_delta_vs_planar": float(block["wirelength_delta_vs_planar"]),
            "thermal_status": str(artifact["thermal_status"]),
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X3D placement failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X3D placement; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
