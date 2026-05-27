#!/usr/bin/env python3
"""Generate the artifact-driven final Alberta robot training report."""

from __future__ import annotations

import argparse
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and math.isfinite(float(value))
    )


def _fmt(value: Any) -> str:
    if _finite_number(value):
        return f"{float(value):.4f}"
    if value is None:
        return "missing"
    return str(value)


def _benchmark_summary(path: Path) -> dict[str, Any]:
    data = _load_json(path / "continual_benchmark.json")
    return data.get("summary") if isinstance(data.get("summary"), dict) else {}


def _mean(summary: dict[str, Any], learner: str, metric: str) -> Any:
    block = summary.get(learner)
    if not isinstance(block, dict):
        return None
    item = block.get(metric)
    if not isinstance(item, dict):
        return None
    return item.get("mean")


def _delta(left: Any, right: Any) -> float | None:
    if _finite_number(left) and _finite_number(right):
        return float(left) - float(right)
    return None


def _observed_delta_comparisons(deltas: dict[str, Any]) -> dict[str, bool]:
    acc_delta = deltas.get("alberta_acc_minus_ppo")
    forgetting_delta = deltas.get("alberta_forgetting_minus_ppo")
    observed: dict[str, bool] = {}
    if _finite_number(acc_delta):
        observed["alberta_acc_gte_ppo"] = float(acc_delta) >= 0.0
    if _finite_number(forgetting_delta):
        observed["alberta_forgetting_lte_ppo"] = float(forgetting_delta) <= 0.0
    return observed


def _enforced_delta_gates(
    observed: dict[str, bool],
    required_deltas: dict[str, Any],
    fallback_checks: dict[str, Any],
) -> dict[str, bool]:
    return {
        "alberta_acc_gte_ppo": (
            observed.get("alberta_acc_gte_ppo") is True
            if required_deltas.get("require_alberta_acc_gte_ppo") is True
            else True
        )
        if "alberta_acc_gte_ppo" in observed
        else fallback_checks.get("alberta_acc_gte_ppo") is True,
        "alberta_forgetting_lte_ppo": (
            observed.get("alberta_forgetting_lte_ppo") is True
            if required_deltas.get("require_alberta_forgetting_lte_ppo") is True
            else True
        )
        if "alberta_forgetting_lte_ppo" in observed
        else fallback_checks.get("alberta_forgetting_lte_ppo") is True,
    }


def _video_metric_summary(video_review: dict[str, Any]) -> dict[str, Any]:
    videos = video_review.get("videos")
    if not isinstance(videos, list):
        videos = []
    ok_videos = [item for item in videos if isinstance(item, dict) and item.get("ok")]
    visual_progress = [
        float(item["visual_progress"])
        for item in videos
        if isinstance(item, dict) and _finite_number(item.get("visual_progress"))
    ]
    frame_delta = [
        float(item["mean_frame_delta"])
        for item in videos
        if isinstance(item, dict) and _finite_number(item.get("mean_frame_delta"))
    ]
    profiles = sorted(
        {
            str(item["profile"])
            for item in videos
            if isinstance(item, dict) and isinstance(item.get("profile"), str)
        }
    )
    return {
        "reviewed_video_count": len(videos),
        "ok_video_count": len(ok_videos),
        "profiles": profiles,
        "min_visual_progress": min(visual_progress) if visual_progress else None,
        "mean_visual_progress": (
            sum(visual_progress) / len(visual_progress) if visual_progress else None
        ),
        "mean_frame_delta": sum(frame_delta) / len(frame_delta) if frame_delta else None,
    }


def _multi_robot_video_summary(video_evidence: dict[str, Any]) -> dict[str, Any]:
    profiles = video_evidence.get("profiles")
    if not isinstance(profiles, list):
        profiles = []
    profile_rows: list[dict[str, Any]] = []
    for item in profiles:
        if not isinstance(item, dict):
            continue
        expected = item.get("expected") if isinstance(item.get("expected"), list) else []
        present = item.get("present") if isinstance(item.get("present"), list) else []
        missing = item.get("missing") if isinstance(item.get("missing"), list) else []
        too_small = item.get("too_small") if isinstance(item.get("too_small"), list) else []
        combined_present = any(
            isinstance(present_item, dict)
            and str(present_item.get("name", "")).endswith("_combined_actions.mp4")
            for present_item in present
        )
        profile_rows.append(
            {
                "profile": item.get("profile"),
                "ok": item.get("ok"),
                "expected_count": len(expected),
                "present_count": len(present),
                "missing": missing,
                "too_small": too_small,
                "combined_present": combined_present,
            }
        )
    return {
        "ok": video_evidence.get("ok"),
        "manifest": video_evidence.get("manifest"),
        "manifest_ok_field": video_evidence.get("manifest_ok_field"),
        "require_combined": video_evidence.get("require_combined"),
        "profile_count": len(profile_rows),
        "ok_profile_count": sum(1 for item in profile_rows if item.get("ok") is True),
        "profiles": profile_rows,
    }


