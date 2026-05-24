"""Generate `profiles/<unitree-*>/profile.yaml` + copy MJCF assets from
mujoco_menagerie or Unitree's MuJoCo robot bundle. Parses the MJCF for joint names, ranges, and torque
limits, infers a group split from joint name patterns, and writes a
Pydantic-validated YAML to disk that matches the canonical
`RobotProfile` schema in `eliza_robot/profiles/schema.py`.

Run:
    uv run python scripts/generate_unitree_profile.py --robot g1
    uv run python scripts/generate_unitree_profile.py --robot h1
    uv run python scripts/generate_unitree_profile.py --robot r1
"""

from __future__ import annotations

import argparse
import shutil
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

import yaml

PKG_ROOT = Path(__file__).resolve().parents[1]
MENAGERIE_ROOT = PKG_ROOT / "vendor" / "mujoco_menagerie"
UNITREE_MUJOCO_ROOT = PKG_ROOT / "vendor" / "unitree_mujoco"
PROFILES_ROOT = PKG_ROOT / "profiles"
ASSETS_ROOT = PKG_ROOT / "assets" / "profiles"

ROBOTS: dict[str, dict] = {
    "g1": {
        "source_root": MENAGERIE_ROOT,
        "menagerie_dir": "unitree_g1",
        "mjcf": "g1.xml",
        "scene": "scene.xml",
        "profile_id": "unitree-g1",
        "name": "Unitree G1",
        "description": (
            "29-DoF Unitree G1 humanoid (12 legs + 3 waist + 14 arms). "
            "MJCF sourced verbatim from google-deepmind/mujoco_menagerie/unitree_g1. "
            "Sim2real recipe follows google/mujoco_playground locomotion env."
        ),
        "default_height_m": 0.79,
        "stand_qpos_key": "stand",
        "head_link": "torso_link",  # G1 MJCF has no head body; mesh attaches to torso
        "imu_site": "imu_in_torso",
    },
    "h1": {
        "source_root": MENAGERIE_ROOT,
        "menagerie_dir": "unitree_h1",
        "mjcf": "h1.xml",
        "scene": "scene.xml",
        "profile_id": "unitree-h1",
        "name": "Unitree H1",
        "description": (
            "19-DoF Unitree H1 humanoid (10 legs + 1 torso + 8 arms; no hand fingers). "
            "MJCF sourced verbatim from google-deepmind/mujoco_menagerie/unitree_h1."
        ),
        "default_height_m": 1.02,
        "stand_qpos_key": "home",
        "head_link": "torso_link",
        "imu_site": "imu_in_torso",
    },
    "r1": {
        "source_root": UNITREE_MUJOCO_ROOT,
        "menagerie_dir": "unitree_robots/r1",
        "mjcf": "R1_C++.xml",
        "scene": "scene.xml",
        "profile_id": "unitree-r1",
        "name": "Unitree R1",
        "description": (
            "29-actuator Unitree R1 humanoid. MJCF and STL assets sourced from "
            "unitreerobotics/unitree_mujoco/unitree_robots/r1 at the vendored commit."
        ),
        "default_height_m": 0.74,
        "stand_qpos_key": "home",
        "head_link": "torso_link",
        "imu_site": "imu",
    },
}


def _group_for(joint_name: str) -> str:
    n = joint_name.lower()
    if any(k in n for k in ("hip", "knee", "ankle")):
        return "LEG"
    if any(k in n for k in ("shoulder", "elbow", "wrist", "arm")):
        return "ARM"
    if any(k in n for k in ("head", "neck")):
        return "HEAD"
    if any(k in n for k in ("waist", "torso", "spine")):
        return "TORSO"
    return "ARM"


def _parse_actuated_joints(mjcf_path: Path) -> list[dict]:
    tree = ET.parse(mjcf_path)
    root = tree.getroot()
    actuated: list[str] = []
    for parent in root.iter("actuator"):
        for act in parent:
            if act.tag in ("position", "motor", "general"):
                jname = act.attrib.get("joint")
                if jname:
                    actuated.append(jname)
    joints: dict[str, dict] = {}
    for j in root.iter("joint"):
        name = j.attrib.get("name")
        if not name or name not in set(actuated):
            continue
        rng = j.attrib.get("range", "0 0").split()
        lower = float(rng[0]) if len(rng) == 2 else -3.14
        upper = float(rng[1]) if len(rng) == 2 else 3.14
        if upper <= lower:
            # Unitree R1's public MuJoCo bundle includes placeholder motors
            # for unmodeled waist/wrist axes on inertial-only bodies parked
            # away from the robot. Keep the actuator inventory intact while
            # giving the profile schema a narrow valid range.
            lower, upper = -0.01, 0.01
        afrng = j.attrib.get("actuatorfrcrange", "")
        torque = 50.0
        if afrng:
            try:
                a, b = afrng.split()
                torque = max(abs(float(a)), abs(float(b)))
            except ValueError:
                pass
        joints[name] = {
            "name": name,
            "lower_rad": round(lower, 4),
            "upper_rad": round(upper, 4),
            "torque_nm": torque,
        }
    for parent in root.iter("actuator"):
        for act in parent:
            jname = act.attrib.get("joint")
            if not jname or jname not in joints:
                continue
            ctrl = act.attrib.get("ctrlrange", "").split()
            if len(ctrl) == 2:
                try:
                    joints[jname]["torque_nm"] = max(abs(float(ctrl[0])), abs(float(ctrl[1])))
                except ValueError:
                    pass
    ordered: list[dict] = []
    seen: set[str] = set()
    for jname in actuated:
        if jname in joints and jname not in seen:
            ordered.append(joints[jname])
            seen.add(jname)
    return ordered


