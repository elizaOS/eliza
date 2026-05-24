"""Material and manufacturing proof scaffolding for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


MATERIAL_BASELINES: dict[str, dict[str, Any]] = {
    "ALU_7075": {
        "material": "7075 aluminum",
        "density_kg_m3": 2810,
        "elastic_modulus_pa": 71.7e9,
        "yield_strength_pa": 503e6,
        "allowable_stress_pa": 250e6,
        "source": "conservative common 7075-T6 engineering baseline; verify exact temper before release",
    },
    "SML_316L": {
        "material": "316L stainless steel",
        "density_kg_m3": 8000,
        "elastic_modulus_pa": 193e9,
        "yield_strength_pa": 170e6,
        "allowable_stress_pa": 85e6,
        "source": "conservative annealed/low-strength 316L engineering baseline; verify stock/process before release",
    },
    "MJF_PA12": {
        "material": "PA12 nylon",
        "density_kg_m3": 1010,
        "elastic_modulus_pa": 1.6e9,
        "yield_strength_pa": 45e6,
        "allowable_stress_pa": 18e6,
        "source": "conservative MJF PA12 baseline; replace with vendor build-direction data before release",
    },
    "OFF_THE_SHELF": {
        "material": "vendor-defined off-the-shelf component",
        "density_kg_m3": None,
        "elastic_modulus_pa": None,
        "yield_strength_pa": None,
        "allowable_stress_pa": None,
        "source": "vendor component; do not scale or infer material without datasheet",
    },
}


MANUFACTURING_BASELINES: dict[str, dict[str, Any]] = {
    "ALU_7075": {
        "process": "CNC machining or sheet/plate fabrication",
        "minimum_wall_thickness_m": 0.0015,
        "minimum_feature_size_m": 0.0010,
        "draft_angle_deg": None,
        "tolerance_class": "machined functional fits require drawing-specific tolerances",
        "requires_flatness_check": True,
        "requires_smoothness_check": False,
        "requires_tool_access_check": True,
    },
    "SML_316L": {
        "process": "sheet metal/laser cut or machined stainless",
        "minimum_wall_thickness_m": 0.0008,
        "minimum_feature_size_m": 0.0008,
        "draft_angle_deg": None,
        "tolerance_class": "sheet/plate process dependent; bend allowance required if formed",
        "requires_flatness_check": True,
        "requires_smoothness_check": False,
        "requires_tool_access_check": True,
    },
    "MJF_PA12": {
        "process": "MJF additive manufacturing or reconstructed molded shell",
        "minimum_wall_thickness_m": 0.0012,
        "minimum_feature_size_m": 0.0008,
        "draft_angle_deg": 1.0,
        "tolerance_class": "process/vendor dependent; molded shell requires draft and undercut analysis",
        "requires_flatness_check": False,
        "requires_smoothness_check": True,
        "requires_tool_access_check": False,
    },
    "OFF_THE_SHELF": {
        "process": "purchased component",
        "minimum_wall_thickness_m": None,
        "minimum_feature_size_m": None,
        "draft_angle_deg": None,
        "tolerance_class": "vendor datasheet controls envelope and mounting pattern",
        "requires_flatness_check": False,
        "requires_smoothness_check": False,
        "requires_tool_access_check": False,
    },
}


def build_fembot_material_manufacturing_proof(
    body_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    """Classify candidate STEP parts by material/process.

    This proof is intentionally not accepted for production by itself. It proves
    source classification coverage for the current ASIMOV fabrication folders,
    but the final fembot needs generated per-part geometry measurements before
    material/manufacturing proof contracts can pass.
    """
    group_reports = []
    unknown_candidates = []
    total_fabrication_candidates = 0

    for group in body_groups:
        candidates = [
            candidate
            for candidate in group.get("step_candidates", [])
            if candidate.get("fabrication_class") != "ASSEMBLY"
        ]
        total_fabrication_candidates += len(candidates)
        class_counts: dict[str, int] = {}
        material_records: dict[str, dict[str, Any]] = {}
        manufacturing_records: dict[str, dict[str, Any]] = {}
        for candidate in candidates:
            fabrication_class = str(candidate.get("fabrication_class", "unknown"))
            class_counts[fabrication_class] = class_counts.get(fabrication_class, 0) + 1
            material = MATERIAL_BASELINES.get(fabrication_class)
            manufacturing = MANUFACTURING_BASELINES.get(fabrication_class)
            if material is None or manufacturing is None:
                unknown_candidates.append(candidate.get("path"))
                continue
            material_records[fabrication_class] = material
            manufacturing_records[fabrication_class] = manufacturing

        classification_ok = bool(candidates) and not unknown_candidates
        group_reports.append(
            {
                "group": group["group"],
                "candidate_count": len(candidates),
                "fabrication_class_counts": dict(sorted(class_counts.items())),
                "material_records": material_records,
                "manufacturing_records": manufacturing_records,
                "classification_ok": classification_ok,
                "accepted": False,
                "blocking_reason": (
                    "candidate STEP folders are classified, but generated fembot parts "
                    "do not yet have measured wall thickness, flatness/smoothness, "
                    "tool access, draft/undercut, tolerance, mass, or inertia proofs"
                ),
            }
        )

    classification_ok = total_fabrication_candidates > 0 and not unknown_candidates
    return {
        "schema": "asimov-fembot-material-manufacturing-proof-v1",
        "ok": classification_ok,
        "accepted": False,
        "summary": {
            "body_groups": len(group_reports),
            "fabrication_candidates": total_fabrication_candidates,
            "unknown_candidate_count": len(unknown_candidates),
            "classification_ok": classification_ok,
            "material_properties_accepted": False,
            "manufacturing_process_accepted": False,
        },
        "unknown_candidates": unknown_candidates,
        "body_groups": group_reports,
    }


def write_fembot_material_manufacturing_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-material-manufacturing.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def dump_fembot_material_manufacturing_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
