"""Generate a current Alberta end-to-end evidence report."""

from __future__ import annotations

import argparse
import json
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


def _get(data: dict[str, Any], *keys: str) -> Any:
    cur: Any = data
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _profile_video_counts(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    profiles = manifest.get("profiles") if isinstance(manifest.get("profiles"), list) else []
    counts: dict[str, dict[str, Any]] = {}
    for item in profiles:
        if not isinstance(item, dict) or not isinstance(item.get("profile"), str):
            continue
        videos = item.get("videos") if isinstance(item.get("videos"), list) else []
        expected = item.get("expected_videos") if isinstance(item.get("expected_videos"), list) else []
        missing = item.get("missing_videos") if isinstance(item.get("missing_videos"), list) else []
        counts[item["profile"]] = {
            "videos": len(videos),
            "expected": len(expected),
            "missing": len(missing),
            "combined_present": item.get("combined_present"),
            "ok": item.get("ok"),
        }
    return counts


def _finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and value == value
        and value not in (float("inf"), float("-inf"))
    )


def _profile_video_count_total(counts: dict[str, dict[str, Any]], key: str) -> int:
    total = 0
    for item in counts.values():
        value = item.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            total += value
    return total


def _all_manifest_profiles_ok(counts: dict[str, dict[str, Any]]) -> bool:
    return bool(counts) and all(
        item.get("ok") is True
        and item.get("missing") == 0
        and item.get("combined_present") is True
        and isinstance(item.get("expected"), int)
        and isinstance(item.get("videos"), int)
        and item["expected"] > 0
        and item["videos"] >= item["expected"]
        for item in counts.values()
    )


def _backend_comparison_summary(backend_dir: Path) -> dict[str, Any]:
    validation = _load_json(backend_dir / "validation_report.json")
    comparison = _load_json(backend_dir / "comparison.json")
    alberta_minus_ppo = _get(
        comparison,
        "alberta_vs_ppo_delta",
        "mean_reward_overall",
    )
    if alberta_minus_ppo is None:
        alberta_minus_ppo = _get(validation, "deltas", "alberta_minus_ppo_mean_reward")
    return {
        "name": backend_dir.name,
        "path": str(backend_dir),
        "ok": validation.get("ok"),
        "profile_id": comparison.get("profile_id"),
        "tasks": comparison.get("tasks"),
        "steps": comparison.get("steps"),
        "winner_by_mean_reward": comparison.get("winner_by_mean_reward"),
        "alberta_minus_ppo_mean_reward": alberta_minus_ppo,
        "alberta_gte_ppo_by_mean_reward": (
            _finite_number(alberta_minus_ppo) and float(alberta_minus_ppo) >= 0.0
        ),
        "baseline_mean_reward": _get(validation, "deltas", "baseline_mean_reward"),
        "alberta_mean_reward": _get(validation, "deltas", "alberta_mean_reward"),
        "ppo_mean_reward": _get(validation, "deltas", "ppo_mean_reward"),
        "alberta_minus_untrained_mean_reward": _get(
            validation,
            "deltas",
            "alberta_minus_untrained_mean_reward",
        ),
        "ppo_minus_untrained_mean_reward": _get(
            validation,
            "deltas",
            "ppo_minus_untrained_mean_reward",
        ),
        "survival": validation.get("survival"),
        "checks": validation.get("checks"),
    }


def _discover_backend_comparisons(package_root: Path, primary_backend_dir: Path) -> list[dict[str, Any]]:
    dirs: list[Path] = []
    for root in (
        package_root / "evidence" / "backend_compare_local",
        package_root / "evidence" / "backend_compare",
    ):
        if root.is_dir():
            dirs.extend(sorted(path for path in root.iterdir() if path.is_dir()))
    if primary_backend_dir.is_dir():
        dirs.append(primary_backend_dir)
    seen: set[Path] = set()
    summaries: list[dict[str, Any]] = []
    for path in dirs:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if (path / "comparison.json").is_file() or (path / "validation_report.json").is_file():
            summaries.append(_backend_comparison_summary(path))
    return summaries


def _sota_baseline_status(package_root: Path) -> dict[str, Any]:
    preflight = _load_json(package_root / "evidence" / "full_training_preflight" / "preflight_report.json")
    brax_manifest = _load_json(
        package_root
        / "evidence"
        / "full_training_preflight"
        / "asimov_1_brax_mjx_baseline"
        / "manifest.json"
    )
    brax_contract = _load_json(
        package_root / "evidence" / "brax_mjx_contract_artifact" / "validation_report.json"
    )
    scripts = preflight.get("scripts") if isinstance(preflight.get("scripts"), dict) else {}
    brax_script_raw = scripts.get("brax_baseline")
    brax_script = Path(str(brax_script_raw)) if brax_script_raw else None
    return {
        "stable_baselines3_ppo": {
            "role": "matched robot-policy baseline",
            "local_comparison_artifact_present": bool(
                list((package_root / "evidence" / "backend_compare_local").glob("*/ppo/manifest.json"))
            ),
        },
        "brax_mjx_ppo": {
            "role": "SOTA-style accelerator PPO baseline",
            "preflight_validation_ok": _get(preflight, "brax_validation", "ok"),
            "script_present": brax_script.is_file() if brax_script is not None else False,
            "script": str(brax_script) if brax_script is not None else None,
            "manifest_present": bool(brax_manifest),
            "regime": brax_manifest.get("regime"),
            "profile_id": brax_manifest.get("profile_id"),
            "total_steps": brax_manifest.get("total_steps"),
            "contract_artifact_present": bool(brax_contract),
            "contract_artifact_ok": brax_contract.get("ok"),
            "contract_only": brax_contract.get("contract_only"),
            "production_training": brax_contract.get("production_training"),
            "contract_regime": _get(brax_contract, "manifest", "regime"),
            "contract_profile_id": _get(brax_contract, "manifest", "profile_id"),
            "contract_steps": _get(brax_contract, "manifest", "total_steps"),
            "contract_checks": brax_contract.get("checks") if isinstance(brax_contract.get("checks"), dict) else {},
        },
    }


def _integration_surfaces_status(package_root: Path) -> dict[str, Any]:
    return _load_json(package_root / "evidence" / "alberta_integration_surfaces.json")


def _training_inputs_status(package_root: Path) -> dict[str, Any]:
    report = _load_json(
        package_root / "evidence" / "full_training_preflight" / "training_inputs_report.json"
    )
    preflight = _load_json(package_root / "evidence" / "full_training_preflight" / "preflight_report.json")
    curriculum = report.get("curriculum") if isinstance(report.get("curriculum"), dict) else {}
    datasets = report.get("datasets") if isinstance(report.get("datasets"), dict) else {}
    tasks = report.get("tasks") if isinstance(report.get("tasks"), list) else []
    profiles = report.get("profiles") if isinstance(report.get("profiles"), list) else []
    launch_tasks = report.get("launch_tasks") if isinstance(report.get("launch_tasks"), list) else []
    supported_launch_tasks = [
        task
        for task in tasks
        if isinstance(task, dict)
        and task.get("in_launch_tasks") is True
        and task.get("supported_by_profile_env") is True
    ]
    ready_profiles = [
        profile.get("profile_id")
        for profile in profiles
        if isinstance(profile, dict) and profile.get("ok") is True
    ]
    blockers = report.get("blockers") if isinstance(report.get("blockers"), list) else []
    warnings = report.get("warnings") if isinstance(report.get("warnings"), list) else []
    return {
        "ok": report.get("ok"),
        "preflight_training_inputs_valid": _get(preflight, "checks", "training_inputs_valid")
        if isinstance(preflight.get("checks"), dict)
        else preflight.get("training_inputs_valid"),
        "launch_tasks": launch_tasks,
        "launch_task_count": len(launch_tasks),
        "supported_launch_task_count": len(supported_launch_tasks),
        "curriculum_version": curriculum.get("version"),
        "curriculum_task_count": curriculum.get("task_count"),
        "curriculum_content_sha256": curriculum.get("content_sha256"),
        "text_variant_collision_count": len(curriculum.get("text_variant_collisions") or []),
        "ready_profiles": ready_profiles,
        "ready_profile_count": len(ready_profiles),
        "rl_from_sim_ready": datasets.get("rl_from_sim_ready"),
        "offline_datasets_present": datasets.get("offline_datasets_present"),
        "imitation_training_ready": datasets.get("imitation_training_ready"),
        "offline_datasets_block_current_plan": datasets.get("offline_datasets_block_current_plan"),
        "training_source": datasets.get("training_source"),
        "trajectory_db_tooling_present": datasets.get("trajectory_db_tooling_present"),
        "blocker_count": len(blockers),
        "warning_kinds": [
            warning.get("kind")
            for warning in warnings
            if isinstance(warning, dict) and isinstance(warning.get("kind"), str)
        ],
    }


def _alberta_checkpoint_validations(package_root: Path) -> dict[str, Any]:
    roots = [
        package_root / "evidence" / "alberta_all_profiles",
        package_root / "evidence" / "backend_compare_local",
        package_root / "evidence" / "backend_compare",
        package_root / "evidence" / "backend_compare_smoke",
    ]
    reports: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        candidates = (
            [root / "alberta_validation_report.json"]
            if root.name == "backend_compare_smoke"
            else sorted(root.glob("*/alberta_validation_report.json"))
        )
        for path in candidates:
            if not path.is_file() or path.resolve() in seen:
                continue
            seen.add(path.resolve())
            report = _load_json(path)
            checks = report.get("checks") if isinstance(report.get("checks"), dict) else {}
            inference = report.get("inference_report") if isinstance(report.get("inference_report"), dict) else {}
            failed_checks = [key for key, value in checks.items() if value is False]
            reports.append(
                {
                    "name": path.parent.name,
                    "path": str(path),
                    "checkpoint": report.get("checkpoint"),
                    "ok": report.get("ok"),
                    "profile_id": report.get("profile_id"),
                    "total_steps": report.get("total_steps"),
                    "requested_total_steps": report.get("requested_total_steps"),
                    "regime_streaming": checks.get("regime"),
                    "profile_matches": checks.get("profile_id"),
                    "required_tasks": checks.get("required_tasks"),
                    "domain_rand": checks.get("domain_rand"),
                    "controller": checks.get("controller"),
                    "history": checks.get("history"),
                    "inference_ok": inference.get("ok"),
                    "inference_result_count": len(inference.get("results") or []),
                    "failed_checks": failed_checks,
                }
            )
    ok_reports = [report for report in reports if report.get("ok") is True]
    profiles = sorted({str(report.get("profile_id")) for report in ok_reports if report.get("profile_id")})
    return {
        "count": len(reports),
        "ok_count": len(ok_reports),
        "profiles": profiles,
        "all_ok": bool(reports) and len(ok_reports) == len(reports),
        "any_inference_ok": any(report.get("inference_ok") is True for report in reports),
        "all_inference_ok": bool(reports) and all(report.get("inference_ok") is True for report in reports),
        "reports": reports,
    }


