#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.collision_sweep import APPROVED_FLOOR_PREFIXES  # noqa: E402
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF  # noqa: E402
from eliza_robot.asimov_1.fembot_contact_tuning import (  # noqa: E402
    _limit_inward_hip_roll,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402

FEMBOT_CONTACT_TUNING_PROOF = ASIMOV_PARAM_PROOFS / "fembot-contact-tuning.json"


def _geom_name(mujoco: Any, model: Any, geom_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id)) or str(geom_id)


def _joint_name(mujoco: Any, model: Any, joint_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, int(joint_id)) or str(joint_id)


def _approved_contact(geom_a: str, geom_b: str) -> bool:
    if geom_a == "floor":
        return geom_b.startswith(APPROVED_FLOOR_PREFIXES)
    if geom_b == "floor":
        return geom_a.startswith(APPROVED_FLOOR_PREFIXES)
    return False


def _set_neutral_qpos(data: Any) -> None:
    data.qpos[:] = 0.0
    data.qpos[2] = 0.63
    data.qpos[3] = 1.0


def _camera(mujoco: Any, model: Any, data: Any) -> Any:
    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    root_body = 1 if model.nbody > 1 else 0
    cam.lookat[:] = data.xpos[root_body]
    cam.lookat[2] = 0.34
    cam.distance = 2.0
    cam.azimuth = 135
    cam.elevation = -18
    return cam


def _overlay(frame: np.ndarray, label: str, unapproved: int, torso_z: float) -> np.ndarray:
    image = Image.fromarray(frame)
    draw = ImageDraw.Draw(image)
    text = f"{label} | unapproved contacts: {unapproved} | root z: {torso_z:.3f}m"
    draw.rectangle((8, 8, min(image.width - 8, 8 + len(text) * 7), 30), fill=(0, 0, 0))
    draw.text((12, 12), text, fill=(255, 255, 255))
    return np.asarray(image)


def _contacts(mujoco: Any, model: Any, data: Any) -> tuple[int, list[dict[str, Any]]]:
    unapproved: list[dict[str, Any]] = []
    for contact_idx in range(int(data.ncon)):
        contact = data.contact[contact_idx]
        geom1 = _geom_name(mujoco, model, int(contact.geom1))
        geom2 = _geom_name(mujoco, model, int(contact.geom2))
        if _approved_contact(geom1, geom2):
            continue
        unapproved.append(
            {
                "geom1": geom1,
                "geom2": geom2,
                "distance_m": float(contact.dist),
            }
        )
    return len(unapproved), unapproved


def _limited_hinge_joints(mujoco: Any, model: Any) -> list[dict[str, Any]]:
    joints = []
    for joint_id in range(int(model.njnt)):
        if int(model.jnt_type[joint_id]) != int(mujoco.mjtJoint.mjJNT_HINGE):
            continue
        if not int(model.jnt_limited[joint_id]):
            continue
        lower = float(model.jnt_range[joint_id, 0])
        upper = float(model.jnt_range[joint_id, 1])
        joints.append(
            {
                "joint_id": joint_id,
                "joint": _joint_name(mujoco, model, joint_id),
                "qpos_adr": int(model.jnt_qposadr[joint_id]),
                "lower_rad": lower,
                "upper_rad": upper,
                "mid_rad": (lower + upper) * 0.5,
            }
        )
    return joints


def _write_contact_sheet(paths: list[Path], output: Path, *, columns: int = 4) -> None:
    thumbs = []
    for path in paths:
        image = Image.open(path).convert("RGB")
        image.thumbnail((320, 240))
        thumbs.append((path.stem, image.copy()))
    if not thumbs:
        return
    rows = int(np.ceil(len(thumbs) / columns))
    sheet = Image.new("RGB", (columns * 320, rows * 270), (240, 240, 240))
    draw = ImageDraw.Draw(sheet)
    for index, (label, image) in enumerate(thumbs):
        x = (index % columns) * 320
        y = (index // columns) * 270
        sheet.paste(image, (x, y))
        draw.text((x + 6, y + 244), label[:42], fill=(0, 0, 0))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)


def _write_mp4(frames: list[np.ndarray], output: Path, *, fps: int) -> None:
    if not frames:
        return
    height, width = frames[0].shape[:2]
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-an",
        "-vcodec",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(output),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for frame in frames:
        proc.stdin.write(np.ascontiguousarray(frame[:, :, :3]).tobytes())
    stdout, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError((stderr or stdout).decode("utf-8", errors="replace"))


