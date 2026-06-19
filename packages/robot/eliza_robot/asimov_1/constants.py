"""Constants for the ASIMOV-1 robot integration."""

from __future__ import annotations

from pathlib import Path

ROBOT_PACKAGE_ROOT = Path(__file__).resolve().parents[2]

ASIMOV1_PROFILE_ID = "asimov-1"
ASIMOV1_SUBMODULE_ROOT = ROBOT_PACKAGE_ROOT / "vendor" / "asimov-1"
ASIMOV1_SOURCE_XML = ASIMOV1_SUBMODULE_ROOT / "sim-model" / "xmls" / "asimov.xml"
ASIMOV1_SOURCE_MESH_DIR = ASIMOV1_SUBMODULE_ROOT / "sim-model" / "assets" / "meshes"
ASIMOV1_MECHANICAL_ROOT = ASIMOV1_SUBMODULE_ROOT / "mechanical" / "ASV1"
ASIMOV1_MAIN_STEP = ASIMOV1_MECHANICAL_ROOT / "ASIMOV_V1.STEP"
ASIMOV1_FABRICATION_MANIFEST = ASIMOV1_SUBMODULE_ROOT / "mechanical" / "FABRICATION_MANIFEST.json"

ASIMOV1_PROFILE_ASSET_ROOT = ROBOT_PACKAGE_ROOT / "assets" / "profiles" / ASIMOV1_PROFILE_ID
ASIMOV1_GENERATED_MJCF = ASIMOV1_PROFILE_ASSET_ROOT / "mjcf" / "asimov_eliza.xml"
ASIMOV1_GENERATED_URDF = ASIMOV1_PROFILE_ASSET_ROOT / "asimov.urdf"
ASIMOV1_GENERATED_MANIFEST = ASIMOV1_PROFILE_ASSET_ROOT / "asimov_asset_manifest.json"

ASIMOV1_CONTROL_HZ = 50.0
ASIMOV1_PHYSICS_HZ = 200.0
ASIMOV1_ACTOR_OBSERVATION_DIM = 45
ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM = 9
ASIMOV1_LEG_ACTION_DIM = 12
ASIMOV1_FULL_ACTION_DIM = 25
ASIMOV1_TRAJECTORY_WATCHDOG_S = 0.2
ASIMOV1_VELOCITY_LIMITS = {"vx_mps": 2.0, "vy_mps": 1.0, "yaw_rad_s": 2.0}

ASIMOV1_LEG_JOINT_ORDER = (
    "left_hip_pitch_joint",
    "left_hip_roll_joint",
    "left_hip_yaw_joint",
    "left_knee_joint",
    "left_ankle_pitch_joint",
    "left_ankle_roll_joint",
    "right_hip_pitch_joint",
    "right_hip_roll_joint",
    "right_hip_yaw_joint",
    "right_knee_joint",
    "right_ankle_pitch_joint",
    "right_ankle_roll_joint",
)

ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS = {
    "left_leg": tuple(range(0, 6)),
    "right_leg": tuple(range(6, 12)),
}

ASIMOV1_FIRMWARE_JOINT_ORDER = (
    *ASIMOV1_LEG_JOINT_ORDER,
    "left_shoulder_pitch_joint",
    "left_shoulder_roll_joint",
    "left_shoulder_yaw_joint",
    "left_elbow_joint",
    "left_wrist_yaw_joint",
    "right_shoulder_pitch_joint",
    "right_shoulder_roll_joint",
    "right_shoulder_yaw_joint",
    "right_elbow_joint",
    "right_wrist_yaw_joint",
    "waist_yaw_joint",
    "neck_pitch_joint",
    "neck_yaw_joint",
)
