from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_generated_cad_exports_adjusted_envelope_steps(tmp_path) -> None:
    report = build_fembot_generated_cad_envelope_proof(
        _body_groups(),
        step_root=tmp_path / "steps",
        pocket_root=tmp_path / "pockets",
        link_pocket_root=tmp_path / "link-pockets",
        pocketed_preview_root=tmp_path / "pocketed-preview",
        bulged_preview_root=tmp_path / "bulged-preview",
        ribbed_bulged_preview_root=tmp_path / "ribbed-bulged-preview",
        full_cavity_clearance_root=tmp_path / "full-cavity-clearance",
        supplier_vendor_adjusted_root=tmp_path / "supplier-vendor-adjusted",
        manufacturing_adjusted_plate_root=tmp_path / "manufacturing-adjusted-plates",
    )

    assert report["schema"] == "asimov-fembot-generated-cad-parametric-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["requested_links"] == 28
    assert report["summary"]["links"] == 28
    assert report["summary"]["step_exports"] == 28
    assert report["summary"]["step_reloads"] == 28
    assert report["summary"]["single_solid_links"] == 28
    assert report["summary"]["extent_tolerance_failures"] == 0
    assert report["summary"]["clearance_adjusted_violation_links"] == 0
    assert report["summary"]["shape_family_counts"] == {
        "source_fitted_controlled_loft": 28,
    }
    assert len(report["summary"]["source_fitted_controlled_loft_links"]) == 28
    assert report["summary"]["source_fitted_controlled_loft_step_exports"] == 28
    assert report["summary"]["source_fitted_controlled_loft_step_reloads"] == 28
    assert report["summary"]["source_fitted_controlled_loft_failures"] == 0
    assert report["summary"]["surface_intent_counts"] == {"flat": 2, "smooth": 26}
    assert report["summary"]["smooth_chest_no_cutout_loft_links"] == ["WAIST_YAW"]
    assert report["summary"]["stl_or_mesh_source_links"] == []
    assert report["summary"]["hollow_shell_links"] == 26
    assert report["summary"]["flat_plate_links"] == 2
    assert report["summary"]["wall_thickness_m"] == 0.0012
    assert report["summary"]["internal_cavity_violation_links"] == 26
    assert report["summary"]["internal_cavity_pre_clearance_violation_links"] == 26
    assert report["summary"]["internal_cavity_violations"] == 73
    assert report["summary"]["internal_cavity_minimum_projected_clearance_m"] is not None
    assert report["summary"]["internal_cavity_minimum_projected_clearance_m"] < 0.0
    assert report["summary"]["volume_adjusted_xy_violation_links"] == 16
    assert report["summary"]["volume_adjusted_xy_violations"] == 23
    assert report["summary"]["volume_adjusted_z_blocked_links"] == 16
    assert report["summary"]["volume_adjusted_max_z_expansion_required_m"] > 0.03
    assert report["summary"]["volume_adjusted_max_xy_area_increase_fraction"] > 0.45
    assert report["summary"]["remediation_target_count"] == 73
    assert report["summary"]["remediation_still_blocked_after_xy_count"] == 25
    assert report["summary"]["remediation_z_pocket_or_refinement_count"] == 23
    assert report["summary"]["remediation_component_type_counts"] == {
        "collision_keepout": 28,
        "joint_axis": 21,
        "motor_actuator": 23,
        "site": 1,
    }
    assert report["summary"]["remediation_plan_links"] == 26
    assert report["summary"]["remediation_top_priority_links"][:4] == [
        "WAIST_YAW",
        "NECK_PITCH",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
    ]
    assert report["remediation_plan"][0]["link"] == "WAIST_YAW"
    assert report["remediation_plan"][0]["primary_strategy"] == "z_pocket_or_component_refinement"
    assert report["remediation_plan"][2]["primary_strategy"] == "xy_local_bulge_or_split_plate"
    assert report["summary"]["remediation_pocket_step_exports"] == 73
    assert report["summary"]["remediation_pocket_step_reloads"] == 73
    assert report["summary"]["remediation_pocket_step_failures"] == 0
    assert report["summary"]["remediation_link_pocket_set_exports"] == 26
    assert report["summary"]["remediation_link_pocket_set_reloads"] == 26
    assert report["summary"]["remediation_link_pocket_set_failures"] == 0
    assert report["summary"]["remediation_link_pocket_set_total_solids"] == 33
    assert report["summary"]["pocketed_preview_exports"] == 26
    assert report["summary"]["pocketed_preview_reloads"] == 26
    assert report["summary"]["pocketed_preview_failures"] == 0
    assert report["summary"]["pocketed_preview_fragmented_links"] == 2
    assert report["summary"]["pocketed_preview_high_volume_loss_links"] == 25
    assert report["summary"]["pocketed_preview_structural_risk_links"] == 25
    assert report["summary"]["pocketed_preview_top_structural_risk_links"][:4] == [
        "RIGHT_ELBOW",
        "NECK_PITCH",
        "RIGHT_HIP_PITCH",
        "LEFT_HIP_PITCH",
    ]
    assert report["summary"]["pocketed_preview_max_volume_removed_fraction"] > 0.8
    assert report["summary"]["bulged_preview_exports"] == 26
    assert report["summary"]["bulged_preview_reloads"] == 26
    assert report["summary"]["bulged_preview_failures"] == 0
    assert report["summary"]["bulged_preview_fragmented_links"] == 2
    assert report["summary"]["bulged_preview_high_volume_loss_links"] == 16
    assert report["summary"]["bulged_preview_max_volume_removed_fraction"] > 0.8
    assert report["summary"]["bulged_preview_residual_structural_risk_links"] == 16
    assert report["summary"]["bulged_preview_top_residual_risk_links"][:4] == [
        "RIGHT_WRIST_YAW",
        "NECK_PITCH",
        "RIGHT_SHOULDER_YAW",
        "LEFT_SHOULDER_YAW",
    ]
    assert report["summary"]["bulge_extra_wall_m"] == 0.003
    assert report["summary"]["ribbed_bulged_preview_candidates"] == 15
    assert report["summary"]["ribbed_bulged_preview_exports"] == 15
    assert report["summary"]["ribbed_bulged_preview_reloads"] == 15
    assert report["summary"]["ribbed_bulged_preview_failures"] == 0
    assert report["summary"]["ribbed_bulged_preview_fragmented_links"] == 0
    assert report["summary"]["ribbed_bulged_preview_high_volume_loss_links"] == 0
    assert report["summary"]["ribbed_bulged_preview_residual_structural_risk_links"] == 0
    assert report["summary"]["ribbed_bulged_preview_top_residual_risk_links"] == []
    assert report["summary"]["ribbed_bulged_preview_total_ribs"] == 315
    assert report["summary"]["ribbed_bulged_preview_rib_thickness_m"] == 0.003
    assert report["summary"]["full_cavity_clearance_candidates"] == 26
    assert report["summary"]["full_cavity_clearance_exports"] == 26
    assert report["summary"]["full_cavity_clearance_reloads"] == 26
    assert report["summary"]["full_cavity_clearance_failures"] == 0
    assert report["summary"]["full_cavity_clearance_extent_tolerance_failures"] == 1
    assert report["summary"]["full_cavity_clearance_specific_extent_tolerance_m"] == 5.0e-6
    assert report["summary"]["full_cavity_clearance_specific_extent_tolerance_failures"] == 0
    assert report["summary"]["full_cavity_clearance_max_extent_abs_error_m"] < 3.2e-6
    assert report["summary"]["full_cavity_clearance_cleared_links"] == 26
    assert report["summary"]["full_cavity_clearance_residual_violation_links"] == 0
    assert report["summary"]["full_cavity_clearance_residual_violation_link_names"] == []
    assert report["summary"]["active_internal_cavity_residual_violation_links"] == 0
    assert report["summary"]["full_cavity_clearance_height_preserved_links"] == 10
    assert report["summary"]["full_cavity_clearance_z_expansion_links"] == 16
    assert report["summary"]["full_cavity_clearance_max_z_expansion_m"] > 0.03
    assert report["summary"]["full_cavity_clearance_max_xy_area_increase_fraction"] > 0.45
    assert report["summary"]["full_cavity_clearance_max_volume_increase_fraction"] > 0.75
    assert report["summary"]["supplier_vendor_adjusted_candidates"] == 8
    assert report["summary"]["supplier_vendor_adjusted_exports"] == 8
    assert report["summary"]["supplier_vendor_adjusted_reloads"] == 8
    assert report["summary"]["supplier_vendor_adjusted_failures"] == 0
    assert report["summary"]["supplier_vendor_adjusted_extent_tolerance_failures"] == 0
    assert report["summary"]["supplier_vendor_adjusted_single_solid_links"] == 8
    assert report["summary"]["supplier_vendor_adjusted_fit_margin_m"] == 0.002
    assert report["summary"]["supplier_vendor_adjusted_fit_checked"] == 36
    assert report["summary"]["supplier_vendor_adjusted_fit_pass"] == 36
    assert report["summary"]["supplier_vendor_adjusted_fit_fail"] == 0
    assert report["summary"]["supplier_vendor_adjusted_fit_pass_links"] == 8
    assert report["summary"]["supplier_vendor_adjusted_fit_fail_links"] == 0
    assert report["summary"]["supplier_vendor_adjusted_max_residual_extent_growth_m"] == 0.0
    assert report["summary"]["supplier_vendor_adjusted_links"] == [
        "LEFT_ANKLE_A",
        "LEFT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_ANKLE_A",
        "RIGHT_HIP_ROLL",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
    ]
    assert report["summary"]["supplier_vendor_adjusted_max_axis_growth_m"] > 0.026
    assert report["summary"]["supplier_vendor_adjusted_max_volume_increase_fraction"] < 0.0
    assert report["summary"]["manufacturing_adjusted_plate_exports"] == 2
    assert report["summary"]["manufacturing_adjusted_plate_reloads"] == 2
    assert report["summary"]["manufacturing_adjusted_plate_failures"] == 0
    assert report["summary"]["manufacturing_adjusted_plate_process_floor_m"] == 0.0015
    assert report["summary"]["manufacturing_adjusted_plate_process_floor_failures"] == 0
    assert report["summary"]["manufacturing_adjusted_plate_max_thickness_increase_m"] > 0.0006
    assert report["summary"]["manufacturing_adjusted_plate_max_height_delta_m"] == 0.0
    assert report["pocketed_preview_structural_risk_plan"][0]["risk"] == "critical_high_volume_loss"
    assert report["bulged_preview_residual_structural_risk_plan"][0]["risk"] == (
        "critical_high_volume_loss"
    )
    assert report["ribbed_bulged_preview_residual_structural_risk_plan"] == []
    assert report["pocket_generation"]["records"][0]["solid_count"] == 1
    assert report["link_pocket_generation"]["records"][0]["target_count"] > 0
    assert report["pocketed_preview_generation"]["records"][0]["volume_removed_fraction"] > 0.0
    assert report["ribbed_bulged_preview_generation"]["records"][0]["rib_count"] == 21
    assert report["ribbed_bulged_preview_generation"]["records"][0]["solid_count"] == 1
    assert report["summary"]["total_adjusted_bbox_volume_m3"] > 0.0
    assert report["summary"]["total_generated_solid_volume_m3"] > 0.0

    left_toe = {record["link"]: record for record in report["link_steps"]}["LEFT_TOE"]
    assert left_toe["step_path"].endswith("left_toe.step")
    assert left_toe["step_sha256"]
    assert left_toe["step_size_bytes"] > 0
    assert left_toe["extent_within_tolerance"] is True
    assert left_toe["generated_geometry_role"] == "source_fitted_controlled_loft_brep"
    assert left_toe["shape_family"] == "source_fitted_controlled_loft"
    assert left_toe["parametric_source"] == "source_mesh_cross_section_periodic_spline_loft"
    assert left_toe["source_control_ring_count"] >= 2
    assert left_toe["source_control_points_per_ring"] >= 32
    assert left_toe["surface_intent"] == "flat"
    assert left_toe["internal_cavity"]["required"] is False
    assert left_toe["manufacturing_adjusted_plate"]["adjusted_extent_m"][2] >= 0.0015
    assert left_toe["manufacturing_adjusted_plate"]["adjusted_design_thickness_m"] == 0.0015
    assert left_toe["manufacturing_adjusted_plate"]["height_delta_m"] == 0.0
    assert left_toe["manufacturing_adjusted_plate"]["process_floor_satisfied"] is True
    assert left_toe["manufacturing_adjusted_plate"]["step_sha256"]

    waist_yaw = {record["link"]: record for record in report["link_steps"]}["WAIST_YAW"]
    assert waist_yaw["smooth_chest_no_cutout_loft"] is True
    assert waist_yaw["parametric_source"] == "source_mesh_cross_section_periodic_spline_loft"
    assert "front M logo/cutout omitted" in waist_yaw["cutout_policy"]
    assert waist_yaw["step_path"].endswith("waist_yaw.step")
    assert waist_yaw["extent_within_tolerance"] is True

    neck_pitch = {record["link"]: record for record in report["link_steps"]}["NECK_PITCH"]
    assert neck_pitch["shape_family"] == "source_fitted_controlled_loft"
    assert neck_pitch["surface_intent"] == "smooth"
    assert neck_pitch["wall_thickness_m"] == 0.0012
    assert neck_pitch["internal_cavity"]["required"] is True
    assert neck_pitch["internal_cavity"]["violation_count"] > 0
    assert neck_pitch["internal_cavity"]["points"][0]["component_radius_m"] > 0.0
    assert neck_pitch["volume_adjusted_candidate"]["required"] is True
    assert max(
        adjusted - requested
        for adjusted, requested in zip(
            neck_pitch["volume_adjusted_candidate"]["full_clearance_bbox_extent_m"],
            neck_pitch["requested_extent_m"],
            strict=True,
        )
    ) > 0.0
    assert neck_pitch["full_cavity_clearance_candidate"]["required"] is True
    assert neck_pitch["full_cavity_clearance_candidate"]["reload_ok"] is True
    assert neck_pitch["full_cavity_clearance_candidate"]["internal_cavity_cleared"] is True
    assert (
        neck_pitch["full_cavity_clearance_candidate"][
            "full_cavity_clearance_extent_within_tolerance"
        ]
        is True
    )
    assert neck_pitch["full_cavity_clearance_candidate"]["z_expansion_m"] > 0.0
    assert (
        neck_pitch["full_cavity_clearance_candidate"]["generated_geometry_role"]
        == "full_internal_cavity_clearance_parametric_reference"
    )
    assert neck_pitch["remediation_targets"]
    assert neck_pitch["remediation_targets"][0]["required_local_pocket_radius_m"] > 0.0
    assert neck_pitch["remediation_targets"][0]["pocket_step_path"].endswith(".step")
    assert neck_pitch["remediation_targets"][0]["pocket_step_sha256"]
    assert "recommended_next_action" in neck_pitch["remediation_targets"][0]

    left_knee = {record["link"]: record for record in report["link_steps"]}["LEFT_KNEE"]
    assert left_knee["supplier_vendor_adjusted_candidate"]["required"] is True
    assert left_knee["supplier_vendor_adjusted_candidate"]["reload_ok"] is True
    assert left_knee["supplier_vendor_adjusted_candidate"]["step_sha256"]
    assert (
        left_knee["supplier_vendor_adjusted_candidate"]["generated_geometry_role"]
    ) == "supplier_vendor_adjusted_parametric_reference"
    assert max(left_knee["supplier_vendor_adjusted_candidate"]["axis_growth_m"]) > 0.026
    assert left_knee["supplier_vendor_adjusted_candidate"]["fit_validation"]["all_fit"] is True
    assert left_knee["supplier_vendor_adjusted_candidate"]["fit_validation"]["fit_check_count"] == 5
    assert left_knee["supplier_vendor_adjusted_candidate"]["fit_validation"]["fit_fail_count"] == 0
    assert (
        left_knee["supplier_vendor_adjusted_candidate"]["fit_validation"][
            "max_residual_extent_growth_m"
        ]
        == 0.0
    )
    assert left_toe["supplier_vendor_adjusted_candidate"]["required"] is False


