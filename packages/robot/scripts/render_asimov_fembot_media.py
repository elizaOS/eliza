"""Render fembot screenshots and simultaneous constrained joint motion video."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

os.environ.setdefault("MUJOCO_GL", "glfw")

import cv2
import mujoco
import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageStat

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MJCF = PACKAGE_ROOT / "cad" / "asimov-feminine" / "output" / "mjcf" / "asimov_fembot.xml"
DEFAULT_OUTPUT = PACKAGE_ROOT / "cad" / "asimov-feminine" / "output" / "media" / "fembot"
DEFAULT_PROOF = PACKAGE_ROOT / "cad" / "asimov-feminine" / "proofs" / "fembot-media-review.json"
DEFAULT_GENERATED_CAD_PROOF = (
    PACKAGE_ROOT / "cad" / "asimov-feminine" / "proofs" / "fembot-generated-cad-envelope.json"
)
DEFAULT_SPLINE_PROOF_ROOT = PACKAGE_ROOT / "cad" / "asimov-feminine" / "proofs"
DEFAULT_SOURCE_FITTED_STL_ROOT = PACKAGE_ROOT / "cad" / "asimov-feminine" / "output" / "stl"


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


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _projection_points(
    vertices: np.ndarray,
    dims: tuple[int, int],
    *,
    image_size: int,
    margin: int,
) -> list[tuple[float, float]]:
    points = vertices[:, list(dims)].astype(float)
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    span = np.maximum(hi - lo, 1.0e-9)
    scale = (image_size - margin * 2) / float(max(span))
    centered = (points - (lo + hi) * 0.5) * scale
    return [
        (
            float(image_size * 0.5 + point[0]),
            float(image_size * 0.5 - point[1]),
        )
        for point in centered
    ]


def _draw_mesh_projection(
    *,
    mesh: trimesh.Trimesh,
    title: str,
    output: Path,
    image_size: int = 360,
) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGB", (image_size * 3, image_size + 42), (248, 248, 246))
    draw = ImageDraw.Draw(canvas)
    vertices = np.asarray(mesh.vertices)
    face_indices = np.asarray(mesh.faces)
    views = [
        ("XY", (0, 1), 0),
        ("XZ", (0, 2), image_size),
        ("YZ", (1, 2), image_size * 2),
    ]
    for label, dims, x_offset in views:
        projected = _projection_points(
            vertices,
            dims,
            image_size=image_size,
            margin=22,
        )
        for face in face_indices:
            coords = [
                (projected[int(index)][0] + x_offset, projected[int(index)][1] + 36)
                for index in face
            ]
            draw.line([*coords, coords[0]], fill=(35, 88, 110), width=1)
        draw.rectangle(
            [x_offset + 6, 36 + 6, x_offset + image_size - 6, 36 + image_size - 6],
            outline=(170, 170, 165),
            width=1,
        )
        draw.text((x_offset + 12, 12), label, fill=(30, 30, 30))
    draw.text((12, image_size + 18), title, fill=(25, 25, 25))
    canvas.save(output)
    return _nonblank_image(output)


def _source_fitted_part_screenshots(
    *,
    generated_cad_proof: Path,
    spline_proof_root: Path,
    output_root: Path,
) -> list[dict[str, Any]]:
    generated = _load_json(generated_cad_proof) or {}
    records = []
    for record in generated.get("link_steps", []):
        if record.get("shape_family") != "source_fitted_controlled_loft":
            continue
        link = str(record.get("link", "")).upper()
        spline = _load_json(spline_proof_root / f"{link}.spline-fit.json") or {}
        mesh_path = Path(str(spline.get("output_mesh_path") or ""))
        if not link or not mesh_path.is_file():
            records.append(
                {
                    "link": link,
                    "exists": False,
                    "nonblank": False,
                    "blocking_reason": "missing controlled-loft output mesh for media projection",
                }
            )
            continue
        mesh = trimesh.load(mesh_path, force="mesh")
        output = output_root / f"fembot_source_fitted_{link.lower()}.png"
        image_report = _draw_mesh_projection(
            mesh=mesh,
            title=f"{link} source-fitted controlled loft",
            output=output,
        )
        records.append(
            {
                "link": link,
                "shape_family": record.get("shape_family"),
                "generated_step_path": record.get("step_path"),
                "generated_step_sha256": record.get("step_sha256"),
                "controlled_loft_mesh": str(mesh_path),
                "controlled_loft_mesh_sha256": spline.get("output_mesh_sha256"),
                "source_mesh": spline.get("mesh_path"),
                "surface_symmetric_hausdorff_m": spline.get("summary", {}).get(
                    "surface_symmetric_hausdorff_m"
                ),
                **image_report,
            }
        )
    return records


def _link_from_primitive_visual_name(name: str) -> str | None:
    suffix = "_cad_primitive_visual"
    if not name.endswith(suffix):
        return None
    return name[: -len(suffix)].upper()


def _write_source_fitted_visual_mjcf(
    *,
    mjcf_path: Path,
    output_root: Path,
    stl_root: Path = DEFAULT_SOURCE_FITTED_STL_ROOT,
) -> dict[str, Any]:
    tree = ET.parse(mjcf_path)
    root = tree.getroot()
    asset = root.find("asset")
    if asset is None:
        asset = ET.SubElement(root, "asset")
    compiler = root.find("compiler")
    if compiler is not None:
        compiler.attrib.pop("meshdir", None)

    replacements: list[dict[str, Any]] = []
    mesh_assets: set[str] = set()
    for geom in root.findall(".//geom"):
        link = _link_from_primitive_visual_name(str(geom.get("name") or ""))
        if link is None:
            continue
        mesh_path = stl_root / f"{link}.STL"
        mesh_name = f"source_fitted_{link.lower()}"
        if not mesh_path.is_file():
            replacements.append(
                {
                    "link": link,
                    "replaced": False,
                    "blocking_reason": "missing source-fitted controlled loft STL mesh",
                    "mesh_path": str(mesh_path),
                }
            )
            continue
        if mesh_name not in mesh_assets:
            ET.SubElement(asset, "mesh", {"name": mesh_name, "file": str(mesh_path)})
            mesh_assets.add(mesh_name)
        for key in ("type", "size", "pos", "quat", "fromto"):
            geom.attrib.pop(key, None)
        geom.set("type", "mesh")
        geom.set("mesh", mesh_name)
        replacements.append(
            {
                "link": link,
                "replaced": True,
                "mesh_name": mesh_name,
                "mesh_path": str(mesh_path),
            }
        )

    output_path = output_root / "asimov_fembot_source_fitted_visuals.xml"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_path, encoding="utf-8", xml_declaration=False)
    return {
        "path": str(output_path),
        "exists": output_path.is_file(),
        "source_mjcf": str(mjcf_path),
        "mesh_assets": len(mesh_assets),
        "visual_replacements": sum(1 for item in replacements if item.get("replaced")),
        "replacement_failures": sum(1 for item in replacements if not item.get("replaced")),
        "replacements": replacements,
    }


def _source_fitted_assembly_screenshots(
    *,
    source_fitted_mjcf: Path,
    output_root: Path,
    width: int,
    height: int,
) -> list[dict[str, Any]]:
    model = mujoco.MjModel.from_xml_path(str(source_fitted_mjcf))
    data = mujoco.MjData(model)
    screenshots: list[dict[str, Any]] = []
    camera_specs = {
        "front": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": 180, "elevation": -8},
        "left": {"lookat": [0.0, 0.0, 0.78], "distance": 1.9, "azimuth": 90, "elevation": -8},
        "three_quarter": {"lookat": [0.0, 0.0, 0.82], "distance": 1.75, "azimuth": 145, "elevation": -10},
    }
    renderer = mujoco.Renderer(model, height=height, width=width)
    try:
        _reset_pose(model, data)
        for name, spec in camera_specs.items():
            renderer.update_scene(data, camera=_camera(spec))
            path = output_root / f"fembot_source_fitted_assembly_{name}.png"
            Image.fromarray(renderer.render()).save(path)
            screenshots.append({"name": name, **_nonblank_image(path)})
    finally:
        renderer.close()
    return screenshots


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
    generated_cad_proof: Path = DEFAULT_GENERATED_CAD_PROOF,
    spline_proof_root: Path = DEFAULT_SPLINE_PROOF_ROOT,
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
    source_fitted_part_media = _source_fitted_part_screenshots(
        generated_cad_proof=generated_cad_proof,
        spline_proof_root=spline_proof_root,
        output_root=output_root,
    )
    source_fitted_visual_mjcf = _write_source_fitted_visual_mjcf(
        mjcf_path=mjcf_path,
        output_root=output_root,
    )
    source_fitted_assembly_media = _source_fitted_assembly_screenshots(
        source_fitted_mjcf=Path(str(source_fitted_visual_mjcf["path"])),
        output_root=output_root,
        width=width,
        height=height,
    )

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
        "source_fitted_part_media": source_fitted_part_media,
        "source_fitted_visual_mjcf": source_fitted_visual_mjcf,
        "source_fitted_assembly_media": source_fitted_assembly_media,
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
    parser.add_argument("--generated-cad-proof", type=Path, default=DEFAULT_GENERATED_CAD_PROOF)
    parser.add_argument("--spline-proof-root", type=Path, default=DEFAULT_SPLINE_PROOF_ROOT)
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
        generated_cad_proof=args.generated_cad_proof,
        spline_proof_root=args.spline_proof_root,
    )
    print(json.dumps({"ok": proof["ok"], "screenshots": len(proof["screenshots"]), "video": proof["video"]}, indent=2))


if __name__ == "__main__":
    main()
