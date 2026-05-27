#!/usr/bin/env python3
"""Skeptical audit: prove whether robot evidence shows learning and motion."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

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


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    video = report["robot_video_physical_review"]
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
        f"- Existing Nebius obstacle-course evidence has physical rollout metrics: `{obstacle['ok']}`.",
        f"- Fresh obstacle smoke benchmark with new physical metrics passes: `{smoke['ok']}`.",
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
        "## Obstacle Course",
        "",
        f"Existing evidence failed checks: `{', '.join(obstacle['failed_checks']) or 'none'}`",
        "",
        "Fresh smoke motion summary:",
        "",
        "```json",
        json.dumps(smoke.get("motion"), indent=2),
        "```",
        "",
        "## Conclusion",
        "",
        "The current historical Nebius artifacts do not prove real robot walking or "
        "a physically meaningful obstacle-course result. The patched benchmark "
        "now records forward progress, obstacle passing, collision rate, and "
        "success rate; fresh smoke evidence shows the harness can expose those "
        "facts. A production claim should require these physical checks.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def audit(
    *,
    run_root: Path,
    fresh_obstacle_dir: Path,
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
        require_alberta_forgetting_lte_ppo=True,
    )
    smoke_bundle = _load(fresh_obstacle_dir / "continual_benchmark.json")
    report = {
        "schema": "robot-motion-learning-audit-v1",
        "ok": bool(video_review.get("ok"))
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
            "benchmark": str(fresh_obstacle_dir / "continual_benchmark.json"),
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
        default=ROOT / "evidence" / "obstacle_motion_audit_smoke",
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
        out_json=args.out_json,
        out_md=args.out_md,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
