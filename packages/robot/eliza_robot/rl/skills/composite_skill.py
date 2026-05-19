"""Composite skill: simultaneous walking + upper-body control.

Runs ``BraxWalkSkill`` for legs and a separate upper-body policy
concurrently, outputting a combined 24-dim joint target for all servos.

Architecture::

    BraxWalkSkill  → 12 leg joint targets
    UpperBodySkill → 12 upper body joint targets (head + arms)
    CompositeSkill → concatenated 24-dim joint targets → servo.set

Usage::

    from eliza_robot.rl.skills.composite_skill import CompositeSkill

    skill = CompositeSkill()  # uses default checkpoint dirs
    skill.set_command(vx=0.3)
    targets = skill.get_full_action(gyro, imu_roll, imu_pitch, joint_positions)
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from eliza_robot.rl import checkpoint_path
from eliza_robot.rl.skills.base import SkillStatus
from eliza_robot.rl.skills.brax_walk_skill import BraxWalkSkill, _resolve_leg_joints

logger = logging.getLogger(__name__)


def _resolve_upper_dim(profile_id: str) -> int:
    """Return number of HEAD + ARM joints for the profile (else 12)."""
    try:
        from eliza_robot.profiles import load_profile

        profile = load_profile(profile_id)
        return sum(1 for j in profile.kinematics.joints if j.group in {"HEAD", "ARM"}) or 12
    except Exception:  # noqa: BLE001
        return 12


def _resolve_total_dim(profile_id: str) -> int:
    try:
        from eliza_robot.profiles import load_profile

        return load_profile(profile_id).kinematics.dof or 24
    except Exception:  # noqa: BLE001
        return 24


DEFAULT_WAVE_CHECKPOINT_NAME = "mujoco_wave/final_params"

# Default constants for back-compat with code that imported these.
NUM_UPPER_JOINTS = 12
NUM_TOTAL_JOINTS = 24


class UpperBodySkill:
    """Upper-body policy loaded from a Brax checkpoint.

    Maintains its own obs history and produces N-dim upper-body targets,
    where N is resolved from the profile.
    """

    SINGLE_OBS_DIM = 42  # gyro(3) + gravity(3) + upper_pos(12) + upper_vel(12) + last_act(12)
    OBS_HISTORY_SIZE = 3
    ACTION_SCALE = 0.3

    def __init__(
        self,
        checkpoint_path: str | None = None,
        task_obs_dim: int = 0,
        default_upper_pose: np.ndarray | None = None,
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self.action_dim = _resolve_upper_dim(profile_id)

        self._inference_fn = None
        self._task_obs_dim = task_obs_dim
        # Recompute SINGLE_OBS_DIM if action_dim differs from default 12.
        single = 3 + 3 + self.action_dim + self.action_dim + self.action_dim
        self._total_single = single + task_obs_dim
        self._total_obs_dim = self._total_single * self.OBS_HISTORY_SIZE

        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._obs_history = np.zeros(self._total_obs_dim, dtype=np.float32)
        self._last_positions = np.zeros(self.action_dim, dtype=np.float32)

        if default_upper_pose is not None:
            self._default_pose = default_upper_pose.copy().astype(np.float32)
        else:
            self._default_pose = np.zeros(self.action_dim, dtype=np.float32)

        if checkpoint_path:
            self.load_checkpoint(checkpoint_path)

    def load_checkpoint(self, path: str) -> None:
        """Load upper-body policy checkpoint."""
        from eliza_robot.sim.mujoco.inference import load_policy
        self._inference_fn, _ = load_policy(path)

    def reset(self) -> None:
        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._obs_history = np.zeros(self._total_obs_dim, dtype=np.float32)
        self._last_positions = np.zeros(self.action_dim, dtype=np.float32)

    def get_action(
        self,
        gyro: np.ndarray | None = None,
        imu_roll: float = 0.0,
        imu_pitch: float = 0.0,
        upper_joint_positions: np.ndarray | None = None,
        task_obs: np.ndarray | None = None,
    ) -> np.ndarray:
        """Compute upper-body joint targets."""
        if self._inference_fn is None:
            return self._default_pose.copy()

        if gyro is None:
            gyro = np.zeros(3, dtype=np.float32)

        gravity = np.array([
            np.sin(imu_roll),
            np.sin(imu_pitch),
            np.cos(imu_roll) * np.cos(imu_pitch),
        ], dtype=np.float32)

        if upper_joint_positions is not None:
            upper_pos = upper_joint_positions[: self.action_dim] - self._default_pose
            upper_vel = (upper_joint_positions[: self.action_dim] - self._last_positions) * 2.5
            self._last_positions = upper_joint_positions[: self.action_dim].copy()
        else:
            upper_pos = np.zeros(self.action_dim, dtype=np.float32)
            upper_vel = np.zeros(self.action_dim, dtype=np.float32)

        single_obs = np.concatenate([
            gyro,
            gravity,
            upper_pos,
            upper_vel,
            self._last_action,
        ]).astype(np.float32)

        if task_obs is not None:
            single_obs = np.concatenate([single_obs, task_obs])

        self._obs_history = np.roll(self._obs_history, single_obs.size)
        self._obs_history[: single_obs.size] = single_obs
        full_obs = self._obs_history.copy()

        action = self._inference_fn(full_obs)
        action = np.clip(action, -1.0, 1.0)

        targets = self._default_pose + action[: self.action_dim] * self.ACTION_SCALE
        self._last_action = action[: self.action_dim].astype(np.float32)
        return targets

    @property
    def is_loaded(self) -> bool:
        return self._inference_fn is not None


class CompositeSkill:
    """Combines walking + upper-body skills into joint control for all DoF.

    Runs both policies in parallel, concatenates their outputs, and
    returns a full joint target vector for all servos. The width is
    derived from the profile (24 for hiwonder-ainex).
    """

    def __init__(
        self,
        walking_checkpoint: str | None = None,
        upper_checkpoint: str | None = None,
        task_obs_dim: int = 0,
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self._leg_dim = _resolve_leg_joints(profile_id)
        self._upper_dim = _resolve_upper_dim(profile_id)
        self._total_dim = _resolve_total_dim(profile_id)

        self._walk_skill = BraxWalkSkill(
            checkpoint_path=walking_checkpoint,
            profile_id=profile_id,
        )

        resolved_upper = upper_checkpoint or str(checkpoint_path(DEFAULT_WAVE_CHECKPOINT_NAME))
        if upper_checkpoint is None and not Path(resolved_upper).exists():
            # No default upper checkpoint installed — instantiate without loading.
            resolved_upper = None

        self._upper_skill = UpperBodySkill(
            checkpoint_path=resolved_upper,
            task_obs_dim=task_obs_dim,
            profile_id=profile_id,
        )

    def set_command(
        self, vx: float = 0.0, vy: float = 0.0, vyaw: float = 0.0
    ) -> None:
        """Set velocity command for the walking policy."""
        self._walk_skill.set_command(vx, vy, vyaw)

    def reset(self) -> None:
        """Reset both skills."""
        self._walk_skill.reset()
        self._upper_skill.reset()

    def get_full_action(
        self,
        gyro: np.ndarray | None = None,
        imu_roll: float = 0.0,
        imu_pitch: float = 0.0,
        joint_positions: np.ndarray | None = None,
        task_obs: np.ndarray | None = None,
    ) -> np.ndarray:
        """Compute combined joint targets [legs, upper_body]."""
        leg_positions = None
        upper_positions = None
        if joint_positions is not None:
            leg_positions = joint_positions[: self._leg_dim]
            upper_positions = joint_positions[self._leg_dim :]

        leg_targets, _status = self._walk_skill.get_action_from_telemetry(
            gyro=gyro,
            imu_roll=imu_roll,
            imu_pitch=imu_pitch,
            joint_positions=leg_positions,
        )
        _ = SkillStatus  # noqa: F841 — keep re-export usage for type narrowing tools

        upper_targets = self._upper_skill.get_action(
            gyro=gyro,
            imu_roll=imu_roll,
            imu_pitch=imu_pitch,
            upper_joint_positions=upper_positions,
            task_obs=task_obs,
        )

        return np.concatenate([leg_targets, upper_targets])

    @property
    def default_pose(self) -> np.ndarray:
        """Default standing pose for legs + upper body."""
        return np.concatenate([self._walk_skill.default_pose, self._upper_skill._default_pose])

    @property
    def walk_skill(self) -> BraxWalkSkill:
        return self._walk_skill

    @property
    def upper_skill(self) -> UpperBodySkill:
        return self._upper_skill