def test_fembot_generated_cad_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "generated-cad.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_generated_cad_envelope.py",
            "--output",
            str(output),
            "--step-root",
            str(tmp_path / "steps"),
            "--pocket-root",
            str(tmp_path / "pockets"),
            "--link-pocket-root",
            str(tmp_path / "link-pockets"),
            "--pocketed-preview-root",
            str(tmp_path / "pocketed-preview"),
            "--bulged-preview-root",
            str(tmp_path / "bulged-preview"),
            "--ribbed-bulged-preview-root",
            str(tmp_path / "ribbed-bulged-preview"),
            "--supplier-vendor-adjusted-root",
            str(tmp_path / "supplier-vendor-adjusted"),
            "--manufacturing-adjusted-plate-root",
            str(tmp_path / "manufacturing-adjusted-plates"),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-generated-cad-parametric-v1"
    assert report["ok"] is True
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"generated_geometry_role": "source_fitted_controlled_loft_brep"' in proc.stdout


def test_fembot_inventory_surfaces_generated_cad_status() -> None:
    report = collect_fembot_inventory()

    assert report["generated_cad"]["ok"] is True
    assert report["generated_cad"]["accepted"] is False
    assert report["generated_cad"]["summary"]["links"] == 28
    assert report["generated_cad"]["summary"]["step_reloads"] == 28
    assert report["generated_cad"]["summary"]["surface_intent_counts"]["smooth"] == 26
    assert report["generated_cad"]["summary"]["internal_cavity_violation_links"] == 26
    assert (
        report["generated_cad"]["summary"][
            "active_internal_cavity_residual_violation_links"
        ]
        == 0
    )
    assert report["generated_cad"]["summary"]["volume_adjusted_z_blocked_links"] == 18
    assert report["generated_cad"]["summary"]["remediation_target_count"] == 73
    assert report["generated_cad"]["summary"]["remediation_pocket_step_exports"] == 73
    assert report["generated_cad"]["summary"]["remediation_link_pocket_set_exports"] == 26
    assert report["generated_cad"]["summary"]["pocketed_preview_exports"] == 26
    assert report["generated_cad"]["summary"]["pocketed_preview_structural_risk_links"] == 25
    assert report["generated_cad"]["summary"]["bulged_preview_exports"] == 26
    assert report["generated_cad"]["summary"]["bulged_preview_fragmented_links"] == 2
    assert report["generated_cad"]["summary"]["bulged_preview_residual_structural_risk_links"] == 15
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_exports"] == 15
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_fragmented_links"] == 1
    assert (
        report["generated_cad"]["summary"][
            "ribbed_bulged_preview_residual_structural_risk_links"
        ]
        == 1
    )
    assert report["generated_cad"]["summary"]["full_cavity_clearance_exports"] == 26
    assert report["generated_cad"]["summary"]["full_cavity_clearance_cleared_links"] == 26
    assert (
        report["generated_cad"]["summary"][
            "full_cavity_clearance_extent_tolerance_failures"
        ]
        == 1
    )
    assert (
        report["generated_cad"]["summary"][
            "full_cavity_clearance_specific_extent_tolerance_failures"
        ]
        == 0
    )
    assert (
        report["generated_cad"]["summary"][
            "full_cavity_clearance_residual_violation_links"
        ]
        == 0
    )
    assert report["generated_cad"]["summary"]["full_cavity_clearance_z_expansion_links"] == 18
    assert report["generated_cad"]["summary"]["supplier_vendor_adjusted_exports"] == 0
    assert report["generated_cad"]["summary"]["supplier_vendor_adjusted_reloads"] == 0
    assert report["generated_cad"]["summary"]["supplier_vendor_adjusted_fit_fail"] == 0
    assert report["generated_cad"]["summary"]["manufacturing_adjusted_plate_exports"] == 2
    assert (
        report["generated_cad"]["summary"][
            "manufacturing_adjusted_plate_process_floor_failures"
        ]
        == 0
    )