def _check(report: dict[str, Any], *path: str) -> Any:
    current: Any = report
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def generate_nebius_training_report(run_root: Path) -> dict[str, Any]:
    run_root = run_root.resolve()
    evidence = run_root / "evidence"
    monitor = _load_json(run_root / "monitor_status.json")
    finalization = _load_json(run_root / "finalization_report.json")
    validation = _load_json(run_root / "validation_report.json")
    comparison = _load_json(evidence / "backend_compare" / "asimov-1" / "comparison.json")
    joint_reach = _benchmark_summary(evidence / "alberta_joint_reach")
    obstacle = _benchmark_summary(evidence / "alberta_obstacle_course")
    video_review = _load_json(evidence / "video_review_production" / "video_review.json")
    multi_robot_smoke_review = _load_json(
        evidence / "multi_robot_smoke_review" / "video_review.json"
    )
    alberta_end_to_end_report = _load_json(evidence / "ALBERTA_END_TO_END_REPORT.json")
    video_metrics = _video_metric_summary(video_review)
    multi_robot_smoke_metrics = _video_metric_summary(multi_robot_smoke_review)
    training_inputs = _load_json(
        evidence / "full_training_preflight" / "training_inputs_report.json"
    )
    brax_manifest = _load_json(
        evidence / "full_training_preflight" / "asimov_1_brax_mjx_baseline" / "manifest.json"
    )
    tasks = comparison.get("tasks") if isinstance(comparison.get("tasks"), list) else []
    alberta_mean_reward = (
        comparison.get("alberta", {}).get("eval", {}).get("mean_reward_overall")
        if isinstance(comparison.get("alberta"), dict)
        else None
    )
    ppo_mean_reward = (
        comparison.get("ppo", {}).get("eval", {}).get("mean_reward_overall")
        if isinstance(comparison.get("ppo"), dict)
        else None
    )
    untrained_mean_reward = (
        comparison.get("baseline", {}).get("mean_reward_overall")
        if isinstance(comparison.get("baseline"), dict)
        else None
    )
    joint_alberta_acc = _mean(joint_reach, "alberta", "acc")
    joint_alberta_forgetting = _mean(joint_reach, "alberta", "forgetting")
    joint_ppo_acc = _mean(joint_reach, "ppo", "acc")
    joint_ppo_forgetting = _mean(joint_reach, "ppo", "forgetting")
    obstacle_alberta_acc = _mean(obstacle, "alberta", "acc")
    obstacle_alberta_forgetting = _mean(obstacle, "alberta", "forgetting")
    obstacle_ppo_acc = _mean(obstacle, "ppo", "acc")
    obstacle_ppo_forgetting = _mean(obstacle, "ppo", "forgetting")

    method_matrix = {
        "alberta_streaming": {
            "role": "default continual online robot learner",
            "artifact_present": bool(comparison.get("alberta")),
            "robot_mean_reward": alberta_mean_reward,
            "joint_reach_acc": joint_alberta_acc,
            "joint_reach_forgetting": joint_alberta_forgetting,
            "obstacle_course_acc": obstacle_alberta_acc,
            "obstacle_course_forgetting": obstacle_alberta_forgetting,
            "video_reviewed": bool(video_review.get("ok")),
        },
        "stable_baselines3_ppo": {
            "role": "matched local robot-policy baseline",
            "artifact_present": bool(comparison.get("ppo")),
            "robot_mean_reward": ppo_mean_reward,
            "joint_reach_acc": joint_ppo_acc,
            "joint_reach_forgetting": joint_ppo_forgetting,
            "obstacle_course_acc": obstacle_ppo_acc,
            "obstacle_course_forgetting": obstacle_ppo_forgetting,
            "video_reviewed": bool(video_review.get("ok")),
        },
        "untrained_policy": {
            "role": "zero/untrained control baseline",
            "artifact_present": bool(comparison.get("baseline")),
            "robot_mean_reward": untrained_mean_reward,
            "robot_delta_vs_alberta": _delta(untrained_mean_reward, alberta_mean_reward),
            "robot_delta_vs_ppo": _delta(untrained_mean_reward, ppo_mean_reward),
        },
        "brax_mjx_ppo": {
            "role": "SOTA-style accelerator PPO baseline",
            "artifact_present": bool(brax_manifest),
            "regime": brax_manifest.get("regime"),
            "total_steps": brax_manifest.get("total_steps"),
            "profile_id": brax_manifest.get("profile_id"),
        },
    }
    obstacle_acc_delta = _delta(obstacle_alberta_acc, obstacle_ppo_acc)
    obstacle_forgetting_delta = _delta(
        obstacle_alberta_forgetting, obstacle_ppo_forgetting
    )
    validation_checks = (
        validation.get("checks") if isinstance(validation.get("checks"), dict) else {}
    )
    current_failed_validation_gates = [
        name for name, value in validation_checks.items() if not value
    ]
    finalization_missing_gates = (
        finalization.get("missing_gates")
        if isinstance(finalization.get("missing_gates"), list)
        else []
    )
    missing_gates = list(
        dict.fromkeys([*finalization_missing_gates, *current_failed_validation_gates])
    )
    finalization_report_ok = finalization.get("ok") is True
    validation_report_ok = validation.get("ok") is True
    finalization_matches_current_validation = (
        finalization_report_ok
        and validation_report_ok
        and not current_failed_validation_gates
    ) or (
        not finalization_report_ok
        and not validation_report_ok
        and all(gate in finalization_missing_gates for gate in current_failed_validation_gates)
    )
    effective_finalization_ok = (
        finalization_report_ok
        and validation_report_ok
        and finalization_matches_current_validation
    )
    report = {
        "schema": "robot-nebius-training-comparison-report-v1",
        "ok": False,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "run_id": monitor.get("run_id") or validation.get("run_id"),
        "run_root": str(run_root),
        "monitor_state": monitor.get("state"),
        "finalization_ok": effective_finalization_ok,
        "finalization_report_ok": finalization.get("ok"),
        "finalization_matches_current_validation": finalization_matches_current_validation,
        "validation_ok": validation.get("ok"),
        "missing_gates": missing_gates,
        "backend_comparison": {
            "present": bool(comparison),
            "profile_id": comparison.get("profile_id"),
            "tasks": tasks,
            "steps": comparison.get("steps"),
            "winner_by_mean_reward": comparison.get("winner_by_mean_reward"),
            "alberta_mean_reward": alberta_mean_reward,
            "ppo_mean_reward": ppo_mean_reward,
            "untrained_mean_reward": untrained_mean_reward,
            "alberta_delta_vs_ppo": _delta(alberta_mean_reward, ppo_mean_reward),
            "alberta_delta_vs_untrained": _delta(
                alberta_mean_reward, untrained_mean_reward
            ),
            "ppo_delta_vs_untrained": _delta(ppo_mean_reward, untrained_mean_reward),
        },
        "continual_learning": {
            "joint_reach": {
                "present": bool(joint_reach),
                "alberta_acc": joint_alberta_acc,
                "alberta_forgetting": joint_alberta_forgetting,
                "ppo_acc": joint_ppo_acc,
                "ppo_forgetting": joint_ppo_forgetting,
                "alberta_acc_delta_vs_ppo": _delta(joint_alberta_acc, joint_ppo_acc),
                "alberta_forgetting_delta_vs_ppo": _delta(
                    joint_alberta_forgetting, joint_ppo_forgetting
                ),
            },
            "obstacle_course": {
                "present": bool(obstacle),
                "alberta_acc": obstacle_alberta_acc,
                "alberta_forgetting": obstacle_alberta_forgetting,
                "ppo_acc": obstacle_ppo_acc,
                "ppo_forgetting": obstacle_ppo_forgetting,
                "alberta_acc_delta_vs_ppo": obstacle_acc_delta,
                "alberta_forgetting_delta_vs_ppo": obstacle_forgetting_delta,
            },
        },
        "obstacle_generalization": {
            "present": bool(obstacle),
            "alberta_acc_delta_vs_ppo": obstacle_acc_delta,
            "alberta_forgetting_delta_vs_ppo": obstacle_forgetting_delta,
            "alberta_no_catastrophic_forgetting_observed": (
                _finite_number(obstacle_alberta_forgetting)
                and float(obstacle_alberta_forgetting) <= 0.0
            ),
            "alberta_forgetting_not_worse_than_ppo": (
                obstacle_forgetting_delta is not None and obstacle_forgetting_delta <= 0.0
            ),
        },
        "method_matrix": method_matrix,
        "sota_baseline": {
            "brax_mjx_present": bool(brax_manifest),
            "regime": brax_manifest.get("regime"),
            "total_steps": brax_manifest.get("total_steps"),
            "profile_id": brax_manifest.get("profile_id"),
        },
        "video_review": {
            "present": bool(video_review),
            "ok": video_review.get("ok"),
            "video_count": video_review.get("video_count"),
            "action_progress": video_metrics,
        },
        "multi_robot_smoke_review": {
            "present": bool(multi_robot_smoke_review),
            "ok": multi_robot_smoke_review.get("ok"),
            "video_count": multi_robot_smoke_review.get("video_count"),
            "action_progress": multi_robot_smoke_metrics,
        },
        "alberta_end_to_end_report": {
            "present": bool(alberta_end_to_end_report),
            "ok": alberta_end_to_end_report.get("ok"),
            "production_complete": alberta_end_to_end_report.get("production_complete"),
            "production_blocker": alberta_end_to_end_report.get("production_blocker"),
            "video_count": _check(alberta_end_to_end_report, "video_review", "video_count"),
            "profiles": _check(alberta_end_to_end_report, "video_review", "profiles") or [],
            "backend_winner": _check(
                alberta_end_to_end_report,
                "backend_comparison",
                "winner_by_mean_reward",
            ),
            "obstacle_acc_delta": _check(
                alberta_end_to_end_report,
                "continual_obstacle_course",
                "deltas",
                "alberta_acc_minus_ppo",
            ),
            "obstacle_forgetting_delta": _check(
                alberta_end_to_end_report,
                "continual_obstacle_course",
                "deltas",
                "alberta_forgetting_minus_ppo",
            ),
            "claim_support": alberta_end_to_end_report.get("claim_support")
            if isinstance(alberta_end_to_end_report.get("claim_support"), dict)
            else {},
            "video_manifest_review_consistent": _check(
                alberta_end_to_end_report,
                "video_review",
                "manifest_review_consistent",
            ),
            "video_all_manifest_profiles_ok": _check(
                alberta_end_to_end_report,
                "video_review",
                "all_manifest_profiles_ok",
            ),
        },
        "training_inputs": {
            "present": bool(training_inputs),
            "ok": training_inputs.get("ok"),
            "launch_tasks": training_inputs.get("launch_tasks", []),
            "warning_kinds": [
                item.get("kind")
                for item in training_inputs.get("warnings", [])
                if isinstance(item, dict)
            ]
            if isinstance(training_inputs.get("warnings"), list)
            else [],
            "offline_datasets_present": training_inputs.get("datasets", {}).get(
                "offline_datasets_present"
            )
            if isinstance(training_inputs.get("datasets"), dict)
            else None,
            "rl_from_sim_ready": training_inputs.get("datasets", {}).get(
                "rl_from_sim_ready"
            )
            if isinstance(training_inputs.get("datasets"), dict)
            else None,
            "imitation_training_ready": training_inputs.get("datasets", {}).get(
                "imitation_training_ready"
            )
            if isinstance(training_inputs.get("datasets"), dict)
            else None,
            "offline_datasets_block_current_plan": training_inputs.get(
                "datasets", {}
            ).get("offline_datasets_block_current_plan")
            if isinstance(training_inputs.get("datasets"), dict)
            else None,
            "curriculum_sha256": training_inputs.get("curriculum", {}).get(
                "content_sha256"
            )
            if isinstance(training_inputs.get("curriculum"), dict)
            else None,
        },
        "validation_gates": {
            "training_inputs": {
                "ok": _check(validation, "reports", "training_inputs", "ok"),
                "checks": _check(validation, "reports", "training_inputs", "checks")
                or {},
                "warning_kinds": _check(
                    validation, "reports", "training_inputs", "warning_kinds"
                )
                or [],
            },
            "stage_status": {
                "ok": _check(validation, "reports", "stage_status", "ok"),
                "checks": _check(validation, "reports", "stage_status", "checks")
                or {},
                "runner": _check(validation, "reports", "stage_status", "runner")
                or {},
                "stages": _check(validation, "reports", "stage_status", "stages")
                or {},
            },
            "multi_robot_readiness": {
                "ok": _check(validation, "reports", "multi_robot_readiness", "ok"),
                "profiles": _check(
                    validation, "reports", "multi_robot_readiness", "profiles"
                )
                or {},
                "video_evidence": _check(
                    validation, "reports", "multi_robot_readiness", "video_evidence"
                )
                or {},
            },
            "backend_comparison": {
                "ok": _check(validation, "reports", "backend_comparison", "ok"),
                "checks": _check(validation, "reports", "backend_comparison", "checks")
                or {},
                "deltas": _check(validation, "reports", "backend_comparison", "deltas")
                or {},
            },
            "joint_reach_benchmark": {
                "ok": _check(validation, "reports", "joint_reach_benchmark", "ok"),
                "checks": _check(validation, "reports", "joint_reach_benchmark", "checks")
                or {},
                "deltas": _check(validation, "reports", "joint_reach_benchmark", "deltas")
                or {},
                "required_deltas": _check(
                    validation, "reports", "joint_reach_benchmark", "required_deltas"
                )
                or {},
                "observed_comparisons": _check(
                    validation,
                    "reports",
                    "joint_reach_benchmark",
                    "observed_comparisons",
                )
                or {},
                "enforced_delta_gates": _check(
                    validation,
                    "reports",
                    "joint_reach_benchmark",
                    "enforced_delta_gates",
                )
                or {},
            },
            "obstacle_course_benchmark": {
                "ok": _check(validation, "reports", "obstacle_course_benchmark", "ok"),
                "checks": _check(
                    validation, "reports", "obstacle_course_benchmark", "checks"
                )
                or {},
                "deltas": _check(
                    validation, "reports", "obstacle_course_benchmark", "deltas"
                )
                or {},
                "required_deltas": _check(
                    validation,
                    "reports",
                    "obstacle_course_benchmark",
                    "required_deltas",
                )
                or {},
                "observed_comparisons": _check(
                    validation,
                    "reports",
                    "obstacle_course_benchmark",
                    "observed_comparisons",
                )
                or {},
                "enforced_delta_gates": _check(
                    validation,
                    "reports",
                    "obstacle_course_benchmark",
                    "enforced_delta_gates",
                )
                or {},
            },
            "alberta_checkpoint": {
                "ok": _check(validation, "reports", "alberta_checkpoint", "ok"),
                "checks": _check(validation, "reports", "alberta_checkpoint", "checks")
                or {},
                "profile_id": _check(
                    validation, "reports", "alberta_checkpoint", "profile_id"
                ),
                "total_steps": _check(
                    validation, "reports", "alberta_checkpoint", "total_steps"
                ),
            },
            "asimov1_alberta_production": {
                "ok": _check(
                    validation, "reports", "asimov1_alberta_production", "ok"
                ),
                "checks": _check(
                    validation, "reports", "asimov1_alberta_production", "checks"
                )
                or {},
                "production_regime": _check(
                    validation,
                    "reports",
                    "asimov1_alberta_production",
                    "production_regime",
                ),
                "max_metric_steps": _check(
                    validation,
                    "reports",
                    "asimov1_alberta_production",
                    "max_metric_steps",
                ),
            },
            "brax_full_training_run": {
                "ok": _check(validation, "reports", "brax_full_training_run", "ok"),
                "checks": _check(validation, "reports", "brax_full_training_run", "checks")
                or {},
            },
            "brax_production_checkpoint": {
                "ok": _check(validation, "reports", "brax_production_checkpoint", "ok"),
                "checks": _check(
                    validation, "reports", "brax_production_checkpoint", "checks"
                )
                or {},
            },
            "video_review": {
                "ok": _check(validation, "reports", "video_review", "ok"),
                "thresholds": _check(validation, "reports", "video_review", "thresholds")
                or {},
                "video_count": _check(validation, "reports", "video_review", "video_count"),
            },
            "production_policy_videos": {
                "ok": _check(validation, "reports", "production_policy_videos", "ok"),
                "checks": _check(
                    validation, "reports", "production_policy_videos", "checks"
                )
                or {},
                "profile_id": _check(
                    validation, "reports", "production_policy_videos", "profile_id"
                ),
                "checkpoint": _check(
                    validation, "reports", "production_policy_videos", "checkpoint"
                ),
            },
            "curriculum_eval": {
                "ok": _check(validation, "reports", "curriculum_eval", "ok"),
                "checks": _check(validation, "reports", "curriculum_eval", "checks")
                or {},
                "programmatic_pass_rate": _check(
                    validation,
                    "reports",
                    "curriculum_eval",
                    "programmatic_pass_rate",
                ),
                "min_programmatic_pass_rate": _check(
                    validation,
                    "reports",
                    "curriculum_eval",
                    "min_programmatic_pass_rate",
                ),
                "task_checks": _check(
                    validation, "reports", "curriculum_eval", "task_checks"
                )
                or {},
            },
            "instance_launch_hygiene": {
                "ok": _check(validation, "reports", "instance_launch_hygiene", "ok"),
                "checks": _check(
                    validation, "reports", "instance_launch_hygiene", "checks"
                )
                or {},
                "secret_fields_embedded": _check(
                    validation,
                    "reports",
                    "instance_launch_hygiene",
                    "secret_fields_embedded",
                )
                or [],
            },
        },
    }
    backend_checks = report["validation_gates"]["backend_comparison"]["checks"]
    joint_checks = report["validation_gates"]["joint_reach_benchmark"]["checks"]
    obstacle_checks = report["validation_gates"]["obstacle_course_benchmark"]["checks"]
    joint_deltas = report["validation_gates"]["joint_reach_benchmark"]["deltas"]
    obstacle_deltas = report["validation_gates"]["obstacle_course_benchmark"]["deltas"]
    joint_observed = report["validation_gates"]["joint_reach_benchmark"][
        "observed_comparisons"
    ]
    joint_enforced = report["validation_gates"]["joint_reach_benchmark"][
        "enforced_delta_gates"
    ]
    obstacle_observed = report["validation_gates"]["obstacle_course_benchmark"][
        "observed_comparisons"
    ]
    obstacle_enforced = report["validation_gates"]["obstacle_course_benchmark"][
        "enforced_delta_gates"
    ]
    obstacle_required = report["validation_gates"]["obstacle_course_benchmark"][
        "required_deltas"
    ]
    joint_required = report["validation_gates"]["joint_reach_benchmark"][
        "required_deltas"
    ]
    if not joint_observed:
        joint_observed = _observed_delta_comparisons(joint_deltas)
        report["validation_gates"]["joint_reach_benchmark"][
            "observed_comparisons"
        ] = joint_observed
    if not obstacle_observed:
        obstacle_observed = _observed_delta_comparisons(obstacle_deltas)
        report["validation_gates"]["obstacle_course_benchmark"][
            "observed_comparisons"
        ] = obstacle_observed
    if not joint_enforced:
        joint_enforced = _enforced_delta_gates(
            joint_observed, joint_required, joint_checks
        )
        report["validation_gates"]["joint_reach_benchmark"][
            "enforced_delta_gates"
        ] = joint_enforced
    if not obstacle_enforced:
        obstacle_enforced = _enforced_delta_gates(
            obstacle_observed, obstacle_required, obstacle_checks
        )
        report["validation_gates"]["obstacle_course_benchmark"][
            "enforced_delta_gates"
        ] = obstacle_enforced
    alberta_checkpoint_gate = report["validation_gates"]["alberta_checkpoint"]
    alberta_checkpoint_checks = alberta_checkpoint_gate["checks"]
    asimov1_alberta_gate = report["validation_gates"]["asimov1_alberta_production"]
    asimov1_alberta_checks = asimov1_alberta_gate["checks"]
    brax_full_run_gate = report["validation_gates"]["brax_full_training_run"]
    brax_checkpoint_gate = report["validation_gates"]["brax_production_checkpoint"]
    training_input_checks = report["validation_gates"]["training_inputs"]["checks"]
    multi_robot_gate = report["validation_gates"]["multi_robot_readiness"]
    multi_robot_video = multi_robot_gate["video_evidence"]
    report["multi_robot_video_manifest"] = _multi_robot_video_summary(multi_robot_video)
    video_gate = report["validation_gates"]["video_review"]
    alberta_e2e = report["alberta_end_to_end_report"]
    alberta_e2e_claim = (
        alberta_e2e.get("claim_support")
        if isinstance(alberta_e2e.get("claim_support"), dict)
        else {}
    )
    production_video_gate = report["validation_gates"]["production_policy_videos"]
    production_video_checks = production_video_gate["checks"]
    curriculum_eval_gate = report["validation_gates"]["curriculum_eval"]
    curriculum_eval_checks = curriculum_eval_gate["checks"]
    stage_status_gate = report["validation_gates"]["stage_status"]
    stage_status_checks = stage_status_gate["checks"]
    stage_status_runner = stage_status_gate["runner"]
    stage_status_stages = stage_status_gate["stages"]
    launch_hygiene_gate = report["validation_gates"]["instance_launch_hygiene"]
    launch_hygiene_checks = launch_hygiene_gate["checks"]
    video_thresholds = (
        video_gate.get("thresholds") if isinstance(video_gate.get("thresholds"), dict) else {}
    )
    video_action = report["video_review"]["action_progress"]
    report["benchmark_delta_evidence"] = {
        "joint_reach": {
            "observed_comparisons": joint_observed,
            "enforced_delta_gates": joint_enforced,
            "required_deltas": report["validation_gates"]["joint_reach_benchmark"][
                "required_deltas"
            ],
        },
        "obstacle_course": {
            "observed_comparisons": obstacle_observed,
            "enforced_delta_gates": obstacle_enforced,
            "required_deltas": obstacle_required,
        },
    }
    report["completion_requirements"] = {
        "finalization_ok": bool(report["finalization_ok"]),
        "finalization_report_matches_current_validation": (
            report["finalization_matches_current_validation"] is True
        ),
        "validation_ok": bool(report["validation_ok"]),
        "stage_status_ok": stage_status_gate.get("ok") is True,
        "runner_status_complete": (
            stage_status_checks.get("runner_status") is True
            and stage_status_runner.get("state") == "complete"
            and stage_status_runner.get("ok") is True
            and stage_status_runner.get("last_stage") == "50_post_train_validation"
        ),
        "stage_status_all_complete": (
            stage_status_checks.get("all_stage_statuses") is True
            and all(stage_status_stages.get(stage) is True for stage in (
                "00_local_preflight",
                "10_nebius_train_alberta",
                "20_nebius_compare_backends",
                "30_nebius_continual_benchmarks",
                "40_nebius_brax_baseline",
                "50_post_train_validation",
            ))
        ),
        "backend_comparison_present": bool(comparison),
        "backend_alberta_vs_ppo_delta_ok": backend_checks.get("alberta_vs_ppo_delta")
        is True,
        "backend_alberta_delta_vs_untrained_ok": backend_checks.get(
            "alberta_delta_vs_untrained"
        )
        is True,
        "backend_ppo_delta_vs_untrained_ok": backend_checks.get(
            "ppo_delta_vs_untrained"
        )
        is True,
        "backend_eval_config_ok": backend_checks.get("eval_config") is True,
        "backend_winner_consistent": backend_checks.get("winner_consistent") is True,
        "backend_eval_rollout_depth_ok": backend_checks.get("eval_rollout_depth")
        is True,
        "joint_reach_benchmark_present": bool(joint_reach),
        "joint_reach_alberta_acc_gte_ppo": (
            joint_observed.get("alberta_acc_gte_ppo")
            if joint_observed
            else joint_checks.get("alberta_acc_gte_ppo")
        )
        is True,
        "joint_reach_alberta_forgetting_lte_ppo": (
            joint_observed.get("alberta_forgetting_lte_ppo")
            if joint_observed
            else joint_checks.get("alberta_forgetting_lte_ppo")
        )
        is True,
        "joint_reach_task_matrix_ok": (
            joint_checks.get("tasks") is True
            and joint_checks.get("matrix_shapes") is True
            and joint_checks.get("result_count") is True
            and joint_checks.get("learner_seed_pairs") is True
            and joint_checks.get("learner_seed_coverage") is True
        ),
        "joint_reach_exact_learner_seed_grid": joint_checks.get(
            "learner_seed_pairs"
        )
        is True,
        "obstacle_course_benchmark_present": bool(obstacle),
        "obstacle_course_observed_alberta_acc_gte_ppo": (
            obstacle_observed.get("alberta_acc_gte_ppo")
            if obstacle_observed
            else obstacle_checks.get("alberta_acc_gte_ppo")
        )
        is True,
        "obstacle_course_alberta_acc_gte_ppo_gate_passed": (
            obstacle_enforced.get("alberta_acc_gte_ppo")
            if obstacle_enforced
            else obstacle_checks.get("alberta_acc_gte_ppo")
        )
        is True,
        "obstacle_course_alberta_forgetting_lte_ppo": (
            obstacle_observed.get("alberta_forgetting_lte_ppo")
            if obstacle_observed
            else obstacle_checks.get("alberta_forgetting_lte_ppo")
        )
        is True,
        "obstacle_course_required_delta_gates_ok": all(
            value is True for value in obstacle_enforced.values()
        )
        if obstacle_enforced
        else (
            obstacle_checks.get("alberta_acc_gte_ppo") is True
            and obstacle_checks.get("alberta_forgetting_lte_ppo") is True
        ),
        "obstacle_course_task_matrix_ok": (
            obstacle_checks.get("tasks") is True
            and obstacle_checks.get("matrix_shapes") is True
            and obstacle_checks.get("result_count") is True
            and obstacle_checks.get("learner_seed_pairs") is True
            and obstacle_checks.get("learner_seed_coverage") is True
        ),
        "obstacle_course_exact_learner_seed_grid": obstacle_checks.get(
            "learner_seed_pairs"
        )
        is True,
        "alberta_checkpoint_ok": alberta_checkpoint_gate.get("ok") is True,
        "alberta_checkpoint_regime_streaming": alberta_checkpoint_checks.get("regime")
        is True,
        "alberta_checkpoint_profile_matches": alberta_checkpoint_checks.get(
            "profile_id"
        )
        is True,
        "alberta_checkpoint_required_tasks": alberta_checkpoint_checks.get(
            "required_tasks"
        )
        is True,
        "alberta_checkpoint_domain_rand": alberta_checkpoint_checks.get("domain_rand")
        is True,
        "alberta_checkpoint_total_steps": alberta_checkpoint_checks.get("total_steps")
        is True,
        "alberta_checkpoint_inference": alberta_checkpoint_checks.get("inference")
        is True,
        "asimov1_alberta_production_ok": asimov1_alberta_gate.get("ok") is True,
        "asimov1_alberta_regime_streaming": asimov1_alberta_gate.get(
            "production_regime"
        )
        == "alberta_streaming",
        "asimov1_alberta_required_tasks": asimov1_alberta_checks.get(
            "required_tasks"
        )
        is True,
        "asimov1_alberta_asset_provenance": (
            asimov1_alberta_checks.get("manifest_mjcf_asset_provenance") is True
            and asimov1_alberta_checks.get("manifest_asset_manifest_provenance")
            is True
        ),
        "asimov1_alberta_inference_check": asimov1_alberta_checks.get(
            "inference_check"
        )
        is True,
        "brax_mjx_baseline_present": bool(brax_manifest),
        "brax_full_training_run_ok": brax_full_run_gate.get("ok") is True,
        "brax_production_checkpoint_ok": brax_checkpoint_gate.get("ok") is True,
        "brax_regime_ppo": brax_manifest.get("regime") == "brax_ppo",
        "brax_profile_matches": brax_manifest.get("profile_id") == "asimov-1",
        "brax_total_steps_present": isinstance(
            brax_manifest.get("total_steps"), int | float
        )
        and _finite_number(brax_manifest.get("total_steps"))
        and float(brax_manifest["total_steps"]) > 0,
        "training_inputs_ok": training_inputs.get("ok") is True,
        "training_inputs_present": training_input_checks.get("present") is True,
        "training_inputs_launch_tasks_cover_requested": training_input_checks.get(
            "launch_tasks_cover_requested"
        )
        is True,
        "training_inputs_no_blockers": training_input_checks.get("no_blockers")
        is True,
        "training_inputs_curriculum_hash": training_input_checks.get(
            "curriculum_hash"
        )
        is True,
        "training_inputs_rl_from_sim_ready": training_input_checks.get(
            "rl_from_sim_ready"
        )
        is True,
        "training_inputs_offline_datasets_not_blocking": training_input_checks.get(
            "offline_datasets_not_blocking_current_plan"
        )
        is True,
        "multi_robot_readiness_ok": multi_robot_gate.get("ok") is True,
        "multi_robot_video_evidence_ok": multi_robot_video.get("ok") is True,
        "multi_robot_combined_videos_required": multi_robot_video.get(
            "require_combined"
        )
        is True,
        "multi_robot_video_commands_match": multi_robot_video.get("commands_match")
        is True,
        "multi_robot_video_combined_recording_match": multi_robot_video.get(
            "combined_recording_match"
        )
        is True,
        "video_review_ok": bool(video_review.get("ok")),
        "alberta_end_to_end_report_present": bool(alberta_end_to_end_report),
        "alberta_end_to_end_report_ok": alberta_e2e.get("ok") is True,
        "alberta_end_to_end_report_video_count_matches": (
            isinstance(alberta_e2e.get("video_count"), int)
            and not isinstance(alberta_e2e.get("video_count"), bool)
            and isinstance(video_review.get("video_count"), int)
            and not isinstance(video_review.get("video_count"), bool)
            and int(alberta_e2e["video_count"]) == int(video_review["video_count"])
        ),
        "alberta_end_to_end_report_video_manifest_consistent": (
            alberta_e2e.get("video_manifest_review_consistent") is True
            and alberta_e2e.get("video_all_manifest_profiles_ok") is True
        ),
        "alberta_end_to_end_report_evidence_consistent": (
            alberta_e2e_claim.get("evidence_consistent") is True
        ),
        "alberta_end_to_end_report_robot_advantage_supported": (
            alberta_e2e_claim.get("alberta_robot_backend_advantage_supported") is True
        ),
        "alberta_end_to_end_report_obstacle_advantage_supported": (
            alberta_e2e_claim.get("alberta_obstacle_advantage_supported") is True
        ),
        "alberta_end_to_end_report_production_claim_supported": (
            alberta_e2e_claim.get("production_claim_supported") is True
        ),
        "video_action_progress_ok": (
            isinstance(video_action.get("reviewed_video_count"), int)
            and not isinstance(video_action.get("reviewed_video_count"), bool)
            and int(video_action["reviewed_video_count"]) > 0
            and _finite_number(video_action.get("min_visual_progress"))
        ),
        "video_min_visual_progress_met": (
            _finite_number(video_action.get("min_visual_progress"))
            and _finite_number(video_thresholds.get("min_visual_progress"))
            and float(video_action["min_visual_progress"])
            >= float(video_thresholds["min_visual_progress"])
        ),
        "video_all_reviewed_ok": (
            isinstance(video_action.get("reviewed_video_count"), int)
            and not isinstance(video_action.get("reviewed_video_count"), bool)
            and isinstance(video_action.get("ok_video_count"), int)
            and not isinstance(video_action.get("ok_video_count"), bool)
            and int(video_action["reviewed_video_count"]) > 0
            and int(video_action["reviewed_video_count"])
            == int(video_action["ok_video_count"])
        ),
        "production_policy_videos_ok": production_video_gate.get("ok") is True,
        "production_policy_videos_checkpoint_bound": (
            production_video_checks.get("checkpoint_exists") is True
            and
            production_video_checks.get("manifest_policy_checkpoint") is True
            and production_video_checks.get("profile_policy_checkpoint") is True
        ),
        "production_policy_videos_checkpoint_exists": (
            production_video_checks.get("checkpoint_exists") is True
        ),
        "production_policy_videos_expected_actions": (
            production_video_checks.get("expected_videos") is True
            and production_video_checks.get("video_sizes") is True
            and production_video_checks.get("expected_telemetry") is True
            and production_video_checks.get("telemetry_sizes") is True
            and production_video_checks.get("combined_video") is True
        ),
        "curriculum_eval_ok": curriculum_eval_gate.get("ok") is True,
        "curriculum_eval_present": curriculum_eval_checks.get("present") is True,
        "curriculum_eval_checkpoint_bound": (
            curriculum_eval_checks.get("checkpoint_bound") is True
        ),
        "curriculum_eval_all_tasks_success": (
            curriculum_eval_checks.get("all_requested_tasks_programmatic_success")
            is True
        ),
        "curriculum_eval_pass_rate": (
            _finite_number(curriculum_eval_gate.get("programmatic_pass_rate"))
            and _finite_number(curriculum_eval_gate.get("min_programmatic_pass_rate"))
            and float(curriculum_eval_gate["programmatic_pass_rate"])
            >= float(curriculum_eval_gate["min_programmatic_pass_rate"])
        ),
        "instance_launch_hygiene_ok": launch_hygiene_gate.get("ok") is True,
        "instance_launch_no_inline_credentials": launch_hygiene_checks.get(
            "no_inline_object_storage_credentials"
        )
        is True,
        "instance_launch_repo_stage_runner": launch_hygiene_checks.get(
            "uses_repo_owned_stage_runner"
        )
        is True,
        "instance_launch_training_s3_uri": launch_hygiene_checks.get(
            "uses_training_s3_uri"
        )
        is True,
        "instance_launch_heartbeat_upload_contract": launch_hygiene_checks.get(
            "has_status_heartbeat_upload_contract"
        )
        is True,
        "no_missing_gates": not bool(report["missing_gates"]),
    }
    report["ok"] = all(report["completion_requirements"].values())
    return report


