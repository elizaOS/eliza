from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    FEMBOT_PROOF_TYPES,
    collect_fembot_inventory,
)


def test_fembot_inventory_groups_cover_asimov_links_once() -> None:
    links = [link for group_links in FEMBOT_BODY_GROUP_LINKS.values() for link in group_links]

    assert set(FEMBOT_BODY_GROUP_LINKS) == {"torso", "head", "arm", "leg", "foot"}
    assert len(links) == 28
    assert len(set(links)) == 28
    assert "WAIST_YAW" in FEMBOT_BODY_GROUP_LINKS["torso"]
    assert "NECK_PITCH" in FEMBOT_BODY_GROUP_LINKS["head"]
    assert "LEFT_ELBOW" in FEMBOT_BODY_GROUP_LINKS["arm"]
    assert "RIGHT_KNEE" in FEMBOT_BODY_GROUP_LINKS["leg"]
    assert "LEFT_TOE" in FEMBOT_BODY_GROUP_LINKS["foot"]


def test_fembot_inventory_is_stricter_than_visual_parametric_experiment() -> None:
    report = collect_fembot_inventory()

    assert report["schema"] == "asimov-fembot-inventory-v1"
    assert report["ok"] is True
    assert report["production_ready"] is False
    assert report["counts"]["body_groups"] == 5
    assert report["counts"]["links"] == 28
    assert report["counts"]["source_stl_links"] == 28
    assert report["counts"]["step_candidate_files"] > 0
    assert report["counts"]["proven_step_links"] == 0
    assert report["mujoco"]["static_ok"] is True
    assert report["body_matching"]["ok"] is True
    assert report["body_matching"]["accepted"] is False
    assert report["body_matching"]["summary"]["matched_links"] == 28
    assert report["body_matching"]["summary"]["accepted_link_matches"] == 0
    assert report["mesh_traceability"]["ok"] is True
    assert report["mesh_traceability"]["accepted"] is True
    assert report["mesh_traceability"]["summary"]["traceability_ready_links"] == 28
    assert report["mesh_traceability"]["summary"]["controlled_loft_source_ready_links"] == 28
    assert report["mesh_traceability"]["summary"]["exact_brep_source_ready_links"] == 0
    assert report["mesh_traceability"]["summary"]["generated_stl_physics_ready_links"] == 28
    assert report["mesh_traceability"]["summary"]["mesh_artifact_free_links"] == 28
    assert report["slimming_envelope"]["ok"] is True
    assert report["slimming_envelope"]["accepted"] is False
    assert report["slimming_envelope"]["summary"]["z_preserved_links"] == 28
    assert report["clearance_projection"]["ok"] is True
    assert report["clearance_projection"]["accepted"] is False
    assert report["clearance_projection"]["summary"]["violation_links"] > 0
    assert report["clearance_projection"]["summary"]["adjusted_violation_links"] == 0
    assert report["generated_cad"]["ok"] is True
    assert report["generated_cad"]["accepted"] is False
    assert report["generated_cad"]["summary"]["step_exports"] == 28
    assert report["generated_cad"]["summary"]["step_reloads"] == 28
    assert report["generated_cad"]["summary"]["shape_family_counts"] == {
        "source_fitted_controlled_loft": 28,
    }
    assert report["generated_cad"]["summary"]["surface_intent_counts"] == {"flat": 2, "smooth": 26}
    assert report["generated_cad"]["summary"]["hollow_shell_links"] == 26
    assert report["generated_cad"]["summary"]["internal_cavity_violation_links"] == 26
    assert report["generated_cad"]["summary"]["internal_cavity_minimum_projected_clearance_m"] < 0.0
    assert report["generated_cad"]["summary"]["volume_adjusted_xy_violation_links"] == 18
    assert report["generated_cad"]["summary"]["volume_adjusted_z_blocked_links"] == 18
    assert report["generated_cad"]["summary"]["remediation_target_count"] == 73
    assert report["generated_cad"]["summary"]["remediation_z_pocket_or_refinement_count"] == 23
    assert report["generated_cad"]["summary"]["remediation_plan_links"] == 26
    assert report["generated_cad"]["summary"]["remediation_top_priority_links"][0] == "WAIST_YAW"
    assert report["generated_cad"]["summary"]["remediation_pocket_step_exports"] == 73
    assert report["generated_cad"]["summary"]["remediation_pocket_step_reloads"] == 73
    assert report["generated_cad"]["summary"]["remediation_link_pocket_set_exports"] == 26
    assert report["generated_cad"]["summary"]["remediation_link_pocket_set_reloads"] == 26
    assert report["generated_cad"]["summary"]["pocketed_preview_exports"] == 26
    assert report["generated_cad"]["summary"]["pocketed_preview_fragmented_links"] == 7
    assert report["generated_cad"]["summary"]["pocketed_preview_structural_risk_links"] == 25
    assert report["generated_cad"]["summary"]["pocketed_preview_high_volume_loss_links"] == 25
    assert report["generated_cad"]["summary"]["bulged_preview_exports"] == 26
    assert report["generated_cad"]["summary"]["bulged_preview_high_volume_loss_links"] == 15
    assert report["generated_cad"]["summary"]["bulged_preview_fragmented_links"] == 4
    assert report["generated_cad"]["summary"]["bulged_preview_residual_structural_risk_links"] == 15
    assert report["generated_cad"]["summary"]["bulged_preview_top_residual_risk_links"][0] == "NECK_PITCH"
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_exports"] == 15
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_reloads"] == 15
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_fragmented_links"] == 0
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_high_volume_loss_links"] == 0
    assert report["generated_cad"]["summary"]["ribbed_bulged_preview_residual_structural_risk_links"] == 0
    assert report["generated_cad"]["summary"]["full_cavity_clearance_exports"] == 26
    assert report["generated_cad"]["summary"]["full_cavity_clearance_cleared_links"] == 26
    assert report["generated_cad"]["summary"]["full_cavity_clearance_residual_violation_links"] == 0
    assert report["generated_cad"]["summary"]["full_cavity_clearance_z_expansion_links"] == 18
    assert report["generated_cad"]["summary"]["manufacturing_adjusted_plate_exports"] == 2
    assert (
        report["generated_cad"]["summary"][
            "manufacturing_adjusted_plate_process_floor_failures"
        ]
        == 0
    )
    assert report["hardware_measurements"]["ok"] is True
    assert report["hardware_measurements"]["accepted"] is False
    assert report["hardware_measurements"]["summary"]["measurement_records"] == 1047
    assert report["hardware_measurements"]["summary"]["missing_measurement_records"] == 1047
    assert report["hardware_measurements"]["summary"]["remediation_targets"] == 73
    assert report["generated_topology"]["ok"] is True
    assert report["generated_topology"]["accepted"] is False
    assert report["generated_topology"]["summary"]["mesh_exports"] == 28
    assert report["generated_topology"]["summary"]["single_solid_source_steps"] == 28
    assert report["generated_topology"]["summary"]["watertight_meshes"] == 19
    assert report["generated_topology"]["summary"]["accepted_topologies"] == 19
    assert report["generated_topology"]["summary"]["topology_failure_links"] == 9
    assert report["generated_topology"]["summary"]["repair_preview_candidates"] == 9
    assert report["generated_topology"]["summary"]["repair_preview_exports"] == 9
    assert report["generated_topology"]["summary"]["repair_preview_reloads"] == 9
    assert (
        report["generated_topology"]["summary"]["repair_preview_accepted_topologies"]
        == 9
    )
    assert report["generated_topology"]["summary"]["repair_preview_failure_links"] == 0
    assert (
        report["generated_topology"]["summary"][
            "repair_preview_promotable_by_topology_and_envelope"
        ]
        is True
    )
    assert report["topology_promotion"]["ok"] is True
    assert report["topology_promotion"]["accepted"] is True
    assert report["topology_promotion"]["summary"]["links"] == 28
    assert report["topology_promotion"]["summary"]["promoted_repair_preview_links"] == 9
    assert report["topology_promotion"]["summary"]["accepted_promoted_meshes"] == 28
    assert report["surface_quality"]["summary"]["generated_reference_links"] == 28
    assert report["surface_quality"]["summary"]["generated_flat_plate_surfaces"] == 2
    assert report["surface_quality"]["summary"]["generated_smooth_loft_surfaces"] == 26
    assert report["surface_quality"]["summary"]["generated_surface_check_failures"] == 0
    assert report["foot_handling"]["ok"] is True
    assert report["foot_handling"]["accepted"] is True
    assert report["foot_handling"]["summary"]["foot_collision_geoms_preserved"] is True
    assert report["foot_handling"]["summary"]["non_foot_floor_contact_count"] == 0
    assert report["foot_handling"]["summary"]["flat_foot_plate_count"] == 2
    assert report["foot_handling"]["summary"]["manufacturing_adjusted_foot_plate_count"] == 2
    assert report["foot_handling"]["summary"]["foot_flatness_ok_count"] == 2
    assert report["inertia_calibration"]["ok"] is True
    assert report["inertia_calibration"]["accepted"] is False
    assert report["inertia_calibration"]["summary"]["calibration_ready"] is True
    assert report["inertia_calibration"]["summary"]["hardware_measured_links"] == 0
    assert report["inertia_calibration"]["summary"]["hardware_measurement_schema"] == (
        "asimov-fembot-hardware-measurement-requirements-v1"
    )
    assert report["inertia_calibration"]["summary"]["hardware_measurement_required_links"] == 28
    assert len(report["inertia_calibration"]["summary"]["missing_hardware_links"]) == 28
    assert report["controller_validation"]["ok"] is True
    assert report["controller_validation"]["accepted"] is False
    assert (
        report["controller_validation"]["summary"]["mujoco_controller_rollout_ok"]
        is True
    )
    assert report["controller_validation"]["summary"]["actuator_order_ok"] is True
    assert report["controller_validation"]["summary"]["actuators_commanded"] == 25
    assert (
        report["controller_validation"]["summary"]["hardware_controller_validated"]
        is False
    )
    assert report["material_manufacturing"]["ok"] is True
    assert report["material_manufacturing"]["accepted"] is False
    assert report["material_manufacturing"]["summary"]["classification_ok"] is True
    assert report["material_manufacturing"]["summary"]["generated_part_records"] == 28
    assert report["material_manufacturing"]["summary"]["generated_mass_estimate_kg"] > 0.0
    assert report["material_manufacturing"]["summary"]["generated_wall_thickness_failures"] == 2
    assert (
        report["material_manufacturing"]["summary"][
            "generated_adjusted_wall_thickness_failures"
        ]
        == 0
    )
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
    assert report["structural_sanity"]["summary"]["internal_cavity_blocker_links"] == 26
    assert report["structural_sanity"]["summary"]["volume_adjusted_blocker_links"] == 16
    assert (
        report["structural_sanity"]["summary"][
            "ribbed_bulged_preview_residual_structural_risk_links"
        ]
        == 0
    )
    assert report["structural_sanity"]["summary"]["topology_repair_preview_links"] == 9
    assert (
        report["structural_sanity"]["summary"][
            "topology_repair_preview_envelope_preserved_links"
        ]
        == 9
    )
    assert report["structural_sanity"]["summary"]["analytic_load_cases"] == 84
    assert report["structural_sanity"]["summary"]["analytic_load_case_failure_links"] == 6
    assert report["structural_sanity"]["summary"]["structural_remediation_links"] == 6
    assert report["structural_sanity"]["summary"]["structural_remediation_preview_exports"] == 6
    assert report["structural_sanity"]["summary"]["structural_remediation_preview_reloads"] == 6
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
            "structural_remediation_internal_cavity_checked_links"
        ]
        == 6
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_adjusted_violations"
        ]
        == 20
    )
    assert (
        report["structural_sanity"]["summary"][
            "structural_remediation_internal_cavity_z_blocked_links"
        ]
        == 2
    )
    assert report["structural_sanity"]["summary"]["minimum_preliminary_safety_factor"] < 1.0
    assert report["assembly"]["ok"] is True
    assert report["assembly"]["accepted"] is False
    assert report["assembly"]["summary"]["actuator_order_ok"] is True
    assert report["assembly"]["summary"]["generated_link_count"] == 28
    assert report["assembly"]["summary"]["visual_body_link_count"] == 28
    assert report["assembly"]["summary"]["mate_gap_max_m"] == 0.0
    assert report["assembly"]["summary"]["axis_delta_max_rad"] == 0.0
    assert report["assembly"]["summary"]["structural_remediation_assembly_links"] == 6
    assert report["assembly"]["summary"]["structural_remediation_actuated_links"] == 6
    assert report["assembly"]["summary"]["structural_remediation_z_refinement_links"] == 2
    assert report["fembot_collision_dynamics"]["ok"] is False
    assert report["fembot_collision_dynamics"]["accepted"] is False
    assert report["fembot_collision_dynamics"]["summary"]["generated_links"] == 28
    assert report["fembot_collision_dynamics"]["summary"]["mujoco_dynamic_step_ok"] is True
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_geometry_substituted_in_mjcf"
        ]
        is True
    )
    assert report["fembot_collision_dynamics"]["summary"]["fembot_mass_inertia_ok"] is True
    assert report["fembot_collision_dynamics"]["summary"]["fembot_actuator_lag_ok"] is True
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "structural_remediation_contact_risk_pairs"
        ]
        == 0
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "structural_remediation_contact_risk_links"
        ]
        == 0
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_promoted_contact_tuned_collider_contact_clean"
        ]
        is True
    )
    assert report["fembot_collision_dynamics"]["summary"]["foot_handling_accepted"] is True
    assert (
        report["fembot_collision_dynamics"]["summary"]["inertia_calibration_ready"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "inertia_mass_out_of_tolerance_count"
        ]
        == 28
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "inertia_inertia_out_of_tolerance_count"
        ]
        == 28
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "inertia_total_required_added_mass_to_match_compiled_kg"
        ]
        > 0.0
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_simulation_validated"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_motor_response_profile_ok"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_trajectory_response_overshoot_count"
        ]
        == 0
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_hardware_validated"
        ]
        is False
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "contact_tuning_clears_sampled_self_contacts_and_visual_fit"
        ]
        is True
    )
    assert report["visual_review"]["ok"] is True
    assert report["visual_review"]["accepted"] is False
    assert report["visual_review"]["summary"]["body_groups"] == 5
    assert report["visual_review"]["summary"]["render_paths"] == 15
    assert report["visual_review"]["summary"]["missing_render_paths"] == []
    assert report["visual_motion_media"]["ok"] is True
    assert report["visual_motion_media"]["accepted"] is False
    assert report["visual_motion_media"]["summary"]["screenshot_count"] == 6
    assert report["visual_motion_media"]["summary"]["video_frame_count"] == 144
    assert report["visual_motion_media"]["summary"]["joint_count"] == 27

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["links"] == ["IMU_ORIGIN", "WAIST_YAW"]
    assert groups["head"]["assembly_candidates"] == ["100"]
    assert groups["arm"]["assembly_candidates"] == ["300", "400"]
    assert groups["leg"]["assembly_candidates"] == ["500", "600"]

    for group in groups.values():
        assert group["required_proofs"] == list(FEMBOT_PROOF_TYPES)
        assert "source_step_or_controlled_loft" in group["required_proofs"]
        assert "manufacturing_process" in group["missing_proofs"]
        assert "hardware_measurements" in group["missing_proofs"]
        assert "collision_sweep" in group["missing_proofs"]
        assert "all_cad_no_stl_parametric" in group["missing_proofs"]
        assert "visual_motion_media" in group["required_proofs"]
        assert "visual_motion_media" not in group["missing_proofs"]
        assert group["step_candidate_count"] == len(group["step_candidates"])
        assert group["source_stl_count"] == len(group["links"])


def test_fembot_inventory_cli_can_gate_production_readiness() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/inventory_asimov_fembot.py",
            "--require-production-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert '"production_ready": false' in proc.stdout
