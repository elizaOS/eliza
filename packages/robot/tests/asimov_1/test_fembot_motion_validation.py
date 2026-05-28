from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory
from eliza_robot.asimov_1.fembot_motion_validation import build_fembot_collision_dynamics_proof


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def _contact_tuning_report() -> dict[str, object]:
    return {
        "schema": "asimov-fembot-contact-tuning-proof-v1",
        "ok": True,
        "accepted": False,
        "summary": {
            "best_strategy": "physical_visual_remediation",
            "contact_clean_scale_count": 7,
            "contact_clean_and_visual_fit_scale_count": 1,
            "physical_visual_remediation_contact_clean_count": 1,
            "physical_visual_remediation_visual_fit_clean_count": 1,
            "physical_visual_remediation_geom_count": 5,
            "visual_fit_remediation_geom_count": 0,
            "hip_roll_limit_contact_clean_count": 2,
            "first_hip_roll_limit_contact_clean_rad": 0.25,
            "hip_roll_limit_best_unapproved_contact_count": 0,
            "hip_roll_limit_best_contact_pair_count": 0,
            "physical_visual_remediation_best_worst_mean_outside_margin_m": 0.03282405299866911,
            "physical_visual_remediation_best_worst_outside_fraction": 0.8188,
        },
    }


def _joint_sweep_visual_report() -> dict[str, object]:
    return {
        "schema": "asimov-1-constrained-joint-sweep-visual-evidence-v1",
        "ok": True,
        "accepted": False,
        "video": "evidence/asimov_1_joint_sweep_contact_clean/asimov1_constrained_joint_sweep.mp4",
        "contact_sheet": "evidence/asimov_1_joint_sweep_contact_clean/asimov1_constrained_joint_sweep_contact_sheet.jpg",
        "screenshot_count": 82,
        "frame_count": 298,
        "summary": {
            "limited_hinge_joints": 27,
            "samples": 298,
            "video_recorded": True,
            "screenshots_recorded": True,
            "standing_height_gate": True,
            "unapproved_contact_samples": 0,
            "max_unapproved_contacts": 0,
            "hip_roll_inward_limit_rad": 0.25,
            "hip_roll_limited_joint_count": 2,
            "contact_clean_dense_range_applied": True,
            "contact_clean_dense_range_changed_joints": 5,
            "visual_review_required": True,
        },
    }


