"""E1X3D 3D-placement feasibility model.

Models the "small in XY, tall in Z" tier-partitioning of a single E1X3D
processing element: a logic tier with its local SRAM folded onto one or more
memory tiers above it (memory-on-logic). It quantifies the three quantities the
research says decide 3D feasibility:

1. **XY footprint shrink** from moving SRAM off the logic plane (and folding it
   across memory tiers). The binding XY constraint is the per-tier SRAM area, so
   more memory tiers shrink the footprint further at the cost of a taller stack.
2. **Inter-tier via density** of the tier split, checked against a catalog of
   bonding technologies. This is where the research finding "production hybrid
   bonding (~6 um) is too coarse to bisect a small PE" becomes a checkable gate:
   a coarse block split fits hybrid bonding, but a fine logic fold needs
   monolithic-3D (MIV) density.
3. **Wirelength delta** vs the planar baseline (Open3DBench two-tier ~ -24%).

This is an analytic placement-feasibility model, not a placed layout. The real
prototype path is OpenROAD-Research / Open3DBench / Pin-3D with DREAMPlace and
HotSpot/3D-ICE (open, runnable); the real signoff path (3D DRC/LVS,
electrothermal, SI/PI) is commercial-only and fails closed as a documented
BLOCKED escalation.
"""

from __future__ import annotations

from dataclasses import dataclass

from compiler.runtime.e1x3d_wafer_model import E1X3DConfig, artifact_sha256, thermal_model

# Catalog of inter-tier bonding technologies: (name, pitch_um, hard_cap_vias_per_mm2).
# Capacity at a pitch is (1000/pitch_um)^2 vias/mm2, capped at the technology's
# demonstrated density ceiling (MIV ~30M/mm2 per the research).
BONDING_CATALOG: tuple[tuple[str, float, float], ...] = (
    ("hybrid_bond_f2f_6um", 6.0, 1.0e6),
    ("hybrid_bond_f2f_3um", 3.0, 1.0e6),
    ("hybrid_bond_f2f_1um", 1.0, 1.0e6),
    ("monolithic_miv", 0.1, 30.0e6),
)
# Open3DBench measured two-tier folded-2D wirelength reduction vs planar.
TWO_TIER_WIRELENGTH_DELTA = -0.24


@dataclass(frozen=True)
class PEFloorplan:
    """Area / connectivity budget of one tiny RV64 processing element.

    Defaults sum to ~0.05 mm2 (the public Cerebras-class per-core area point),
    split logic vs local-SRAM ~36/64 -- SRAM dominates a tiny core's area, which
    is why moving it off the logic plane is the dominant XY-shrink lever.
    """

    name: str = "e1x3d_tiny_pe"
    logic_area_mm2: float = 0.018
    sram_area_mm2: float = 0.032
    # Inter-tier signals for the two split styles.
    sram_port_signals: int = 768  # block SRAM-on-logic: one wide local-SRAM port per memory tier
    logic_fold_cut_nets: int = 16384  # fine logic fold: nets crossing a bisected datapath


def via_capacity_per_mm2(pitch_um: float, hard_cap: float) -> float:
    return min((1000.0 / pitch_um) ** 2, hard_cap)


def _feasible_bondings(required_density: float) -> list[dict[str, float | str]]:
    feasible: list[dict[str, float | str]] = []
    for name, pitch, cap in BONDING_CATALOG:
        capacity = via_capacity_per_mm2(pitch, cap)
        if capacity >= required_density:
            feasible.append({"bonding": name, "pitch_um": pitch, "capacity_per_mm2": capacity})
    return feasible


