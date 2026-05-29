from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from eliza_robot.profiles.schema import load_profile
from scripts.validate_multi_robot_training_readiness import (
    DEFAULT_COMMANDS as DEFAULT_MULTI_ROBOT_COMMANDS,
)
from scripts.validate_multi_robot_training_readiness import (
    DEFAULT_PROFILES as DEFAULT_MULTI_ROBOT_PROFILES,
)
from scripts.validate_nebius_full_training_run import (
    STAGES,
    _policy_video_motion_checks,
    _validate_curriculum_eval_report,
    _validate_production_contract,
    _validate_production_policy_videos,
    _validate_status_consistency,
    _validate_text_policy_eval_report,
    sync_from_s3,
    validate_nebius_full_training_run,
)


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _task_physical_checks(task: str, *, eval_report: bool = False) -> dict[str, bool]:
    locomotion_support = {
        "min_swing_foot_clearance_m": True,
        "max_foot_slip_m_s": True,
        "max_self_collision_count": True,
    }
    checks = {
        "episodes": True,
        "success_rate_full": True,
        "failure_rate_zero": True,
    } if eval_report else {}
    if task == "stand_up":
        checks.update(
            {
                "hold_s": True,
                "torso_height_gain": True,
                "tracked_height_gain": True,
            }
        )
        if eval_report:
            checks.update(
                {
                    "torso_height_finite_positive": True,
                    "tracked_height_finite_positive": True,
                }
            )
    elif task == "walk_forward":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "min_alternating_foot_contacts": True,
                "tracked_height_present": True,
                "tracked_delta_x_forward": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
                **locomotion_support,
            }
        )
    elif task == "walk_backward":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "min_alternating_foot_contacts": True,
                "tracked_height_present": True,
                "tracked_delta_x_backward": True,
                "tracked_lateral_drift_bound": True,
                "yaw_drift_bound": True,
                **locomotion_support,
            }
        )
    elif task == "sidestep_left":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "min_alternating_foot_contacts": True,
                "tracked_height_present": True,
                "tracked_delta_y_left": True,
                "tracked_forward_drift_bound": True,
                "yaw_drift_bound": True,
                **locomotion_support,
            }
        )
    elif task == "sidestep_right":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "min_alternating_foot_contacts": True,
                "tracked_height_present": True,
                "tracked_delta_y_right": True,
                "tracked_forward_drift_bound": True,
                "yaw_drift_bound": True,
                **locomotion_support,
            }
        )
    elif task == "turn_left":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "tracked_height_present": True,
                "delta_yaw_left": True,
                "tracked_translation_drift_bound": True,
            }
        )
    elif task == "turn_right":
        checks.update(
            {
                "no_fall": True,
                "hold_s": True,
                "tracked_height_present": True,
                "delta_yaw_right": True,
                "tracked_translation_drift_bound": True,
            }
        )
    return checks


def _task_motion_fields(task: str, profile_id: str) -> dict[str, float | str]:
    tracked_body_name = load_profile(profile_id).sensors.locomotion_tracking_body
    delta_x, delta_y, delta_yaw = _task_motion(task)
    fields: dict[str, float | str] = {
        "mean_final_delta_x_m": delta_x,
        "mean_final_delta_y_m": delta_y,
        "mean_final_delta_yaw_rad": delta_yaw,
        "mean_final_torso_z_m": 1.0,
        "mean_final_torso_z_delta_m": 0.0,
        "mean_final_tracked_delta_x_m": delta_x,
        "mean_final_tracked_delta_y_m": delta_y,
        "mean_final_tracked_delta_z_m": 0.0,
        "mean_final_tracked_z_m": 1.0,
        "tracked_body_name": tracked_body_name,
    }
    if task == "stand_up":
        fields.update(
            {
                "mean_final_torso_z_delta_m": 0.1,
                "mean_final_tracked_delta_z_m": 0.1,
            }
        )
    return fields


def _valid_curriculum_eval_report(
    *,
    checkpoint: Path,
    profile_id: str = "asimov-1",
    tasks: tuple[str, ...] = ("stand_up", "walk_forward"),
) -> dict:
    return {
        "schema": "robot-policy-curriculum-eval-v1",
        "source": "eval_text_policy",
        "profile_id": profile_id,
        "policy": "checkpoint:asimov_1_alberta_full",
        "checkpoint": str(checkpoint),
        "n_tasks": len(tasks),
        "n_programmatic_pass": len(tasks),
        "programmatic_pass_rate": 1.0,
        "mean_success_rate_overall": 1.0,
        "tasks": [
            {
                "task_id": task,
                "success_programmatic": True,
                "physical_success": True,
                "physical_checks": _task_physical_checks(task, eval_report=True),
                "success_rate": 1.0,
                "failure_rate": 0.0,
                "episodes": 2,
                "error": None,
                **_task_motion_fields(task, profile_id),
            }
            for task in tasks
        ],
    }


