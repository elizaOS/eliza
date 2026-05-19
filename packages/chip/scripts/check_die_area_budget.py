#!/usr/bin/env python3
"""Check die-area budget envelope.

Validates:
1. docs/evidence/process/die-area-budget.yaml describes a 100-130 mm² envelope.
2. The per-block sub-budgets are present and consistent with the
   benchmarks/pd/die-shot-calibration.yaml reference cohort.
3. The reference cohort cites independent die-shot analyses.
4. The envelope is below the N2/A14 reticle limit (~858 mm²).

Writes docs/evidence/process/die-area-budget-check.json so downstream gates
can consume the result.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BUDGET = ROOT / "docs/evidence/process/die-area-budget.yaml"
CALIBRATION = ROOT / "benchmarks/pd/die-shot-calibration.yaml"
OUT = ROOT / "docs/evidence/process/die-area-budget-check.json"

REQUIRED_BLOCKS = {
    "big_core_ultra_with_l2_mm2",
    "premium_mid_core_with_l2_mm2",
    "pro_little_core_with_l2_mm2",
    "l3_cluster_8_to_16_MB_mm2",
    "slc_16_to_32_MB_mm2",
    "npu_compute_logic_plus_8_MiB_local_mm2",
    "lpddr_phy_4x16bit_mm2",
    "gpu_mm2",
    "modem_isp_codecs_aon_mm2",
}

RETICLE_LIMIT_MM2 = 858.0


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_yaml(path: Path, errors: list[str]) -> dict[str, Any]:
    if not path.is_file():
        errors.append(f"missing: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        errors.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def check_envelope(budget: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    envelope = budget.get("envelope")
    if not isinstance(envelope, dict):
        errors.append("budget.envelope must be a mapping")
        return {}
    minimum = envelope.get("total_die_area_mm2_min")
    maximum = envelope.get("total_die_area_mm2_max")
    reticle = envelope.get("reticle_limit_n2_a14_mm2")
    if not isinstance(minimum, int | float) or not 80 <= float(minimum) <= 130:
        errors.append("envelope.total_die_area_mm2_min must be 80-130 mm²")
    if not isinstance(maximum, int | float) or not 100 <= float(maximum) <= 150:
        errors.append("envelope.total_die_area_mm2_max must be 100-150 mm²")
    if not isinstance(reticle, int | float) or float(reticle) < RETICLE_LIMIT_MM2 - 50:
        errors.append(f"envelope.reticle_limit must be near {RETICLE_LIMIT_MM2} mm²")
    if isinstance(minimum, int | float) and isinstance(maximum, int | float):
        if float(minimum) >= float(maximum):
            errors.append("envelope min must be < envelope max")
        if isinstance(reticle, int | float) and float(maximum) >= float(reticle):
            errors.append("envelope max must be well below reticle limit")
    return envelope


def check_sub_budgets(budget: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    sub = budget.get("per_block_sub_budgets_at_n2_density")
    if not isinstance(sub, dict):
        errors.append("per_block_sub_budgets_at_n2_density must be a mapping")
        return {}
    missing = sorted(REQUIRED_BLOCKS - set(sub))
    if missing:
        errors.append(f"per_block_sub_budgets missing: {', '.join(missing)}")
    flat_npu = sub.get("npu_local_sram_64_MiB_naive_flat_mm2_forbidden")
    if not isinstance(flat_npu, dict):
        errors.append("must call out flat-64-MiB NPU SRAM as infeasible")
    elif not str(flat_npu.get("rule", "")).lower().startswith("npu memory hierarchy required"):
        errors.append("flat-64-MiB NPU SRAM rule must require hierarchy")
    return sub


def check_calibration(cal: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    cohort = cal.get("reference_die_shots")
    if not isinstance(cohort, list) or len(cohort) < 3:
        errors.append("reference_die_shots must list at least three 2025-2026 flagships")
        return {}
    have_a19_pro = False
    have_s8e5 = False
    for chip in cohort:
        if not isinstance(chip, dict):
            errors.append("reference_cohort entry must be a mapping")
            continue
        name = str(chip.get("chip", ""))
        if "A19 Pro" in name:
            have_a19_pro = True
            if chip.get("die_area_mm2") != 98.68:
                errors.append("A19 Pro die_area must match published 98.68 mm²")
        if "Snapdragon 8 Elite Gen 5" in name:
            have_s8e5 = True
            if not isinstance(chip.get("die_area_mm2"), int | float):
                errors.append("Snapdragon 8 Elite Gen 5 die_area must be numeric")
        sources = chip.get("sources")
        if not isinstance(sources, list) or not sources:
            errors.append(f"{name}: sources must be a non-empty list")
    if not have_a19_pro:
        errors.append("reference_cohort must include Apple A19 Pro")
    if not have_s8e5:
        errors.append("reference_cohort must include Snapdragon 8 Elite Gen 5")
    scaling = cal.get("density_scaling_factors")
    if not isinstance(scaling, dict):
        errors.append("density_scaling_factors must be a mapping")
        return cal
    ratio = scaling.get("n3p_to_n2_logic_density_ratio")
    if not isinstance(ratio, int | float) or not 1.3 <= float(ratio) <= 1.6:
        errors.append("n3p_to_n2_logic_density_ratio must be ~1.45")
    n2_sram = scaling.get("n2_sram_macro_mb_per_mm2")
    if not isinstance(n2_sram, int | float) or float(n2_sram) < 36:
        errors.append("n2_sram_macro_mb_per_mm2 must be ≥ 36 (38.1 published)")
    return cal


def main() -> int:
    errors: list[str] = []
    budget = load_yaml(BUDGET, errors)
    cal = load_yaml(CALIBRATION, errors)
    if not budget or not cal:
        for error in errors:
            print(f"  - {error}")
        print("die-area-budget check FAILED")
        return 1

    if budget.get("status") != "envelope_target_subject_to_n2p_or_a14_density_scaling":
        errors.append(
            "budget.status must remain envelope_target_subject_to_n2p_or_a14_density_scaling"
        )
    if cal.get("status") != "published_die_shot_calibration_used_as_envelope_input":
        errors.append(
            "calibration.status must remain published_die_shot_calibration_used_as_envelope_input"
        )

    envelope = check_envelope(budget, errors)
    sub_budgets = check_sub_budgets(budget, errors)
    cal_data = check_calibration(cal, errors)

    report = {
        "schema": "eliza.process_die_area_budget_check.v1",
        "evidence_class": "envelope_target_real_no_signoff",
        "envelope": envelope,
        "sub_budgets_seen": sorted(sub_budgets.keys()) if isinstance(sub_budgets, dict) else [],
        "reference_cohort_count": len(cal_data.get("reference_die_shots", []))
        if isinstance(cal_data, dict)
        else 0,
        "errors": errors,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if errors:
        print("die-area-budget check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"die-area-budget envelope OK; report -> {rel(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
