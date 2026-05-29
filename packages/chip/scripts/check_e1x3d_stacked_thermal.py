#!/usr/bin/env python3
"""Gate for the first-order STACKED electrothermal model of E1X3D.

Generates the ``eliza.e1x3d.stacked_electrothermal.v1`` artifact (vertical theta
network across the E1X3D physical Z stack + per-tier temperature-dependent
leakage fixed point) and emits an ``eliza.gate_status.v1`` verdict to
``build/reports/e1x3d_stacked_thermal.json``.

PASS iff, for the modeled config, the coupled leakage/temperature fixed point is
stable (no thermal runaway) AND every physical tier's modeled junction
temperature is <= ``max_junction_temp_c`` AND every tier's modeled power density
is <= the per-tier ceiling. Otherwise BLOCKED.

This is a PLANNING-GRADE gate. It never claims thermal margin or signoff. It
ALWAYS records the residual blocked dependency: real stacked electrothermal
signoff needs a calibrated package/board thermal model and a foundry leakage
model (commercial: Ansys RedHawk-SC Electrothermal, Cadence Celsius), with the
proving command that would close it.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_wafer_model import E1X3DConfig, artifact_sha256  # noqa: E402
from scripts.generate_e1x3d_stacked_thermal import (  # noqa: E402
    DEFAULT_OUTPUT,
    SCHEMA,
    stacked_coanalyze,
)

REPORT = ROOT / "build/reports/e1x3d_stacked_thermal.json"

# Real stacked electrothermal signoff is commercial-only and has no open path;
# this dependency is recorded on every run, PASS or BLOCKED, so the planning
# verdict never masquerades as signoff.
RESIDUAL_BLOCKER = {
    "id": "e1x3d_stacked_electrothermal_signoff",
    "missing_dependency": (
        "Calibrated package/board thermal model + foundry leakage model + calibrated "
        "stacked electrothermal co-simulation (commercial: Ansys RedHawk-SC "
        "Electrothermal, Cadence Celsius / Sigrity). The vertical theta network and "
        "leakage coefficient here are documented engineering assumptions anchored to a "
        "phone-class theta budget, not extracted resistances or a foundry leakage deck."
    ),
    "proving_command": (
        "extract per-tier stack thermal resistances from a calibrated package thermal "
        "model and a foundry leakage model, then run RedHawk-SC Electrothermal / Celsius "
        "stacked electrothermal co-simulation on the placed 3D design"
    ),
}


def _evaluate(artifact: dict[str, object]) -> tuple[list[dict[str, str]], dict[str, object]]:
    fit = artifact["fit"]
    totals = artifact["totals"]
    per_tier = artifact["per_tier"]
    assert isinstance(fit, dict) and isinstance(totals, dict) and isinstance(per_tier, list)

    stable = not bool(fit["thermal_runaway"]) and bool(fit["fixed_point_converged"])
    tj_ok = bool(fit["all_tier_junction_le_max"])
    density_ok = bool(fit["all_tier_density_le_ceiling"])
    over_tj = [
        f"z{entry['z']}/{entry['kind']}={entry['converged_junction_c']}C"
        for entry in per_tier
        if not bool(entry["junction_le_max"])
    ]
    over_density = [
        f"z{entry['z']}/{entry['kind']}={entry['power_density_w_per_mm2']}W/mm2"
        for entry in per_tier
        if not bool(entry["density_le_ceiling"])
    ]

    checks = [
        {
            "id": "e1x3d_stacked_thermal_artifact_schema",
            "status": "pass" if artifact["schema"] == SCHEMA else "fail",
            "detail": f"schema {artifact['schema']}",
        },
        {
            "id": "e1x3d_stacked_thermal_fixed_point_stable",
            "status": "pass" if stable else "fail",
            "detail": (
                f"converged={fit['fixed_point_converged']} runaway={fit['thermal_runaway']} "
                f"iterations={artifact['model_assumptions']['fixed_point_iterations_run']}"
            ),
        },
        {
            "id": "e1x3d_stacked_thermal_all_tier_junction_le_max",
            "status": "pass" if tj_ok else "fail",
            "detail": (
                f"max_junction={totals['max_junction_c']}C <= {totals['max_junction_temp_c']}C"
                if tj_ok
                else "over-limit tiers: " + ", ".join(over_tj)
            ),
        },
        {
            "id": "e1x3d_stacked_thermal_all_tier_density_le_ceiling",
            "status": "pass" if density_ok else "fail",
            "detail": (
                f"all tier densities <= {totals['tier_power_density_ceiling_w_per_mm2']}W/mm2"
                if density_ok
                else "over-ceiling tiers: " + ", ".join(over_density)
            ),
        },
    ]
    summary = {
        "chip": str(artifact["chip"]),
        "physical_tiers": len(per_tier),
        "max_junction_c": float(totals["max_junction_c"]),
        "max_junction_temp_c": float(totals["max_junction_temp_c"]),
        "hottest_tier_z": int(totals["hottest_tier_z"]),
        "hottest_tier_kind": str(totals["hottest_tier_kind"]),
        "tier_power_density_ceiling_w_per_mm2": float(
            totals["tier_power_density_ceiling_w_per_mm2"]
        ),
        "fixed_point_converged": bool(fit["fixed_point_converged"]),
        "thermal_runaway": bool(fit["thermal_runaway"]),
    }
    return checks, summary


def main() -> int:
    artifact = stacked_coanalyze(E1X3DConfig())
    DEFAULT_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_OUTPUT.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    checks, summary = _evaluate(artifact)
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-stacked-thermal",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "subsystem": "e1x3d",
        "claim_boundary": (
            "E1X3D first-order STACKED electrothermal planning model only: a vertical "
            "theta network across the physical Z stack (logic tiers as heat sources, "
            "memory tiers as cool buffers, buried-tier penalty, dual-sided cooling) with "
            "a per-tier temperature-dependent leakage fixed point. Theta resistances and "
            "the leakage coefficient are documented engineering assumptions anchored to a "
            "phone-class theta budget, NOT extracted from a package thermal model, foundry "
            "leakage model, TCAD, or silicon. Not electrothermal signoff; the residual "
            "BLOCKED dependency is recorded on every run."
        ),
        "evidence_paths": [
            "scripts/generate_e1x3d_stacked_thermal.py",
            str(DEFAULT_OUTPUT.relative_to(ROOT)),
            "scripts/electrothermal_coanalysis.py",
            "research/threed_ic_2026/02_analysis/3d_placement_benchmarks_yield_thermal.md",
            "research/threed_ic_2026/03_implementation/e1x3d_design_decisions.md",
        ],
        "checks": checks,
        "stacked_electrothermal_artifact_sha256": str(artifact["artifact_sha256"]),
        "residual_blocked_dependency": RESIDUAL_BLOCKER,
        "summary": {
            **summary,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    report["report_sha256"] = artifact_sha256(report)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if failures:
        print(
            "BLOCKED: E1X3D stacked electrothermal: "
            + ", ".join(c["id"] for c in failures)
            + f" (planning-grade; residual signoff blocker recorded -> {REPORT.relative_to(ROOT)})"
        )
        return 1
    print(
        f"PASS: E1X3D stacked electrothermal (planning-grade, prohibited_until_external_review); "
        f"report {REPORT.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