def write_markdown(report: dict[str, Any], path: Path) -> None:
    comp = report["backend_comparison"]
    joint = report["continual_learning"]["joint_reach"]
    obstacle = report["continual_learning"]["obstacle_course"]
    sota = report["sota_baseline"]
    video = report["video_review"]
    smoke_video = report.get("multi_robot_smoke_review", {})
    alberta_e2e = report.get("alberta_end_to_end_report", {})
    multi_robot_video = report.get("multi_robot_video_manifest", {})
    production_video = (
        report.get("validation_gates", {}).get("production_policy_videos", {})
        if isinstance(report.get("validation_gates"), dict)
        else {}
    )
    training_inputs = report.get("training_inputs", {})
    gates = report.get("validation_gates", {})
    matrix = report.get("method_matrix", {})
    obstacle_claim = report.get("obstacle_generalization", {})
    requirements = report.get("completion_requirements", {})
    lines = [
        "# Alberta Robot Training Final Report",
        "",
        f"Run: `{report.get('run_id')}`",
        f"Result: `{'complete' if report.get('ok') else 'not-complete'}`",
        f"Monitor state: `{report.get('monitor_state')}`",
        "",
        "## Alberta vs PPO",
        "",
        "| field | Alberta | PPO |",
        "|---|---:|---:|",
        f"| mean reward | `{_fmt(comp.get('alberta_mean_reward'))}` | `{_fmt(comp.get('ppo_mean_reward'))}` |",
        f"| delta vs untrained | `{_fmt(comp.get('alberta_delta_vs_untrained'))}` | `{_fmt(comp.get('ppo_delta_vs_untrained'))}` |",
        f"| Alberta delta vs PPO | `{_fmt(comp.get('alberta_delta_vs_ppo'))}` |  |",
        f"| winner | `{comp.get('winner_by_mean_reward') or 'missing'}` |  |",
        f"| untrained mean reward | `{_fmt(comp.get('untrained_mean_reward'))}` |  |",
        "",
        "## Method Matrix",
        "",
        "| method | role | artifact present | robot mean reward | obstacle ACC | obstacle forgetting |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for name, item in matrix.items():
        lines.append(
            f"| `{name}` | {item.get('role', 'missing')} | "
            f"`{bool(item.get('artifact_present'))}` | "
            f"`{_fmt(item.get('robot_mean_reward'))}` | "
            f"`{_fmt(item.get('obstacle_course_acc'))}` | "
            f"`{_fmt(item.get('obstacle_course_forgetting'))}` |"
        )
    lines += [
        "",
        "## Continual Learning",
        "",
        "| environment | Alberta ACC | Alberta forgetting | PPO ACC | PPO forgetting |",
        "|---|---:|---:|---:|---:|",
        f"| joint reach | `{_fmt(joint.get('alberta_acc'))}` | `{_fmt(joint.get('alberta_forgetting'))}` | `{_fmt(joint.get('ppo_acc'))}` | `{_fmt(joint.get('ppo_forgetting'))}` |",
        f"| obstacle course | `{_fmt(obstacle.get('alberta_acc'))}` | `{_fmt(obstacle.get('alberta_forgetting'))}` | `{_fmt(obstacle.get('ppo_acc'))}` | `{_fmt(obstacle.get('ppo_forgetting'))}` |",
        "",
        "## Obstacle Generalization And Forgetting",
        "",
        f"Obstacle benchmark present: `{obstacle_claim.get('present')}`",
        f"Alberta ACC delta vs PPO: `{_fmt(obstacle_claim.get('alberta_acc_delta_vs_ppo'))}`",
        "Alberta forgetting delta vs PPO: "
        f"`{_fmt(obstacle_claim.get('alberta_forgetting_delta_vs_ppo'))}`",
        "Alberta no catastrophic forgetting observed: "
        f"`{obstacle_claim.get('alberta_no_catastrophic_forgetting_observed')}`",
        "Alberta forgetting not worse than PPO: "
        f"`{obstacle_claim.get('alberta_forgetting_not_worse_than_ppo')}`",
        "",
        "## SOTA-Style Baseline",
        "",
        f"Brax/MJX present: `{sota.get('brax_mjx_present')}`",
        f"Regime: `{sota.get('regime') or 'missing'}`",
        f"Steps: `{_fmt(sota.get('total_steps'))}`",
        "",
        "## Video Evidence",
        "",
        f"Video review present: `{video.get('present')}`",
        f"Video review ok: `{video.get('ok')}`",
        f"Video count: `{_fmt(video.get('video_count'))}`",
        "Reviewed profiles: "
        f"`{', '.join(video.get('action_progress', {}).get('profiles') or []) or 'missing'}`",
        "OK reviewed videos: "
        f"`{_fmt(video.get('action_progress', {}).get('ok_video_count'))}`",
        "Minimum visual progress: "
        f"`{_fmt(video.get('action_progress', {}).get('min_visual_progress'))}`",
        "Mean visual progress: "
        f"`{_fmt(video.get('action_progress', {}).get('mean_visual_progress'))}`",
        "Mean frame delta: "
        f"`{_fmt(video.get('action_progress', {}).get('mean_frame_delta'))}`",
        f"Production policy video gate ok: `{production_video.get('ok')}`",
        f"Production video checkpoint: `{production_video.get('checkpoint') or 'missing'}`",
        "",
        "## Multi-Robot Smoke Video Evidence",
        "",
        f"Smoke review present: `{smoke_video.get('present')}`",
        f"Smoke review ok: `{smoke_video.get('ok')}`",
        f"Smoke video count: `{_fmt(smoke_video.get('video_count'))}`",
        "Smoke reviewed profiles: "
        f"`{', '.join(smoke_video.get('action_progress', {}).get('profiles') or []) or 'missing'}`",
        "Smoke OK reviewed videos: "
        f"`{_fmt(smoke_video.get('action_progress', {}).get('ok_video_count'))}`",
        "",
        "## Alberta End-to-End Evidence Bundle",
        "",
        f"Report present: `{alberta_e2e.get('present')}`",
        f"Report ok: `{alberta_e2e.get('ok')}`",
        f"Report production complete: `{alberta_e2e.get('production_complete')}`",
        f"Report production blocker: `{alberta_e2e.get('production_blocker') or 'none'}`",
        f"Report video count: `{_fmt(alberta_e2e.get('video_count'))}`",
        f"Report profiles: `{', '.join(alberta_e2e.get('profiles') or []) or 'missing'}`",
        f"Report backend winner: `{alberta_e2e.get('backend_winner') or 'missing'}`",
        f"Report obstacle ACC delta: `{_fmt(alberta_e2e.get('obstacle_acc_delta'))}`",
        "Report obstacle forgetting delta: "
        f"`{_fmt(alberta_e2e.get('obstacle_forgetting_delta'))}`",
        "",
        "## Multi-Robot Video Manifest",
        "",
        f"Manifest ok: `{multi_robot_video.get('ok')}`",
        f"Require combined videos: `{multi_robot_video.get('require_combined')}`",
        "Profiles with complete video evidence: "
        f"`{_fmt(multi_robot_video.get('ok_profile_count'))}` / "
        f"`{_fmt(multi_robot_video.get('profile_count'))}`",
        "",
        "| profile | ok | present | expected | combined | missing | too small |",
        "|---|---:|---:|---:|---:|---|---|",
    ]
    for item in multi_robot_video.get("profiles") or []:
        if not isinstance(item, dict):
            continue
        lines.append(
            f"| `{item.get('profile') or 'missing'}` | `{item.get('ok')}` | "
            f"`{_fmt(item.get('present_count'))}` | "
            f"`{_fmt(item.get('expected_count'))}` | "
            f"`{item.get('combined_present')}` | "
            f"`{', '.join(map(str, item.get('missing') or [])) or 'none'}` | "
            f"`{', '.join(map(str, item.get('too_small') or [])) or 'none'}` |"
        )
    lines += [
        "",
        "## Training Inputs And Text Conditioning",
        "",
        f"Training-input report present: `{training_inputs.get('present')}`",
        f"Training-input report ok: `{training_inputs.get('ok')}`",
        f"Launch tasks: `{', '.join(training_inputs.get('launch_tasks') or []) or 'missing'}`",
        f"Curriculum SHA256: `{training_inputs.get('curriculum_sha256') or 'missing'}`",
        "Offline datasets present: "
        f"`{training_inputs.get('offline_datasets_present')}`",
        "RL-from-sim ready: "
        f"`{training_inputs.get('rl_from_sim_ready')}`",
        "Imitation training ready: "
        f"`{training_inputs.get('imitation_training_ready')}`",
        "Offline datasets block current plan: "
        f"`{training_inputs.get('offline_datasets_block_current_plan')}`",
        "Warnings: "
        f"`{', '.join(training_inputs.get('warning_kinds') or []) or 'none'}`",
        "",
        "## Validation Gate Details",
        "",
        "| gate | ok | key checks |",
        "|---|---:|---|",
    ]
    gate_rows = (
        ("training_inputs", "present, launch_tasks_cover_requested, no_blockers"),
        ("stage_status", "runner_status complete, every stage status complete"),
        ("multi_robot_readiness", "profiles, per-action videos, combined videos"),
        ("backend_comparison", "alberta_vs_ppo_delta, winner_consistent"),
        (
            "joint_reach_benchmark",
            "observed ACC/forgetting deltas, enforced delta gates, learner_seed_pairs",
        ),
        (
            "obstacle_course_benchmark",
            "observed ACC/forgetting deltas, required delta gates, learner_seed_pairs",
        ),
        ("alberta_checkpoint", "regime, profile, tasks, domain_rand, inference"),
        (
            "asimov1_alberta_production",
            "production_regime, required_tasks, provenance, inference_check",
        ),
        ("brax_full_training_run", "training run contract"),
        ("brax_production_checkpoint", "policy artifact, inference_check"),
        ("video_review", "action_progress, min_visual_progress"),
        ("production_policy_videos", "checkpoint-bound manifest, expected actions"),
        ("curriculum_eval", "checkpoint-bound per-task programmatic success"),
        (
            "instance_launch_hygiene",
            "no inline credentials, repo stage runner, heartbeat uploads",
        ),
    )
    for name, key_checks in gate_rows:
        item = gates.get(name) if isinstance(gates.get(name), dict) else {}
        lines.append(f"| `{name}` | `{item.get('ok')}` | {key_checks} |")
    lines += [
        "",
        "## Completion Requirements",
        "",
        "| requirement | result |",
        "|---|---:|",
    ]
    for name, value in requirements.items():
        lines.append(f"| `{name}` | `{bool(value)}` |")
    missing = report.get("missing_gates") or []
    if missing:
        lines += [
            "",
            "## Missing Production Gates",
            "",
            *[f"- `{gate}`" for gate in missing],
        ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run_root",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "nebius_full_training"
        / "synced_run",
    )
    args = parser.parse_args(argv)
    report = generate_nebius_training_report(args.run_root)
    json_path = args.run_root / "training_comparison_report.json"
    md_path = args.run_root / "training_comparison_report.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, md_path)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
