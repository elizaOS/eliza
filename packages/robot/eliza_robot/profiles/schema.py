"""Pydantic v2 schema for robot profiles.

A `RobotProfile` is the single source of truth for everything that depends on
the specific robot we are driving: kinematics (joint inventory, limits, home
pose), gait parameters, sensor configuration, control rates, paths to
simulation assets (MJCF/MJX/URDF), the action library (predefined gesture
keyframes), safety envelope, and the set of bridge commands the robot
supports.

Every code path in `packages/robot/` that touches a real or simulated robot
MUST resolve its configuration via `load_profile(profile_id)` and read from
the returned `RobotProfile` — no hardcoded `if robot == "ainex"` branches.

Keep in sync with `plugins/plugin-ainex/src/types.ts` (TS mirror types).
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

# `JointSpec.group` enum. Mirrors the LEG/ARM/HEAD split in
# `ainex-robot-code/training/mujoco/ainex_constants.py`.
JointGroup = Literal["LEG", "ARM", "HEAD", "TORSO"]

# `GaitParams.controller` enum. `bezier` is the hand-tuned Hiwonder gait
# (`GAIT_SOURCE_CODE.py`), `rl` is a learned Brax-PPO policy, `openpi` is
# Physical Intelligence's VLA backend served over HTTP.
GaitController = Literal["bezier", "rl", "openpi"]


class JointSpec(BaseModel):
    """One actuated DoF on the robot."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(description="URDF joint name, e.g. 'r_hip_yaw'.")
    index: int = Field(ge=0, description="Index in the actuator vector.")
    lower_rad: float = Field(description="Position lower limit (rad).")
    upper_rad: float = Field(description="Position upper limit (rad).")
    home_rad: float = Field(description="Default stand pose position (rad).")
    group: JointGroup = Field(description="LEG | ARM | HEAD grouping.")
    actuator_torque_nm: float = Field(
        gt=0.0, description="Max actuator torque (N·m)."
    )
    velocity_max_rad_s: float = Field(
        gt=0.0, description="Max joint velocity (rad/s)."
    )

    @field_validator("upper_rad")
    @classmethod
    def _upper_above_lower(cls, v: float, info) -> float:
        lower = info.data.get("lower_rad")
        if lower is not None and v <= lower:
            raise ValueError(
                f"upper_rad ({v}) must be > lower_rad ({lower})"
            )
        return v

    @field_validator("home_rad")
    @classmethod
    def _home_within_limits(cls, v: float, info) -> float:
        lower = info.data.get("lower_rad")
        upper = info.data.get("upper_rad")
        if lower is not None and upper is not None and not (lower <= v <= upper):
            raise ValueError(
                f"home_rad ({v}) must lie within [{lower}, {upper}]"
            )
        return v


class Kinematics(BaseModel):
    """Joint inventory and total DoF count."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    dof: int = Field(gt=0, description="Total number of actuated joints.")
    joints: list[JointSpec]

    @field_validator("joints")
    @classmethod
    def _matches_dof(cls, v: list[JointSpec], info) -> list[JointSpec]:
        dof = info.data.get("dof")
        if dof is not None and len(v) != dof:
            raise ValueError(
                f"joints length ({len(v)}) does not match dof ({dof})"
            )
        names = [j.name for j in v]
        if len(set(names)) != len(names):
            raise ValueError("joint names must be unique")
        indices = [j.index for j in v]
        if sorted(indices) != list(range(len(v))):
            raise ValueError(
                "joint indices must be a contiguous 0..N-1 permutation"
            )
        return v


class GaitParams(BaseModel):
    """Locomotion gait baseline. The selected controller produces foot
    targets parameterised by these values.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    cycle_hz: float = Field(gt=0.0, description="Steps per second.")
    swing_height_m: float = Field(
        gt=0.0, description="Peak foot clearance during swing (m)."
    )
    stance_width_m: float = Field(
        gt=0.0, description="Lateral foot spacing during stance (m)."
    )
    step_length_max_m: float = Field(
        gt=0.0, description="Max forward stride per cycle (m)."
    )
    foot_offset_m: float = Field(
        description="Z offset from body link to foot sole at stance (m)."
    )
    default_height_m: float = Field(
        gt=0.0, description="Nominal standing torso height (m)."
    )
    controller: GaitController