def _absolutize_meshdir(mjcf: Path, *, source_mjcf: Path) -> None:
    tree = ET.parse(mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is None or not compiler.get("meshdir"):
        return
    meshdir = Path(str(compiler.get("meshdir")))
    if meshdir.is_absolute():
        return
    compiler.set("meshdir", str((source_mjcf.parent / meshdir).resolve()))
    ET.indent(tree, space="  ")
    tree.write(mjcf, encoding="utf-8", xml_declaration=False)


def _parse_range(raw: str | None) -> list[float]:
    if not raw:
        return []
    return [float(part) for part in raw.split()]


def _format_range(values: list[float]) -> str:
    return " ".join(f"{value:.12g}" for value in values)


def _dense_contact_clean_joint_ranges(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    frames_per_joint: int,
) -> dict[str, Any]:
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(source_mjcf))
    data = mujoco.MjData(model)
    updates: dict[str, dict[str, Any]] = {}
    for joint in _limited_hinge_joints(mujoco, model):
        values = np.linspace(
            float(joint["lower_rad"]),
            float(joint["upper_rad"]),
            max(3, frames_per_joint),
        )
        clean = []
        sample_records = []
        for value in values:
            _set_neutral_qpos(data)
            data.qpos[int(joint["qpos_adr"])] = float(value)
            mujoco.mj_forward(model, data)
            unapproved_count, _contacts_list = _contacts(mujoco, model, data)
            is_clean = unapproved_count == 0
            clean.append(is_clean)
            sample_records.append(
                {
                    "value_rad": float(value),
                    "unapproved_contact_count": unapproved_count,
                    "contact_clean": is_clean,
                }
            )
        neutral_index = int(np.argmin(np.abs(values)))
        if not clean[neutral_index]:
            clean_indices = [index for index, is_clean in enumerate(clean) if is_clean]
            if not clean_indices:
                continue
            neutral_index = min(clean_indices, key=lambda index: abs(float(values[index])))
        lower_index = neutral_index
        while lower_index > 0 and clean[lower_index - 1]:
            lower_index -= 1
        upper_index = neutral_index
        while upper_index + 1 < len(clean) and clean[upper_index + 1]:
            upper_index += 1
        new_range = [float(values[lower_index]), float(values[upper_index])]
        old_range = [float(joint["lower_rad"]), float(joint["upper_rad"])]
        changed = (
            abs(new_range[0] - old_range[0]) > 1.0e-12
            or abs(new_range[1] - old_range[1]) > 1.0e-12
        )
        updates[str(joint["joint"])] = {
            "source_range_rad": old_range,
            "output_range_rad": new_range,
            "changed": changed,
            "samples": sample_records,
        }

    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    changed_count = 0
    for joint in root.findall(".//joint"):
        name = str(joint.get("name") or "")
        update = updates.get(name)
        if update is None or not update["changed"]:
            continue
        values = _parse_range(joint.get("range"))
        if len(values) != 2:
            continue
        joint.set("range", _format_range(update["output_range_rad"]))
        changed_count += 1
    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "contact_clean_dense_frames_per_joint": max(3, frames_per_joint),
        "limited_joint_count": len(updates),
        "changed_joint_count": changed_count,
        "joint_ranges": updates,
    }


def render_joint_sweep(
    *,
    mjcf: Path,
    out_dir: Path,
    width: int,
    height: int,
    fps: int,
    frames_per_joint: int,
    hip_roll_inward_limit_rad: float | None,
    contact_clean_dense_ranges: bool,
) -> dict[str, Any]:
    import mujoco

    out_dir.mkdir(parents=True, exist_ok=True)
    screenshot_dir = out_dir / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    video_path = out_dir / "asimov1_constrained_joint_sweep.mp4"
    contact_sheet_path = out_dir / "asimov1_constrained_joint_sweep_contact_sheet.jpg"
    report_path = out_dir / "asimov1_constrained_joint_sweep.json"
    render_mjcf = mjcf
    hip_roll_limit_record = None
    if hip_roll_inward_limit_rad is not None:
        render_mjcf = out_dir / "asimov1_hip_roll_limited.xml"
        hip_roll_limit_record = _limit_inward_hip_roll(
            source_mjcf=mjcf,
            output_mjcf=render_mjcf,
            inward_limit_rad=hip_roll_inward_limit_rad,
        )
        _absolutize_meshdir(render_mjcf, source_mjcf=mjcf)
    contact_clean_range_record = None
    if contact_clean_dense_ranges:
        source_for_dense = render_mjcf
        render_mjcf = out_dir / "asimov1_contact_clean_dense_ranges.xml"
        contact_clean_range_record = _dense_contact_clean_joint_ranges(
            source_mjcf=source_for_dense,
            output_mjcf=render_mjcf,
            frames_per_joint=frames_per_joint,
        )
        _absolutize_meshdir(render_mjcf, source_mjcf=mjcf)

    model = mujoco.MjModel.from_xml_path(str(render_mjcf))
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=height, width=width)
    joints = _limited_hinge_joints(mujoco, model)

    frames: list[np.ndarray] = []
    screenshots: list[Path] = []
    samples: list[dict[str, Any]] = []

    def sample(label: str, overrides: dict[int, float], *, save_screenshot: bool) -> None:
        _set_neutral_qpos(data)
        for qpos_adr, value in overrides.items():
            data.qpos[int(qpos_adr)] = float(value)
        mujoco.mj_forward(model, data)
        unapproved_count, unapproved_contacts = _contacts(mujoco, model, data)
        renderer.update_scene(data, camera=_camera(mujoco, model, data))
        frame = _overlay(renderer.render().copy(), label, unapproved_count, float(data.qpos[2]))
        frames.append(frame)
        screenshot_path = None
        if save_screenshot:
            screenshot_path = screenshot_dir / f"{len(screenshots):03d}_{label.replace(':', '_')}.png"
            Image.fromarray(frame).save(screenshot_path)
            screenshots.append(screenshot_path)
        samples.append(
            {
                "label": label,
                "root_height_m": float(data.qpos[2]),
                "contact_count": int(data.ncon),
                "unapproved_contact_count": unapproved_count,
                "unapproved_contacts": unapproved_contacts[:10],
                "screenshot": str(screenshot_path) if screenshot_path else None,
            }
        )

    sample("neutral", {}, save_screenshot=True)
    for joint in joints:
        qpos_adr = int(joint["qpos_adr"])
        values = np.linspace(
            float(joint["lower_rad"]),
            float(joint["upper_rad"]),
            max(3, frames_per_joint),
        )
        midpoint_index = len(values) // 2
        for index, value in enumerate(values):
            label = f"{joint['joint']}:{index:02d}"
            save = index in {0, midpoint_index, len(values) - 1}
            sample(label, {qpos_adr: float(value)}, save_screenshot=save)

    renderer.close()
    _write_mp4(frames, video_path, fps=fps)
    _write_contact_sheet(screenshots, contact_sheet_path)

    unapproved_samples = [sample for sample in samples if sample["unapproved_contact_count"]]
    root_heights = [float(sample["root_height_m"]) for sample in samples]
    report = {
        "schema": "asimov-1-constrained-joint-sweep-visual-evidence-v1",
        "ok": True,
        "accepted": False,
        "source_mjcf": str(mjcf),
        "mjcf": str(render_mjcf),
        "hip_roll_limit": hip_roll_limit_record,
        "contact_clean_dense_ranges": contact_clean_range_record,
        "video": str(video_path),
        "video_bytes": video_path.stat().st_size if video_path.is_file() else 0,
        "contact_sheet": str(contact_sheet_path),
        "screenshot_dir": str(screenshot_dir),
        "screenshot_count": len(screenshots),
        "joint_count": len(joints),
        "frame_count": len(frames),
        "summary": {
            "limited_hinge_joints": len(joints),
            "hip_roll_inward_limit_rad": hip_roll_inward_limit_rad,
            "hip_roll_limited_joint_count": (
                hip_roll_limit_record.get("limited_joint_count")
                if hip_roll_limit_record
                else 0
            ),
            "contact_clean_dense_range_applied": contact_clean_range_record is not None,
            "contact_clean_dense_range_changed_joints": (
                contact_clean_range_record.get("changed_joint_count")
                if contact_clean_range_record
                else 0
            ),
            "samples": len(samples),
            "unapproved_contact_samples": len(unapproved_samples),
            "max_unapproved_contacts": max(
                (sample["unapproved_contact_count"] for sample in samples),
                default=0,
            ),
            "root_height_min_m": min(root_heights) if root_heights else None,
            "root_height_max_m": max(root_heights) if root_heights else None,
            "standing_height_gate": bool(root_heights and min(root_heights) >= 0.5),
            "video_recorded": video_path.is_file() and video_path.stat().st_size > 0,
            "screenshots_recorded": len(screenshots) == 1 + len(joints) * 3,
            "visual_review_required": True,
            "acceptance_blocker": (
                "visual artifacts are recorded for manual review; exact visible "
                "part-contiguity and no-weirdness acceptance is not automated"
            ),
        },
        "joints": joints,
        "samples": samples,
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render screenshots/video for all limited ASIMOV-1 joint rotations."
    )
    parser.add_argument("--mjcf", type=Path, default=ASIMOV1_GENERATED_MJCF)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "evidence" / "asimov_1_joint_sweep")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--frames-per-joint", type=int, default=15)
    parser.add_argument(
        "--hip-roll-inward-limit-rad",
        type=float,
        default=None,
        help="Clamp inward hip-roll range before rendering the constrained sweep.",
    )
    parser.add_argument(
        "--use-contact-tuning-hip-limit",
        action="store_true",
        help="Use first_hip_roll_limit_contact_clean_rad from fembot-contact-tuning.json.",
    )
    parser.add_argument(
        "--contact-clean-dense-ranges",
        action="store_true",
        help=(
            "Before final rendering, tighten each limited hinge to the contiguous "
            "zero-unapproved-contact interval around neutral using the same dense samples."
        ),
    )
    args = parser.parse_args()
    hip_roll_limit = args.hip_roll_inward_limit_rad
    if args.use_contact_tuning_hip_limit:
        contact_tuning = json.loads(FEMBOT_CONTACT_TUNING_PROOF.read_text(encoding="utf-8"))
        hip_roll_limit = float(
            contact_tuning["summary"]["first_hip_roll_limit_contact_clean_rad"]
        )

    report = render_joint_sweep(
        mjcf=args.mjcf,
        out_dir=args.out_dir,
        width=args.width,
        height=args.height,
        fps=args.fps,
        frames_per_joint=args.frames_per_joint,
        hip_roll_inward_limit_rad=hip_roll_limit,
        contact_clean_dense_ranges=args.contact_clean_dense_ranges,
    )
    print(json.dumps(report["summary"], indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
