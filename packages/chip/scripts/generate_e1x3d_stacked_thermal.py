#!/usr/bin/env python3
"""First-order STACKED electrothermal model for the E1X3D 3D wafer mesh.

This is the 3D companion to ``scripts/electrothermal_coanalysis.py`` (the planar
E1 SoC theta-network). It couples a *vertical* lumped thermal-resistance (theta)
network across the E1X3D physical Z stack into a temperature-dependent leakage
fixed point, per tier:

    P_tier(T) = P_dynamic + P_leak0 * exp(k_leak * (T - T_ref))
    T_tier    = T_ambient + sum_j R[tier][j] * P_j

The physical stack is memory-on-logic (``compiler.runtime.e1x3d_wafer_model``):
each logic tier carries ``memory_tiers_per_core`` folded SRAM tiers above it, so
the physical Z order from the substrate-side sink upward is, per logic plane,
[logic, memory, memory, ...]. Logic tiers are the heat sources; memory tiers are
modeled as cool buffers (no active power, only conduction + a thermal mass that
spreads heat). Dual-sided / backside cooling places a heat sink on *both* ends of
the stack, so a tier's junction-to-sink resistance is taken to the *nearest*
surface; the worst (hottest) tier is the most buried one, farthest from either
sink -- the buried-tier penalty the research names as the hard ceiling on tall-Z
logic.

Grounding (all documented engineering assumptions, NOT extracted from a package
thermal model, TCAD deck, or measured silicon):

* Per-tier conduction, inter-tier bond/interface, and stack-coupling resistances
  are AREA-SPECIFIC (K*mm2/W), anchored to the planar phone-class junction-to-
  ambient theta budget in ``scripts/electrothermal_coanalysis.py`` and divided by
  the modeled tier XY area so the network is scale-invariant. They are an
  INDEPENDENT first-order estimate -- this model does NOT back-solve them from the
  ``thermal_model`` ceiling (which would be circular); it reports that ceiling as
  a leakage-free conduction cross-check alongside the coupled result.
* Leakage doubles roughly every ~10 C near the operating point: k = ln(2)/10 per
  C, applied to a per-tier leakage fraction of the active power at T_ref. Same
  generic advanced-node assumption as the planar co-analysis.
* Memory tiers carry no active power (folded SRAM thermal buffer), matching the
  ``thermal_model`` treatment of memory tiers as cool buffers.

The coupled leakage/temperature loop can be unstable (loop gain > 1): if the
modeled junction crosses a physical sanity bound before settling, the model
reports a ``thermal_runaway`` -- there is no stable operating point at these
assumptions, which the gate reads as a non-fit. This is an honest, fail-closed
outcome, not a value to paper over.

It emits ``eliza.e1x3d.stacked_electrothermal.v1`` with an ``artifact_sha256``
and stays planning-grade: ``status = draft_local_evidence``,
``release_use = prohibited_until_external_review``. It NEVER claims thermal
margin, power savings, or signoff. Real stacked electrothermal signoff needs a
calibrated package/board thermal model and a foundry leakage model (commercial:
Ansys RedHawk-SC Electrothermal, Cadence Celsius), both named as release blockers
by the gate ``scripts/check_e1x3d_stacked_thermal.py``.

CLI:
  python3 scripts/generate_e1x3d_stacked_thermal.py            # write + print
  python3 scripts/generate_e1x3d_stacked_thermal.py --output PATH
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_wafer_model import (  # noqa: E402
    E1X3DConfig,
    artifact_sha256,
    scaled_e1x3d_config,
    thermal_model,
)

class _PhysicalTier(TypedDict):
    z: int
    kind: str
    logic_index: int
    depth_from_nearest_sink: int


class _PerTierResult(TypedDict):
    z: int
    kind: str
    logic_index: int
    depth_from_nearest_sink: int
    resistance_to_sink_c_per_w: float
    active_power_w_at_ref: float
    converged_power_w: float
    converged_junction_c: float
    leakage_uplift_w: float
    power_density_w_per_mm2: float
    power_density_ceiling_w_per_mm2: float
    junction_le_max: bool
    density_le_ceiling: bool


SCHEMA = "eliza.e1x3d.stacked_electrothermal.v1"
DEFAULT_OUTPUT = ROOT / "benchmarks/results/e1x3d-stacked-electrothermal.json"
CLAIM_BOUNDARY = (
    "first_order_stacked_electrothermal_planning_model_vertical_theta_network_plus_"
    "leakage_fixed_point_no_package_thermal_model_foundry_leakage_tcad_or_silicon_claim"
)

# Ambient at the cooling surface. Matches the planar co-analysis convention
# (T_AMBIENT = 25 C reference) so the two theta networks are comparable; the
# wafer model's own ambient_c (45 C) is the on-package coolant temperature and is
# reported separately as the baseline ceiling's ambient.
T_AMBIENT_C = 25.0

# Leakage temperature model: leakage ~doubles every 10 C near the operating
# point. Same documented advanced-node assumption as electrothermal_coanalysis.py.
LEAKAGE_K_PER_C = math.log(2.0) / 10.0
LEAKAGE_T_REF_C = 25.0
# Fraction of a logic tier's active power that is leakage at T_ref. Memory tiers
# carry no active power (cool buffer), so they have no leakage term.
LEAKAGE_FRACTION_AT_REF = 0.20

# Vertical theta network as AREA-SPECIFIC resistances (K*mm2/W) so the network is
# scale-invariant: a larger tier conducts proportionally more heat, so its lumped
# resistance is the specific resistance divided by the tier XY area (R = R" / A),
# the standard 1D conduction relation. These are documented engineering
# assumptions, NOT extracted from a package thermal model:
#   - THETA_TIER_LOGIC_SPECIFIC: a logic tier's own junction-to-tier-midplane
#     conduction specific resistance, anchored to the planar phone-class
#     junction-to-ambient theta budget in scripts/electrothermal_coanalysis.py
#     (hottest block ~3.5 C/W over a few mm2). A buried tier additionally crosses
#     the bond resistance to the sink, so the own term is kept conservative.
#   - THETA_BOND_SPECIFIC: the inter-tier hybrid-bond / interface specific
#     resistance crossed once per tier boundary on the path toward a sink.
#   - STACK_COUPLING_SPECIFIC: off-diagonal coupling -- the specific resistance
#     through which each tier additionally sees every other tier's power via the
#     shared stack (lateral + vertical spreading).
# Memory tiers are lower-power and more conductive (no dense logic routing), so
# their own-tier specific resistance is taken at 60% of a logic tier's. The model
# is an INDEPENDENT first-order estimate; it does not back-solve against the
# baseline thermal_model ceiling (which would be circular), and instead reports
# that ceiling as a leakage-free cross-check alongside the coupled result.
THETA_TIER_LOGIC_SPECIFIC_K_MM2_PER_W = 10.0
THETA_BOND_SPECIFIC_K_MM2_PER_W = 3.0
STACK_COUPLING_SPECIFIC_K_MM2_PER_W = 0.5


def _physical_stack(config: E1X3DConfig) -> list[_PhysicalTier]:
    """Physical Z tiers from the substrate-side sink upward.

    Memory-on-logic: each logic plane is [logic, then its memory tiers]. The
    returned list is ordered bottom (z=0, substrate-side sink) to top (backside
    sink under dual-sided cooling). ``depth_from_nearest_sink`` is the number of
    tier boundaries to the closer of the two surfaces (0 = touching a sink).
    """
    mem_per_logic = max(0, config.memory_tiers_per_core)
    tiers: list[_PhysicalTier] = []
    z = 0
    for logic_index in range(config.logical_tiers):
        tiers.append({"z": z, "kind": "logic", "logic_index": logic_index, "depth_from_nearest_sink": 0})
        z += 1
        for _ in range(mem_per_logic):
            tiers.append({"z": z, "kind": "memory", "logic_index": logic_index, "depth_from_nearest_sink": 0})
            z += 1
    total = len(tiers)
    dual_side = config.cooling == "dual_side"
    for tier in tiers:
        z_pos = tier["z"]
        depth_bottom = z_pos
        depth_top = (total - 1 - z_pos) if dual_side else (total - 1 + 1)
        tier["depth_from_nearest_sink"] = min(depth_bottom, depth_top)
    return tiers


def _tier_area_mm2(config: E1X3DConfig) -> float:
    """Modeled per-tier XY conducting area (mm2): logical cores x per-core area."""
    return config.logical_rows * config.logical_cols * config.core_xy_area_mm2


def _tier_active_power_w(config: E1X3DConfig) -> float:
    """Active power dissipated in one logic tier's XY area (W).

    Power density (W/mm2) x the modeled per-tier XY area. Memory tiers are cool
    buffers with no active power. This keeps the per-tier power density identical
    to ``thermal_model`` (tier_power_density_w_per_mm2) so the two models agree on
    the density check.
    """
    return config.tier_power_density_w_per_mm2 * _tier_area_mm2(config)


def _bond_resistance_c_per_w(config: E1X3DConfig) -> float:
    """Absolute inter-tier bond resistance (C/W) = specific resistance / area."""
    return THETA_BOND_SPECIFIC_K_MM2_PER_W / _tier_area_mm2(config)


def _stack_coupling_c_per_w(config: E1X3DConfig) -> float:
    """Absolute off-diagonal stack coupling resistance (C/W) = specific / area."""
    return STACK_COUPLING_SPECIFIC_K_MM2_PER_W / _tier_area_mm2(config)


def _tier_logic_resistance_c_per_w(config: E1X3DConfig) -> float:
    """Absolute logic-tier own conduction resistance (C/W) = specific / area."""
    return THETA_TIER_LOGIC_SPECIFIC_K_MM2_PER_W / _tier_area_mm2(config)


# Cap on the leakage multiplier per fixed-point step. A physical leakage model
# does not amplify without bound; this clamp turns a numerical blow-up into the
# meaningful outcome it represents -- the vertical network has no stable operating
# point at this theta (thermal runaway), which the gate reads as a non-fit.
LEAKAGE_MULTIPLIER_CAP = 1.0e6
# Outer fixed-point convergence: stop when the max junction delta between
# iterations falls below this (C), else report the iteration count and let the
# gate judge the (possibly non-converged) result.
CONVERGENCE_EPSILON_C = 0.01
MAX_FIXED_POINT_ITERATIONS = 256
# Picard under-relaxation on the leakage power update. Near the thermal-runaway
# knee the bare Gauss-Seidel iteration converges slowly; damping the power step
# stabilizes the path WITHOUT moving the fixed point (where new == old, damping is
# a no-op). Standard electrothermal co-iteration practice.
LEAKAGE_RELAXATION = 0.5


def _resistance_to_sink(
    tier: _PhysicalTier,
    theta_tier_logic: float,
    theta_tier_memory: float,
    theta_bond: float,
) -> float:
    """Junction-to-nearest-sink resistance (C/W) for one tier.

    Own-tier conduction plus one bond resistance per tier boundary crossed on the
    shortest path to a sink.
    """
    own = theta_tier_logic if tier["kind"] == "logic" else theta_tier_memory
    depth = tier["depth_from_nearest_sink"]
    return own + depth * theta_bond


def _leakage_power_w(p_dynamic: float, p_leak0: float, junction_c: float) -> float:
    """Active power of a logic tier at a junction temperature (W).

    Dynamic power plus a temperature-scaled leakage term, with the leakage
    multiplier clamped so a runaway shows up as a saturated (clamped) power rather
    than a numeric overflow.
    """
    multiplier = math.exp(
        min(LEAKAGE_K_PER_C * (junction_c - LEAKAGE_T_REF_C), math.log(LEAKAGE_MULTIPLIER_CAP))
    )
    return p_dynamic + p_leak0 * multiplier


# Physical sanity bound on junction temperature. The coupled leakage fixed point
# can be unstable (loop gain > 1): leakage feeds temperature which feeds leakage.
# When the modeled junction crosses this bound the iteration is declared a thermal
# runaway -- there is no stable operating point at this theta. This is a real,
# honest outcome the gate reads as a non-fit, not a numerical glitch to paper over.
RUNAWAY_JUNCTION_BOUND_C = 1000.0


def _solve_fixed_point(
    stack: list[_PhysicalTier],
    r_to_sink: list[float],
    theta_coupling: float,
    p_dynamic: float,
    p_leak0: float,
    p_active: float,
) -> tuple[list[float], list[float], list[dict[str, list[float]]], bool, bool]:
    """Iterate the coupled temperature/leakage fixed point.

    Returns (temps_c, power_w, iteration_trace, converged, runaway). ``runaway`` is
    True when the junction crosses the physical sanity bound before settling -- the
    leakage/temperature loop has no stable operating point at this theta.
    """
    n = len(stack)
    power = [p_active if t["kind"] == "logic" else 0.0 for t in stack]
    temps = [T_AMBIENT_C] * n
    trace: list[dict[str, list[float]]] = []
    converged = False
    runaway = False
    for _ in range(MAX_FIXED_POINT_ITERATIONS):
        total_power = sum(power)
        new_temps = [
            T_AMBIENT_C + r_to_sink[i] * power[i] + theta_coupling * (total_power - power[i])
            for i in range(n)
        ]
        target_power = [
            _leakage_power_w(p_dynamic, p_leak0, new_temps[i])
            if stack[i]["kind"] == "logic"
            else 0.0
            for i in range(n)
        ]
        new_power = [power[i] + LEAKAGE_RELAXATION * (target_power[i] - power[i]) for i in range(n)]
        delta = max(abs(new_temps[i] - temps[i]) for i in range(n))
        temps, power = new_temps, new_power
        trace.append(
            {
                "temps_c": [round(t, 3) for t in temps],
                "power_w": [round(p, 4) for p in power],
            }
        )
        if max(temps) >= RUNAWAY_JUNCTION_BOUND_C:
            runaway = True
            break
        if delta <= CONVERGENCE_EPSILON_C:
            converged = True
            break
    return temps, power, trace, converged, runaway


def stacked_coanalyze(config: E1X3DConfig) -> dict[str, object]:
    stack = _physical_stack(config)
    if _tier_active_power_w(config) <= 0.0:
        raise ValueError("modeled per-tier active power is non-positive")
    theta_tier_logic = _tier_logic_resistance_c_per_w(config)
    # Memory tiers conduct slightly better (no dense logic metal); model their own
    # resistance at 60% of a logic tier's. Documented engineering assumption.
    theta_tier_memory = theta_tier_logic * 0.6
    theta_bond = _bond_resistance_c_per_w(config)
    theta_coupling = _stack_coupling_c_per_w(config)

    p_active = _tier_active_power_w(config)
    p_dynamic = p_active * (1.0 - LEAKAGE_FRACTION_AT_REF)
    p_leak0 = p_active * LEAKAGE_FRACTION_AT_REF

    base_power = [p_active if t["kind"] == "logic" else 0.0 for t in stack]
    r_to_sink = [
        _resistance_to_sink(t, theta_tier_logic, theta_tier_memory, theta_bond) for t in stack
    ]

    temps, power, iterations, converged, runaway = _solve_fixed_point(
        stack, r_to_sink, theta_coupling, p_dynamic, p_leak0, p_active
    )

    baseline = thermal_model(config)
    ceiling_density = config.tier_power_density_ceiling_w_per_mm2
    max_tj_c = config.max_junction_temp_c

    per_tier: list[dict[str, object]] = []
    for i, t in enumerate(stack):
        density = config.tier_power_density_w_per_mm2 if t["kind"] == "logic" else 0.0
        per_tier.append(
            {
                "z": int(t["z"]),
                "kind": str(t["kind"]),
                "logic_index": int(t["logic_index"]),
                "depth_from_nearest_sink": int(t["depth_from_nearest_sink"]),
                "resistance_to_sink_c_per_w": round(r_to_sink[i], 4),
                "active_power_w_at_ref": round(base_power[i], 4),
                "converged_power_w": round(power[i], 4),
                "converged_junction_c": round(temps[i], 3),
                "leakage_uplift_w": round(power[i] - base_power[i], 4),
                "power_density_w_per_mm2": round(density, 4),
                "power_density_ceiling_w_per_mm2": ceiling_density,
                "junction_le_max": temps[i] <= max_tj_c,
                "density_le_ceiling": density <= ceiling_density,
            }
        )

    hottest = max(per_tier, key=lambda entry: float(entry["converged_junction_c"]))
    all_tj_ok = all(bool(entry["junction_le_max"]) for entry in per_tier) and not runaway
    all_density_ok = all(bool(entry["density_le_ceiling"]) for entry in per_tier)

    artifact: dict[str, object] = {
        "schema": SCHEMA,
        "status": "draft_local_evidence",
        "release_use": "prohibited_until_external_review",
        "as_of": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "subsystem": "e1x3d",
        "chip": config.name,
        "claim_boundary": CLAIM_BOUNDARY,
        "provenance": (
            "independent_vertical_theta_network_anchored_to_phone_class_theta_budget_x_"
            "generic_advanced_node_leakage_fixed_point_cross_checked_against_"
            "e1x3d_wafer_model_thermal_ceiling"
        ),
        "stack_geometry": {
            "logical_tiers": config.logical_tiers,
            "memory_tiers_per_core": config.memory_tiers_per_core,
            "physical_tiers": len(stack),
            "cooling": config.cooling,
            "dual_side_rise_reduction": config.dual_side_rise_reduction,
            "physical_order_bottom_to_top": [
                {"z": int(t["z"]), "kind": str(t["kind"])} for t in stack
            ],
        },
        "model_assumptions": {
            "t_ambient_c": T_AMBIENT_C,
            "package_ambient_c": config.ambient_c,
            "leakage_k_per_c": round(LEAKAGE_K_PER_C, 6),
            "leakage_fraction_at_ref": LEAKAGE_FRACTION_AT_REF,
            "leakage_t_ref_c": LEAKAGE_T_REF_C,
            "tier_area_mm2": round(_tier_area_mm2(config), 4),
            "theta_tier_logic_specific_k_mm2_per_w": THETA_TIER_LOGIC_SPECIFIC_K_MM2_PER_W,
            "theta_tier_logic_c_per_w": round(theta_tier_logic, 6),
            "theta_tier_memory_c_per_w": round(theta_tier_memory, 6),
            "theta_bond_specific_k_mm2_per_w": THETA_BOND_SPECIFIC_K_MM2_PER_W,
            "theta_bond_c_per_w": round(theta_bond, 6),
            "stack_coupling_specific_k_mm2_per_w": STACK_COUPLING_SPECIFIC_K_MM2_PER_W,
            "stack_coupling_c_per_w": round(theta_coupling, 6),
            "per_tier_active_power_w": round(p_active, 4),
            "fixed_point_iterations_run": len(iterations),
            "max_fixed_point_iterations": MAX_FIXED_POINT_ITERATIONS,
            "convergence_epsilon_c": CONVERGENCE_EPSILON_C,
            "leakage_relaxation": LEAKAGE_RELAXATION,
            "leakage_multiplier_cap": LEAKAGE_MULTIPLIER_CAP,
            "runaway_junction_bound_c": RUNAWAY_JUNCTION_BOUND_C,
            "theta_source": (
                "area_specific_resistances_anchored_to_planar_phone_class_theta_budget_"
                "not_back_solved_from_baseline_ceiling; baseline_ceiling_reported_as_"
                "leakage_free_cross_check_only"
            ),
        },
        "baseline_ceiling_cross_check": {
            "note": (
                "leakage_free_conduction_ceiling_from_e1x3d_wafer_model.thermal_model; "
                "reported for comparison only, NOT used to calibrate this network"
            ),
            "schema": baseline["schema"],
            "artifact_sha256": baseline["artifact_sha256"],
            "ambient_c": baseline["ambient_c"],
            "peak_junction_c": baseline["peak_junction_c"],
            "max_junction_temp_c": baseline["max_junction_temp_c"],
            "tier_power_density_ceiling_w_per_mm2": ceiling_density,
            "status": baseline["status"],
            "stacked_minus_baseline_peak_junction_c": round(
                float(hottest["converged_junction_c"]) - float(baseline["peak_junction_c"]), 3
            ),
        },
        "per_tier": per_tier,
        "iterations": iterations,
        "totals": {
            "converged_total_active_power_w": round(sum(power), 4),
            "max_junction_c": float(hottest["converged_junction_c"]),
            "hottest_tier_z": int(hottest["z"]),
            "hottest_tier_kind": str(hottest["kind"]),
            "max_junction_temp_c": max_tj_c,
            "tier_power_density_ceiling_w_per_mm2": ceiling_density,
        },
        "fit": {
            "all_tier_junction_le_max": all_tj_ok,
            "all_tier_density_le_ceiling": all_density_ok,
            "fixed_point_converged": converged,
            "thermal_runaway": runaway,
        },
        "release_blockers": [
            "Per-tier vertical theta resistances are area-specific engineering "
            "assumptions anchored to a phone-class theta budget, not an extracted "
            "package/board thermal model or a measured stack thermal-resistance budget.",
            "Leakage temperature coefficient and reference leakage fraction are generic "
            "advanced-node assumptions, not a foundry leakage model or TCAD deck.",
            "Buried-tier penalty, inter-tier bond resistance, and dual-sided cooling "
            "split are modeled, not measured against silicon or a calibrated solver.",
            "No calibrated stacked electrothermal co-simulation (commercial: Ansys "
            "RedHawk-SC Electrothermal, Cadence Celsius) has confirmed this fixed point.",
        ],
        "check_command": "python3 scripts/check_e1x3d_stacked_thermal.py",
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--scaled",
        action="store_true",
        help="use the scaled 16GB E1X3D config instead of the default baseline",
    )
    args = parser.parse_args(argv)

    config = scaled_e1x3d_config() if args.scaled else E1X3DConfig()
    artifact = stacked_coanalyze(config)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
