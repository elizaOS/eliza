#!/usr/bin/env python3
"""Skeptical audit: prove whether robot evidence shows learning and motion."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from scripts.eval_text_policy import curriculum_report_from_eval
from scripts.review_robot_video_evidence import review_videos
from scripts.validate_alberta_benchmark_artifacts import (
    validate_alberta_benchmark_artifacts,
)

ROOT = Path(__file__).resolve().parents[1]


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
            "progress_ratio": most_forward.get("progress_ratio")
            if most_forward
            else row.get("progress_ratio"),
            "unmet_success_predicates": most_forward.get("unmet_success_predicates")
            if most_forward
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
                    "progress_ratio": row.get("progress_ratio"),
                    "unmet_success_predicates": row.get("diagnostics", {}).get(
                        "unmet_success_predicates"
                    ),
                    "best_candidate": best_candidates[-1],
                    "most_forward_candidate": most_forward_summary,
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


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    video = report["robot_video_physical_review"]
    learned = report["learned_policy_curriculum_eval"]
    local_probe = report["local_learning_probe"]
    feasibility = report["task_feasibility"]
    open_loop = report["open_loop_gait_search"]
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
        f"- Local short learning probe shows actual learning signal: `{local_probe['learning_signal_present']}`.",
        f"- Local short learning probe reaches walking success: `{local_probe['walking_success']}`.",
        f"- Open-loop task feasibility candidates can satisfy walking: `{feasibility['ok']}`.",
        f"- Open-loop gait search finds a walking primitive: `{open_loop['ok']}`.",
        f"- Cross-profile walking evidence beats passive baselines: `{multi_profile_walk['ok']}`.",
        f"- Existing Nebius obstacle-course evidence has physical rollout metrics: `{obstacle['ok']}`.",
        f"- Fresh obstacle smoke benchmark with physical metrics and path traces passes: `{smoke['ok']}`.",
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
        f"Reward delta trained-zero: `{local_probe.get('reward_delta_trained_minus_zero')}`",
        f"Forward delta trained-zero m: `{local_probe.get('forward_delta_trained_minus_zero_m')}`",
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
            "| task | best controller | best dx m | most-forward controller | most-forward dx m | passive dx m | termination | unmet predicates |",
            "|---|---|---:|---|---:|---:|---|---|",
        ]
        for row in failed_feasibility:
            best = row.get("best_candidate") if isinstance(row.get("best_candidate"), dict) else {}
            most_forward = (
                row.get("most_forward_candidate")
                if isinstance(row.get("most_forward_candidate"), dict)
                else {}
            )
            passive = (
                row.get("passive_baseline")
                if isinstance(row.get("passive_baseline"), dict)
                else {}
            )
            lines.append(
                f"| `{row.get('task_id')}` | `{best.get('controller')}` | "
                f"{float(best.get('final_delta_x_m') or 0.0):.3f} | "
                f"`{most_forward.get('controller')}` | "
                f"{float(most_forward.get('final_delta_x_m') or 0.0):.3f} | "
                f"{float(passive.get('final_delta_x_m') or 0.0):.3f} | "
                f"`{most_forward.get('termination_reason')}` | "
                f"`{', '.join(most_forward.get('unmet_success_predicates') or []) or 'none'}` |"
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
    ]
    lines += [
        "",
        "## Multi-profile Walk Feasibility",
        "",
        f"Cross-profile walk ok: `{multi_profile_walk.get('ok')}`",
        f"Valid walking profiles: `{multi_profile_walk.get('n_valid_walking')}`",
        f"Passive-success profiles: `{multi_profile_walk.get('n_passive_success')}`",
        "",
        "| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m |",
        "|---|---|---|---:|---:|---|---:|",
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
            f"{float(row.get('most_forward_final_delta_x_m') or 0.0):.3f} |"
        )
    lines += [
        "",
        "## Obstacle Course",
        "",
        f"Existing evidence failed checks: `{', '.join(obstacle['failed_checks']) or 'none'}`",
        f"Fresh smoke beats passive baseline: `{smoke.get('obstacle_baseline', {}).get('learning_beats_baseline')}`",
        f"Fresh smoke passive baseline is a control: `{smoke.get('obstacle_baseline', {}).get('baseline_is_control')}`",
        "",
        "Fresh smoke motion summary:",
        "",
        "```json",
        json.dumps(smoke.get("motion"), indent=2),
        "```",
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
    local_probe = _load(local_probe_dir / "learning_probe_summary.json")
    task_feasibility = _task_feasibility_summary(_load(task_feasibility_path))
    open_loop_search = _load(open_loop_search_path)
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
        and bool(open_loop_search.get("any_success"))
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
            "probe": str(local_probe_dir / "learning_probe_summary.json"),
            "learning_signal_present": local_probe.get("learning_signal_present"),
            "walking_success": local_probe.get("walking_success"),
            "reward_delta_trained_minus_zero": local_probe.get(
                "reward_delta_trained_minus_zero"
            ),
            "forward_delta_trained_minus_zero_m": local_probe.get(
                "forward_delta_trained_minus_zero_m"
            ),
            "verdict": local_probe.get("verdict"),
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
            "ok": smoke_report.get("ok"),
            "failed_checks": _false_checks(smoke_report),
            "motion": smoke_report.get("motion"),
            "deltas": smoke_report.get("deltas"),
            "obstacle_baseline": smoke_report.get("obstacle_baseline"),
            "benchmark": str(fresh_obstacle_dir / "continual_benchmark.json"),
            "demo_video": str(fresh_obstacle_dir / "obstacle_course_demo.mp4"),
            "summary": smoke_bundle.get("summary"),
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
        default=ROOT / "evidence" / "local_learning_probe_hiwonder_walk_8k",
    )
    parser.add_argument(
        "--task-feasibility-path",
        type=Path,
        default=ROOT / "evidence" / "task_feasibility_hiwonder_walk_forward.json",
    )
    parser.add_argument(
        "--open-loop-search-path",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_open_loop_gait_search.json",
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
        multi_profile_walk_path=args.multi_profile_walk_path,
        out_json=args.out_json,
        out_md=args.out_md,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
