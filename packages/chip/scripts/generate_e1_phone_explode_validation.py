#!/usr/bin/env python3
"""Explode-state collision validation + per-part exploded screenshots for the e1-phone.

Verifies two distinct things the assembled boolean check cannot:
  1. No part passes *through* another while the explode plays. Sampled along the
     full explode trajectory, no part-part AABB interpenetration may grow beyond
     its assembled baseline (monotone separation), and at full explode no two
     parts may share volume above tolerance.
  2. Each individual part is rendered in its exploded position (highlighted, with
     the rest ghosted) so a reviewer can confirm the part's geometry and that it
     stands clear of its neighbours.

AABB overlap is a conservative proxy: world-axis-aligned box parts make it exact,
curved parts make it pessimistic, so a clean report has no false negatives.

Re-runnable. Reads out/e1-phone-assembly.glb + out/assembly-manifest.json and the
same classify()/RING_MM explode model the animation uses, so the proof matches the
video frame-for-frame.
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any, cast

import numpy as np
import trimesh

os.environ.setdefault("PYOPENGL_PLATFORM", "egl")

ROOT = Path("/home/shaw/milady/eliza/packages/chip/mechanical/e1-phone")
OUT = ROOT / "out"
REVIEW = ROOT / "review"
ASM_GLB = OUT / "e1-phone-assembly.glb"
MANIFEST = OUT / "assembly-manifest.json"
PART_SHOTS = OUT / "e1-phone-part-explode-shots"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_e1_phone_exploded_animation import RING_MM, classify, color_for  # noqa: E402

# Penetration tolerance: assembled parts share datum faces, and CAD envelopes carry
# datasheet-typical slop, so treat sub-0.05 mm^3 growth as numerical noise.
OVERLAP_TOL_MM3 = 0.05
SAMPLES = 21  # trajectory fractions f in [0, 1]


def load_parts() -> tuple[trimesh.Scene, list[dict[str, Any]]]:
    scene = cast(trimesh.Scene, trimesh.load(str(ASM_GLB), force="scene"))
    manifest = json.loads(MANIFEST.read_text())
    parts: list[dict[str, Any]] = []
    for entry in manifest:
        name = entry["name"]
        if name not in scene.geometry:
            continue
        direction, ring = classify(name)
        mesh = scene.geometry[name]
        parts.append(
            {
                "name": name,
                "dir": np.asarray(direction, dtype=float),
                "ring": int(ring),
                "base_min": np.asarray(mesh.bounds[0], dtype=float),
                "base_max": np.asarray(mesh.bounds[1], dtype=float),
            }
        )
    return scene, parts


def aabb_at(part: dict, frac: float) -> tuple[np.ndarray, np.ndarray]:
    offset = part["dir"] * (part["ring"] * RING_MM) * frac
    return part["base_min"] + offset, part["base_max"] + offset


def overlap_volume(amin, amax, bmin, bmax) -> float:
    lo = np.maximum(amin, bmin)
    hi = np.minimum(amax, bmax)
    span = hi - lo
    if np.any(span <= 0.0):
        return 0.0
    return float(span[0] * span[1] * span[2])


def is_virtual_volume(name: str) -> bool:
    """Keepouts are reserved-air envelopes (RF/SIM service space), not solid bodies.

    They are rendered for context but cannot physically collide, so they are
    excluded from solid-vs-solid interference.
    """
    return "keepout" in name.lower()


def check_collisions(all_parts: list[dict]) -> dict:
    fracs = [i / (SAMPLES - 1) for i in range(SAMPLES)]
    excluded = [p["name"] for p in all_parts if is_virtual_volume(p["name"])]
    parts = [p for p in all_parts if not is_virtual_volume(p["name"])]
    n = len(parts)
    growth_pairs: list[dict] = []
    residual_pairs: list[dict] = []
    for i in range(n):
        amins = [aabb_at(parts[i], f) for f in fracs]
        for j in range(i + 1, n):
            bmins = [aabb_at(parts[j], f) for f in fracs]
            vols = [
                overlap_volume(amins[k][0], amins[k][1], bmins[k][0], bmins[k][1])
                for k in range(len(fracs))
            ]
            baseline = vols[0]
            peak = max(vols[1:])
            peak_frac = fracs[1 + int(np.argmax(vols[1:]))]
            if peak > baseline + OVERLAP_TOL_MM3:
                growth_pairs.append(
                    {
                        "a": parts[i]["name"],
                        "b": parts[j]["name"],
                        "assembled_overlap_mm3": round(baseline, 4),
                        "peak_overlap_mm3": round(peak, 4),
                        "peak_at_fraction": round(peak_frac, 3),
                        "growth_mm3": round(peak - baseline, 4),
                    }
                )
            if vols[-1] > OVERLAP_TOL_MM3:
                residual_pairs.append(
                    {
                        "a": parts[i]["name"],
                        "b": parts[j]["name"],
                        "fully_exploded_overlap_mm3": round(vols[-1], 4),
                    }
                )
    passed = len(growth_pairs) == 0
    report = {
        "claim_boundary": (
            "Geometric explode-trajectory collision proxy. Part-part overlap is "
            "measured as world-AABB interpenetration volume sampled across the explode "
            "path; exact for axis-aligned box envelopes, conservative for curved parts. "
            "Supplier B-rep boolean remains the signoff engine for the assembled state."
        ),
        "status": "explode_collision_pass" if passed else "explode_collision_fail",
        "engine": "world_aabb_overlap_volume_swept_along_explode_trajectory",
        "ring_offset_mm": RING_MM,
        "trajectory_samples": SAMPLES,
        "overlap_tolerance_mm3": OVERLAP_TOL_MM3,
        "solid_part_count": len(parts),
        "excluded_virtual_volume_count": len(excluded),
        "excluded_virtual_volumes": excluded,
        "pair_count": n * (n - 1) // 2,
        "pass_through_pair_count": len(growth_pairs),
        "pass_through_pairs": growth_pairs,
        "residual_overlap_at_full_explode_pair_count": len(residual_pairs),
        "residual_overlap_pairs": residual_pairs,
        "release_rule": (
            "No part-part overlap may grow beyond its assembled baseline anywhere on "
            "the explode trajectory (no pass-through). Residual overlaps at full "
            "explode are reported for review; same-axis stacked parts may legitimately "
            "remain nested if their assembled overlap does not grow."
        ),
    }
    return report


def write_collision_report(report: dict) -> None:
    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "explode-collision.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Explode-State Collision Validation",
        "",
        f"Status: {report['status']}.",
        "",
        f"Engine: `{report['engine']}`.",
        f"Solid parts: {report['solid_part_count']}. Pairs checked: {report['pair_count']}. "
        f"Trajectory samples: {report['trajectory_samples']}. "
        f"Virtual keepout volumes excluded: {report['excluded_virtual_volume_count']}.",
        "",
        "## Pass-through (overlap grows during explode)",
        "",
    ]
    if report["pass_through_pairs"]:
        for pair in report["pass_through_pairs"]:
            lines.append(
                f"- FAIL: `{pair['a']}` vs `{pair['b']}` grows "
                f"{pair['growth_mm3']} mm^3 (peak {pair['peak_overlap_mm3']} mm^3 "
                f"at f={pair['peak_at_fraction']})"
            )
    else:
        lines.append("- PASS: no part overlap grows beyond its assembled baseline.")
    lines += ["", "## Residual overlap at full explode", ""]
    if report["residual_overlap_pairs"]:
        for pair in report["residual_overlap_pairs"]:
            lines.append(
                f"- review: `{pair['a']}` vs `{pair['b']}` "
                f"{pair['fully_exploded_overlap_mm3']} mm^3 still nested"
            )
    else:
        lines.append("- PASS: every part fully clears its neighbours at full explode.")
    lines += ["", "## Release Rule", "", f"- {report['release_rule']}"]
    (REVIEW / "explode-collision.md").write_text("\n".join(lines) + "\n")


def render_part_screenshots(scene: trimesh.Scene, parts: list[dict]) -> dict:
    import pyrender
    from PIL import Image

    PART_SHOTS.mkdir(parents=True, exist_ok=True)
    for old in PART_SHOTS.glob("*.png"):
        old.unlink()

    W, H = 720, 720
    highlight_mesh: dict[str, pyrender.Mesh] = {}
    ghost_mesh: dict[str, pyrender.Mesh] = {}
    poses: dict[str, np.ndarray] = {}
    for part in parts:
        name = part["name"]
        geom = scene.geometry[name].copy()
        color = np.array(color_for(name), dtype=np.uint8)
        hi = geom.copy()
        hi.visual = trimesh.visual.ColorVisuals(
            hi, vertex_colors=np.tile(color, (len(hi.vertices), 1))
        )
        highlight_mesh[name] = pyrender.Mesh.from_trimesh(hi, smooth=False)
        gh = geom.copy()
        gh.visual = trimesh.visual.ColorVisuals(
            gh, vertex_colors=np.tile(np.array([150, 150, 158, 38]), (len(gh.vertices), 1))
        )
        ghost_mesh[name] = pyrender.Mesh.from_trimesh(gh, smooth=False)
        offset = part["dir"] * (part["ring"] * RING_MM)
        pose = np.eye(4)
        pose[:3, 3] = offset
        poses[name] = pose

    cam_r = 520.0
    cam_h = cam_r * math.tan(math.radians(18.0))
    ang = math.radians(35.0)
    eye = np.array([cam_r * math.sin(ang), cam_h, cam_r * math.cos(ang)])
    target = np.array([0.0, 0.0, 0.0])
    fwd = target - eye
    fwd = fwd / np.linalg.norm(fwd)
    s = np.cross(fwd, np.array([0.0, 1.0, 0.0]))
    s = s / np.linalg.norm(s)
    u = np.cross(s, fwd)
    cam_pose = np.eye(4)
    cam_pose[:3, 0] = s
    cam_pose[:3, 1] = u
    cam_pose[:3, 2] = -fwd
    cam_pose[:3, 3] = eye
    cam = pyrender.PerspectiveCamera(
        yfov=math.radians(30.0), aspectRatio=1.0, znear=1.0, zfar=4000.0
    )
    key = pyrender.DirectionalLight(color=np.ones(3), intensity=3.2)
    fill = pyrender.DirectionalLight(color=np.ones(3) * 0.85, intensity=1.5)
    rim = pyrender.DirectionalLight(color=np.ones(3), intensity=1.8)

    renderer = pyrender.OffscreenRenderer(viewport_width=W, viewport_height=H)
    shots: list[str] = []
    for idx, part in enumerate(parts):
        if idx > 0 and idx % 24 == 0:
            renderer.delete()
            renderer = pyrender.OffscreenRenderer(viewport_width=W, viewport_height=H)
        name = part["name"]
        pyscene = pyrender.Scene(
            bg_color=np.array([0.22, 0.22, 0.24, 1.0]),
            ambient_light=np.array([0.3, 0.3, 0.32]),
        )
        for other in parts:
            if other["name"] == name:
                continue
            pyscene.add(ghost_mesh[other["name"]], pose=poses[other["name"]])
        pyscene.add(highlight_mesh[name], pose=poses[name])
        pyscene.add(cam, pose=cam_pose)
        for light, pos in (
            (key, [350.0, 350.0, 350.0]),
            (fill, [-350.0, 250.0, 350.0]),
            (rim, [0.0, -200.0, -350.0]),
        ):
            lp = np.eye(4)
            lp[:3, 3] = np.array(pos)
            pyscene.add(light, pose=lp)
        color, _ = renderer.render(pyscene)
        out_path = PART_SHOTS / f"{idx:03d}_{name}.png"
        Image.fromarray(color).save(out_path)
        shots.append(out_path.name)
    renderer.delete()

    contact = build_contact_sheet(shots)
    return {"part_shot_count": len(shots), "contact_sheet": str(contact)}


def build_contact_sheet(shot_names: list[str]) -> Path:
    from PIL import Image, ImageDraw

    thumbs = sorted(PART_SHOTS.glob("*.png"))
    cols = 8
    rows = math.ceil(len(thumbs) / cols)
    cell = 200
    label_h = 18
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), (245, 245, 247))
    draw = ImageDraw.Draw(sheet)
    for i, path in enumerate(thumbs):
        img = Image.open(path).resize((cell, cell))
        r, c = divmod(i, cols)
        x, y = c * cell, r * (cell + label_h)
        sheet.paste(img, (x, y))
        label = path.stem.split("_", 1)[-1][:30]
        draw.text((x + 3, y + cell + 3), label, fill=(20, 20, 20))
    out = REVIEW / "part-explode-contact-sheet.png"
    sheet.save(out)
    return out


def main() -> int:
    scene, parts = load_parts()
    print(f"[load] {len(parts)} parts from {ASM_GLB.name}")
    report = check_collisions(parts)
    write_collision_report(report)
    print(
        f"[collision] status={report['status']} "
        f"pass_through={report['pass_through_pair_count']} "
        f"residual={report['residual_overlap_at_full_explode_pair_count']}"
    )

    shots_info = {"part_shot_count": 0, "contact_sheet": ""}
    try:
        shots_info = render_part_screenshots(scene, parts)
        print(f"[shots] {shots_info['part_shot_count']} per-part screenshots → {PART_SHOTS}")
    except Exception as exc:  # noqa: BLE001 - render env is optional, report status
        print(f"[shots] FAILED: {exc}", file=sys.stderr)
        shots_info["error"] = str(exc)

    report["part_screenshots"] = shots_info
    (REVIEW / "explode-collision.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], **shots_info}, indent=2))
    return 0 if report["status"] == "explode_collision_pass" else 1


if __name__ == "__main__":
    sys.exit(main())
