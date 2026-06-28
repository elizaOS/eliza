from __future__ import annotations

import json
from pathlib import Path

from scripts.inventory_nebius_training_artifacts import (
    REQUIRED_ARTIFACTS,
    inventory_nebius_training_artifacts,
    main,
    write_markdown,
)


def test_inventory_reports_missing_artifacts(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "status").mkdir(parents=True)
    (run / "status" / "success.txt").write_text("SUCCESS\n")

    report = inventory_nebius_training_artifacts(run)

    assert report["ok"] is False
    assert "status_success" in report["present"]
    assert "alberta_policy" in report["missing"]
    assert report["categories"]["stage_status"]["present_count"] == 1
    assert "alberta_policy" in report["categories"]["checkpoints"]["missing"]


def test_inventory_accepts_complete_artifact_tree(tmp_path: Path) -> None:
    run = tmp_path / "run"
    semantic_ok_reports = {
        "validation_report": {"ok": True},
        "finalization_report": {"ok": True},
        "training_comparison_report": {"ok": True},
        "production_video_review": {"ok": True},
    }
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in semantic_ok_reports:
            path.write_text(json.dumps(semantic_ok_reports[name]) + "\n")
        elif name == "curriculum_eval_report":
            path.write_text(
                json.dumps(
                    {
                        "schema": "robot-policy-curriculum-eval-v1",
                        "tasks": [],
                    }
                )
                + "\n"
            )
        elif name == "curriculum_eval_native":
            path.write_text(
                json.dumps(
                    {
                        "schema": "robot-text-policy-eval-v1",
                        "tasks": {},
                    }
                )
                + "\n"
            )
        else:
            path.write_text("artifact\n")

    report = inventory_nebius_training_artifacts(run)
    write_markdown(report, run / "inventory.md")

    assert report["ok"] is True
    assert report["present_count"] == report["required_count"]
    assert report["semantic_ok_count"] == report["required_count"]
    markdown = (run / "inventory.md").read_text()
    assert "complete" in markdown
    assert "Category Summary" in markdown
    assert "Artifact Detail" in markdown


def test_inventory_rejects_zero_byte_required_artifacts(tmp_path: Path) -> None:
    run = tmp_path / "run"
    for rel in REQUIRED_ARTIFACTS.values():
        path = run / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("artifact\n")
    (run / REQUIRED_ARTIFACTS["alberta_policy"]).write_bytes(b"")

    report = inventory_nebius_training_artifacts(run)

    assert report["ok"] is False
    assert "alberta_policy" in report["missing"]
    artifact = next(
        item for item in report["artifacts"] if item["name"] == "alberta_policy"
    )
    assert artifact["present"] is False
    assert artifact["bytes"] == 0


def test_inventory_rejects_false_review_reports(tmp_path: Path) -> None:
    run = tmp_path / "run"
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in {
            "validation_report",
            "finalization_report",
            "training_comparison_report",
            "production_video_review",
        }:
            path.write_text(json.dumps({"ok": True}) + "\n")
        else:
            path.write_text("artifact\n")
    (run / REQUIRED_ARTIFACTS["validation_report"]).write_text('{"ok": false}\n')

    report = inventory_nebius_training_artifacts(run)

    assert report["ok"] is False
    assert "validation_report" in report["present"]
    assert "validation_report" not in report["missing"]
    assert "validation_report" in report["semantic_failed"]
    artifact = next(
        item for item in report["artifacts"] if item["name"] == "validation_report"
    )
    assert artifact["present"] is True
    assert artifact["semantic_ok"] is False
    assert artifact["semantic_reason"] == "ok_not_true"


def test_inventory_rejects_false_production_video_review(tmp_path: Path) -> None:
    run = tmp_path / "run"
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in {
            "validation_report",
            "finalization_report",
            "training_comparison_report",
            "production_video_review",
        }:
            path.write_text(json.dumps({"ok": True}) + "\n")
        else:
            path.write_text("artifact\n")
    (run / REQUIRED_ARTIFACTS["production_video_review"]).write_text(
        '{"ok": false}\n'
    )

    report = inventory_nebius_training_artifacts(run)

    assert report["ok"] is False
    assert "production_video_review" in report["semantic_failed"]


def test_inventory_does_not_require_closeout_status_it_writes_later() -> None:
    assert "closeout_status" not in REQUIRED_ARTIFACTS
    assert "closeout_status.json" not in REQUIRED_ARTIFACTS.values()


def test_inventory_requires_instance_launch_hygiene_report() -> None:
    assert REQUIRED_ARTIFACTS["instance_launch_hygiene"] == "instance_launch_hygiene.json"


