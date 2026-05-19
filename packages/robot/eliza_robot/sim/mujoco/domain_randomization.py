"""Domain randomization for MuJoCo environments.

Applies physics parameter randomization (friction, mass, stiffness, damping)
to MjModel before stepping, improving sim-to-real transfer.

Usage:
    from eliza_robot.sim.mujoco.domain_randomization import DomainRandomization, PRESETS
    dr = DomainRandomization.from_preset("moderate")
    dr.randomize_model(mj_model, rng)
"""

from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np


@dataclass
class DomainRandomization:
    """Domain randomization config for MuJoCo models."""

    name: str = "none"

    # Ground friction
    friction_range: tuple[float, float] = (1.0, 1.0)

    # Robot mass scaling
    mass_scale_range: tuple[float, float] = (1.0, 1.0)

    # Joint stiffness/damping scaling
    joint_stiffness_scale: tuple[float, float] = (1.0, 1.0)
    joint_damping_scale: tuple[float, float] = (1.0, 1.0)

    # Observation noise (applied in env, not here)
    obs_noise_scale: float = 0.05

    # Action noise
    action_noise_std: float = 0.0

    # Action delay (number of control steps)
    action_delay_steps: int = 0

    def randomize_model(self, model: mujoco.MjModel, rng: np.random.Generator) -> None:
        """Apply randomization in-place to a MuJoCo model.

        Call this at the start of each episode (before mjx.put_model).

        Args:
            model: MuJoCo MjModel to randomize in-place.
            rng: numpy random generator.
        """
        # Friction randomization (all geom pairs)
        if self.friction_range != (1.0, 1.0):
            scale = rng.uniform(*self.friction_range)
            model.geom_friction[:, 0] *= scale

        # Mass randomization (all bodies except world)
        if self.mass_scale_range != (1.0, 1.0):
            for i in range(1, model.nbody):
                scale = rng.uniform(*self.mass_scale_range)
                model.body_mass[i] *= scale

        # Joint stiffness randomization
        if self.joint_stiffness_scale != (1.0, 1.0):
            scale = rng.uniform(*self.joint_stiffness_scale)
            model.actuator_gainprm[:, 0] *= scale
            model.actuator_biasprm[:, 1] *= scale

        # Joint damping randomization
        if self.joint_damping_scale != (1.0, 1.0):
            scale = rng.uniform(*self.joint_damping_scale)
            # Skip first 6 DOFs (freejoint)
            model.dof_damping[6:] *= scale

    @classmethod
    def from_preset(cls, name: str) -> DomainRandomization:
        if name not in PRESETS:
            raise ValueError(f"Unknown preset: {name}. Available: {list(PRESETS.keys())}")
        return PRESETS[name]


PRESETS: dict[str, DomainRandomization] = {
    "none": DomainRandomization(name="none"),

    "light": DomainRandomization(
        name="light",
        friction_range=(0.8, 1.2),
        mass_scale_range=(0.95, 1.05),
        obs_noise_scale=0.06,
    ),

    "moderate": DomainRandomization(
        name="moderate",
        friction_range=(0.5, 1.5),
        mass_scale_range=(0.9, 1.1),
        joint_stiffness_scale=(0.8, 1.2),
        joint_damping_scale=(0.8, 1.2),
        obs_noise_scale=0.08,
        action_noise_std=0.02,
        action_delay_steps=1,
    ),

    "aggressive": DomainRandomization(
        name="aggressive",
        friction_range=(0.3, 1.8),
        mass_scale_range=(0.85, 1.15),
        joint_stiffness_scale=(0.7, 1.3),
        joint_damping_scale=(0.5, 2.0),
        obs_noise_scale=0.10,
        action_noise_std=0.03,
        action_delay_steps=2,
    ),

    "real_world": DomainRandomization(
        name="real_world",
        friction_range=(0.4, 1.2),
        mass_scale_range=(0.92, 1.08),
        joint_stiffness_scale=(0.8, 1.2),
        joint_damping_scale=(0.6, 1.5),
        obs_noise_scale=0.07,
        action_noise_std=0.015,
        action_delay_steps=1,
    ),
}