class ContactGeoms(BaseModel):
    """Explicit MuJoCo contact geometry declarations for locomotion rewards."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    floor_geom_names: list[str] = Field(
        default_factory=list,
        description="MuJoCo geom names treated as the floor/ground contact surface.",
    )
    left_foot_geom_names: list[str] = Field(
        default_factory=list,
        description="MuJoCo geom names treated as left foot contact patches.",
    )
    right_foot_geom_names: list[str] = Field(
        default_factory=list,
        description="MuJoCo geom names treated as right foot contact patches.",
    )
    left_foot_body_names: list[str] = Field(
        default_factory=list,
        description=(
            "MuJoCo body names whose collision-enabled geoms are treated as "
            "left foot contact patches. Useful for unnamed vendor geoms."
        ),
    )
    right_foot_body_names: list[str] = Field(
        default_factory=list,
        description=(
            "MuJoCo body names whose collision-enabled geoms are treated as "
            "right foot contact patches. Useful for unnamed vendor geoms."
        ),
    )

    @field_validator("floor_geom_names")
    @classmethod
    def _floor_declared(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("contact.floor_geom_names must list at least one floor geom")
        return v

    @field_validator("right_foot_body_names")
    @classmethod
    def _some_foot_contact_declared(cls, v: list[str], info) -> list[str]:
        left_geoms = info.data.get("left_foot_geom_names") or []
        right_geoms = info.data.get("right_foot_geom_names") or []
        left_bodies = info.data.get("left_foot_body_names") or []
        if not (left_geoms or right_geoms or left_bodies or v):
            raise ValueError("contact must declare foot geoms or foot body names")
        return v


class CameraSpec(BaseModel):
    """One on-robot camera. Extrinsics expressed as roll/pitch/yaw (rad) plus
    x/y/z translation (m) in the mount link frame.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: int = Field(gt=0)
    fov_deg: float = Field(gt=0.0, lt=360.0)
    mount_link: str = Field(description="Parent URDF link name.")
    extrinsics_rpy_xyz: tuple[float, float, float, float, float, float] = Field(
        description="(roll, pitch, yaw, x, y, z) relative to mount_link."
    )


class SensorSpecs(BaseModel):
    """IMU + cameras + (future) other sensors."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    imu_noise_std: float = Field(
        ge=0.0,
        description="Gaussian noise std applied to simulated IMU (rad or m/s²).",
    )
    locomotion_tracking_body: str | None = Field(
        default=None,
        description=(
            "MuJoCo body name used for locomotion displacement and height "
            "success checks. Prefer a stable torso/pelvis body, not a camera "
            "or head link."
        ),
    )
    cameras: list[CameraSpec]


class ControlSpec(BaseModel):
    """Low-level control rates and per-step safety clips."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    rate_hz: float = Field(gt=0.0, description="Outer control loop frequency.")
    command_smoothing: float = Field(
        ge=0.0,
        le=1.0,
        description="EMA factor for command smoothing (0=no smoothing).",
    )
    max_joint_delta_rad_per_step: float = Field(
        gt=0.0,
        description="Max change in commanded joint position per control step.",
    )
    safe_torque_clip_nm: float = Field(
        gt=0.0, description="Hard torque clip applied at the bridge layer."
    )


class AssetPaths(BaseModel):
    """Paths to simulation/visualisation assets. Resolved by `load_profile` to
    absolute paths under `packages/robot/assets/profiles/<id>/`.

    All three of MJCF, MJX, and URDF are listed because they each serve a
    different consumer:

      - `mjcf_xml`  — MuJoCo CPU rollouts, rendering, manual inspection.
      - `mjx_xml`   — MuJoCo MJX (GPU/TPU) batched training.
      - `urdf`      — IsaacLab / IsaacSim, ROS, motion planners, RViz.

    `mesh_dir` is the directory that XMLs/URDFs reference for STL meshes.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    mjcf_xml: Path
    mjx_xml: Path
    urdf: Path
    mesh_dir: Path
    scene_xml: Path | None = Field(
        default=None,
        description=(
            "Optional MJCF that includes mjcf_xml plus a ground plane, "
            "lighting, and a free camera. Used by the interactive viewer "
            "and video recorder; falls back to mjcf_xml when not set."
        ),
    )


class Frame(BaseModel):
    """One keyframe in a scripted action."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    t: float = Field(
        ge=0.0, description="Time offset from action start (seconds)."
    )
    joints: dict[str, float] = Field(
        description="Map of joint name -> target position (rad). "
        "Joints not listed hold their previous commanded value.",
    )


class ActionGroup(BaseModel):
    """One scripted action — a sequence of timed keyframes."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    duration_s: float = Field(gt=0.0)
    frames: list[Frame]

    @field_validator("frames")
    @classmethod
    def _frames_in_order(cls, v: list[Frame], info) -> list[Frame]:
        if not v:
            raise ValueError("action group must have at least one frame")
        duration = info.data.get("duration_s")
        ts = [f.t for f in v]
        if ts != sorted(ts):
            raise ValueError("frames must be in non-decreasing time order")
        if duration is not None and ts[-1] > duration:
            raise ValueError(
                f"last frame t={ts[-1]} exceeds duration_s={duration}"
            )
        return v


class ActionLibrary(BaseModel):
    """Set of named scripted actions playable via `action.play`."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    groups: dict[str, ActionGroup]