def test_inventory_requires_alberta_end_to_end_reports(tmp_path: Path) -> None:
    assert REQUIRED_ARTIFACTS["alberta_end_to_end_report_json"] == (
        "evidence/ALBERTA_END_TO_END_REPORT.json"
    )
    assert REQUIRED_ARTIFACTS["alberta_end_to_end_report_md"] == (
        "evidence/ALBERTA_END_TO_END_REPORT.md"
    )
    run = tmp_path / "run"
    report = inventory_nebius_training_artifacts(run)
    assert "alberta_end_to_end_report_json" in report["categories"]["review_reports"]["missing"]
    assert "alberta_end_to_end_report_md" in report["categories"]["review_reports"]["missing"]


def test_inventory_requires_obstacle_course_demo_artifacts() -> None:
    assert REQUIRED_ARTIFACTS["obstacle_course_demo_json"] == (
        "evidence/alberta_obstacle_course/obstacle_course_demo.json"
    )
    assert REQUIRED_ARTIFACTS["obstacle_course_demo_video"] == (
        "evidence/alberta_obstacle_course/obstacle_course_demo.mp4"
    )


def test_inventory_requires_curriculum_eval_artifacts(tmp_path: Path) -> None:
    assert REQUIRED_ARTIFACTS["curriculum_eval_report"] == (
        "evidence/curriculum_eval/report.json"
    )
    assert REQUIRED_ARTIFACTS["curriculum_eval_native"] == (
        "evidence/curriculum_eval/eval_text_policy.json"
    )

    report = inventory_nebius_training_artifacts(tmp_path / "run")

    missing = report["categories"]["curriculum_eval"]["missing"]
    assert "curriculum_eval_report" in missing
    assert "curriculum_eval_native" in missing


def test_inventory_rejects_curriculum_eval_schema_mismatch(tmp_path: Path) -> None:
    run = tmp_path / "run"
    for name, rel in REQUIRED_ARTIFACTS.items():
        path = run / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in {
            "validation_report",
            "finalization_report",
            "training_comparison_report",
        }:
            path.write_text(json.dumps({"ok": True}) + "\n")
        elif name == "curriculum_eval_report":
            path.write_text(
                json.dumps({"schema": "robot-text-policy-eval-v1", "tasks": []})
                + "\n"
            )
        elif name == "curriculum_eval_native":
            path.write_text(
                json.dumps(
                    {
                        "schema": "robot-text-policy-eval-v1",
                        "tasks": {},
                    }
                )
                + "\n"
            )
        else:
            path.write_text("artifact\n")

    report = inventory_nebius_training_artifacts(run)

    assert report["ok"] is False
    assert "curriculum_eval_report" in report["semantic_failed"]
    artifact = next(
        item
        for item in report["artifacts"]
        if item["name"] == "curriculum_eval_report"
    )
    assert artifact["semantic_reason"] == "schema_mismatch"


