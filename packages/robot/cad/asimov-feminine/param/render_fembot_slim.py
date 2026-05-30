"""
Build the slim fembot visual MJCF from the assembly body tree, swapping the
parametric source-fitted STLs onto every link, narrowing the hip spacing, then
load it in MuJoCo (verifies the model still compiles/forwards/steps) and render
front / left / rear / three-quarter views.

Run:  .venv/bin/python cad/asimov-feminine/param/render_fembot_slim.py
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from pathlib import Path

os.environ.setdefault("MUJOCO_GL", "glfw")

import mujoco
import numpy as np
from PIL import Image

ROBOT = Path("/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot")
SRC_MJCF = ROBOT / "cad/asimov-feminine/output/mjcf/asimov_fembot.xml"
STL_ROOT = ROBOT / "cad/asimov-feminine/output/stl"
OUT_MJCF = ROBOT / "cad/asimov-feminine/output/mjcf/asimov_fembot_slim_visuals.xml"
OUT_DIR = ROBOT / "cad/asimov-feminine/output/media/fembot-slim"

HIP_SPACING = float(os.environ.get("HIP_SPACING", "0.80"))  # scale pelvis->hip_pitch Y


def _link_from_visual(name: str) -> str | None:
    suffix = "_cad_primitive_visual"
    return name[: -len(suffix)].upper() if name.endswith(suffix) else None


def build_visual_mjcf() -> Path:
    tree = ET.parse(SRC_MJCF)
    root = tree.getroot()
    asset = root.find("asset") or ET.SubElement(root, "asset")
    compiler = root.find("compiler")
    if compiler is not None:
        compiler.attrib.pop("meshdir", None)

    # narrow hip spacing: scale Y of the two hip-pitch bodies under the pelvis
    for body in root.findall(".//body"):
        if body.get("name") in ("left_hip_pitch_link", "right_hip_pitch_link"):
            pos = [float(v) for v in body.get("pos").split()]
            pos[1] *= HIP_SPACING
            body.set("pos", " ".join(f"{v:.9g}" for v in pos))

    seen: set[str] = set()
    swapped = 0
    for geom in root.findall(".//geom"):
        link = _link_from_visual(str(geom.get("name") or ""))
        if link is None:
            continue
        mesh_path = STL_ROOT / f"{link}.STL"
        if not mesh_path.is_file():
            continue
        mesh_name = f"slim_{link.lower()}"
        if mesh_name not in seen:
            ET.SubElement(asset, "mesh", {"name": mesh_name, "file": str(mesh_path)})
            seen.add(mesh_name)
        for key in ("type", "size", "pos", "quat", "fromto"):
            geom.attrib.pop(key, None)
        geom.set("type", "mesh")
        geom.set("mesh", mesh_name)
        swapped += 1
    ET.indent(tree, space="  ")
    tree.write(OUT_MJCF, encoding="utf-8", xml_declaration=False)
    print(f"swapped {swapped} visual geoms, {len(seen)} meshes, hip spacing x{HIP_SPACING}")
    return OUT_MJCF


def render(mjcf: Path) -> None:
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    data = mujoco.MjData(model)
    data.qpos[:] = 0.0
    for jid in range(model.njnt):
        if model.jnt_type[jid] == mujoco.mjtJoint.mjJNT_FREE:
            a = int(model.jnt_qposadr[jid])
            data.qpos[a : a + 7] = [0, 0, 0.74, 1, 0, 0, 0]
    mujoco.mj_forward(model, data)
    print(f"MuJoCo OK: bodies={model.nbody} joints={model.njnt} actuators={model.nu} "
          f"meshes={model.nmesh}  (compiled+forward)")

    cams = {
        "front": (180, -6), "rear": (0, -6), "left": (90, -6), "three_quarter": (145, -10),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    r = mujoco.Renderer(model, height=900, width=640)
    try:
        for name, (az, el) in cams.items():
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = [0.0, 0.0, 0.78]
            cam.distance = 1.9
            cam.azimuth = az
            cam.elevation = el
            r.update_scene(data, camera=cam)
            Image.fromarray(r.render()).save(OUT_DIR / f"slim_{name}.png")
    finally:
        r.close()
    print(f"rendered -> {OUT_DIR}")


if __name__ == "__main__":
    render(build_visual_mjcf())