def test_fembot_collision_dynamics_proof_tracks_promoted_collider_clearance() -> None:
    report = build_fembot_collision_dynamics_proof(
        _body_groups(),
        contact_tuning_report=_contact_tuning_report(),
        joint_sweep_visual_report=_joint_sweep_visual_report(),
    )

    assert report["schema"] == "asimov-fembot-collision-dynamics-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["generated_links"] == 28
    assert report["summary"]["missing_generated_links"] == []
    assert report["summary"]["fembot_collision_samples"] >= 80
    assert report["summary"]["fembot_unapproved_contact_samples"] == 0
    assert report["summary"]["fembot_unapproved_contact_count"] == 0
    assert report["summary"]["fembot_contact_pair_count"] == 0
    assert report["summary"]["fembot_minimum_unapproved_distance_m"] is None
    assert report["summary"]["fembot_worst_sample"] is None
    assert report["summary"]["fembot_worst_contact_pair"] is None
    assert report["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert report["summary"]["structural_remediation_contact_risk_links"] == 0
    assert report["summary"]["structural_remediation_contact_risk_link_names"] == []
    assert report["summary"]["structural_remediation_no_current_contact_links"] == [
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "LEFT_SHOULDER_YAW",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
        "RIGHT_SHOULDER_YAW",
    ]
    assert report["summary"]["structural_remediation_contact_worsened_pairs"] == 0
    assert report["summary"]["structural_remediation_worst_estimated_distance_after_growth_m"] is None
    assert report["summary"]["baseline_collision_samples"] >= 80
    assert report["summary"]["baseline_unapproved_contact_samples"] == 0
    assert report["summary"]["neutral_sample_accepted"] is True
    assert report["summary"]["mujoco_dynamic_step_ok"] is True
    assert report["summary"]["fembot_geometry_substituted_in_mjcf"] is True
    assert report["summary"]["fembot_mjcf_ok"] is True
    assert report["summary"]["fembot_hip_spacing_ratio"] < 0.98
    assert report["summary"]["fembot_mass_inertia_ok"] is True
    assert report["summary"]["fembot_total_mass_kg"] > 0.0
    assert report["summary"]["fembot_actuator_lag_ok"] is True
    assert report["summary"]["fembot_actuators_tracked"] == 25
    assert report["summary"]["fembot_contact_tuned_colliders_promoted"] is True
    assert (
        report["summary"]["fembot_contact_tuned_collider_strategy"]
        == "physical_visual_remediation_promoted"
    )
    assert report["summary"]["fembot_contact_tuned_collider_scaled_geom_count"] == 19
    assert report["summary"]["fembot_contact_tuned_collider_fit_geom_count"] == 15
    assert (
        report["summary"][
            "fembot_contact_tuned_collider_physical_visual_remediation_geom_count"
        ]
        == 5
    )
    assert report["summary"]["fembot_promoted_contact_tuned_collider_contact_clean"] is True
    assert report["summary"]["foot_handling_ok"] is True
    assert report["summary"]["foot_handling_accepted"] is True
    assert report["summary"]["foot_collision_geoms_preserved"] is True
    assert report["summary"]["foot_non_foot_floor_contact_count"] == 0
    assert report["summary"]["foot_flat_plate_count"] == 2
    assert report["summary"]["foot_manufacturing_adjusted_plate_count"] == 2
    assert report["summary"]["foot_flatness_ok_count"] == 2
    assert report["summary"]["inertia_calibration_ok"] is True
    assert report["summary"]["inertia_calibration_accepted"] is False
    assert report["summary"]["inertia_calibration_ready"] is True
    assert report["summary"]["inertia_hardware_measured_links"] == 0
    assert report["summary"]["inertia_missing_hardware_links"] == 28
    assert report["summary"]["inertia_cad_mass_estimate_kg"] > 0.0
    assert report["summary"]["inertia_compiled_total_mass_kg"] > 0.0
    assert report["summary"]["inertia_mass_out_of_tolerance_count"] == 28
    assert report["summary"]["inertia_inertia_out_of_tolerance_count"] == 28
    assert (
        report["summary"]["inertia_total_required_added_mass_to_match_compiled_kg"]
        > 0.0
    )
    assert (
        report["summary"]["inertia_max_required_added_mass_to_match_compiled_kg"]
        > 0.0
    )
    assert report["summary"]["inertia_max_mass_scale_to_compiled"] > 1.0
    assert report["summary"]["inertia_max_inertia_scale_to_compiled"] > 1.0
    assert report["summary"]["controller_validation_ok"] is True
    assert report["summary"]["controller_validation_accepted"] is False
    assert report["summary"]["controller_simulation_validated"] is True
    assert report["summary"]["controller_motor_response_profile_ok"] is True
    assert report["summary"]["controller_hardware_validated"] is False
    assert report["summary"]["controller_actuator_order_ok"] is True
    assert report["summary"]["controller_actuators_commanded"] == 25
    assert report["summary"]["controller_trajectory_final_max_abs_error_rad"] < 0.1
    assert report["summary"]["controller_trajectory_final_median_abs_error_rad"] < 0.02
    assert (
        0.0
        <= report["summary"]["controller_trajectory_early_median_response_fraction"]
        < 0.5
    )
    assert report["summary"][
        "controller_trajectory_settled_median_response_fraction"
    ] > report["summary"]["controller_trajectory_early_median_response_fraction"]
    assert report["summary"]["controller_trajectory_response_overshoot_count"] == 0
    assert report["summary"]["contact_tuning_ok"] is True
    assert report["summary"]["contact_tuning_accepted"] is False
    assert report["summary"]["contact_tuning_best_strategy"] == "physical_visual_remediation"
    assert report["summary"]["contact_tuning_contact_clean_scale_count"] == 7
    assert report["summary"]["contact_tuning_contact_clean_and_visual_fit_scale_count"] == 1
    assert report["summary"]["contact_tuning_physical_visual_remediation_contact_clean_count"] == 1
    assert report["summary"]["contact_tuning_physical_visual_remediation_visual_fit_clean_count"] == 1
    assert report["summary"]["contact_tuning_physical_visual_remediation_geom_count"] == 5
    assert report["summary"]["contact_tuning_visual_fit_remediation_geom_count"] == 0
    assert report["summary"]["contact_tuning_hip_roll_limit_contact_clean_count"] == 2
    assert (
        report["summary"]["contact_tuning_first_hip_roll_limit_contact_clean_rad"]
        == 0.25
    )
    assert report["summary"]["contact_tuning_hip_roll_limit_best_unapproved_contact_count"] == 0
    assert report["summary"]["contact_tuning_hip_roll_limit_best_contact_pair_count"] == 0
    assert (
        report["summary"]["contact_tuning_clears_sampled_self_contacts_and_visual_fit"]
        is True
    )
    assert (
        report["summary"][
            "contact_tuning_clears_sampled_cross_leg_contacts_with_motion_limit"
        ]
        is True
    )
    assert report["summary"]["joint_sweep_visual_ok"] is True
    assert report["summary"]["joint_sweep_visual_video_recorded"] is True
    assert report["summary"]["joint_sweep_visual_screenshots_recorded"] is True
    assert report["summary"]["joint_sweep_visual_standing_height_gate"] is True
    assert report["summary"]["joint_sweep_visual_contact_clean"] is True
    assert report["summary"]["joint_sweep_visual_unapproved_contact_samples"] == 0
    assert report["summary"]["joint_sweep_visual_max_unapproved_contacts"] == 0
    assert report["summary"]["joint_sweep_visual_limited_hinge_joints"] == 27
    assert report["summary"]["joint_sweep_visual_frame_count"] == 298
    assert report["summary"]["joint_sweep_visual_screenshot_count"] == 82
    assert report["summary"]["joint_sweep_visual_hip_roll_inward_limit_rad"] == 0.25
    assert report["summary"]["joint_sweep_visual_hip_roll_limited_joint_count"] == 2
    assert (
        report["summary"]["joint_sweep_visual_contact_clean_dense_range_applied"]
        is True
    )
    assert (
        report["summary"]["joint_sweep_visual_contact_clean_dense_range_changed_joints"]
        == 5
    )
    assert "CAD-vs-MJCF inertia records are mapped" in report["summary"][
        "acceptance_blocker"
    ]
    assert "diagnostic inward hip-roll limit clears sampled cross-leg" in report["summary"][
        "acceptance_blocker"
    ]
    assert "hardware mass/inertia measurements" in report["summary"][
        "acceptance_blocker"
    ]
    assert "hardware motor-controller telemetry" in report["summary"][
        "acceptance_blocker"
    ]
    assert report["contact_tuning"]["clears_sampled_self_contacts_and_visual_fit"] is True
    assert (
        report["contact_tuning"][
            "clears_sampled_cross_leg_contacts_with_motion_limit"
        ]
        is True
    )
    assert report["contact_pairs"] == []
    assert report["controller_validation"]["ok"] is True
    assert report["controller_validation"]["accepted"] is False

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["generated_link_count"] == 2
    assert groups["arm"]["generated_link_count"] == 10
    assert groups["leg"]["generated_link_count"] == 12


def test_fembot_inventory_surfaces_collision_dynamics_gap() -> None:
    report = collect_fembot_inventory()

    assert report["fembot_collision_dynamics"]["ok"] is True
    assert report["fembot_collision_dynamics"]["accepted"] is False
    assert report["fembot_collision_dynamics"]["summary"]["generated_links"] == 28
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_geometry_substituted_in_mjcf"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["fembot_mass_inertia_ok"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["fembot_actuator_lag_ok"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "structural_remediation_contact_risk_pairs"
        ]
        == 0
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "structural_remediation_no_current_contact_links"
        ]
        == [
            "LEFT_HIP_YAW",
            "LEFT_KNEE",
            "LEFT_SHOULDER_YAW",
            "RIGHT_HIP_YAW",
            "RIGHT_KNEE",
            "RIGHT_SHOULDER_YAW",
        ]
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_promoted_contact_tuned_collider_contact_clean"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["foot_handling_accepted"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["inertia_calibration_ready"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["inertia_missing_hardware_links"]
        == 28
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
            "contact_tuning_clears_sampled_self_contacts_and_visual_fit"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "joint_sweep_visual_contact_clean"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "joint_sweep_visual_standing_height_gate"
        ]
        is True
    )
    assert report["fembot_collision_dynamics"]["contact_pairs"] == []


def test_fembot_collision_dynamics_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-collision-dynamics.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_collision_dynamics_proof.py",
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
    assert report["schema"] == "asimov-fembot-collision-dynamics-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
