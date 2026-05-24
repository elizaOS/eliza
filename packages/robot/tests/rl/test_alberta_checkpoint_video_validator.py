from __future__ import annotations

import json
from pathlib import Path

from scripts.validate_alberta_checkpoint_videos import validate_alberta_checkpoint_videos


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_checkpoint(root: Path, profile: str) -> Path:
    checkpoint = root / "evidence" / "alberta_all_profiles" / profile / "alberta"
    checkpoint.mkdir(parents=True, exist_ok=True)
    (checkpoint / "alberta_policy.npz").write_bytes(b"checkpoint")
    _write_json(
        checkpoint / "manifest.json",
        {
            "regime": "alberta_streaming",
            "profile_id": profile,
        },
    )
    return checkpoint


def _write_videos(root: Path, profile: str, checkpoint: Path, *, wrong_source: bool = False) -> None:
    evidence = root / "evidence" / "alberta_checkpoint_videos"
    profile_dir = evidence / profile
    profile_dir.mkdir(parents=True, exist_ok=True)
    source = f"checkpoint:{checkpoint.relative_to(root).as_posix()}"
    if wrong_source:
        source = "checkpoint:evidence/alberta_all_profiles/other/alberta"
    videos = [
        f"{profile}_stand_up.mp4",
        f"{profile}_walk_forward.mp4",
        f"{profile}_combined_actions.mp4",
    ]
    for video in videos:
        (profile_dir / video).write_bytes(b"x" * 2048)
        telemetry = {
            "label": video.removeprefix(f"{profile}_").removesuffix(".mp4").replace("_", " "),
            "policy_source": source,
            "rollout_ok": True,
            "steps_executed": 30,
            "reward": {"min": 1.0, "max": 2.0, "final": 1.5, "mean": 1.4},
            "torso_z": {"min": 0.5, "max": 0.7, "final": 0.6, "mean": 0.6},
            "upright_proj": {"min": 0.9, "max": 1.0, "final": 0.95, "mean": 0.96},
            "checks": {
                "no_termination": True,
                "torso_above_fall_threshold": True,
                "upright_positive": True,
            },
        }
        if video.endswith("combined_actions.mp4"):
            telemetry["commands"] = [
                {
                    "label": "stand up",
                    "policy_source": source,
                    "rollout_ok": True,
                    "steps_executed": 30,
                    "reward": {"min": 1.0, "max": 2.0, "final": 1.5, "mean": 1.4},
                    "torso_z": {"min": 0.5, "max": 0.7, "final": 0.6, "mean": 0.6},
                    "upright_proj": {"min": 0.9, "max": 1.0, "final": 0.95, "mean": 0.96},
                    "checks": {
                        "no_termination": True,
                        "torso_above_fall_threshold": True,
                        "upright_positive": True,
                    },
                },
                {
                    "label": "walk forward",
                    "policy_source": source,
                    "rollout_ok": True,
                    "steps_executed": 30,
                    "reward": {"min": 1.0, "max": 2.0, "final": 1.5, "mean": 1.4},
                    "torso_z": {"min": 0.5, "max": 0.7, "final": 0.6, "mean": 0.6},
                    "upright_proj": {"min": 0.9, "max": 1.0, "final": 0.95, "mean": 0.96},
                    "checks": {
                        "no_termination": True,
                        "torso_above_fall_threshold": True,
                        "upright_positive": True,
                    },
                },
            ]
        _write_json((profile_dir / video).with_suffix(".telemetry.json"), telemetry)
    _write_json(
        evidence / "manifest.json",
        {
            "ok": True,
            "profiles": [
                {
                    "profile": profile,
                    "policy_checkpoint": str(checkpoint.resolve()),
                    "videos": videos,
                    "telemetry": [Path(video).with_suffix(".telemetry.json").name for video in videos],
                    "combined_present": True,
                    "ok": True,
                }
            ],
        },
    )
    _write_json(
        root / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 3,
            "profiles": [profile],
            "actions": ["combined_actions", "stand_up", "walk_forward"],
            "all_videos_reviewed_good": True,
            "telemetry": {"present_count": 3, "ok_count": 3, "failed_count": 0},
        },
    )


def test_alberta_checkpoint_video_validator_accepts_bound_policy_sources(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path, "asimov-1")
    _write_videos(tmp_path, "asimov-1", checkpoint)

    report = validate_alberta_checkpoint_videos(
        package_root=tmp_path,
        evidence_dir=tmp_path / "evidence" / "alberta_checkpoint_videos",
        review_path=tmp_path / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        profiles=("asimov-1",),
        commands=("stand up", "walk forward"),
    )

    assert report["ok"] is True
    assert report["checks"]["videos"] is True
    assert report["profile_reports"][0]["checks"]["manifest_checkpoint"] is True
    assert all(video["policy_source_ok"] for video in report["video_reports"])
    assert all(video["task_signal_ok"] for video in report["video_reports"])


def test_alberta_checkpoint_video_validator_rejects_wrong_policy_source(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path, "asimov-1")
    _write_videos(tmp_path, "asimov-1", checkpoint, wrong_source=True)

    report = validate_alberta_checkpoint_videos(
        package_root=tmp_path,
        evidence_dir=tmp_path / "evidence" / "alberta_checkpoint_videos",
        review_path=tmp_path / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        profiles=("asimov-1",),
        commands=("stand up", "walk forward"),
    )

    assert report["ok"] is False
    assert report["checks"]["videos"] is False
    assert {video["policy_source_ok"] for video in report["video_reports"]} == {False}


def test_alberta_checkpoint_video_validator_rejects_missing_task_signal(tmp_path: Path) -> None:
    checkpoint = _write_checkpoint(tmp_path, "asimov-1")
    _write_videos(tmp_path, "asimov-1", checkpoint)
    telemetry_path = (
        tmp_path
        / "evidence"
        / "alberta_checkpoint_videos"
        / "asimov-1"
        / "asimov-1_stand_up.telemetry.json"
    )
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
    telemetry.pop("reward")
    telemetry_path.write_text(json.dumps(telemetry, indent=2) + "\n", encoding="utf-8")

    report = validate_alberta_checkpoint_videos(
        package_root=tmp_path,
        evidence_dir=tmp_path / "evidence" / "alberta_checkpoint_videos",
        review_path=tmp_path / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        profiles=("asimov-1",),
        commands=("stand up", "walk forward"),
    )

    assert report["ok"] is False
    assert report["checks"]["videos"] is False
    assert {video["task_signal_ok"] for video in report["video_reports"]} == {False, True}