def _local_validation_status(package_root: Path) -> dict[str, Any]:
    summary_path = package_root / "evidence" / "local_validation" / "alberta_robot_validation_summary.json"
    summary = _load_json(summary_path)
    return {
        "present": bool(summary),
        "path": str(summary_path),
        "ok": summary.get("ok"),
        "tests": summary.get("tests"),
        "passed": summary.get("passed"),
        "failures": summary.get("failures"),
        "errors": summary.get("errors"),
        "skipped": summary.get("skipped"),
        "time_seconds": summary.get("time_seconds"),
        "known_warnings": summary.get("known_warnings"),
        "coverage_scope": summary.get("coverage_scope"),
        "junit_xml": summary.get("junit_xml"),
    }


def _checkpoint_video_status(package_root: Path, ready_profiles: list[str]) -> dict[str, Any]:
    evidence_dir = package_root / "evidence" / "alberta_checkpoint_videos"
    review_path = package_root / "evidence" / "alberta_checkpoint_video_review" / "video_review.json"
    validation_path = package_root / "evidence" / "alberta_checkpoint_video_review" / "validation_report.json"
    manifest_path = evidence_dir / "manifest.json"
    manifest = _load_json(manifest_path)
    review = _load_json(review_path)
    validation = _load_json(validation_path)
    entries = manifest.get("profiles") if isinstance(manifest.get("profiles"), list) else []
    expected_profiles = sorted({profile for profile in ready_profiles if isinstance(profile, str)})
    profile_entries = {
        entry["profile"]: entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("profile"), str)
    }
    missing_profiles = [profile for profile in expected_profiles if profile not in profile_entries]
    checkpoint_mismatches: list[dict[str, str | None]] = []
    profile_summaries: dict[str, dict[str, Any]] = {}
    for profile in expected_profiles:
        entry = profile_entries.get(profile, {})
        checkpoint = entry.get("policy_checkpoint")
        expected_checkpoint = str(
            (package_root / "evidence" / "alberta_all_profiles" / profile / "alberta").resolve()
        )
        if checkpoint != expected_checkpoint:
            checkpoint_mismatches.append(
                {
                    "profile": profile,
                    "expected": expected_checkpoint,
                    "actual": checkpoint if isinstance(checkpoint, str) else None,
                }
            )
        profile_summaries[profile] = {
            "ok": entry.get("ok"),
            "video_count": len(entry.get("videos") or []),
            "telemetry_count": len(entry.get("telemetry") or []),
            "combined_present": entry.get("combined_present"),
            "policy_checkpoint": checkpoint,
        }
    review_profiles = review.get("profiles") if isinstance(review.get("profiles"), list) else []
    review_actions = review.get("actions") if isinstance(review.get("actions"), list) else []
    review_artifacts = _video_review_artifact_summary(
        review,
        package_root=package_root,
        limit=10,
    )
    expected_video_count = len(expected_profiles) * 3
    all_expected_reviewed = (
        sorted(review_profiles) == expected_profiles
        and review.get("video_count") == expected_video_count
        and sorted(review_actions) == ["combined_actions", "stand_up", "walk_forward"]
    )
    ok = bool(
        expected_profiles
        and manifest.get("ok") is True
        and review.get("ok") is True
        and review.get("all_videos_reviewed_good") is True
        and _get(review, "telemetry", "present_count") == expected_video_count
        and _get(review, "telemetry", "ok_count") == expected_video_count
        and _get(review, "telemetry", "failed_count") == 0
        and validation.get("ok") is True
        and not missing_profiles
        and not checkpoint_mismatches
        and all_expected_reviewed
    )
    return {
        "ok": ok,
        "evidence_dir": str(evidence_dir),
        "manifest": str(manifest_path),
        "review": str(review_path),
        "validation": str(validation_path),
        "profile_count": len(expected_profiles),
        "video_count": review.get("video_count"),
        "expected_video_count": expected_video_count,
        "profiles": expected_profiles,
        "actions": review_actions,
        "all_videos_reviewed_good": review.get("all_videos_reviewed_good"),
        "telemetry": review.get("telemetry"),
        "min_visual_progress": review.get("min_visual_progress"),
        "mean_visual_progress": review.get("mean_visual_progress"),
        "review_artifacts": review_artifacts,
        "min_frame_count": min(
            (
                int(video.get("frame_count"))
                for video in review.get("videos", [])
                if isinstance(video, dict) and isinstance(video.get("frame_count"), int)
            ),
            default=None,
        ),
        "profile_summaries": profile_summaries,
        "missing_profiles": missing_profiles,
        "checkpoint_mismatches": checkpoint_mismatches,
        "validation_ok": validation.get("ok"),
        "validation_checks": validation.get("checks"),
        "policy_source_ok_count": sum(
            1
            for item in validation.get("video_reports", [])
            if isinstance(item, dict) and item.get("policy_source_ok") is True
        )
        if isinstance(validation.get("video_reports"), list)
        else 0,
        "task_signal_ok_count": sum(
            1
            for item in validation.get("video_reports", [])
            if isinstance(item, dict) and item.get("task_signal_ok") is True
        )
        if isinstance(validation.get("video_reports"), list)
        else 0,
        "all_expected_reviewed": all_expected_reviewed,
    }


def _failed_video_reviews(video_review: dict[str, Any]) -> list[dict[str, Any]]:
    videos = video_review.get("videos") if isinstance(video_review.get("videos"), list) else []
    failed: list[dict[str, Any]] = []
    for video in videos:
        if not isinstance(video, dict) or video.get("ok") is not False:
            continue
        failed.append(
            {
                "profile": video.get("profile"),
                "action": video.get("action"),
                "video": video.get("video"),
                "verdict": video.get("verdict"),
                "review_notes": video.get("review_notes"),
                "failed_checks": video.get("failed_checks"),
            }
        )
    return failed


def _video_review_artifact_summary(
    video_review: dict[str, Any],
    *,
    package_root: Path,
    limit: int = 8,
) -> dict[str, Any]:
    videos = video_review.get("videos") if isinstance(video_review.get("videos"), list) else []
    rows: list[dict[str, Any]] = []
    contact_sheet_count = 0
    existing_contact_sheet_count = 0
    missing_contact_sheets: list[str] = []
    for video in videos:
        if not isinstance(video, dict):
            continue
        contact_sheet = video.get("contact_sheet")
        has_contact_sheet = isinstance(contact_sheet, str) and bool(contact_sheet)
        contact_sheet_exists = False
        if has_contact_sheet:
            contact_sheet_count += 1
            contact_path = Path(contact_sheet)
            if not contact_path.is_absolute():
                contact_path = package_root / contact_path
            contact_sheet_exists = contact_path.is_file()
            if contact_sheet_exists:
                existing_contact_sheet_count += 1
            else:
                missing_contact_sheets.append(contact_sheet)
        if len(rows) >= limit:
            continue
        rows.append(
            {
                "profile": video.get("profile"),
                "action": video.get("action"),
                "video": video.get("video"),
                "contact_sheet": contact_sheet if has_contact_sheet else None,
                "contact_sheet_exists": contact_sheet_exists,
                "verdict": video.get("verdict"),
                "review_notes": video.get("review_notes"),
                "frame_count": video.get("frame_count"),
                "visual_progress": video.get("visual_progress"),
                "telemetry_ok": _get(video, "telemetry", "ok"),
            }
        )
    return {
        "contact_sheet_count": contact_sheet_count,
        "existing_contact_sheet_count": existing_contact_sheet_count,
        "missing_contact_sheet_count": len(missing_contact_sheets),
        "missing_contact_sheets": missing_contact_sheets[:20],
        "sample_count": len(rows),
        "samples": rows,
    }


def _resolve_artifact_path(package_root: Path, raw_path: Any) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path:
        return None
    path = Path(raw_path)
    return path if path.is_absolute() else package_root / path


def _demo_artifact_summary(package_root: Path, demo: dict[str, Any]) -> dict[str, Any]:
    video_path = _resolve_artifact_path(package_root, demo.get("video"))
    expected_video_bytes = demo.get("video_bytes")
    actual_video_bytes = video_path.stat().st_size if video_path is not None and video_path.is_file() else 0
    contact_sheet = _get(demo, "visual_review", "contact_sheet")
    contact_path = _resolve_artifact_path(package_root, contact_sheet)
    return {
        "video_present": video_path.is_file() if video_path is not None else False,
        "video_bytes_actual": actual_video_bytes,
        "video_bytes_recorded": expected_video_bytes,
        "video_bytes_match": (
            isinstance(expected_video_bytes, int)
            and not isinstance(expected_video_bytes, bool)
            and actual_video_bytes == expected_video_bytes
        ),
        "contact_sheet": contact_sheet,
        "contact_sheet_exists": contact_path.is_file() if contact_path is not None else False,
    }


def _delta(left: Any, right: Any) -> float | None:
    if not (_finite_number(left) and _finite_number(right)):
        return None
    return float(left) - float(right)


def _optional_sac_deltas(
    validation_deltas: Any,
    acc: dict[str, Any],
    forgetting: dict[str, Any],
    adaptation: dict[str, Any],
) -> dict[str, Any]:
    deltas = dict(validation_deltas) if isinstance(validation_deltas, dict) else {}
    deltas["alberta_acc_minus_sac"] = _delta(acc.get("alberta"), acc.get("sac"))
    deltas["alberta_forgetting_minus_sac"] = _delta(
        forgetting.get("alberta"),
        forgetting.get("sac"),
    )
    deltas["alberta_new_task_gain_minus_sac"] = _delta(
        _get(adaptation, "alberta", "mean_new_task_gain"),
        _get(adaptation, "sac", "mean_new_task_gain"),
    )
    deltas["alberta_acc_gte_sac"] = (
        _finite_number(deltas["alberta_acc_minus_sac"])
        and float(deltas["alberta_acc_minus_sac"]) >= 0.0
    )
    deltas["alberta_forgetting_lte_sac"] = (
        _finite_number(deltas["alberta_forgetting_minus_sac"])
        and float(deltas["alberta_forgetting_minus_sac"]) <= 0.0
    )
    deltas["alberta_new_task_gain_gte_sac"] = (
        _finite_number(deltas["alberta_new_task_gain_minus_sac"])
        and float(deltas["alberta_new_task_gain_minus_sac"]) >= 0.0
    )
    deltas["alberta_vs_sac_advantage_supported"] = bool(
        deltas["alberta_acc_gte_sac"]
        and deltas["alberta_forgetting_lte_sac"]
        and deltas["alberta_new_task_gain_gte_sac"]
    )
    return deltas


