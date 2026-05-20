"""Robot profile registry.

Profiles are how multi-robot support is plumbed through `eliza_robot`. The
first shipping profile is `hiwonder-ainex`; add a new robot by dropping a
`profile.yaml` into `packages/robot/profiles/<id>/` and the matching assets
into `packages/robot/assets/profiles/<id>/`.
"""

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
    list_profiles,
    load_profile,
)

DEFAULT_PROFILE_ID: str = "hiwonder-ainex"

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
