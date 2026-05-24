from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np

from scripts.validate_multi_robot_training_readiness import (
    DEFAULT_COMMANDS as DEFAULT_MULTI_ROBOT_COMMANDS,
)
from scripts.validate_multi_robot_training_readiness import (
    DEFAULT_PROFILES as DEFAULT_MULTI_ROBOT_PROFILES,
)
from scripts.validate_nebius_full_training_run import (
    STAGES,
    _validate_production_policy_videos,
    sync_from_s3,
    validate_nebius_full_training_run,
)


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


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


def _write_video_telemetry(path: Path) -> None:
    _write_json(
        path,
        {
            "rollout_ok": True,
            "steps_requested": 8,
            "steps_executed": 8,
            "terminated": False,
            "torso_z": {"min": 1.0, "final": 1.0},
            "upright_proj": {"min": 1.0, "final": 1.0},
        },
    )


def _safe_label(label: str) -> str:
    return label.replace(" ", "_").replace("/", "_")[:48]


def _write_multi_robot_videos(root: Path) -> None:
    evidence = root / "evidence" / "agent_videos"
    profiles = []
    for profile in DEFAULT_MULTI_ROBOT_PROFILES:
        profile_dir = evidence / profile
        expected = []
        videos = []
        for command in DEFAULT_MULTI_ROBOT_COMMANDS:
            name = f"{profile}_{_safe_label(command)}.mp4"
            _write_moving_video(profile_dir / name)
            _write_video_telemetry((profile_dir / name).with_suffix(".telemetry.json"))
            expected.append(name)
            videos.append(name)
        combined = f"{profile}_combined_actions.mp4"
        _write_moving_video(profile_dir / combined)
        _write_video_telemetry((profile_dir / combined).with_suffix(".telemetry.json"))
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


def test_validate_nebius_full_training_run_accepts_synced_artifact_tree(
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
    _write_multi_robot_videos(root)
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

    assert report["ok"] is True
    assert report["checks"]["stage_logs"] is True
    assert report["checks"]["stage_status"] is True
    assert report["checks"]["instance_launch_hygiene"] is True
    assert report["checks"]["training_inputs"] is True
    assert report["checks"]["multi_robot_readiness"] is True
    assert report["checks"]["backend_comparison"] is True
    assert report["checks"]["video_review"] is True
    assert report["checks"]["production_policy_videos"] is True
    assert (root / "validation_report.json").is_file()
    assert (root / "validation_summary.md").is_file()
    summary = (root / "validation_summary.md").read_text()
    assert "Production Gates" in summary
    assert "Failed Gates" in summary
    assert "- none" in summary
    assert "Production Policy Videos" in summary
    assert "Checkpoint artifacts exist: `True`" in summary
    assert "Manifest checkpoint bound: `True`" in summary


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