def _optional_sac_baseline_summary(package_root: Path) -> dict[str, Any]:
    benchmark_dir = package_root / "evidence" / "alberta_obstacle_course_sac_smoke"
    benchmark = _load_json(benchmark_dir / "continual_benchmark.json")
    validation = _load_json(benchmark_dir / "validation_report.json")
    demo = _load_json(benchmark_dir / "obstacle_course_demo.json")
    summary = benchmark.get("summary") if isinstance(benchmark.get("summary"), dict) else {}
    adaptation = _benchmark_adaptation(benchmark)
    learners = _get(benchmark, "config", "learners")
    learners = learners if isinstance(learners, list) else []
    acc = {
        learner: _get(summary, learner, "acc", "mean")
        for learner in learners
        if isinstance(learner, str)
    }
    forgetting = {
        learner: _get(summary, learner, "forgetting", "mean")
        for learner in learners
        if isinstance(learner, str)
    }
    deltas = _optional_sac_deltas(validation.get("deltas"), acc, forgetting, adaptation)
    return {
        "present": bool(benchmark),
        "ok": validation.get("ok"),
        "path": str(benchmark_dir) if benchmark_dir.exists() else None,
        "env_kind": _get(benchmark, "config", "env_kind"),
        "n_tasks": _get(benchmark, "config", "n_tasks"),
        "steps_per_task": _get(benchmark, "config", "steps_per_task"),
        "eval_episodes": _get(benchmark, "config", "eval_episodes"),
        "learners": learners,
        "configured_learners": validation.get("configured_learners"),
        "checks": validation.get("checks"),
        "deltas": deltas,
        "adaptation": adaptation,
        "demo": {
            "present": bool(demo),
            "ok": demo.get("ok"),
            "video": demo.get("video"),
            "video_bytes": demo.get("video_bytes"),
            "frames": demo.get("frames"),
            "learners": demo.get("learners"),
            "visual_review": demo.get("visual_review"),
            "artifacts": _demo_artifact_summary(package_root, demo),
        },
        "acc": acc,
        "forgetting": forgetting,
    }


def _benchmark_adaptation(bundle: dict[str, Any]) -> dict[str, dict[str, float | int]]:
    existing = bundle.get("adaptation")
    if isinstance(existing, dict) and existing:
        return existing
    results = bundle.get("results") if isinstance(bundle.get("results"), list) else []
    by_learner: dict[str, list[dict[str, float | int]]] = {}
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get("name"), str):
            continue
        matrix = result.get("matrix")
        baseline = result.get("baseline")
        if not isinstance(matrix, list) or not isinstance(baseline, list):
            continue
        try:
            rows = [[float(value) for value in row] for row in matrix]
            base = [float(value) for value in baseline]
        except (TypeError, ValueError):
            continue
        n_tasks = len(rows)
        if n_tasks == 0 or len(base) != n_tasks:
            continue
        if any(len(row) != n_tasks for row in rows):
            continue
        diag = [rows[i][i] for i in range(n_tasks)]
        final = rows[-1]
        best = [max(rows[phase][task] for phase in range(n_tasks)) for task in range(n_tasks)]
        new_task_gain = [diag[i] - base[i] for i in range(n_tasks)]
        final_minus_best = [final[i] - best[i] for i in range(n_tasks)]
        by_learner.setdefault(result["name"], []).append(
            {
                "mean_new_task_gain": sum(new_task_gain) / n_tasks,
                "min_new_task_gain": min(new_task_gain),
                "tasks_with_positive_gain": sum(1 for gain in new_task_gain if gain > 0.0),
                "task_count": n_tasks,
                "mean_final_minus_best": sum(final_minus_best) / n_tasks,
                "min_final_minus_best": min(final_minus_best),
                "first_task_retention_delta": rows[-1][0] - rows[0][0],
            }
        )
    summary: dict[str, dict[str, float | int]] = {}
    for learner, rows in by_learner.items():
        keys = (
            "mean_new_task_gain",
            "min_new_task_gain",
            "tasks_with_positive_gain",
            "task_count",
            "mean_final_minus_best",
            "min_final_minus_best",
            "first_task_retention_delta",
        )
        summary[learner] = {
            key: sum(float(row[key]) for row in rows) / len(rows)
            for key in keys
        }
        summary[learner]["seeds"] = len(rows)
    return summary


def _requirement(
    *,
    status: str,
    evidence: dict[str, Any],
    gaps: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "ok": status == "proved",
        "evidence": evidence,
        "gaps": gaps or [],
    }


def _comparison_interpretation(
    *,
    backend_comparisons: list[dict[str, Any]],
    obstacle_validation: dict[str, Any],
    obstacle_adaptation: dict[str, Any],
    optional_sac_baseline: dict[str, Any],
    sota_baselines: dict[str, Any],
) -> dict[str, Any]:
    ok_backend = [item for item in backend_comparisons if item.get("ok") is True]
    alberta_backend_wins = [
        item for item in ok_backend if item.get("alberta_gte_ppo_by_mean_reward") is True
    ]
    ppo_backend_wins = [
        item for item in ok_backend if item.get("alberta_gte_ppo_by_mean_reward") is False
    ]
    obstacle_acc_delta = _get(obstacle_validation, "deltas", "alberta_acc_minus_ppo")
    obstacle_forgetting_delta = _get(
        obstacle_validation,
        "deltas",
        "alberta_forgetting_minus_ppo",
    )
    obstacle_advantage = bool(
        _finite_number(obstacle_acc_delta)
        and float(obstacle_acc_delta) >= 0.0
        and _finite_number(obstacle_forgetting_delta)
        and float(obstacle_forgetting_delta) <= 0.0
    )
    sac_learners = optional_sac_baseline.get("learners")
    sac_learners = sac_learners if isinstance(sac_learners, list) else []
    compared_methods = ["stable-baselines3 PPO"]
    if optional_sac_baseline.get("present"):
        compared_methods.append("stable-baselines3 SAC")
    if _get(sota_baselines, "brax_mjx_ppo", "preflight_validation_ok") is True:
        compared_methods.append("Brax/MJX PPO preflight")
    if _get(sota_baselines, "brax_mjx_ppo", "contract_artifact_ok") is True:
        compared_methods.append("Brax/MJX PPO contract artifact")
    sac_deltas = (
        optional_sac_baseline.get("deltas")
        if isinstance(optional_sac_baseline.get("deltas"), dict)
        else {}
    )
    return {
        "robot_backend_mean_reward": {
            "ok_comparison_count": len(ok_backend),
            "profiles": sorted(
                {str(item.get("profile_id")) for item in ok_backend if item.get("profile_id")}
            ),
            "alberta_gte_ppo_count": len(alberta_backend_wins),
            "ppo_gt_alberta_count": len(ppo_backend_wins),
            "conclusion": (
                "Local robot-backend mean-reward evidence does not show an Alberta advantage over PPO."
                if ppo_backend_wins
                else "Local robot-backend mean-reward evidence shows Alberta at least matching PPO."
            ),
        },
        "continual_obstacle_course": {
            "alberta_acc_minus_ppo": obstacle_acc_delta,
            "alberta_forgetting_minus_ppo": obstacle_forgetting_delta,
            "alberta_new_task_gain": _get(obstacle_adaptation, "alberta", "mean_new_task_gain"),
            "ppo_new_task_gain": _get(obstacle_adaptation, "ppo", "mean_new_task_gain"),
            "alberta_first_task_retention_delta": _get(
                obstacle_adaptation,
                "alberta",
                "first_task_retention_delta",
            ),
            "ppo_first_task_retention_delta": _get(
                obstacle_adaptation,
                "ppo",
                "first_task_retention_delta",
            ),
            "advantage_supported": obstacle_advantage,
            "conclusion": (
                "Continual obstacle-course evidence supports Alberta over PPO on adaptation/retention."
                if obstacle_advantage
                else "Continual obstacle-course evidence does not currently support an Alberta advantage."
            ),
        },
        "sota_methods_compared": {
            "methods": compared_methods,
            "method_count": len(compared_methods),
            "sac_learners": sac_learners,
            "brax_mjx_manifest_present": _get(sota_baselines, "brax_mjx_ppo", "manifest_present"),
            "brax_mjx_contract_artifact_ok": _get(
                sota_baselines,
                "brax_mjx_ppo",
                "contract_artifact_ok",
            ),
            "brax_mjx_contract_only": _get(sota_baselines, "brax_mjx_ppo", "contract_only"),
            "brax_mjx_production_training": _get(
                sota_baselines,
                "brax_mjx_ppo",
                "production_training",
            ),
            "alberta_vs_sac_acc_delta": sac_deltas.get("alberta_acc_minus_sac"),
            "alberta_vs_sac_forgetting_delta": sac_deltas.get(
                "alberta_forgetting_minus_sac"
            ),
            "alberta_vs_sac_new_task_gain_delta": sac_deltas.get(
                "alberta_new_task_gain_minus_sac"
            ),
            "alberta_vs_sac_advantage_supported": sac_deltas.get(
                "alberta_vs_sac_advantage_supported"
            ),
        },
    }


def _objective_requirements(
    *,
    objective_audit: dict[str, Any],
    integration_surfaces: dict[str, Any],
    backend_validation: dict[str, Any],
    backend_comparisons: list[dict[str, Any]],
    sota_baselines: dict[str, Any],
    training_inputs: dict[str, Any],
    checkpoint_validations: dict[str, Any],
    local_validation: dict[str, Any],
    optional_sac_baseline: dict[str, Any],
    obstacle_validation: dict[str, Any],
    obstacle_adaptation: dict[str, Any],
    obstacle_demo: dict[str, Any],
    video_review: dict[str, Any],
    checkpoint_videos: dict[str, Any],
    manifest_review_consistent: bool,
    evidence_consistent: bool,
    production_blocker: str | None,
) -> dict[str, dict[str, Any]]:
    passed = set(objective_audit.get("passed") or [])
    failed = set(objective_audit.get("failed") or [])
    green_backend = [item for item in backend_comparisons if item.get("ok") is True]
    ok_backend_profiles = sorted(
        str(item.get("profile_id")) for item in green_backend if item.get("profile_id")
    )
    sac_demo = optional_sac_baseline.get("demo") if isinstance(optional_sac_baseline.get("demo"), dict) else {}
    sac_adaptation = optional_sac_baseline.get("adaptation")
    sac_adaptation = sac_adaptation if isinstance(sac_adaptation, dict) else {}
    failed_review_count = len(_failed_video_reviews(video_review))
    ready_profiles = {
        str(profile)
        for profile in training_inputs.get("ready_profiles", [])
        if isinstance(profile, str)
    }
    checkpoint_profiles = {
        str(profile)
        for profile in checkpoint_validations.get("profiles", [])
        if isinstance(profile, str)
    }
    all_ready_profiles_have_checkpoint_inference = bool(ready_profiles) and ready_profiles.issubset(
        checkpoint_profiles
    )
    videos_proved = bool(
        video_review.get("ok")
        and video_review.get("all_videos_reviewed_good") is True
        and failed_review_count == 0
        and manifest_review_consistent
    )
    checkpoint_videos_proved = checkpoint_videos.get("ok") is True
    return {
        "alberta_framework_integrated": _requirement(
            status=(
                "proved"
                if "alberta_framework_integrated" in passed
                and integration_surfaces.get("ok") is True
                else "missing"
            ),
            evidence={
                "objective_audit_passed": "alberta_framework_integrated" in passed,
                "backend_validation_ok": backend_validation.get("ok"),
                "integration_surfaces_ok": integration_surfaces.get("ok"),
                "integration_checks": integration_surfaces.get("checks"),
            },
            gaps=(
                []
                if "alberta_framework_integrated" in passed
                and integration_surfaces.get("ok") is True
                else ["objective audit or Alberta integration surface validation is incomplete"]
            ),
        ),
        "unified_robot_interface_all_profiles": _requirement(
            status="proved" if "unified_robot_interface_all_profiles" in passed else "missing",
            evidence={
                "objective_audit_passed": "unified_robot_interface_all_profiles" in passed,
                "video_profiles": video_review.get("profiles"),
                "manifest_review_consistent": manifest_review_consistent,
            },
            gaps=[] if "unified_robot_interface_all_profiles" in passed else ["multi-robot readiness evidence is incomplete"],
        ),
        "traditional_and_sota_baselines": _requirement(
            status="proved" if "traditional_and_sota_baselines_available" in passed else "partial",
            evidence={
                "stable_baselines3_ppo_artifact": _get(
                    sota_baselines,
                    "stable_baselines3_ppo",
                    "local_comparison_artifact_present",
                ),
                "stable_baselines3_sac_artifact": optional_sac_baseline.get("present"),
                "stable_baselines3_sac_ok": optional_sac_baseline.get("ok"),
                "brax_mjx_ppo_preflight_ok": _get(sota_baselines, "brax_mjx_ppo", "preflight_validation_ok"),
                "brax_mjx_ppo_manifest_present": _get(sota_baselines, "brax_mjx_ppo", "manifest_present"),
                "brax_mjx_ppo_contract_artifact_ok": _get(
                    sota_baselines,
                    "brax_mjx_ppo",
                    "contract_artifact_ok",
                ),
                "brax_mjx_ppo_contract_only": _get(sota_baselines, "brax_mjx_ppo", "contract_only"),
                "brax_mjx_ppo_production_training": _get(
                    sota_baselines,
                    "brax_mjx_ppo",
                    "production_training",
                ),
            },
            gaps=(
                []
                if "traditional_and_sota_baselines_available" in passed
                else ["traditional/SOTA baseline availability is not fully proved by objective audit"]
            ),
        ),
        "training_inputs_text_conditioning_and_datasets": _requirement(
            status="proved"
            if (
                training_inputs.get("ok") is True
                and training_inputs.get("rl_from_sim_ready") is True
                and training_inputs.get("offline_datasets_block_current_plan") is False
                and training_inputs.get("text_variant_collision_count") == 0
                and training_inputs.get("blocker_count") == 0
            )
            else "partial",
            evidence={
                "training_inputs_ok": training_inputs.get("ok"),
                "launch_tasks": training_inputs.get("launch_task_count"),
                "supported_launch_tasks": training_inputs.get("supported_launch_task_count"),
                "ready_profiles": training_inputs.get("ready_profile_count"),
                "rl_from_sim_ready": training_inputs.get("rl_from_sim_ready"),
                "offline_datasets_present": training_inputs.get("offline_datasets_present"),
                "offline_datasets_block_current_plan": training_inputs.get("offline_datasets_block_current_plan"),
                "text_variant_collision_count": training_inputs.get("text_variant_collision_count"),
                "curriculum_content_sha256": training_inputs.get("curriculum_content_sha256"),
            },
            gaps=[]
            if (
                training_inputs.get("ok") is True
                and training_inputs.get("rl_from_sim_ready") is True
                and training_inputs.get("offline_datasets_block_current_plan") is False
                and training_inputs.get("text_variant_collision_count") == 0
                and training_inputs.get("blocker_count") == 0
            )
            else ["training input, text-conditioning, or dataset validation is incomplete"],
        ),
        "alberta_checkpoint_inference_contract": _requirement(
            status="proved"
            if (
                checkpoint_validations.get("ok_count", 0) > 0
                and checkpoint_validations.get("all_inference_ok") is True
                and all_ready_profiles_have_checkpoint_inference
            )
            else "partial",
            evidence={
                "checkpoint_validation_count": checkpoint_validations.get("count"),
                "checkpoint_validation_ok_count": checkpoint_validations.get("ok_count"),
                "profiles": checkpoint_validations.get("profiles"),
                "ready_profiles": sorted(ready_profiles),
                "all_ready_profiles_have_checkpoint_inference": all_ready_profiles_have_checkpoint_inference,
                "all_inference_ok": checkpoint_validations.get("all_inference_ok"),
                "any_inference_ok": checkpoint_validations.get("any_inference_ok"),
            },
            gaps=[]
            if (
                checkpoint_validations.get("ok_count", 0) > 0
                and checkpoint_validations.get("all_inference_ok") is True
                and all_ready_profiles_have_checkpoint_inference
            )
            else ["validated Alberta checkpoint inference does not cover every ready profile"],
        ),
        "local_test_validation_suite": _requirement(
            status="proved"
            if (
                local_validation.get("ok") is True
                and isinstance(local_validation.get("tests"), int)
                and local_validation["tests"] > 0
                and local_validation.get("failures") == 0
                and local_validation.get("errors") == 0
            )
            else "partial",
            evidence={
                "tests": local_validation.get("tests"),
                "passed": local_validation.get("passed"),
                "failures": local_validation.get("failures"),
                "errors": local_validation.get("errors"),
                "skipped": local_validation.get("skipped"),
                "junit_xml": local_validation.get("junit_xml"),
            },
            gaps=[]
            if (
                local_validation.get("ok") is True
                and isinstance(local_validation.get("tests"), int)
                and local_validation["tests"] > 0
                and local_validation.get("failures") == 0
                and local_validation.get("errors") == 0
            )
            else ["local validation summary is missing or failing"],
        ),
        "alberta_vs_baselines_side_by_side": _requirement(
            status="proved" if "alberta_vs_ppo_side_by_side_comparison" in passed else "partial",
            evidence={
                "backend_comparison_count": len(backend_comparisons),
                "green_backend_comparison_count": len(green_backend),
                "green_backend_profiles": ok_backend_profiles,
                "sac_learners": optional_sac_baseline.get("learners"),
            },
            gaps=(
                []
                if "alberta_vs_ppo_side_by_side_comparison" in passed
                else ["side-by-side baseline comparison is incomplete"]
            ),
        ),
        "continual_unseen_obstacle_learning_no_forgetting": _requirement(
            status="proved" if "continual_learning_obstacle_demo_no_forgetting" in passed else "partial",
            evidence={
                "obstacle_validation_ok": obstacle_validation.get("ok"),
                "alberta_acc_minus_ppo": _get(obstacle_validation, "deltas", "alberta_acc_minus_ppo"),
                "alberta_forgetting_minus_ppo": _get(
                    obstacle_validation,
                    "deltas",
                    "alberta_forgetting_minus_ppo",
                ),
                "obstacle_demo_ok": obstacle_demo.get("ok"),
                "sac_demo_ok": sac_demo.get("ok"),
                "alberta_new_task_gain": _get(
                    obstacle_adaptation,
                    "alberta",
                    "mean_new_task_gain",
                ),
                "sac_alberta_new_task_gain": _get(
                    sac_adaptation,
                    "alberta",
                    "mean_new_task_gain",
                ),
            },
            gaps=(
                []
                if "continual_learning_obstacle_demo_no_forgetting" in passed
                else ["continual obstacle-course no-forgetting proof is incomplete"]
            ),
        ),
        "robot_action_videos_self_reviewed": _requirement(
            status="proved" if videos_proved and checkpoint_videos_proved else "partial",
            evidence={
                "video_review_ok": video_review.get("ok"),
                "video_count": video_review.get("video_count"),
                "profiles": video_review.get("profiles"),
                "all_videos_reviewed_good": video_review.get("all_videos_reviewed_good"),
                "manifest_review_consistent": manifest_review_consistent,
                "failed_review_count": failed_review_count,
                "checkpoint_bound_local_policy_videos_ok": checkpoint_videos.get("ok"),
                "checkpoint_bound_video_count": checkpoint_videos.get("video_count"),
                "checkpoint_bound_profiles": checkpoint_videos.get("profiles"),
            },
            gaps=[]
            if videos_proved and checkpoint_videos_proved
            else ["video review, manifest consistency, or checkpoint-bound local policy videos are incomplete"],
        ),
        "checkpoint_bound_local_policy_videos_reviewed": _requirement(
            status="proved" if checkpoint_videos_proved else "missing",
            evidence={
                "checkpoint_video_validation_ok": checkpoint_videos.get("validation_ok"),
                "checkpoint_bound_local_policy_videos_ok": checkpoint_videos.get("ok"),
                "checkpoint_bound_video_count": checkpoint_videos.get("video_count"),
                "checkpoint_bound_expected_video_count": checkpoint_videos.get(
                    "expected_video_count"
                ),
                "checkpoint_bound_profiles": checkpoint_videos.get("profiles"),
                "checkpoint_bound_actions": checkpoint_videos.get("actions"),
                "policy_source_ok_count": checkpoint_videos.get("policy_source_ok_count"),
                "task_signal_ok_count": checkpoint_videos.get("task_signal_ok_count"),
                "all_expected_reviewed": checkpoint_videos.get("all_expected_reviewed"),
                "telemetry_failed_count": _get(checkpoint_videos, "telemetry", "failed_count"),
            },
            gaps=[]
            if checkpoint_videos_proved
            else ["checkpoint-bound local policy videos are missing or failed validation"],
        ),
        "detailed_report_generated": _requirement(
            status="proved" if evidence_consistent else "partial",
            evidence={
                "evidence_consistent": evidence_consistent,
                "has_backend_matrix": bool(backend_comparisons),
                "has_obstacle_metrics": obstacle_validation.get("ok"),
                "has_video_metrics": video_review.get("ok"),
                "has_sac_comparison": optional_sac_baseline.get("ok"),
            },
            gaps=[] if evidence_consistent else ["report evidence is not internally consistent"],
        ),
        "nebius_production_training_complete": _requirement(
            status="missing" if "nebius_production_training_complete" in failed else "proved",
            evidence={
                "objective_audit_failed": "nebius_production_training_complete" in failed,
                "production_blocker": production_blocker,
            },
            gaps=(
                ["Nebius production training is still gated by CLI auth or missing production artifacts"]
                if "nebius_production_training_complete" in failed
                else []
            ),
        ),
    }