def test_curriculum_eval_gate_rejects_missing_physical_success(tmp_path: Path) -> None:
    checkpoint = tmp_path / "ckpt"
    checkpoint.mkdir()
    report = _valid_curriculum_eval_report(checkpoint=checkpoint)
    report["tasks"][1]["physical_success"] = False
    report["tasks"][1]["physical_checks"]["tracked_delta_x_forward"] = False
    path = tmp_path / "evidence" / "curriculum_eval" / "report.json"
    _write_json(path, report)

    validation = _validate_curriculum_eval_report(
        path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert validation["ok"] is False
    assert validation["checks"]["all_requested_tasks_physical_success"] is False
    assert validation["task_checks"]["walk_forward"] is False


def test_curriculum_eval_gate_rejects_extra_failed_physical_check(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "ckpt"
    checkpoint.mkdir()
    report = _valid_curriculum_eval_report(checkpoint=checkpoint)
    report["tasks"][1]["physical_checks"]["unexpected_extra_check"] = False
    path = tmp_path / "evidence" / "curriculum_eval" / "report.json"
    _write_json(path, report)

    validation = _validate_curriculum_eval_report(
        path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert validation["ok"] is False
    assert validation["checks"]["all_requested_tasks_physical_success"] is False
    assert validation["task_checks"]["walk_forward"] is False


def test_curriculum_eval_gate_rejects_boolean_only_physical_evidence(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "ckpt"
    checkpoint.mkdir()
    report = _valid_curriculum_eval_report(checkpoint=checkpoint)
    for key in tuple(report["tasks"][1]):
        if key.startswith("mean_final_") or key == "tracked_body_name":
            report["tasks"][1].pop(key)
    path = tmp_path / "evidence" / "curriculum_eval" / "report.json"
    _write_json(path, report)

    validation = _validate_curriculum_eval_report(
        path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert validation["ok"] is False
    assert validation["checks"]["all_requested_tasks_numeric_motion"] is False
    assert validation["checks"]["all_requested_tasks_tracked_body"] is False
    assert "mean_final_tracked_delta_x_m" in validation[
        "numeric_task_fail_reasons"
    ]["walk_forward"]


def test_curriculum_eval_gate_rejects_wrong_tracking_body(tmp_path: Path) -> None:
    checkpoint = tmp_path / "ckpt"
    checkpoint.mkdir()
    report = _valid_curriculum_eval_report(checkpoint=checkpoint)
    report["tasks"][0]["tracked_body_name"] = "base_link"
    path = tmp_path / "evidence" / "curriculum_eval" / "report.json"
    _write_json(path, report)

    validation = _validate_curriculum_eval_report(
        path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert validation["ok"] is False
    assert validation["checks"]["all_requested_tasks_tracked_body"] is False
    assert validation["numeric_task_fail_reasons"]["stand_up"] == [
        "tracked_body_name"
    ]


def _valid_text_policy_eval_report(
    *,
    checkpoint: Path,
    profile_id: str = "asimov-1",
    tasks: tuple[str, ...] = ("stand_up", "walk_forward"),
) -> dict:
    return {
        "schema": "robot-text-policy-eval-v1",
        "profile_id": profile_id,
        "env": "asimov_mjx",
        "checkpoint": str(checkpoint),
        "policy": "alberta_streaming",
        "tasks": {
            task: {
                "mean_reward": 1.0,
                "mean_steps_survived": 20.0,
                "success_rate": 1.0,
                "failure_rate": 0.0,
                "episodes": 2,
                **_task_motion_fields(task, profile_id),
            }
            for task in tasks
        },
        "mean_reward_overall": 1.0,
        "mean_success_rate_overall": 1.0,
    }


def _write_moving_video(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        30.0,
        (64, 48),
    )
    assert writer.isOpened()
    for i in range(8):
        frame = np.zeros((48, 64, 3), dtype=np.uint8)
        frame[10:30, 5 + i : 25 + i] = (255, 255, 255)
        writer.write(frame)
    writer.release()


def _write_video_telemetry(
    path: Path,
    *,
    profile: str = "asimov-1",
    task_id: str = "stand_up",
    policy_source: str = "checkpoint:asimov_1_alberta_full",
) -> None:
    delta_x, delta_y, delta_yaw = _task_motion(task_id)
    tracked_body_name = load_profile(profile).sensors.locomotion_tracking_body
    torso_z = {"min": 0.9, "max": 1.0, "final": 1.0, "mean": 0.95} if task_id == "stand_up" else {"min": 1.0, "max": 1.0, "final": 1.0, "mean": 1.0}
    tracked_delta_z = _summary(0.1) if task_id == "stand_up" else _summary(0.0)
    _write_json(
        path,
        {
            "profile": profile,
            "task_id": task_id,
            "policy_source": policy_source,
            "rollout_ok": True,
            "steps_requested": 8,
            "steps_executed": 8,
            "terminated": False,
            "goal_success": True,
            "attempted_action": True,
            "nonzero_action_steps": 8,
            "torso_z": torso_z,
            "tracked_body_name": tracked_body_name,
            "tracked_z_m": torso_z,
            "tracked_delta_x_m": _summary(delta_x),
            "tracked_delta_y_m": _summary(delta_y),
            "tracked_delta_z_m": tracked_delta_z,
            "upright_proj": {"min": 1.0, "final": 1.0},
            "delta_x_m": _summary(delta_x),
            "delta_y_m": _summary(delta_y),
            "delta_yaw_rad": _summary(delta_yaw),
            "action_norm": {"min": 0.1, "max": 0.2, "final": 0.1, "mean": 0.1},
        },
    )


def _task_motion(task_id: str) -> tuple[float, float, float]:
    delta_x = 0.0
    delta_y = 0.0
    delta_yaw = 0.0
    if task_id == "walk_forward":
        delta_x = 0.4
    elif task_id == "walk_backward":
        delta_x = -0.3
    elif task_id == "sidestep_left":
        delta_y = 0.3
    elif task_id == "sidestep_right":
        delta_y = -0.3
    elif task_id == "turn_left":
        delta_yaw = 0.8
    elif task_id == "turn_right":
        delta_yaw = -0.8
    return delta_x, delta_y, delta_yaw


def _summary(value: float) -> dict[str, float]:
    return {
        "min": min(0.0, value),
        "max": max(0.0, value),
        "final": value,
        "mean": value / 2.0,
    }


def _write_combined_video_telemetry(
    path: Path,
    *,
    profile: str,
    commands: tuple[str, ...] = DEFAULT_MULTI_ROBOT_COMMANDS,
    policy_source: str = "checkpoint:asimov_1_alberta_full",
) -> None:
    tracked_body_name = load_profile(profile).sensors.locomotion_tracking_body
    _write_json(
        path,
        {
            "profile": profile,
            "label": "combined_actions",
            "policy_source": policy_source,
            "rollout_ok": True,
            "any_goal_success": True,
            "steps_executed": len(commands) * 8,
            "commands": [
                {
                    "task_id": task_id,
                    "policy_source": policy_source,
                    "rollout_ok": True,
                    "goal_success": True,
                    "attempted_action": True,
                    "nonzero_action_steps": 8,
                    "tracked_body_name": tracked_body_name,
                    "torso_z": (
                        {"min": 0.9, "max": 1.0, "final": 1.0, "mean": 0.95}
                        if task_id == "stand_up"
                        else {"min": 1.0, "max": 1.0, "final": 1.0, "mean": 1.0}
                    ),
                    "tracked_z_m": (
                        {"min": 0.9, "max": 1.0, "final": 1.0, "mean": 0.95}
                        if task_id == "stand_up"
                        else {"min": 1.0, "max": 1.0, "final": 1.0, "mean": 1.0}
                    ),
                    "tracked_delta_x_m": _summary(_task_motion(task_id)[0]),
                    "tracked_delta_y_m": _summary(_task_motion(task_id)[1]),
                    "tracked_delta_z_m": (
                        _summary(0.1) if task_id == "stand_up" else _summary(0.0)
                    ),
                    "delta_x_m": _summary(_task_motion(task_id)[0]),
                    "delta_y_m": _summary(_task_motion(task_id)[1]),
                    "delta_yaw_rad": _summary(_task_motion(task_id)[2]),
                }
                for command in commands
                for task_id in (command.replace(" ", "_"),)
            ],
        },
    )


def _safe_label(label: str) -> str:
    return label.replace(" ", "_").replace("/", "_")[:48]


def _write_multi_robot_videos(
    root: Path,
    *,
    evidence_name: str = "agent_videos",
    profiles_to_write: tuple[str, ...] = DEFAULT_MULTI_ROBOT_PROFILES,
) -> None:
    evidence = root / "evidence" / evidence_name
    profiles = []
    for profile in profiles_to_write:
        profile_dir = evidence / profile
        expected = []
        videos = []
        for command in DEFAULT_MULTI_ROBOT_COMMANDS:
            name = f"{profile}_{_safe_label(command)}.mp4"
            _write_moving_video(profile_dir / name)
            _write_video_telemetry(
                (profile_dir / name).with_suffix(".telemetry.json"),
                profile=profile,
                task_id=command.replace(" ", "_"),
            )
            expected.append(name)
            videos.append(name)
        combined = f"{profile}_combined_actions.mp4"
        _write_moving_video(profile_dir / combined)
        _write_combined_video_telemetry(
            (profile_dir / combined).with_suffix(".telemetry.json"),
            profile=profile,
        )
        expected.append(combined)
        videos.append(combined)
        profiles.append(
            {
                "profile": profile,
                "videos": videos,
                "expected_videos": expected,
                "missing_videos": [],
                "combined_video": combined,
                "combined_present": True,
                "exit_code": 0,
                "ok": True,
            }
        )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "commands": list(DEFAULT_MULTI_ROBOT_COMMANDS),
            "record_combined": True,
            "profiles": profiles,
        },
    )


def _write_stage_statuses(root: Path) -> None:
    stages = []
    for stage in STAGES:
        status = {
            "stage": stage,
            "state": "complete",
            "returncode": 0,
            "started_at": "2026-05-23T00:00:00Z",
            "ended_at": "2026-05-23T00:01:00Z",
            "heartbeat_at": "2026-05-23T00:01:00Z",
        }
        _write_json(root / "status" / f"{stage}.json", status)
        stages.append(status)
    _write_json(
        root / "status" / "runner_status.json",
        {
            "ok": True,
            "state": "complete",
            "started_at": "2026-05-23T00:00:00Z",
            "ended_at": "2026-05-23T00:06:00Z",
            "heartbeat_at": "2026-05-23T00:06:00Z",
            "last_stage": STAGES[-1],
            "stages": stages,
        },
    )


def _write_benchmark(path: Path, *, env_kind: str) -> None:
    alberta_result = {
        "name": "alberta",
        "matrix": [
            [1.0, 0.0, 0.0, 0.0],
            [1.0, 1.0, 0.0, 0.0],
            [1.0, 1.0, 1.0, 0.0],
            [1.0, 1.0, 1.0, 1.0],
        ],
        "baseline": [0.0, 0.0, 0.0, 0.0],
    }
    ppo_result = {
        "name": "ppo",
        "matrix": [
            [0.5, 0.0, 0.0, 0.0],
            [0.5, 0.5, 0.0, 0.0],
            [0.5, 0.5, 0.5, 0.0],
            [0.5, 0.5, 0.5, 0.5],
        ],
        "baseline": [0.0, 0.0, 0.0, 0.0],
    }
    _write_json(
        path / "continual_benchmark.json",
        {
            "config": {
                "env_kind": env_kind,
                "n_tasks": 4,
                "seeds": 3,
                "steps_per_task": 16000,
            },
            "summary": {
                "alberta": {
                    "acc": {"mean": 1.0, "std": 0.0},
                    "bwt": {"mean": 0.0, "std": 0.0},
                    "forgetting": {"mean": 0.0, "std": 0.0},
                    "fwt": {"mean": 0.0, "std": 0.0},
                },
                "ppo": {
                    "acc": {"mean": 0.5, "std": 0.0},
                    "bwt": {"mean": -0.1, "std": 0.0},
                    "forgetting": {"mean": 0.1, "std": 0.0},
                    "fwt": {"mean": 0.0, "std": 0.0},
                },
            },
            "results": [
                {**alberta_result, "seed": 1000 + seed}
                for seed in range(3)
            ]
            + [{**ppo_result, "seed": 1000 + seed} for seed in range(3)],
        },
    )
    (path / "continual_benchmark.md").write_text("# benchmark\n")
    (path / "continual_benchmark.png").write_bytes(b"not-empty")
    if env_kind == "obstacle_course":
        _write_json(
            path / "obstacle_course_demo.json",
            {
                "schema": "robot-alberta-obstacle-demo-v1",
                "ok": True,
                "frames": 4,
                "video_bytes": 10,
            },
        )
        (path / "obstacle_course_demo.mp4").write_bytes(b"demo-video")


def _write_backend_compare(path: Path) -> None:
    tasks = ["stand_up", "walk_forward"]
    task_report = {task: {"mean_reward": 1.0} for task in tasks}
    _write_json(
        path / "comparison.json",
        {
            "profile_id": "asimov-1",
            "tasks": tasks,
            "steps": 30000,
            "seed": 0,
            "pca_dim": 32,
            "episode_steps": 200,
            "eval_episodes": 5,
            "max_steps": 200,
            "domain_rand": True,
            "baseline": {"tasks": task_report, "mean_reward_overall": 1.0},
            "alberta": {
                "validation": {"ok": True},
                "eval": {"tasks": task_report, "mean_reward_overall": 1.0},
                "delta_vs_untrained": {task: 0.0 for task in tasks},
            },
            "ppo": {
                "eval": {"tasks": task_report, "mean_reward_overall": 1.0},
                "delta_vs_untrained": {task: 0.0 for task in tasks},
            },
            "alberta_vs_ppo_delta": {
                "mean_reward_overall": 0.0,
                "tasks": {task: 0.0 for task in tasks},
            },
            "winner_by_mean_reward": "alberta",
        },
    )
    (path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n"
        "delta vs untrained\n\n"
        "## Per-Task Reward\n\n"
        "Winner by mean reward\n"
    )


def test_sync_from_s3_deletes_stale_local_files(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs["cwd"]
        return subprocess.CompletedProcess(cmd, 0, stdout="synced\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    report = sync_from_s3(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=tmp_path / "synced",
        aws_bin="aws",
    )

    assert report["ok"] is True
    assert report["delete_extra"] is True
    assert report["preserved_local_patterns"] == [
        "runtime_watch.json",
        "runtime_watch.md",
        "runtime_watch_history.jsonl",
        "instance_launch_hygiene.json",
    ]
    assert captured["cmd"] == [
        "aws",
        "--endpoint-url",
        "https://example.test",
        "s3",
        "sync",
        "--delete",
        "--exclude",
        "runtime_watch.json",
        "--exclude",
        "runtime_watch.md",
        "--exclude",
        "runtime_watch_history.jsonl",
        "--exclude",
        "instance_launch_hygiene.json",
        "s3://bucket/robot-full-test/",
        str(tmp_path / "synced"),
    ]


def test_validate_nebius_full_training_run_rejects_non_production_closeout(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    (root / "status").mkdir(parents=True)
    (root / "status" / "success.txt").write_text("SUCCESS\n")
    _write_stage_statuses(root)
    _write_json(
        root / "instance_launch_hygiene.json",
        {
            "ok": True,
            "checks": {
                "no_inline_object_storage_credentials": True,
                "uses_repo_owned_stage_runner": True,
                "uses_training_s3_uri": True,
                "has_status_heartbeat_upload_contract": True,
            },
            "secret_fields_embedded": [],
        },
    )
    for stage in STAGES:
        log = root / "logs" / f"{stage}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(f"START {stage}\nEND {stage} rc=0\n")
    alberta_dir = root / "checkpoints" / "asimov_1_alberta_full"
    alberta_dir.mkdir(parents=True)
    (alberta_dir / "manifest.json").write_text("{}\n")
    (alberta_dir / "alberta_policy.npz").write_bytes(b"checkpoint")
    brax_dir = root / "evidence" / "full_training_preflight" / "asimov_1_brax_mjx_baseline"
    brax_dir.mkdir(parents=True)
    for name in (
        "manifest.json",
        "metrics.json",
        "config.json",
        "inference_check.json",
        "full_training_run.json",
        "policy_brax.pkl",
    ):
        (brax_dir / name).write_text("{}\n")
    _write_json(
        brax_dir / "full_training_run.json",
        {"ok": True},
    )
    _write_json(
        root / "evidence" / "full_training_preflight" / "training_inputs_report.json",
        {
            "ok": True,
            "launch_tasks": ["stand_up", "walk_forward"],
            "blockers": [],
            "warnings": [{"kind": "no_offline_policy_datasets"}],
            "datasets": {
                "rl_from_sim_ready": True,
                "offline_datasets_block_current_plan": False,
            },
            "curriculum": {"content_sha256": "abc123"},
        },
    )
    _write_backend_compare(root / "evidence" / "backend_compare" / "asimov-1")
    _write_benchmark(root / "evidence" / "alberta_joint_reach", env_kind="joint_reach")
    _write_benchmark(
        root / "evidence" / "alberta_obstacle_course",
        env_kind="obstacle_course",
    )
    _write_multi_robot_videos(root, evidence_name="multi_robot_smoke_videos")
    _write_multi_robot_videos(root, profiles_to_write=("asimov-1",))
    manifest_path = root / "evidence" / "agent_videos" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    checkpoint = str(alberta_dir.resolve())
    manifest["policy_checkpoint"] = checkpoint
    for entry in manifest["profiles"]:
        if entry["profile"] == "asimov-1":
            entry["policy_checkpoint"] = checkpoint
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        tasks=("stand_up", "walk_forward"),
        run_deep_validators=False,
    )

    assert report["ok"] is False
    assert report["checks"]["stage_logs"] is True
    assert report["checks"]["stage_status"] is True
    assert report["checks"]["production_contract"] is False
    assert report["checks"]["instance_launch_hygiene"] is True
    assert report["checks"]["training_inputs"] is True
    assert report["checks"]["multi_robot_readiness"] is True
    assert report["checks"]["backend_comparison"] is True
    assert report["checks"]["video_review"] is True
    assert report["checks"]["production_policy_videos"] is True
    assert report["checks"]["curriculum_eval"] is False
    assert report["checks"]["curriculum_eval_native"] is False
    assert (root / "validation_report.json").is_file()
    assert (root / "validation_summary.md").is_file()
    summary = (root / "validation_summary.md").read_text()
    assert "Production Gates" in summary
    assert "Failed Gates" in summary
    assert "- `production_contract`" in summary
    assert "- `curriculum_eval`" in summary
    assert "- `curriculum_eval_native`" in summary
    assert "Production Policy Videos" in summary
    assert "Checkpoint artifacts exist: `True`" in summary
    assert "Manifest checkpoint bound: `True`" in summary


def test_production_contract_rejects_short_checkpoint_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    _write_json(
        manifest,
        {
            "total_steps": 7000,
            "requested_total_steps": 7000,
        },
    )

    report = _validate_production_contract(
        checkpoint_manifest=manifest,
        tasks=("stand_up", "walk_forward"),
        require_success=True,
        run_deep_validators=True,
        min_alberta_steps=150_000_000,
        min_backend_compare_steps=30_000,
        min_benchmark_steps_per_task=16_000,
        min_benchmark_seeds=3,
    )

    assert report["ok"] is False
    assert report["checks"]["checkpoint_manifest_present"] is True
    assert report["checks"]["checkpoint_total_steps"] is False
    assert report["checks"]["checkpoint_requested_total_steps"] is False
    assert report["actual"]["checkpoint_total_steps"] == 7000


def _production_contract_manifest(
    *,
    tasks: tuple[str, ...] = ("stand_up", "walk_forward"),
    total_steps: int = 150_000_000,
) -> dict:
    tracked_body_name = load_profile("asimov-1").sensors.locomotion_tracking_body
    steps_per_task = total_steps // len(tasks)
    cumulative = 0
    phases = []
    for phase, task in enumerate(tasks):
        cumulative += steps_per_task
        delta_x, delta_y, delta_yaw = _task_motion(task)
        phases.append(
            {
                "phase": phase,
                "task": task,
                "steps_trained": steps_per_task,
                "cumulative_steps": cumulative,
                "eval_episodes": 5,
                "eval_mean_return": 1.0,
                "eval_success_rate": 1.0,
                "failure_rate": 0.0,
                "physical_success": True,
                "physical_checks": _task_physical_checks(task),
                "tracked_body_name": tracked_body_name,
                "mean_final_delta_yaw_rad": delta_yaw,
                "mean_final_torso_z_m": 1.0,
                "mean_final_torso_z_delta_m": 0.1 if task == "stand_up" else 0.0,
                "mean_final_tracked_delta_x_m": delta_x,
                "mean_final_tracked_delta_y_m": delta_y,
                "mean_final_tracked_delta_z_m": 0.1 if task == "stand_up" else 0.0,
                "mean_final_tracked_z_m": 1.0,
                "promotion_passed": True,
            }
        )
    return {
        "regime": "alberta_streaming",
        "profile_id": "asimov-1",
        "domain_rand": True,
        "active_tasks": list(tasks),
        "total_steps": total_steps,
        "requested_total_steps": total_steps,
        "steps_per_task": steps_per_task,
        "phase_promotion_schema": "alberta-phase-promotion-v1",
        "phase_promotion": {
            "gate": "curriculum_goal_checker",
            "status": "completed",
            "success_threshold": 1.0,
            "eval_episodes": 5,
            "promoted_phase_count": len(tasks),
            "requested_phase_count": len(tasks),
            "failed_phase": None,
            "phases": phases,
        },
    }


def _validate_production_manifest(manifest: Path, tasks: tuple[str, ...]) -> dict:
    return _validate_production_contract(
        checkpoint_manifest=manifest,
        tasks=tasks,
        require_success=True,
        run_deep_validators=True,
        min_alberta_steps=150_000_000,
        min_backend_compare_steps=30_000,
        min_benchmark_steps_per_task=16_000,
        min_benchmark_seeds=3,
    )


def test_production_contract_requires_phase_promotion_proof(
    tmp_path: Path,
) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload.pop("phase_promotion_schema")
    payload.pop("phase_promotion")
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_total_steps"] is True
    assert report["checks"]["checkpoint_phase_promotion_schema"] is False
    assert report["checks"]["checkpoint_phase_promotion_completed"] is False


def test_production_contract_rejects_failed_or_incomplete_phase_promotion(
    tmp_path: Path,
) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload["phase_promotion"]["status"] = "failed"
    payload["phase_promotion"]["phases"][1]["promotion_passed"] = False
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_phase_promotion_completed"] is False
    assert report["checks"]["checkpoint_phase_promotion_all_passed"] is False


def test_production_contract_rejects_phase_promotion_without_physical_evidence(
    tmp_path: Path,
) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload["phase_promotion"]["phases"][0].pop("tracked_body_name")
    payload["phase_promotion"]["phases"][0]["physical_success"] = False
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_phase_promotion_physical"] is False


def test_production_contract_rejects_phase_promotion_wrong_signed_motion(
    tmp_path: Path,
) -> None:
    tasks = ("walk_backward",)
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload["phase_promotion"]["phases"][0]["mean_final_tracked_delta_x_m"] = 0.4
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_phase_promotion_physical"] is False


def test_production_contract_rejects_stale_tracked_body_name(
    tmp_path: Path,
) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload["phase_promotion"]["phases"][0]["tracked_body_name"] = "head_tilt_link"
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_phase_promotion_physical"] is False


def test_production_contract_rejects_non_production_or_bad_accounting(
    tmp_path: Path,
) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=tasks)
    payload["non_production"] = True
    payload["steps_per_task"] = payload["steps_per_task"] - 1
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_not_non_production"] is False
    assert report["checks"]["checkpoint_steps_accounting"] is False


def test_production_contract_rejects_missing_required_task(tmp_path: Path) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    payload = _production_contract_manifest(tasks=("stand_up",))
    _write_json(manifest, payload)

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is False
    assert report["checks"]["checkpoint_tasks_cover_requested"] is False
    assert report["checks"]["checkpoint_phase_promotion_tasks"] is False


def test_production_contract_accepts_complete_manifest(tmp_path: Path) -> None:
    tasks = ("stand_up", "walk_forward")
    manifest = tmp_path / "checkpoints" / "asimov_1_alberta_full" / "manifest.json"
    _write_json(manifest, _production_contract_manifest(tasks=tasks))

    report = _validate_production_manifest(manifest, tasks)

    assert report["ok"] is True


def test_production_policy_video_gate_rejects_empty_action_clip(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward")
    expected = [
        f"{profile}_{command.replace(' ', '_')}.mp4" for command in commands
    ] + [f"{profile}_combined_actions.mp4"]
    for name in expected:
        _write_moving_video(profile_dir / name)
        _write_video_telemetry((profile_dir / name).with_suffix(".telemetry.json"))
    (profile_dir / f"{profile}_walk_forward.mp4").write_bytes(b"")
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    assert report["checks"]["expected_videos"] is True
    assert report["checks"]["expected_telemetry"] is True
    assert report["checks"]["video_sizes"] is False
    assert report["undersized"] == [f"{profile}_walk_forward.mp4"]


def test_production_policy_video_gate_rejects_missing_telemetry_sidecar(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward")
    expected = [
        f"{profile}_{command.replace(' ', '_')}.mp4" for command in commands
    ] + [f"{profile}_combined_actions.mp4"]
    for name in expected:
        _write_moving_video(profile_dir / name)
        if name != f"{profile}_walk_forward.mp4":
            _write_video_telemetry((profile_dir / name).with_suffix(".telemetry.json"))
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    assert report["checks"]["expected_videos"] is True
    assert report["checks"]["expected_telemetry"] is False
    assert report["missing_telemetry"] == [f"{profile}_walk_forward.telemetry.json"]


def test_production_policy_video_gate_rejects_unsuccessful_telemetry(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward")
    for command in commands:
        name = f"{profile}_{command.replace(' ', '_')}.mp4"
        _write_moving_video(profile_dir / name)
        telemetry = (profile_dir / name).with_suffix(".telemetry.json")
        _write_video_telemetry(
            telemetry,
            profile=profile,
            task_id=command.replace(" ", "_"),
        )
    _write_json(
        profile_dir / f"{profile}_walk_forward.telemetry.json",
        {
            "profile": profile,
            "task_id": "walk_forward",
            "policy_source": "checkpoint:asimov_1_alberta_full",
            "rollout_ok": False,
            "goal_success": False,
            "attempted_action": True,
            "nonzero_action_steps": 8,
            "torso_z": {"final": 1.0},
            "action_norm": {"final": 0.1},
            "delta_x_m": {"final": None},
        },
    )
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    assert report["checks"]["expected_videos"] is True
    assert report["checks"]["expected_telemetry"] is True
    assert report["checks"]["telemetry_sizes"] is True
    assert report["checks"]["telemetry_semantics"] is False
    walk_report = report["telemetry_reports"][f"{profile}_walk_forward.telemetry.json"]
    assert walk_report["checks"]["goal_success"] is False
    assert walk_report["checks"]["delta_x_series"] is False


def test_production_policy_video_gate_rejects_stand_up_without_action_or_rise(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up",)
    name = f"{profile}_stand_up.mp4"
    _write_moving_video(profile_dir / name)
    _write_json(
        profile_dir / f"{profile}_stand_up.telemetry.json",
        {
            "profile": profile,
            "task_id": "stand_up",
            "policy_source": "checkpoint:asimov_1_alberta_full",
            "rollout_ok": True,
            "goal_success": True,
            "attempted_action": True,
            "nonzero_action_steps": 0,
            "torso_z": {"min": 1.0, "final": 1.0},
            "action_norm": {"final": 0.0},
        },
    )
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    stand_report = report["telemetry_reports"][f"{profile}_stand_up.telemetry.json"]
    assert stand_report["checks"]["nonzero_action_steps"] is False
    assert stand_report["checks"]["torso_height_gain"] is False


def test_production_policy_video_gate_rejects_wrong_direction_telemetry(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("walk backward", "sidestep right", "turn right")
    for command in commands:
        name = f"{profile}_{command.replace(' ', '_')}.mp4"
        _write_moving_video(profile_dir / name)
        _write_video_telemetry(
            (profile_dir / name).with_suffix(".telemetry.json"),
            profile=profile,
            task_id=command.replace(" ", "_"),
        )
    _write_json(
        profile_dir / f"{profile}_walk_backward.telemetry.json",
        {
            "profile": profile,
            "task_id": "walk_backward",
            "policy_source": "checkpoint:asimov_1_alberta_full",
            "rollout_ok": True,
            "goal_success": True,
            "attempted_action": True,
            "nonzero_action_steps": 8,
            "torso_z": {"final": 1.0},
            "action_norm": {"final": 0.1},
            "delta_x_m": {"final": 0.3},
        },
    )
    _write_json(
        profile_dir / f"{profile}_sidestep_right.telemetry.json",
        {
            "profile": profile,
            "task_id": "sidestep_right",
            "policy_source": "checkpoint:asimov_1_alberta_full",
            "rollout_ok": True,
            "goal_success": True,
            "attempted_action": True,
            "nonzero_action_steps": 8,
            "torso_z": {"final": 1.0},
            "action_norm": {"final": 0.1},
            "delta_x_m": {"final": 0.0},
            "delta_y_m": {"final": 0.3},
        },
    )
    _write_json(
        profile_dir / f"{profile}_turn_right.telemetry.json",
        {
            "profile": profile,
            "task_id": "turn_right",
            "policy_source": "checkpoint:asimov_1_alberta_full",
            "rollout_ok": True,
            "goal_success": True,
            "attempted_action": True,
            "nonzero_action_steps": 8,
            "torso_z": {"final": 1.0},
            "action_norm": {"final": 0.1},
            "delta_yaw_rad": {"final": 0.8},
        },
    )
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    assert report["checks"]["telemetry_semantics"] is False
    assert report["telemetry_reports"][f"{profile}_walk_backward.telemetry.json"][
        "checks"
    ]["delta_x_backward"] is False
    assert report["telemetry_reports"][f"{profile}_sidestep_right.telemetry.json"][
        "checks"
    ]["delta_y_right"] is False
    assert report["telemetry_reports"][f"{profile}_turn_right.telemetry.json"][
        "checks"
    ]["delta_yaw_right"] is False


def test_production_policy_video_gate_rejects_turn_translation_drift(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("turn left",)
    name = f"{profile}_turn_left.mp4"
    _write_moving_video(profile_dir / name)
    _write_video_telemetry(
        (profile_dir / name).with_suffix(".telemetry.json"),
        profile=profile,
        task_id="turn_left",
    )
    payload_path = profile_dir / f"{profile}_turn_left.telemetry.json"
    payload = json.loads(payload_path.read_text())
    payload["delta_x_m"] = _summary(0.4)
    payload["tracked_delta_x_m"] = _summary(0.4)
    _write_json(payload_path, payload)
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    turn_report = report["telemetry_reports"][f"{profile}_turn_left.telemetry.json"]
    assert turn_report["checks"]["delta_yaw_left"] is True
    assert turn_report["checks"]["translation_drift_bound"] is False


@pytest.mark.parametrize(
    ("task_id", "series_key", "check_key", "min_value", "max_value"),
    (
        ("walk_forward", "tracked_delta_x_m", "delta_x_forward", 0.0, 0.35),
        ("walk_backward", "tracked_delta_x_m", "delta_x_backward", -0.25, 0.0),
        ("sidestep_left", "tracked_delta_y_m", "delta_y_left", 0.0, 0.25),
        ("sidestep_right", "tracked_delta_y_m", "delta_y_right", -0.25, 0.0),
        ("turn_left", "delta_yaw_rad", "delta_yaw_left", 0.0, 0.75),
        ("turn_right", "delta_yaw_rad", "delta_yaw_right", -0.75, 0.0),
    ),
)
def test_policy_video_motion_checks_use_signed_motion_extrema(
    task_id: str,
    series_key: str,
    check_key: str,
    min_value: float,
    max_value: float,
) -> None:
    payload = {
        "tracked_delta_x_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "tracked_delta_y_m": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "delta_yaw_rad": {"min": 0.0, "max": 0.0, "mean": 0.0, "final": 0.0},
        "tracked_z_m": {"min": 0.3, "max": 0.3, "mean": 0.3, "final": 0.3},
    }
    payload[series_key] = {
        "min": min_value,
        "max": max_value,
        "mean": 0.0,
        "final": 0.0,
    }

    assert _policy_video_motion_checks(payload, task_id)[check_key] is True


def test_production_policy_video_gate_rejects_combined_wrong_motion(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward", "turn left")
    for command in commands:
        name = f"{profile}_{command.replace(' ', '_')}.mp4"
        _write_moving_video(profile_dir / name)
        _write_video_telemetry(
            (profile_dir / name).with_suffix(".telemetry.json"),
            profile=profile,
            task_id=command.replace(" ", "_"),
        )
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    combined_payload = json.loads(
        (profile_dir / f"{profile}_combined_actions.telemetry.json").read_text()
    )
    combined_payload["commands"][1]["delta_x_m"] = _summary(-0.4)
    combined_payload["commands"][1]["tracked_delta_x_m"] = _summary(-0.4)
    _write_json(
        profile_dir / f"{profile}_combined_actions.telemetry.json",
        combined_payload,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    combined_report = report["telemetry_reports"][
        f"{profile}_combined_actions.telemetry.json"
    ]
    assert combined_report["checks"]["all_goal_success"] is True
    assert combined_report["checks"]["all_command_motion"] is False


def test_production_policy_video_gate_rejects_combined_missing_tracked_telemetry(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward")
    for command in commands:
        name = f"{profile}_{command.replace(' ', '_')}.mp4"
        _write_moving_video(profile_dir / name)
        _write_video_telemetry(
            (profile_dir / name).with_suffix(".telemetry.json"),
            profile=profile,
            task_id=command.replace(" ", "_"),
        )
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    combined_path = profile_dir / f"{profile}_combined_actions.telemetry.json"
    combined_payload = json.loads(combined_path.read_text())
    for command_payload in combined_payload["commands"]:
        command_payload.pop("tracked_body_name", None)
        command_payload.pop("tracked_z_m", None)
        command_payload.pop("tracked_delta_x_m", None)
        command_payload.pop("tracked_delta_y_m", None)
        command_payload.pop("tracked_delta_z_m", None)
    _write_json(combined_path, combined_payload)
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    combined_report = report["telemetry_reports"][
        f"{profile}_combined_actions.telemetry.json"
    ]
    assert combined_report["checks"]["all_goal_success"] is True
    assert combined_report["checks"]["all_command_tracked_telemetry"] is False


def test_production_policy_video_gate_rejects_stale_tracked_body_name(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence" / "agent_videos"
    profile = "asimov-1"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True)
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    (checkpoint / "manifest.json").write_text("{}\n")
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    checkpoint_path = str(checkpoint.resolve())
    commands = ("stand up", "walk forward")
    for command in commands:
        name = f"{profile}_{command.replace(' ', '_')}.mp4"
        _write_moving_video(profile_dir / name)
        _write_video_telemetry(
            (profile_dir / name).with_suffix(".telemetry.json"),
            profile=profile,
            task_id=command.replace(" ", "_"),
        )
    stale_path = profile_dir / f"{profile}_walk_forward.telemetry.json"
    stale_payload = json.loads(stale_path.read_text())
    stale_payload["tracked_body_name"] = "head_tilt_link"
    _write_json(stale_path, stale_payload)
    combined = f"{profile}_combined_actions.mp4"
    _write_moving_video(profile_dir / combined)
    _write_combined_video_telemetry(
        (profile_dir / combined).with_suffix(".telemetry.json"),
        profile=profile,
        commands=commands,
    )
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "policy_checkpoint": checkpoint_path,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": checkpoint_path,
                    "ok": True,
                }
            ],
        },
    )

    report = _validate_production_policy_videos(
        evidence,
        checkpoint=checkpoint,
        profile_id=profile,
        commands=commands,
    )

    assert report["ok"] is False
    single_report = report["telemetry_reports"][f"{profile}_walk_forward.telemetry.json"]
    assert report["expected_tracking_body"] == "pelvis_link"
    assert single_report["checks"]["tracked_body_name"] is False


def test_curriculum_eval_gate_requires_checkpoint_bound_task_success(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    report_path = tmp_path / "evidence" / "curriculum_eval" / "report.json"
    _write_json(
        report_path,
        {
            "schema": "robot-policy-curriculum-eval-v1",
            "source": "eval_text_policy",
            "profile_id": "asimov-1",
            "policy": "checkpoint:asimov_1_alberta_full",
            "checkpoint": str(checkpoint),
            "n_tasks": 2,
            "n_programmatic_pass": 1,
            "programmatic_pass_rate": 0.5,
            "mean_success_rate_overall": 0.5,
            "tasks": [
                {
                    "task_id": "stand_up",
                    "success_programmatic": True,
                    "success_rate": 1.0,
                    "episodes": 2,
                },
                {
                    "task_id": "walk_forward",
                    "success_programmatic": False,
                    "success_rate": 0.0,
                    "episodes": 2,
                },
            ],
        },
    )

    failed = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert failed["ok"] is False
    assert failed["checks"]["checkpoint_matches"] is True
    assert failed["checks"]["all_requested_tasks_programmatic_success"] is False
    assert failed["checks"]["programmatic_pass_rate"] is False

    _write_json(report_path, _valid_curriculum_eval_report(checkpoint=checkpoint))

    passed = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert passed["ok"] is True

    payload = _valid_curriculum_eval_report(checkpoint=checkpoint)
    payload["checkpoint"] = "checkpoints/asimov_1_alberta_full"
    _write_json(report_path, payload)
    relative_passed = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert relative_passed["ok"] is True
    assert relative_passed["checks"]["checkpoint_matches"] is True


def test_curriculum_eval_gate_rejects_forged_or_incomplete_reports(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    report_path = tmp_path / "evidence" / "curriculum_eval" / "report.json"

    payload = _valid_curriculum_eval_report(checkpoint=checkpoint)
    payload["policy"] = "untrained_zero"
    _write_json(report_path, payload)
    report = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert report["ok"] is False
    assert report["checks"]["policy_checkpoint"] is False

    payload = _valid_curriculum_eval_report(checkpoint=checkpoint)
    payload["checkpoint"] = checkpoint.name
    _write_json(report_path, payload)
    report = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert report["ok"] is False
    assert report["checks"]["checkpoint_matches"] is False

    payload = _valid_curriculum_eval_report(checkpoint=checkpoint)
    payload["programmatic_pass_rate"] = 0.75
    _write_json(report_path, payload)
    report = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert report["ok"] is False
    assert report["checks"]["programmatic_pass_rate_recomputed"] is False

    payload = _valid_curriculum_eval_report(checkpoint=checkpoint)
    payload["tasks"][0]["episodes"] = 0
    _write_json(report_path, payload)
    report = _validate_curriculum_eval_report(
        report_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert report["ok"] is False
    assert report["checks"]["task_episodes"] is False


def test_text_policy_eval_gate_requires_exact_native_schema(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    native_path = tmp_path / "evidence" / "curriculum_eval" / "eval_text_policy.json"

    _write_json(native_path, _valid_text_policy_eval_report(checkpoint=checkpoint))
    passed = _validate_text_policy_eval_report(
        native_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert passed["ok"] is True

    payload = _valid_text_policy_eval_report(checkpoint=checkpoint)
    payload["checkpoint"] = "checkpoints/asimov_1_alberta_full"
    _write_json(native_path, payload)
    relative_passed = _validate_text_policy_eval_report(
        native_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert relative_passed["ok"] is True
    assert relative_passed["checks"]["checkpoint_matches"] is True

    payload = _valid_text_policy_eval_report(checkpoint=checkpoint)
    payload["schema"] = "robot-policy-curriculum-eval-v1"
    _write_json(native_path, payload)
    failed = _validate_text_policy_eval_report(
        native_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert failed["ok"] is False
    assert failed["checks"]["schema"] is False

    legacy_path = tmp_path / "evidence" / "curriculum_v2_sota" / "eval_text_policy.json"
    _write_json(legacy_path, _valid_text_policy_eval_report(checkpoint=checkpoint))
    missing_exact = _validate_text_policy_eval_report(
        tmp_path / "evidence" / "curriculum_eval" / "missing.json",
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )
    assert missing_exact["ok"] is False
    assert missing_exact["checks"]["present"] is False


def test_text_policy_eval_gate_rejects_boolean_only_motion_evidence(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    native_path = tmp_path / "evidence" / "curriculum_eval" / "eval_text_policy.json"
    payload = _valid_text_policy_eval_report(checkpoint=checkpoint)
    for key in tuple(payload["tasks"]["walk_forward"]):
        if key.startswith("mean_final_") or key == "tracked_body_name":
            payload["tasks"]["walk_forward"].pop(key)
    _write_json(native_path, payload)

    report = _validate_text_policy_eval_report(
        native_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert report["ok"] is False
    assert report["checks"]["per_task_numeric_motion"] is False
    assert report["checks"]["per_task_tracked_body"] is False
    assert "mean_final_tracked_delta_x_m" in report["numeric_task_fail_reasons"][
        "walk_forward"
    ]


def test_text_policy_eval_gate_rejects_wrong_tracking_body(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoints" / "asimov_1_alberta_full"
    checkpoint.mkdir(parents=True)
    native_path = tmp_path / "evidence" / "curriculum_eval" / "eval_text_policy.json"
    payload = _valid_text_policy_eval_report(checkpoint=checkpoint)
    payload["tasks"]["stand_up"]["tracked_body_name"] = "base_link"
    _write_json(native_path, payload)

    report = _validate_text_policy_eval_report(
        native_path,
        checkpoint=checkpoint,
        profile_id="asimov-1",
        tasks=("stand_up", "walk_forward"),
    )

    assert report["ok"] is False
    assert report["checks"]["per_task_tracked_body"] is False
    assert report["numeric_task_fail_reasons"]["stand_up"] == ["tracked_body_name"]


def test_validate_nebius_full_training_run_rejects_missing_success(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    root.mkdir()

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        run_deep_validators=False,
    )

    assert report["ok"] is False
    assert report["checks"]["success_marker"] is False
    assert report["checks"]["stage_logs"] is False
    assert report["checks"]["stage_status"] is False
    assert report["checks"]["training_inputs"] is False
    summary = (root / "validation_summary.md").read_text()
    assert "- `success_marker`" in summary
    assert "- `stage_logs`" in summary


def test_validate_nebius_full_training_run_rejects_missing_stage_status(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    (root / "status").mkdir(parents=True)
    (root / "status" / "success.txt").write_text("SUCCESS\n")
    for stage in STAGES:
        log = root / "logs" / f"{stage}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(f"START {stage}\nEND {stage} rc=0\n")

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        run_deep_validators=False,
    )

    assert report["ok"] is False
    assert report["checks"]["stage_logs"] is True
    assert report["checks"]["stage_status"] is False
    assert report["reports"]["stage_status"]["checks"]["runner_status"] is False
    assert report["reports"]["stage_status"]["checks"]["all_stage_statuses"] is False


def test_validate_nebius_full_training_run_repairs_stale_runner_status(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    (root / "status").mkdir(parents=True)
    (root / "status" / "success.txt").write_text("SUCCESS\n")
    for stage in STAGES:
        log = root / "logs" / f"{stage}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(f"START {stage}\nEND {stage} rc=0\n")
    _write_stage_statuses(root)
    _write_json(
        root / "status" / "runner_status.json",
        {
            "ok": True,
            "state": "complete",
            "started_at": "2026-05-23T00:00:00Z",
            "ended_at": "2026-05-23T00:06:00Z",
            "heartbeat_at": "2026-05-23T00:06:00Z",
            "last_stage": STAGES[-1],
            "stages": [
                {
                    "stage": STAGES[-1],
                    "state": "complete",
                    "returncode": 0,
                    "started_at": "2026-05-23T00:05:00Z",
                    "ended_at": "2026-05-23T00:06:00Z",
                    "heartbeat_at": "2026-05-23T00:06:00Z",
                }
            ],
        },
    )

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        run_deep_validators=False,
    )

    stage_report = report["reports"]["stage_status"]
    runner = stage_report["runner"]
    assert report["checks"]["stage_logs"] is True
    assert report["checks"]["stage_status"] is True
    assert stage_report["checks"]["runner_status"] is True
    assert stage_report["checks"]["all_stage_statuses"] is True
    assert runner["repaired_from_stage_files"] is True
    assert runner["raw_stage_count"] == 1
    assert runner["stage_count"] == len(STAGES)


def test_validate_nebius_full_training_run_rejects_preflight_only_brax_dir(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    (root / "status").mkdir(parents=True)
    (root / "status" / "success.txt").write_text("SUCCESS\n")
    brax_dir = root / "evidence" / "full_training_preflight" / "asimov_1_brax_mjx_baseline"
    brax_dir.mkdir(parents=True)
    (brax_dir / "training_job.json").write_text("{}\n")

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        run_deep_validators=False,
    )

    assert report["ok"] is False
    assert report["checks"]["brax_production_checkpoint"] is False


def test_validate_nebius_full_training_run_rejects_missing_training_mode_flags(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    (root / "evidence" / "full_training_preflight").mkdir(parents=True)
    _write_json(
        root / "evidence" / "full_training_preflight" / "training_inputs_report.json",
        {
            "ok": True,
            "launch_tasks": ["stand_up"],
            "blockers": [],
            "curriculum": {"content_sha256": "abc123"},
            "datasets": {"offline_datasets_present": False},
        },
    )

    report = validate_nebius_full_training_run(
        root,
        run_id="robot-full-test",
        tasks=("stand_up",),
        run_deep_validators=False,
    )

    training = report["reports"]["training_inputs"]
    assert report["checks"]["training_inputs"] is False
    assert training["checks"]["rl_from_sim_ready"] is False
    assert training["checks"]["offline_datasets_not_blocking_current_plan"] is False


def test_status_consistency_rejects_stale_monitor_and_closeout_claims(
    tmp_path: Path,
) -> None:
    root = tmp_path / "run"
    _write_json(
        root / "monitor_status.json",
        {
            "ok": True,
            "checks": {
                "video_review": True,
                "production_policy_videos": True,
            },
        },
    )
    _write_json(
        root / "closeout_status.json",
        {
            "monitor": {
                "summary": {
                    "passed_gates": ["video_review", "production_policy_videos"],
                },
            },
            "finalization": {"ok": True},
            "artifact_inventory": {
                "ok": True,
                "present_count": 117,
                "required_count": 117,
            },
        },
    )
    _write_json(root / "finalization_report.json", {"ok": False})
    _write_json(
        root / "artifact_inventory.json",
        {"ok": False, "present_count": 164, "required_count": 164},
    )

    report = _validate_status_consistency(
        root,
        {"video_review": False, "production_policy_videos": False},
    )

    assert report["ok"] is False
    assert report["checks"]["monitor_status_consistent"] is False
    assert report["checks"]["closeout_monitor_consistent"] is False
    assert report["checks"]["closeout_finalization_consistent"] is False
    assert report["checks"]["closeout_inventory_consistent"] is False
    assert {item["source"] for item in report["contradictions"]} == {
        "monitor_status",
        "closeout_status.monitor.summary",
        "closeout_status.finalization",
        "closeout_status.artifact_inventory",
    }
