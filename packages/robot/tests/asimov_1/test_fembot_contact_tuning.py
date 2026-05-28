from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_contact_tuning import build_fembot_contact_tuning_proof
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_contact_tuning_sweeps_body_capsule_scales() -> None:
    report = build_fembot_contact_tuning_proof(
        _body_groups(),
        scale_candidates=(1.0, 0.8, 0.6, 0.4),
        length_scale_candidates=(1.0, 0.8, 0.6, 0.5),
        structural_target_length_scale_candidates=(0.8, 0.6, 0.5, 0.4),
        reconstruction_target_length_scale_candidates=(0.8, 0.6, 0.5, 0.4),
    )

    assert report["schema"] == "asimov-fembot-contact-tuning-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["scales_tested"] == 4
    assert report["summary"]["length_scales_tested"] == 4
    assert report["summary"]["structural_target_length_scales_tested"] == 4
    assert report["summary"]["reconstruction_target_length_scales_tested"] == 4
    assert report["summary"]["segment_candidates_tested"] == 3
    assert report["summary"]["link_specific_fit_candidates_tested"] == 1
    assert report["summary"]["physical_visual_remediation_candidates_tested"] == 1
    assert report["summary"]["strategies_tested"] == 10
    assert report["summary"]["baseline_unapproved_contact_count"] == 11
    assert report["summary"]["baseline_unapproved_contact_samples"] == 7
    assert report["summary"]["baseline_structural_remediation_contact_risk_pairs"] == 5
    assert report["summary"]["baseline_structural_remediation_contact_risk_links"] == 4
    assert report["summary"]["contact_clean_candidate_found"] is True
    assert report["summary"]["contact_clean_scale_count"] == 6
    assert report["summary"]["radius_contact_clean_scale_count"] == 1
    assert report["summary"]["length_contact_clean_scale_count"] == 1
    assert report["summary"]["structural_target_length_contact_clean_scale_count"] == 0
    assert report["summary"]["reconstruction_target_length_contact_clean_scale_count"] == 2
    assert report["summary"]["link_specific_fit_contact_clean_count"] == 1
    assert report["summary"]["physical_visual_remediation_contact_clean_count"] == 1
    assert report["summary"]["physical_visual_remediation_visual_fit_clean_count"] == 1
    assert report["summary"]["physical_visual_remediation_geom_count"] == 5
    assert report["summary"]["physical_visual_remediation_best_worst_mean_outside_margin_m"] < 0.033
    assert report["summary"]["physical_visual_remediation_best_worst_outside_fraction"] < 0.82
    assert report["summary"]["structural_target_length_structural_risk_clean_scale_count"] == 2
    assert report["summary"]["segmented_contact_clean_scale_count"] == 0
    assert report["summary"]["first_contact_clean_scale"] == 0.4
    assert report["summary"]["first_contact_clean_length_scale"] == 0.5
    assert report["summary"]["first_structural_target_length_contact_clean_scale"] is None
    assert report["summary"]["first_structural_target_length_structural_risk_clean_scale"] == 0.5
    assert report["summary"]["first_reconstruction_target_length_contact_clean_scale"] == 0.5
    assert report["summary"]["first_link_specific_fit_contact_clean_length_scale"] == 0.5
    assert report["summary"]["first_contact_clean_segment"] is None
    assert report["summary"]["best_strategy"] == "physical_visual_remediation"
    assert report["summary"]["best_scale"] is None
    assert report["summary"]["best_length_scale"] == 0.5
    assert report["summary"]["best_unapproved_contact_count"] == 0
    assert report["summary"]["best_unapproved_contact_samples"] == 0
    assert report["summary"]["link_specific_collider_reconstruction_pairs"] == 5
    assert report["summary"]["link_specific_collider_reconstruction_links"] == 8
    assert report["summary"]["link_specific_collider_reconstruction_structural_pairs"] == 0
    assert report["summary"]["structural_remediation_contact_risk_scale_count"] == 13
    assert report["summary"]["structural_remediation_contact_clean_scale_count"] == 8
    assert report["summary"]["structural_remediation_contact_clean_and_contact_clean_count"] == 6
    assert report["summary"]["link_specific_fit_best_unapproved_contact_count"] == 0
    assert report["summary"]["link_specific_fit_best_contact_pair_count"] == 0
    assert report["summary"]["visual_fit_remediation_geom_count"] == 0
    assert report["summary"]["visual_fit_remediation_link_count"] == 0
    assert report["summary"]["visual_fit_remediation_worst_link"] is None
    assert report["summary"]["visual_fit_remediation_worst_geom"] is None
    assert report["summary"]["visual_envelope_proxy_candidates_tested"] == 1
    assert report["summary"]["visual_envelope_proxy_contact_clean_count"] == 1
    assert report["summary"]["visual_envelope_proxy_visual_fit_clean_count"] == 1
    assert report["summary"]["visual_envelope_proxy_geom_count"] == 9
    assert report["summary"]["visual_envelope_proxy_contact_enabled"] is False
    assert report["summary"]["visual_envelope_proxy_best_worst_mean_outside_margin_m"] < 0.032
    assert report["summary"]["visual_envelope_proxy_best_worst_outside_fraction"] < 0.82
    assert report["summary"]["floor_contact_proxy_candidates_tested"] == 1
    assert report["summary"]["floor_contact_proxy_contact_clean_count"] == 1
    assert report["summary"]["floor_contact_proxy_visual_fit_clean_count"] == 1
    assert report["summary"]["floor_contact_proxy_geom_count"] == 9
    assert report["summary"]["floor_contact_proxy_contact_enabled"] is True
    assert report["summary"]["floor_contact_proxy_floor_contact_enabled"] is True
    assert report["summary"]["floor_contact_proxy_self_contact_enabled"] is False
    assert report["summary"]["floor_contact_proxy_best_worst_mean_outside_margin_m"] < 0.032
    assert report["summary"]["floor_contact_proxy_best_worst_outside_fraction"] < 0.82
    assert report["summary"]["physical_envelope_candidates_tested"] == 1
    assert report["summary"]["physical_envelope_contact_clean_count"] == 0
    assert report["summary"]["physical_envelope_visual_fit_clean_count"] == 1
    assert report["summary"]["physical_envelope_geom_count"] == 9
    assert report["summary"]["physical_envelope_contact_enabled"] is True
    assert report["summary"]["physical_envelope_floor_contact_enabled"] is True
    assert report["summary"]["physical_envelope_self_contact_enabled"] is True
    assert report["summary"]["physical_envelope_best_unapproved_contact_count"] == 992
    assert report["summary"]["physical_envelope_best_contact_pair_count"] == 28
    assert report["summary"]["physical_envelope_best_worst_mean_outside_margin_m"] < 0.032
    assert report["summary"]["physical_envelope_best_worst_outside_fraction"] < 0.82
    assert report["summary"]["physical_envelope_exclusion_candidates_tested"] == 1
    assert report["summary"]["physical_envelope_exclusion_contact_clean_count"] == 0
    assert report["summary"]["physical_envelope_exclusion_visual_fit_clean_count"] == 1
    assert report["summary"]["physical_envelope_exclusion_contact_exclusion_count"] == 2
    assert report["summary"]["physical_envelope_exclusion_best_unapproved_contact_count"] == 16
    assert report["summary"]["physical_envelope_exclusion_best_contact_pair_count"] == 14
    assert (
        report["summary"]["physical_envelope_exclusion_best_worst_mean_outside_margin_m"]
        < 0.032
    )
    assert report["summary"]["physical_envelope_exclusion_best_worst_outside_fraction"] < 0.82
    assert report["summary"]["hip_roll_limit_candidates_tested"] == 3
    assert report["summary"]["hip_roll_limit_contact_clean_count"] == 2
    assert report["summary"]["hip_roll_limit_visual_fit_clean_count"] == 3
    assert report["summary"]["first_hip_roll_limit_contact_clean_rad"] == 0.25
    assert report["summary"]["hip_roll_limit_best_unapproved_contact_count"] == 0
    assert report["summary"]["hip_roll_limit_best_contact_pair_count"] == 0
    assert report["summary"]["best_structural_remediation_contact_clean_strategy"] == "physical_visual_remediation"
    assert report["summary"]["best_structural_remediation_contact_clean_scale"] is None
    assert report["summary"]["best_structural_remediation_contact_clean_length_scale"] == 0.5
    assert (
        report["summary"][
            "best_structural_remediation_contact_clean_visual_fit_worst_mean_outside_margin_m"
        ]
        < 0.04
    )
    assert report["summary"]["best_contact_clean_strategy"] == "physical_visual_remediation"
    assert report["summary"]["best_contact_clean_length_scale"] == 0.5
    assert report["summary"]["visual_fit_scale_count"] == 1
    assert report["summary"]["contact_clean_and_visual_fit_scale_count"] == 1
    plan = report["link_specific_collider_reconstruction_plan"]
    assert len(plan) == 5
    assert plan[0]["geom_pair"] == [
        "neck_pitch_link_collision",
        "waist_yaw_link_collision",
    ]
    assert plan[0]["links"] == ["NECK_PITCH", "WAIST_YAW"]
    assert plan[0]["involves_structural_remediation_link"] is False
    assert all(record["accepted"] is False for record in plan)

    by_scale = {record["scale"]: record for record in report["scale_sweeps"]}
    by_length = {record["length_scale"]: record for record in report["length_scale_sweeps"]}
    by_target_length = {
        record["length_scale"]: record
        for record in report["structural_target_length_scale_sweeps"]
    }
    by_reconstruction_length = {
        record["length_scale"]: record
        for record in report["reconstruction_target_length_scale_sweeps"]
    }
    by_link_specific_fit = {
        record["length_scale"]: record
        for record in report["link_specific_residual_fit_sweeps"]
    }
    by_physical_visual = {
        record["length_scale"]: record
        for record in report["physical_visual_remediation_sweeps"]
    }
    by_segment = {
        (record["segment_count"], record["segment_length_scale"]): record
        for record in report["segment_sweeps"]
    }
    assert set(by_scale) == {1.0, 0.8, 0.6, 0.4}
    assert set(by_length) == {1.0, 0.8, 0.6, 0.5}
    assert set(by_target_length) == {0.8, 0.6, 0.5, 0.4}
    assert set(by_reconstruction_length) == {0.8, 0.6, 0.5, 0.4}
    assert set(by_link_specific_fit) == {0.5}
    assert set(by_physical_visual) == {0.5}
    assert set(by_segment) == {(2, 0.4), (2, 0.5), (3, 0.4)}
    assert by_scale[1.0]["summary"]["contact_pair_count"] == 10
    assert by_scale[1.0]["summary"]["structural_remediation_contact_risk_pairs"] == 5
    assert by_scale[0.8]["summary"]["structural_remediation_contact_risk_pairs"] == 3
    assert by_scale[0.6]["summary"]["structural_remediation_contact_risk_pairs"] == 2
    assert by_scale[0.4]["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert by_scale[0.4]["accepted"] is True
    assert by_scale[0.4]["summary"]["unapproved_contact_count"] == 0
    assert by_length[0.5]["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert by_length[0.5]["accepted"] is True
    assert by_length[0.5]["summary"]["unapproved_contact_count"] == 0
    assert by_target_length[0.8]["summary"]["structural_remediation_contact_risk_pairs"] == 5
    assert by_target_length[0.6]["summary"]["structural_remediation_contact_risk_pairs"] == 2
    assert by_target_length[0.5]["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert by_target_length[0.5]["summary"]["unapproved_contact_count"] == 5
    assert by_target_length[0.5]["accepted"] is False
    assert by_target_length[0.5]["target_links"] == [
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "LEFT_SHOULDER_YAW",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
        "RIGHT_SHOULDER_YAW",
    ]
    assert by_target_length[0.5]["scaled_model"]["scaled_geom_count"] == 4
    assert by_reconstruction_length[0.8]["summary"]["unapproved_contact_count"] == 6
    assert by_reconstruction_length[0.6]["summary"]["unapproved_contact_count"] == 2
    assert by_reconstruction_length[0.5]["accepted"] is True
    assert by_reconstruction_length[0.5]["summary"]["unapproved_contact_count"] == 0
    assert by_reconstruction_length[0.5]["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert by_reconstruction_length[0.5]["scaled_model"]["scaled_geom_count"] == 12
    assert by_reconstruction_length[0.5]["target_links"] == [
        "LEFT_ELBOW",
        "LEFT_HIP_PITCH",
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "LEFT_SHOULDER_ROLL",
        "LEFT_SHOULDER_YAW",
        "NECK_PITCH",
        "RIGHT_ELBOW",
        "RIGHT_HIP_PITCH",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
        "RIGHT_SHOULDER_ROLL",
        "RIGHT_SHOULDER_YAW",
        "WAIST_YAW",
    ]
    assert by_link_specific_fit[0.5]["accepted"] is True
    assert by_link_specific_fit[0.5]["summary"]["unapproved_contact_count"] == 0
    assert by_link_specific_fit[0.5]["summary"]["contact_pair_count"] == 0
    assert by_link_specific_fit[0.5]["summary"]["structural_remediation_contact_risk_pairs"] == 0
    assert by_link_specific_fit[0.5]["summary"]["visual_fit_accepted"] is False
    assert by_link_specific_fit[0.5]["scaled_model"]["scaled_geom_count"] == 14
    assert by_link_specific_fit[0.5]["scaled_model"]["fit_geom_count"] == 10
    assert by_physical_visual[0.5]["accepted"] is True
    assert by_physical_visual[0.5]["summary"]["unapproved_contact_count"] == 0
    assert by_physical_visual[0.5]["summary"]["contact_pair_count"] == 0
    assert by_physical_visual[0.5]["summary"]["visual_fit_accepted"] is True
    assert by_physical_visual[0.5]["summary"]["visual_fit_worst_mean_outside_margin_m"] < (
        by_link_specific_fit[0.5]["summary"]["visual_fit_worst_mean_outside_margin_m"]
    )
    assert by_physical_visual[0.5]["summary"]["visual_fit_worst_outside_fraction"] < (
        by_link_specific_fit[0.5]["summary"]["visual_fit_worst_outside_fraction"]
    )
    assert by_physical_visual[0.5]["scaled_model"]["scaled_geom_count"] == 19
    assert by_physical_visual[0.5]["scaled_model"]["fit_geom_count"] == 15
    assert by_physical_visual[0.5]["scaled_model"]["remediation_geom_count"] == 5
    assert by_physical_visual[0.5]["scaled_model"]["contact_enabled"] is True
    proxy = report["visual_envelope_proxy_sweeps"][0]
    assert proxy["accepted"] is True
    assert proxy["production_accepted"] is False
    assert proxy["summary"]["unapproved_contact_count"] == 0
    assert proxy["summary"]["visual_fit_accepted"] is True
    assert proxy["scaled_model"]["scaled_geom_count"] == 23
    assert proxy["scaled_model"]["fit_geom_count"] == 19
    assert proxy["scaled_model"]["proxy_geom_count"] == 9
    assert proxy["scaled_model"]["contact_enabled"] is False
    assert "not physical colliders" in proxy["acceptance_blocker"]
    floor_proxy = report["visual_envelope_floor_contact_proxy_sweeps"][0]
    assert floor_proxy["accepted"] is True
    assert floor_proxy["production_accepted"] is False
    assert floor_proxy["summary"]["unapproved_contact_count"] == 0
    assert floor_proxy["summary"]["visual_fit_accepted"] is True
    assert floor_proxy["scaled_model"]["scaled_geom_count"] == 23
    assert floor_proxy["scaled_model"]["fit_geom_count"] == 19
    assert floor_proxy["scaled_model"]["proxy_geom_count"] == 9
    assert floor_proxy["scaled_model"]["contact_enabled"] is True
    assert floor_proxy["scaled_model"]["floor_contact_enabled"] is True
    assert floor_proxy["scaled_model"]["self_contact_enabled"] is False
    assert "not a production self-collider" in floor_proxy["acceptance_blocker"]
    physical_envelope = report["physical_visual_envelope_sweeps"][0]
    assert physical_envelope["accepted"] is False
    assert physical_envelope["production_accepted"] is False
    assert physical_envelope["summary"]["unapproved_contact_count"] == 992
    assert physical_envelope["summary"]["contact_pair_count"] == 28
    assert physical_envelope["summary"]["visual_fit_accepted"] is True
    assert physical_envelope["summary"]["worst_contact_pair"] == [
        "left_knee_link_collision_physical_xneg",
        "right_knee_link_collision_physical_xneg",
    ]
    assert physical_envelope["scaled_model"]["physical_envelope_geom_count"] == 9
    assert physical_envelope["scaled_model"]["contact_enabled"] is True
    assert physical_envelope["scaled_model"]["floor_contact_enabled"] is True
    assert physical_envelope["scaled_model"]["self_contact_enabled"] is True
    assert physical_envelope["contact_pairs"][0]["links"] == ["LEFT_KNEE", "RIGHT_KNEE"]
    assert "real self-colliders" in physical_envelope["acceptance_blocker"]
    physical_envelope_exclusions = report["physical_visual_envelope_exclusion_sweeps"][0]
    assert physical_envelope_exclusions["accepted"] is False
    assert physical_envelope_exclusions["production_accepted"] is False
    assert physical_envelope_exclusions["summary"]["unapproved_contact_count"] == 16
    assert physical_envelope_exclusions["summary"]["unapproved_contact_samples"] == 2
    assert physical_envelope_exclusions["summary"]["contact_pair_count"] == 14
    assert physical_envelope_exclusions["summary"]["visual_fit_accepted"] is True
    assert physical_envelope_exclusions["summary"]["worst_contact_pair"] == [
        "left_knee_link_collision_physical_xneg",
        "right_knee_link_collision_physical_xneg",
    ]
    assert physical_envelope_exclusions["scaled_model"]["physical_envelope_geom_count"] == 9
    assert physical_envelope_exclusions["scaled_model"]["contact_exclusion_count"] == 2
    assert physical_envelope_exclusions["scaled_model"]["self_contact_enabled"] is True
    assert physical_envelope_exclusions["contact_pairs"][0]["links"] == [
        "LEFT_KNEE",
        "RIGHT_KNEE",
    ]
    assert "same-limb knee-to-ankle-roll" in physical_envelope_exclusions[
        "acceptance_blocker"
    ]
    by_hip_roll_limit = {
        record["scaled_model"]["hip_roll_inward_limit_rad"]: record
        for record in report["physical_visual_envelope_hip_roll_limit_sweeps"]
    }
    assert set(by_hip_roll_limit) == {0.3, 0.25, 0.2}
    assert by_hip_roll_limit[0.3]["accepted"] is False
    assert by_hip_roll_limit[0.3]["summary"]["unapproved_contact_count"] == 12
    assert by_hip_roll_limit[0.3]["summary"]["contact_pair_count"] == 10
    assert by_hip_roll_limit[0.25]["accepted"] is True
    assert by_hip_roll_limit[0.25]["production_accepted"] is False
    assert by_hip_roll_limit[0.25]["summary"]["unapproved_contact_count"] == 0
    assert by_hip_roll_limit[0.25]["summary"]["contact_pair_count"] == 0
    assert by_hip_roll_limit[0.25]["scaled_model"]["limited_joint_count"] == 2
    assert "controller/range constraint" in by_hip_roll_limit[0.25]["acceptance_blocker"]
    assert by_segment[(2, 0.4)]["accepted"] is False
    assert by_segment[(2, 0.4)]["summary"]["unapproved_contact_count"] == 4
    assert by_segment[(2, 0.4)]["summary"]["structural_remediation_contact_risk_pairs"] == 3
    assert by_segment[(3, 0.4)]["summary"]["visual_fit_worst_mean_outside_margin_m"] < (
        by_length[0.5]["summary"]["visual_fit_worst_mean_outside_margin_m"]
    )
    reconstruction_pairs = {
        tuple(record["geom_pair"]): record
        for record in report["link_specific_collider_reconstruction_plan"]
    }
    assert set(reconstruction_pairs) == {
        ("neck_pitch_link_collision", "waist_yaw_link_collision"),
        ("right_elbow_link_collision", "right_hip_pitch_link_collision"),
        ("left_elbow_link_collision", "left_hip_pitch_link_collision"),
        ("left_elbow_link_collision", "left_shoulder_roll_link_collision"),
        ("right_elbow_link_collision", "right_shoulder_roll_link_collision"),
    }
    assert reconstruction_pairs[
        ("neck_pitch_link_collision", "waist_yaw_link_collision")
    ]["links"] == ["NECK_PITCH", "WAIST_YAW"]
    assert all(
        not record["involves_structural_remediation_link"]
        for record in report["link_specific_collider_reconstruction_plan"]
    )
    assert all(
        "link-specific multi-capsule" in record["recommended_reconstruction"]
        for record in report["link_specific_collider_reconstruction_plan"]
    )
    visual_fit_plan = {
        record["link"]: record
        for record in report["visual_fit_remediation_plan"]
    }
    assert visual_fit_plan == {}
    assert all(record["accepted"] is False for record in report["visual_fit_remediation_plan"])
    assert all(
        "visual-envelope collider coverage" in record["recommended_reconstruction"]
        for record in report["visual_fit_remediation_plan"]
    )
    assert by_scale[1.0]["summary"]["visual_fit_accepted"] is False
    assert by_scale[0.4]["summary"]["visual_fit_accepted"] is False
    assert by_length[0.5]["summary"]["visual_fit_accepted"] is False
    assert (
        by_scale[0.4]["summary"]["visual_fit_worst_mean_outside_margin_m"]
        > by_scale[1.0]["summary"]["visual_fit_worst_mean_outside_margin_m"]
    )
    assert (
        by_length[0.5]["summary"]["visual_fit_worst_mean_outside_margin_m"]
        < by_scale[0.4]["summary"]["visual_fit_worst_mean_outside_margin_m"]
    )
    for record in [
        *report["scale_sweeps"],
        *report["length_scale_sweeps"],
        *report["structural_target_length_scale_sweeps"],
        *report["reconstruction_target_length_scale_sweeps"],
        *report["link_specific_residual_fit_sweeps"],
        *report["physical_visual_remediation_sweeps"],
        *report["physical_visual_envelope_sweeps"],
        *report["physical_visual_envelope_exclusion_sweeps"],
        *report["physical_visual_envelope_hip_roll_limit_sweeps"],
        *report["segment_sweeps"],
    ]:
        assert record["ok"] is True
        assert record["scaled_model"]["scaled_geom_count"] > 0
        assert record["summary"]["samples"] >= 80
        assert record["summary"]["unapproved_contact_count"] >= 0
        assert record["summary"]["structural_remediation_contact_risk_pairs"] >= 0
        assert record["contact_pairs"] or record["accepted"] is True
        assert record["visual_fit"]["schema"] == "asimov-fembot-collider-visual-fit-v1"
        assert record["visual_fit"]["summary"]["geom_count"] > 0
        assert record["visual_fit"]["summary"]["missing_visual_geom_count"] == 0


def test_fembot_contact_tuning_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-contact-tuning.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_contact_tuning_proof.py",
            "--output",
            str(output),
            "--scales",
            "1.0,0.8,0.4",
            "--length-scales",
            "1.0,0.8,0.5",
            "--structural-target-length-scales",
            "0.8,0.5",
            "--reconstruction-target-length-scales",
            "0.8,0.5",
            "--segments",
            "2:0.4",
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-contact-tuning-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert report["summary"]["contact_clean_candidate_found"] is True
    assert report["summary"]["best_contact_clean_strategy"] == "physical_visual_remediation"
    assert report["summary"]["baseline_structural_remediation_contact_risk_pairs"] == 5
    assert report["summary"]["structural_remediation_contact_clean_and_contact_clean_count"] >= 1
    assert report["summary"]["structural_target_length_structural_risk_clean_scale_count"] == 1
    assert report["summary"]["reconstruction_target_length_contact_clean_scale_count"] == 1
    assert report["summary"]["link_specific_fit_contact_clean_count"] == 1
    assert report["summary"]["physical_visual_remediation_contact_clean_count"] == 1
    assert report["summary"]["physical_visual_remediation_visual_fit_clean_count"] == 1
    assert report["summary"]["link_specific_fit_best_contact_pair_count"] == 0
    assert report["summary"]["visual_fit_remediation_geom_count"] == 0
    assert report["summary"]["visual_envelope_proxy_visual_fit_clean_count"] == 1
    assert report["summary"]["visual_envelope_proxy_contact_enabled"] is False
    assert report["summary"]["floor_contact_proxy_visual_fit_clean_count"] == 1
    assert report["summary"]["floor_contact_proxy_floor_contact_enabled"] is True
    assert report["summary"]["floor_contact_proxy_self_contact_enabled"] is False
    assert report["summary"]["physical_envelope_visual_fit_clean_count"] == 1
    assert report["summary"]["physical_envelope_contact_clean_count"] == 0
    assert report["summary"]["physical_envelope_self_contact_enabled"] is True
    assert report["physical_visual_envelope_sweeps"][0]["production_accepted"] is False
    assert report["summary"]["physical_envelope_exclusion_visual_fit_clean_count"] == 1
    assert report["summary"]["physical_envelope_exclusion_contact_clean_count"] == 0
    assert report["summary"]["physical_envelope_exclusion_contact_exclusion_count"] == 2
    assert report["physical_visual_envelope_exclusion_sweeps"][0][
        "production_accepted"
    ] is False
    assert report["summary"]["hip_roll_limit_candidates_tested"] == 3
    assert report["summary"]["hip_roll_limit_contact_clean_count"] == 2
    assert report["summary"]["first_hip_roll_limit_contact_clean_rad"] == 0.25
    assert report["physical_visual_envelope_hip_roll_limit_sweeps"][1][
        "production_accepted"
    ] is False
    assert report["summary"]["link_specific_collider_reconstruction_pairs"] == 5
    assert report["summary"]["segment_candidates_tested"] == 1
    assert report["summary"]["contact_clean_and_visual_fit_scale_count"] == 1
    assert '"scales_tested": 3' in proc.stdout
    assert '"length_scales_tested": 3' in proc.stdout
    assert '"structural_target_length_scales_tested": 2' in proc.stdout
    assert '"reconstruction_target_length_scales_tested": 2' in proc.stdout
    assert '"link_specific_fit_candidates_tested": 1' in proc.stdout
    assert '"physical_visual_remediation_contact_clean_count": 1' in proc.stdout
    assert '"physical_visual_remediation_visual_fit_clean_count": 1' in proc.stdout
    assert '"visual_fit_remediation_geom_count": 0' in proc.stdout
    assert '"visual_envelope_proxy_visual_fit_clean_count": 1' in proc.stdout
    assert '"floor_contact_proxy_visual_fit_clean_count": 1' in proc.stdout
    assert '"physical_envelope_visual_fit_clean_count": 1' in proc.stdout
    assert '"physical_envelope_contact_clean_count": 0' in proc.stdout
    assert '"physical_envelope_exclusion_visual_fit_clean_count": 1' in proc.stdout
    assert '"physical_envelope_exclusion_contact_clean_count": 0' in proc.stdout
    assert '"hip_roll_limit_contact_clean_count": 2' in proc.stdout
    assert '"first_hip_roll_limit_contact_clean_rad": 0.25' in proc.stdout
    assert '"segment_candidates_tested": 1' in proc.stdout
    assert '"link_specific_collider_reconstruction_pairs": 5' in proc.stdout
