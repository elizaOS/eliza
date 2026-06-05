#!/usr/bin/env python3
"""Strictly audit the Alberta robot-training objective against current evidence."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.validate_alberta_vendoring import validate_alberta_vendoring


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _check(data: dict[str, Any], *keys: str) -> Any:
    cur: Any = data
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _requirement(
    name: str,
    *,
    ok: bool,
    evidence: dict[str, Any],
    blockers: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "ok": bool(ok),
        "evidence": evidence,
        "blockers": blockers or [],
    }


def _discover_local_backend_comparisons(package_root: Path) -> list[dict[str, Any]]:
    comparisons: list[dict[str, Any]] = []
    for root in (
        package_root / "evidence" / "backend_compare_local",
        package_root / "evidence" / "backend_compare",
    ):
        if not root.is_dir():
            continue
        for path in sorted(item for item in root.iterdir() if item.is_dir()):
            validation = _load_json(path / "validation_report.json")
            comparison = _load_json(path / "comparison.json")
            if not validation and not comparison:
                continue
            comparisons.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "ok": validation.get("ok"),
                    "profile_id": comparison.get("profile_id"),
                    "steps": comparison.get("steps"),
                    "winner_by_mean_reward": comparison.get("winner_by_mean_reward"),
                    "alberta_minus_ppo_mean_reward": _check(
                        validation,
                        "deltas",
                        "alberta_minus_ppo_mean_reward",
                    )
                    if _check(validation, "deltas", "alberta_minus_ppo_mean_reward") is not None
                    else _check(
                        comparison,
                        "alberta_vs_ppo_delta",
                        "mean_reward_overall",
                    ),
                    "has_delta": _check(validation, "checks", "alberta_vs_ppo_delta") is True,
                    "winner_consistent": _check(validation, "checks", "winner_consistent") is True,
                    "eval_rollout_depth": _check(validation, "checks", "eval_rollout_depth"),
                    "survival": validation.get("survival"),
                }
            )
    return comparisons


def audit_alberta_objective_completion(
    *,
    package_root: Path,
    nebius_run_root: Path,
) -> dict[str, Any]:
    package_root = package_root.resolve()
    nebius_run_root = nebius_run_root.resolve()
    training_report = _load_json(nebius_run_root / "training_comparison_report.json")
    validation = _load_json(nebius_run_root / "validation_report.json")
    closeout = _load_json(nebius_run_root / "closeout_status.json")
    finalization = _load_json(nebius_run_root / "finalization_report.json")
    inventory = _load_json(nebius_run_root / "artifact_inventory.json")
    relaunch = _load_json(nebius_run_root / "relaunch_plan.json")
    clean_launch_prepared = _load_json(
        package_root / "evidence" / "nebius_full_training" / "clean_launch_prepared.json"
    )
    clean_launch_status = _load_json(
        package_root / "evidence" / "nebius_full_training" / "clean_launch_status.json"
    )
    local_video = _load_json(package_root / "evidence" / "video_review" / "video_review.json")
    local_manifest = _load_json(package_root / "evidence" / "agent_videos" / "manifest.json")
    checkpoint_video_validation = _load_json(
        package_root / "evidence" / "alberta_checkpoint_video_review" / "validation_report.json"
    )
    checkpoint_video_review = _load_json(
        package_root / "evidence" / "alberta_checkpoint_video_review" / "video_review.json"
    )
    preflight = _load_json(
        package_root / "evidence" / "full_training_preflight" / "preflight_report.json"
    )
    brax_contract = _load_json(
        package_root / "evidence" / "brax_mjx_contract_artifact" / "validation_report.json"
    )
    sac_obstacle = _load_json(
        package_root / "evidence" / "alberta_obstacle_course_sac_smoke" / "validation_report.json"
    )
    local_readiness = _load_json(
        package_root / "evidence" / "full_training_preflight" / "multi_robot_readiness.json"
    )
    local_backend = _load_json(
        package_root / "evidence" / "backend_compare_smoke" / "validation_report.json"
    )
    local_backend_profile = _load_json(
        package_root
        / "evidence"
        / "backend_compare_local"
        / "asimov-1-profile-4k"
        / "validation_report.json"
    )
    local_backend_comparisons = _discover_local_backend_comparisons(package_root)
    local_ok_backend_comparisons = [
        item for item in local_backend_comparisons if item.get("ok") is True
    ]
    local_backend_profiles = sorted(
        {
            str(item.get("profile_id"))
            for item in local_ok_backend_comparisons
            if item.get("profile_id")
        }
    )
    local_backend_side_by_side_ok = any(
        item.get("has_delta") is True and item.get("winner_consistent") is True
        for item in local_ok_backend_comparisons
    )
    checkpoint_video_reports = (
        checkpoint_video_validation.get("video_reports")
        if isinstance(checkpoint_video_validation.get("video_reports"), list)
        else []
    )
    checkpoint_video_policy_sources_ok = bool(checkpoint_video_reports) and all(
        isinstance(item, dict) and item.get("policy_source_ok") is True
        for item in checkpoint_video_reports
    )
    checkpoint_bound_local_videos_ok = (
        checkpoint_video_validation.get("ok") is True
        and _check(checkpoint_video_validation, "checks", "videos") is True
        and _check(checkpoint_video_validation, "checks", "review") is True
        and checkpoint_video_policy_sources_ok
        and checkpoint_video_review.get("ok") is True
        and checkpoint_video_review.get("all_videos_reviewed_good") is True
    )
    production_policy_videos_ok = (
        _check(training_report, "completion_requirements", "production_policy_videos_ok")
        is True
        and _check(training_report, "completion_requirements", "video_all_reviewed_ok")
        is True
        and _check(training_report, "completion_requirements", "video_min_visual_progress_met")
        is True
    )
    production_curriculum_eval_failed_checks = [
        name
        for name, ok in {
            "training_report_curriculum_eval_ok": _check(
                training_report,
                "completion_requirements",
                "curriculum_eval_ok",
            )
            is True,
            "training_report_curriculum_eval_present": _check(
                training_report,
                "completion_requirements",
                "curriculum_eval_present",
            )
            is True,
            "training_report_curriculum_eval_checkpoint_bound": _check(
                training_report,
                "completion_requirements",
                "curriculum_eval_checkpoint_bound",
            )
            is True,
            "training_report_curriculum_eval_all_tasks_success": _check(
                training_report,
                "completion_requirements",
                "curriculum_eval_all_tasks_success",
            )
            is True,
            "training_report_curriculum_eval_pass_rate": _check(
                training_report,
                "completion_requirements",
                "curriculum_eval_pass_rate",
            )
            is True,
            "validation_curriculum_eval_ok": _check(
                validation,
                "reports",
                "curriculum_eval",
                "ok",
            )
            is True,
            "validation_curriculum_eval_native_ok": _check(
                validation,
                "reports",
                "curriculum_eval_native",
                "ok",
            )
            is True,
        }.items()
        if ok is not True
    ]
    production_curriculum_eval_ok = (
        _check(training_report, "completion_requirements", "curriculum_eval_ok")
        is True
        and _check(training_report, "completion_requirements", "curriculum_eval_present")
        is True
        and _check(
            training_report,
            "completion_requirements",
            "curriculum_eval_checkpoint_bound",
        )
        is True
        and _check(
            training_report,
            "completion_requirements",
            "curriculum_eval_all_tasks_success",
        )
        is True
        and _check(training_report, "completion_requirements", "curriculum_eval_pass_rate")
        is True
        and _check(validation, "reports", "curriculum_eval", "ok") is True
        and _check(validation, "reports", "curriculum_eval_native", "ok") is True
    )
    obstacle_smoke = _load_json(
        package_root / "evidence" / "alberta_obstacle_course_smoke" / "validation_report.json"
    )
    obstacle_local_4task = _load_json(
        package_root
        / "evidence"
        / "alberta_obstacle_course_local_4task"
        / "validation_report.json"
    )
    vendoring = validate_alberta_vendoring()
    requirements = [
        _requirement(
            "alberta_framework_integrated",
            ok=vendoring.get("ok") is True
            and (
                _check(validation, "reports", "multi_robot_readiness", "alberta", "ok")
                is True
                or _check(local_readiness, "alberta", "ok") is True
            ),
            evidence={
                "vendoring_ok": vendoring.get("ok"),
                "vendored_commit": vendoring.get("vendored_commit"),
                "local_multi_robot_alberta_ok": _check(
                    local_readiness,
                    "alberta",
                    "ok",
                ),
                "multi_robot_alberta_ok": _check(
                    validation,
                    "reports",
                    "multi_robot_readiness",
                    "alberta",
                    "ok",
                ),
            },
            blockers=[] if vendoring.get("ok") else ["alberta vendoring check failed"],
        ),
        _requirement(
            "unified_robot_interface_all_profiles",
            ok=(
                _check(validation, "reports", "multi_robot_readiness", "ok") is True
                or local_readiness.get("ok") is True
            ),
            evidence={
                "local_multi_robot_readiness_ok": local_readiness.get("ok"),
                "production_multi_robot_readiness_ok": _check(
                    validation,
                    "reports",
                    "multi_robot_readiness",
                    "ok",
                ),
                "profiles": sorted(
                    (
                        local_readiness.get("profiles")
                        or _check(validation, "reports", "multi_robot_readiness", "profiles")
                        or {}
                    ).keys()
                ),
                "zero_action_survival_ok": {
                    profile_id: check.get("zero_action_survival_ok")
                    for profile_id, check in (
                        local_readiness.get("profiles") or {}
                    ).items()
                    if isinstance(check, dict)
                },
                "local_default_profiles": preflight.get("default_profiles"),
                "local_video_profiles": [
                    item.get("profile")
                    for item in local_manifest.get("profiles", [])
                    if isinstance(item, dict)
                ],
            },
            blockers=[]
            if (
                _check(validation, "reports", "multi_robot_readiness", "ok") is True
                or local_readiness.get("ok") is True
            )
            else ["production multi_robot_readiness gate is not green"],
        ),
        _requirement(
            "traditional_and_sota_baselines_available",
            ok=(
                (
                    _check(training_report, "completion_requirements", "brax_full_training_run_ok")
                    is True
                    and _check(
                        training_report,
                        "completion_requirements",
                        "brax_production_checkpoint_ok",
                    )
                    is True
                    and _check(training_report, "completion_requirements", "backend_eval_config_ok")
                    is True
                )
                or (
                    (local_backend.get("ok") is True or bool(local_ok_backend_comparisons))
                    and local_backend_side_by_side_ok
                    and _check(preflight, "brax_validation", "ok") is True
                    and brax_contract.get("ok") is True
                    and brax_contract.get("contract_only") is True
                )
            ),
            evidence={
                "local_backend_smoke_ok": local_backend.get("ok"),
                "local_profile_backend_ok": local_backend_profile.get("ok"),
                "local_profile_backend_steps": local_backend_profile.get("steps"),
                "local_backend_comparison_count": len(local_backend_comparisons),
                "local_backend_comparison_ok_count": len(local_ok_backend_comparisons),
                "local_backend_comparison_profiles": local_backend_profiles,
                "local_profile_backend_eval_rollout_depth": _check(
                    local_backend_profile,
                    "checks",
                    "eval_rollout_depth",
                ),
                "stable_baselines3_sac_ok": sac_obstacle.get("ok"),
                "preflight_brax_validation_ok": _check(preflight, "brax_validation", "ok"),
                "brax_contract_artifact_ok": brax_contract.get("ok"),
                "brax_contract_only": brax_contract.get("contract_only"),
                "brax_contract_production_training": brax_contract.get("production_training"),
                "brax_contract_regime": _check(brax_contract, "manifest", "regime"),
                "brax_contract_profile_id": _check(brax_contract, "manifest", "profile_id"),
                "brax_full_training_run_ok": _check(
                    training_report,
                    "completion_requirements",
                    "brax_full_training_run_ok",
                ),
                "brax_production_checkpoint_ok": _check(
                    training_report,
                    "completion_requirements",
                    "brax_production_checkpoint_ok",
                ),
                "backend_eval_config_ok": _check(
                    training_report,
                    "completion_requirements",
                    "backend_eval_config_ok",
                ),
            },
            blockers=[]
            if (
                (local_backend.get("ok") is True or bool(local_ok_backend_comparisons))
                and local_backend_side_by_side_ok
                and _check(preflight, "brax_validation", "ok") is True
                and brax_contract.get("ok") is True
            )
            else ["production PPO/Brax/SOTA baseline artifacts are not fully present"],
        ),
        _requirement(
            "alberta_vs_ppo_side_by_side_comparison",
            ok=(
                (
                    _check(
                        training_report,
                        "completion_requirements",
                        "backend_alberta_vs_ppo_delta_ok",
                    )
                    is True
                    and _check(
                        training_report,
                        "completion_requirements",
                        "backend_winner_consistent",
                    )
                    is True
                )
                or (
                    local_backend_side_by_side_ok
                )
            ),
            evidence={
                "training_report_ok": training_report.get("ok"),
                "local_backend_smoke_ok": local_backend.get("ok"),
                "local_profile_backend_ok": local_backend_profile.get("ok"),
                "local_backend_comparison_count": len(local_backend_comparisons),
                "local_backend_comparison_ok_count": len(local_ok_backend_comparisons),
                "local_backend_comparison_profiles": local_backend_profiles,
                "local_backend_comparisons": local_backend_comparisons,
                "local_profile_backend_winner": local_backend_profile.get("winner_by_mean_reward"),
                "local_profile_backend_alberta_minus_ppo": _check(
                    local_backend_profile,
                    "deltas",
                    "alberta_minus_ppo_mean_reward",
                ),
                "alberta_delta_vs_ppo": _check(
                    training_report,
                    "backend_comparison",
                    "alberta_delta_vs_ppo",
                ),
                "winner_by_mean_reward": _check(
                    training_report,
                    "backend_comparison",
                    "winner_by_mean_reward",
                ),
            },
            blockers=[]
            if local_backend_side_by_side_ok
            else ["production Alberta-vs-PPO comparison is missing or invalid"],
        ),
        _requirement(
            "continual_learning_obstacle_demo_no_forgetting",
            ok=(
                (
                    _check(
                        training_report,
                        "completion_requirements",
                        "obstacle_course_observed_alberta_acc_gte_ppo",
                    )
                    is True
                    and _check(
                        training_report,
                        "completion_requirements",
                        "obstacle_course_alberta_forgetting_lte_ppo",
                    )
                    is True
                )
                or (
                    obstacle_local_4task.get("ok") is True
                    and _check(
                        obstacle_local_4task,
                        "observed_comparisons",
                        "alberta_acc_gte_ppo",
                    )
                    is True
                    and _check(obstacle_local_4task, "checks", "alberta_forgetting_lte_ppo")
                    is True
                    and _check(obstacle_local_4task, "checks", "demo_video") is True
                    and int(_check(obstacle_local_4task, "config", "n_tasks") or 0) >= 4
                )
            ),
            evidence={
                "obstacle_smoke_ok": obstacle_smoke.get("ok"),
                "local_4task_obstacle_ok": obstacle_local_4task.get("ok"),
                "local_4task_obstacle_tasks": _check(
                    obstacle_local_4task,
                    "config",
                    "n_tasks",
                ),
                "local_4task_alberta_acc_delta_vs_ppo": _check(
                    obstacle_local_4task,
                    "deltas",
                    "alberta_acc_minus_ppo",
                ),
                "local_4task_alberta_forgetting_delta_vs_ppo": _check(
                    obstacle_local_4task,
                    "deltas",
                    "alberta_forgetting_minus_ppo",
                ),
                "local_4task_demo_video": _check(
                    obstacle_local_4task,
                    "checks",
                    "demo_video",
                ),
                "local_4task_demo_json": _check(
                    obstacle_local_4task,
                    "checks",
                    "demo_json",
                ),
                "production_obstacle_present": _check(
                    training_report,
                    "continual_learning",
                    "obstacle_course",
                    "present",
                ),
                "alberta_acc_delta_vs_ppo": _check(
                    training_report,
                    "continual_learning",
                    "obstacle_course",
                    "alberta_acc_delta_vs_ppo",
                ),
                "alberta_forgetting_delta_vs_ppo": _check(
                    training_report,
                    "continual_learning",
                    "obstacle_course",
                    "alberta_forgetting_delta_vs_ppo",
                ),
            },
            blockers=[]
            if obstacle_local_4task.get("ok") is True
            else ["production obstacle-course continual benchmark is not fully proved"],
        ),
        _requirement(
            "checkpoint_bound_local_policy_videos_reviewed",
            ok=checkpoint_bound_local_videos_ok or production_policy_videos_ok,
            evidence={
                "checkpoint_video_validation_ok": checkpoint_video_validation.get("ok"),
                "checkpoint_video_review_ok": checkpoint_video_review.get("ok"),
                "checkpoint_video_count": checkpoint_video_review.get("video_count"),
                "checkpoint_profiles": checkpoint_video_validation.get("profiles"),
                "checkpoint_commands": checkpoint_video_validation.get("commands"),
                "all_videos_reviewed_good": checkpoint_video_review.get(
                    "all_videos_reviewed_good"
                ),
                "telemetry_present_count": _check(
                    checkpoint_video_review,
                    "telemetry",
                    "present_count",
                ),
                "telemetry_failed_count": _check(
                    checkpoint_video_review,
                    "telemetry",
                    "failed_count",
                ),
                "policy_source_ok_count": sum(
                    1
                    for item in checkpoint_video_reports
                    if isinstance(item, dict) and item.get("policy_source_ok") is True
                ),
                "expected_video_count": checkpoint_video_validation.get("expected_video_count"),
                "production_policy_videos_ok": production_policy_videos_ok,
            },
            blockers=[]
            if checkpoint_bound_local_videos_ok or production_policy_videos_ok
            else ["checkpoint-bound local Alberta videos are missing or not reviewed"],
        ),
        _requirement(
            "production_robot_policy_videos_reviewed",
            ok=production_policy_videos_ok,
            evidence={
                "local_video_ok": local_video.get("ok"),
                "local_video_count": local_video.get("video_count"),
                "local_all_videos_reviewed_good": local_video.get(
                    "all_videos_reviewed_good"
                ),
                "local_failed_frame_reviews": len(
                    [
                        video
                        for video in local_video.get("videos", [])
                        if isinstance(video, dict) and video.get("ok") is False
                    ]
                )
                if isinstance(local_video.get("videos"), list)
                else None,
                "production_video_review_ok": _check(training_report, "video_review", "ok"),
                "production_video_count": _check(training_report, "video_review", "video_count"),
                "production_policy_videos_ok": _check(
                    training_report,
                    "completion_requirements",
                    "production_policy_videos_ok",
                ),
                "checkpoint_bound_local_policy_videos_ok": checkpoint_bound_local_videos_ok,
            },
            blockers=[
                "production trained-policy videos do not pass semantic telemetry and video review"
            ],
        ),
        _requirement(
            "production_curriculum_eval_passed",
            ok=production_curriculum_eval_ok,
            evidence={
                "training_report_curriculum_eval_ok": _check(
                    training_report,
                    "completion_requirements",
                    "curriculum_eval_ok",
                ),
                "training_report_curriculum_eval_present": _check(
                    training_report,
                    "completion_requirements",
                    "curriculum_eval_present",
                ),
                "training_report_curriculum_eval_checkpoint_bound": _check(
                    training_report,
                    "completion_requirements",
                    "curriculum_eval_checkpoint_bound",
                ),
                "training_report_curriculum_eval_all_tasks_success": _check(
                    training_report,
                    "completion_requirements",
                    "curriculum_eval_all_tasks_success",
                ),
                "training_report_curriculum_eval_pass_rate": _check(
                    training_report,
                    "completion_requirements",
                    "curriculum_eval_pass_rate",
                ),
                "validation_curriculum_eval_ok": _check(
                    validation,
                    "reports",
                    "curriculum_eval",
                    "ok",
                ),
                "validation_curriculum_eval_native_ok": _check(
                    validation,
                    "reports",
                    "curriculum_eval_native",
                    "ok",
                ),
                "programmatic_pass_rate": _check(
                    validation,
                    "reports",
                    "curriculum_eval",
                    "programmatic_pass_rate",
                ),
                "task_checks": _check(
                    validation,
                    "reports",
                    "curriculum_eval",
                    "task_checks",
                ),
                "failed_check": production_curriculum_eval_failed_checks[0]
                if production_curriculum_eval_failed_checks
                else None,
                "failed_checks": production_curriculum_eval_failed_checks,
            },
            blockers=[]
            if production_curriculum_eval_ok
            else [
                "native curriculum eval and checkpoint-bound curriculum report must both pass"
            ],
        ),
        _requirement(
            "nebius_production_training_complete",
            ok=(
                finalization.get("ok") is True
                and inventory.get("ok") is True
                and validation.get("ok") is True
                and training_report.get("ok") is True
            ),
            evidence={
                "closeout_ok": closeout.get("ok"),
                "closeout_state": closeout.get("state"),
                "finalization_ok": finalization.get("ok"),
                "inventory_present": inventory.get("present_count"),
                "inventory_required": inventory.get("required_count"),
                "validation_ok": validation.get("ok"),
                "training_report_ok": training_report.get("ok"),
                "missing_gates": closeout.get("missing_gates"),
            },
            blockers=closeout.get("missing_gates") or ["production closeout is not complete"],
        ),
        _requirement(
            "clean_relaunch_path_ready",
            ok=(
                preflight.get("ok") is True
                and _check(preflight, "launch_template", "hygiene", "ok") is True
            ),
            evidence={
                "preflight_ok": preflight.get("ok"),
                "launch_template_hygiene": _check(preflight, "launch_template", "hygiene", "ok"),
                "relaunch_ready": relaunch.get("relaunch_ready"),
                "relaunch_recommendation": relaunch.get("recommendation"),
                "relaunch_blockers": relaunch.get("blockers"),
                "clean_payload_uploaded": clean_launch_prepared.get("payload_uploaded"),
                "clean_payload_uri": clean_launch_prepared.get("payload_uri"),
                "clean_launch_state": clean_launch_status.get("state"),
                "clean_launch_compute_created": bool(clean_launch_status.get("instance_id")),
                "clean_launch_auth_reason": _check(
                    clean_launch_status,
                    "nebius_auth",
                    "reason",
                ),
            },
            blockers=[]
            if preflight.get("ok") is True
            else ["regenerated safe preflight bundle is not ready"],
        ),
    ]
    passed = [item["name"] for item in requirements if item["ok"]]
    failed = [item["name"] for item in requirements if not item["ok"]]
    report = {
        "schema": "robot-alberta-objective-completion-audit-v1",
        "ok": not failed,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "package_root": str(package_root),
        "nebius_run_root": str(nebius_run_root),
        "passed": passed,
        "failed": failed,
        "requirements": requirements,
    }
    out_json = package_root / "evidence" / "alberta_objective_completion_audit.json"
    out_md = package_root / "evidence" / "alberta_objective_completion_audit.md"
    out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, out_md)
    return report


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Alberta Objective Completion Audit",
        "",
        f"Result: `{'complete' if report.get('ok') else 'not-complete'}`",
        f"Generated: `{report.get('generated_at')}`",
        "",
        "| requirement | ok | blockers |",
        "|---|---:|---|",
    ]
    for item in report.get("requirements", []):
        blockers = ", ".join(item.get("blockers") or [])
        lines.append(
            f"| `{item.get('name')}` | `{item.get('ok')}` | {blockers or 'none'} |"
        )
    clean_relaunch = next(
        (
            item
            for item in report.get("requirements", [])
            if item.get("name") == "clean_relaunch_path_ready"
        ),
        {},
    )
    clean_evidence = clean_relaunch.get("evidence") if isinstance(clean_relaunch, dict) else {}
    if isinstance(clean_evidence, dict) and clean_evidence.get("clean_launch_state"):
        lines += [
            "",
            "## Clean Launch Status",
            "",
            f"State: `{clean_evidence.get('clean_launch_state')}`",
            f"Compute created: `{clean_evidence.get('clean_launch_compute_created')}`",
            f"Auth reason: `{clean_evidence.get('clean_launch_auth_reason') or 'none'}`",
        ]
    lines += [
        "",
        "This audit intentionally treats local smoke evidence as insufficient for "
        "the production objective when the Nebius production artifacts are absent.",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    parser.add_argument(
        "--nebius-run-root",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "nebius_full_training"
        / "synced_run",
    )
    args = parser.parse_args(argv)
    report = audit_alberta_objective_completion(
        package_root=args.package_root,
        nebius_run_root=args.nebius_run_root,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
