"""AiNex joint mapping between URDF names, servo IDs, and IsaacLab indices.

Servo IDs are taken from ainex_controller.py `joint_id` dict — these are the
hardware bus servo addresses used by the real robot's motion_manager.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class JointSpec:
    """Single joint specification."""

    urdf_name: str
    servo_id: int
    group: str
    lower_rad: float
    upper_rad: float
    effort: float
    velocity: float


# Canonical joint table derived from ainex.urdf.xacro and ainex_controller.py.
# servo_id values match ainex_controller.py Controller.joint_id exactly.
JOINT_TABLE: tuple[JointSpec, ...] = (
    # Right leg
    JointSpec("r_hip_yaw", 12, "right_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_hip_roll", 10, "right_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_hip_pitch", 8, "right_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_knee", 6, "right_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_ank_pitch", 4, "right_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_ank_roll", 2, "right_leg", -2.09, 2.09, 6.0, 100.0),
    # Left leg
    JointSpec("l_hip_yaw", 11, "left_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_hip_roll", 9, "left_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_hip_pitch", 7, "left_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_knee", 5, "left_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_ank_pitch", 3, "left_leg", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_ank_roll", 1, "left_leg", -2.09, 2.09, 6.0, 100.0),
    # Right arm
    JointSpec("r_sho_pitch", 14, "right_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_sho_roll", 16, "right_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_el_pitch", 18, "right_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_el_yaw", 20, "right_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("r_gripper", 22, "right_arm", -2.09, 2.09, 6.0, 100.0),
    # Left arm
    JointSpec("l_sho_pitch", 13, "left_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_sho_roll", 15, "left_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_el_pitch", 17, "left_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_el_yaw", 19, "left_arm", -2.09, 2.09, 6.0, 100.0),
    JointSpec("l_gripper", 21, "left_arm", -2.09, 2.09, 6.0, 100.0),
    # Head
    JointSpec("head_pan", 23, "head", -2.09, 2.09, 6.0, 100.0),
    JointSpec("head_tilt", 24, "head", -2.09, 2.09, 6.0, 100.0),
)

# Quick lookups.
JOINT_BY_NAME: dict[str, JointSpec] = {j.urdf_name: j for j in JOINT_TABLE}
JOINT_BY_SERVO_ID: dict[int, JointSpec] = {j.servo_id: j for j in JOINT_TABLE}
JOINT_NAMES: tuple[str, ...] = tuple(j.urdf_name for j in JOINT_TABLE)
NUM_JOINTS: int = len(JOINT_TABLE)

# Group lookups.
LEG_JOINT_NAMES: tuple[str, ...] = tuple(j.urdf_name for j in JOINT_TABLE if "leg" in j.group)
ARM_JOINT_NAMES: tuple[str, ...] = tuple(j.urdf_name for j in JOINT_TABLE if "arm" in j.group)
HEAD_JOINT_NAMES: tuple[str, ...] = tuple(j.urdf_name for j in JOINT_TABLE if j.group == "head")


def servo_id_to_joint_name(servo_id: int) -> str:
    """Convert servo ID to URDF joint name."""
    spec = JOINT_BY_SERVO_ID.get(servo_id)
    if spec is None:
        raise ValueError(f"unknown servo ID: {servo_id}")
    return spec.urdf_name


def joint_name_to_servo_id(name: str) -> int:
    """Convert URDF joint name to servo ID."""
    spec = JOINT_BY_NAME.get(name)
    if spec is None:
        raise ValueError(f"unknown joint name: {name}")
    return spec.servo_id


def pulse_to_radians(pulse: int, servo_id: int) -> float:
    """Convert servo pulse width (0-1000) to radians.

    Uses the standard AiNex mapping: center at 500, ±2.09 rad at 0/1000.
    """
    center = 500
    scale = 2.09 / 500.0  # rad per pulse unit from center
    return (pulse - center) * scale


def radians_to_pulse(rad: float, servo_id: int) -> int:
    """Convert radians to servo pulse width (0-1000)."""
    center = 500
    scale = 500.0 / 2.09
    pulse = int(center + rad * scale)
    return max(0, min(1000, pulse))
