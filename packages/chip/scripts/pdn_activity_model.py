#!/usr/bin/env python3
"""Vectorless per-block dynamic-IR activity budget for the E1 PDN.

Reads the planning activity table (``docs/spec-db/pdn-activity-model.yaml``) and
the per-rail peak currents in ``docs/pd/rail-plan-2028.yaml``, and derives a
worst-case vectorless dynamic-IR current budget per rail:

    dynamic_current_a = peak_a * activity_factor * simultaneous_switch_factor
    budget_a          = dynamic_current_a * dynamic_margin_factor   (2.0x)

This sizes the dynamic-IR budget the PDN signoff gate mandates
("worst-case vectorless dynamic + 2x margin"). It is a planning model: every
number is derived from rail-plan currents and clearly-labeled engineering
toggle assumptions, never from a VCD/SAIF or measured silicon. The budget is
what a later commercial vector-driven dynamic-IR run (Voltus / RedHawk-SC) must
confirm; this model never claims signoff.

CLI:
  python3 scripts/pdn_activity_model.py            # write JSON budget report
  python3 scripts/pdn_activity_model.py --check    # validate model, fail closed
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ACTIVITY_MODEL = ROOT / "docs" / "spec-db" / "pdn-activity-model.yaml"
RAIL_PLAN = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
DROOP_SCHEMA = ROOT / "pd" / "signoff" / "pdn-current" / "package-droop-activity-schema.yaml"
REPORT_PATH = ROOT / "build" / "reports" / "pdn_activity_budget.json"
DROOP_REPORT_PATH = ROOT / "build" / "reports" / "pdn_package_droop.json"
SCHEMA = "eliza.pdn_activity_model.v1"
DROOP_SCHEMA_ID = "eliza.pdn_package_droop.v1"
CLAIM_BOUNDARY = "vectorless_dynamic_ir_planning_budget_no_vcd_or_silicon_claim"
DROOP_CLAIM_BOUNDARY = (
    "first_order_package_droop_planning_estimate_no_extracted_pdn_or_silicon_claim"
)


@dataclass(frozen=True)
class BlockBudget:
    rail: str
    block: str
    peak_a: float
    activity_factor: float
    simultaneous_switch_factor: float
    dynamic_current_a: float
    budget_a: float
    folded_into_rail: str | None


def _rail_peak_currents() -> dict[str, float]:
    plan = yaml.safe_load(RAIL_PLAN.read_text(encoding="utf-8")) or {}
    return {
        r["id"]: float(r["peak_a"])
        for r in plan.get("rails", [])
        if isinstance(r, dict) and "id" in r and "peak_a" in r
    }


def _rail_voltages() -> dict[str, dict[str, float]]:
    plan = yaml.safe_load(RAIL_PLAN.read_text(encoding="utf-8")) or {}
    out: dict[str, dict[str, float]] = {}
    for r in plan.get("rails", []):
        if isinstance(r, dict) and "id" in r and "nominal_v" in r:
            nominal = float(r["nominal_v"])
            out[str(r["id"])] = {
                "nominal_v": nominal,
                "dvfs_min_v": float(r["dvfs_min_v"]) if "dvfs_min_v" in r else nominal,
            }
    return out


def build_budget() -> tuple[dict[str, object], list[str]]:
    blockers: list[str] = []
    model = yaml.safe_load(ACTIVITY_MODEL.read_text(encoding="utf-8")) or {}
    if model.get("schema") != SCHEMA:
        blockers.append(f"{ACTIVITY_MODEL.relative_to(ROOT)} schema must be {SCHEMA}")
    if model.get("release_use") != "prohibited_until_external_review":
        blockers.append("pdn-activity-model release_use must stay prohibited_until_external_review")

    assumptions = model.get("assumptions") or {}
    margin = float(assumptions.get("dynamic_margin_factor", 0.0))
    if margin < 2.0:
        blockers.append(f"dynamic_margin_factor {margin} < required 2.0 (gate waiver penalty)")

    peak_currents = _rail_peak_currents()
    rows: list[BlockBudget] = []
    for entry in model.get("blocks", []) or []:
        if not isinstance(entry, dict):
            blockers.append("blocks entries must be mappings")
            continue
        rail = str(entry.get("rail", ""))
        block = str(entry.get("block", "<unnamed>"))
        af = float(entry.get("activity_factor", -1))
        ssf = float(entry.get("simultaneous_switch_factor", -1))
        folded_raw = entry.get("folded_into_rail")
        folded = str(folded_raw) if folded_raw else None
        if not 0.0 <= af <= 1.0:
            blockers.append(f"{block}: activity_factor {af} out of [0,1]")
        if not 0.0 <= ssf <= 1.0:
            blockers.append(f"{block}: simultaneous_switch_factor {ssf} out of [0,1]")
        # A folded block draws on its host rail; its own rail id need not be a
        # standalone rail-plan rail.
        lookup_rail = folded if folded else rail
        peak = peak_currents.get(lookup_rail)
        if peak is None:
            blockers.append(f"{block}: rail {lookup_rail} not found in rail plan peak_a table")
            continue
        dynamic = peak * af * ssf
        rows.append(
            BlockBudget(
                rail=rail,
                block=block,
                peak_a=peak,
                activity_factor=af,
                simultaneous_switch_factor=ssf,
                dynamic_current_a=round(dynamic, 4),
                budget_a=round(dynamic * margin, 4),
                folded_into_rail=folded,
            )
        )

    # Aggregate per host rail (fold folded blocks onto their host).
    per_rail: dict[str, float] = {}
    for row in rows:
        host = row.folded_into_rail or row.rail
        per_rail[host] = round(per_rail.get(host, 0.0) + row.budget_a, 4)

    report = {
        "schema": SCHEMA,
        "as_of": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "claim_boundary": CLAIM_BOUNDARY,
        "provenance": "rail_plan_peak_a_x_engineering_toggle_assumptions",
        "dynamic_margin_factor": margin,
        "blocks": [
            {
                "rail": r.rail,
                "block": r.block,
                "peak_a": r.peak_a,
                "activity_factor": r.activity_factor,
                "simultaneous_switch_factor": r.simultaneous_switch_factor,
                "vectorless_dynamic_current_a": r.dynamic_current_a,
                "dynamic_ir_budget_a_with_margin": r.budget_a,
                "folded_into_rail": r.folded_into_rail,
            }
            for r in rows
        ],
        "per_host_rail_dynamic_ir_budget_a": dict(sorted(per_rail.items())),
        "release_use": "prohibited_until_external_review",
        "blockers": blockers,
    }
    return report, blockers


def _rail_decoupling() -> dict[str, dict[str, float]]:
    plan = yaml.safe_load(RAIL_PLAN.read_text(encoding="utf-8")) or {}
    out: dict[str, dict[str, float]] = {}
    for r in plan.get("rails", []):
        if isinstance(r, dict) and "id" in r and isinstance(r.get("decoupling_nf"), dict):
            d = r["decoupling_nf"]
            out[r["id"]] = {
                "on_die_nf": float(d.get("on_die_target", 0)),
                "package_nf": float(d.get("package_target", 0)),
                "board_nf": float(d.get("board_target", 0)),
            }
    return out


def build_droop() -> tuple[dict[str, object], list[str]]:
    """First-order package-aware droop estimate per di/dt scenario.

    Couples the package/board loop inductance with the on-die decap network as a
    first-order L-C tank. For a current step dI the transient droop is bounded by

        V_droop = dI * Z0 + dI * decap_ESR,   Z0 = sqrt(L_loop / C_on_die)

    where Z0 is the characteristic impedance of the package-inductance /
    on-die-decap loop (the standard first-order PDN droop estimate). L_loop is
    the package + board loop inductance; C_on_die is the on-die decap that
    responds within the di/dt window; dI is the vectorless dynamic current step
    (pre-margin) from the activity budget; decap_ESR is the package decap ESR.
    Every input is a package/board-class engineering assumption or a rail-plan
    target, never extracted PDN or silicon.
    """
    blockers: list[str] = []
    schema_doc = yaml.safe_load(DROOP_SCHEMA.read_text(encoding="utf-8")) or {}
    if schema_doc.get("schema") != DROOP_SCHEMA_ID:
        blockers.append(f"{DROOP_SCHEMA.relative_to(ROOT)} schema must be {DROOP_SCHEMA_ID}")
    if schema_doc.get("release_use") != "prohibited_until_external_review":
        blockers.append(
            "package-droop schema release_use must stay prohibited_until_external_review"
        )

    par = schema_doc.get("parasitic_assumptions") or {}
    bga_l_ph = float(par.get("bga_ball_loop_l_ph_per_rail", 0))
    bond_l_ph = float(par.get("bond_wire_l_ph_if_wirebond", 0))
    board_l_ph = float(par.get("board_plane_l_ph", 0))
    esr_pkg_mohm = float(par.get("decap_esr_mohm_package", 0))
    wirebond = par.get("packaging") == "wirebond"
    loop_l_h = (bga_l_ph + (bond_l_ph if wirebond else 0.0) + board_l_ph) * 1e-12

    accept = schema_doc.get("droop_acceptance") or {}
    max_droop_pct = float(accept.get("max_transient_droop_pct_of_nominal", 10.0))
    must_stay_above_min = bool(accept.get("must_stay_above_dvfs_min_v", True))

    budget_report, budget_blockers = build_budget()
    blockers.extend(budget_blockers)
    dyn_step: dict[str, float] = {}
    blocks = budget_report.get("blocks", [])
    assert isinstance(blocks, list)
    for b in blocks:
        host = b.get("folded_into_rail") or b.get("rail")
        dyn_step[host] = dyn_step.get(host, 0.0) + float(b["vectorless_dynamic_current_a"])

    voltages = _rail_voltages()
    decoupling = _rail_decoupling()
    rows = []
    for scen in schema_doc.get("di_dt_scenarios", []) or []:
        if not isinstance(scen, dict):
            blockers.append("di_dt_scenarios entries must be mappings")
            continue
        rail = str(scen.get("rail", ""))
        edge_ns = float(scen.get("edge_time_ns", 0))
        di = dyn_step.get(rail)
        rv = voltages.get(rail)
        dec = decoupling.get(rail)
        if di is None:
            blockers.append(
                f"{scen.get('id')}: rail {rail} has no dynamic-current step in activity budget"
            )
            continue
        if rv is None:
            blockers.append(f"{scen.get('id')}: rail {rail} not found in rail-plan voltages")
            continue
        if dec is None or dec["on_die_nf"] <= 0:
            blockers.append(
                f"{scen.get('id')}: rail {rail} has no on-die decap target in rail plan"
            )
            continue
        if edge_ns <= 0:
            blockers.append(f"{scen.get('id')}: edge_time_ns must be > 0")
            continue
        c_on_die_f = dec["on_die_nf"] * 1e-9
        z0 = (loop_l_h / c_on_die_f) ** 0.5  # ohm, sqrt(L/C) tank impedance
        v_inductive = di * z0  # V, characteristic-impedance droop
        v_resistive = di * (esr_pkg_mohm * 1e-3)  # V
        v_droop = v_inductive + v_resistive
        nominal_v = rv["nominal_v"]
        dvfs_min_v = rv["dvfs_min_v"]
        droop_pct = (v_droop / nominal_v) * 100.0
        v_floor = nominal_v - v_droop
        within_pct = droop_pct <= max_droop_pct
        above_min = v_floor >= dvfs_min_v
        passes = within_pct and (above_min or not must_stay_above_min)
        if not passes:
            blockers.append(
                f"{scen.get('id')}: droop {droop_pct:.1f}% (floor {v_floor:.3f} V) violates "
                f"max {max_droop_pct}% / dvfs_min {dvfs_min_v} V"
            )
        rows.append(
            {
                "id": scen.get("id"),
                "rail": rail,
                "dynamic_current_step_a": round(di, 4),
                "edge_time_ns": edge_ns,
                "loop_inductance_ph": round(loop_l_h * 1e12, 1),
                "on_die_decap_nf": dec["on_die_nf"],
                "tank_impedance_z0_mohm": round(z0 * 1e3, 3),
                "v_droop_inductive": round(v_inductive, 4),
                "v_droop_resistive": round(v_resistive, 4),
                "v_droop_total": round(v_droop, 4),
                "droop_pct_of_nominal": round(droop_pct, 2),
                "v_floor": round(v_floor, 4),
                "nominal_v": nominal_v,
                "dvfs_min_v": dvfs_min_v,
                "within_max_droop_pct": within_pct,
                "above_dvfs_min_v": above_min,
            }
        )

    report = {
        "schema": DROOP_SCHEMA_ID,
        "as_of": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "claim_boundary": DROOP_CLAIM_BOUNDARY,
        "provenance": "package_board_class_parasitics_and_on_die_decap_x_vectorless_dynamic_step",
        "loop_inductance_ph": round(loop_l_h * 1e12, 1),
        "package_decap_esr_mohm": esr_pkg_mohm,
        "scenarios": rows,
        "release_use": "prohibited_until_external_review",
        "blockers": blockers,
    }
    return report, blockers


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate model, fail closed")
    parser.add_argument(
        "--droop", action="store_true", help="compute first-order package droop, fail closed"
    )
    parser.add_argument("--report-path", type=Path, default=REPORT_PATH)
    args = parser.parse_args(argv)

    for path in (ACTIVITY_MODEL, RAIL_PLAN):
        if not path.is_file():
            print(f"FAIL: {path.relative_to(ROOT)} missing", file=sys.stderr)
            return 1

    if args.droop:
        if not DROOP_SCHEMA.is_file():
            print(f"FAIL: {DROOP_SCHEMA.relative_to(ROOT)} missing", file=sys.stderr)
            return 1
        droop_report, droop_blockers = build_droop()
        DROOP_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        DROOP_REPORT_PATH.write_text(
            json.dumps(droop_report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if droop_blockers:
            print("pdn_package_droop FAILED:", file=sys.stderr)
            for b in droop_blockers:
                print(f"  FAIL: {b}", file=sys.stderr)
            return 1
        scenarios = droop_report["scenarios"]
        assert isinstance(scenarios, list)
        print(
            f"STATUS: PASS pdn_package_droop ({len(scenarios)} di/dt scenarios, "
            f"loop_L={droop_report['loop_inductance_ph']} pH) "
            f"-> {DROOP_REPORT_PATH.relative_to(ROOT)} "
            "— first-order planning estimate only, extracted-PDN dynamic IR signoff still required"
        )
        return 0

    report, blockers = build_budget()

    args.report_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    if blockers:
        print("pdn_activity_model FAILED:", file=sys.stderr)
        for b in blockers:
            print(f"  FAIL: {b}", file=sys.stderr)
        return 1

    blocks = report["blocks"]
    assert isinstance(blocks, list)
    print(
        f"STATUS: PASS pdn_activity_model ({len(blocks)} blocks, "
        f"margin={report['dynamic_margin_factor']}x) "
        f"-> {args.report_path.relative_to(ROOT)} "
        "— vectorless planning budget only, vector-driven dynamic IR signoff still required"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
