from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import mujoco
import pytest


PKG_ROOT = Path(__file__).resolve().parents[1]
BODYKIT_ROOT = PKG_ROOT / "mechanical" / "unitree-r1-bodykit"


def test_unitree_r1_bodykit_generator_outputs_valid_mjcf() -> None:
    subprocess.run(
        [
            sys.executable,
            "scripts/generate_unitree_r1_bodykit.py",
            "--skip-render",
            "--skip-video",
        ],
        cwd=PKG_ROOT,
        check=True,
    )
    mjcf = BODYKIT_ROOT / "out" / "mjcf" / "R1_C++_bodykit.xml"
    collision_mjcf = BODYKIT_ROOT / "out" / "mjcf" / "R1_C++_bodykit_collision_test.xml"
    report = BODYKIT_ROOT / "review" / "fit-validation.json"
    manifest = BODYKIT_ROOT / "review" / "manufacturing-manifest.json"
    panel_gap = BODYKIT_ROOT / "review" / "panel-gap-validation.json"
    part_review = BODYKIT_ROOT / "review" / "part-review-report.json"
    face_alignment = BODYKIT_ROOT / "review" / "face-alignment-validation.json"
    stress_blockers = BODYKIT_ROOT / "review" / "mechanical-stress-blockers.json"
    head_keepout_policy = BODYKIT_ROOT / "review" / "head-keepout-policy.json"
    render_validation = BODYKIT_ROOT / "review" / "render-validation.json"
    concept_reference = BODYKIT_ROOT / "review" / "reference-validation.json"
    layout = BODYKIT_ROOT / "review" / "shapeways-print-layout.csv"
    dfm = BODYKIT_ROOT / "review" / "injection-molding-dfm.json"
    step_report = BODYKIT_ROOT / "review" / "step-export-report.json"
    source_audit = BODYKIT_ROOT / "review" / "design-source-audit.json"
    morph_report = BODYKIT_ROOT / "review" / "parametric-morph-report.json"
    base_reconstruction = BODYKIT_ROOT / "review" / "base-cad-reconstruction-report.json"
    reconstruction_audit = BODYKIT_ROOT / "review" / "parametric-reconstruction-audit.json"
    subassembly_report = BODYKIT_ROOT / "review" / "subassembly-volume-report.json"
    step_dir = BODYKIT_ROOT / "out" / "step"
    base_reconstruction_step_dir = BODYKIT_ROOT / "out" / "base-reconstruction" / "step"
    base_reconstruction_param_dir = BODYKIT_ROOT / "out" / "base-reconstruction" / "params"
    assert mjcf.is_file()
    assert collision_mjcf.is_file()
    assert report.is_file()
    assert manifest.is_file()
    assert panel_gap.is_file()
    assert part_review.is_file()
    assert face_alignment.is_file()
    assert stress_blockers.is_file()
    assert head_keepout_policy.is_file()
    if render_validation.is_file():
        render_raw = json.loads(render_validation.read_text())
        assert render_raw["verdict"] in {"pass", "needs-work"}
        assert "bodykit_front.png" in render_raw["required_images"]
        assert "bodykit_front_concept_overlay.png" in render_raw["required_images"]
        assert "bodykit_front_reference_scale_overlay.png" in render_raw["required_images"]
    assert layout.is_file()
    assert dfm.is_file()
    assert step_report.is_file()
    assert source_audit.is_file()
    assert morph_report.is_file()
    assert base_reconstruction.is_file()
    assert reconstruction_audit.is_file()
    assert subassembly_report.is_file()
    assert concept_reference.is_file()

    model = mujoco.MjModel.from_xml_path(str(mjcf))
    assert model.nu == 29
    bodykit_geoms = [
        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i)
        for i in range(model.ngeom)
    ]
    assert any((name or "").startswith("bodykit_face_shell") for name in bodykit_geoms)
    assert any((name or "").startswith("bodykit_torso_chest_shell") for name in bodykit_geoms)
    removed_bridge_name = "gl" + "asses_bridge"
    assert not any(removed_bridge_name in (name or "") for name in bodykit_geoms)

    raw = json.loads(report.read_text())
    assert raw["verdict"] in {"pass", "needs-work"}
    assert raw["simulator_verdict"] == "pass"
    assert raw["clearance_verdict"] in {"pass", "needs-work"}
    assert raw["production_fit_verdict"] == raw["clearance_verdict"]
    assert raw["bodykit_geoms_are_visual_only"] is True
    assert raw["collision_test_model_loads"] is True
    assert raw["bodykit_contact_count"] == 0
    assert raw["sampled_clearance_is_advisory"] is False
    assert raw["clearance_sampling"] == "deterministic_vertices_and_face_centroids"
    assert raw["articulated_body_distance"] >= 1
    assert raw["minimum_non_mounted_body_clearance_mm"] >= 0
    assert raw["minimum_non_adjacent_body_clearance_mm"] >= 0
    assert raw["worst_non_mounted_body_clearance"]["part"]
    assert raw["worst_non_adjacent_body_clearance"]["part"]
    assert raw["worst_non_mounted_body_clearance"]["base_geom"]
    assert raw["dynamic_joint_sweep"]["poses_checked"] >= 60
    assert raw["dynamic_joint_sweep"]["minimum_non_mounted_clearance_mm"] >= 0
    assert raw["dynamic_joint_sweep"]["minimum_non_adjacent_clearance_mm"] >= 0
    assert raw["dynamic_joint_sweep"]["label"] == "bodykit_operating"
    assert raw["mechanical_dynamic_joint_sweep"]["label"] == "mechanical"
    assert raw["mechanical_dynamic_joint_sweep"]["sweep_fraction"] >= raw["dynamic_joint_sweep"]["sweep_fraction"]
    assert raw["mechanical_dynamic_joint_sweep"]["minimum_non_adjacent_clearance_mm"] >= 0
    assert raw["dynamic_joint_sweep"]["worst_non_adjacent_pose"]
    assert any(
        pose.get("worst_clearance", {}).get("base_geom")
        for pose in raw["dynamic_joint_sweep"]["pose_results"]
    )
    assert any(
        pose.get("worst_non_adjacent_clearance", {}).get("base_geom")
        for pose in raw["dynamic_joint_sweep"]["pose_results"]
    )
    manifest_raw = json.loads(manifest.read_text())
    panel_gap_raw = json.loads(panel_gap.read_text())
    part_review_raw = json.loads(part_review.read_text())
    face_alignment_raw = json.loads(face_alignment.read_text())
    stress_raw = json.loads(stress_blockers.read_text())
    head_keepout_raw = json.loads(head_keepout_policy.read_text())
    assert panel_gap_raw["verdict"] in {"pass", "needs-work"}
    assert panel_gap_raw["pairs_checked"] > 0
    assert "pairs_below_gap_gate" in panel_gap_raw
    assert panel_gap_raw["seated_detail_gap_mm"] > 0
    assert panel_gap_raw["minimum_sampled_panel_gap_mm"] is not None
    assert any(
        row.get("interface_type") == "seated_detail"
        and {row["role_a"], row["role_b"]} == {"face", "face_detail"}
        for row in panel_gap_raw["seated_detail_pairs"]
    )
    assert manifest_raw["panel_gap_validation"]["verdict"] == panel_gap_raw["verdict"]
    assert manifest_raw["part_review"]["verdict"] == part_review_raw["verdict"]
    assert manifest_raw["face_alignment_validation"]["verdict"] == face_alignment_raw["verdict"]
    assert face_alignment_raw["verdict"] == "pass"
    assert face_alignment_raw["face_shell_source"].endswith("eliza_face_donor.stl")
    assert face_alignment_raw["reference_assets"]["face_closeup_jpeg"]["exists"] is True
    assert face_alignment_raw["reference_assets"]["full_body_jpeg"]["exists"] is True
    assert face_alignment_raw["reference_assets"]["source_front_glb"]["exists"] is True
    assert face_alignment_raw["source_robot_subassemblies"]["neck_carrier"]["mounted_robot_bodies"] == [
        "torso_link"
    ]
    assert face_alignment_raw["source_robot_subassemblies"]["face_plate_details"]["parts"] == [
        "face_shell",
        "left_eye_insert",
        "right_eye_insert",
        "lip_insert",
    ]
    assert face_alignment_raw["source_robot_subassemblies"]["hair_reference_only"]["parts"] == []
    assert face_alignment_raw["hair_reference_policy"]["generated_geometry"] is False
    assert face_alignment_raw["hair_reference_policy"]["params_no_hair"] is True
    assert face_alignment_raw["wrist_collision_policy"]["face_geometry_can_close_wrist_rows"] is False
    assert "wrist/forearm" in face_alignment_raw["wrist_collision_policy"]["required_resolution"]
    assert face_alignment_raw["minimum_neck_head_face_non_mounted_clearance_mm"] >= 0
    assert face_alignment_raw["minimum_neck_head_face_non_adjacent_clearance_mm"] >= 0
    assert face_alignment_raw["face_shell_depth_check"]["minimum_mm"] >= 12.0
    assert face_alignment_raw["face_shell_depth_check"]["actual_mm"] == face_alignment_raw["face_shell_extents_mm"][0]
    assert face_alignment_raw["aesthetic_depth_verdict"] in {"pass", "needs-work"}
    face_surfacing = face_alignment_raw["face_production_surfacing"]
    assert face_surfacing["verdict"] == "parametric-step-pass"
    assert face_surfacing["source_kind"] == "parametric_donor_face_grid"
    assert face_surfacing["preserves_fit_geometry"] is False
    assert face_surfacing["collision_mesh_changed"] is True
    assert "fixed-yz-grid" in face_surfacing["surface_method"]
    assert face_surfacing["face_depth_mm"] == face_alignment_raw["face_shell_depth_check"]["actual_mm"]
    assert face_surfacing["visual_finish"]["preserve_collision_mesh"] is True
    assert face_alignment_raw["comparisons"]["eye_center_down_from_face_top"]["within_tolerance"] is True
    assert face_alignment_raw["comparisons"]["mouth_center_down_from_face_top"]["within_tolerance"] is True
    assert stress_raw["verdict"] in {"pass", "needs-work"}
    assert stress_raw["target_mm"] == raw["required_dynamic_clearance_mm"]
    assert stress_raw["mechanical_sweep_fraction"] == raw["mechanical_dynamic_joint_sweep"]["sweep_fraction"]
    assert stress_raw["minimum_non_adjacent_clearance_mm"] == raw["mechanical_dynamic_joint_sweep"][
        "minimum_non_adjacent_clearance_mm"
    ]
    assert stress_raw["head_keepout_policy"]["candidate_count"] == head_keepout_raw["candidate_count"]
    assert head_keepout_raw["controlled_part"] == "face_shell"
    assert head_keepout_raw["controlled_base_body_suffix"] == "wrist_roll_link"
    if head_keepout_raw["candidate_count"]:
        assert head_keepout_raw["verdict"] == "needs-implementation"
        assert head_keepout_raw["minimum_candidate_clearance_mm"] < stress_raw["target_mm"]
        assert all(row["part"] == "face_shell" for row in head_keepout_raw["candidate_rows"])
        assert all(str(row["base_body"]).endswith("wrist_roll_link") for row in head_keepout_raw["candidate_rows"])
    if stress_raw["top_blockers"]:
        first = stress_raw["top_blockers"][0]
        assert first["part"]
        assert len(first["part_sample_point_m"]) == 3
        assert len(first["base_sample_point_m"]) == 3
        assert len(first["part_to_base_vector_mm"]) == 3
        assert first["region"] in {
            "feet_ankles",
            "legs",
            "hips_torso_chest_back",
            "arms",
            "neck_head_face",
        }
        assert first["clearance_mm"] < stress_raw["target_mm"]
    assert (
        part_review_raw["regions"]["neck_head_face"]["programmatic_checks"]["face_alignment_verdict"]
        == face_alignment_raw["verdict"]
    )
    for region in [
        "feet_ankles",
        "legs",
        "hips_torso_chest_back",
        "arms",
        "neck_head_face",
    ]:
        assert part_review_raw["regions"][region]["part_count"] > 0
        assert any(
            image.endswith("_concept_overlay.png")
            for image in part_review_raw["regions"][region]["review_images"]
        )
    assert "left_forearm_shell" in part_review_raw["regions"]["arms"]["parts"]
    assert "left_forearm_shell" not in part_review_raw["regions"]["hips_torso_chest_back"]["parts"]
    assert not part_review_raw["unclassified_parts"]
    assert any(part["name"] == "left_foot_top_shell" for part in manifest_raw["parts"])
    assert any(part["name"] == "rear_back_spine_plate" for part in manifest_raw["parts"])
    concept_asset = BODYKIT_ROOT / "cad" / "source-assets" / "concept" / "eliza_front_reference.png"
    assert concept_asset.is_file()
    concept_mesh = BODYKIT_ROOT / "cad" / "source-assets" / "concept" / "eliza_front_reference.glb"
    assert concept_mesh.is_file()
    concept_raw = json.loads(concept_reference.read_text())
    assert concept_raw["verdict"] == "pass"
    assert concept_raw["mesh"]["height_m"] > 1.0
    assert concept_raw["mesh"]["scale_to_r1_height"] > 0
    assert concept_raw["source_match"]["png_hash_match"] in {True, None}
    assert concept_raw["source_match"]["glb_hash_match"] in {True, None}
    face_part = next(part for part in manifest_raw["parts"] if part["name"] == "face_shell")
    assert face_part["source_kind"] == "parametric_donor_face_grid"
    assert face_part["source_asset"].endswith("eliza_face_donor.stl")
    source_raw = json.loads(source_audit.read_text())
    assert source_raw["verdict"] == "pass"
    assert source_raw["missing_oem_baseline_parts"] == []
    morph_raw = json.loads(morph_report.read_text())
    assert morph_raw["verdict"] == "pass"
    assert morph_raw["applied_count"] >= 7
    assert morph_raw["skipped_count"] == 0
    assert {
        "torso_chest_shell",
        "pelvis_front_shell",
        "left_shin_shell",
        "left_forearm_outer_blade",
        "right_forearm_outer_blade",
        "left_wrist_separated_cuff",
        "right_wrist_separated_cuff",
    }.issubset({row["part"] for row in morph_raw["applied"]})
    assert morph_raw["morphs"]["feminine_compact_v1"]["blend"] == 1.0
    assert morph_raw["morphs"]["feminine_compact_v1"]["controls"]["waist_y_scale"] < 1.0
    torso_morph = next(row for row in morph_raw["applied"] if row["part"] == "torso_chest_shell")
    assert torso_morph["kind"] == "section_loft"
    assert torso_morph["section_deltas"][0]["scale_delta"][1]["percent"] < 0
    arm_morph = next(row for row in morph_raw["applied"] if row["part"] == "left_forearm_outer_blade")
    assert arm_morph["kind"] == "section_loft"
    assert arm_morph["section_deltas"][0]["axis"] == "x"
    assert arm_morph["section_deltas"][0]["scale_delta"][0]["percent"] < 0
    dfm_raw = json.loads(dfm.read_text())
    assert dfm_raw["verdict"] == "prototype-fit-check-ready"
    assert dfm_raw["prototype_fit_ready"] is True
    assert dfm_raw["tooling_ready"] is False
    assert dfm_raw["panel_gap_verdict"] == panel_gap_raw["verdict"]
    assert dfm_raw["tooling_release_verdict"] == "blocked-until-final-r1-cad-and-production-dfm"

    step_raw = json.loads(step_report.read_text())
    assert step_raw["status"] in {"exported", "partial"}
    assert step_raw["exported_count"] + step_raw.get("blocked_count", 0) == raw["bodykit_parts"]
    assert len(list(step_dir.glob("*.step"))) == step_raw["exported_count"]
    assert step_raw["blocked_count"] == 0
    assert step_raw.get("blocked_parts", []) == []
    face_step = next(part for part in step_raw["parts"] if part["name"] == "face_shell")
    assert face_step["shape"] == "donor_face_grid_loft"
    assert (step_dir / "face_shell.step").is_file()
    loft_exports = {part["name"] for part in step_raw["parts"] if part["shape"] == "section_loft"}
    assert {
        "torso_chest_shell",
        "pelvis_front_shell",
        "left_shoulder_cap",
        "right_shoulder_cap",
        "left_shin_shell",
        "right_shin_shell",
    }.issubset(loft_exports)
    base_reconstruction_raw = json.loads(base_reconstruction.read_text())
    assert base_reconstruction_raw["verdict"] == "pass"
    assert base_reconstruction_raw["official_step_source_available"] is False
    assert base_reconstruction_raw["source"] == "unitree-r1 MJCF STL assets"
    assert base_reconstruction_raw["reconstructed_count"] == base_reconstruction_raw["asset_count"]
    assert base_reconstruction_raw["failed_count"] == 0
    assert len(list(base_reconstruction_step_dir.glob("*.step"))) == base_reconstruction_raw["reconstructed_count"]
    assert len(list(base_reconstruction_param_dir.glob("*.json"))) == base_reconstruction_raw["reconstructed_count"]
    torso_reconstruction = next(
        row for row in base_reconstruction_raw["assets"] if row["asset"] == "torso_collision.stl"
    )
    assert torso_reconstruction["reconstruction_kind"] == "parametric_mesh_section_loft"
    assert torso_reconstruction["sections_count"] >= 9
    assert Path(torso_reconstruction["step"]).is_file()
    assert Path(torso_reconstruction["parameters"]).is_file()
    reconstruction_audit_raw = json.loads(reconstruction_audit.read_text())
    subassembly_raw = json.loads(subassembly_report.read_text())
    assert reconstruction_audit_raw["verdict"] == "pass"
    assert reconstruction_audit_raw["step_exported_count"] == step_raw["exported_count"]
    assert reconstruction_audit_raw["base_reconstructed_assets"] == base_reconstruction_raw["reconstructed_count"]
    assert reconstruction_audit_raw["official_base_step_source_available"] is False
    assert reconstruction_audit_raw["primitive_shell_count"] == 0
    assert reconstruction_audit_raw["primitive_shell_parts"] == []
    assert "left_rear_hip_fairing" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_rear_hip_fairing" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_rear_glute_armor_skin" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_rear_glute_armor_skin" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_wrist_separated_cuff" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_wrist_separated_cuff" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_shin_side_armor" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_shin_side_armor" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_chest_contour_armor" not in reconstruction_audit_raw["primitive_shell_parts"]
    assert "left_foot_top_shell" not in reconstruction_audit_raw["primitive_shell_parts"]
    assert "torso_chest_shell" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_chest_contour_armor" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_foot_top_shell" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_forearm_outer_blade" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_forearm_outer_blade" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_shin_front_armor" in reconstruction_audit_raw["morph_ready_parts"]
    assert "right_shin_front_armor" in reconstruction_audit_raw["morph_ready_parts"]
    assert "left_shin_front_armor" not in reconstruction_audit_raw["primitive_shell_parts"]
    assert "right_shin_front_armor" not in reconstruction_audit_raw["primitive_shell_parts"]
    assert "rear_back_spine_plate" in reconstruction_audit_raw["morph_ready_parts"]
    assert "rear_back_spine_plate" not in reconstruction_audit_raw["primitive_shell_parts"]
    assert subassembly_raw["source_body_subassemblies"]["neck_carrier"]["mounted_robot_bodies"] == [
        "torso_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["neck_carrier"]["total_solid_volume_cm3"] > 0
    assert subassembly_raw["source_body_subassemblies"]["face_plate_details"]["mounted_robot_bodies"] == [
        "torso_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["face_plate_details"]["total_solid_volume_cm3"] > 0
    assert (
        subassembly_raw["reference_only_subassemblies"]["hair_reference_alignment"]["total_solid_volume_cm3"]
        == 0.0
    )
    assert subassembly_raw["reference_only_subassemblies"]["hair_reference_alignment"]["generated_geometry"] is False
    assert subassembly_raw["reference_only_subassemblies"]["hair_reference_alignment"]["params_no_hair"] is True
    for part_name in [
        "abdomen_center_armor",
        "pelvis_center_plate",
        "pelvis_lower_nose_plate",
        "chest_upper_bridge_armor",
        "chest_lower_bridge_armor",
        "rear_seat_bridge_armor",
        "left_upper_arm_outer_blade",
        "right_upper_arm_outer_blade",
        "left_upper_arm_front_armor",
        "right_upper_arm_front_armor",
    ]:
        assert part_name in reconstruction_audit_raw["morph_ready_parts"]
        assert part_name not in reconstruction_audit_raw["primitive_shell_parts"]
    assert any(
        row["part"] == "face_shell" and row["reconstruction_status"] == "morph-ready-section-loft"
        for row in reconstruction_audit_raw["parts"]
    )
    assert manifest_raw["subassembly_volume_report"]["verdict"] == subassembly_raw["verdict"]
    assert subassembly_raw["verdict"] == "pass"
    assert subassembly_raw["total_solid_volume_cm3"] > 0
    assert len(subassembly_raw["source_body_subassemblies"]) >= 10
    assert {
        "feet_ankles_worker",
        "legs_knees_shins_worker",
        "hips_pelvis_torso_worker",
        "arms_shoulders_wrists_worker",
        "neck_head_face_worker",
    }.issubset(subassembly_raw["worker_work_packages"])
    for assembly_name in [
        "left_forearm",
        "right_forearm",
        "left_wrist_cuff",
        "right_wrist_cuff",
        "left_foot_ankle",
        "right_foot_ankle",
        "left_knee_shin",
        "right_knee_shin",
        "torso_front_chest",
        "front_pelvis",
        "rear_pelvis_bridge",
        "left_rear_hip_fairing",
        "right_rear_hip_fairing",
        "left_glute_backside",
        "right_glute_backside",
        "face_plate_details",
    ]:
        assembly = subassembly_raw["source_body_subassemblies"][assembly_name]
        assert assembly["part_count"] > 0
        assert assembly["total_solid_volume_cm3"] > 0
        assert assembly["mounted_robot_bodies"]
        assert assembly["source_robot_anchors"]
        assert assembly["world_bbox_home_pose"]["extents_mm"]
        assert assembly["worker_package"]
        assert assembly["fit_review"]["minimum_non_mounted_clearance_mm"] is not None
        assert assembly["panel_gap_review"]["verdict"] == "pass"
        assert "blocker_count" in assembly["mechanical_stress_review"]
        assert all(part["step_solid_exported"] for part in assembly["parts"])
        assert all(part["source_robot_connected"] for part in assembly["parts"])
        assert assembly["source_subassembly_anchor"]["anchor_connected"] is True
    assert subassembly_raw["source_body_subassemblies"]["left_foot_ankle"]["mounted_robot_bodies"] == [
        "left_ankle_roll_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["right_foot_ankle"]["mounted_robot_bodies"] == [
        "right_ankle_roll_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["left_wrist_cuff"]["mounted_robot_bodies"] == [
        "left_elbow_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["left_wrist_cuff"]["source_subassembly_anchor"][
        "keepout_bodies"
    ] == ["left_wrist_roll_link"]
    assert subassembly_raw["source_body_subassemblies"]["right_wrist_cuff"]["source_subassembly_anchor"][
        "keepout_oem_meshes"
    ] == ["right_wrist_roll_link.STL"]
    assert (
        subassembly_raw["reference_only_subassemblies"]["left_hand_keepout"]["connection_review"]
        == "reference-only-source-keepout"
    )
    assert subassembly_raw["reference_only_subassemblies"]["left_hand_keepout"]["source_subassembly_anchor"][
        "keepout_bodies"
    ] == ["left_wrist_roll_link"]
    assert subassembly_raw["reference_only_subassemblies"]["right_hand_keepout"]["generated_geometry"] is False
    left_foot_ankle = subassembly_raw["source_body_subassemblies"]["left_foot_ankle"]
    right_foot_ankle = subassembly_raw["source_body_subassemblies"]["right_foot_ankle"]
    for foot_ankle in [left_foot_ankle, right_foot_ankle]:
        assert foot_ankle["configured_source_subassembly"] is True
        assert foot_ankle["source_subassembly_anchor"]["anchor_connected"] is True
        assert foot_ankle["source_robot_anchors"]
        assert {"dorsal_boot_upper", "toe_cap", "outsole_band", "rear_heel_block"}.issubset(
            set(foot_ankle["source_robot_anchors"][0]["anchor_roles"])
        )
        assert all(part["source_robot_anchor"]["source_body"] == part["body"] for part in foot_ankle["parts"])
    foot_volume_ratio = (
        max(left_foot_ankle["total_solid_volume_cm3"], right_foot_ankle["total_solid_volume_cm3"])
        / min(left_foot_ankle["total_solid_volume_cm3"], right_foot_ankle["total_solid_volume_cm3"])
    )
    assert foot_volume_ratio < 2.0
    assert subassembly_raw["source_body_subassemblies"]["right_knee_shin"]["mounted_robot_bodies"] == [
        "right_knee_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["left_hip_upper_leg"]["mounted_robot_bodies"] == [
        "left_hip_yaw_link"
    ]
    assert subassembly_raw["source_body_subassemblies"]["right_hip_upper_leg"]["mounted_robot_bodies"] == [
        "right_hip_yaw_link"
    ]
    assert "left_shin_side_armor" in {
        part["name"] for part in subassembly_raw["source_body_subassemblies"]["left_knee_shin"]["parts"]
    }
    assert "left_rear_hip_fairing" not in {
        part["name"] for part in subassembly_raw["source_body_subassemblies"]["left_hip_upper_leg"]["parts"]
    }
    assert {
        "waist_abdomen",
        "front_pelvis",
        "rear_pelvis_bridge",
        "left_rear_hip_fairing",
        "right_rear_hip_fairing",
        "left_glute_backside",
        "right_glute_backside",
        "left_hip_upper_leg",
        "right_hip_upper_leg",
    }.issubset(set(subassembly_raw["configured_source_subassemblies"]))
    for assembly_name in [
        "waist_abdomen",
        "front_pelvis",
        "rear_pelvis_bridge",
        "left_rear_hip_fairing",
        "right_rear_hip_fairing",
        "left_glute_backside",
        "right_glute_backside",
        "left_hip_upper_leg",
        "right_hip_upper_leg",
    ]:
        assembly = subassembly_raw["source_body_subassemblies"][assembly_name]
        assert assembly["configured_source_subassembly"] is True
        assert assembly["connection_review"] == "source-anchor-connected-parametric-subassembly"
        assert assembly["source_subassembly_anchor"]["anchor_connected"] is True
        assert all(part["source_subassembly"] == assembly_name for part in assembly["parts"])
    assert subassembly_raw["source_body_subassemblies"]["front_pelvis"]["mounted_robot_bodies"] == ["pelvis"]
    assert subassembly_raw["source_body_subassemblies"]["rear_pelvis_bridge"]["mounted_robot_bodies"] == ["pelvis"]
    assert subassembly_raw["source_body_subassemblies"]["left_glute_backside"]["mounted_robot_bodies"] == ["pelvis"]
    assert subassembly_raw["source_body_subassemblies"]["right_glute_backside"]["mounted_robot_bodies"] == ["pelvis"]
    assert "right_rear_hip_fairing" not in {
        part["name"] for part in subassembly_raw["source_body_subassemblies"]["right_hip_upper_leg"]["parts"]
    }

    forbidden = ("Make" + "Human", "make" + "human", "M" + "PFB", "m" + "pfb")
    checked_suffixes = {".py", ".yaml", ".yml", ".md", ".json", ".csv", ".obj", ".mtl"}
    for root in [BODYKIT_ROOT, PKG_ROOT / "scripts"]:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in checked_suffixes:
                if path.name == "test_unitree_r1_bodykit.py":
                    continue
                text = path.read_text(errors="ignore")
                assert not any(term in text for term in forbidden), path


def test_tapered_box_primitive_exports_mesh_and_step() -> None:
    sys.path.insert(0, str(PKG_ROOT / "scripts"))
    import generate_unitree_r1_bodykit as generator

    spec = {
        "name": "test_tapered_boot_plate",
        "shape": "tapered_box",
        "scale": [0.10, 0.04, 0.02],
        "top_scale": [0.055, 0.025],
        "center": [0.01, 0.0, -0.03],
        "rotation_euler_deg": [0, -6, 0],
    }
    mesh = generator._part_mesh(spec, [1.0, 0.3, 0.0, 1.0])
    assert len(mesh.vertices) == 8
    assert len(mesh.faces) == 12
    assert pytest.approx(mesh.extents[0], rel=0.2) == 0.20

    cadquery = pytest.importorskip("cadquery")
    solid = generator._cq_shape_from_spec(cadquery, spec)
    assert solid.Volume() > 0


def test_axis_x_section_loft_exports_mesh_and_step() -> None:
    sys.path.insert(0, str(PKG_ROOT / "scripts"))
    import generate_unitree_r1_bodykit as generator

    spec = {
        "name": "test_x_axis_foot_loft",
        "shape": "section_loft",
        "center": [0.047, -0.016, -0.050],
        "axis": "x",
        "sections": [
            {"x": -0.096, "scale": [0.012, 0.0035]},
            {"x": -0.030, "scale": [0.018, 0.0060]},
            {"x": 0.040, "scale": [0.020, 0.0070]},
            {"x": 0.096, "scale": [0.011, 0.0035]},
        ],
    }
    mesh = generator._part_mesh(spec, [1.0, 0.3, 0.0, 1.0])
    assert mesh.extents[0] > mesh.extents[1]
    assert mesh.extents[0] > mesh.extents[2]
    assert mesh.extents[0] > 0.18

    cadquery = pytest.importorskip("cadquery")
    solid = generator._cq_shape_from_spec(cadquery, spec)
    assert solid.Volume() > 0


def test_donor_face_grid_loft_exports_mesh_and_step() -> None:
    sys.path.insert(0, str(PKG_ROOT / "scripts"))
    import generate_unitree_r1_bodykit as generator

    spec = {
        "name": "test_donor_face_surface",
        "shape": "donor_face_grid_loft",
        "mesh_source": "cad/source-assets/human-donor/eliza_face_donor.stl",
        "units": "m",
        "scale": [0.206, 0.96, 0.82],
        "center": [-0.056, 0.0, 0.077],
        "sections_count": 9,
        "samples_per_side": 9,
        "shell_depth_mm": 2.4,
        "face_depth_min_mm": 12.0,
        "front_fit_quantile": 0.985,
        "y_shrink": -0.055,
        "feature_gain": 0.22,
        "nose_gain": 0.24,
        "lip_gain": 0.12,
        "cheek_gain": 0.06,
        "brow_gain": 0.04,
    }
    mesh = generator._part_mesh(spec, [0.98, 0.78, 0.68, 1.0])
    assert len(mesh.vertices) > 100
    assert mesh.extents[0] * 1000.0 >= 12.0

    cadquery = pytest.importorskip("cadquery")
    solid = generator._cq_shape_from_spec(cadquery, spec)
    assert solid.Volume() > 0


def test_stl_reference_mesh_reconstructs_as_parametric_section_loft() -> None:
    sys.path.insert(0, str(PKG_ROOT / "scripts"))
    import generate_unitree_r1_bodykit as generator

    asset = PKG_ROOT / "assets" / "profiles" / "unitree-r1" / "mjcf" / "assets" / "torso_collision.stl"
    spec = generator._mesh_section_loft_spec(asset, sections_count=7)
    assert spec["source_kind"] == "stl_mesh_reference"
    assert spec["reconstruction_kind"] == "parametric_mesh_section_loft"
    assert spec["sections_count"] == 7
    assert spec["axis"] in {"x", "y", "z"}
    assert all(len(section["center"]) == 2 for section in spec["sections"])
    assert all(len(section["radius"]) == 2 for section in spec["sections"])
    assert all(min(section["radius"]) > 0 for section in spec["sections"])

    cadquery = pytest.importorskip("cadquery")
    solid = generator._cq_solid_from_mesh_section_loft(cadquery, spec)
    assert solid.Volume() > 0
