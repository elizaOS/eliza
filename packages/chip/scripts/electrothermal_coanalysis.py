#!/usr/bin/env python3
"""First-order electrothermal co-analysis for the E1 SoC.

Couples the per-block power projection from ``scripts/power_thermal_model.py``
into a lumped thermal resistance (theta) network, then feeds the resulting
per-block junction temperature back into a temperature-dependent leakage model
and re-evaluates power. The coupling is iterated to a 2-step fixed point:

    P_block(T) = P_dynamic + P_leak0 * exp(k_leak * (T - T_ref))
    T_block    = T_ambient + sum_j theta[block][j] * P_j

This is a planning model. The thermal resistances and the leakage temperature
coefficient are documented engineering assumptions (vapor-chamber phone-class
theta budget + a generic advanced-node leakage sensitivity), NOT extracted from
a package thermal model, TCAD deck, or measured silicon. It emits a
``draft_local_evidence`` manifest and stays ``prohibited_until_external_review``:
it never claims thermal margin, power savings, or signoff. Real electrothermal
signoff requires a calibrated package/board thermal model and a foundry leakage
model, both named as release blockers.

CLI:
  python3 scripts/electrothermal_coanalysis.py            # write manifest
  python3 scripts/electrothermal_coanalysis.py --check     # fail if over envelope
"""

from __future__ import annotations

import argparse
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import yaml
from power_thermal_model import _load_thermal_envelope, project

ROOT = Path(__file__).resolve().parents[1]
PROCESS_SPEC = ROOT / "docs" / "spec-db" / "process-14a-effects.yaml"
MANIFEST_PATH = ROOT / "docs" / "evidence" / "power" / "electrothermal-coanalysis.yaml"
SCHEMA = "eliza.electrothermal_coanalysis.v1"
CLAIM_BOUNDARY = (
    "first_order_electrothermal_planning_coanalysis_"
    "no_package_thermal_model_tcad_or_silicon_claim"
)

T_AMBIENT_C = 25.0

# Planning-grade leakage temperature model. Coefficient is a documented
# engineering assumption for an advanced-node mobile SoC, NOT a foundry or
# silicon value. Leakage roughly doubles every ~10 C near the operating point;
# k = ln(2)/10 per degree C, applied to a per-block leakage fraction of the
# sustained power at the reference temperature.
LEAKAGE_K_PER_C = math.log(2.0) / 10.0
LEAKAGE_T_REF_C = 25.0
# Fraction of sustained power that is leakage at T_ref (engineering assumption).
LEAKAGE_FRACTION_AT_REF = 0.20

# Lumped junction-to-ambient thermal resistance per block (C/W). Diagonal is the
# block's own theta_ja under the vapor-chamber phone envelope; off-diagonal is a
# small shared-substrate coupling term. Engineering assumption, not extracted.
THETA_JA_C_PER_W: dict[str, float] = {
    "cpu_ap_cluster": 3.5,
    "npu": 3.0,
    "lpddr_phy_and_dram": 6.0,
    "display_and_dsi": 8.0,
    "wifi_bt": 10.0,
    "misc_pmic_audio": 10.0,
}
# Shared-substrate coupling: each block sees this fraction of every other
# block's power through the common heat-spreader (C/W effective).
SUBSTRATE_COUPLING_C_PER_W = 0.4

MAX_TJ_C = 95.0  # die Tj envelope, docs/pd/rail-plan-2028.yaml budgets.max_die_tj_c


def _block_sustained_power() -> dict[str, float]:
    report = project()
    blocks = cast(list[dict[str, object]], report["blocks"])
    return {str(b["block"]): float(cast(float, b["sustained_w"])) for b in blocks}


