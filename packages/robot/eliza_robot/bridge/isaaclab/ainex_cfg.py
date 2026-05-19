"""IsaacLab ArticulationCfg and environment configuration for AiNex.

This module provides the robot configuration that IsaacLab uses to instantiate
the AiNex articulation in simulation. It can be imported by IsaacLab task configs
or used directly for standalone testing.

When Isaac Sim is not available, the configuration is defined as plain dataclasses
that mirror the IsaacLab API surface for validation and testing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

from eliza_robot.bridge.isaaclab.joint_map import (
    ARM_JOINT_NAMES,
    HEAD_JOINT_NAMES,
    JOINT_TABLE,
    LEG_JOINT_NAMES,
)

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_USD_PATH = ROOT_DIR / "bridge" / "generated" / "ainex.usd"

# Standing pose: joint positions in radians for a stable stand.
# Derived from ainex_controller.py default init and gazebo.launch spawn args.
STAND_JOINT_POSITIONS: dict[str, float] = {
    # Legs at zero (standing straight)
    "r_hip_yaw": 0.0,
    "r_hip_roll": 0.0,
    "r_hip_pitch": 0.0,
    "r_knee": 0.0,
    "r_ank_pitch": 0.0,
    "r_ank_roll": 0.0,
    "l_hip_yaw": 0.0,
    "l_hip_roll": 0.0,
    "l_hip_pitch": 0.0,
    "l_knee": 0.0,
    "l_ank_pitch": 0.0,
    "l_ank_roll": 0.0,
    # Arms tucked (from gazebo.launch initial positions)
    "r_sho_pitch": 0.0,
    "r_sho_roll": 1.403,
    "r_el_pitch": 0.0,
    "r_el_yaw": 1.226,
    "r_gripper": 0.0,
    "l_sho_pitch": 0.0,
    "l_sho_roll": -1.403,
    "l_el_pitch": 0.0,
    "l_el_yaw": -1.226,
    "l_gripper": 0.0,
    # Head centered
    "head_pan": 0.0,
    "head_tilt": 0.0,
}


@dataclass(frozen=True)
class JointLimits:
    """Joint position, effort, and velocity limits."""

    lower: float
    upper: float
    effort: float
    velocity: float


@dataclass(frozen=True)
class AiNexActuatorCfg:
    """Actuator configuration for a group of joints."""

    joint_names: tuple[str, ...]
    stiffness: float
    damping: float
    effort_limit: float


@dataclass(frozen=True)
class AiNexArticulationCfg:
    """Complete articulation configuration for AiNex in IsaacLab."""

    usd_path: str
    spawn_height: float
    enable_self_collision: bool
    leg_actuators: AiNexActuatorCfg
    arm_actuators: AiNexActuatorCfg
    head_actuators: AiNexActuatorCfg
    joint_limits: dict[str, JointLimits]
    default_positions: dict[str, float]


def build_joint_limits() -> dict[str, JointLimits]:
    """Build joint limits from the canonical joint table."""
    return {
        spec.urdf_name: JointLimits(
            lower=spec.lower_rad,
            upper=spec.upper_rad,
            effort=spec.effort,
            velocity=spec.velocity,
        )
        for spec in JOINT_TABLE
    }


def build_ainex_cfg(usd_path: str | None = None) -> AiNexArticulationCfg:
    """Build the default AiNex articulation configuration.

    Args:
        usd_path: Path to the USD asset. Defaults to bridge/generated/ainex.usd.

    Returns:
        AiNexArticulationCfg ready for IsaacLab environment registration.
    """
    if usd_path is None:
        usd_path = str(DEFAULT_USD_PATH)

    return AiNexArticulationCfg(
        usd_path=usd_path,
        spawn_height=0.25,
        enable_self_collision=False,
        leg_actuators=AiNexActuatorCfg(
            joint_names=LEG_JOINT_NAMES,
            stiffness=50.0,
            damping=5.0,
            effort_limit=6.0,
        ),
        arm_actuators=AiNexActuatorCfg(
            joint_names=ARM_JOINT_NAMES,
            stiffness=10.0,
            damping=1.0,
            effort_limit=6.0,
        ),
        head_actuators=AiNexActuatorCfg(
            joint_names=HEAD_JOINT_NAMES,
            stiffness=10.0,
            damping=1.0,
            effort_limit=6.0,
        ),
        joint_limits=build_joint_limits(),
        default_positions=dict(STAND_JOINT_POSITIONS),
    )


def try_build_isaaclab_articulation_cfg() -> object | None:
    """Attempt to build a native IsaacLab ArticulationCfg.

    Returns None if IsaacLab is not importable (non-Isaac environment).
    """
    try:
        from omni.isaac.lab.assets import ArticulationCfg
        from omni.isaac.lab.actuators import ImplicitActuatorCfg
        from omni.isaac.lab.sim import UsdFileCfg
    except ImportError:
        return None

    cfg = build_ainex_cfg()

    return ArticulationCfg(
        prim_path="/World/AiNex",
        spawn=UsdFileCfg(
            usd_path=cfg.usd_path,
            activate_contact_sensors=True,
        ),
        init_state=ArticulationCfg.InitialStateCfg(
            pos=(0.0, 0.0, cfg.spawn_height),
            joint_pos=cfg.default_positions,
        ),
        actuators={
            "legs": ImplicitActuatorCfg(
                joint_names_expr=list(cfg.leg_actuators.joint_names),
                stiffness=cfg.leg_actuators.stiffness,
                damping=cfg.leg_actuators.damping,
                effort_limit=cfg.leg_actuators.effort_limit,
            ),
            "arms": ImplicitActuatorCfg(
                joint_names_expr=list(cfg.arm_actuators.joint_names),
                stiffness=cfg.arm_actuators.stiffness,
                damping=cfg.arm_actuators.damping,
                effort_limit=cfg.arm_actuators.effort_limit,
            ),
            "head": ImplicitActuatorCfg(
                joint_names_expr=list(cfg.head_actuators.joint_names),
                stiffness=cfg.head_actuators.stiffness,
                damping=cfg.head_actuators.damping,
                effort_limit=cfg.head_actuators.effort_limit,
            ),
        },
    )