def generate_report(
    *,
    package_root: Path,
    out_json: Path,
    out_md: Path,
    backend_dir: Path | None = None,
    backend_validation_path: Path | None = None,
    obstacle_dir: Path | None = None,
    obstacle_validation_path: Path | None = None,
    video_review_path: Path | None = None,
    video_manifest_path: Path | None = None,
    scope: str = "local-smoke-and-preflight-evidence",
) -> dict[str, Any]:
    package_root = package_root.resolve()
    backend_dir = (
        backend_dir
        if backend_dir is not None
        else package_root / "evidence" / "backend_compare_smoke"
    )
    obstacle_dir = (
        obstacle_dir
        if obstacle_dir is not None
        else package_root / "evidence" / "alberta_obstacle_course_smoke"
    )
    backend_validation_path = (
        backend_validation_path
        if backend_validation_path is not None
        else backend_dir / "validation_report.json"
    )
    obstacle_validation_path = (
        obstacle_validation_path
        if obstacle_validation_path is not None
        else obstacle_dir / "validation_report.json"
    )
    video_review_path = (
        video_review_path
        if video_review_path is not None
        else package_root / "evidence" / "video_review" / "video_review.json"
    )
    video_manifest_path = (
        video_manifest_path
        if video_manifest_path is not None
        else package_root / "evidence" / "agent_videos" / "manifest.json"
    )
    backend_validation = _load_json(backend_validation_path)
    backend_comparison = _load_json(backend_dir / "comparison.json")
    backend_comparisons = _discover_backend_comparisons(package_root, backend_dir)
    ok_backend_comparisons = [
        item for item in backend_comparisons if item.get("ok") is True
    ]
    backend_profiles = sorted(
        {
            str(item.get("profile_id"))
            for item in ok_backend_comparisons
            if item.get("profile_id")
        }
    )
    any_backend_alberta_gte_ppo = any(
        item.get("alberta_gte_ppo_by_mean_reward") is True for item in ok_backend_comparisons
    )
    all_ok_backend_alberta_gte_ppo = bool(ok_backend_comparisons) and all(
        item.get("alberta_gte_ppo_by_mean_reward") is True for item in ok_backend_comparisons
    )
    integration_surfaces = _integration_surfaces_status(package_root)
    sota_baselines = _sota_baseline_status(package_root)
    training_inputs = _training_inputs_status(package_root)
    checkpoint_validations = _alberta_checkpoint_validations(package_root)
    local_validation = _local_validation_status(package_root)
    checkpoint_videos = _checkpoint_video_status(
        package_root,
        training_inputs.get("ready_profiles")
        if isinstance(training_inputs.get("ready_profiles"), list)
        else [],
    )
    optional_sac_baseline = _optional_sac_baseline_summary(package_root)
    obstacle_validation = _load_json(obstacle_validation_path)
    obstacle = _load_json(obstacle_dir / "continual_benchmark.json")
    obstacle_demo = _load_json(obstacle_dir / "obstacle_course_demo.json")
    obstacle_adaptation = _benchmark_adaptation(obstacle)
    video_review = _load_json(video_review_path)
    video_review_artifacts = _video_review_artifact_summary(
        video_review,
        package_root=package_root,
        limit=10,
    )
    video_manifest = _load_json(video_manifest_path)
    failed_video_reviews = _failed_video_reviews(video_review)
    profile_video_counts = _profile_video_counts(video_manifest)
    reviewed_profiles = set(video_review.get("profiles") or [])
    manifest_profiles = set(profile_video_counts)
    reviewed_video_count = video_review.get("video_count")
    manifest_video_count = _profile_video_count_total(profile_video_counts, "videos")
    expected_video_count = _profile_video_count_total(profile_video_counts, "expected")
    manifest_review_consistent = (
        bool(profile_video_counts)
        and reviewed_profiles == manifest_profiles
        and isinstance(reviewed_video_count, int)
        and reviewed_video_count == manifest_video_count
        and expected_video_count > 0
        and manifest_video_count >= expected_video_count
        and _all_manifest_profiles_ok(profile_video_counts)
    )
    alberta_minus_ppo = _get(
        backend_comparison,
        "alberta_vs_ppo_delta",
        "mean_reward_overall",
    )
    obstacle_acc_delta = _get(obstacle_validation, "deltas", "alberta_acc_minus_ppo")
    obstacle_forgetting_delta = _get(
        obstacle_validation,
        "deltas",
        "alberta_forgetting_minus_ppo",
    )
    backend_alberta_gte_ppo = _finite_number(alberta_minus_ppo) and float(alberta_minus_ppo) >= 0.0
    obstacle_alberta_acc_gte_ppo = (
        _finite_number(obstacle_acc_delta) and float(obstacle_acc_delta) >= 0.0
    )
    obstacle_alberta_forgetting_lte_ppo = (
        _finite_number(obstacle_forgetting_delta) and float(obstacle_forgetting_delta) <= 0.0
    )
    sac_deltas = (
        optional_sac_baseline.get("deltas")
        if isinstance(optional_sac_baseline.get("deltas"), dict)
        else {}
    )
    sac_demo = optional_sac_baseline.get("demo") if isinstance(optional_sac_baseline.get("demo"), dict) else {}
    alberta_sac_advantage_supported = bool(
        optional_sac_baseline.get("ok") is True
        and sac_deltas.get("alberta_vs_sac_advantage_supported") is True
        and sac_demo.get("ok") is True
    )
    objective_audit = _load_json(package_root / "evidence" / "alberta_objective_completion_audit.json")
    clean_launch = _load_json(
        package_root / "evidence" / "nebius_full_training" / "clean_launch_status.json"
    )
    evidence_consistent = bool(
        backend_validation.get("ok")
        and obstacle_validation.get("ok")
        and video_review.get("ok")
        and video_review.get("all_videos_reviewed_good", True) is True
        and video_manifest.get("ok")
        and manifest_review_consistent
    )
    production_blocker = _get(clean_launch, "nebius_auth", "reason")
    objective_requirements = _objective_requirements(
        objective_audit=objective_audit,
        integration_surfaces=integration_surfaces,
        backend_validation=backend_validation,
        backend_comparisons=backend_comparisons,
        sota_baselines=sota_baselines,
        training_inputs=training_inputs,
        checkpoint_validations=checkpoint_validations,
        local_validation=local_validation,
        optional_sac_baseline=optional_sac_baseline,
        obstacle_validation=obstacle_validation,
        obstacle_adaptation=obstacle_adaptation,
        obstacle_demo=obstacle_demo,
        video_review=video_review,
        checkpoint_videos=checkpoint_videos,
        manifest_review_consistent=manifest_review_consistent,
        evidence_consistent=evidence_consistent,
        production_blocker=production_blocker,
    )
    comparison_interpretation = _comparison_interpretation(
        backend_comparisons=backend_comparisons,
        obstacle_validation=obstacle_validation,
        obstacle_adaptation=obstacle_adaptation,
        optional_sac_baseline=optional_sac_baseline,
        sota_baselines=sota_baselines,
    )
    report = {
        "schema": "robot-alberta-end-to-end-report-v1",
        "ok": evidence_consistent,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "scope": scope,
        "sources": {
            "backend_dir": str(backend_dir),
            "backend_validation": str(backend_validation_path),
            "obstacle_dir": str(obstacle_dir),
            "obstacle_validation": str(obstacle_validation_path),
            "video_review": str(video_review_path),
            "video_manifest": str(video_manifest_path),
        },
        "production_complete": objective_audit.get("ok") is True,
        "production_blocker": production_blocker,
        "objective_requirements": objective_requirements,
        "comparison_interpretation": comparison_interpretation,
        "integration_surfaces": integration_surfaces,
        "backend_comparison": {
            "ok": backend_validation.get("ok"),
            "profile_id": backend_comparison.get("profile_id"),
            "tasks": backend_comparison.get("tasks"),
            "steps": backend_comparison.get("steps"),
            "winner_by_mean_reward": backend_comparison.get("winner_by_mean_reward"),
            "alberta_minus_ppo_mean_reward": alberta_minus_ppo,
            "alberta_gte_ppo_by_mean_reward": backend_alberta_gte_ppo,
            "baseline_mean_reward": _get(backend_validation, "deltas", "baseline_mean_reward"),
            "alberta_mean_reward": _get(backend_validation, "deltas", "alberta_mean_reward"),
            "ppo_mean_reward": _get(backend_validation, "deltas", "ppo_mean_reward"),
            "alberta_minus_untrained_mean_reward": _get(
                backend_validation,
                "deltas",
                "alberta_minus_untrained_mean_reward",
            ),
            "ppo_minus_untrained_mean_reward": _get(
                backend_validation,
                "deltas",
                "ppo_minus_untrained_mean_reward",
            ),
            "survival": backend_validation.get("survival"),
            "checks": backend_validation.get("checks"),
        },
        "robot_backend_comparisons": {
            "count": len(backend_comparisons),
            "ok_count": len(ok_backend_comparisons),
            "profiles": backend_profiles,
            "any_alberta_gte_ppo_by_mean_reward": any_backend_alberta_gte_ppo,
            "all_ok_alberta_gte_ppo_by_mean_reward": all_ok_backend_alberta_gte_ppo,
            "comparisons": backend_comparisons,
        },
        "sota_baselines": sota_baselines,
        "training_inputs": training_inputs,
        "alberta_checkpoints": checkpoint_validations,
        "alberta_checkpoint_videos": checkpoint_videos,
        "local_validation": local_validation,
        "optional_sota_comparisons": {
            "stable_baselines3_sac": optional_sac_baseline,
        },
        "continual_obstacle_course": {
            "ok": obstacle_validation.get("ok"),
            "env_kind": _get(obstacle, "config", "env_kind"),
            "n_tasks": _get(obstacle, "config", "n_tasks"),
            "steps_per_task": _get(obstacle, "config", "steps_per_task"),
            "eval_episodes": _get(obstacle, "config", "eval_episodes"),
            "seeds": _get(obstacle, "config", "seeds"),
            "alberta_acc": _get(obstacle, "summary", "alberta", "acc", "mean"),
            "ppo_acc": _get(obstacle, "summary", "ppo", "acc", "mean"),
            "alberta_bwt": _get(obstacle, "summary", "alberta", "bwt", "mean"),
            "ppo_bwt": _get(obstacle, "summary", "ppo", "bwt", "mean"),
            "alberta_forgetting": _get(obstacle, "summary", "alberta", "forgetting", "mean"),
            "ppo_forgetting": _get(obstacle, "summary", "ppo", "forgetting", "mean"),
            "alberta_fwt": _get(obstacle, "summary", "alberta", "fwt", "mean"),
            "ppo_fwt": _get(obstacle, "summary", "ppo", "fwt", "mean"),
            "deltas": obstacle_validation.get("deltas"),
            "adaptation": obstacle_adaptation,
            "alberta_acc_gte_ppo": obstacle_alberta_acc_gte_ppo,
            "alberta_forgetting_lte_ppo": obstacle_alberta_forgetting_lte_ppo,
            "checks": obstacle_validation.get("checks"),
            "demo": {
                "present": bool(obstacle_demo),
                "ok": obstacle_demo.get("ok"),
                "video": obstacle_demo.get("video"),
                "video_bytes": obstacle_demo.get("video_bytes"),
                "frames": obstacle_demo.get("frames"),
                "visual_review": obstacle_demo.get("visual_review"),
                "artifacts": _demo_artifact_summary(package_root, obstacle_demo),
            },
        },
        "video_review": {
            "ok": video_review.get("ok"),
            "video_count": video_review.get("video_count"),
            "profiles": video_review.get("profiles"),
            "actions": video_review.get("actions"),
            "all_videos_reviewed_good": video_review.get("all_videos_reviewed_good"),
            "manual_annotation_count": _get(video_review, "manual_annotations", "count"),
            "telemetry": video_review.get("telemetry"),
            "min_visual_progress": video_review.get("min_visual_progress"),
            "mean_visual_progress": video_review.get("mean_visual_progress"),
            "review_artifacts": video_review_artifacts,
            "manifest_video_count": manifest_video_count,
            "expected_video_count": expected_video_count,
            "manifest_review_consistent": manifest_review_consistent,
            "all_manifest_profiles_ok": _all_manifest_profiles_ok(profile_video_counts),
            "min_frame_count": min(
                (
                    int(video.get("frame_count"))
                    for video in video_review.get("videos", [])
                    if isinstance(video, dict) and isinstance(video.get("frame_count"), int)
                ),
                default=None,
            ),
            "profile_video_counts": profile_video_counts,
            "failed_review_count": len(failed_video_reviews),
            "failed_reviews": failed_video_reviews,
        },
        "claim_support": {
            "evidence_consistent": evidence_consistent,
            "backend_alberta_gte_ppo": backend_alberta_gte_ppo,
            "backend_comparison_profiles": backend_profiles,
            "backend_any_alberta_gte_ppo": any_backend_alberta_gte_ppo,
            "backend_all_ok_alberta_gte_ppo": all_ok_backend_alberta_gte_ppo,
            "obstacle_alberta_acc_gte_ppo": obstacle_alberta_acc_gte_ppo,
            "obstacle_alberta_forgetting_lte_ppo": obstacle_alberta_forgetting_lte_ppo,
            "obstacle_demo_video_ok": obstacle_demo.get("ok") is True,
            "sac_comparison_ok": optional_sac_baseline.get("ok") is True,
            "alberta_acc_gte_sac": sac_deltas.get("alberta_acc_gte_sac"),
            "alberta_forgetting_lte_sac": sac_deltas.get("alberta_forgetting_lte_sac"),
            "alberta_new_task_gain_gte_sac": sac_deltas.get(
                "alberta_new_task_gain_gte_sac"
            ),
            "sac_demo_video_ok": sac_demo.get("ok") is True,
            "alberta_sac_obstacle_advantage_supported": alberta_sac_advantage_supported,
            "alberta_obstacle_advantage_supported": bool(
                obstacle_alberta_acc_gte_ppo
                and obstacle_alberta_forgetting_lte_ppo
                and obstacle_demo.get("ok") is True
            ),
            "alberta_robot_backend_advantage_supported": any_backend_alberta_gte_ppo,
            "all_robot_backend_comparisons_support_alberta": all_ok_backend_alberta_gte_ppo,
            "checkpoint_bound_local_policy_videos_ok": checkpoint_videos.get("ok") is True,
            "production_claim_supported": objective_audit.get("ok") is True,
        },
        "objective_audit": {
            "ok": objective_audit.get("ok"),
            "passed": objective_audit.get("passed"),
            "failed": objective_audit.get("failed"),
        },
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, out_md)
    return report


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.6g}"
    if value is None:
        return "missing"
    return str(value)


