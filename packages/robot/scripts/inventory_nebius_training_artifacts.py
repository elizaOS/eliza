#!/usr/bin/env python3
"""Inventory required Nebius robot training artifacts in a synced run tree."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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
    "multi_robot_video_hiwonder_stand_up": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_stand_up.mp4",
    "multi_robot_video_hiwonder_walk_forward": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.mp4",
    "multi_robot_video_hiwonder_turn_left": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_left.mp4",
    "multi_robot_video_hiwonder_turn_right": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_right.mp4",
    "multi_robot_video_hiwonder_combined": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.mp4",
    "multi_robot_video_telemetry_hiwonder_stand_up": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_stand_up.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_walk_forward": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_turn_left": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_left.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_turn_right": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_turn_right.telemetry.json",
    "multi_robot_video_telemetry_hiwonder_combined": "evidence/agent_videos/hiwonder-ainex/hiwonder-ainex_combined_actions.telemetry.json",
    "multi_robot_video_unitree_g1_stand_up": "evidence/agent_videos/unitree-g1/unitree-g1_stand_up.mp4",
    "multi_robot_video_unitree_g1_walk_forward": "evidence/agent_videos/unitree-g1/unitree-g1_walk_forward.mp4",
    "multi_robot_video_unitree_g1_turn_left": "evidence/agent_videos/unitree-g1/unitree-g1_turn_left.mp4",
    "multi_robot_video_unitree_g1_turn_right": "evidence/agent_videos/unitree-g1/unitree-g1_turn_right.mp4",
    "multi_robot_video_unitree_g1_combined": "evidence/agent_videos/unitree-g1/unitree-g1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_g1_stand_up": "evidence/agent_videos/unitree-g1/unitree-g1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_walk_forward": "evidence/agent_videos/unitree-g1/unitree-g1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_turn_left": "evidence/agent_videos/unitree-g1/unitree-g1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_turn_right": "evidence/agent_videos/unitree-g1/unitree-g1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_g1_combined": "evidence/agent_videos/unitree-g1/unitree-g1_combined_actions.telemetry.json",
    "multi_robot_video_unitree_h1_stand_up": "evidence/agent_videos/unitree-h1/unitree-h1_stand_up.mp4",
    "multi_robot_video_unitree_h1_walk_forward": "evidence/agent_videos/unitree-h1/unitree-h1_walk_forward.mp4",
    "multi_robot_video_unitree_h1_turn_left": "evidence/agent_videos/unitree-h1/unitree-h1_turn_left.mp4",
    "multi_robot_video_unitree_h1_turn_right": "evidence/agent_videos/unitree-h1/unitree-h1_turn_right.mp4",
    "multi_robot_video_unitree_h1_combined": "evidence/agent_videos/unitree-h1/unitree-h1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_h1_stand_up": "evidence/agent_videos/unitree-h1/unitree-h1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_walk_forward": "evidence/agent_videos/unitree-h1/unitree-h1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_turn_left": "evidence/agent_videos/unitree-h1/unitree-h1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_turn_right": "evidence/agent_videos/unitree-h1/unitree-h1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_h1_combined": "evidence/agent_videos/unitree-h1/unitree-h1_combined_actions.telemetry.json",
    "multi_robot_video_unitree_r1_stand_up": "evidence/agent_videos/unitree-r1/unitree-r1_stand_up.mp4",
    "multi_robot_video_unitree_r1_walk_forward": "evidence/agent_videos/unitree-r1/unitree-r1_walk_forward.mp4",
    "multi_robot_video_unitree_r1_turn_left": "evidence/agent_videos/unitree-r1/unitree-r1_turn_left.mp4",
    "multi_robot_video_unitree_r1_turn_right": "evidence/agent_videos/unitree-r1/unitree-r1_turn_right.mp4",
    "multi_robot_video_unitree_r1_combined": "evidence/agent_videos/unitree-r1/unitree-r1_combined_actions.mp4",
    "multi_robot_video_telemetry_unitree_r1_stand_up": "evidence/agent_videos/unitree-r1/unitree-r1_stand_up.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_walk_forward": "evidence/agent_videos/unitree-r1/unitree-r1_walk_forward.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_turn_left": "evidence/agent_videos/unitree-r1/unitree-r1_turn_left.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_turn_right": "evidence/agent_videos/unitree-r1/unitree-r1_turn_right.telemetry.json",
    "multi_robot_video_telemetry_unitree_r1_combined": "evidence/agent_videos/unitree-r1/unitree-r1_combined_actions.telemetry.json",
    "production_video_review": "evidence/video_review_production/video_review.json",
    "production_video_contact_asimov_stand_up": "evidence/video_review_production/asimov-1_asimov-1_stand_up_contact.jpg",
    "production_video_contact_asimov_walk_forward": "evidence/video_review_production/asimov-1_asimov-1_walk_forward_contact.jpg",
    "production_video_contact_asimov_turn_left": "evidence/video_review_production/asimov-1_asimov-1_turn_left_contact.jpg",
    "production_video_contact_asimov_turn_right": "evidence/video_review_production/asimov-1_asimov-1_turn_right_contact.jpg",
    "production_video_contact_asimov_combined": "evidence/video_review_production/asimov-1_asimov-1_combined_actions_contact.jpg",
    "multi_robot_contact_hiwonder_stand_up": "evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_stand_up_contact.jpg",
    "multi_robot_contact_hiwonder_walk_forward": "evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_walk_forward_contact.jpg",
    "multi_robot_contact_hiwonder_turn_left": "evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_left_contact.jpg",
    "multi_robot_contact_hiwonder_turn_right": "evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_turn_right_contact.jpg",
    "multi_robot_contact_hiwonder_combined": "evidence/video_review_production/hiwonder-ainex_hiwonder-ainex_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_g1_stand_up": "evidence/video_review_production/unitree-g1_unitree-g1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_g1_walk_forward": "evidence/video_review_production/unitree-g1_unitree-g1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_g1_turn_left": "evidence/video_review_production/unitree-g1_unitree-g1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_g1_turn_right": "evidence/video_review_production/unitree-g1_unitree-g1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_g1_combined": "evidence/video_review_production/unitree-g1_unitree-g1_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_h1_stand_up": "evidence/video_review_production/unitree-h1_unitree-h1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_h1_walk_forward": "evidence/video_review_production/unitree-h1_unitree-h1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_h1_turn_left": "evidence/video_review_production/unitree-h1_unitree-h1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_h1_turn_right": "evidence/video_review_production/unitree-h1_unitree-h1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_h1_combined": "evidence/video_review_production/unitree-h1_unitree-h1_combined_actions_contact.jpg",
    "multi_robot_contact_unitree_r1_stand_up": "evidence/video_review_production/unitree-r1_unitree-r1_stand_up_contact.jpg",
    "multi_robot_contact_unitree_r1_walk_forward": "evidence/video_review_production/unitree-r1_unitree-r1_walk_forward_contact.jpg",
    "multi_robot_contact_unitree_r1_turn_left": "evidence/video_review_production/unitree-r1_unitree-r1_turn_left_contact.jpg",
    "multi_robot_contact_unitree_r1_turn_right": "evidence/video_review_production/unitree-r1_unitree-r1_turn_right_contact.jpg",
    "multi_robot_contact_unitree_r1_combined": "evidence/video_review_production/unitree-r1_unitree-r1_combined_actions_contact.jpg",
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


def _artifact_category(name: str) -> str:
    if name in {"status_success", "runner_status"} or name.startswith(("log_", "status_")):
        return "stage_status"
    if name.startswith("backend_comparison"):
        return "backend_comparison"
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


def inventory_nebius_training_artifacts(run_root: Path) -> dict[str, Any]:
    run_root = run_root.resolve()
    artifacts = []
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run_root / rel
        size = path.stat().st_size if path.is_file() else 0
        present = path.is_file() and size > 0
        artifacts.append(
            {
                "name": name,
                "category": _artifact_category(name),
                "path": rel,
                "present": present,
                "bytes": size,
            }
        )
    present = [item["name"] for item in artifacts if item["present"]]
    missing = [item["name"] for item in artifacts if not item["present"]]
    categories: dict[str, dict[str, Any]] = {}
    for item in artifacts:
        category = str(item["category"])
        summary = categories.setdefault(
            category,
            {"present_count": 0, "required_count": 0, "missing": []},
        )
        summary["required_count"] += 1
        if item["present"]:
            summary["present_count"] += 1
        else:
            summary["missing"].append(item["name"])
    return {
        "schema": "robot-nebius-training-artifact-inventory-v1",
        "ok": not missing,
        "run_root": str(run_root),
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "present_count": len(present),
        "required_count": len(artifacts),
        "categories": categories,
        "present": present,
        "missing": missing,
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
        "| category | present | required | missing |",
        "|---|---:|---:|---|",
    ]
    categories = report.get("categories") if isinstance(report.get("categories"), dict) else {}
    for name in sorted(categories):
        item = categories[name]
        if not isinstance(item, dict):
            continue
        lines.append(
            f"| `{name}` | `{int(item.get('present_count') or 0)}` | "
            f"`{int(item.get('required_count') or 0)}` | "
            f"`{', '.join(map(str, item.get('missing') or [])) or 'none'}` |"
        )
    lines += [
        "",
        "## Artifact Detail",
        "",
        "| artifact | present | bytes | path |",
        "|---|---:|---:|---|",
    ]
    for item in report.get("artifacts", []):
        lines.append(
            f"| `{item['name']}` | `{bool(item['present'])}` | `{int(item['bytes'])}` | `{item['path']}` |"
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
