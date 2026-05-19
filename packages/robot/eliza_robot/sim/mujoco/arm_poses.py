"""Named arm poses for the AiNex robot.

Each pose is a dict mapping joint names to target angles in radians.
Only arm joints are specified; leg/head joints use the stand keyframe.

Joint axes (empirically verified with MuJoCo sweeps):
  sho_roll:   axis [1, 0, 0]  — PRIMARY raise/lower. Negative=UP, Positive=DOWN.
              At 0: arm extends laterally (T-pose). At ±1.403: arm tucked at side.
  sho_pitch:  axis [0, -1, 0] — When arm is DOWN (roll=±1.4): positive=FORWARD, neg=BACK.
              When arm is LATERAL (roll=0): mostly twist, minimal movement.
  el_pitch:   axis [0, -1, 0] — Similar to sho_pitch for the forearm.
  el_yaw:     axis [0, 0, 1]  — Bends forearm in/out of the arm plane.
  gripper:    axis [1, 0, 0]  — Open/close.

Default stand: sho_roll=±1.403 (tucked), el_yaw=±1.226 (forearm bent inward).
Zero position: arms straight out to sides (T-pose).
"""

from __future__ import annotations

from dataclasses import dataclass

from bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS


@dataclass(frozen=True)
class ArmPose:
    """Named arm pose with expected visual description."""

    name: str
    joints: dict[str, float]
    description: str


# Arm joint names for quick reference
RIGHT_ARM = ("r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper")
LEFT_ARM = ("l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper")
ALL_ARM_JOINTS = RIGHT_ARM + LEFT_ARM


def _full_pose(**arm_overrides: float) -> dict[str, float]:
    """Start from stand pose, override specified arm joints."""
    pose = dict(STAND_JOINT_POSITIONS)
    pose.update(arm_overrides)
    return pose


# --------------------------------------------------------------------------- #
#  Named arm poses                                                             #
# --------------------------------------------------------------------------- #

ARM_POSES: dict[str, ArmPose] = {
    "default_stand": ArmPose(
        name="default_stand",
        joints=_full_pose(),
        description="Arms tucked at sides with elbows bent inward (default standing position)",
    ),
    "t_pose": ArmPose(
        name="t_pose",
        joints=_full_pose(
            r_sho_pitch=0.0, r_sho_roll=0.0, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
            l_sho_pitch=0.0, l_sho_roll=0.0, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Arms straight out to sides forming a T (all arm joints at zero)",
    ),
    "arms_forward": ArmPose(
        name="arms_forward",
        joints=_full_pose(
            r_sho_pitch=1.5, r_sho_roll=1.403, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
            l_sho_pitch=1.5, l_sho_roll=-1.403, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Both arms pointing forward (pitch +1.5 swings from tucked-down to forward)",
    ),
    "arms_up": ArmPose(
        name="arms_up",
        joints=_full_pose(
            r_sho_pitch=0.0, r_sho_roll=-1.57, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
            l_sho_pitch=0.0, l_sho_roll=1.57, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Both arms raised straight overhead (roll from lateral to up)",
    ),
    "arms_down": ArmPose(
        name="arms_down",
        joints=_full_pose(
            r_sho_pitch=0.0, r_sho_roll=1.57, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
            l_sho_pitch=0.0, l_sho_roll=-1.57, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Arms hanging straight down at sides (roll positive=down, elbows straight)",
    ),
    "arms_back": ArmPose(
        name="arms_back",
        joints=_full_pose(
            r_sho_pitch=-1.5, r_sho_roll=1.403, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
            l_sho_pitch=-1.5, l_sho_roll=-1.403, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Arms swung backward from tucked position (pitch -1.5)",
    ),
    "wave_left": ArmPose(
        name="wave_left",
        joints=_full_pose(
            l_sho_pitch=0.0, l_sho_roll=0.0, l_el_pitch=0.0, l_el_yaw=0.8, l_gripper=0.0,
        ),
        description="Left arm out to side with forearm bent forward (waving). Right stays tucked.",
    ),
    "wave_right": ArmPose(
        name="wave_right",
        joints=_full_pose(
            r_sho_pitch=0.0, r_sho_roll=0.0, r_el_pitch=0.0, r_el_yaw=-0.8, r_gripper=0.0,
        ),
        description="Right arm out to side with forearm bent forward (waving). Left stays tucked.",
    ),
    "wave_left_high": ArmPose(
        name="wave_left_high",
        joints=_full_pose(
            l_sho_pitch=0.0, l_sho_roll=0.8, l_el_pitch=0.0, l_el_yaw=0.8, l_gripper=0.0,
        ),
        description="Left arm raised above head with forearm bent (high wave). Right stays tucked.",
    ),
    "right_point": ArmPose(
        name="right_point",
        joints=_full_pose(
            r_sho_pitch=1.5, r_sho_roll=1.403, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=0.0,
        ),
        description="Right arm pointing forward. Left arm stays in default.",
    ),
    "left_point": ArmPose(
        name="left_point",
        joints=_full_pose(
            l_sho_pitch=1.5, l_sho_roll=-1.403, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=0.0,
        ),
        description="Left arm pointing forward. Right arm stays in default.",
    ),
    "elbows_bent": ArmPose(
        name="elbows_bent",
        joints=_full_pose(
            r_sho_pitch=0.0, r_sho_roll=0.0, r_el_pitch=0.0, r_el_yaw=-1.2, r_gripper=0.0,
            l_sho_pitch=0.0, l_sho_roll=0.0, l_el_pitch=0.0, l_el_yaw=1.2, l_gripper=0.0,
        ),
        description="Arms out to sides (T-pose) with elbows bent, forearms pointing forward",
    ),
    "grippers_open": ArmPose(
        name="grippers_open",
        joints=_full_pose(
            r_sho_pitch=1.5, r_sho_roll=1.403, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=1.5,
            l_sho_pitch=1.5, l_sho_roll=-1.403, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=-1.5,
        ),
        description="Arms forward with grippers wide open",
    ),
    "grippers_closed": ArmPose(
        name="grippers_closed",
        joints=_full_pose(
            r_sho_pitch=1.5, r_sho_roll=1.403, r_el_pitch=0.0, r_el_yaw=0.0, r_gripper=-1.5,
            l_sho_pitch=1.5, l_sho_roll=-1.403, l_el_pitch=0.0, l_el_yaw=0.0, l_gripper=1.5,
        ),
        description="Arms forward with grippers closed tight",
    ),
}


def get_arm_only(pose: ArmPose) -> dict[str, float]:
    """Extract only arm joint values from a full pose."""
    return {k: v for k, v in pose.joints.items() if k in ALL_ARM_JOINTS}


def list_poses() -> list[str]:
    """Return all available pose names."""
    return sorted(ARM_POSES.keys())
