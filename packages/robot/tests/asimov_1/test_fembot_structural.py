from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_structural_sanity_proof_quantifies_current_blockers() -> None:
    report = build_fembot_structural_sanity_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-structural-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["wall_thickness_failures"] == 2
    assert report["summary"]["manufacturing_adjusted_wall_thickness_failures"] == 0
    assert report["summary"]["manufacturing_adjusted_plate_exports"] == 2
    assert report["summary"]["manufacturing_adjusted_plate_max_thickness_increase_m"] > 0.0006
    assert report["summary"]["manufacturing_adjusted_plate_max_height_delta_m"] == 0.0
    assert report["summary"]["internal_cavity_blocker_links"] == 26
    assert report["summary"]["internal_cavity_pre_clearance_blocker_links"] == 26
    assert report["summary"]["full_cavity_clearance_cleared_links"] == 26
    assert report["summary"]["active_internal_cavity_residual_blocker_links"] == 0
    assert report["summary"]["volume_adjusted_blocker_links"] == 16
    assert report["summary"]["ribbed_bulged_preview_candidates"] == 15
    assert report["summary"]["ribbed_bulged_preview_residual_structural_risk_links"] == 0
    assert report["summary"]["topology_repair_preview_links"] == 0
    assert report["summary"]["topology_repair_preview_envelope_preserved_links"] == 0
    assert report["summary"]["topology_repair_preview_height_preserved_links"] == 0
    assert report["summary"]["topology_repair_preview_max_abs_volume_delta_fraction"] is None
    assert report["summary"]["analytic_load_cases"] == 84
    assert report["summary"]["analytic_load_case_failures"] == 0
    assert report["summary"]["analytic_load_case_failure_links"] == 0
    assert report["summary"]["analytic_load_case_top_failure_links"] == []
    assert report["summary"]["preliminary_bending_buckling_deflection_screen_present"] is True
    assert report["summary"]["preliminary_load_case_screen_pass_links"] == 28
    assert report["summary"]["preliminary_structural_screen_pass_links"] == 28
    assert report["summary"]["structural_remediation_links"] == 0
    assert report["summary"]["structural_remediation_top_links"] == []
    assert report["summary"]["structural_remediation_max_required_minor_axis_m"] == 0.0
    assert report["summary"]["structural_remediation_max_minor_axis_increase_m"] == 0.0
    assert report["summary"]["structural_remediation_safety_factor_target"] == 1.05
    assert report["summary"]["structural_remediation_preview_exports"] == 0
    assert report["summary"]["structural_remediation_preview_reloads"] == 0
    assert report["summary"]["structural_remediation_preview_failures"] == 0
    assert report["summary"]["structural_remediation_preview_height_preserved_links"] == 0
    assert report["summary"]["structural_remediation_preview_center_preserved_links"] == 0
    assert report["summary"]["structural_remediation_preview_single_solid_links"] == 0
    assert report["summary"]["structural_remediation_preview_screened_links"] == 0
    assert report["summary"]["structural_remediation_preview_screen_pass_links"] == 0
    assert report["summary"]["structural_remediation_preview_min_safety_factor"] is None
    assert report["summary"]["structural_remediation_preview_xy_area_increase_fraction"] is None
    assert report["summary"]["structural_remediation_preview_max_xy_area_increase_fraction"] is None
    assert report["summary"]["structural_remediation_preview_max_minor_axis_increase_m"] == 0.0
    assert report["summary"]["structural_remediation_internal_cavity_checked_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_improved_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_cleared_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_residual_violation_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_current_violations"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_adjusted_violations"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_z_blocked_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_minimum_projected_clearance_m"] is None
    assert report["summary"]["minimum_preliminary_safety_factor"] > 40.0
    assert report["summary"]["max_preliminary_deflection_m"] < 1.0e-4
    assert report["summary"]["structural_sanity_accepted"] is False
    assert "preliminary wall-adjusted bending, buckling, and deflection screens" in (
        report["summary"]["acceptance_blocker"]
    )
    assert "production structural acceptance" in report["summary"]["acceptance_blocker"]

    parts = {part["part_id"]: part for part in report["parts"]}
    assert parts["LEFT_ELBOW"]["ribbed_preview_required"] is True
    assert parts["LEFT_ELBOW"]["wall_thickness_ok"] is True
    assert len(parts["LEFT_ELBOW"]["load_cases"]) == 3
    assert parts["LEFT_ELBOW"]["load_cases"][0]["accepted"] is True
    assert parts["LEFT_ELBOW"]["minimum_safety_factor"] > 1.0
    assert parts["LEFT_KNEE"]["load_cases"][1]["accepted"] is True
    assert parts["LEFT_KNEE"]["minimum_safety_factor"] > 1.0
    assert parts["LEFT_KNEE"]["max_deflection_m"] < 1.0e-4
    assert parts["LEFT_KNEE"]["structural_remediation"] is None
    assert parts["LEFT_ELBOW"]["structural_remediation"] is None
    assert report["structural_remediation_preview"]["records"] == []
    assert report["structural_remediation_preview_screen"] == []
    assert report["structural_remediation_thinness_impact"] == []
    assert report["structural_remediation_internal_cavity_impact"] == []
    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["leg"]["structural_remediation_xy_area_increase_fraction"] is None
    assert groups["arm"]["structural_remediation_xy_area_increase_fraction"] is None
    assert parts["LEFT_TOE"]["material_class"] == "ALU_7075"
    assert parts["LEFT_TOE"]["wall_thickness_ok"] is False
    assert parts["LEFT_TOE"]["manufacturing_adjusted_wall_thickness_ok"] is True
    assert parts["LEFT_TOE"]["manufacturing_adjusted_step_sha256"]
    assert parts["LEFT_KNEE"]["internal_cavity_pre_clearance_violation_count"] > 0
    assert parts["LEFT_KNEE"]["full_cavity_clearance_cleared"] is True
    assert parts["LEFT_KNEE"]["active_internal_cavity_residual_violation_count"] == 0
    assert parts["NECK_PITCH"]["material_class"] == "MJF_PA12"
    assert parts["NECK_YAW"]["topology_repair_preview_available"] is False
    assert parts["NECK_YAW"]["topology_repair_preview_envelope_preserved"] is False
    assert parts["NECK_YAW"]["topology_repair_preview_height_preserved"] is False
    assert parts["NECK_YAW"]["topology_repair_preview_step_sha256"] is None
    assert parts["NECK_PITCH"]["topology_repair_preview_available"] is False


