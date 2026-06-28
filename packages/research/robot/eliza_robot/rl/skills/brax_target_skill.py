"""Target-reaching skill backed by Brax/JAX checkpoint.

Walks toward a target position ``(x, y)`` in body frame using the trained
``TargetReaching`` policy. When no target-reaching checkpoint exists, falls
back to ``BraxWalkSkill`` by converting target direction into velocity
commands (vx proportional to distance, vyaw proportional to bearing).

Usage::

    skill = BraxTargetSkill()
    skill.set_target(x=1.5, y=0.3)
    action, status = skill.get_action_from_telemetry(
        imu_roll=0.0, imu_pitch=0.0, joint_positions=feedback,
    )
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from eliza_robot.rl import checkpoint_path
from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus
from eliza_robot.rl.skills.brax_walk_skill import (
    ACTION_SCALE,
    CTRL_DT,
    BraxWalkSkill,
    DEFAULT_WALK_CHECKPOINT_NAME,
    _resolve_leg_joints,
)

logger = logging.getLogger(__name__)

# Observation layout for TargetReaching (matches target.py):
# gyro(3) + gravity(3) + target_vec(2) + target_dist(1) + target_bearing(1)
# + joint_pos(...) + last_act(...) = 34 (12-act deploy) or 58 (24-act train)
TARGET_OBS_EXTRA = 4

OBS_HISTORY_SIZE = 3

# Fallback velocity gains
FALLBACK_VX_MAX = 0.3
FALLBACK_VYAW_GAIN = 2.0
FALLBACK_VYAW_MAX = 1.0

DEFAULT_TARGET_CHECKPOINT_NAME = "mujoco_target_reaching"


class BraxTargetSkill(BaseSkill):
    """Walk to a target position using the trained TargetReaching policy.

    Accepts a target ``(x, y)`` in body frame and produces leg joint targets
    that walk toward it. Uses the same Brax checkpoint format as the walking
    policy, but with extended observation (target_vec, target_dist,
    target_bearing appended).

    Fallback mode
    -------------
    If no target-reaching checkpoint is available, the skill delegates to
    ``BraxWalkSkill`` with velocity commands computed from the target
    direction:

    - ``vx = clamp(target_dist, 0, 0.3)``
    - ``vyaw = clamp(target_bearing * 2.0, -1.0, 1.0)``
    """

    name = "walk_to_target"
    requires_rl = True

    DEFAULT_CHECKPOINT_NAME = DEFAULT_TARGET_CHECKPOINT_NAME

    def __init__(
        self,
        checkpoint_path: str | None = None,
        arrival_threshold: float = 0.3,  # metres
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self.action_dim = _resolve_leg_joints(profile_id)

        # Derive obs dim layouts from the profile-resolved leg count.
        self._single_obs_dim_legs = 3 + 3 + 2 + 1 + 1 + self.action_dim + self.action_dim
        # 24-actuator training mode uses double the joint width (head + arms).
        self._single_obs_dim_full = 3 + 3 + 2 + 1 + 1 + 2 * self.action_dim + 2 * self.action_dim

        self._inference_fn = None
        self._config: dict | None = None
        self._arrival_threshold = arrival_threshold

        # Target in body frame
        self._target_x: float = 0.0
        self._target_y: float = 0.0
        self._target_set: bool = False

        # Default standing pose — TargetReaching env uses all-zeros (straight legs).
        self._default_pose = np.zeros(self.action_dim, dtype=np.float32)

        # State buffers
        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._last_positions = self._default_pose.copy()

        self._single_obs_dim: int = self._single_obs_dim_legs
        self._obs_history = np.zeros(
            self._single_obs_dim * OBS_HISTORY_SIZE, dtype=np.float32
        )

        self._params = SkillParams()
        self._step = 0

        self._fallback_walk: BraxWalkSkill | None = None
        self._using_fallback = True

        resolved_path = checkpoint_path or str(_default_target_checkpoint())
        if Path(resolved_path).exists():
            try:
                self.load_checkpoint(resolved_path)
                self._using_fallback = False
                logger.info(
                    "BraxTargetSkill: loaded target-reaching checkpoint from %s",
                    resolved_path,
                )
            except Exception:  # noqa: BLE001 — fallback is intentional
                logger.warning(
                    "BraxTargetSkill: failed to load checkpoint %s, using fallback",
                    resolved_path,
                    exc_info=True,
                )
        else:
            logger.info(
                "BraxTargetSkill: no checkpoint at %s, using fallback walk skill",
                resolved_path,
            )

        if self._using_fallback:
            self._init_fallback()

    # ------------------------------------------------------------------
    # Checkpoint loading
    # ------------------------------------------------------------------

    def load_checkpoint(self, path: str) -> None:
        """Load Brax checkpoint via ``eliza_robot.sim.mujoco.inference``."""
        from eliza_robot.sim.mujoco.inference import load_policy

        self._inference_fn, self._config = load_policy(path)

        obs_size = self._config.get("obs_size") if self._config else None
        if obs_size is not None:
            enable_entities = self._config.get("enable_entity_slots", False)
            entity_dims = 0
            if enable_entities:
                # Perception package may not be importable in every env.
                try:
                    from eliza_robot.perception.entity_slots.slot_config import (
                        TOTAL_ENTITY_DIMS,
                    )
                    entity_dims = TOTAL_ENTITY_DIMS
                except Exception:  # noqa: BLE001
                    entity_dims = 152  # 8 slots * 19 dims

            core_obs_size = obs_size - entity_dims
            if core_obs_size > 0 and core_obs_size % OBS_HISTORY_SIZE == 0:
                self._single_obs_dim = core_obs_size // OBS_HISTORY_SIZE
            else:
                self._single_obs_dim = self._single_obs_dim_full

            self._obs_history = np.zeros(
                self._single_obs_dim * OBS_HISTORY_SIZE, dtype=np.float32
            )

    def _init_fallback(self) -> None:
        """Initialise fallback walk skill (loads walking checkpoint if available)."""
        walk_ckpt = checkpoint_path(DEFAULT_WALK_CHECKPOINT_NAME)
        ckpt = str(walk_ckpt) if walk_ckpt.exists() else None
        self._fallback_walk = BraxWalkSkill(checkpoint_path=ckpt, profile_id=self.profile_id)
        self._using_fallback = True

    # ------------------------------------------------------------------
    # Target setters
    # ------------------------------------------------------------------

    def set_target(self, x: float, y: float) -> None:
        """Set target position in body frame (metres)."""
        self._target_x = float(x)
        self._target_y = float(y)
        self._target_set = True

    def set_target_world(
        self,
        target_world: np.ndarray,
        robot_pos: np.ndarray,
        robot_yaw: float,
    ) -> None:
        """Set target from world-frame coordinates."""
        delta = np.asarray(target_world[:2], dtype=np.float64) - np.asarray(
            robot_pos[:2], dtype=np.float64
        )
        cos_yaw = np.cos(-robot_yaw)
        sin_yaw = np.sin(-robot_yaw)
        body_x = float(delta[0] * cos_yaw - delta[1] * sin_yaw)
        body_y = float(delta[0] * sin_yaw + delta[1] * cos_yaw)
        self.set_target(body_x, body_y)

    # ------------------------------------------------------------------
    # Target properties
    # ------------------------------------------------------------------

    @property
    def target_reached(self) -> bool:
        return self.target_distance <= self._arrival_threshold

    @property
    def target_distance(self) -> float:
        return float(np.sqrt(self._target_x ** 2 + self._target_y ** 2))

    @property
    def target_bearing(self) -> float:
        return float(np.arctan2(self._target_y, self._target_x))

    # ------------------------------------------------------------------
    # Skill interface
    # ------------------------------------------------------------------

    def reset(self, params: SkillParams | None = None) -> None:
        self._params = params or SkillParams()
        self._step = 0
        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._obs_history = np.zeros(
            self._single_obs_dim * OBS_HISTORY_SIZE, dtype=np.float32
        )
        self._last_positions = self._default_pose.copy()
        self._target_x = 0.0
        self._target_y = 0.0
        self._target_set = False

        if self._fallback_walk is not None:
            self._fallback_walk.reset(params)

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        """Compute one step of target-reaching policy."""
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * CTRL_DT
            if elapsed >= self._params.duration_sec:
                return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._target_set and self.target_reached:
            return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._using_fallback:
            return self._fallback_get_action(obs)

        if self._inference_fn is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        expected_dim = self._single_obs_dim * OBS_HISTORY_SIZE
        full_obs = obs if obs.shape[0] == expected_dim else self._obs_history.copy()

        action = self._inference_fn(full_obs)
        action = np.clip(action, -1.0, 1.0)

        joint_targets = self._default_pose + action[: self.action_dim] * ACTION_SCALE
        self._last_action = action[: self.action_dim].astype(np.float32)
        return joint_targets, SkillStatus.RUNNING

    def get_action_from_telemetry(
        self,
        gyro: np.ndarray | None = None,
        imu_roll: float = 0.0,
        imu_pitch: float = 0.0,
        joint_positions: np.ndarray | None = None,
    ) -> tuple[np.ndarray, SkillStatus]:
        """Structured telemetry interface."""
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * CTRL_DT
            if elapsed >= self._params.duration_sec:
                return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._target_set and self.target_reached:
            return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._using_fallback:
            return self._fallback_get_action_from_telemetry(
                gyro=gyro,
                imu_roll=imu_roll,
                imu_pitch=imu_pitch,
                joint_positions=joint_positions,
            )

        if self._inference_fn is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        if gyro is None:
            gyro = np.zeros(3, dtype=np.float32)

        gravity = np.array(
            [
                np.sin(imu_roll),
                np.sin(imu_pitch),
                np.cos(imu_roll) * np.cos(imu_pitch),
            ],
            dtype=np.float32,
        )

        target_vec = np.array(
            [self._target_x, self._target_y], dtype=np.float32
        )
        target_dist_val = np.float32(self.target_distance)
        target_bearing_val = np.float32(self.target_bearing)

        if joint_positions is not None:
            leg_pos = joint_positions[: self.action_dim] - self._default_pose
            self._last_positions = joint_positions[: self.action_dim].copy()
        else:
            leg_pos = np.zeros(self.action_dim, dtype=np.float32)

        if self._single_obs_dim == self._single_obs_dim_full:
            # 24-actuator (full body) training-time layout — pad with zeros.
            full_dim = 2 * self.action_dim
            joint_pos_full = np.zeros(full_dim, dtype=np.float32)
            joint_pos_full[: self.action_dim] = leg_pos
            last_act_full = np.zeros(full_dim, dtype=np.float32)
            last_act_full[: self.action_dim] = self._last_action
            single_obs = np.concatenate(
                [
                    gyro,
                    gravity,
                    target_vec,
                    np.array([target_dist_val]),
                    np.array([target_bearing_val]),
                    joint_pos_full,
                    last_act_full,
                ]
            ).astype(np.float32)
        else:
            single_obs = np.concatenate(
                [
                    gyro,
                    gravity,
                    target_vec,
                    np.array([target_dist_val]),
                    np.array([target_bearing_val]),
                    leg_pos,
                    self._last_action,
                ]
            ).astype(np.float32)

        full_obs = self._stack_history(single_obs)
        action = self._inference_fn(full_obs)
        action = np.clip(action, -1.0, 1.0)

        joint_targets = self._default_pose + action[: self.action_dim] * ACTION_SCALE
        self._last_action = action[: self.action_dim].astype(np.float32)
        return joint_targets, SkillStatus.RUNNING

    # ------------------------------------------------------------------
    # Fallback velocity computation
    # ------------------------------------------------------------------

    def _compute_fallback_velocity(self) -> tuple[float, float]:
        dist = self.target_distance
        bearing = self.target_bearing

        vx = float(np.clip(dist, 0.0, FALLBACK_VX_MAX))
        vyaw = float(
            np.clip(
                bearing * FALLBACK_VYAW_GAIN,
                -FALLBACK_VYAW_MAX,
                FALLBACK_VYAW_MAX,
            )
        )
        return vx, vyaw

    def _fallback_get_action(
        self, obs: np.ndarray
    ) -> tuple[np.ndarray, SkillStatus]:
        if self._fallback_walk is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        vx, vyaw = self._compute_fallback_velocity()
        self._fallback_walk.set_command(vx=vx, vy=0.0, vyaw=vyaw)
        return self._fallback_walk.get_action(obs)

    def _fallback_get_action_from_telemetry(
        self,
        gyro: np.ndarray | None = None,
        imu_roll: float = 0.0,
        imu_pitch: float = 0.0,
        joint_positions: np.ndarray | None = None,
    ) -> tuple[np.ndarray, SkillStatus]:
        if self._fallback_walk is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        vx, vyaw = self._compute_fallback_velocity()
        self._fallback_walk.set_command(vx=vx, vy=0.0, vyaw=vyaw)
        return self._fallback_walk.get_action_from_telemetry(
            gyro=gyro,
            imu_roll=imu_roll,
            imu_pitch=imu_pitch,
            joint_positions=joint_positions,
        )

    # ------------------------------------------------------------------
    # History stacking
    # ------------------------------------------------------------------

    def _stack_history(self, obs: np.ndarray) -> np.ndarray:
        self._obs_history = np.roll(self._obs_history, obs.size)
        self._obs_history[: obs.size] = obs
        return self._obs_history.copy()

    # ------------------------------------------------------------------
    # Convenience properties
    # ------------------------------------------------------------------

    @property
    def default_pose(self) -> np.ndarray:
        return self._default_pose.copy()

    @property
    def is_loaded(self) -> bool:
        return self._inference_fn is not None

    @property
    def using_fallback(self) -> bool:
        return self._using_fallback


def _default_target_checkpoint() -> Path:
    """Resolve the default target-reaching checkpoint directory."""
    return checkpoint_path(DEFAULT_TARGET_CHECKPOINT_NAME)


# Back-compat re-export.
NUM_LEG_JOINTS = 12
