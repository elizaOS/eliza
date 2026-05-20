"""eliza_robot — Python robotics stack for elizaOS.

Profile-driven multi-robot support. See `eliza_robot.profiles` for the
canonical `RobotProfile` schema and bundled profile loader.
"""

from eliza_robot.profiles import DEFAULT_PROFILE_ID, list_profiles, load_profile
from eliza_robot.profiles.schema import (
    ActionGroup,
    ActionLibrary,
    AssetPaths,
    CameraSpec,
    ControlSpec,
    Frame,
    GaitParams,
    JointSpec,
    Kinematics,
    RobotProfile,
    SafetyLimits,
    SensorSpecs,
)

__all__ = [
    "ActionGroup",
    "ActionLibrary",
    "AssetPaths",
    "CameraSpec",
    "ControlSpec",
    "DEFAULT_PROFILE_ID",
    "Frame",
    "GaitParams",
    "JointSpec",
    "Kinematics",
    "RobotProfile",
    "SafetyLimits",
    "SensorSpecs",
    "list_profiles",
    "load_profile",
]
