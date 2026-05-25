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
    assert report["summary"]["volume_adjusted_blocker_links"] == 16
    assert report["summary"]["ribbed_bulged_preview_candidates"] == 4
    assert report["summary"]["ribbed_bulged_preview_residual_structural_risk_links"] == 0
    assert report["summary"]["topology_repair_preview_links"] == 9
    assert report["summary"]["topology_repair_preview_envelope_preserved_links"] == 9
    assert report["summary"]["topology_repair_preview_height_preserved_links"] == 9
    assert report["summary"]["topology_repair_preview_max_abs_volume_delta_fraction"] > 0.0
    assert report["summary"]["analytic_load_cases"] == 84
    assert report["summary"]["analytic_load_case_failures"] == 8
    assert report["summary"]["analytic_load_case_failure_links"] == 6
    assert report["summary"]["analytic_load_case_top_failure_links"] == [
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "LEFT_SHOULDER_YAW",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
        "RIGHT_SHOULDER_YAW",
    ]
    assert report["summary"]["structural_remediation_links"] == 6
    assert report["summary"]["structural_remediation_top_links"][:2] == [
        "LEFT_KNEE",
        "RIGHT_KNEE",
    ]
    assert report["summary"]["structural_remediation_max_required_minor_axis_m"] > 0.0186
    assert report["summary"]["structural_remediation_max_minor_axis_increase_m"] > 0.006
    assert report["summary"]["structural_remediation_safety_factor_target"] == 1.05
    assert report["summary"]["structural_remediation_preview_exports"] == 6
    assert report["summary"]["structural_remediation_preview_reloads"] == 6
    assert report["summary"]["structural_remediation_preview_failures"] == 0
    assert report["summary"]["structural_remediation_preview_height_preserved_links"] == 6
    assert report["summary"]["structural_remediation_preview_center_preserved_links"] == 6
    assert report["summary"]["structural_remediation_preview_single_solid_links"] == 6
    assert report["summary"]["structural_remediation_preview_screened_links"] == 6
    assert report["summary"]["structural_remediation_preview_screen_pass_links"] == 6
    assert report["summary"]["structural_remediation_preview_min_safety_factor"] >= 1.05
    assert report["summary"]["structural_remediation_preview_xy_area_increase_fraction"] > 0.7
    assert report["summary"]["structural_remediation_preview_max_xy_area_increase_fraction"] > 1.4
    assert report["summary"]["structural_remediation_preview_max_minor_axis_increase_m"] > 0.006
    assert report["summary"]["structural_remediation_internal_cavity_checked_links"] == 6
    assert report["summary"]["structural_remediation_internal_cavity_improved_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_cleared_links"] == 0
    assert report["summary"]["structural_remediation_internal_cavity_residual_violation_links"] == 6
    assert report["summary"]["structural_remediation_internal_cavity_current_violations"] == 20
    assert report["summary"]["structural_remediation_internal_cavity_adjusted_violations"] == 20
    assert report["summary"]["structural_remediation_internal_cavity_z_blocked_links"] == 2
    assert (
        report["summary"]["structural_remediation_internal_cavity_minimum_projected_clearance_m"]
        < -0.04
    )
    assert report["summary"]["minimum_preliminary_safety_factor"] < 1.0
    assert report["summary"]["max_preliminary_deflection_m"] > 0.3
    assert report["summary"]["structural_sanity_accepted"] is False

    parts = {part["part_id"]: part for part in report["parts"]}
    assert parts["LEFT_ELBOW"]["ribbed_preview_required"] is True
    assert parts["LEFT_ELBOW"]["wall_thickness_ok"] is True
    assert len(parts["LEFT_ELBOW"]["load_cases"]) == 3
    assert parts["LEFT_ELBOW"]["load_cases"][0]["accepted"] is True
    assert parts["LEFT_ELBOW"]["minimum_safety_factor"] > 1.0
    assert parts["LEFT_KNEE"]["load_cases"][1]["accepted"] is False
    assert parts["LEFT_KNEE"]["minimum_safety_factor"] < 1.0
    assert parts["LEFT_KNEE"]["max_deflection_m"] > 0.3
    assert parts["LEFT_KNEE"]["structural_remediation"]["required_square_minor_axis_m"] > 0.0186
    assert "preliminary_euler_buckling_screen" in parts["LEFT_KNEE"]["structural_remediation"][
        "failed_load_cases"
    ]
    assert parts["LEFT_ELBOW"]["structural_remediation"] is None
    preview_records = {
        record["link"]: record for record in report["structural_remediation_preview"]["records"]
    }
    assert preview_records["LEFT_KNEE"]["step_sha256"]
    assert preview_records["LEFT_KNEE"]["height_delta_m"] == 0.0
    assert preview_records["LEFT_KNEE"]["solid_count_ok"] is True
    assert preview_records["LEFT_KNEE"]["adjusted_extent_m"][0] > 0.0186
    preview_screens = {
        record["link"]: record for record in report["structural_remediation_preview_screen"]
    }
    assert preview_screens["LEFT_KNEE"]["accepted"] is True
    assert preview_screens["LEFT_KNEE"]["minimum_safety_factor"] >= 1.05
    assert preview_screens["LEFT_KNEE"]["max_deflection_m"] < parts["LEFT_KNEE"]["max_deflection_m"]
    thinness_impact = {
        record["link"]: record for record in report["structural_remediation_thinness_impact"]
    }
    assert thinness_impact["LEFT_KNEE"]["xy_area_increase_fraction"] > 1.4
    assert thinness_impact["LEFT_KNEE"]["height_delta_m"] == 0.0
    cavity_impact = {
        record["link"]: record
        for record in report["structural_remediation_internal_cavity_impact"]
    }
    assert cavity_impact["LEFT_KNEE"]["current_violation_count"] == 4
    assert cavity_impact["LEFT_KNEE"]["adjusted_violation_count"] == 4
    assert cavity_impact["LEFT_KNEE"]["requires_z_pocket_or_component_refinement"] is False
    assert cavity_impact["LEFT_SHOULDER_YAW"]["adjusted_violation_count"] == 2
    assert (
        cavity_impact["LEFT_SHOULDER_YAW"]["requires_z_pocket_or_component_refinement"]
        is True
    )
    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["leg"]["structural_remediation_xy_area_increase_fraction"] > 0.9
    assert groups["arm"]["structural_remediation_xy_area_increase_fraction"] > 0.2
    assert parts["LEFT_TOE"]["material_class"] == "ALU_7075"
    assert parts["LEFT_TOE"]["wall_thickness_ok"] is False
    assert parts["LEFT_TOE"]["manufacturing_adjusted_wall_thickness_ok"] is True
    assert parts["LEFT_TOE"]["manufacturing_adjusted_step_sha256"]
    assert parts["NECK_PITCH"]["material_class"] == "MJF_PA12"
    assert parts["NECK_YAW"]["topology_repair_preview_available"] is True
    assert parts["NECK_YAW"]["topology_repair_preview_envelope_preserved"] is True
    assert parts["NECK_YAW"]["topology_repair_preview_height_preserved"] is True
    assert parts["NECK_YAW"]["topology_repair_preview_step_sha256"]
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
    assert report["structural_sanity"]["summary"]["ribbed_bulged_preview_candidates"] == 4
    assert report["structural_sanity"]["summary"]["topology_repair_preview_links"] == 9
    assert report["structural_sanity"]["summary"]["analytic_load_case_failure_links"] == 6
    assert report["structural_sanity"]["summary"]["structural_remediation_links"] == 6
    assert report["structural_sanity"]["summary"]["structural_remediation_preview_exports"] == 6
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_preview_screen_pass_links"
        ]
        == 6
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_preview_xy_area_increase_fraction"
        ]
        > 0.7
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_residual_violation_links"
        ]
        == 6
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_adjusted_violations"
        ]
        == 20
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