class SafetyLimits(BaseModel):
    """Hard safety envelope. Violations trigger deadman / E-stop at the bridge."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    fall_pitch_rad: float = Field(gt=0.0)
    fall_roll_rad: float = Field(gt=0.0)
    battery_low_mv: int = Field(gt=0)
    deadman_timeout_s: float = Field(gt=0.0)


class RobotProfile(BaseModel):
    """Top-level robot profile. One of these per supported robot."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Stable profile id, e.g. 'hiwonder-ainex'.")
    name: str
    version: str
    description: str

    kinematics: Kinematics
    gait: GaitParams
    contact: ContactGeoms | None = None
    sensors: SensorSpecs
    control: ControlSpec
    assets: AssetPaths
    actions: ActionLibrary
    safety: SafetyLimits

    bridge_capabilities: list[str] = Field(
        description=(
            "Subset of bridge command names this profile supports. "
            "Plugins MUST refuse commands not listed here."
        )
    )

    @field_validator("kinematics")
    @classmethod
    def _joint_limits_within_two_pi(cls, v: Kinematics) -> Kinematics:
        # Real humanoid wrists / shoulder-yaws can rotate beyond ±π (Unitree
        # H1 shoulder_yaw range is ±4.45 rad). Anything beyond ±2π is almost
        # certainly a URDF unit bug (degrees rather than radians).
        for j in v.joints:
            if j.lower_rad < -2 * math.pi or j.upper_rad > 2 * math.pi:
                raise ValueError(
                    f"joint {j.name!r} limits [{j.lower_rad}, {j.upper_rad}] "
                    f"exceed ±2π — verify URDF units (degrees vs radians)"
                )
        return v


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

# Repo layout:
#   packages/robot/
#     eliza_robot/profiles/schema.py     ← this file
#     profiles/<id>/profile.yaml         ← profile manifests
#     assets/profiles/<id>/              ← binary assets (MJCF/URDF/STL)
PROFILES_ROOT = Path(__file__).resolve().parents[2] / "profiles"
ASSETS_ROOT = Path(__file__).resolve().parents[2] / "assets" / "profiles"


def profiles_root() -> Path:
    """Return the active profile-manifest root.

    Editable/source checkouts use ``packages/robot/profiles``. Installed
    deployments can set ``ELIZA_ROBOT_PROFILES_ROOT`` to a mounted profile tree
    without repackaging the Python wheel.
    """

    override = os.environ.get("ELIZA_ROBOT_PROFILES_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return PROFILES_ROOT


def assets_root() -> Path:
    """Return the active profile-asset root.

    This can be large because it contains MJCF/URDF/mesh assets. Wheel-style
    deployments should mount/copy it separately and set
    ``ELIZA_ROBOT_ASSETS_ROOT``.
    """

    override = os.environ.get("ELIZA_ROBOT_ASSETS_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return ASSETS_ROOT


def _resolve_assets(profile_id: str, raw: dict) -> dict:
    """Rewrite asset paths in a raw YAML dict to absolute paths."""
    assets = raw.get("assets") or {}
    base = assets_root() / profile_id
    resolved = {}
    for key in ("mjcf_xml", "mjx_xml", "urdf", "mesh_dir"):
        value = assets.get(key)
        if value is None:
            raise ValueError(
                f"profile {profile_id!r} is missing assets.{key}"
            )
        path = Path(value)
        if not path.is_absolute():
            path = (base / path).resolve()
        resolved[key] = path
    scene = assets.get("scene_xml")
    if scene is not None:
        scene_path = Path(scene)
        if not scene_path.is_absolute():
            scene_path = (base / scene_path).resolve()
        resolved["scene_xml"] = scene_path
    raw = dict(raw)
    raw["assets"] = resolved
    return raw


def load_profile(profile_id: str) -> RobotProfile:
    """Load and validate `profiles/<profile_id>/profile.yaml`."""
    manifest = profiles_root() / profile_id / "profile.yaml"
    if not manifest.is_file():
        raise FileNotFoundError(
            f"no profile manifest at {manifest} for id={profile_id!r}"
        )
    with manifest.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict):
        raise ValueError(
            f"profile {profile_id!r} did not parse to a mapping"
        )
    raw.setdefault("id", profile_id)
    if raw["id"] != profile_id:
        raise ValueError(
            f"profile manifest id ({raw['id']!r}) does not match "
            f"directory id ({profile_id!r})"
        )
    raw = _resolve_assets(profile_id, raw)
    return RobotProfile.model_validate(raw)


def list_profiles() -> list[str]:
    """Return sorted ids of all available profiles."""
    root = profiles_root()
    if not root.is_dir():
        return []
    return sorted(
        p.name
        for p in root.iterdir()
        if p.is_dir() and (p / "profile.yaml").is_file()
    )