def coanalyze() -> dict[str, object]:
    sustained = _block_sustained_power()
    names = list(sustained.keys())

    # P_dynamic is the non-leakage portion at T_ref; P_leak0 is the reference
    # leakage power that scales with temperature.
    p_dynamic = {n: sustained[n] * (1.0 - LEAKAGE_FRACTION_AT_REF) for n in names}
    p_leak0 = {n: sustained[n] * LEAKAGE_FRACTION_AT_REF for n in names}

    # Fixed-point iteration: start at reference power, 2 coupling iterations.
    power = dict(sustained)
    temps: dict[str, float] = {n: T_AMBIENT_C for n in names}
    iterations: list[dict[str, dict[str, float]]] = []
    for _ in range(2):
        total_power = sum(power.values())
        new_temps: dict[str, float] = {}
        for n in names:
            theta_self = THETA_JA_C_PER_W.get(n, 10.0)
            others_power = total_power - power[n]
            new_temps[n] = (
                T_AMBIENT_C
                + theta_self * power[n]
                + SUBSTRATE_COUPLING_C_PER_W * others_power
            )
        new_power: dict[str, float] = {}
        for n in names:
            leak = p_leak0[n] * math.exp(LEAKAGE_K_PER_C * (new_temps[n] - LEAKAGE_T_REF_C))
            new_power[n] = p_dynamic[n] + leak
        temps = new_temps
        power = new_power
        iterations.append(
            {
                "temps_c": {n: round(temps[n], 2) for n in names},
                "power_w": {n: round(power[n], 4) for n in names},
            }
        )

    envelope = _load_thermal_envelope(PROCESS_SPEC)
    total_power_w = round(sum(power.values()), 4)
    max_tj = round(max(temps.values()), 2)
    steady_fit = total_power_w <= envelope.steady_state_w_high
    tj_fit = max_tj <= MAX_TJ_C
    release_blocker = (not steady_fit) or (not tj_fit)

    return {
        "schema": SCHEMA,
        "status": "draft_local_evidence",
        "release_use": "prohibited_until_external_review",
        "as_of": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "claim_boundary": CLAIM_BOUNDARY,
        "provenance": "power_thermal_model_projection_x_engineering_theta_and_leakage_assumptions",
        "model_assumptions": {
            "t_ambient_c": T_AMBIENT_C,
            "leakage_k_per_c": round(LEAKAGE_K_PER_C, 6),
            "leakage_fraction_at_ref": LEAKAGE_FRACTION_AT_REF,
            "leakage_t_ref_c": LEAKAGE_T_REF_C,
            "theta_ja_c_per_w": THETA_JA_C_PER_W,
            "substrate_coupling_c_per_w": SUBSTRATE_COUPLING_C_PER_W,
            "fixed_point_iterations": 2,
        },
        "blocks": [
            {
                "block": n,
                "sustained_w_at_ref": round(sustained[n], 4),
                "converged_power_w": round(power[n], 4),
                "converged_tj_c": round(temps[n], 2),
                "leakage_uplift_w": round(power[n] - sustained[n], 4),
            }
            for n in names
        ],
        "iterations": iterations,
        "totals": {
            "converged_total_power_w": total_power_w,
            "max_tj_c": max_tj,
            "steady_state_envelope_w_high": envelope.steady_state_w_high,
            "max_tj_envelope_c": MAX_TJ_C,
        },
        "fit": {
            "steady_state_fit": steady_fit,
            "max_tj_fit": tj_fit,
        },
        "release_blocker": release_blocker,
        "release_blockers": [
            "Thermal resistances are vapor-chamber phone-class engineering assumptions, not an extracted package thermal model.",
            "Leakage temperature coefficient is a generic advanced-node assumption, not a foundry leakage model or TCAD deck.",
            "No calibrated electrothermal co-simulation (signoff power-grid + thermal solver) has confirmed this fixed point.",
            "Per-block floorplan-aware theta coupling matrix is not extracted.",
        ],
        "check_command": "python3 scripts/electrothermal_coanalysis.py --check",
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if envelope exceeded")
    parser.add_argument("--manifest-path", type=Path, default=MANIFEST_PATH)
    args = parser.parse_args(argv)

    if not PROCESS_SPEC.is_file():
        print(f"FAIL: {PROCESS_SPEC.relative_to(ROOT)} missing", file=sys.stderr)
        return 1

    report = coanalyze()
    args.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_path.write_text(
        yaml.safe_dump(report, sort_keys=True, default_flow_style=False), encoding="utf-8"
    )
    totals = cast(dict[str, object], report["totals"])
    print(
        f"electrothermal_coanalysis: total_power={totals['converged_total_power_w']} W "
        f"max_tj={totals['max_tj_c']} C -> {args.manifest_path.relative_to(ROOT)} "
        "(draft_local_evidence, prohibited_until_external_review)"
    )

    if args.check and report["release_blocker"]:
        print(
            f"FAIL: electrothermal release_blocker=True "
            f"(total_power={totals['converged_total_power_w']} W "
            f"max_tj={totals['max_tj_c']} C "
            f"steady_max={totals['steady_state_envelope_w_high']} "
            f"tj_max={totals['max_tj_envelope_c']})",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
