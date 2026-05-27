#!/usr/bin/env python3
"""Inventory required Nebius robot training artifacts in a synced run tree."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TEXT_POLICY_EVAL_SCHEMA = "robot-text-policy-eval-v1"
CURRICULUM_EVAL_SCHEMA = "robot-policy-curriculum-eval-v1"

REQUIRED_ARTIFACTS = {
    "status_success": "status/success.txt",
    "runner_status": "status/runner_status.json",
    "status_00_local_preflight": "status/00_local_preflight.json",
    "status_10_nebius_train_alberta": "status/10_nebius_train_alberta.json",
    "status_20_nebius_compare_backends": "status/20_nebius_compare_backends.json",
    "status_30_nebius_continual_benchmarks": (
        "status/30_nebius_continual_benchmarks.json"
    ),
    "status_40_nebius_brax_baseline": "status/40_nebius_brax_baseline.json",
    "status_50_post_train_validation": "status/50_post_train_validation.json",
    "log_train_alberta": "logs/10_nebius_train_alberta.log",
    "log_compare_backends": "logs/20_nebius_compare_backends.log",
    "log_continual_benchmarks": "logs/30_nebius_continual_benchmarks.log",
    "log_brax_baseline": "logs/40_nebius_brax_baseline.log",
    "log_post_train_validation": "logs/50_post_train_validation.log",
    "training_inputs_report": "evidence/full_training_preflight/training_inputs_report.json",
    "alberta_manifest": "checkpoints/asimov_1_alberta_full/manifest.json",
    "alberta_policy": "checkpoints/asimov_1_alberta_full/alberta_policy.npz",
    "backend_comparison_json": "evidence/backend_compare/asimov-1/comparison.json",
    "backend_comparison_md": "evidence/backend_compare/asimov-1/comparison.md",
    "curriculum_eval_report": "evidence/curriculum_eval/report.json",
    "curriculum_eval_native": "evidence/curriculum_eval/eval_text_policy.json",
    "joint_reach_benchmark_json": "evidence/alberta_joint_reach/continual_benchmark.json",
    "joint_reach_benchmark_md": "evidence/alberta_joint_reach/continual_benchmark.md",
    "joint_reach_benchmark_plot": "evidence/alberta_joint_reach/continual_benchmark.png",
    "obstacle_course_benchmark_json": "evidence/alberta_obstacle_course/continual_benchmark.json",
    "obstacle_course_benchmark_md": "evidence/alberta_obstacle_course/continual_benchmark.md",
    "obstacle_course_benchmark_plot": "evidence/alberta_obstacle_course/continual_benchmark.png",
    "obstacle_course_demo_json": "evidence/alberta_obstacle_course/obstacle_course_demo.json",
    "obstacle_course_demo_video": "evidence/alberta_obstacle_course/obstacle_course_demo.mp4",
    "brax_manifest": "evidence/full_training_preflight/asimov_1_brax_mjx_baseline/manifest.json",
    "brax_policy": "evidence/full_training_preflight/asimov_1_brax_mjx_baseline/policy_brax.pkl",
    "agent_video_manifest": "evidence/agent_videos/manifest.json",
    "production_video_asimov_stand_up": "evidence/agent_videos/asimov-1/asimov-1_stand_up.mp4",
    "production_video_asimov_walk_forward": "evidence/agent_videos/asimov-1/asimov-1_walk_forward.mp4",
    "production_video_asimov_turn_left": "evidence/agent_videos/asimov-1/asimov-1_turn_left.mp4",
    "production_video_asimov_turn_right": "evidence/agent_videos/asimov-1/asimov-1_turn_right.mp4",
    "production_video_asimov_combined": "evidence/agent_videos/asimov-1/asimov-1_combined_actions.mp4",
    "production_video_telemetry_asimov_stand_up": "evidence/agent_videos/asimov-1/asimov-1_stand_up.telemetry.json",
    "production_video_telemetry_asimov_walk_forward": "evidence/agent_videos/asimov-1/asimov-1_walk_forward.telemetry.json",
    "production_video_telemetry_asimov_turn_left": "evidence/agent_videos/asimov-1/asimov-1_turn_left.telemetry.json",
    "production_video_telemetry_asimov_turn_right": "evidence/agent_videos/asimov-1/asimov-1_turn_right.telemetry.json",
    "production_video_telemetry_asimov_combined": "evidence/agent_videos/asimov-1/asimov-1_combined_actions.telemetry.json",
    "multi_robot_video_hiwonder_stand_up": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_stand_up.mp4",
    "multi_robot_video_hiwonder_walk_forward": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.mp4",
    "multi_robot_video_hiwonder_turn_left": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_turn_left.mp4",
    "multi_robot_video_hiwonder_turn_right": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_turn_right.mp4",
    "multi_robot_video_hiwonder_combined": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.mp4",
    "multi_robot_video_telemetry_hiwonder_stand_up": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_stand_up.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_walk_forward": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_turn_left": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_turn_left.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_turn_right": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_turn_right.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_combined": "evidence/multi_robot_smoke_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.telemetry.json",
    "multi_robot_video_unitree_g1_stand_up": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_stand_up.mp4",
    "multi_robot_video_unitree_g1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_walk_forward.mp4",
    "multi_robot_video_unitree_g1_turn_left": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_turn_left.mp4",
    "multi_robot_video_unitree_g1_turn_right": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_turn_right.mp4",
    "multi_robot_video_unitree_g1_combined": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_g1_stand_up": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_turn_left": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_turn_right": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_combined": "evidence/multi_robot_smoke_videos/unitree-g1/unitree-g1_combined_actions.telemetry.json",
    "multi_robot_video_unitree_h1_stand_up": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_stand_up.mp4",
    "multi_robot_video_unitree_h1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_walk_forward.mp4",
    "multi_robot_video_unitree_h1_turn_left": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_turn_left.mp4",
    "multi_robot_video_unitree_h1_turn_right": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_turn_right.mp4",
    "multi_robot_video_unitree_h1_combined": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_h1_stand_up": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_turn_left": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_turn_right": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_combined": "evidence/multi_robot_smoke_videos/unitree-h1/unitree-h1_combined_actions.telemetry.json",
    "multi_robot_video_unitree_r1_stand_up": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_stand_up.mp4",
    "multi_robot_video_unitree_r1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_walk_forward.mp4",
    "multi_robot_video_unitree_r1_turn_left": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_turn_left.mp4",
    "multi_robot_video_unitree_r1_turn_right": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_turn_right.mp4",
    "multi_robot_video_unitree_r1_combined": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_r1_stand_up": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_walk_forward": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_turn_left": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_turn_right": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_combined": "evidence/multi_robot_smoke_videos/unitree-r1/unitree-r1_combined_actions.telemetry.json",
    "production_video_review": "evidence/video_review_production/video_review.json",
    "production_video_contact_asimov_stand_up": "evidence/video_review_production/asimov-1_asimov-1_stand_up_contact.jpg",
    "production_video_contact_asimov_walk_forward": "evidence/video_review_production/asimov-1_asimov-1_walk_forward_contact.jpg",
    "production_video_contact_asimov_turn_left": "evidence/video_review_production/asimov-1_asimov-1_turn_left_contact.jpg",
    "production_video_contact_asimov_turn_right": "evidence/video_review_production/asimov-1_asimov-1_turn_right_contact.jpg",
    "production_video_contact_asimov_combined": "evidence/video_review_production/asimov-1_asimov-1_combined_actions_contact.jpg",
    "multi_robot_contact_hiwonder_stand_up": "evidence/multi_robot_smoke_review/hiwonder-ainex_hiwonder-ainex_stand_up_contact.jpg",
    "multi_robot_contact_hiwonder_walk_forward": "evidence/multi_robot_smoke_review/hiwonder-ainex_hiwonder-ainex_walk_forward_contact.jpg",
    "multi_robot_contact_hiwonder_turn_left": "evidence/multi_robot_smoke_review/hiwonder-ainex_hiwonder-ainex_turn_left_contact.jpg",
    "multi_robot_contact_hiwonder_turn_right": "evidence/multi_robot_smoke_review/hiwonder-ainex_hiwonder-ainex_turn_right_contact.jpg",
    "multi_robot_contact_hiwonder_combined": "evidence/multi_robot_smoke_review/hiwonder-ainex_hiwonder-ainex_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_g1_stand_up": "evidence/multi_robot_smoke_review/unitree-g1_unitree-g1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_g1_walk_forward": "evidence/multi_robot_smoke_review/unitree-g1_unitree-g1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_g1_turn_left": "evidence/multi_robot_smoke_review/unitree-g1_unitree-g1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_g1_turn_right": "evidence/multi_robot_smoke_review/unitree-g1_unitree-g1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_g1_combined": "evidence/multi_robot_smoke_review/unitree-g1_unitree-g1_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_h1_stand_up": "evidence/multi_robot_smoke_review/unitree-h1_unitree-h1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_h1_walk_forward": "evidence/multi_robot_smoke_review/unitree-h1_unitree-h1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_h1_turn_left": "evidence/multi_robot_smoke_review/unitree-h1_unitree-h1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_h1_turn_right": "evidence/multi_robot_smoke_review/unitree-h1_unitree-h1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_h1_combined": "evidence/multi_robot_smoke_review/unitree-h1_unitree-h1_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_r1_stand_up": "evidence/multi_robot_smoke_review/unitree-r1_unitree-r1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_r1_walk_forward": "evidence/multi_robot_smoke_review/unitree-r1_unitree-r1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_r1_turn_left": "evidence/multi_robot_smoke_review/unitree-r1_unitree-r1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_r1_turn_right": "evidence/multi_robot_smoke_review/unitree-r1_unitree-r1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_r1_combined": "evidence/multi_robot_smoke_review/unitree-r1_unitree-r1_combined_actions_contact.jpg",
    "monitor_status": "monitor_status.json",
    "monitor_summary": "monitor_summary.md",
    "validation_report": "validation_report.json",
    "validation_summary": "validation_summary.md",
    "finalization_report": "finalization_report.json",
    "finalization_summary": "finalization_summary.md",
    "training_comparison_report": "training_comparison_report.json",
    "training_comparison_summary": "training_comparison_report.md",
    "alberta_end_to_end_report_json": "evidence/ALBERTA_END_TO_END_REPORT.json",
    "alberta_end_to_end_report_md": "evidence/ALBERTA_END_TO_END_REPORT.md",
    "runtime_watch_history": "runtime_watch_history.jsonl",
    "instance_launch_hygiene": "instance_launch_hygiene.json",
}

PRODUCTION_VIDEO_COMMANDS = (
    ("stand_up", "stand_up"),
    ("walk_forward", "walk_forward"),
    ("walk_backward", "walk_backward"),
    ("sidestep_left", "sidestep_left"),
    ("sidestep_right", "sidestep_right"),
    ("turn_left", "turn_left"),
    ("turn_right", "turn_right"),
)
MULTI_ROBOT_VIDEO_PROFILES = (
    ("hiwonder", "hiwonder-ainex"),
    ("unitree_g1", "unitree-g1"),
    ("unitree_h1", "unitree-h1"),
    ("unitree_r1", "unitree-r1"),
)

for command_key, safe_command in PRODUCTION_VIDEO_COMMANDS:
    REQUIRED_ARTIFACTS.setdefault(
        f"production_video_asimov_{command_key}",
        f"evidence/agent_videos/asimov-1/asimov-1_{safe_command}.mp4",
    )
    REQUIRED_ARTIFACTS.setdefault(
        f"production_video_telemetry_asimov_{command_key}",
        f"evidence/agent_videos/asimov-1/asimov-1_{safe_command}.telemetry.json",
    )
    REQUIRED_ARTIFACTS.setdefault(
        f"production_video_contact_asimov_{command_key}",
        f"evidence/video_review_production/asimov-1_asimov-1_{safe_command}_contact.jpg",
    )

for profile_key, profile_id in MULTI_ROBOT_VIDEO_PROFILES:
    for command_key, safe_command in PRODUCTION_VIDEO_COMMANDS:
        REQUIRED_ARTIFACTS.setdefault(
            f"multi_robot_video_{profile_key}_{command_key}",
            (
                f"evidence/multi_robot_smoke_videos/{profile_id}/"
                f"{profile_id}_{safe_command}.mp4"
            ),
        )
        REQUIRED_ARTIFACTS.setdefault(
            f"multi_robot_video_telemetry_{profile_key}_{command_key}",
            (
                f"evidence/multi_robot_smoke_videos/{profile_id}/"
                f"{profile_id}_{safe_command}.telemetry.json"
            ),
        )
        REQUIRED_ARTIFACTS.setdefault(
            f"multi_robot_contact_{profile_key}_{command_key}",
            (
                f"evidence/multi_robot_smoke_review/{profile_id}_"
                f"{profile_id}_{safe_command}_contact.jpg"
            ),
        )


def _artifact_category(name: str) -> str:
    if name in {"status_success", "runner_status"} or name.startswith(("log_", "status_")):
        return "stage_status"
    if name.startswith("backend_comparison"):
        return "backend_comparison"
    if name.startswith("curriculum_eval"):
        return "curriculum_eval"
    if "benchmark" in name:
        return "continual_benchmarks"
    if "video" in name or "contact" in name:
        return "video_evidence"
    if name in {
        "monitor_status",
        "monitor_summary",
        "validation_report",
        "validation_summary",
        "finalization_report",
        "finalization_summary",
        "training_comparison_report",
        "training_comparison_summary",
        "alberta_end_to_end_report_json",
        "alberta_end_to_end_report_md",
        "runtime_watch_history",
        "instance_launch_hygiene",
    }:
        return "review_reports"
    if name.startswith("alberta_") or name.startswith("brax_"):
        return "checkpoints"
    return "training_inputs"


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _artifact_semantic_status(name: str, path: Path, present: bool) -> tuple[bool, str | None]:
    if not present:
        return False, "missing"
    if name == "curriculum_eval_report":
        payload = _read_json_object(path)
        if not payload:
            return False, "invalid_json_object"
        if payload.get("schema") != CURRICULUM_EVAL_SCHEMA:
            return False, "schema_mismatch"
        if not isinstance(payload.get("tasks"), list):
            return False, "tasks_not_list"
        return True, None
    if name == "curriculum_eval_native":
        payload = _read_json_object(path)
        if not payload:
            return False, "invalid_json_object"
        if payload.get("schema") != TEXT_POLICY_EVAL_SCHEMA:
            return False, "schema_mismatch"
        if not isinstance(payload.get("tasks"), dict):
            return False, "tasks_not_object"
        return True, None
    if name not in {
        "validation_report",
        "finalization_report",
        "training_comparison_report",
        "production_video_review",
    }:
        return True, None
    payload = _read_json_object(path)
    if not payload:
        return False, "invalid_json_object"
    if payload.get("ok") is not True:
        return False, "ok_not_true"
    return True, None


def inventory_nebius_training_artifacts(run_root: Path) -> dict[str, Any]:
    run_root = run_root.resolve()
    artifacts = []
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run_root / rel
        size = path.stat().st_size if path.is_file() else 0
        present = path.is_file() and size > 0
        semantic_ok, semantic_reason = _artifact_semantic_status(name, path, present)
        artifacts.append(
            {
                "name": name,
                "category": _artifact_category(name),
                "path": rel,
                "present": present,
                "semantic_ok": semantic_ok,
                "semantic_reason": semantic_reason,
                "bytes": size,
            }
        )
    present = [item["name"] for item in artifacts if item["present"]]
    missing = [item["name"] for item in artifacts if not item["present"]]
    semantic_failed = [
        item["name"]
        for item in artifacts
        if item["present"] and item["semantic_ok"] is not True
    ]
    categories: dict[str, dict[str, Any]] = {}
    for item in artifacts:
        category = str(item["category"])
        summary = categories.setdefault(
            category,
            {
                "present_count": 0,
                "semantic_ok_count": 0,
                "required_count": 0,
                "missing": [],
                "semantic_failed": [],
            },
        )
        summary["required_count"] += 1
        if item["present"]:
            summary["present_count"] += 1
            if item["semantic_ok"]:
                summary["semantic_ok_count"] += 1
            else:
                summary["semantic_failed"].append(item["name"])
        else:
            summary["missing"].append(item["name"])
    return {
        "schema": "robot-nebius-training-artifact-inventory-v1",
        "ok": not missing and not semantic_failed,
        "run_root": str(run_root),
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "present_count": len(present),
        "semantic_ok_count": len(artifacts) - len(missing) - len(semantic_failed),
        "required_count": len(artifacts),
        "categories": categories,
        "present": present,
        "missing": missing,
        "semantic_failed": semantic_failed,
        "artifacts": artifacts,
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Nebius Training Artifact Inventory",
        "",
        f"Result: `{'complete' if report.get('ok') else 'incomplete'}`",
        f"Present: `{report.get('present_count')}` / `{report.get('required_count')}`",
        f"Generated: `{report.get('generated_at')}`",
        "",
        "## Category Summary",
        "",
        "| category | present | semantic ok | required | missing | semantic failed |",
        "|---|---:|---:|---:|---|---|",
    ]
    categories = report.get("categories") if isinstance(report.get("categories"), dict) else {}
    for name in sorted(categories):
        item = categories[name]
        if not isinstance(item, dict):
            continue
        lines.append(
            f"| `{name}` | `{int(item.get('present_count') or 0)}` | "
            f"`{int(item.get('semantic_ok_count') or 0)}` | "
            f"`{int(item.get('required_count') or 0)}` | "
            f"`{', '.join(map(str, item.get('missing') or [])) or 'none'}` | "
            f"`{', '.join(map(str, item.get('semantic_failed') or [])) or 'none'}` |"
        )
    lines += [
        "",
        "## Artifact Detail",
        "",
        "| artifact | present | semantic ok | reason | bytes | path |",
        "|---|---:|---:|---|---:|---|",
    ]
    for item in report.get("artifacts", []):
        lines.append(
            f"| `{item['name']}` | `{bool(item['present'])}` | "
            f"`{bool(item.get('semantic_ok'))}` | "
            f"`{item.get('semantic_reason') or 'none'}` | "
            f"`{int(item['bytes'])}` | `{item['path']}` |"
        )
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
    report = inventory_nebius_training_artifacts(args.run_root)
    json_path = args.run_root / "artifact_inventory.json"
    md_path = args.run_root / "artifact_inventory.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, md_path)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