def _stand_qpos_keyframe(
    mjcf_path: Path, actuated: list[str], key_name: str, *, scene_path: Path | None = None
) -> dict[str, float]:
    """Read the named `<key qpos=...>` keyframe from the bare MJCF, falling
    back to `scene_path` (which typically `<include>s` the bare MJCF and adds
    the keyframe). mujoco_menagerie usually puts keyframes in scene.xml
    rather than the robot MJCF itself.
    """

    def _search(path: Path) -> dict[str, float] | None:
        tree = ET.parse(path)
        root = tree.getroot()
        for k in root.iter("key"):
            if k.attrib.get("name") == key_name:
                qpos = k.attrib.get("qpos", "").split()
                if len(qpos) >= 7 + len(actuated):
                    return {
                        actuated[i]: float(qpos[7 + i])
                        for i in range(len(actuated))
                    }
        return None

    home = _search(mjcf_path)
    if home is None and scene_path is not None and scene_path.is_file():
        home = _search(scene_path)
    return home or {j: 0.0 for j in actuated}


def _stand_action_group(home: dict[str, float]) -> dict:
    knee = next((v for k, v in home.items() if "knee" in k.lower()), 0.0)
    return {
        "name": "stand",
        "duration_s": 1.0,
        "frames": [
            {
                "t": 0.0,
                "joints": {k: round(v, 4) for k, v in home.items() if abs(v) > 1e-3}
                or {"left_knee_joint": round(knee, 4)},
            }
        ],
    }


def _build_profile_yaml(spec: dict, joints: list[dict], home: dict[str, float]) -> dict:
    joint_entries = []
    for i, j in enumerate(joints):
        joint_entries.append({
            "name": j["name"],
            "index": i,
            "lower_rad": j["lower_rad"],
            "upper_rad": j["upper_rad"],
            "home_rad": round(
                max(j["lower_rad"], min(j["upper_rad"], home.get(j["name"], 0.0))), 4
            ),
            "group": _group_for(j["name"]),
            "actuator_torque_nm": j["torque_nm"],
            "velocity_max_rad_s": 30.0,
        })

    profile: dict = {
        "id": spec["profile_id"],
        "name": spec["name"],
        "version": "1.0.0",
        "description": spec["description"],
        "kinematics": {"dof": len(joint_entries), "joints": joint_entries},
        "gait": {
            "cycle_hz": 1.25,
            "swing_height_m": 0.08,
            "stance_width_m": 0.22,
            "step_length_max_m": 0.25,
            "foot_offset_m": -spec["default_height_m"],
            "default_height_m": spec["default_height_m"],
            "controller": "rl",
        },
        "sensors": {
            "imu_noise_std": 0.005,
            "cameras": [
                {
                    "name": "head_cam",
                    "width": 320,
                    "height": 240,
                    "fps": 30,
                    "fov_deg": 60.0,
                    "mount_link": spec["head_link"],
                    "extrinsics_rpy_xyz": [0.0, 0.0, 0.0, 0.08, 0.0, 0.0],
                }
            ],
        },
        "control": {
            "rate_hz": 50.0,
            "command_smoothing": 0.3,
            "max_joint_delta_rad_per_step": 0.15,
            "safe_torque_clip_nm": max(j["torque_nm"] for j in joints) + 1.0,
        },
        "assets": {
            "mjcf_xml": f"mjcf/{spec['mjcf']}",
            "mjx_xml": f"mjcf/{spec['mjcf']}",
            "urdf": f"mjcf/{spec['mjcf']}",  # menagerie ships MJCF only; URDF == MJCF placeholder
            "mesh_dir": "mjcf/assets",
            "scene_xml": f"mjcf/{spec['scene']}",
        },
        "actions": {"groups": {"stand": _stand_action_group(home)}},
        "safety": {
            "fall_pitch_rad": 0.8,
            "fall_roll_rad": 0.8,
            "battery_low_mv": 36000,
            "deadman_timeout_s": 1.0,
        },
        "bridge_capabilities": [
            "policy.start",
            "policy.stop",
            "policy.tick",
            "policy.status",
            "action.play",
            "walk.command",
            "stop",
            "stand",
        ],
    }
    return profile


