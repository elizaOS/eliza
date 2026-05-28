"""Fembot collision and dynamics validation scaffold."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.collision_sweep import build_asimov1_collision_sweep_proof
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_controller_validation import (
    build_fembot_controller_validation_proof,
)
from eliza_robot.asimov_1.fembot_foot_handling import build_fembot_foot_handling_proof
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_inertia_calibration import (
    build_fembot_inertia_calibration_proof,
)
from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof
from eliza_robot.asimov_1.mujoco_load_proof import build_mujoco_load_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_COLLISION_DYNAMICS_SCHEMA = "asimov-fembot-collision-dynamics-proof-v1"
FEMBOT_CONTACT_TUNING_PROOF = ASIMOV_PARAM_PROOFS / "fembot-contact-tuning.json"
FEMBOT_JOINT_SWEEP_VISUAL_EVIDENCE = (
    Path(__file__).resolve().parents[2]
    / "evidence"
    / "asimov_1_joint_sweep_contact_clean"
    / "asimov1_constrained_joint_sweep.json"
)


def _collision_geom_to_link(geom: str) -> str | None:
    if not geom or geom == "floor":
        return None
    for marker in ("_seg", "_fit", "_visual", "_proxy", "_physical"):
        if marker in geom:
            geom = geom.split(marker, 1)[0]
    if geom == "pelvis_collision":
        return "IMU_ORIGIN"
    link_collision_suffix = "_link_collision"
    if geom.endswith(link_collision_suffix):
        return geom[: -len(link_collision_suffix)].upper()
    suffix = "_collision"
    if geom.endswith(suffix):
        return geom[: -len(suffix)].upper()
    return None


def _contact_pair_summary(
    collision: dict[str, Any],
    *,
    body_groups: list[dict[str, Any]],
    structural_report: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    group_by_link = {
        str(link).upper(): str(group.get("group"))
        for group in body_groups
        for link in group.get("links", [])
    }
    structural_growth_by_link = {
        str(record.get("link", "")).upper(): float(record.get("max_minor_axis_increase_m") or 0.0)
        for record in (structural_report or {}).get("structural_remediation_thinness_impact", [])
    }
    pair_records: dict[tuple[str, str], dict[str, Any]] = {}
    for sample in collision.get("samples", []):
        sample_label = str(sample.get("label"))
        for contact in sample.get("unapproved_contacts", []):
            geoms = tuple(sorted([str(contact.get("geom1")), str(contact.get("geom2"))]))
            record = pair_records.setdefault(
                geoms,
                {
                    "geom_pair": list(geoms),
                    "contact_count": 0,
                    "sample_labels": [],
                    "minimum_distance_m": None,
                },
            )
            record["contact_count"] += 1
            if sample_label not in record["sample_labels"]:
                record["sample_labels"].append(sample_label)
            distance = contact.get("distance_m")
            if distance is not None:
                current = record["minimum_distance_m"]
                record["minimum_distance_m"] = (
                    float(distance)
                    if current is None
                    else min(float(current), float(distance))
                )

    records = []
    for record in pair_records.values():
        links = [_collision_geom_to_link(geom) for geom in record["geom_pair"]]
        groups = [
            group_by_link.get(link, "unknown")
            for link in links
            if link is not None
        ]
        structural_links = [
            link for link in links if link is not None and link in structural_growth_by_link
        ]
        growth_allowance = sum(
            structural_growth_by_link[link] * 0.5
            for link in structural_links
        )
        minimum_distance = record["minimum_distance_m"]
        estimated_distance = (
            float(minimum_distance) - growth_allowance
            if minimum_distance is not None
            else None
        )
        records.append(
            {
                **record,
                "links": links,
                "body_groups": groups,
                "sample_count": len(record["sample_labels"]),
                "structural_remediation_links": structural_links,
                "structural_remediation_growth_allowance_m": growth_allowance,
                "estimated_minimum_distance_after_structural_growth_m": estimated_distance,
                "structural_remediation_contact_risk": bool(structural_links),
            }
        )
    records.sort(
        key=lambda record: (
            float(record["minimum_distance_m"])
            if record["minimum_distance_m"] is not None
            else 0.0,
            record["geom_pair"],
        )
    )
    return records


def _load_contact_tuning_proof(
    path: Path = FEMBOT_CONTACT_TUNING_PROOF,
) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _load_joint_sweep_visual_evidence(
    path: Path = FEMBOT_JOINT_SWEEP_VISUAL_EVIDENCE,
) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _joint_sweep_visual_compact_summary(report: dict[str, Any] | None) -> dict[str, Any]:
    if not report:
        return {
            "schema": None,
            "ok": False,
            "accepted": False,
            "video": None,
            "contact_sheet": None,
            "limited_hinge_joints": 0,
            "samples": 0,
            "screenshot_count": 0,
            "frame_count": 0,
            "video_recorded": False,
            "screenshots_recorded": False,
            "standing_height_gate": False,
            "unapproved_contact_samples": None,
            "max_unapproved_contacts": None,
            "contact_clean": False,
            "hip_roll_inward_limit_rad": None,
            "hip_roll_limited_joint_count": 0,
            "contact_clean_dense_range_applied": False,
            "contact_clean_dense_range_changed_joints": 0,
            "manual_visual_review_required": True,
        }
    summary = report.get("summary", {})
    unapproved_samples = summary.get("unapproved_contact_samples")
    return {
        "schema": report.get("schema"),
        "ok": bool(report.get("ok")),
        "accepted": bool(report.get("accepted")),
        "video": report.get("video"),
        "contact_sheet": report.get("contact_sheet"),
        "limited_hinge_joints": int(summary.get("limited_hinge_joints") or 0),
        "samples": int(summary.get("samples") or 0),
        "screenshot_count": int(report.get("screenshot_count") or 0),
        "frame_count": int(report.get("frame_count") or 0),
        "video_recorded": bool(summary.get("video_recorded")),
        "screenshots_recorded": bool(summary.get("screenshots_recorded")),
        "standing_height_gate": bool(summary.get("standing_height_gate")),
        "unapproved_contact_samples": unapproved_samples,
        "max_unapproved_contacts": summary.get("max_unapproved_contacts"),
        "contact_clean": unapproved_samples == 0,
        "hip_roll_inward_limit_rad": summary.get("hip_roll_inward_limit_rad"),
        "hip_roll_limited_joint_count": int(
            summary.get("hip_roll_limited_joint_count") or 0
        ),
        "contact_clean_dense_range_applied": bool(
            summary.get("contact_clean_dense_range_applied")
        ),
        "contact_clean_dense_range_changed_joints": int(
            summary.get("contact_clean_dense_range_changed_joints") or 0
        ),
        "manual_visual_review_required": bool(summary.get("visual_review_required", True)),
    }


def _as_int(value: Any) -> int:
    return int(value or 0)


def _contact_tuning_compact_summary(report: dict[str, Any] | None) -> dict[str, Any]:
    if not report:
        return {
            "schema": None,
            "ok": False,
            "accepted": False,
            "best_strategy": None,
            "contact_clean_scale_count": 0,
            "contact_clean_and_visual_fit_scale_count": 0,
            "physical_visual_remediation_contact_clean_count": 0,
            "physical_visual_remediation_visual_fit_clean_count": 0,
            "physical_visual_remediation_geom_count": 0,
            "visual_fit_remediation_geom_count": 0,
            "hip_roll_limit_contact_clean_count": 0,
            "first_hip_roll_limit_contact_clean_rad": None,
            "hip_roll_limit_best_unapproved_contact_count": None,
            "hip_roll_limit_best_contact_pair_count": None,
            "physical_visual_remediation_best_worst_mean_outside_margin_m": None,
            "physical_visual_remediation_best_worst_outside_fraction": None,
            "clears_sampled_self_contacts_and_visual_fit": False,
            "clears_sampled_cross_leg_contacts_with_motion_limit": False,
        }

    summary = report.get("summary", {})
    contact_visual_clean = _as_int(summary.get("contact_clean_and_visual_fit_scale_count"))
    physical_visual_clean = _as_int(
        summary.get("physical_visual_remediation_visual_fit_clean_count")
    )
    return {
        "schema": report.get("schema"),
        "ok": bool(report.get("ok")),
        "accepted": bool(report.get("accepted")),
        "best_strategy": summary.get("best_strategy"),
        "contact_clean_scale_count": _as_int(summary.get("contact_clean_scale_count")),
        "contact_clean_and_visual_fit_scale_count": contact_visual_clean,
        "physical_visual_remediation_contact_clean_count": _as_int(
            summary.get("physical_visual_remediation_contact_clean_count")
        ),
        "physical_visual_remediation_visual_fit_clean_count": physical_visual_clean,
        "physical_visual_remediation_geom_count": _as_int(
            summary.get("physical_visual_remediation_geom_count")
        ),
        "visual_fit_remediation_geom_count": _as_int(
            summary.get("visual_fit_remediation_geom_count")
        ),
        "hip_roll_limit_contact_clean_count": _as_int(
            summary.get("hip_roll_limit_contact_clean_count")
        ),
        "first_hip_roll_limit_contact_clean_rad": summary.get(
            "first_hip_roll_limit_contact_clean_rad"
        ),
        "hip_roll_limit_best_unapproved_contact_count": summary.get(
            "hip_roll_limit_best_unapproved_contact_count"
        ),
        "hip_roll_limit_best_contact_pair_count": summary.get(
            "hip_roll_limit_best_contact_pair_count"
        ),
        "physical_visual_remediation_best_worst_mean_outside_margin_m": summary.get(
            "physical_visual_remediation_best_worst_mean_outside_margin_m"
        ),
        "physical_visual_remediation_best_worst_outside_fraction": summary.get(
            "physical_visual_remediation_best_worst_outside_fraction"
        ),
        "clears_sampled_self_contacts_and_visual_fit": bool(
            contact_visual_clean or physical_visual_clean
        ),
        "clears_sampled_cross_leg_contacts_with_motion_limit": bool(
            _as_int(summary.get("hip_roll_limit_contact_clean_count")) > 0
        ),
    }


def build_fembot_collision_dynamics_proof(
    body_groups: list[dict[str, Any]],
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    generated_cad_report: dict[str, Any] | None = None,
    fembot_mjcf_report: dict[str, Any] | None = None,
    collision_sweep_report: dict[str, Any] | None = None,
    mujoco_report: dict[str, Any] | None = None,
    structural_report: dict[str, Any] | None = None,
    contact_tuning_report: dict[str, Any] | None = None,
    joint_sweep_visual_report: dict[str, Any] | None = None,
    foot_handling_report: dict[str, Any] | None = None,
    inertia_calibration_report: dict[str, Any] | None = None,
    controller_validation_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    structural = structural_report or build_fembot_structural_sanity_proof(
        body_groups,
        generated_cad_report=generated,
    )
    fembot_mjcf = fembot_mjcf_report or generate_fembot_mjcf()
    proof_mjcf_path = Path(fembot_mjcf.get("output", {}).get("mjcf", mjcf_path))
    collision = collision_sweep_report or build_asimov1_collision_sweep_proof(
        mjcf_path=proof_mjcf_path
    )
    mujoco = mujoco_report or build_mujoco_load_proof(mjcf_path=proof_mjcf_path)
    contact_tuning = contact_tuning_report or _load_contact_tuning_proof()
    contact_tuning_compact = _contact_tuning_compact_summary(contact_tuning)
    joint_sweep_visual = (
        joint_sweep_visual_report
        if joint_sweep_visual_report is not None
        else _load_joint_sweep_visual_evidence()
    )
    joint_sweep_visual_compact = _joint_sweep_visual_compact_summary(joint_sweep_visual)
    foot_handling = foot_handling_report or build_fembot_foot_handling_proof(
        body_groups,
        source_mjcf=mjcf_path,
        fembot_mjcf_report=fembot_mjcf,
        collision_sweep_report=collision,
        generated_cad_report=generated,
    )
    inertia_calibration = (
        inertia_calibration_report
        or build_fembot_inertia_calibration_proof(
            body_groups,
            source_mjcf=mjcf_path,
            fembot_mjcf_report=fembot_mjcf,
            generated_cad_report=generated,
        )
    )
    controller_validation = (
        controller_validation_report
        or build_fembot_controller_validation_proof(
            body_groups,
            source_mjcf=mjcf_path,
            fembot_mjcf_report=fembot_mjcf,
        )
    )
    generated_links = {record["link"] for record in generated.get("link_steps", [])}
    requested_links = {str(link).upper() for group in body_groups for link in group.get("links", [])}
    missing_generated_links = sorted(requested_links - generated_links)
    neutral_sample = next(
        (sample for sample in collision.get("samples", []) if sample.get("label") == "neutral"),
        None,
    )
    contact_pairs = _contact_pair_summary(
        collision,
        body_groups=body_groups,
        structural_report=structural,
    )
    worst_contact_pair = contact_pairs[0] if contact_pairs else None
    structural_remediation_links = {
        str(record.get("link", "")).upper()
        for record in structural.get("structural_remediation_thinness_impact", [])
    }
    structural_contact_risk_pairs = [
        pair for pair in contact_pairs if pair["structural_remediation_contact_risk"]
    ]
    structural_contact_risk_links = sorted(
        {
            link
            for pair in structural_contact_risk_pairs
            for link in pair["structural_remediation_links"]
        }
    )
    structural_contact_estimated_distances = [
        float(pair["estimated_minimum_distance_after_structural_growth_m"])
        for pair in structural_contact_risk_pairs
        if pair.get("estimated_minimum_distance_after_structural_growth_m") is not None
    ]
    group_records = []
    for group in body_groups:
        links = [str(link).upper() for link in group.get("links", [])]
        group_records.append(
            {
                "group": group.get("group"),
                "links": links,
                "generated_link_count": sum(1 for link in links if link in generated_links),
                "collision_samples": collision.get("summary", {}).get("samples", 0),
                "accepted": False,
            }
        )
    ok = bool(
        generated.get("ok")
        and collision.get("ok")
        and mujoco.get("ok")
        and len(generated_links) == len(requested_links) == 28
    )
    promoted_contact_clean = bool(
        fembot_mjcf.get("summary", {}).get("contact_tuned_colliders_promoted")
        and collision.get("summary", {}).get("unapproved_contact_count", 0) == 0
        and collision.get("summary", {}).get("unapproved_contact_samples", 0) == 0
    )
    return {
        "schema": FEMBOT_COLLISION_DYNAMICS_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mjcf": str(mjcf_path),
            "fembot_mjcf": str(proof_mjcf_path),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "fembot_collision_schema": collision.get("schema"),
            "mujoco_schema": mujoco.get("schema"),
            "contact_tuning_schema": contact_tuning_compact["schema"],
            "joint_sweep_visual_schema": joint_sweep_visual_compact["schema"],
            "foot_handling_schema": foot_handling.get("schema"),
            "inertia_calibration_schema": inertia_calibration.get("schema"),
            "controller_validation_schema": controller_validation.get("schema"),
        },
        "summary": {
            "generated_links": len(generated_links),
            "missing_generated_links": missing_generated_links,
            "fembot_collision_samples": collision.get("summary", {}).get("samples", 0),
            "fembot_unapproved_contact_samples": collision.get("summary", {}).get(
                "unapproved_contact_samples",
                0,
            ),
            "fembot_unapproved_contact_count": collision.get("summary", {}).get(
                "unapproved_contact_count",
                0,
            ),
            "fembot_contact_pair_count": len(contact_pairs),
            "fembot_minimum_unapproved_distance_m": collision.get("summary", {}).get(
                "minimum_unapproved_distance_m",
            ),
            "fembot_worst_sample": collision.get("summary", {}).get("worst_sample"),
            "fembot_worst_contact_pair": (
                worst_contact_pair.get("geom_pair") if worst_contact_pair else None
            ),
            "structural_remediation_contact_risk_pairs": len(structural_contact_risk_pairs),
            "structural_remediation_contact_risk_links": len(structural_contact_risk_links),
            "structural_remediation_contact_risk_link_names": structural_contact_risk_links,
            "structural_remediation_no_current_contact_links": sorted(
                structural_remediation_links - set(structural_contact_risk_links)
            ),
            "structural_remediation_contact_worsened_pairs": sum(
                1
                for pair in structural_contact_risk_pairs
                if float(pair["structural_remediation_growth_allowance_m"]) > 0.0
            ),
            "structural_remediation_worst_estimated_distance_after_growth_m": min(
                structural_contact_estimated_distances,
                default=None,
            ),
            "baseline_collision_samples": collision.get("summary", {}).get("samples", 0),
            "baseline_unapproved_contact_samples": collision.get("summary", {}).get(
                "unapproved_contact_samples",
                0,
            ),
            "baseline_unapproved_contact_count": collision.get("summary", {}).get(
                "unapproved_contact_count",
                0,
            ),
            "baseline_worst_sample": collision.get("summary", {}).get("worst_sample"),
            "neutral_sample_accepted": bool(neutral_sample and neutral_sample.get("accepted")),
            "mujoco_dynamic_step_ok": bool(mujoco.get("summary", {}).get("mujoco_step_ok")),
            "fembot_mjcf_ok": bool(fembot_mjcf.get("ok")),
            "fembot_geometry_substituted_in_mjcf": bool(fembot_mjcf.get("ok")),
            "fembot_hip_spacing_ratio": fembot_mjcf.get("summary", {}).get("hip_spacing_ratio"),
            "fembot_mass_inertia_ok": bool(fembot_mjcf.get("summary", {}).get("mass_inertia_ok")),
            "fembot_total_mass_kg": fembot_mjcf.get("mass_inertia", {}).get("total_mass_kg"),
            "fembot_actuator_lag_ok": bool(fembot_mjcf.get("summary", {}).get("actuator_lag_ok")),
            "fembot_actuators_tracked": fembot_mjcf.get("actuator_lag", {}).get("actuators_tracked"),
            "fembot_actuator_lag_duration_s": fembot_mjcf.get("actuator_lag", {}).get("duration_s"),
            "fembot_contact_tuned_colliders_promoted": bool(
                fembot_mjcf.get("summary", {}).get("contact_tuned_colliders_promoted")
            ),
            "fembot_contact_tuned_collider_strategy": fembot_mjcf.get("summary", {}).get(
                "contact_tuned_collider_strategy"
            ),
            "fembot_contact_tuned_collider_scaled_geom_count": fembot_mjcf.get(
                "summary", {}
            ).get("contact_tuned_collider_scaled_geom_count"),
            "fembot_contact_tuned_collider_fit_geom_count": fembot_mjcf.get(
                "summary", {}
            ).get("contact_tuned_collider_fit_geom_count"),
            "fembot_contact_tuned_collider_physical_visual_remediation_geom_count": (
                fembot_mjcf.get("summary", {}).get(
                    "contact_tuned_collider_physical_visual_remediation_geom_count"
                )
            ),
            "fembot_promoted_contact_tuned_collider_contact_clean": promoted_contact_clean,
            "foot_handling_ok": bool(foot_handling.get("ok")),
            "foot_handling_accepted": bool(foot_handling.get("accepted")),
            "foot_collision_geoms_preserved": bool(
                foot_handling.get("summary", {}).get("foot_collision_geoms_preserved")
            ),
            "foot_floor_contact_count": foot_handling.get("summary", {}).get(
                "floor_contact_count"
            ),
            "foot_neutral_floor_contact_count": foot_handling.get("summary", {}).get(
                "neutral_floor_contact_count"
            ),
            "foot_non_foot_floor_contact_count": foot_handling.get("summary", {}).get(
                "non_foot_floor_contact_count"
            ),
            "foot_flat_plate_count": foot_handling.get("summary", {}).get(
                "flat_foot_plate_count"
            ),
            "foot_manufacturing_adjusted_plate_count": foot_handling.get("summary", {}).get(
                "manufacturing_adjusted_foot_plate_count"
            ),
            "foot_flatness_ok_count": foot_handling.get("summary", {}).get(
                "foot_flatness_ok_count"
            ),
            "inertia_calibration_ok": bool(inertia_calibration.get("ok")),
            "inertia_calibration_accepted": bool(inertia_calibration.get("accepted")),
            "inertia_calibration_ready": bool(
                inertia_calibration.get("summary", {}).get("calibration_ready")
            ),
            "inertia_hardware_measured_links": inertia_calibration.get("summary", {}).get(
                "hardware_measured_links"
            ),
            "inertia_missing_hardware_links": len(
                inertia_calibration.get("summary", {}).get("missing_hardware_links", [])
            ),
            "inertia_cad_mass_estimate_kg": inertia_calibration.get("summary", {}).get(
                "cad_mass_estimate_kg"
            ),
            "inertia_compiled_total_mass_kg": inertia_calibration.get("summary", {}).get(
                "compiled_total_mass_kg"
            ),
            "inertia_max_abs_mass_relative_delta_vs_cad": inertia_calibration.get(
                "summary", {}
            ).get("max_abs_mass_relative_delta_vs_cad"),
            "inertia_max_abs_inertia_relative_delta_vs_cad": inertia_calibration.get(
                "summary", {}
            ).get("max_abs_inertia_relative_delta_vs_cad"),
            "inertia_mass_out_of_tolerance_count": inertia_calibration.get(
                "summary", {}
            ).get("mass_out_of_tolerance_count"),
            "inertia_inertia_out_of_tolerance_count": inertia_calibration.get(
                "summary", {}
            ).get("inertia_out_of_tolerance_count"),
            "inertia_total_required_added_mass_to_match_compiled_kg": (
                inertia_calibration.get("summary", {}).get(
                    "total_required_added_mass_to_match_compiled_kg"
                )
            ),
            "inertia_max_required_added_mass_to_match_compiled_kg": (
                inertia_calibration.get("summary", {}).get(
                    "max_required_added_mass_to_match_compiled_kg"
                )
            ),
            "inertia_max_mass_scale_to_compiled": inertia_calibration.get(
                "summary", {}
            ).get("max_mass_scale_to_compiled"),
            "inertia_max_inertia_scale_to_compiled": inertia_calibration.get(
                "summary", {}
            ).get("max_inertia_scale_to_compiled"),
            "controller_validation_ok": bool(controller_validation.get("ok")),
            "controller_validation_accepted": bool(
                controller_validation.get("accepted")
            ),
            "controller_simulation_validated": bool(
                controller_validation.get("summary", {}).get(
                    "mujoco_controller_rollout_ok"
                )
            ),
            "controller_motor_response_profile_ok": bool(
                controller_validation.get("summary", {}).get(
                    "motor_response_profile_ok"
                )
            ),
            "controller_hardware_validated": bool(
                controller_validation.get("summary", {}).get(
                    "hardware_controller_validated"
                )
            ),
            "controller_actuator_order_ok": bool(
                controller_validation.get("summary", {}).get("actuator_order_ok")
            ),
            "controller_actuators_commanded": controller_validation.get(
                "summary", {}
            ).get("actuators_commanded"),
            "controller_trajectory_final_max_abs_error_rad": (
                controller_validation.get("summary", {}).get(
                    "trajectory_final_max_abs_error_rad"
                )
            ),
            "controller_trajectory_final_median_abs_error_rad": (
                controller_validation.get("summary", {}).get(
                    "trajectory_final_median_abs_error_rad"
                )
            ),
            "controller_trajectory_early_median_response_fraction": (
                controller_validation.get("summary", {}).get(
                    "trajectory_early_median_response_fraction"
                )
            ),
            "controller_trajectory_settled_median_response_fraction": (
                controller_validation.get("summary", {}).get(
                    "trajectory_settled_median_response_fraction"
                )
            ),
            "controller_trajectory_response_overshoot_count": (
                controller_validation.get("summary", {}).get(
                    "trajectory_response_overshoot_count"
                )
            ),
            "controller_trajectory_min_final_response_fraction": (
                controller_validation.get("summary", {}).get(
                    "trajectory_min_final_response_fraction"
                )
            ),
            "controller_trajectory_max_final_response_fraction": (
                controller_validation.get("summary", {}).get(
                    "trajectory_max_final_response_fraction"
                )
            ),
            "contact_tuning_ok": contact_tuning_compact["ok"],
            "contact_tuning_accepted": contact_tuning_compact["accepted"],
            "contact_tuning_best_strategy": contact_tuning_compact["best_strategy"],
            "contact_tuning_contact_clean_scale_count": contact_tuning_compact[
                "contact_clean_scale_count"
            ],
            "contact_tuning_contact_clean_and_visual_fit_scale_count": contact_tuning_compact[
                "contact_clean_and_visual_fit_scale_count"
            ],
            "contact_tuning_physical_visual_remediation_contact_clean_count": (
                contact_tuning_compact["physical_visual_remediation_contact_clean_count"]
            ),
            "contact_tuning_physical_visual_remediation_visual_fit_clean_count": (
                contact_tuning_compact["physical_visual_remediation_visual_fit_clean_count"]
            ),
            "contact_tuning_physical_visual_remediation_geom_count": contact_tuning_compact[
                "physical_visual_remediation_geom_count"
            ],
            "contact_tuning_visual_fit_remediation_geom_count": contact_tuning_compact[
                "visual_fit_remediation_geom_count"
            ],
            "contact_tuning_hip_roll_limit_contact_clean_count": contact_tuning_compact[
                "hip_roll_limit_contact_clean_count"
            ],
            "contact_tuning_first_hip_roll_limit_contact_clean_rad": (
                contact_tuning_compact["first_hip_roll_limit_contact_clean_rad"]
            ),
            "contact_tuning_hip_roll_limit_best_unapproved_contact_count": (
                contact_tuning_compact["hip_roll_limit_best_unapproved_contact_count"]
            ),
            "contact_tuning_hip_roll_limit_best_contact_pair_count": (
                contact_tuning_compact["hip_roll_limit_best_contact_pair_count"]
            ),
            "contact_tuning_physical_visual_remediation_best_worst_mean_outside_margin_m": (
                contact_tuning_compact[
                    "physical_visual_remediation_best_worst_mean_outside_margin_m"
                ]
            ),
            "contact_tuning_physical_visual_remediation_best_worst_outside_fraction": (
                contact_tuning_compact[
                    "physical_visual_remediation_best_worst_outside_fraction"
                ]
            ),
            "contact_tuning_clears_sampled_self_contacts_and_visual_fit": (
                contact_tuning_compact["clears_sampled_self_contacts_and_visual_fit"]
            ),
            "contact_tuning_clears_sampled_cross_leg_contacts_with_motion_limit": (
                contact_tuning_compact[
                    "clears_sampled_cross_leg_contacts_with_motion_limit"
                ]
            ),
            "joint_sweep_visual_ok": joint_sweep_visual_compact["ok"],
            "joint_sweep_visual_video_recorded": joint_sweep_visual_compact[
                "video_recorded"
            ],
            "joint_sweep_visual_screenshots_recorded": joint_sweep_visual_compact[
                "screenshots_recorded"
            ],
            "joint_sweep_visual_standing_height_gate": joint_sweep_visual_compact[
                "standing_height_gate"
            ],
            "joint_sweep_visual_contact_clean": joint_sweep_visual_compact[
                "contact_clean"
            ],
            "joint_sweep_visual_unapproved_contact_samples": (
                joint_sweep_visual_compact["unapproved_contact_samples"]
            ),
            "joint_sweep_visual_max_unapproved_contacts": joint_sweep_visual_compact[
                "max_unapproved_contacts"
            ],
            "joint_sweep_visual_limited_hinge_joints": joint_sweep_visual_compact[
                "limited_hinge_joints"
            ],
            "joint_sweep_visual_frame_count": joint_sweep_visual_compact["frame_count"],
            "joint_sweep_visual_screenshot_count": joint_sweep_visual_compact[
                "screenshot_count"
            ],
            "joint_sweep_visual_hip_roll_inward_limit_rad": (
                joint_sweep_visual_compact["hip_roll_inward_limit_rad"]
            ),
            "joint_sweep_visual_hip_roll_limited_joint_count": (
                joint_sweep_visual_compact["hip_roll_limited_joint_count"]
            ),
            "joint_sweep_visual_contact_clean_dense_range_applied": (
                joint_sweep_visual_compact["contact_clean_dense_range_applied"]
            ),
            "joint_sweep_visual_contact_clean_dense_range_changed_joints": (
                joint_sweep_visual_compact[
                    "contact_clean_dense_range_changed_joints"
                ]
            ),
            "accepted": False,
            "acceptance_blocker": (
                "generated fembot geometry is substituted into a MuJoCo MJCF and "
                "dynamic stepping, compiled mass/inertia, and actuator lag response "
                "are measured; the promoted tuned physical collider clears sampled "
                "generated-MJCF self-contacts and the visual-fit gate, foot handling "
                "preserves floor contacts and flat toe plates, CAD-vs-MJCF "
                "inertia records are mapped, and a diagnostic inward hip-roll "
                "limit clears sampled cross-leg envelope contacts, but production "
                "acceptance still needs hardware mass/inertia measurements and "
                "hardware motor-controller telemetry"
                if (
                    promoted_contact_clean
                    and foot_handling.get("accepted")
                    and inertia_calibration.get("ok")
                    and controller_validation.get("ok")
                )
                else "generated fembot geometry is substituted into a MuJoCo MJCF and "
                "dynamic stepping, compiled mass/inertia, and actuator lag response "
                "are measured; the promoted tuned physical collider clears sampled "
                "generated-MJCF self-contacts and the visual-fit gate, foot handling "
                "preserves floor contacts and flat toe plates, CAD-vs-MJCF "
                "inertia records are mapped, and a diagnostic inward hip-roll "
                "limit clears sampled cross-leg envelope contacts, but production "
                "acceptance still needs hardware mass/inertia measurements and "
                "motor-controller validation"
                if (
                    promoted_contact_clean
                    and foot_handling.get("accepted")
                    and inertia_calibration.get("ok")
                )
                else "generated fembot geometry is substituted into a MuJoCo MJCF and "
                "dynamic stepping, compiled mass/inertia, and actuator lag response "
                "are measured; the promoted tuned physical collider clears sampled "
                "generated-MJCF self-contacts and the visual-fit gate, but production "
                "acceptance still needs foot handling, hardware-identified inertia "
                "calibration, and motor-controller validation"
                if promoted_contact_clean
                else "generated fembot geometry is substituted into a MuJoCo MJCF and "
                "dynamic stepping, compiled mass/inertia, and actuator lag response "
                "are measured; generated-MJCF contact pairs are identified and a "
                "tuned physical collider clears sampled self-contacts plus the visual-fit "
                "gate, but production acceptance still needs tuned-collider promotion "
                "into MJCF, foot handling, hardware-identified inertia calibration, "
                "and motor-controller validation"
                if contact_tuning_compact["clears_sampled_self_contacts_and_visual_fit"]
                else "generated fembot geometry is substituted into a MuJoCo MJCF and "
                "dynamic stepping, compiled mass/inertia, and actuator lag response "
                "are measured; generated-MJCF contact pairs are identified, but "
                "production acceptance still needs contact tuning, foot handling, "
                "hardware-identified inertia calibration, and motor-controller validation"
            ),
        },
        "contact_tuning": contact_tuning_compact,
        "joint_sweep_visual": joint_sweep_visual_compact,
        "foot_handling": foot_handling,
        "inertia_calibration": inertia_calibration,
        "controller_validation": controller_validation,
        "contact_pairs": contact_pairs,
        "body_groups": group_records,
    }


def dump_fembot_collision_dynamics_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_collision_dynamics_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-collision-dynamics.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_collision_dynamics_proof_json(report), encoding="utf-8")
    return output