def write_markdown(report: dict[str, Any], path: Path) -> None:
    backend = report["backend_comparison"]
    backend_matrix = report["robot_backend_comparisons"]
    integration = report.get("integration_surfaces", {})
    sota = report["sota_baselines"]
    training_inputs = report["training_inputs"]
    checkpoints = report["alberta_checkpoints"]
    local_validation = report["local_validation"]
    optional_sota = report.get("optional_sota_comparisons", {})
    sac = optional_sota.get("stable_baselines3_sac", {}) if isinstance(optional_sota, dict) else {}
    interpretation = report.get("comparison_interpretation", {})
    robot_backend_interpretation = (
        interpretation.get("robot_backend_mean_reward", {})
        if isinstance(interpretation, dict)
        else {}
    )
    obstacle_interpretation = (
        interpretation.get("continual_obstacle_course", {})
        if isinstance(interpretation, dict)
        else {}
    )
    methods_interpretation = (
        interpretation.get("sota_methods_compared", {})
        if isinstance(interpretation, dict)
        else {}
    )
    obstacle = report["continual_obstacle_course"]
    video = report["video_review"]
    checkpoint_videos = report.get("alberta_checkpoint_videos", {})
    claim = report["claim_support"]
    requirements = report.get("objective_requirements", {})
    lines = [
        "# Alberta End-to-End Evidence Report",
        "",
        f"Result: `{'ok' if report.get('ok') else 'not-ready'}`",
        f"Generated: `{report.get('generated_at')}`",
        f"Scope: `{report.get('scope')}`",
        f"Production complete: `{report.get('production_complete')}`",
        f"Production blocker: `{report.get('production_blocker') or 'none'}`",
        "",
        "## Objective Requirements",
        "",
        "| requirement | status | evidence | gaps |",
        "|---|---|---|---|",
    ]
    for name, requirement in requirements.items():
        if not isinstance(requirement, dict):
            continue
        evidence = requirement.get("evidence") if isinstance(requirement.get("evidence"), dict) else {}
        evidence_text = ", ".join(
            f"{key}=`{_fmt(value)}`" for key, value in evidence.items()
        )
        gaps = requirement.get("gaps") if isinstance(requirement.get("gaps"), list) else []
        gap_text = "; ".join(str(gap) for gap in gaps) if gaps else "none"
        lines.append(
            f"| `{name}` | `{requirement.get('status')}` | {evidence_text} | {gap_text} |"
        )
    lines += [
        "",
        "## Alberta Integration Surfaces",
        "",
        "| surface | value |",
        "|---|---:|",
        f"| validation ok | `{integration.get('ok')}` |",
        f"| dependency wired | `{_get(integration, 'checks', 'dependency')}` |",
        f"| vendored source override | `{_get(integration, 'checks', 'source_override')}` |",
        f"| modules import | `{_get(integration, 'checks', 'modules')}` |",
        f"| public exports | `{_get(integration, 'checks', 'public_exports')}` |",
        f"| console scripts | `{_get(integration, 'checks', 'console_scripts')}` |",
        f"| package files | `{_get(integration, 'checks', 'files')}` |",
        "",
        "",
        "## Alberta vs PPO",
        "",
        "| field | value |",
        "|---|---:|",
        f"| profile | `{backend.get('profile_id')}` |",
        f"| tasks | `{', '.join(backend.get('tasks') or [])}` |",
        f"| steps | `{backend.get('steps')}` |",
        f"| winner | `{backend.get('winner_by_mean_reward')}` |",
        f"| untrained mean reward | `{_fmt(backend.get('baseline_mean_reward'))}` |",
        f"| Alberta mean reward | `{_fmt(backend.get('alberta_mean_reward'))}` |",
        f"| PPO mean reward | `{_fmt(backend.get('ppo_mean_reward'))}` |",
        f"| Alberta minus untrained | `{_fmt(backend.get('alberta_minus_untrained_mean_reward'))}` |",
        f"| PPO minus untrained | `{_fmt(backend.get('ppo_minus_untrained_mean_reward'))}` |",
        f"| Alberta minus PPO | `{_fmt(backend.get('alberta_minus_ppo_mean_reward'))}` |",
        f"| Alberta >= PPO | `{backend.get('alberta_gte_ppo_by_mean_reward')}` |",
        f"| min mean steps survived | `{_fmt(_get(backend, 'survival', 'min_mean_steps_survived'))}` |",
        f"| Alberta min mean steps survived | `{_fmt(_get(backend, 'survival', 'alberta_min_mean_steps_survived'))}` |",
        f"| PPO min mean steps survived | `{_fmt(_get(backend, 'survival', 'ppo_min_mean_steps_survived'))}` |",
        "",
        "## Robot Backend Comparison Matrix",
        "",
        "| field | value |",
        "|---|---:|",
        f"| comparisons | `{backend_matrix.get('count')}` |",
        f"| green comparisons | `{backend_matrix.get('ok_count')}` |",
        f"| profiles | `{', '.join(backend_matrix.get('profiles') or [])}` |",
        f"| any Alberta >= PPO | `{backend_matrix.get('any_alberta_gte_ppo_by_mean_reward')}` |",
        f"| all green Alberta >= PPO | `{backend_matrix.get('all_ok_alberta_gte_ppo_by_mean_reward')}` |",
        "",
        "| comparison | profile | ok | winner | untrained | Alberta | PPO | Alberta - untrained | PPO - untrained | Alberta - PPO | survival min |",
        "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in backend_matrix.get("comparisons") or []:
        lines.append(
            f"| `{item.get('name')}` | `{item.get('profile_id')}` | `{item.get('ok')}` | "
            f"`{item.get('winner_by_mean_reward')}` | "
            f"`{_fmt(item.get('baseline_mean_reward'))}` | "
            f"`{_fmt(item.get('alberta_mean_reward'))}` | "
            f"`{_fmt(item.get('ppo_mean_reward'))}` | "
            f"`{_fmt(item.get('alberta_minus_untrained_mean_reward'))}` | "
            f"`{_fmt(item.get('ppo_minus_untrained_mean_reward'))}` | "
            f"`{_fmt(item.get('alberta_minus_ppo_mean_reward'))}` | "
            f"`{_fmt(_get(item, 'survival', 'min_mean_steps_survived'))}` |"
        )
    lines += [
        "",
        "## SOTA Baseline Evidence",
        "",
        "| baseline | role | evidence |",
        "|---|---|---|",
        "| `stable_baselines3_ppo` | "
        f"{_get(sota, 'stable_baselines3_ppo', 'role')} | "
        f"local artifact present: `{_get(sota, 'stable_baselines3_ppo', 'local_comparison_artifact_present')}` |",
        "| `brax_mjx_ppo` | "
        f"{_get(sota, 'brax_mjx_ppo', 'role')} | "
        f"preflight ok: `{_get(sota, 'brax_mjx_ppo', 'preflight_validation_ok')}`, "
        f"script present: `{_get(sota, 'brax_mjx_ppo', 'script_present')}`, "
        f"manifest present: `{_get(sota, 'brax_mjx_ppo', 'manifest_present')}`, "
        f"contract artifact ok: `{_get(sota, 'brax_mjx_ppo', 'contract_artifact_ok')}`, "
        f"contract only: `{_get(sota, 'brax_mjx_ppo', 'contract_only')}`, "
        f"production training: `{_get(sota, 'brax_mjx_ppo', 'production_training')}`, "
        f"contract profile: `{_get(sota, 'brax_mjx_ppo', 'contract_profile_id')}`, "
        f"contract steps: `{_get(sota, 'brax_mjx_ppo', 'contract_steps')}` |",
        "| `stable_baselines3_sac` | optional off-policy maximum-entropy baseline | "
        f"artifact present: `{sac.get('present')}`, ok: `{sac.get('ok')}`, "
        f"learners: `{', '.join(sac.get('learners') or [])}` |",
        "",
        "## Training Inputs And Datasets",
        "",
        "| field | value |",
        "|---|---:|",
        f"| training inputs ok | `{training_inputs.get('ok')}` |",
        f"| launch tasks | `{training_inputs.get('launch_task_count')}` |",
        f"| supported launch tasks | `{training_inputs.get('supported_launch_task_count')}` |",
        f"| ready profiles | `{training_inputs.get('ready_profile_count')}` |",
        f"| curriculum version | `{training_inputs.get('curriculum_version')}` |",
        f"| curriculum task count | `{training_inputs.get('curriculum_task_count')}` |",
        f"| curriculum SHA256 | `{training_inputs.get('curriculum_content_sha256')}` |",
        f"| text variant collisions | `{training_inputs.get('text_variant_collision_count')}` |",
        f"| RL-from-sim ready | `{training_inputs.get('rl_from_sim_ready')}` |",
        f"| offline datasets present | `{training_inputs.get('offline_datasets_present')}` |",
        f"| imitation training ready | `{training_inputs.get('imitation_training_ready')}` |",
        f"| offline datasets block current plan | `{training_inputs.get('offline_datasets_block_current_plan')}` |",
        f"| trajectory DB tooling present | `{training_inputs.get('trajectory_db_tooling_present')}` |",
        f"| blocker count | `{training_inputs.get('blocker_count')}` |",
        f"| warning kinds | `{', '.join(training_inputs.get('warning_kinds') or [])}` |",
        "",
        "## Alberta Checkpoint Inference",
        "",
        "| field | value |",
        "|---|---:|",
        f"| validation reports | `{checkpoints.get('count')}` |",
        f"| passing reports | `{checkpoints.get('ok_count')}` |",
        f"| profiles | `{', '.join(checkpoints.get('profiles') or [])}` |",
        f"| all inference ok | `{checkpoints.get('all_inference_ok')}` |",
        f"| any inference ok | `{checkpoints.get('any_inference_ok')}` |",
        "",
        "| checkpoint | profile | ok | steps | inference | failed checks |",
        "|---|---|---:|---:|---:|---|",
    ]
    for item in checkpoints.get("reports") or []:
        failed = item.get("failed_checks") if isinstance(item.get("failed_checks"), list) else []
        lines.append(
            f"| `{item.get('name')}` | `{item.get('profile_id')}` | `{item.get('ok')}` | "
            f"`{item.get('total_steps')}` | `{item.get('inference_ok')}` | "
            f"`{', '.join(failed) if failed else 'none'}` |"
        )
    lines += [
        "",
        "## Local Validation",
        "",
        "| field | value |",
        "|---|---:|",
        f"| validation ok | `{local_validation.get('ok')}` |",
        f"| tests | `{local_validation.get('tests')}` |",
        f"| passed | `{local_validation.get('passed')}` |",
        f"| failures | `{local_validation.get('failures')}` |",
        f"| errors | `{local_validation.get('errors')}` |",
        f"| skipped | `{local_validation.get('skipped')}` |",
        f"| time seconds | `{_fmt(local_validation.get('time_seconds'))}` |",
        f"| JUnit XML | `{local_validation.get('junit_xml') or 'missing'}` |",
        f"| known warnings | `{', '.join(local_validation.get('known_warnings') or [])}` |",
        "",
        "| coverage scope |",
        "|---|",
    ]
    for item in local_validation.get("coverage_scope") or []:
        lines.append(f"| {item} |")
    lines += [
        "",
        "### Optional SAC Continual Comparison",
        "",
        "| field | value |",
        "|---|---:|",
        f"| path | `{sac.get('path') or 'missing'}` |",
        f"| env | `{sac.get('env_kind') or 'missing'}` |",
        f"| tasks | `{sac.get('n_tasks')}` |",
        f"| steps per task | `{sac.get('steps_per_task')}` |",
        f"| eval episodes | `{sac.get('eval_episodes')}` |",
        f"| Alberta ACC | `{_fmt(_get(sac, 'acc', 'alberta'))}` |",
        f"| PPO ACC | `{_fmt(_get(sac, 'acc', 'ppo'))}` |",
        f"| SAC ACC | `{_fmt(_get(sac, 'acc', 'sac'))}` |",
        f"| Alberta forgetting | `{_fmt(_get(sac, 'forgetting', 'alberta'))}` |",
        f"| PPO forgetting | `{_fmt(_get(sac, 'forgetting', 'ppo'))}` |",
        f"| SAC forgetting | `{_fmt(_get(sac, 'forgetting', 'sac'))}` |",
        f"| Alberta ACC delta vs PPO | `{_fmt(_get(sac, 'deltas', 'alberta_acc_minus_ppo'))}` |",
        f"| Alberta forgetting delta vs PPO | `{_fmt(_get(sac, 'deltas', 'alberta_forgetting_minus_ppo'))}` |",
        f"| Alberta ACC delta vs SAC | `{_fmt(_get(sac, 'deltas', 'alberta_acc_minus_sac'))}` |",
        f"| Alberta forgetting delta vs SAC | `{_fmt(_get(sac, 'deltas', 'alberta_forgetting_minus_sac'))}` |",
        f"| Alberta new-task gain | `{_fmt(_get(sac, 'adaptation', 'alberta', 'mean_new_task_gain'))}` |",
        f"| PPO new-task gain | `{_fmt(_get(sac, 'adaptation', 'ppo', 'mean_new_task_gain'))}` |",
        f"| SAC new-task gain | `{_fmt(_get(sac, 'adaptation', 'sac', 'mean_new_task_gain'))}` |",
        f"| Alberta new-task gain delta vs SAC | `{_fmt(_get(sac, 'deltas', 'alberta_new_task_gain_minus_sac'))}` |",
        f"| Alberta advantage vs SAC | `{_get(sac, 'deltas', 'alberta_vs_sac_advantage_supported')}` |",
        f"| demo video ok | `{_get(sac, 'demo', 'ok')}` |",
        f"| demo learners | `{', '.join(_get(sac, 'demo', 'learners') or [])}` |",
        f"| demo video | `{_get(sac, 'demo', 'video') or 'missing'}` |",
        f"| demo frames | `{_get(sac, 'demo', 'frames')}` |",
        f"| visual review | `{_get(sac, 'demo', 'visual_review', 'verdict') or 'missing'}` |",
        f"| demo video file exists | `{_get(sac, 'demo', 'artifacts', 'video_present')}` |",
        f"| demo video bytes match | `{_get(sac, 'demo', 'artifacts', 'video_bytes_match')}` |",
        f"| demo review contact sheet exists | `{_get(sac, 'demo', 'artifacts', 'contact_sheet_exists')}` |",
        "",
        "## Continual Obstacle Course",
        "",
        "| field | value |",
        "|---|---:|",
        f"| env | `{obstacle.get('env_kind')}` |",
        f"| tasks | `{obstacle.get('n_tasks')}` |",
        f"| steps per task | `{obstacle.get('steps_per_task')}` |",
        f"| eval episodes | `{obstacle.get('eval_episodes')}` |",
        f"| seeds | `{obstacle.get('seeds')}` |",
        f"| Alberta ACC | `{_fmt(obstacle.get('alberta_acc'))}` |",
        f"| PPO ACC | `{_fmt(obstacle.get('ppo_acc'))}` |",
        f"| Alberta BWT | `{_fmt(obstacle.get('alberta_bwt'))}` |",
        f"| PPO BWT | `{_fmt(obstacle.get('ppo_bwt'))}` |",
        f"| Alberta forgetting | `{_fmt(obstacle.get('alberta_forgetting'))}` |",
        f"| PPO forgetting | `{_fmt(obstacle.get('ppo_forgetting'))}` |",
        f"| Alberta FWT | `{_fmt(obstacle.get('alberta_fwt'))}` |",
        f"| PPO FWT | `{_fmt(obstacle.get('ppo_fwt'))}` |",
        f"| ACC delta | `{_fmt(_get(obstacle, 'deltas', 'alberta_acc_minus_ppo'))}` |",
        f"| forgetting delta | `{_fmt(_get(obstacle, 'deltas', 'alberta_forgetting_minus_ppo'))}` |",
        f"| Alberta new-task gain | `{_fmt(_get(obstacle, 'adaptation', 'alberta', 'mean_new_task_gain'))}` |",
        f"| PPO new-task gain | `{_fmt(_get(obstacle, 'adaptation', 'ppo', 'mean_new_task_gain'))}` |",
        f"| Alberta task-0 retention delta | `{_fmt(_get(obstacle, 'adaptation', 'alberta', 'first_task_retention_delta'))}` |",
        f"| PPO task-0 retention delta | `{_fmt(_get(obstacle, 'adaptation', 'ppo', 'first_task_retention_delta'))}` |",
        f"| Alberta ACC >= PPO | `{obstacle.get('alberta_acc_gte_ppo')}` |",
        f"| Alberta forgetting <= PPO | `{obstacle.get('alberta_forgetting_lte_ppo')}` |",
        f"| demo video ok | `{_get(obstacle, 'demo', 'ok')}` |",
        f"| demo video | `{_get(obstacle, 'demo', 'video') or 'missing'}` |",
        f"| demo frames | `{_get(obstacle, 'demo', 'frames')}` |",
        f"| visual review | `{_get(obstacle, 'demo', 'visual_review', 'verdict') or 'missing'}` |",
        f"| demo video file exists | `{_get(obstacle, 'demo', 'artifacts', 'video_present')}` |",
        f"| demo video bytes match | `{_get(obstacle, 'demo', 'artifacts', 'video_bytes_match')}` |",
        f"| demo review contact sheet exists | `{_get(obstacle, 'demo', 'artifacts', 'contact_sheet_exists')}` |",
        "",
        "## Video Review",
        "",
        "| field | value |",
        "|---|---:|",
        f"| videos | `{video.get('video_count')}` |",
        f"| profiles | `{', '.join(video.get('profiles') or [])}` |",
        f"| actions | `{', '.join(video.get('actions') or [])}` |",
        f"| manifest videos | `{video.get('manifest_video_count')}` |",
        f"| expected videos | `{video.get('expected_video_count')}` |",
        f"| manifest/review consistent | `{video.get('manifest_review_consistent')}` |",
        f"| all manifest profiles ok | `{video.get('all_manifest_profiles_ok')}` |",
        f"| all videos reviewed good | `{video.get('all_videos_reviewed_good')}` |",
        f"| manual annotations | `{video.get('manual_annotation_count')}` |",
        f"| failed frame reviews | `{video.get('failed_review_count')}` |",
        f"| min frame count | `{video.get('min_frame_count')}` |",
        f"| min visual progress | `{_fmt(video.get('min_visual_progress'))}` |",
        f"| mean visual progress | `{_fmt(video.get('mean_visual_progress'))}` |",
        f"| contact sheets | `{_get(video, 'review_artifacts', 'contact_sheet_count')}` |",
        f"| existing contact sheets | `{_get(video, 'review_artifacts', 'existing_contact_sheet_count')}` |",
        f"| missing contact sheets | `{_get(video, 'review_artifacts', 'missing_contact_sheet_count')}` |",
        f"| representative reviewed clips | `{_get(video, 'review_artifacts', 'sample_count')}` |",
        "",
        "### Representative Video Review Artifacts",
        "",
        "| profile | action | verdict | frames | visual progress | contact sheet | notes |",
        "|---|---|---|---:|---:|---|---|",
    ]
    for item in _get(video, "review_artifacts", "samples") or []:
        lines.append(
            f"| `{item.get('profile')}` | `{item.get('action')}` | "
            f"`{item.get('verdict')}` | `{item.get('frame_count')}` | "
            f"`{_fmt(item.get('visual_progress'))}` | "
            f"`{item.get('contact_sheet') or 'missing'}` "
            f"exists=`{item.get('contact_sheet_exists')}` | "
            f"{item.get('review_notes') or ''} |"
        )
    lines += [
        "",
        "## Checkpoint-Bound Alberta Videos",
        "",
        "| field | value |",
        "|---|---:|",
        f"| review ok | `{checkpoint_videos.get('ok')}` |",
        f"| profiles | `{', '.join(checkpoint_videos.get('profiles') or [])}` |",
        f"| videos | `{checkpoint_videos.get('video_count')}` / `{checkpoint_videos.get('expected_video_count')}` |",
        f"| actions | `{', '.join(checkpoint_videos.get('actions') or [])}` |",
        f"| all videos reviewed good | `{checkpoint_videos.get('all_videos_reviewed_good')}` |",
        f"| telemetry ok | `{_get(checkpoint_videos, 'telemetry', 'ok_count')}` / `{_get(checkpoint_videos, 'telemetry', 'present_count')}` |",
        f"| provenance validation ok | `{checkpoint_videos.get('validation_ok')}` |",
        f"| telemetry policy source ok | `{checkpoint_videos.get('policy_source_ok_count')}` / `{checkpoint_videos.get('video_count')}` |",
        f"| telemetry task signal ok | `{checkpoint_videos.get('task_signal_ok_count')}` / `{checkpoint_videos.get('video_count')}` |",
        f"| checkpoint mismatches | `{len(checkpoint_videos.get('checkpoint_mismatches') or [])}` |",
        f"| min frame count | `{checkpoint_videos.get('min_frame_count')}` |",
        f"| min visual progress | `{_fmt(checkpoint_videos.get('min_visual_progress'))}` |",
        f"| contact sheets | `{_get(checkpoint_videos, 'review_artifacts', 'contact_sheet_count')}` |",
        f"| existing contact sheets | `{_get(checkpoint_videos, 'review_artifacts', 'existing_contact_sheet_count')}` |",
        f"| missing contact sheets | `{_get(checkpoint_videos, 'review_artifacts', 'missing_contact_sheet_count')}` |",
        f"| representative reviewed clips | `{_get(checkpoint_videos, 'review_artifacts', 'sample_count')}` |",
        "",
        "### Representative Checkpoint-Bound Review Artifacts",
        "",
        "| profile | action | verdict | frames | visual progress | contact sheet | notes |",
        "|---|---|---|---:|---:|---|---|",
    ]
    for item in _get(checkpoint_videos, "review_artifacts", "samples") or []:
        lines.append(
            f"| `{item.get('profile')}` | `{item.get('action')}` | "
            f"`{item.get('verdict')}` | `{item.get('frame_count')}` | "
            f"`{_fmt(item.get('visual_progress'))}` | "
            f"`{item.get('contact_sheet') or 'missing'}` "
            f"exists=`{item.get('contact_sheet_exists')}` | "
            f"{item.get('review_notes') or ''} |"
        )
    if video.get("failed_reviews"):
        lines += [
            "",
            "### Failed Frame Reviews",
            "",
            "| profile | action | verdict | notes |",
            "|---|---|---|---|",
        ]
        for item in video["failed_reviews"]:
            lines.append(
                f"| `{item.get('profile')}` | `{item.get('action')}` | "
                f"`{item.get('verdict')}` | {item.get('review_notes') or ''} |"
            )
    lines += [
        "",
        "## Claim Support",
        "",
        "| claim | supported |",
        "|---|---:|",
        f"| evidence internally consistent | `{claim.get('evidence_consistent')}` |",
        f"| Alberta robot backend advantage | `{claim.get('alberta_robot_backend_advantage_supported')}` |",
        f"| Alberta obstacle-course advantage | `{claim.get('alberta_obstacle_advantage_supported')}` |",
        f"| obstacle demo video | `{claim.get('obstacle_demo_video_ok')}` |",
        f"| production objective complete | `{claim.get('production_claim_supported')}` |",
        "",
        "## Comparison Interpretation",
        "",
        "| surface | result |",
        "|---|---|",
        f"| robot backend mean reward | {robot_backend_interpretation.get('conclusion') or 'missing'} |",
        f"| obstacle continual learning | {obstacle_interpretation.get('conclusion') or 'missing'} |",
        f"| methods compared | `{', '.join(methods_interpretation.get('methods') or [])}` |",
        f"| Alberta >= PPO robot-backend count | `{robot_backend_interpretation.get('alberta_gte_ppo_count')}` / `{robot_backend_interpretation.get('ok_comparison_count')}` |",
        f"| obstacle advantage supported | `{obstacle_interpretation.get('advantage_supported')}` |",
    ]
    lines += [
        "",
        "This report is generated from the configured evidence artifacts. "
        "It does not claim production completion unless the strict objective audit is green.",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--backend-dir", type=Path)
    parser.add_argument("--backend-validation", type=Path)
    parser.add_argument("--obstacle-dir", type=Path)
    parser.add_argument("--obstacle-validation", type=Path)
    parser.add_argument("--video-review", type=Path)
    parser.add_argument("--video-manifest", type=Path)
    parser.add_argument("--scope", default="local-smoke-and-preflight-evidence")
    parser.add_argument(
        "--out-json",
        type=Path,
        default=Path("evidence") / "ALBERTA_END_TO_END_REPORT.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=Path("evidence") / "ALBERTA_END_TO_END_REPORT.md",
    )
    args = parser.parse_args(argv)
    report = generate_report(
        package_root=args.package_root,
        out_json=args.out_json,
        out_md=args.out_md,
        backend_dir=args.backend_dir,
        backend_validation_path=args.backend_validation,
        obstacle_dir=args.obstacle_dir,
        obstacle_validation_path=args.obstacle_validation,
        video_review_path=args.video_review,
        video_manifest_path=args.video_manifest,
        scope=args.scope,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