def _inject_head_camera(mjcf_path: Path, parent_body: str) -> None:
    """Add a forward-facing `<camera name="head_cam">` to ``parent_body``
    so the offscreen renderer + perception modules have an ego-pose view.

    Idempotent — re-running the generator does not duplicate the camera.
    """
    text = mjcf_path.read_text()
    if 'name="head_cam"' in text:
        return
    target = f'<body name="{parent_body}"'
    idx = text.find(target)
    if idx < 0:
        return
    body_open_end = text.find(">", idx)
    if body_open_end < 0:
        return
    inject = (
        '\n      <camera name="head_cam" mode="fixed" pos="0.15 0 0.35" '
        'xyaxes="0 -1 0 0 0 1" fovy="60"/>'
    )
    mjcf_path.write_text(text[: body_open_end + 1] + inject + text[body_open_end + 1 :])


def generate(robot_key: str, *, dry_run: bool = False) -> Path:
    if robot_key not in ROBOTS:
        raise SystemExit(f"unknown robot {robot_key}; choose from {list(ROBOTS)}")
    spec = ROBOTS[robot_key]
    source_root = Path(spec.get("source_root", MENAGERIE_ROOT))
    src_dir = source_root / spec["menagerie_dir"]
    mjcf_src = src_dir / spec["mjcf"]
    if not mjcf_src.is_file():
        raise SystemExit(
            f"Unitree MJCF missing at {mjcf_src}; "
            f"run sparse-clone first: see scripts/generate_unitree_profile.py docstring"
        )

    joints = _parse_actuated_joints(mjcf_src)
    scene_src = src_dir / spec["scene"]
    home = _stand_qpos_keyframe(
        mjcf_src,
        [j["name"] for j in joints],
        spec["stand_qpos_key"],
        scene_path=scene_src if scene_src.is_file() else None,
    )
    profile = _build_profile_yaml(spec, joints, home)

    profile_dir = PROFILES_ROOT / spec["profile_id"]
    asset_dir = ASSETS_ROOT / spec["profile_id"]
    mjcf_dst_dir = asset_dir / "mjcf"
    meshes_dst_dir = asset_dir / "mjcf" / "assets"

    if dry_run:
        print(f"[dry-run] would write profile to {profile_dir / 'profile.yaml'}")
        print(f"[dry-run] dof={len(joints)} home_set={bool(home)}")
        return profile_dir / "profile.yaml"

    profile_dir.mkdir(parents=True, exist_ok=True)
    mjcf_dst_dir.mkdir(parents=True, exist_ok=True)
    meshes_dst_dir.mkdir(parents=True, exist_ok=True)

    for fname in (spec["mjcf"], spec["scene"]):
        src = src_dir / fname
        if src.is_file():
            shutil.copy2(src, mjcf_dst_dir / fname)
    src_assets = src_dir / "assets"
    if not src_assets.is_dir():
        src_assets = src_dir / "meshes"
    if src_assets.is_dir():
        for child in src_assets.iterdir():
            if child.is_file():
                shutil.copy2(child, meshes_dst_dir / child.name)
    license_file = src_dir / "LICENSE"
    if license_file.is_file():
        shutil.copy2(license_file, asset_dir / "LICENSE")

    # Inject the head_cam declared in profile.sensors.cameras so the
    # offscreen renderer + perception module can pull ego-pose frames.
    for xml_path in (mjcf_dst_dir / spec["mjcf"], mjcf_dst_dir / spec["scene"]):
        if xml_path.is_file():
            text = xml_path.read_text()
            text = text.replace('meshdir="meshes/"', 'meshdir="assets"')
            text = text.replace('meshdir="meshes"', 'meshdir="assets"')
            xml_path.write_text(text)
    _inject_head_camera(
        mjcf_dst_dir / spec["mjcf"], parent_body=spec["head_link"]
    )
    _inject_head_camera(
        mjcf_dst_dir / spec["scene"], parent_body=spec["head_link"]
    )

    profile_path = profile_dir / "profile.yaml"
    profile_path.write_text(
        "# Auto-generated by scripts/generate_unitree_profile.py from\n"
        f"# {source_root.relative_to(PKG_ROOT)}/{spec['menagerie_dir']}/.\n"
        "# Do not hand-edit; re-run the generator.\n"
        + yaml.safe_dump(profile, sort_keys=False, width=120)
    )
    readme = profile_dir / "README.md"
    if not readme.is_file():
        readme.write_text(
            f"# {spec['name']} profile\n\n"
            f"{spec['description']}\n\n"
            f"DoF: {len(joints)}. Regenerate with:\n\n"
            f"    uv run python scripts/generate_unitree_profile.py --robot {robot_key}\n"
        )
    print(
        f"wrote {profile_path} (dof={len(joints)}) + assets at {asset_dir}",
        file=sys.stderr,
    )
    return profile_path


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--robot", choices=list(ROBOTS), required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)
    generate(args.robot, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
