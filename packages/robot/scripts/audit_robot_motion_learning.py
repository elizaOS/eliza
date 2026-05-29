#!/usr/bin/env python3
"""Skeptical audit: prove whether robot evidence shows learning and motion."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from eliza_robot.profiles import load_profile
from scripts.eval_text_policy import curriculum_report_from_eval
from scripts.review_robot_video_evidence import review_videos
from scripts.validate_alberta_benchmark_artifacts import (
    validate_alberta_benchmark_artifacts,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TASK_FEASIBILITY_PATH = (
    ROOT / "evidence" / "task_feasibility" / "hiwonder_ainex_current.json"
)


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _false_checks(report: dict[str, Any]) -> list[str]:
    checks = report.get("checks")
    if not isinstance(checks, dict):
        return []
    return [name for name, ok in checks.items() if ok is not True]


def _failed_video_rows(video_review: dict[str, Any]) -> list[dict[str, Any]]:
    videos = video_review.get("videos") if isinstance(video_review.get("videos"), list) else []
    rows = []
    for item in videos:
        if not isinstance(item, dict) or item.get("ok") is True:
            continue
        telemetry = item.get("telemetry") if isinstance(item.get("telemetry"), dict) else {}
        rows.append(
            {
                "profile": item.get("profile"),
                "action": item.get("action"),
                "failed_checks": item.get("failed_checks"),
                "telemetry_ok": telemetry.get("ok"),
                "action_progress_ok": telemetry.get("action_progress_ok"),
                "delta_x_m": telemetry.get("delta_x_m"),
                "delta_yaw_rad": telemetry.get("delta_yaw_rad"),
            }
        )
    return rows


def _task_feasibility_summary(report: dict[str, Any]) -> dict[str, Any]:
    tasks = report.get("tasks") if isinstance(report.get("tasks"), list) else []
    if not tasks:
        return {
            "ok": False,
            "all_success": False,
            "n_tasks": 0,
            "n_success": 0,
            "failed_tasks": [],
        }
    failed_tasks = []
    best_candidates = []
    for row in tasks:
        if not isinstance(row, dict):
            continue
        candidates = row.get("candidate_results")
        if not isinstance(candidates, list):
            candidates = []
        sorted_candidates = sorted(
            (candidate for candidate in candidates if isinstance(candidate, dict)),
            key=lambda candidate: float(candidate.get("candidate_score") or 0.0),
            reverse=True,
        )
        best = sorted_candidates[0] if sorted_candidates else {}
        most_forward = max(
            sorted_candidates,
            key=lambda candidate: float(candidate.get("final_delta_x_m") or 0.0),
            default={},
        )
        most_forward_summary = {
            "task_id": row.get("task_id"),
            "controller": most_forward.get("controller") or row.get("controller"),
            "success": most_forward.get("success"),
            "failed": most_forward.get("failed"),
            "termination_reason": most_forward.get("termination_reason")
            or row.get("termination_reason"),
            "final_delta_x_m": most_forward.get("final_delta_x_m")
            if most_forward
            else row.get("final_delta_x_m"),
            "final_delta_y_m": most_forward.get("final_delta_y_m")
            if most_forward
            else row.get("final_delta_y_m"),
            "final_delta_yaw_rad": most_forward.get("final_delta_yaw_rad")
            if most_forward
            else row.get("final_delta_yaw_rad"),
            "max_abs_imu_roll_rad": most_forward.get("max_abs_imu_roll_rad")
            if most_forward
            else row.get("max_abs_imu_roll_rad"),
            "max_abs_imu_pitch_rad": most_forward.get("max_abs_imu_pitch_rad")
            if most_forward
            else row.get("max_abs_imu_pitch_rad"),
            "progress_ratio": most_forward.get("progress_ratio")
            if most_forward
            else row.get("progress_ratio"),
            "unmet_success_predicates": most_forward.get("unmet_success_predicates")
            if most_forward
            else row.get("diagnostics", {}).get("unmet_success_predicates"),
        }
        most_progress = max(
            sorted_candidates,
            key=lambda candidate: float(candidate.get("progress_ratio") or 0.0),
            default={},
        )
        most_progress_summary = {
            "task_id": row.get("task_id"),
            "controller": most_progress.get("controller") or row.get("controller"),
            "success": most_progress.get("success"),
            "failed": most_progress.get("failed"),
            "termination_reason": most_progress.get("termination_reason")
            or row.get("termination_reason"),
            "final_delta_x_m": most_progress.get("final_delta_x_m")
            if most_progress
            else row.get("final_delta_x_m"),
            "final_delta_y_m": most_progress.get("final_delta_y_m")
            if most_progress
            else row.get("final_delta_y_m"),
            "final_delta_yaw_rad": most_progress.get("final_delta_yaw_rad")
            if most_progress
            else row.get("final_delta_yaw_rad"),
            "max_abs_imu_roll_rad": most_progress.get("max_abs_imu_roll_rad")
            if most_progress
            else row.get("max_abs_imu_roll_rad"),
            "max_abs_imu_pitch_rad": most_progress.get("max_abs_imu_pitch_rad")
            if most_progress
            else row.get("max_abs_imu_pitch_rad"),
            "progress_ratio": most_progress.get("progress_ratio")
            if most_progress
            else row.get("progress_ratio"),
            "max_success_window_s": most_progress.get("max_success_window_s")
            if most_progress
            else row.get("max_success_window_s"),
            "unmet_success_predicates": most_progress.get("unmet_success_predicates")
            if most_progress
            else row.get("diagnostics", {}).get("unmet_success_predicates"),
        }
        best_candidates.append(
            {
                "task_id": row.get("task_id"),
                "controller": best.get("controller") or row.get("controller"),
                "success": best.get("success"),
                "failed": best.get("failed"),
                "termination_reason": best.get("termination_reason")
                or row.get("termination_reason"),
                "final_delta_x_m": best.get("final_delta_x_m")
                if best
                else row.get("final_delta_x_m"),
                "final_delta_y_m": best.get("final_delta_y_m")
                if best
                else row.get("final_delta_y_m"),
                "final_delta_yaw_rad": best.get("final_delta_yaw_rad")
                if best
                else row.get("final_delta_yaw_rad"),
                "max_abs_imu_roll_rad": best.get("max_abs_imu_roll_rad")
                if best
                else row.get("max_abs_imu_roll_rad"),
                "max_abs_imu_pitch_rad": best.get("max_abs_imu_pitch_rad")
                if best
                else row.get("max_abs_imu_pitch_rad"),
                "progress_ratio": best.get("progress_ratio")
                if best
                else row.get("progress_ratio"),
                "unmet_success_predicates": best.get("unmet_success_predicates")
                if best
                else row.get("diagnostics", {}).get("unmet_success_predicates"),
            }
        )
        if row.get("success") is not True:
            passive = (
                row.get("passive_baseline")
                if isinstance(row.get("passive_baseline"), dict)
                else {}
            )
            failed_tasks.append(
                {
                    "task_id": row.get("task_id"),
                    "controller": row.get("controller"),
                    "termination_reason": row.get("termination_reason"),
                    "final_delta_x_m": row.get("final_delta_x_m"),
                    "final_delta_y_m": row.get("final_delta_y_m"),
                    "final_delta_yaw_rad": row.get("final_delta_yaw_rad"),
                    "max_abs_imu_roll_rad": row.get("max_abs_imu_roll_rad"),
                    "max_abs_imu_pitch_rad": row.get("max_abs_imu_pitch_rad"),
                    "progress_ratio": row.get("progress_ratio"),
                    "unmet_success_predicates": row.get("diagnostics", {}).get(
                        "unmet_success_predicates"
                    ),
                    "best_candidate": best_candidates[-1],
                    "most_forward_candidate": most_forward_summary,
                    "most_progress_candidate": most_progress_summary,
                    "passive_baseline": passive,
                }
            )
    return {
        "ok": bool(report.get("all_success")),
        "all_success": report.get("all_success"),
        "profile_id": report.get("profile_id"),
        "n_tasks": report.get("n_tasks") or len(tasks),
        "n_success": report.get("n_success"),
        "failed_tasks": failed_tasks,
        "best_candidates": best_candidates,
    }


def _multi_profile_walk_summary(report: dict[str, Any]) -> dict[str, Any]:
    summaries = report.get("summaries") if isinstance(report.get("summaries"), list) else []
    rows = [row for row in summaries if isinstance(row, dict)]
    return {
        "ok": bool(report.get("ok")),
        "task_id": report.get("task_id"),
        "max_steps": report.get("max_steps"),
        "n_profiles": report.get("n_profiles") or len(rows),
        "n_valid_walking": report.get("n_valid_walking")
        if report.get("n_valid_walking") is not None
        else sum(1 for row in rows if row.get("valid_walking_evidence") is True),
        "n_passive_success": report.get("n_passive_success")
        if report.get("n_passive_success") is not None
        else sum(1 for row in rows if row.get("passive_success") is True),
        "errors": report.get("errors") if isinstance(report.get("errors"), dict) else {},
        "profiles": rows,
    }


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _local_learning_probe_summary(report: dict[str, Any]) -> dict[str, Any]:
    trained = report.get("trained") if isinstance(report.get("trained"), dict) else {}
    zero = report.get("zero") if isinstance(report.get("zero"), dict) else {}
    manifest_learning = (
        report.get("manifest_learning")
        if isinstance(report.get("manifest_learning"), dict)
        else {}
    )
    trained_failure_rate = _float_or_none(trained.get("failure_rate"))
    zero_failure_rate = _float_or_none(zero.get("failure_rate"))
    trained_steps = _float_or_none(trained.get("mean_steps_survived"))
    zero_steps = _float_or_none(zero.get("mean_steps_survived"))
    trained_yaw = _float_or_none(trained.get("mean_final_delta_yaw_rad"))
    trained_dy = _float_or_none(trained.get("mean_final_delta_y_m"))
    trained_dx = _float_or_none(trained.get("mean_final_delta_x_m"))
    reward_delta = _float_or_none(report.get("reward_delta_trained_minus_zero"))
    forward_delta = _float_or_none(report.get("forward_delta_trained_minus_zero_m"))
    learning_signal_present = bool(report.get("learning_signal_present"))
    walking_success = bool(report.get("walking_success"))
    learned_motion_signal_present = (
        reward_delta is not None
        and reward_delta > 0.0
        and forward_delta is not None
        and forward_delta > 0.02
        and trained_failure_rate is not None
        and trained_failure_rate < 1.0
    )
    falling_lunge = (
        learning_signal_present
        and not walking_success
        and trained_failure_rate is not None
        and trained_failure_rate >= 1.0
        and (zero_failure_rate is None or zero_failure_rate <= 0.0)
        and trained_steps is not None
        and zero_steps is not None
        and trained_steps < zero_steps
        and (
            (trained_yaw is not None and abs(trained_yaw) > 0.40)
            or (trained_dy is not None and abs(trained_dy) > 0.20)
        )
    )
    return {
        "ok": walking_success,
        "learning_signal_present": learning_signal_present,
        "learned_motion_signal_present": learned_motion_signal_present,
        "walking_success": walking_success,
        "reward_delta_trained_minus_zero": reward_delta,
        "forward_delta_trained_minus_zero_m": forward_delta,
        "trained_failure_rate": trained_failure_rate,
        "zero_failure_rate": zero_failure_rate,
        "trained_mean_steps_survived": trained_steps,
        "zero_mean_steps_survived": zero_steps,
        "trained_mean_final_delta_x_m": trained_dx,
        "trained_mean_final_delta_y_m": trained_dy,
        "trained_mean_final_delta_yaw_rad": trained_yaw,
        "promotion_passed": manifest_learning.get("promotion_passed"),
        "promotion_blocker": manifest_learning.get("promotion_blocker"),
        "promotion_reasons": manifest_learning.get("promotion_reasons"),
        "trained_is_falling_lunge": falling_lunge,
        "verdict": report.get("verdict"),
    }


def _local_learning_probe_from_dir(probe_dir: Path) -> dict[str, Any]:
    summary = _load(probe_dir / "learning_probe_summary.json")
    if summary:
        return {
            "source": str(probe_dir / "learning_probe_summary.json"),
            **_local_learning_probe_summary(summary),
        }
    manifest = _load(probe_dir / "checkpoint" / "manifest.json")
    phases = (
        manifest.get("phase_promotion", {}).get("phases")
        if isinstance(manifest.get("phase_promotion"), dict)
        else []
    )
    history = manifest.get("history") if isinstance(manifest.get("history"), list) else []
    history_phase = history[0] if history and isinstance(history[0], dict) else {}
    phase = phases[0] if isinstance(phases, list) and phases else {}
    if not isinstance(phase, dict):
        phase = {}
    profile_id = manifest.get("profile_id")
    expected_tracked_body = None
    if isinstance(profile_id, str) and profile_id:
        try:
            expected_tracked_body = load_profile(profile_id).sensors.locomotion_tracking_body
        except Exception:
            expected_tracked_body = None
    tracked_body_name = phase.get("tracked_body_name")
    stale_tracked_body = (
        expected_tracked_body is not None
        and tracked_body_name is not None
        and tracked_body_name != expected_tracked_body
    )
    learning_return_delta = _float_or_none(phase.get("learning_return_delta"))
    learning_delta_x = _float_or_none(phase.get("learning_delta_x_m"))
    tracked_dx = _float_or_none(phase.get("mean_final_tracked_delta_x_m"))
    trained_yaw = _float_or_none(phase.get("mean_final_delta_yaw_rad"))
    trained_dy = _float_or_none(phase.get("mean_final_delta_y_m"))
    trained_failure_rate = _float_or_none(phase.get("failure_rate"))
    physical_checks = (
        phase.get("physical_checks") if isinstance(phase.get("physical_checks"), dict) else {}
    )
    movement_summary = (
        phase.get("movement_summary")
        if isinstance(phase.get("movement_summary"), dict)
        else {}
    )
    reward_term_summary = (
        phase.get("reward_term_summary")
        if isinstance(phase.get("reward_term_summary"), dict)
        else {}
    )
    action_summary = (
        phase.get("action_summary")
        if isinstance(phase.get("action_summary"), dict)
        else {}
    )
    walking_success = phase.get("promotion_passed") is True and not stale_tracked_body
    learning_signal_present = (
        learning_return_delta is not None
        and learning_return_delta > 0.0
        and learning_delta_x is not None
        and learning_delta_x > 0.0
        and tracked_dx is not None
        and tracked_dx >= 0.30
        and physical_checks.get("tracked_delta_x_forward") is True
        and physical_checks.get("min_alternating_foot_contacts") is True
    )
    learned_motion_signal_present = (
        not stale_tracked_body
        and learning_return_delta is not None
        and learning_return_delta > 0.0
        and learning_delta_x is not None
        and learning_delta_x > 0.02
        and tracked_dx is not None
        and tracked_dx > 0.05
        and trained_failure_rate is not None
        and trained_failure_rate < 1.0
        and physical_checks.get("no_fall") is True
    )
    stable_standstill = (
        walking_success is not True
        and trained_failure_rate == 0.0
        and tracked_dx is not None
        and tracked_dx < 0.05
        and physical_checks.get("no_fall") is True
        and physical_checks.get("tracked_delta_x_forward") is not True
        and physical_checks.get("yaw_drift_bound") is True
    )
    no_forward_motion = (
        walking_success is not True
        and tracked_dx is not None
        and tracked_dx < 0.05
        and physical_checks.get("tracked_delta_x_forward") is not True
    )
    has_alternating_contacts = physical_checks.get("min_alternating_foot_contacts") is True
    partial_stepping = (
        walking_success is not True
        and trained_failure_rate == 0.0
        and has_alternating_contacts
        and tracked_dx is not None
        and 0.0 < tracked_dx < 0.30
        and physical_checks.get("tracked_delta_x_forward") is not True
    )
    stable_forward_shuffle = (
        walking_success is not True
        and trained_failure_rate == 0.0
        and not has_alternating_contacts
        and tracked_dx is not None
        and 0.05 <= tracked_dx < 0.30
        and physical_checks.get("no_fall") is True
        and physical_checks.get("tracked_delta_x_forward") is not True
        and physical_checks.get("yaw_drift_bound") is True
    )
    falling_lunge = (
        phase.get("promotion_passed") is not True
        and trained_failure_rate == 1.0
        and (
            (trained_yaw is not None and abs(trained_yaw) > 0.40)
            or (trained_dy is not None and abs(trained_dy) > 0.20)
        )
    )
    backward_fall = (
        walking_success is not True
        and trained_failure_rate == 1.0
        and tracked_dx is not None
        and tracked_dx < -0.05
        and physical_checks.get("no_fall") is not True
    )
    return {
        "source": str(probe_dir / "checkpoint" / "manifest.json"),
        "ok": walking_success,
        "profile_id": profile_id,
        "expected_tracked_body_name": expected_tracked_body,
        "tracked_body_name": tracked_body_name,
        "stale_tracked_body": stale_tracked_body,
        "learning_signal_present": learning_signal_present,
        "learned_motion_signal_present": learned_motion_signal_present,
        "walking_success": walking_success,
        "reward_delta_trained_minus_zero": learning_return_delta,
        "forward_delta_trained_minus_zero_m": learning_delta_x,
        "trained_failure_rate": trained_failure_rate,
        "zero_failure_rate": 0.0 if phase.get("pre_eval_success_rate") == 0.0 else None,
        "trained_mean_steps_survived": _float_or_none(phase.get("eval_mean_length")),
        "zero_mean_steps_survived": None,
        "trained_mean_final_delta_x_m": _float_or_none(phase.get("mean_final_delta_x_m")),
        "trained_mean_final_delta_y_m": trained_dy,
        "trained_mean_final_delta_yaw_rad": trained_yaw,
        "trained_mean_final_tracked_delta_x_m": tracked_dx,
        "movement_summary_trained": movement_summary,
        "reward_term_summary_trained": reward_term_summary,
        "action_summary_trained": action_summary,
        "promotion_passed": phase.get("promotion_passed"),
        "promotion_blocker": phase.get("promotion_blocker") or phase.get("blocker"),
        "promotion_reasons": phase.get("promotion_reasons")
        or history_phase.get("promotion_reasons"),
        "trained_is_falling_lunge": falling_lunge,
        "trained_is_backward_fall": backward_fall,
        "trained_is_stable_standstill": stable_standstill,
        "trained_has_no_forward_motion": no_forward_motion,
        "trained_has_alternating_contacts": has_alternating_contacts,
        "trained_is_partial_stepping_below_distance": partial_stepping,
        "trained_is_stable_forward_shuffle_below_distance": stable_forward_shuffle,
        "trained_is_learned_motion_without_walking": (
            learned_motion_signal_present and not walking_success
        ),
        "verdict": (
            "stale_tracked_body_training_probe"
            if stale_tracked_body
            else
            "backward_fall_after_gait_prior_8k"
            if backward_fall
            else
            "partial_stepping_below_distance_after_scale030_8k"
            if partial_stepping
            else
            "stable_forward_shuffle_below_distance_after_scale015_fall100_8k"
            if stable_forward_shuffle
            else
            "stable_standstill_after_yaw_contact_8k"
            if stable_standstill
            else "no_forward_motion_after_progress_8k"
            if no_forward_motion
            else "not_walking_after_progress_8k"
            if phase.get("promotion_passed") is not True
            else "walking_after_progress_8k"
        ),
    }


def _near_gait_visual_summary(
    report: dict[str, Any],
    *,
    report_path: Path,
    min_steps: int = 50,
    min_video_bytes: int = 10_000,
    min_contact_sheet_bytes: int = 5_000,
) -> dict[str, Any]:
    video = Path(str(report.get("video") or ""))
    contact_sheet = Path(str(report.get("contact_sheet") or ""))
    telemetry = report.get("telemetry") if isinstance(report.get("telemetry"), list) else []
    steps = int(report.get("steps") or 0)
    final_dx = report.get("final_tracked_delta_x_m")
    final_dy = report.get("final_tracked_delta_y_m")
    final_yaw = report.get("final_delta_yaw_rad")
    foot_switches = report.get("foot_contact_switches")
    try:
        final_dx_f = float(final_dx)
        final_dy_f = float(final_dy)
        final_yaw_f = float(final_yaw)
    except (TypeError, ValueError):
        final_dx_f = final_dy_f = final_yaw_f = float("nan")
    try:
        foot_switches_f = float(foot_switches)
    except (TypeError, ValueError):
        foot_switches_f = 0.0
    checks = {
        "report_present": report_path.is_file(),
        "schema": report.get("schema") == "hiwonder-near-gait-visual-evidence-v1",
        "video_present": video.is_file(),
        "video_nontrivial": video.is_file() and video.stat().st_size >= min_video_bytes,
        "contact_sheet_present": contact_sheet.is_file(),
        "contact_sheet_nontrivial": contact_sheet.is_file()
        and contact_sheet.stat().st_size >= min_contact_sheet_bytes,
        "telemetry_length": len(telemetry) >= min_steps and steps == len(telemetry),
    }
    walking_metrics = (
        final_dx_f >= 0.30
        and abs(final_dy_f) <= 0.20
        and abs(final_yaw_f) <= 0.40
    )
    active_motion_metrics = (
        final_dx_f >= 0.05
        and abs(final_dy_f) <= 0.20
        and abs(final_yaw_f) <= 0.40
        and foot_switches_f >= 2.0
    )
    return {
        "ok": all(checks.values()) and bool(report.get("walking_success")) and walking_metrics,
        "artifact_ok": all(checks.values()),
        "failed_checks": [name for name, ok in checks.items() if ok is not True],
        "checks": checks,
        "walking_metrics": walking_metrics,
        "motion_evidence": report.get("motion_evidence") is True
        and walking_metrics
        and checks["telemetry_length"],
        "active_motion_evidence": active_motion_metrics and checks["telemetry_length"],
        "walking_success": report.get("walking_success") is True,
        "walking_rejected": report.get("walking_success") is False,
        "controller": report.get("controller"),
        "locomotion_action_prior": report.get("locomotion_action_prior"),
        "locomotion_prior_feedback": report.get("locomotion_prior_feedback"),
        "report": str(report_path),
        "video": str(video) if str(video) else None,
        "contact_sheet": str(contact_sheet) if str(contact_sheet) else None,
        "steps": steps,
        "done_reason": report.get("done_reason"),
        "final_tracked_delta_x_m": final_dx,
        "final_tracked_delta_y_m": final_dy,
        "final_delta_yaw_rad": final_yaw,
        "max_success_window_s": report.get("max_success_window_s"),
        "max_abs_pitch_rad": report.get("max_abs_pitch_rad"),
        "max_abs_roll_rad": report.get("max_abs_roll_rad"),
        "max_abs_delta_yaw_rad": report.get("max_abs_delta_yaw_rad"),
        "foot_contact_switches": foot_switches,
    }


def _trace_sample_summary(trace: dict[str, Any]) -> dict[str, Any]:
    steps = trace.get("steps") if isinstance(trace.get("steps"), list) else []
    numeric_steps = [step for step in steps if isinstance(step, dict)]
    first = numeric_steps[0] if numeric_steps else {}
    last = numeric_steps[-1] if numeric_steps else {}
    obstacle = trace.get("obstacle") if isinstance(trace.get("obstacle"), dict) else {}
    goal = trace.get("goal") if isinstance(trace.get("goal"), list) else []
    summary = trace.get("summary") if isinstance(trace.get("summary"), dict) else {}
    xs = [
        float(step["x"])
        for step in numeric_steps
        if isinstance(step.get("x"), int | float)
    ]
    ys = [
        float(step["y"])
        for step in numeric_steps
        if isinstance(step.get("y"), int | float)
    ]
    obstacle_x = obstacle.get("x")
    obstacle_radius = float(obstacle.get("radius") or 0.0)
    reached_obstacle_x = (
        isinstance(obstacle_x, int | float) and bool(xs) and max(xs) >= float(obstacle_x)
    )
    cleared_obstacle_centerline = (
        isinstance(obstacle_x, int | float)
        and bool(xs)
        and max(xs) >= float(obstacle_x) + obstacle_radius
    )
    return {
        "task_id": trace.get("task_id"),
        "matrix_row": trace.get("_matrix_row"),
        "matrix_col": trace.get("_matrix_col"),
        "lane_y": trace.get("lane_y"),
        "steps": len(numeric_steps),
        "start_x": first.get("x"),
        "start_y": first.get("y"),
        "final_x": last.get("x"),
        "final_y": last.get("y"),
        "max_x": max(xs) if xs else None,
        "min_y": min(ys) if ys else None,
        "max_y": max(ys) if ys else None,
        "forward_progress_m": last.get("forward_progress_m"),
        "goal": goal,
        "obstacle": obstacle,
        "reached_obstacle_x": reached_obstacle_x,
        "cleared_obstacle_centerline": cleared_obstacle_centerline,
        "passed_obstacle_ever": any(
            step.get("passed_obstacle") is True for step in numeric_steps
        ),
        "collision_ever": any(step.get("collision") is True for step in numeric_steps),
        "summary_success_rate": summary.get("success_rate"),
        "summary_collision_rate": summary.get("collision_rate"),
        "summary_passed_obstacle_rate": summary.get("passed_obstacle_rate"),
        "summary_mean_forward_progress_m": summary.get("mean_forward_progress_m"),
        "summary_min_obstacle_clearance_m": summary.get("min_obstacle_clearance_m"),
    }


def _obstacle_trace_score(trace: dict[str, Any]) -> tuple[float, float, float, float]:
    steps = trace.get("steps") if isinstance(trace.get("steps"), list) else []
    rows = [step for step in steps if isinstance(step, dict)]
    summary = trace.get("summary") if isinstance(trace.get("summary"), dict) else {}
    obstacle = trace.get("obstacle") if isinstance(trace.get("obstacle"), dict) else {}
    xs = [
        float(step["x"])
        for step in rows
        if isinstance(step.get("x"), int | float)
    ]
    obstacle_x = obstacle.get("x")
    obstacle_radius = float(obstacle.get("radius") or 0.0)
    physically_cleared = (
        isinstance(obstacle_x, int | float)
        and bool(xs)
        and max(xs) > float(obstacle_x) + obstacle_radius
    )
    collision = float(summary.get("collision_rate") or 0.0)
    success = float(summary.get("success_rate") or 0.0)
    passed = float(summary.get("passed_obstacle_rate") or 0.0)
    progress = float(summary.get("mean_forward_progress_m") or 0.0)
    return (
        success,
        passed if physically_cleared else 0.0,
        1.0 - min(max(collision, 0.0), 1.0),
        progress,
    )


def _best_obstacle_trace_sample(result: dict[str, Any]) -> dict[str, Any] | None:
    matrix = result.get("trajectory_matrix")
    if not isinstance(matrix, list) or not matrix:
        return None
    best_trace = None
    best_score = (-1.0, -1.0, -1.0, -1.0)
    for row_index, row in enumerate(matrix):
        if not isinstance(row, list):
            continue
        for col_index, trace in enumerate(row):
            if not isinstance(trace, dict):
                continue
            score = _obstacle_trace_score(trace)
            if score > best_score:
                best_score = score
                best_trace = {
                    **trace,
                    "_matrix_row": row_index,
                    "_matrix_col": col_index,
                }
    return best_trace


def _fresh_obstacle_smoke_summary(
    smoke_report: dict[str, Any],
    smoke_bundle: dict[str, Any],
    *,
    fresh_obstacle_dir: Path,
    min_demo_video_bytes: int = 10_000,
) -> dict[str, Any]:
    demo = smoke_report.get("demo") if isinstance(smoke_report.get("demo"), dict) else {}
    demo_video = Path(str(demo.get("video") or fresh_obstacle_dir / "obstacle_course_demo.mp4"))
    demo_video_size = demo_video.stat().st_size if demo_video.is_file() else 0
    configured_learners = smoke_report.get("configured_learners")
    if not isinstance(configured_learners, list):
        configured_learners = []
    learner_results = (
        demo.get("learner_results") if isinstance(demo.get("learner_results"), dict) else {}
    )
    traces_by_learner: dict[str, dict[str, Any]] = {}
    for result in smoke_bundle.get("results") or []:
        if not isinstance(result, dict):
            continue
        sample_trace = _best_obstacle_trace_sample(result)
        if sample_trace is None:
            continue
        learner = str(result.get("name") or "")
        if learner:
            traces_by_learner[learner] = _trace_sample_summary(sample_trace)
    obstacle_baseline = (
        smoke_report.get("obstacle_baseline")
        if isinstance(smoke_report.get("obstacle_baseline"), dict)
        else {}
    )
    obstacle_trace_rollouts = (
        smoke_report.get("obstacle_trace_rollouts")
        if isinstance(smoke_report.get("obstacle_trace_rollouts"), dict)
        else {}
    )
    checks = {
        "validator_ok": smoke_report.get("ok") is True,
        "demo_schema": demo.get("schema") == "robot-alberta-obstacle-demo-v1",
        "demo_ok": demo.get("ok") is True,
        "demo_frames": int(demo.get("frames") or 0) > 0,
        "demo_video_present": demo_video.is_file(),
        "demo_video_nontrivial": demo_video_size >= min_demo_video_bytes,
        "demo_video_size_matches_json": demo_video_size == int(demo.get("video_bytes") or -1),
        "demo_has_all_learners": all(
            isinstance(learner_results.get(str(learner)), dict)
            for learner in configured_learners
        ),
        "demo_learners_have_traces": all(
            learner_results.get(str(learner), {}).get("has_trajectory_traces") is True
            for learner in configured_learners
        ),
        "trajectory_samples_present": all(
            str(learner) in traces_by_learner for learner in configured_learners
        )
        and bool(configured_learners),
        "passive_baseline_is_control": obstacle_baseline.get("baseline_is_control") is True,
        "learning_beats_passive_baseline": obstacle_baseline.get(
            "learning_beats_baseline"
        )
        is True,
        "trace_rollouts_ok": obstacle_trace_rollouts.get("ok") is True,
    }
    return {
        "ok": all(checks.values()),
        "artifact_ok": all(checks.values()),
        "benchmark_model": "2d_point_robot",
        "proves_alberta_obstacle_learning": all(checks.values()),
        "proves_robot_walking": False,
        "robot_walking_evidence_note": (
            "Fresh obstacle smoke is a task-conditioned 2D point-robot benchmark; "
            "it validates Alberta obstacle-course learning and path traces, not "
            "MuJoCo or real robot walking."
        ),
        "failed_checks": [name for name, ok in checks.items() if ok is not True],
        "checks": checks,
        "motion": smoke_report.get("motion"),
        "deltas": smoke_report.get("deltas"),
        "obstacle_baseline": obstacle_baseline,
        "obstacle_trace_rollouts": obstacle_trace_rollouts,
        "demo": {
            "schema": demo.get("schema"),
            "ok": demo.get("ok"),
            "frames": demo.get("frames"),
            "fps": demo.get("fps"),
            "video": str(demo_video),
            "video_bytes_json": demo.get("video_bytes"),
            "video_bytes_file": demo_video_size,
            "learners": demo.get("learners"),
            "adaptation": demo.get("adaptation"),
        },
        "trajectory_samples": traces_by_learner,
        "benchmark": str(fresh_obstacle_dir / "continual_benchmark.json"),
        "summary": smoke_bundle.get("summary"),
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    video = report["robot_video_physical_review"]
    learned = report["learned_policy_curriculum_eval"]
    local_probe = report["local_learning_probe"]
    feasibility = report["task_feasibility"]
    open_loop = report["open_loop_gait_search"]
    random_sine = report["hiwonder_random_sine_gait_search"]
    stabilized = report["hiwonder_stabilized_gait_search"]
    near_gait = report["hiwonder_near_gait_visual"]
    multi_profile_walk = report["multi_profile_walk_feasibility"]
    obstacle = report["obstacle_course_existing_evidence"]
    smoke = report["fresh_obstacle_smoke"]
    lines = [
        "# Robot Motion And Learning Audit",
        "",
        f"Overall ok: `{report['ok']}`",
        "",
        "## Findings",
        "",
        f"- Existing production robot videos prove physical walking/turning: `{video['ok']}`.",
        f"- Existing learned-policy curriculum eval proves task success and physical motion: `{learned['ok']}`.",
        f"- Local short learning probe shows learned motion signal: `{local_probe.get('learned_motion_signal_present')}`.",
        f"- Local short learning probe shows walking-grade learning signal: `{local_probe['learning_signal_present']}`.",
        f"- Local short learning probe reaches walking success: `{local_probe['walking_success']}`.",
        f"- Open-loop task feasibility candidates can satisfy walking: `{feasibility['ok']}`.",
        f"- Open-loop gait search finds a walking primitive: `{open_loop['ok']}`.",
        f"- Random sine gait search finds a walking primitive: `{random_sine.get('ok')}`.",
        f"- Stabilized near-gait search can hold walking: `{stabilized.get('ok')}`.",
        f"- HiWonder near-gait visual artifact proves active motion: `{near_gait['active_motion_evidence']}`.",
        f"- HiWonder near-gait visual artifact proves valid walking: `{near_gait['walking_success']}`.",
        f"- Cross-profile walking evidence beats passive baselines: `{multi_profile_walk['ok']}`.",
        f"- Existing Nebius obstacle-course evidence has benchmark rollout metrics: `{obstacle['ok']}`.",
        f"- Fresh obstacle smoke 2D point-robot benchmark with path traces passes: `{smoke['ok']}`.",
        f"- Fresh obstacle smoke proves MuJoCo/real robot walking: `{smoke.get('proves_robot_walking')}`.",
        "",
        "## Failed Production Video Motion Checks",
        "",
    ]
    failed_videos = video.get("failed_videos") or []
    if failed_videos:
        lines += [
            "| profile | action | failed checks |",
            "|---|---|---|",
        ]
        for row in failed_videos:
            lines.append(
                f"| `{row.get('profile')}` | `{row.get('action')}` | "
                f"`{', '.join(row.get('failed_checks') or [])}` |"
            )
    else:
        lines.append("- none")
    lines += [
        "",
        "## Learned Policy Curriculum Eval",
        "",
        f"Programmatic pass rate: `{learned.get('programmatic_pass_rate')}`",
        "",
    ]
    failed_tasks = learned.get("failed_tasks") or []
    if failed_tasks:
        lines += [
            "| task | failed physical checks | success rate |",
            "|---|---|---:|",
        ]
        for row in failed_tasks:
            lines.append(
                f"| `{row.get('task_id')}` | "
                f"`{', '.join(row.get('failed_physical_checks') or []) or 'none'}` | "
                f"{float(row.get('success_rate') or 0.0):.2f} |"
            )
    else:
        lines.append("- none")
    lines += [
        "",
        "## Local Learning Probe",
        "",
        f"Probe ok as walking evidence: `{local_probe.get('ok')}`",
        f"Verdict: `{local_probe.get('verdict') or 'missing'}`",
        f"Learned motion signal: `{local_probe.get('learned_motion_signal_present')}`",
        f"Walking-grade learning signal: `{local_probe.get('learning_signal_present')}`",
        f"Trained is falling lunge: `{local_probe.get('trained_is_falling_lunge')}`",
        f"Trained is backward fall: `{local_probe.get('trained_is_backward_fall')}`",
        f"Trained is stable standstill: `{local_probe.get('trained_is_stable_standstill')}`",
        f"Trained has no forward motion: `{local_probe.get('trained_has_no_forward_motion')}`",
        f"Trained has alternating contacts: `{local_probe.get('trained_has_alternating_contacts')}`",
        f"Trained is partial stepping below distance: `{local_probe.get('trained_is_partial_stepping_below_distance')}`",
        f"Trained is stable forward shuffle below distance: `{local_probe.get('trained_is_stable_forward_shuffle_below_distance')}`",
        f"Reward delta trained-zero: `{local_probe.get('reward_delta_trained_minus_zero')}`",
        f"Forward delta trained-zero m: `{local_probe.get('forward_delta_trained_minus_zero_m')}`",
        f"Tracked forward delta trained m: `{local_probe.get('trained_mean_final_tracked_delta_x_m')}`",
        f"Trained failure rate: `{local_probe.get('trained_failure_rate')}`",
        f"Trained yaw drift rad: `{local_probe.get('trained_mean_final_delta_yaw_rad')}`",
        f"Promotion blocker: `{local_probe.get('promotion_blocker') or 'missing'}`",
        "",
        "## Open-loop Task Feasibility",
        "",
        f"Feasibility ok: `{feasibility.get('ok')}`",
        f"Profile: `{feasibility.get('profile_id') or 'missing'}`",
        "",
    ]
    failed_feasibility = feasibility.get("failed_tasks") or []
    if failed_feasibility:
        lines += [
            "| task | best controller | best dx m | best-progress controller | progress | dx m | dy m | hold s | termination | unmet predicates |",
            "|---|---|---:|---|---:|---:|---:|---:|---|---|",
        ]
        for row in failed_feasibility:
            best = row.get("best_candidate") if isinstance(row.get("best_candidate"), dict) else {}
            most_progress = (
                row.get("most_progress_candidate")
                if isinstance(row.get("most_progress_candidate"), dict)
                else {}
            )
            lines.append(
                f"| `{row.get('task_id')}` | `{best.get('controller')}` | "
                f"{float(best.get('final_delta_x_m') or 0.0):.3f} | "
                f"`{most_progress.get('controller')}` | "
                f"{float(most_progress.get('progress_ratio') or 0.0):.2f} | "
                f"{float(most_progress.get('final_delta_x_m') or 0.0):.3f} | "
                f"{float(most_progress.get('final_delta_y_m') or 0.0):.3f} | "
                f"{float(most_progress.get('max_success_window_s') or 0.0):.2f} | "
                f"`{most_progress.get('termination_reason')}` | "
                f"`{', '.join(most_progress.get('unmet_success_predicates') or []) or 'none'}` |"
            )
    else:
        lines.append("- none")
    best_search = (
        open_loop.get("best_by_score")
        if isinstance(open_loop.get("best_by_score"), dict)
        else {}
    )
    forward_search = (
        open_loop.get("best_by_forward_progress")
        if isinstance(open_loop.get("best_by_forward_progress"), dict)
        else {}
    )
    peak_search = (
        open_loop.get("best_by_peak_forward_progress")
        if isinstance(open_loop.get("best_by_peak_forward_progress"), dict)
        else {}
    )
    stable_peak_search = (
        open_loop.get("best_stable_by_peak_forward_progress")
        if isinstance(open_loop.get("best_stable_by_peak_forward_progress"), dict)
        else {}
    )
    frontier = (
        open_loop.get("failure_frontier")
        if isinstance(open_loop.get("failure_frontier"), dict)
        else {}
    )
    lines += [
        "",
        "## Open-loop Gait Search",
        "",
        f"Search ok: `{open_loop.get('ok')}`",
        f"Candidates: `{open_loop.get('n_candidates')}`",
        "",
        "| criterion | controller | final dx m | peak dx m | termination | reason |",
        "|---|---|---:|---:|---|---|",
        f"| best score | `{best_search.get('controller')}` | "
        f"{float(best_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"{float(best_search.get('max_delta_x_m') or best_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"`{best_search.get('termination_reason')}` | `{best_search.get('reason') or 'none'}` |",
        f"| best forward | `{forward_search.get('controller')}` | "
        f"{float(forward_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"{float(forward_search.get('max_delta_x_m') or forward_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"`{forward_search.get('termination_reason')}` | `{forward_search.get('reason') or 'none'}` |",
        f"| best peak forward | `{peak_search.get('controller')}` | "
        f"{float(peak_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"{float(peak_search.get('max_delta_x_m') or peak_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"`{peak_search.get('termination_reason')}` | `{peak_search.get('reason') or 'none'}` |",
        f"| best stable peak forward | `{stable_peak_search.get('controller')}` | "
        f"{float(stable_peak_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"{float(stable_peak_search.get('max_delta_x_m') or stable_peak_search.get('final_delta_x_m') or 0.0):.3f} | "
        f"`{stable_peak_search.get('termination_reason')}` | `{stable_peak_search.get('reason') or 'none'}` |",
        "",
        "Failure frontier:",
        f"- primary gap: `{frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall candidates: `{frontier.get('n_forward_no_fall_candidates')}`",
        f"- forward + straight candidates: `{frontier.get('n_forward_straight_candidates')}`",
        f"- forward + no-fall + straight candidates: `{frontier.get('n_forward_no_fall_straight_candidates')}`",
        "",
        "## Random Sine Gait Search",
        "",
        f"Search ok: `{random_sine.get('ok')}`",
        f"Candidates: `{random_sine.get('n_candidates')}`",
        f"Successes: `{random_sine.get('n_success')}`",
    ]
    random_frontier = (
        random_sine.get("failure_frontier")
        if isinstance(random_sine.get("failure_frontier"), dict)
        else {}
    )
    lines += [
        f"- primary gap: `{random_frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{random_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{random_frontier.get('n_forward_no_fall_straight_candidates')}`",
    ]
    local_refinement = (
        random_sine.get("local_refinement")
        if isinstance(random_sine.get("local_refinement"), dict)
        else {}
    )
    local_frontier = (
        local_refinement.get("failure_frontier")
        if isinstance(local_refinement.get("failure_frontier"), dict)
        else {}
    )
    transition_refinement = (
        random_sine.get("transition_refinement")
        if isinstance(random_sine.get("transition_refinement"), dict)
        else {}
    )
    transition_frontier = (
        transition_refinement.get("failure_frontier")
        if isinstance(transition_refinement.get("failure_frontier"), dict)
        else {}
    )
    best_transition = (
        transition_refinement.get("best_by_success_window")
        if isinstance(transition_refinement.get("best_by_success_window"), dict)
        else {}
    )
    feedback_refinement = (
        random_sine.get("feedback_refinement")
        if isinstance(random_sine.get("feedback_refinement"), dict)
        else {}
    )
    feedback_frontier = (
        feedback_refinement.get("failure_frontier")
        if isinstance(feedback_refinement.get("failure_frontier"), dict)
        else {}
    )
    best_feedback = (
        feedback_refinement.get("best_by_success_window")
        if isinstance(feedback_refinement.get("best_by_success_window"), dict)
        else {}
    )
    hybrid_refinement = (
        random_sine.get("hybrid_recovery_refinement")
        if isinstance(random_sine.get("hybrid_recovery_refinement"), dict)
        else {}
    )
    hybrid_frontier = (
        hybrid_refinement.get("failure_frontier")
        if isinstance(hybrid_refinement.get("failure_frontier"), dict)
        else {}
    )
    best_hybrid = (
        hybrid_refinement.get("best_by_success_window")
        if isinstance(hybrid_refinement.get("best_by_success_window"), dict)
        else {}
    )
    lines += [
        "Local refinement:",
        f"- base controller: `{local_refinement.get('base_controller') or 'missing'}`",
        f"- candidates: `{local_refinement.get('n_candidates')}`",
        f"- successes: `{local_refinement.get('n_success')}`",
        f"- primary gap: `{local_frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{local_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{local_frontier.get('n_forward_no_fall_straight_candidates')}`",
        "Transition refinement:",
        f"- base controller: `{transition_refinement.get('base_controller') or 'missing'}`",
        f"- candidates: `{transition_refinement.get('n_candidates')}`",
        f"- successes: `{transition_refinement.get('n_success')}`",
        f"- primary gap: `{transition_frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{transition_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{transition_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_transition.get('controller') or 'missing'}`",
        f"- best success window s: `{best_transition.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_transition.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_transition.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_transition.get('termination_reason') or 'none'}`",
        "Feedback refinement:",
        f"- base controller: `{feedback_refinement.get('base_controller') or 'missing'}`",
        f"- candidates: `{feedback_refinement.get('n_candidates')}`",
        f"- successes: `{feedback_refinement.get('n_success')}`",
        f"- primary gap: `{feedback_frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{feedback_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{feedback_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_feedback.get('controller') or 'missing'}`",
        f"- best success window s: `{best_feedback.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_feedback.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_feedback.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_feedback.get('termination_reason') or 'none'}`",
        "Hybrid recovery refinement:",
        f"- base controller: `{hybrid_refinement.get('base_controller') or 'missing'}`",
        f"- candidates: `{hybrid_refinement.get('n_candidates')}`",
        f"- successes: `{hybrid_refinement.get('n_success')}`",
        f"- primary gap: `{hybrid_frontier.get('primary_gap') or 'missing'}`",
        f"- forward-displacement candidates: `{hybrid_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{hybrid_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_hybrid.get('controller') or 'missing'}`",
        f"- best success window s: `{best_hybrid.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_hybrid.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_hybrid.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_hybrid.get('termination_reason') or 'none'}`",
    ]
    lines += [
        "",
        "## HiWonder Near-gait Visual Evidence",
        "",
        f"Artifact ok: `{near_gait.get('artifact_ok')}`",
        f"Failed artifact checks: `{', '.join(near_gait.get('failed_checks') or []) or 'none'}`",
        f"Motion evidence: `{near_gait.get('motion_evidence')}`",
        f"Active motion evidence: `{near_gait.get('active_motion_evidence')}`",
        f"Walking success: `{near_gait.get('walking_success')}`",
        f"Controller: `{near_gait.get('controller')}`",
        f"Locomotion action prior: `{near_gait.get('locomotion_action_prior')}`",
        f"Locomotion prior feedback: `{near_gait.get('locomotion_prior_feedback')}`",
        f"Termination: `{near_gait.get('done_reason')}`",
        f"Final tracked dx m: `{near_gait.get('final_tracked_delta_x_m')}`",
        f"Final tracked dy m: `{near_gait.get('final_tracked_delta_y_m')}`",
        f"Final yaw rad: `{near_gait.get('final_delta_yaw_rad')}`",
        f"Max success window s: `{near_gait.get('max_success_window_s')}`",
        f"Max abs pitch rad: `{near_gait.get('max_abs_pitch_rad')}`",
        f"Max abs roll rad: `{near_gait.get('max_abs_roll_rad')}`",
        f"Max abs yaw rad: `{near_gait.get('max_abs_delta_yaw_rad')}`",
        f"Foot contact switches: `{near_gait.get('foot_contact_switches')}`",
        f"Video: `{near_gait.get('video')}`",
        f"Contact sheet: `{near_gait.get('contact_sheet')}`",
        "",
        "## HiWonder Stabilized Gait Search",
        "",
        f"Search ok: `{stabilized.get('ok')}`",
        f"Candidates: `{stabilized.get('n_candidates')}`",
        f"Best success-window controller: `{stabilized.get('best_by_success_window', {}).get('controller')}`",
        f"Best success window s: `{stabilized.get('best_by_success_window', {}).get('max_success_window_s')}`",
        f"Best success-window dx m: `{stabilized.get('best_by_success_window', {}).get('final_delta_x_m')}`",
        f"Best success-window failure: `{', '.join(stabilized.get('best_by_success_window', {}).get('diagnostics', {}).get('unmet_success_predicates') or []) or stabilized.get('best_by_success_window', {}).get('termination_reason') or 'none'}`",
        f"Report: `{stabilized.get('report')}`",
        "",
        "## Multi-profile Walk Feasibility",
        "",
        f"Cross-profile walk ok: `{multi_profile_walk.get('ok')}`",
        f"Valid walking profiles: `{multi_profile_walk.get('n_valid_walking')}`",
        f"Passive-success profiles: `{multi_profile_walk.get('n_passive_success')}`",
        "",
        "| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m | most-forward failure |",
        "|---|---|---|---:|---:|---|---:|---|",
    ]
    for row in multi_profile_walk.get("profiles") or []:
        if not isinstance(row, dict):
            continue
        lines.append(
            f"| `{row.get('profile_id')}` | `{row.get('active_success')}` | "
            f"`{row.get('passive_success')}` | "
            f"{float(row.get('selected_final_delta_x_m') or 0.0):.3f} | "
            f"{float(row.get('passive_final_delta_x_m') or 0.0):.3f} | "
            f"`{row.get('most_forward_controller')}` | "
            f"{float(row.get('most_forward_final_delta_x_m') or 0.0):.3f} | "
            f"`{', '.join(row.get('most_forward_unmet_success_predicates') or []) or row.get('most_forward_termination_reason') or 'none'}` |"
        )
    lines += [
        "",
        "## Obstacle Course",
        "",
        f"Existing evidence failed checks: `{', '.join(obstacle['failed_checks']) or 'none'}`",
        f"Fresh smoke artifact ok: `{smoke.get('artifact_ok')}`",
        f"Fresh smoke benchmark model: `{smoke.get('benchmark_model')}`",
        f"Fresh smoke proves Alberta obstacle learning: `{smoke.get('proves_alberta_obstacle_learning')}`",
        f"Fresh smoke proves MuJoCo/real robot walking: `{smoke.get('proves_robot_walking')}`",
        f"Fresh smoke note: `{smoke.get('robot_walking_evidence_note')}`",
        f"Fresh smoke artifact failed checks: `{', '.join(smoke.get('failed_checks') or []) or 'none'}`",
        f"Fresh smoke beats passive baseline: `{smoke.get('obstacle_baseline', {}).get('learning_beats_baseline')}`",
        f"Fresh smoke passive baseline is a control: `{smoke.get('obstacle_baseline', {}).get('baseline_is_control')}`",
        f"Fresh smoke trace rollouts ok: `{smoke.get('obstacle_trace_rollouts', {}).get('ok')}`",
        f"Fresh smoke trace consistency: `{smoke.get('obstacle_trace_rollouts', {}).get('all_trace_summaries_consistent')}`",
        f"Fresh smoke has successful final clear trace: `{smoke.get('obstacle_trace_rollouts', {}).get('any_required_learner_successful_final_clear')}`",
        f"Fresh smoke demo frames: `{smoke.get('demo', {}).get('frames')}`",
        f"Fresh smoke demo video bytes json/file: `{smoke.get('demo', {}).get('video_bytes_json')}` / `{smoke.get('demo', {}).get('video_bytes_file')}`",
        f"Fresh smoke demo video: `{smoke.get('demo', {}).get('video')}`",
        "",
        "Fresh smoke motion summary:",
        "",
        "```json",
        json.dumps(smoke.get("motion"), indent=2),
        "```",
        "",
        "Fresh smoke trajectory samples:",
        "",
        "| learner | steps | start x | final x | max x | progress m | reached obstacle x | cleared obstacle centerline | passed obstacle | collision | min clearance m |",
        "|---|---:|---:|---:|---:|---:|---|---|---|---|---:|",
    ]
    for learner, sample in (smoke.get("trajectory_samples") or {}).items():
        if not isinstance(sample, dict):
            continue
        lines.append(
            f"| `{learner}` | {int(sample.get('steps') or 0)} | "
            f"{float(sample.get('start_x') or 0.0):.3f} | "
            f"{float(sample.get('final_x') or 0.0):.3f} | "
            f"{float(sample.get('max_x') or 0.0):.3f} | "
            f"{float(sample.get('forward_progress_m') or 0.0):.3f} | "
            f"`{sample.get('reached_obstacle_x')}` | "
            f"`{sample.get('cleared_obstacle_centerline')}` | "
            f"`{sample.get('passed_obstacle_ever')}` | "
            f"`{sample.get('collision_ever')}` | "
            f"{float(sample.get('summary_min_obstacle_clearance_m') or 0.0):.3f} |"
        )
    lines += [
        "",
        "## Conclusion",
        "",
        "The current historical Nebius artifacts do not prove learned robot "
        "walking/turning or a physically meaningful obstacle-course result. "
        "The patched benchmark "
        "now records forward progress, obstacle passing, collision rate, "
        "success rate, and top-down rollout traces; fresh smoke evidence shows "
        "the harness can expose those facts. A production claim should require "
        "these physical checks.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def audit(
    *,
    run_root: Path,
    fresh_obstacle_dir: Path,
    local_probe_dir: Path,
    task_feasibility_path: Path,
    open_loop_search_path: Path,
    random_sine_search_path: Path,
    stabilized_gait_search_path: Path,
    near_gait_visual_path: Path,
    multi_profile_walk_path: Path,
    out_json: Path,
    out_md: Path,
) -> dict[str, Any]:
    run_root = run_root.resolve()
    video_review = review_videos(
        run_root / "evidence" / "agent_videos",
        out_dir=run_root / "evidence" / "video_review_physical_audit",
        samples=5,
        min_frames=5,
        min_nonblank_ratio=0.05,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.0001,
        require_telemetry=True,
    )
    obstacle_report = validate_alberta_benchmark_artifacts(
        run_root / "evidence" / "alberta_obstacle_course",
        expected_env="obstacle_course",
        min_seeds=3,
        min_steps_per_task=16_000,
        min_tasks=4,
        require_demo_video=True,
        require_alberta_forgetting_lte_ppo=True,
    )
    smoke_report = validate_alberta_benchmark_artifacts(
        fresh_obstacle_dir,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=500,
        min_tasks=3,
        require_demo_video=True,
        require_alberta_forgetting_lte_ppo=True,
    )
    smoke_bundle = _load(fresh_obstacle_dir / "continual_benchmark.json")
    local_probe = _local_learning_probe_from_dir(local_probe_dir)
    task_feasibility = _task_feasibility_summary(_load(task_feasibility_path))
    open_loop_search = _load(open_loop_search_path)
    random_sine_search = _load(random_sine_search_path)
    stabilized_gait_search = _load(stabilized_gait_search_path)
    near_gait_visual = _near_gait_visual_summary(
        _load(near_gait_visual_path),
        report_path=near_gait_visual_path,
    )
    fresh_obstacle_smoke = _fresh_obstacle_smoke_summary(
        smoke_report,
        smoke_bundle,
        fresh_obstacle_dir=fresh_obstacle_dir,
    )
    multi_profile_walk = _multi_profile_walk_summary(_load(multi_profile_walk_path))
    native_eval = _load(run_root / "evidence" / "curriculum_eval" / "eval_text_policy.json")
    learned_report = curriculum_report_from_eval(native_eval) if native_eval else {}
    failed_learned_tasks = []
    for row in learned_report.get("tasks", []):
        if not isinstance(row, dict) or row.get("success_programmatic") is True:
            continue
        physical_checks = (
            row.get("physical_checks") if isinstance(row.get("physical_checks"), dict) else {}
        )
        failed_learned_tasks.append(
            {
                "task_id": row.get("task_id"),
                "success_rate": row.get("success_rate"),
                "physical_success": row.get("physical_success"),
                "failed_physical_checks": [
                    name for name, ok in physical_checks.items() if ok is not True
                ],
                "mean_final_delta_x_m": row.get("mean_final_delta_x_m"),
                "mean_final_delta_y_m": row.get("mean_final_delta_y_m"),
                "mean_final_delta_yaw_rad": row.get("mean_final_delta_yaw_rad"),
            }
        )
    report = {
        "schema": "robot-motion-learning-audit-v1",
        "ok": bool(video_review.get("ok"))
        and bool(learned_report)
        and not failed_learned_tasks
        and bool(local_probe.get("walking_success"))
        and bool(task_feasibility.get("ok"))
        and (
            bool(open_loop_search.get("any_success"))
            or bool(random_sine_search.get("any_success"))
            or bool(stabilized_gait_search.get("any_success"))
        )
        and bool(multi_profile_walk.get("ok"))
        and bool(obstacle_report.get("ok"))
        and bool(smoke_report.get("ok")),
        "run_root": str(run_root),
        "robot_video_physical_review": {
            "ok": video_review.get("ok"),
            "video_count": video_review.get("video_count"),
            "profiles": video_review.get("profiles"),
            "failed_video_count": len(_failed_video_rows(video_review)),
            "failed_videos": _failed_video_rows(video_review),
            "report": str(run_root / "evidence" / "video_review_physical_audit" / "video_review.json"),
        },
        "learned_policy_curriculum_eval": {
            "ok": bool(learned_report) and not failed_learned_tasks,
            "native_eval": str(
                run_root / "evidence" / "curriculum_eval" / "eval_text_policy.json"
            ),
            "programmatic_pass_rate": learned_report.get("programmatic_pass_rate"),
            "n_programmatic_pass": learned_report.get("n_programmatic_pass"),
            "n_tasks": learned_report.get("n_tasks"),
            "failed_tasks": failed_learned_tasks,
        },
        "local_learning_probe": {
            "ok": bool(local_probe.get("walking_success")),
            "probe": local_probe.get("source") or str(local_probe_dir),
            **local_probe,
        },
        "task_feasibility": {
            **task_feasibility,
            "report": str(task_feasibility_path),
        },
        "open_loop_gait_search": {
            "ok": bool(open_loop_search.get("any_success")),
            "report": str(open_loop_search_path),
            "n_candidates": open_loop_search.get("n_candidates"),
            "n_success": open_loop_search.get("n_success"),
            "best_by_score": open_loop_search.get("best_by_score"),
            "best_by_forward_progress": open_loop_search.get(
                "best_by_forward_progress"
            ),
            "best_by_peak_forward_progress": open_loop_search.get(
                "best_by_peak_forward_progress"
            ),
            "best_stable_by_peak_forward_progress": open_loop_search.get(
                "best_stable_by_peak_forward_progress"
            ),
            "failure_frontier": open_loop_search.get("failure_frontier"),
        },
        "hiwonder_random_sine_gait_search": {
            "ok": bool(random_sine_search.get("any_success")),
            "report": str(random_sine_search_path),
            "n_candidates": random_sine_search.get("n_candidates"),
            "n_success": random_sine_search.get("n_success"),
            "failure_frontier": random_sine_search.get("failure_frontier"),
            "local_refinement": random_sine_search.get("local_refinement"),
            "transition_refinement": random_sine_search.get(
                "transition_refinement"
            ),
            "feedback_refinement": random_sine_search.get("feedback_refinement"),
            "hybrid_recovery_refinement": random_sine_search.get(
                "hybrid_recovery_refinement"
            ),
        },
        "hiwonder_stabilized_gait_search": {
            "ok": bool(stabilized_gait_search.get("any_success")),
            "report": str(stabilized_gait_search_path),
            "n_candidates": stabilized_gait_search.get("n_candidates"),
            "n_success": stabilized_gait_search.get("n_success"),
            "best_by_success_window": stabilized_gait_search.get(
                "best_by_success_window"
            ),
            "best_by_forward_progress": stabilized_gait_search.get(
                "best_by_forward_progress"
            ),
        },
        "hiwonder_near_gait_visual": {
            **near_gait_visual,
        },
        "multi_profile_walk_feasibility": {
            **multi_profile_walk,
            "report": str(multi_profile_walk_path),
        },
        "obstacle_course_existing_evidence": {
            "ok": obstacle_report.get("ok"),
            "failed_checks": _false_checks(obstacle_report),
            "motion": obstacle_report.get("motion"),
            "deltas": obstacle_report.get("deltas"),
        },
        "fresh_obstacle_smoke": {
            **fresh_obstacle_smoke,
            "validator_ok": smoke_report.get("ok"),
            "validator_failed_checks": _false_checks(smoke_report),
        },
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(out_md, report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-root",
        type=Path,
        default=ROOT / "evidence" / "nebius_full_training" / "synced_run",
    )
    parser.add_argument(
        "--fresh-obstacle-dir",
        type=Path,
        default=ROOT / "evidence" / "obstacle_motion_trajectory_audit_smoke",
    )
    parser.add_argument(
        "--local-probe-dir",
        type=Path,
        default=ROOT
        / "evidence"
        / "local_learning_probe_hiwonder_walk_progress_reward_balanced_scale015_fall100_8k",
    )
    parser.add_argument(
        "--task-feasibility-path",
        type=Path,
        default=DEFAULT_TASK_FEASIBILITY_PATH,
    )
    parser.add_argument(
        "--open-loop-search-path",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_open_loop_gait_search.json",
    )
    parser.add_argument(
        "--random-sine-search-path",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_random_sine_gait_search.json",
    )
    parser.add_argument(
        "--near-gait-visual-path",
        type=Path,
        default=(
            ROOT
            / "evidence"
            / "hiwonder_near_gait_visual_sine_feedback_scale028"
            / "env_hiwonder_sine_prior.json"
        ),
    )
    parser.add_argument(
        "--stabilized-gait-search-path",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_stabilized_gait_search.json",
    )
    parser.add_argument(
        "--multi-profile-walk-path",
        type=Path,
        default=ROOT / "evidence" / "multi_profile_walk_feasibility.json",
    )
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "evidence" / "robot_motion_learning_audit.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "evidence" / "robot_motion_learning_audit.md",
    )
    args = parser.parse_args(argv)
    report = audit(
        run_root=args.run_root,
        fresh_obstacle_dir=args.fresh_obstacle_dir,
        local_probe_dir=args.local_probe_dir,
        task_feasibility_path=args.task_feasibility_path,
        open_loop_search_path=args.open_loop_search_path,
        random_sine_search_path=args.random_sine_search_path,
        stabilized_gait_search_path=args.stabilized_gait_search_path,
        near_gait_visual_path=args.near_gait_visual_path,
        multi_profile_walk_path=args.multi_profile_walk_path,
        out_json=args.out_json,
        out_md=args.out_md,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
