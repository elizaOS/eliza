from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from scripts.review_robot_video_evidence import review_videos


def _write_video(path: Path, *, frames: int, moving: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        30.0,
        (64, 48),
    )
    assert writer.isOpened()
    for i in range(frames):
        frame = np.zeros((48, 64, 3), dtype=np.uint8)
        x = 8 + (i if moving else 0)
        frame[12:36, x : x + 12] = (255, 255, 255)
        writer.write(frame)
    writer.release()


def test_video_review_accepts_nonblank_moving_clip(tmp_path: Path) -> None:
    _write_video(tmp_path / "evidence" / "robot-a" / "robot-a_walk.mp4", frames=8, moving=True)

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
    )

    assert report["ok"] is True
    assert report["video_count"] == 1
    assert report["videos"][0]["checks"]["motion_or_camera_change"] is True
    assert report["videos"][0]["checks"]["action_progress"] is True
    assert report["videos"][0]["visual_progress"] > 0.0
    assert report["min_visual_progress"] == report["videos"][0]["visual_progress"]
    assert report["mean_visual_progress"] == report["videos"][0]["visual_progress"]
    assert report["profiles"] == ["robot-a"]
    assert report["actions"] == ["walk"]
    assert report["all_videos_reviewed_good"] is True
    assert report["profile_action_matrix"] == {"robot-a": ["walk"]}
    assert report["videos"][0]["action"] == "walk"
    assert report["videos"][0]["verdict"] == "good"
    assert "robot motion" in report["videos"][0]["review_notes"]
    assert (tmp_path / "review" / "video_review.json").is_file()


def test_video_review_rejects_static_one_frame_clip(tmp_path: Path) -> None:
    _write_video(tmp_path / "evidence" / "robot-a" / "robot-a_still.mp4", frames=1, moving=False)

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
    )

    assert report["ok"] is False
    assert report["videos"][0]["checks"]["frame_count"] is False
    assert report["videos"][0]["checks"]["motion_or_camera_change"] is False
    assert report["videos"][0]["checks"]["action_progress"] is False
    assert report["videos"][0]["action"] == "still"
    assert report["videos"][0]["verdict"] == "needs-work"
    assert report["all_videos_reviewed_good"] is False


def test_video_review_uses_rollout_telemetry_sidecar(tmp_path: Path) -> None:
    video = tmp_path / "evidence" / "robot-a" / "robot-a_walk.mp4"
    _write_video(video, frames=8, moving=True)
    video.with_suffix(".telemetry.json").write_text(
        json.dumps(
            {
                "rollout_ok": False,
                "steps_executed": 3,
                "steps_requested": 8,
                "terminated": True,
                "first_done_step": 3,
                "torso_z": {"min": 0.02, "final": 0.02},
                "upright_proj": {"min": -0.4, "final": -0.4},
            }
        ),
        encoding="utf-8",
    )

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
    )

    assert report["ok"] is False
    assert report["telemetry"]["present_count"] == 1
    assert report["telemetry"]["failed_count"] == 1
    assert report["videos"][0]["checks"]["telemetry_rollout_ok"] is False
    assert report["videos"][0]["telemetry"]["ok"] is False
    assert report["videos"][0]["verdict"] == "needs-work"


def test_video_review_accepts_boundary_step_torso_tolerance(tmp_path: Path) -> None:
    video = tmp_path / "evidence" / "robot-a" / "robot-a_walk.mp4"
    _write_video(video, frames=40, moving=True)
    video.with_suffix(".telemetry.json").write_text(
        json.dumps(
            {
                "rollout_ok": False,
                "steps_executed": 40,
                "steps_requested": 40,
                "terminated": True,
                "truncated": True,
                "first_done_step": 40,
                "fall_threshold": 0.378,
                "torso_z": {"min": 0.3738, "final": 0.3738},
                "upright_proj": {"min": 0.59, "final": 0.59},
            }
        ),
        encoding="utf-8",
    )

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
        require_telemetry=True,
    )

    assert report["ok"] is True
    assert report["telemetry"]["ok_count"] == 1
    assert report["telemetry"]["failed_count"] == 0
    assert report["videos"][0]["checks"]["telemetry_rollout_ok"] is True
    assert report["videos"][0]["telemetry"]["final_step_fall_tolerance_applied"] is True


def test_video_review_accepts_combined_boundary_step_commands(tmp_path: Path) -> None:
    video = tmp_path / "evidence" / "robot-a" / "robot-a_combined_actions.mp4"
    _write_video(video, frames=80, moving=True)
    command = {
        "rollout_ok": False,
        "steps_executed": 40,
        "steps_requested": 40,
        "terminated": True,
        "truncated": True,
        "first_done_step": 40,
        "fall_threshold": 0.378,
        "torso_z": {"min": 0.3738, "final": 0.3738},
        "upright_proj": {"min": 0.59, "final": 0.59},
    }
    video.with_suffix(".telemetry.json").write_text(
        json.dumps({"rollout_ok": False, "commands": [command, command]}),
        encoding="utf-8",
    )

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
        require_telemetry=True,
    )

    assert report["ok"] is True
    assert report["telemetry"]["ok_count"] == 1
    assert report["videos"][0]["checks"]["telemetry_rollout_ok"] is True
    assert report["videos"][0]["telemetry"]["failed_commands"] == []


def test_video_review_can_require_telemetry(tmp_path: Path) -> None:
    _write_video(tmp_path / "evidence" / "robot-a" / "robot-a_walk.mp4", frames=8, moving=True)

    report = review_videos(
        tmp_path / "evidence",
        out_dir=tmp_path / "review",
        samples=4,
        min_frames=5,
        min_nonblank_ratio=0.01,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.01,
        require_telemetry=True,
    )

    assert report["ok"] is False
    assert report["videos"][0]["checks"]["telemetry_present"] is False
    assert report["telemetry"]["present_count"] == 0
