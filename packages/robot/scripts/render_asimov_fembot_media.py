"""Render fembot screenshots and simultaneous constrained joint motion video."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

os.environ.setdefault("MUJOCO_GL", "glfw")

import cv2
import mujoco
import numpy as np
from PIL import Image, ImageStat

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MJCF = PACKAGE_ROOT / "cad" / "asimov-feminine" / "output" / "mjcf" / "asimov_fembot.xml"
DEFAULT_OUTPUT = PACKAGE_ROOT / "cad" / "asimov-feminine" / "output" / "media" / "fembot"
DEFAULT_PROOF = PACKAGE_ROOT / "cad" / "asimov-feminine" / "proofs" / "fembot-media-review.json"


def _joint_name(model: mujoco.MjModel, joint_id: int) -> str:
    name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id)
    return str(name or f"joint_{joint_id}")


def _reset_pose(model: mujoco.MjModel, data: mujoco.MjData) -> None:
    data.qpos[:] = 0.0
    for joint_id in range(model.njnt):
        if model.jnt_type[joint_id] == mujoco.mjtJoint.mjJNT_FREE:
            qadr = int(model.jnt_qposadr[joint_id])
            data.qpos[qadr : qadr + 7] = [0.0, 0.0, 0.74, 1.0, 0.0, 0.0, 0.0]
    mujoco.mj_forward(model, data)


def _limited_hinge_joints(model: mujoco.MjModel) -> list[dict[str, Any]]:
    joints: list[dict[str, Any]] = []
    for joint_id in range(model.njnt):
        if model.jnt_type[joint_id] != mujoco.mjtJoint.mjJNT_HINGE:
            continue
        low, high = [float(value) for value in model.jnt_range[joint_id]]
        if not np.isfinite([low, high]).all() or high <= low:
            low, high = -0.35, 0.35
        center = (low + high) * 0.5
        amplitude = (high - low) * 0.45
        joints.append(
            {
                "id": joint_id,
                "name": _joint_name(model, joint_id),
                "qpos_address": int(model.jnt_qposadr[joint_id]),
                "range_rad": [low, high],
                "center_rad": center,
                "amplitude_rad": amplitude,
            }
        )
    return joints


def _set_joint_motion(model: mujoco.MjModel, data: mujoco.MjData, joints: list[dict[str, Any]], phase: float) -> None:
    for index, joint in enumerate(joints):
        low, high = joint["range_rad"]
        offset = 2.0 * math.pi * index / max(len(joints), 1)
        value = joint["center_rad"] + joint["amplitude_rad"] * math.sin(phase + offset)
        data.qpos[int(joint["qpos_address"])] = float(np.clip(value, low, high))
    mujoco.mj_forward(model, data)


def _camera(spec: dict[str, Any]) -> mujoco.MjvCamera:
    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    cam.lookat[:] = spec["lookat"]
    cam.distance = float(spec["distance"])
    cam.azimuth = float(spec["azimuth"])
    cam.elevation = float(spec["elevation"])
    return cam


def _nonblank_image(path: Path) -> dict[str, Any]:
    image = Image.open(path).convert("RGB")
    stat = ImageStat.Stat(image)
    stddev = [round(float(value), 3) for value in stat.stddev]
    return {
        "path": str(path),
        "exists": path.is_file(),
        "bytes": path.stat().st_size if path.is_file() else 0,
        "width": image.width,
        "height": image.height,
        "stddev_rgb": stddev,
        "nonblank": max(stddev) >= 1.0,
    }


def _write_video(frames_dir: Path, output: Path, *, fps: int) -> dict[str, Any]:
    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if not frame_paths:
        raise RuntimeError("no video frames were rendered")
    first = cv2.imread(str(frame_paths[0]))
    if first is None:
        raise RuntimeError(f"could not read first rendered frame: {frame_paths[0]}")
    height, width = first.shape[:2]
    output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("OpenCV could not open an MP4 writer")
    for frame_path in frame_paths:
        frame = cv2.imread(str(frame_path))
        if frame is None:
            raise RuntimeError(f"could not read rendered frame: {frame_path}")
        writer.write(frame)
    writer.release()
    return {
        "path": str(output),
        "exists": output.is_file(),
        "bytes": output.stat().st_size if output.is_file() else 0,
        "frame_count": len(frame_paths),
        "fps": fps,
        "width": width,
        "height": height,
    }


def render_media(
    *,
    mjcf_path: Path,
    output_root: Path,
    proof_path: Path,
    width: int,
    height: int,
    frames: int,
    fps: int,
    keep_frames: bool,
) -> dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    frames_dir = output_root / "joint_rotation_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    joints = _limited_hinge_joints(model)
    screenshots: list[dict[str, Any]] = []
    camera_specs = {
        "front": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": 180, "elevation": -8},
        "rear": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": 0, "elevation": -8},
        "left": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": 90, "elevation": -8},
        "right": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": -90, "elevation": -8},
        "three_quarter": {"lookat": [0.0, 0.0, 0.82], "distance": 1.75, "azimuth": 145, "elevation": -10},
        "upper_three_quarter": {"lookat": [0.02, 0.0, 1.05], "distance": 1.05, "azimuth": 145, "elevation": -8},
    }

    renderer = mujoco.Renderer(model, height=height, width=width)
    try:
        _reset_pose(model, data)
        for name, spec in camera_specs.items():
            renderer.update_scene(data, camera=_camera(spec))
            path = output_root / f"fembot_{name}.png"
            Image.fromarray(renderer.render()).save(path)
            screenshots.append({"name": name, **_nonblank_image(path)})

        video_cam_spec = {"lookat": [0.0, 0.0, 0.82], "distance": 1.8, "azimuth": 150, "elevation": -9}
        for frame in range(frames):
            phase = 2.0 * math.pi * frame / frames
            _set_joint_motion(model, data, joints, phase)
            renderer.update_scene(data, camera=_camera(video_cam_spec))
            Image.fromarray(renderer.render()).save(frames_dir / f"frame_{frame:04d}.png")
    finally:
        renderer.close()

    video = _write_video(frames_dir, output_root / "fembot_all_joints_simultaneous_constraints.mp4", fps=fps)
    sample_frames = [
        _nonblank_image(path)
        for path in [frames_dir / "frame_0000.png", frames_dir / f"frame_{frames // 2:04d}.png", frames_dir / f"frame_{frames - 1:04d}.png"]
        if path.is_file()
    ]
    if not keep_frames:
        shutil.rmtree(frames_dir)

    proof = {
        "schema": "asimov-fembot-media-review-v1",
        "ok": bool(
            screenshots
            and all(item["exists"] and item["nonblank"] for item in screenshots)
            and video["exists"]
            and video["bytes"] > 0
            and sample_frames
            and all(item["nonblank"] for item in sample_frames)
        ),
        "accepted": False,
        "source": {"mjcf": str(mjcf_path), "output_root": str(output_root)},
        "screenshots": screenshots,
        "video": video,
        "joint_motion": {
            "mode": "all limited hinge joints driven simultaneously by phase-offset sinusoid",
            "joint_count": len(joints),
            "joints": [
                {key: value for key, value in joint.items() if key != "id"}
                for joint in joints
            ],
        },
        "sample_video_frames": sample_frames,
        "verification": {
            "renderer": "mujoco.Renderer",
            "video_encoder": "opencv VideoWriter mp4v",
            "constraint_policy": "values clipped to each MuJoCo joint range every frame",
            "acceptance_blocker": "visual media generated; engineering acceptance still requires manual review and measured hardware calibration",
        },
    }
    proof_path.parent.mkdir(parents=True, exist_ok=True)
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return proof


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mjcf", type=Path, default=DEFAULT_MJCF)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--proof-output", type=Path, default=DEFAULT_PROOF)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--frames", type=int, default=144)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--keep-frames", action="store_true")
    args = parser.parse_args()
    proof = render_media(
        mjcf_path=args.mjcf,
        output_root=args.output_root,
        proof_path=args.proof_output,
        width=args.width,
        height=args.height,
        frames=args.frames,
        fps=args.fps,
        keep_frames=args.keep_frames,
    )
    print(json.dumps({"ok": proof["ok"], "screenshots": len(proof["screenshots"]), "video": proof["video"]}, indent=2))


if __name__ == "__main__":
    main()