def test_inventory_requires_stage_status_reports() -> None:
    required = {
        "runner_status",
        "status_00_local_preflight",
        "status_10_nebius_train_alberta",
        "status_20_nebius_compare_backends",
        "status_30_nebius_continual_benchmarks",
        "status_40_nebius_brax_baseline",
        "status_50_post_train_validation",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_production_video_contact_sheets() -> None:
    required = {
        "production_video_contact_asimov_stand_up",
        "production_video_contact_asimov_walk_forward",
        "production_video_contact_asimov_turn_left",
        "production_video_contact_asimov_turn_right",
        "production_video_contact_asimov_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_production_video_mp4s() -> None:
    required = {
        "production_video_asimov_stand_up",
        "production_video_asimov_walk_forward",
        "production_video_asimov_turn_left",
        "production_video_asimov_turn_right",
        "production_video_asimov_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_production_video_telemetry_sidecars() -> None:
    required = {
        "production_video_telemetry_asimov_stand_up",
        "production_video_telemetry_asimov_walk_forward",
        "production_video_telemetry_asimov_turn_left",
        "production_video_telemetry_asimov_turn_right",
        "production_video_telemetry_asimov_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_all_seven_production_video_commands() -> None:
    commands = {
        "stand_up",
        "walk_forward",
        "walk_backward",
        "sidestep_left",
        "sidestep_right",
        "turn_left",
        "turn_right",
    }
    for command in commands:
        assert f"production_video_asimov_{command}" in REQUIRED_ARTIFACTS
        assert f"production_video_telemetry_asimov_{command}" in REQUIRED_ARTIFACTS
        assert f"production_video_contact_asimov_{command}" in REQUIRED_ARTIFACTS
        for profile_key in ("hiwonder", "unitree_g1", "unitree_h1", "unitree_r1"):
            assert f"multi_robot_video_{profile_key}_{command}" in REQUIRED_ARTIFACTS
            assert (
                f"multi_robot_video_telemetry_{profile_key}_{command}"
                in REQUIRED_ARTIFACTS
            )
            assert f"multi_robot_contact_{profile_key}_{command}" in REQUIRED_ARTIFACTS


def test_inventory_requires_non_asimov_multi_robot_video_mp4s() -> None:
    required = {
        "multi_robot_video_hiwonder_stand_up",
        "multi_robot_video_hiwonder_walk_forward",
        "multi_robot_video_hiwonder_turn_left",
        "multi_robot_video_hiwonder_turn_right",
        "multi_robot_video_hiwonder_combined",
        "multi_robot_video_unitree_g1_stand_up",
        "multi_robot_video_unitree_g1_walk_forward",
        "multi_robot_video_unitree_g1_turn_left",
        "multi_robot_video_unitree_g1_turn_right",
        "multi_robot_video_unitree_g1_combined",
        "multi_robot_video_unitree_h1_stand_up",
        "multi_robot_video_unitree_h1_walk_forward",
        "multi_robot_video_unitree_h1_turn_left",
        "multi_robot_video_unitree_h1_turn_right",
        "multi_robot_video_unitree_h1_combined",
        "multi_robot_video_unitree_r1_stand_up",
        "multi_robot_video_unitree_r1_walk_forward",
        "multi_robot_video_unitree_r1_turn_left",
        "multi_robot_video_unitree_r1_turn_right",
        "multi_robot_video_unitree_r1_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_non_asimov_multi_robot_video_telemetry_sidecars() -> None:
    required = {
        "multi_robot_video_telemetry_hiwonder_stand_up",
        "multi_robot_video_telemetry_hiwonder_walk_forward",
        "multi_robot_video_telemetry_hiwonder_turn_left",
        "multi_robot_video_telemetry_hiwonder_turn_right",
        "multi_robot_video_telemetry_hiwonder_combined",
        "multi_robot_video_telemetry_unitree_g1_stand_up",
        "multi_robot_video_telemetry_unitree_g1_walk_forward",
        "multi_robot_video_telemetry_unitree_g1_turn_left",
        "multi_robot_video_telemetry_unitree_g1_turn_right",
        "multi_robot_video_telemetry_unitree_g1_combined",
        "multi_robot_video_telemetry_unitree_h1_stand_up",
        "multi_robot_video_telemetry_unitree_h1_walk_forward",
        "multi_robot_video_telemetry_unitree_h1_turn_left",
        "multi_robot_video_telemetry_unitree_h1_turn_right",
        "multi_robot_video_telemetry_unitree_h1_combined",
        "multi_robot_video_telemetry_unitree_r1_stand_up",
        "multi_robot_video_telemetry_unitree_r1_walk_forward",
        "multi_robot_video_telemetry_unitree_r1_turn_left",
        "multi_robot_video_telemetry_unitree_r1_turn_right",
        "multi_robot_video_telemetry_unitree_r1_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_requires_non_asimov_multi_robot_contact_sheets() -> None:
    required = {
        "multi_robot_contact_hiwonder_stand_up",
        "multi_robot_contact_hiwonder_walk_forward",
        "multi_robot_contact_hiwonder_turn_left",
        "multi_robot_contact_hiwonder_turn_right",
        "multi_robot_contact_hiwonder_combined",
        "multi_robot_contact_unitree_g1_stand_up",
        "multi_robot_contact_unitree_g1_walk_forward",
        "multi_robot_contact_unitree_g1_turn_left",
        "multi_robot_contact_unitree_g1_turn_right",
        "multi_robot_contact_unitree_g1_combined",
        "multi_robot_contact_unitree_h1_stand_up",
        "multi_robot_contact_unitree_h1_walk_forward",
        "multi_robot_contact_unitree_h1_turn_left",
        "multi_robot_contact_unitree_h1_turn_right",
        "multi_robot_contact_unitree_h1_combined",
        "multi_robot_contact_unitree_r1_stand_up",
        "multi_robot_contact_unitree_r1_walk_forward",
        "multi_robot_contact_unitree_r1_turn_left",
        "multi_robot_contact_unitree_r1_turn_right",
        "multi_robot_contact_unitree_r1_combined",
    }

    assert required.issubset(REQUIRED_ARTIFACTS)


def test_inventory_cli_returns_two_for_incomplete_tree(tmp_path: Path) -> None:
    run = tmp_path / "run"
    run.mkdir()

    assert main([str(run)]) == 2
    assert (run / "artifact_inventory.json").is_file()
    assert (run / "artifact_inventory.md").is_file()