def evaluate_split(
    config: E1X3DConfig, floorplan: PEFloorplan, split: str
) -> dict[str, object]:
    memory_tiers = max(1, config.memory_tiers_per_core)
    footprint_2d = floorplan.logic_area_mm2 + floorplan.sram_area_mm2
    if split == "block_sram_on_logic":
        sram_tier_area = floorplan.sram_area_mm2 / memory_tiers
        logic_tier_area = floorplan.logic_area_mm2
        inter_tier_vias = floorplan.sram_port_signals * memory_tiers
    elif split == "fine_logic_fold":
        # Logic also folds across the logic tier pair; SRAM folds across memory tiers.
        sram_tier_area = floorplan.sram_area_mm2 / memory_tiers
        logic_tier_area = floorplan.logic_area_mm2 / 2.0
        inter_tier_vias = floorplan.sram_port_signals * memory_tiers + floorplan.logic_fold_cut_nets
    else:
        raise ValueError(f"unknown tier split {split!r}")
    footprint_3d = max(logic_tier_area, sram_tier_area)
    shrink = 1.0 - footprint_3d / footprint_2d
    required_density = inter_tier_vias / footprint_3d
    feasible = _feasible_bondings(required_density)
    recommended = feasible[0]["bonding"] if feasible else None
    configured_capacity = via_capacity_per_mm2(
        config.inter_tier_via_pitch_um,
        next((cap for _, pitch, cap in BONDING_CATALOG if pitch == config.inter_tier_via_pitch_um), 1.0e6),
    )
    configured_ok = configured_capacity >= required_density
    return {
        "split": split,
        "footprint_2d_mm2": round(footprint_2d, 6),
        "footprint_3d_mm2": round(footprint_3d, 6),
        "xy_footprint_shrink": round(shrink, 4),
        "logic_tier_area_mm2": round(logic_tier_area, 6),
        "sram_tier_area_mm2": round(sram_tier_area, 6),
        "memory_tiers_per_core": memory_tiers,
        "inter_tier_vias": inter_tier_vias,
        "required_via_density_per_mm2": round(required_density, 1),
        "feasible_bondings": feasible,
        "recommended_bonding": recommended,
        "configured_bonding_pitch_um": config.inter_tier_via_pitch_um,
        "configured_bonding_sufficient": configured_ok,
        "wirelength_delta_vs_planar": TWO_TIER_WIRELENGTH_DELTA,
    }


def build_placement_report(
    config: E1X3DConfig | None = None, floorplan: PEFloorplan | None = None
) -> dict:
    cfg = config or E1X3DConfig()
    fp = floorplan or PEFloorplan()
    block = evaluate_split(cfg, fp, "block_sram_on_logic")
    fine = evaluate_split(cfg, fp, "fine_logic_fold")
    thermal = thermal_model(cfg)

    # Gate: the configured split must be physically feasible with at least one
    # catalog bonding, give a real footprint shrink, and pass the thermal ceiling.
    block_feasible = bool(block["feasible_bondings"])
    fine_feasible = bool(fine["feasible_bondings"])
    shrink_ok = 0.25 <= float(block["xy_footprint_shrink"]) <= 0.70
    thermal_ok = thermal["status"] == "PASS"
    status = "PASS" if (block_feasible and shrink_ok and thermal_ok) else "BLOCKED"
    reasons: list[str] = []
    if not block_feasible:
        reasons.append("block SRAM-on-logic split has no feasible bonding in catalog")
    if not shrink_ok:
        reasons.append(f"block split XY shrink {block['xy_footprint_shrink']} outside [0.25, 0.70]")
    if not thermal_ok:
        reasons.append(f"thermal gate is {thermal['status']}")

    artifact = {
        "schema": "eliza.e1x3d.placement_feasibility.v1",
        "chip": cfg.name,
        "claim_boundary": (
            "analytic_placement_feasibility_only_not_placed_layout_not_3d_drc_lvs_not_signoff"
        ),
        "floorplan": {
            "name": fp.name,
            "logic_area_mm2": fp.logic_area_mm2,
            "sram_area_mm2": fp.sram_area_mm2,
            "sram_port_signals": fp.sram_port_signals,
            "logic_fold_cut_nets": fp.logic_fold_cut_nets,
        },
        "tier_splits": {"block_sram_on_logic": block, "fine_logic_fold": fine},
        "findings": {
            "block_fits_hybrid_bond": any(
                b["bonding"].startswith("hybrid_bond") for b in block["feasible_bondings"]
            ),
            "fine_fold_requires_miv": fine_feasible
            and all(
                b["bonding"] == "monolithic_miv" for b in fine["feasible_bondings"]
            ),
            "recommended_bonding_block": block["recommended_bonding"],
            "recommended_bonding_fine": fine["recommended_bonding"],
        },
        "thermal_status": thermal["status"],
        "thermal_peak_junction_c": thermal["peak_junction_c"],
        "open_prototype_path": [
            "OpenROAD-Research / ORFS-Research (Pin-3D / Snap-3D pseudo-3D flow)",
            "Open3DBench (Nangate45_3D, RISC-V designs, DREAMPlace placer)",
            "HotSpot / 3D-ICE thermal co-analysis",
        ],
        "blocked_signoff_path": {
            "status": "BLOCKED",
            "missing_dependency": (
                "3D DRC/LVS, electrothermal signoff, and SI/PI are commercial-only "
                "(Cadence Integrity 3D-IC + Celsius / Sigrity, Synopsys 3DIC Compiler + "
                "3DSO.ai + RedHawk-SC Electrothermal, Siemens Calibre 3D-LVS/DRC). "
                "Fine per-PE logic folding additionally needs a sequential-integration "
                "(monolithic-3D) PDK. No open 3D signoff path exists."
            ),
            "proving_command": "run the configured tier split through Open3DBench + ORFS-Research, then a commercial 3D signoff flow",
        },
        "gate": {"status": status, "reasons": reasons},
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact
