#!/usr/bin/env python3
"""Analyze Unitree R1 OEM STL envelopes for bodykit shell derivation."""

from __future__ import annotations

import json
from pathlib import Path

import trimesh

PKG_ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = PKG_ROOT / "assets" / "profiles" / "unitree-r1" / "mjcf" / "assets"
OUT_PATH = PKG_ROOT / "mechanical" / "unitree-r1-bodykit" / "review" / "oem-envelope-audit.json"

SHELL_GROUPS = {
    "head_face": ["head_yaw_link.STL", "head_pitch_link.STL"],
    "torso_core": ["waist_yaw_link.STL", "waist_roll_link.STL", "torso_collision.stl"],
    "pelvis": ["pelvis_link.STL"],
    "left_shoulder": [
        "left_shoulder_pitch_link.STL",
        "left_shoulder_roll_link.STL",
        "left_shoulder_yaw_link.STL",
    ],
    "right_shoulder": [
        "right_shoulder_pitch_link.STL",
        "right_shoulder_roll_link.STL",
        "right_shoulder_yaw_link.STL",
    ],
    "left_arm": ["left_elbow_link.STL", "left_wrist_roll_link.STL"],
    "right_arm": ["right_elbow_link.STL", "right_wrist_roll_link.STL"],
    "left_hip_thigh": ["left_hip_pitch_link.STL", "left_hip_roll_link.STL", "left_hip_yaw_link.STL"],
    "right_hip_thigh": ["right_hip_pitch_link.STL", "right_hip_roll_link.STL", "right_hip_yaw_link.STL"],
    "left_knee_shin": ["left_knee_link.STL", "left_knee_collision.STL"],
    "right_knee_shin": ["right_knee_link.STL", "right_knee_collision.STL"],
    "left_ankle_keepout": [
        "left_ankle_pitch_link.STL",
        "left_ankle_roll_link.STL",
        "left_ankle_A_link.STL",
        "left_ankle_B_link.STL",
        "left_ankle_A_rod_link.STL",
        "left_ankle_B_rod_link.STL",
    ],
    "right_ankle_keepout": [
        "right_ankle_pitch_link.STL",
        "right_ankle_roll_link.STL",
        "right_ankle_A_link.STL",
        "right_ankle_B_link.STL",
        "right_ankle_A_rod_link.STL",
        "right_ankle_B_rod_link.STL",
    ],
}


def _mesh_stats(filename: str) -> dict[str, object]:
    path = ASSET_ROOT / filename
    mesh = trimesh.load_mesh(path, force="mesh")
    return {
        "file": filename,
        "path": str(path),
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "bounds_m": [[round(float(v), 6) for v in row] for row in mesh.bounds],
        "extents_mm": [round(float(v) * 1000, 2) for v in mesh.extents],
        "volume_cm3": round(float(abs(mesh.volume)) * 1_000_000, 3) if mesh.is_watertight else None,
        "repair_required_for_boolean_offset": not bool(mesh.is_watertight),
    }


def main() -> int:
    if not ASSET_ROOT.is_dir():
        raise FileNotFoundError(f"missing R1 assets: {ASSET_ROOT}")
    groups = {}
    for group, files in SHELL_GROUPS.items():
        stats = [_mesh_stats(name) for name in files]
        groups[group] = {
            "source_meshes": stats,
            "all_watertight": all(item["watertight"] for item in stats),
            "recommended_offset_method": "cad_boolean" if all(item["watertight"] for item in stats) else "voxel_or_sdf_offset",
        }
    report = {
        "asset_root": str(ASSET_ROOT),
        "groups": groups,
        "fit_clearance_targets_mm": {
            "inner_chassis_clearance": 8.0,
            "dynamic_joint_clearance": 18.0,
            "nominal_panel_gap": 2.5,
        },
        "next_step": (
            "Generate offset keepout meshes per group, subtract adjacent swept volumes, "
            "then use those envelopes as imported bodykit shell sources."
        ),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"wrote": str(OUT_PATH), "groups": len(groups)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
