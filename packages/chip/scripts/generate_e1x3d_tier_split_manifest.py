#!/usr/bin/env python3
"""Emit the E1X3D 2-tier pseudo-3D split manifest.

Describes the Shrunk-2D / Compact-2D-style partition of one E1X3D processing
element into two tiers bonded face-to-face:

  * a **logic tier** -- the tiny RV64 PE datapath, signed off as the open-PDK
    Sky130 ``e1x3d_tile`` OpenLane run; and
  * a **memory (SRAM) tier** -- the folded local-SRAM, signed off as the
    existing Sky130 hard-SRAM macro-array run ``e1_npu_weight_buffer_array``.

The per-tier area / footprint and the inter-tier interface come straight from
``compiler.runtime.e1x3d_placement_model.build_placement_report`` (the
``block_sram_on_logic`` split): the binding XY constraint is the per-tier SRAM
area, so moving the SRAM off the logic plane shrinks the per-PE footprint while
the SRAM-port signals set the required inter-tier via density. The manifest
picks the recommended catalog bonding (face-to-face hybrid bond, or MIV for a
finer fold) and records its via-density capacity vs. the requirement.

Per-tier open-PDK signoff is referenced by inspecting the actual OpenLane run
directory on disk and reporting only the stages that produced artifacts, so the
manifest never claims a closure that is not present. A tier whose run did not
reach physical implementation (or whose memory-tier macro-array run is absent)
is recorded as ``pending`` with the missing dependency -- the fail-closed law.

True 3D DRC/LVS across the bonded interface is commercial-only and is left to
the gate (``check_e1x3d_3d_split.py``) as a documented BLOCKED escalation.

Architecture-simulation + open-PDK evidence only: not a placed 3D layout, not
3D DRC/LVS, not electrothermal/SI-PI signoff, not silicon.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_placement_model import build_placement_report  # noqa: E402
from compiler.runtime.e1x3d_wafer_model import artifact_sha256  # noqa: E402

EVIDENCE = ROOT / "benchmarks/results/e1x3d-tier-split-manifest.json"
OPENLANE_RUNS = ROOT / "pd/openlane/runs"

# A physically-implemented OpenLane run leaves a routed-DB / streamout / DRC /
# manufacturability stage. A lint-or-synthesis-only run (e.g. the current
# e1x3d_tile run that stops at the yosys json header) has none of these; we
# treat it as a started-but-not-implemented run and report it as pending.
IMPLEMENTATION_STAGE_MARKERS = (
    "detailedrouting",
    "streamout",
    "magic-drc",
    "klayout-drc",
    "reportmanufacturability",
    "spiceextraction",
)


def _design_name(run_dir: Path) -> str | None:
    resolved = run_dir / "resolved.json"
    if not resolved.is_file():
        return None
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    name = payload.get("DESIGN_NAME")
    return name if isinstance(name, str) and name else None


def _completed_stages(run_dir: Path) -> list[str]:
    return sorted(
        child.name
        for child in run_dir.iterdir()
        if child.is_dir() and child.name[:2].isdigit()
    )


def _signoff_run_for_design(design: str) -> dict[str, object]:
    """Find the furthest-progressed open-PDK run for one design on disk.

    Returns the run with the most completed flow stages so a partially-routed
    run is preferred over a lint-only one. ``status`` is ``complete`` when the
    run reached a physical-implementation stage, ``incomplete`` when a run
    exists but stopped before implementation, and ``pending`` when no run for
    that design exists at all.
    """
    if not OPENLANE_RUNS.is_dir():
        return {
            "design_name": design,
            "status": "pending",
            "run_path": None,
            "completed_stage_count": 0,
            "furthest_stage": None,
            "missing_dependency": (
                f"no OpenLane run directory at {OPENLANE_RUNS.relative_to(ROOT)}"
            ),
        }
    candidates = [
        run_dir
        for run_dir in OPENLANE_RUNS.iterdir()
        if run_dir.is_dir() and _design_name(run_dir) == design
    ]
    if not candidates:
        return {
            "design_name": design,
            "status": "pending",
            "run_path": None,
            "completed_stage_count": 0,
            "furthest_stage": None,
            "missing_dependency": (
                f"no open-PDK OpenLane run found for design {design!r} under "
                f"{OPENLANE_RUNS.relative_to(ROOT)}"
            ),
        }
    best = max(candidates, key=lambda run_dir: len(_completed_stages(run_dir)))
    stages = _completed_stages(best)
    furthest = stages[-1] if stages else None
    implemented = any(
        marker in stage for stage in stages for marker in IMPLEMENTATION_STAGE_MARKERS
    )
    record: dict[str, object] = {
        "design_name": design,
        "run_path": str(best.relative_to(ROOT)),
        "completed_stage_count": len(stages),
        "furthest_stage": furthest,
        "reached_physical_implementation": implemented,
    }
    if implemented:
        record["status"] = "complete"
    else:
        record["status"] = "incomplete"
        record["missing_dependency"] = (
            f"open-PDK run for {design!r} stopped at {furthest!r} before reaching a "
            "physical-implementation stage (route/streamout/DRC); re-run the flow to "
            "produce a routed, DRC-checked tier signoff"
        )
    return record


def build_tier_split_manifest() -> dict:
    placement = build_placement_report()
    block = placement["tier_splits"]["block_sram_on_logic"]
    floorplan = placement["floorplan"]

    logic_signoff = _signoff_run_for_design("e1x3d_tile")
    memory_signoff = _signoff_run_for_design("e1_npu_weight_buffer_array")

    recommended_bonding = block["recommended_bonding"]
    feasible = bool(block["feasible_bondings"])
    bond_capacity = next(
        (
            float(entry["capacity_per_mm2"])
            for entry in block["feasible_bondings"]
            if entry["bonding"] == recommended_bonding
        ),
        None,
    )
    interface_kind = "monolithic_miv" if recommended_bonding == "monolithic_miv" else "hybrid_bond_f2f"

    logic_tier = {
        "tier": 0,
        "role": "logic",
        "content": "tiny RV64 PE datapath (e1x3d_tile)",
        "area_mm2": block["logic_tier_area_mm2"],
        "footprint_mm2": block["logic_tier_area_mm2"],
        "open_pdk": "sky130A",
        "signoff_run": logic_signoff,
    }
    memory_tier = {
        "tier": 1,
        "role": "memory",
        "content": (
            f"folded local SRAM ({floorplan['sram_port_signals']} port signals), "
            "Sky130 hard-SRAM macro array (e1_npu_weight_buffer_array)"
        ),
        "area_mm2": block["sram_tier_area_mm2"],
        "footprint_mm2": block["sram_tier_area_mm2"],
        "open_pdk": "sky130A",
        "signoff_run": memory_signoff,
    }

    inter_tier_interface = {
        "kind": interface_kind,
        "bonding": recommended_bonding,
        "orientation": "face_to_face",
        "configured_bonding_pitch_um": block["configured_bonding_pitch_um"],
        "configured_bonding_sufficient": block["configured_bonding_sufficient"],
        "inter_tier_vias": block["inter_tier_vias"],
        "required_via_density_per_mm2": block["required_via_density_per_mm2"],
        "bonding_capacity_per_mm2": bond_capacity,
        "via_density_margin": (
            round(bond_capacity / float(block["required_via_density_per_mm2"]), 4)
            if bond_capacity is not None and float(block["required_via_density_per_mm2"]) > 0
            else None
        ),
        "feasible_bondings": block["feasible_bondings"],
    }

    artifact = {
        "schema": "eliza.e1x3d.tier_split_manifest.v1",
        "chip": placement["chip"],
        "split_style": "block_sram_on_logic",
        "split_family": "shrunk_2d_compact_2d_two_tier_pseudo_3d",
        "claim_boundary": (
            "two_tier_pseudo_3d_partition_plus_per_tier_open_pdk_signoff_reference_only_"
            "not_placed_3d_layout_not_3d_drc_lvs_not_electrothermal_si_pi_not_silicon"
        ),
        "footprint": {
            "planar_2d_mm2": block["footprint_2d_mm2"],
            "stacked_3d_mm2": block["footprint_3d_mm2"],
            "xy_footprint_shrink": block["xy_footprint_shrink"],
            "wirelength_delta_vs_planar": block["wirelength_delta_vs_planar"],
        },
        "tiers": [logic_tier, memory_tier],
        "inter_tier_interface": inter_tier_interface,
        "feasibility": {
            "footprint_shrink_in_range": 0.25 <= float(block["xy_footprint_shrink"]) <= 0.70,
            "bonding_feasible": feasible,
            "logic_tier_signoff_status": logic_signoff["status"],
            "memory_tier_signoff_status": memory_signoff["status"],
        },
        "per_tier_signoff_note": (
            "Each tier is an independent open-PDK (Sky130) OpenLane signoff: the logic "
            "tier is the e1x3d_tile run and the memory tier is the e1_npu_weight_buffer_array "
            "hard-SRAM macro-array run. Per-tier 2D DRC/LVS is the open path; cross-tier "
            "3D DRC/LVS across the bonded interface is commercial-only and fails closed in "
            "the e1x3d-3d-split gate."
        ),
        "blocked_3d_signoff_path": {
            "status": "BLOCKED",
            "missing_dependency": (
                "3D DRC/LVS across the bonded inter-tier interface is commercial-only "
                "(Siemens Calibre 3D-LVS/3D-DRC, Cadence Integrity 3D-IC). No open tool "
                "verifies connectivity / spacing across a hybrid-bond or MIV interface."
            ),
            "proving_command": (
                "run each tier's open-PDK OpenLane signoff, then a commercial 3D-LVS/3D-DRC "
                "(Calibre 3D-LVS or Integrity 3D-IC) across the bonded interface"
            ),
        },
        "evidence_paths": [
            "compiler/runtime/e1x3d_placement_model.py",
            "benchmarks/results/e1x3d-placement-feasibility.json",
            "research/threed_ic_2026/02_analysis/3d_placement_benchmarks_yield_thermal.md",
        ],
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    return artifact


def main() -> int:
    artifact = build_tier_split_manifest()
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
