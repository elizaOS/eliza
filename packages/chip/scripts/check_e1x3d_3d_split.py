#!/usr/bin/env python3
"""Gate: E1X3D 2-tier pseudo-3D split feasibility.

Builds the ``eliza.e1x3d.tier_split_manifest.v1`` manifest and PASSES when the
two-tier (logic + memory) partition is physically feasible: the XY footprint
shrink from moving SRAM off the logic plane lands in the documented range and at
least one catalog bonding (face-to-face hybrid bond or MIV) carries the required
inter-tier via density. The per-tier open-PDK (Sky130) signoff status for each
tier is recorded for audit.

True 3D DRC/LVS across the bonded inter-tier interface is commercial-only and is
recorded as a documented BLOCKED escalation with its proving command -- the
fail-closed law. The split-feasibility claim (this gate's PASS) is independent
of and never substitutes for that 3D signoff.

Writes ``eliza.gate_status.v1`` to build/reports/e1x3d_3d_split.json.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.generate_e1x3d_tier_split_manifest import (  # noqa: E402
    EVIDENCE,
    build_tier_split_manifest,
)

REPORT = ROOT / "build/reports/e1x3d_3d_split.json"

# Documented footprint-shrink envelope for the block SRAM-on-logic split: the
# Open3DBench two-tier folded-2D point is ~ -36% to -64%; below 0.25 the split is
# not worth the bond cost, above 0.70 the modeled area is implausible.
SHRINK_MIN = 0.25
SHRINK_MAX = 0.70


def main() -> int:
    artifact = build_tier_split_manifest()
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    footprint = artifact["footprint"]
    interface = artifact["inter_tier_interface"]
    feasibility = artifact["feasibility"]
    logic_tier, memory_tier = artifact["tiers"]
    shrink = float(footprint["xy_footprint_shrink"])
    shrink_ok = SHRINK_MIN <= shrink <= SHRINK_MAX
    bonding_ok = bool(feasibility["bonding_feasible"])

    checks = [
        {
            "id": "e1x3d_3d_split_footprint_shrink_in_range",
            "status": "pass" if shrink_ok else "fail",
            "detail": (
                f"two-tier XY footprint shrink {shrink} "
                f"({footprint['planar_2d_mm2']} -> {footprint['stacked_3d_mm2']} mm2), "
                f"required in [{SHRINK_MIN}, {SHRINK_MAX}]"
            ),
        },
        {
            "id": "e1x3d_3d_split_bonding_feasible",
            "status": "pass" if bonding_ok else "fail",
            "detail": (
                f"inter-tier interface {interface['bonding']} ({interface['kind']}) carries "
                f"{interface['required_via_density_per_mm2']}/mm2 vias at margin "
                f"{interface['via_density_margin']}"
            ),
        },
        {
            "id": "e1x3d_3d_split_logic_tier_open_pdk_signoff",
            "status": "pass" if logic_tier["signoff_run"]["status"] == "complete" else "blocked",
            "detail": (
                f"logic tier {logic_tier['signoff_run']['design_name']} open-PDK signoff "
                f"{logic_tier['signoff_run']['status']} "
                f"(run {logic_tier['signoff_run']['run_path']}, furthest stage "
                f"{logic_tier['signoff_run']['furthest_stage']})"
            ),
        },
        {
            "id": "e1x3d_3d_split_memory_tier_open_pdk_signoff",
            "status": "pass" if memory_tier["signoff_run"]["status"] == "complete" else "blocked",
            "detail": (
                f"memory tier {memory_tier['signoff_run']['design_name']} open-PDK signoff "
                f"{memory_tier['signoff_run']['status']} "
                f"(run {memory_tier['signoff_run']['run_path']}, furthest stage "
                f"{memory_tier['signoff_run']['furthest_stage']})"
            ),
        },
        {
            "id": "e1x3d_3d_drc_lvs_commercial_only",
            "status": "blocked",
            "detail": (
                f"{artifact['blocked_3d_signoff_path']['missing_dependency']} "
                f"Proving command: {artifact['blocked_3d_signoff_path']['proving_command']}."
            ),
        },
    ]

    # PASS gates the split-feasibility claim only (footprint shrink + bonding).
    # The per-tier open-PDK signoff status and the commercial-only 3D DRC/LVS are
    # recorded for audit and escalation; the latter is a documented BLOCKED step
    # that does not block the feasibility claim it is distinct from.
    feasibility_failures = [
        check
        for check in checks
        if check["id"]
        in {"e1x3d_3d_split_footprint_shrink_in_range", "e1x3d_3d_split_bonding_feasible"}
        and check["status"] != "pass"
    ]
    blocked_escalations = [check for check in checks if check["status"] == "blocked"]
    status = "PASS" if not feasibility_failures else "BLOCKED"

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-3d-split",
        "status": status,
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "subsystem": "e1x3d",
        "claim_boundary": (
            "E1X3D 2-tier pseudo-3D split feasibility only: logic-tier + memory(SRAM)-tier "
            "partition with an XY footprint shrink in range, a feasible inter-tier bonding "
            "(face-to-face hybrid bond or MIV per the catalog), and per-tier open-PDK (Sky130) "
            "signoff references. Not a placed 3D layout. Cross-tier 3D DRC/LVS, electrothermal, "
            "and SI/PI across the bonded interface are commercial-only and fail closed (see "
            "blocked_3d_signoff_path in the manifest)."
        ),
        "evidence_paths": [
            "compiler/runtime/e1x3d_placement_model.py",
            "scripts/generate_e1x3d_tier_split_manifest.py",
            "benchmarks/results/e1x3d-tier-split-manifest.json",
            "research/threed_ic_2026/02_analysis/3d_placement_benchmarks_yield_thermal.md",
        ],
        "checks": checks,
        "blocked_escalation": {
            "missing_dependency": artifact["blocked_3d_signoff_path"]["missing_dependency"],
            "proving_command": artifact["blocked_3d_signoff_path"]["proving_command"],
        },
        "summary": {
            "split_style": str(artifact["split_style"]),
            "xy_footprint_shrink": shrink,
            "planar_2d_mm2": float(footprint["planar_2d_mm2"]),
            "stacked_3d_mm2": float(footprint["stacked_3d_mm2"]),
            "logic_tier_area_mm2": float(logic_tier["area_mm2"]),
            "memory_tier_area_mm2": float(memory_tier["area_mm2"]),
            "inter_tier_bonding": str(interface["bonding"]),
            "inter_tier_kind": str(interface["kind"]),
            "required_via_density_per_mm2": float(interface["required_via_density_per_mm2"]),
            "via_density_margin": float(interface["via_density_margin"]),
            "logic_tier_signoff_status": str(logic_tier["signoff_run"]["status"]),
            "memory_tier_signoff_status": str(memory_tier["signoff_run"]["status"]),
            "tier_split_manifest_sha256": str(artifact["artifact_sha256"]),
            "check_count": len(checks),
            "feasibility_failing_check_count": len(feasibility_failures),
            "blocked_escalation_count": len(blocked_escalations),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if feasibility_failures:
        print("BLOCKED: E1X3D 3D split failed: " + ", ".join(c["id"] for c in feasibility_failures))
        return 1
    print(
        f"PASS: E1X3D 2-tier split feasible (shrink {shrink}, bonding {interface['bonding']}); "
        f"3D DRC/LVS escalation BLOCKED (commercial-only); report {REPORT.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