def test_fembot_inventory_surfaces_structural_sanity_status() -> None:
    report = collect_fembot_inventory()

    assert report["structural_sanity"]["ok"] is True
    assert report["structural_sanity"]["accepted"] is False
    assert report["structural_sanity"]["summary"]["links"] == 28
    assert report["structural_sanity"]["summary"]["wall_thickness_failures"] == 2
    assert (
        report["structural_sanity"]["summary"][
            "manufacturing_adjusted_wall_thickness_failures"
        ]
        == 0
    )
    assert report["structural_sanity"]["summary"]["manufacturing_adjusted_plate_exports"] == 2
    assert report["structural_sanity"]["summary"]["ribbed_bulged_preview_candidates"] == 15
    assert report["structural_sanity"]["summary"]["topology_repair_preview_links"] == 0
    assert report["structural_sanity"]["summary"]["analytic_load_case_failure_links"] == 0
    assert (
        report["structural_sanity"]["summary"][
            "preliminary_bending_buckling_deflection_screen_present"
        ]
        is True
    )
    assert (
        report["structural_sanity"]["summary"]["preliminary_load_case_screen_pass_links"]
        == 28
    )
    assert (
        report["structural_sanity"]["summary"]["preliminary_structural_screen_pass_links"]
        == 28
    )
    assert report["structural_sanity"]["summary"]["structural_remediation_links"] == 0
    assert report["structural_sanity"]["summary"]["structural_remediation_preview_exports"] == 0
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_preview_screen_pass_links"
        ]
        == 0
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_preview_xy_area_increase_fraction"
        ]
        is None
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_residual_violation_links"
        ]
        == 0
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_adjusted_violations"
        ]
        == 0
    )
    for group in report["body_groups"]:
        assert "structural_sanity" in group["missing_proofs"]


def test_fembot_structural_sanity_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "structural-sanity.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_structural_sanity_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-structural-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
