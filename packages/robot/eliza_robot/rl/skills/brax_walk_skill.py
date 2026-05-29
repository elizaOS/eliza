"""Walk skill backed by a Brax/JAX checkpoint trained in MuJoCo Playground.

Loads the v13 (domain-randomized, flat-feet) locomotion policy via
``eliza_robot.sim.mujoco.inference.load_policy``, maintains a 3-frame
observation history, and outputs 12-dim joint targets in radians. Designed
for direct joint control (`servo.set`) rather than the legacy `walk.set`
parameter mode.

Profile awareness
-----------------

The skill accepts a ``profile_id`` (default ``"hiwonder-ainex"``) and
resolves the leg-joint count from that profile when possible. When the
profile cannot be loaded — e.g. the package is being used in isolation
without the bundled profile YAMLs — we fall back to the AiNex 12-leg-DoF
default.

Checkpoint resolution
---------------------

If no ``checkpoint_path`` is provided, the skill resolves a default of
``checkpoint_path("mujoco_locomotion_v13_flat_feet")`` from
``eliza_robot.rl``. That helper honours the ``ELIZA_ROBOT_CHECKPOINT_DIR``
environment variable.

Usage
-----

.. code-block:: python

    skill = BraxWalkSkill()  # uses default checkpoint dir
    skill.set_command(vx=0.5, vy=0.0, vyaw=0.0)
    action, status = skill.get_action(bridge_obs)
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from eliza_robot.rl import checkpoint_path
from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus

logger = logging.getLogger(__name__)

# Observation layout (matches joystick._get_obs EXACTLY):
# gyro(3) + gravity(3) + command(3) + cos(phase)[L,R](2) + sin(phase)[L,R](2)
# + leg_pos(12) + leg_vel(12) + last_act(12) = 49, stacked obs_history(3) = 147.
# The 4-dim gait-phase block sits BETWEEN command and leg_pos; omitting it (the
# old 45/135 layout) shifted every downstream field and fed the policy garbage.
# Per-instance dims are derived from the profile leg count in __init__.
OBS_HISTORY_SIZE = 3
_NON_LEG_OBS = 3 + 3 + 3 + 4  # gyro, gravity, command, gait-phase(cos2, sin2)
SINGLE_OBS_DIM = _NON_LEG_OBS + 3 * 12  # 49 (12-leg default; re-exported)
TOTAL_OBS_DIM = SINGLE_OBS_DIM * OBS_HISTORY_SIZE  # 147

DEFAULT_NUM_LEG_JOINTS = 12
NUM_LEG_JOINTS = DEFAULT_NUM_LEG_JOINTS  # back-compat re-export
ACTION_SCALE = 0.3
CTRL_DT = 0.02  # 50 Hz
DEFAULT_GAIT_FREQ_HZ = 1.5  # joystick training randomized 1.25–1.75; midpoint

DEFAULT_WALK_CHECKPOINT_NAME = "mujoco_locomotion_v13_flat_feet"


def _resolve_leg_joints(profile_id: str) -> int:
    """Return the number of LEG-group joints for the named profile.

    Falls back to ``DEFAULT_NUM_LEG_JOINTS`` if the profile cannot be loaded
    (e.g. asset-less install).
    """
    try:
        from eliza_robot.profiles import load_profile

        profile = load_profile(profile_id)
        leg_count = sum(1 for j in profile.kinematics.joints if j.group == "LEG")
        return leg_count or DEFAULT_NUM_LEG_JOINTS
    except Exception:  # noqa: BLE001 — profile resolution is best-effort.
        return DEFAULT_NUM_LEG_JOINTS


class BraxWalkSkill(BaseSkill):
    """Walk using the trained Brax/JAX locomotion policy.

    This skill:
    1. Loads the Brax checkpoint via ``eliza_robot.sim.mujoco.inference.load_policy``.
    2. Maintains a 3-frame obs history buffer (45 * 3 = 135 dims).
    3. Accepts velocity commands via ``set_command(vx, vy, vyaw)``.
    4. Maps bridge telemetry to the 45-dim Brax obs format.
    5. Outputs 12-dim joint targets (radians, absolute) for ``servo.set``.

    The obs mapping from bridge telemetry::

        gyro(3)     <- IMU angular velocity (if available) or zeros
        gravity(3)  <- computed from IMU roll/pitch
        command(3)  <- set_command(vx, vy, vyaw)
        leg_pos(12) <- servo position feedback - default_pose
        leg_vel(12) <- finite-diff from positions * 0.05 (scaled to qvel*0.05)
        last_act(12)<- internal buffer
    """

    name = "walk"
    requires_rl = True

    def __init__(
        self,
        checkpoint_path: str | None = None,
        default_pose: np.ndarray | None = None,
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self.action_dim = _resolve_leg_joints(profile_id)

        self._inference_fn = None
        self._config: dict | None = None

        # Velocity command
        self._command = np.zeros(3, dtype=np.float32)

        # Default standing pose (leg joints only, in radians).
        # Bent-knee standing pose matching training.
        if default_pose is not None:
            self._default_pose = default_pose[: self.action_dim].copy().astype(np.float32)
        else:
            self._default_pose = np.array([
                # Right leg: hip_yaw, hip_roll, hip_pitch, knee, ank_pitch, ank_roll
                # From real robot init_pose.yaml
                0, -0.016, 0.828, -1.192, -0.625, -0.016,
                # Left leg
                0, 0.016, -0.828, 1.192, 0.625, 0.016,
            ], dtype=np.float32)
            # Trim/pad to match resolved leg dim.
            if self._default_pose.shape[0] != self.action_dim:
                resized = np.zeros(self.action_dim, dtype=np.float32)
                copy_n = min(self._default_pose.shape[0], self.action_dim)
                resized[:copy_n] = self._default_pose[:copy_n]
                self._default_pose = resized

        # Per-instance observation dims (derived from the profile leg count so
        # this matches whatever joystick env the checkpoint was trained in).
        self._single_obs_dim = _NON_LEG_OBS + 3 * self.action_dim
        self._total_obs_dim = self._single_obs_dim * OBS_HISTORY_SIZE

        # Bipedal gait phase [left, right] = [0, pi], advanced each control step
        # exactly as joystick.step does, so cos/sin(phase) match the training obs.
        self._gait_freq = self._resolve_gait_freq(profile_id)
        self._phase_dt = 2.0 * np.pi * CTRL_DT * self._gait_freq
        self._phase = np.array([0.0, np.pi], dtype=np.float32)

        # State buffers (must come after _default_pose is set)
        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._obs_history = np.zeros(self._total_obs_dim, dtype=np.float32)
        self._last_positions = self._default_pose.copy()

        self._params = SkillParams()
        self._step = 0

        resolved = checkpoint_path or str(_default_checkpoint())
        if Path(resolved).exists():
            try:
                self.load_checkpoint(resolved)
            except Exception:  # noqa: BLE001 — checkpoint loading is optional
                logger.warning(
                    "BraxWalkSkill: failed to load checkpoint %s, running with zero policy",
                    resolved,
                    exc_info=True,
                )
        else:
            # No checkpoint on disk: the skill will HOLD THE DEFAULT POSE, not
            # walk. Surface this loudly — a "walk" skill that silently stands is
            # the exact larp this stack is being cleaned of. Callers can load a
            # checkpoint later via load_checkpoint(); is_loaded reports the truth.
            logger.warning(
                "BraxWalkSkill: no checkpoint at %s — skill will hold the default "
                "pose and NOT walk until load_checkpoint() is called with a trained "
                "policy (train one via scripts/train_playground_locomotion.py).",
                resolved,
            )

    @staticmethod
    def _resolve_gait_freq(profile_id: str) -> float:
        """Gait frequency (Hz) for phase advance; profile.gait.cycle_hz or default."""
        try:
            from eliza_robot.profiles import load_profile

            cyc = getattr(load_profile(profile_id).gait, "cycle_hz", None)
            return float(cyc) if cyc else DEFAULT_GAIT_FREQ_HZ
        except Exception:  # noqa: BLE001 — best-effort profile resolution.
            return DEFAULT_GAIT_FREQ_HZ

    def _advance_phase(self) -> None:
        """Advance the bipedal gait phase one step (matches joystick.step wrap)."""
        self._phase = np.fmod(self._phase + self._phase_dt + np.pi, 2.0 * np.pi) - np.pi

    def _phase_block(self) -> np.ndarray:
        """[cos(phase_L), cos(phase_R), sin(phase_L), sin(phase_R)] — joystick order."""
        return np.concatenate([np.cos(self._phase), np.sin(self._phase)]).astype(np.float32)

    def load_checkpoint(self, path: str) -> None:
        """Load Brax checkpoint via ``eliza_robot.sim.mujoco.inference``.

        Fails loud when the checkpoint's observation size does not match the obs
        this skill builds — a mismatch means the policy receives misaligned
        fields and cannot walk (this previously passed silently).
        """
        from eliza_robot.sim.mujoco.inference import load_policy
        self._inference_fn, self._config = load_policy(path)
        ckpt_obs = int(self._config.get("obs_size", 0) or 0)
        if ckpt_obs and ckpt_obs != self._total_obs_dim:
            self._inference_fn = None
            raise ValueError(
                f"BraxWalkSkill obs mismatch: checkpoint expects obs_size={ckpt_obs} "
                f"but this skill builds {self._total_obs_dim} "
                f"({OBS_HISTORY_SIZE}x{self._single_obs_dim}). The skill obs layout "
                f"(incl. the 4-dim gait-phase block) must match the training env."
            )

    def set_command(self, vx: float = 0.0, vy: float = 0.0, vyaw: float = 0.0) -> None:
        """Set velocity command for the walking policy.

        Args:
            vx: Forward velocity (m/s). Training range: [-0.3, 1.2].
            vy: Lateral velocity (m/s). Training range: [-0.4, 0.4].
            vyaw: Yaw rate (rad/s). Training range: [-0.8, 0.8].
        """
        self._command[0] = np.clip(vx, -0.3, 1.2)
        self._command[1] = np.clip(vy, -0.4, 0.4)
        self._command[2] = np.clip(vyaw, -0.8, 0.8)

    def reset(self, params: SkillParams | None = None) -> None:
        self._params = params or SkillParams()
        self._step = 0
        self._last_action = np.zeros(self.action_dim, dtype=np.float32)
        self._obs_history = np.zeros(self._total_obs_dim, dtype=np.float32)
        self._last_positions = self._default_pose.copy()
        self._phase = np.array([0.0, np.pi], dtype=np.float32)

        # Map skill params to velocity command
        speed = self._params.speed
        direction = self._params.direction
        self._command[0] = float(speed * 0.5)  # speed multiplier -> vx
        self._command[2] = float(direction * 0.3)  # direction -> vyaw

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        """Compute one step of walking policy.

        Args:
            obs: Bridge observation. Can be:
                - Raw bridge obs (arbitrary format) — will use internal state
                - Pre-built 135-dim obs history — passed directly to policy

        Returns:
            (joint_targets, status) where joint_targets are absolute radians
            for the leg joints, suitable for servo.set.
        """
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * CTRL_DT
            if elapsed >= self._params.duration_sec:
                return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._inference_fn is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        full_obs = obs if obs.shape[0] == self._total_obs_dim else self._build_obs_from_bridge(obs)

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
        """Compute action from structured bridge telemetry.

        Args:
            gyro: Angular velocity [wx, wy, wz] in body frame. None = zeros.
            imu_roll: Roll angle in radians.
            imu_pitch: Pitch angle in radians.
            joint_positions: Current leg joint positions in radians (12-dim).

        Returns:
            (joint_targets, status) where joint_targets are absolute radians.
        """
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * CTRL_DT
            if elapsed >= self._params.duration_sec:
                return self._default_pose.copy(), SkillStatus.COMPLETED

        if self._inference_fn is None:
            return self._default_pose.copy(), SkillStatus.RUNNING

        if gyro is None:
            gyro = np.zeros(3, dtype=np.float32)

        gravity = np.array([
            np.sin(imu_roll),
            np.sin(imu_pitch),
            np.cos(imu_roll) * np.cos(imu_pitch),
        ], dtype=np.float32)

        if joint_positions is not None:
            leg_pos = joint_positions[: self.action_dim] - self._default_pose
            # Finite-diff velocity: (pos_delta / ctrl_dt) * 0.05.
            # At 50Hz: pos_delta / 0.02 * 0.05 = pos_delta * 2.5.
            leg_vel = (joint_positions[: self.action_dim] - self._last_positions) * 2.5
            self._last_positions = joint_positions[: self.action_dim].copy()
        else:
            leg_pos = np.zeros(self.action_dim, dtype=np.float32)
            leg_vel = np.zeros(self.action_dim, dtype=np.float32)

        self._advance_phase()
        single_obs = np.concatenate([
            gyro,                   # 3
            gravity,                # 3
            self._command,          # 3
            self._phase_block(),    # 4 (cos[L,R], sin[L,R]) — matches joystick
            leg_pos,                # n
            leg_vel,                # n
            self._last_action,      # n
        ]).astype(np.float32)       # _single_obs_dim

        full_obs = self._stack_history(single_obs)

        action = self._inference_fn(full_obs)
        action = np.clip(action, -1.0, 1.0)

        joint_targets = self._default_pose + action[: self.action_dim] * ACTION_SCALE
        self._last_action = action[: self.action_dim].astype(np.float32)

        return joint_targets, SkillStatus.RUNNING

    def _build_obs_from_bridge(self, obs: np.ndarray) -> np.ndarray:
        """Build the stacked obs from a partial bridge observation."""
        gyro = np.zeros(3, dtype=np.float32)
        gravity = np.array([0.0, 0.0, 1.0], dtype=np.float32)

        if obs.shape[0] >= 5:
            # Bridge obs convention: index 2=imu_roll, 3=imu_pitch.
            imu_roll = float(obs[2]) if obs.shape[0] > 2 else 0.0
            imu_pitch = float(obs[3]) if obs.shape[0] > 3 else 0.0
            gravity[0] = np.sin(imu_roll)
            gravity[1] = np.sin(imu_pitch)
            gravity[2] = np.cos(imu_roll) * np.cos(imu_pitch)

        self._advance_phase()
        single_obs = np.concatenate([
            gyro,
            gravity,
            self._command,
            self._phase_block(),                          # 4 (cos[L,R], sin[L,R])
            np.zeros(self.action_dim, dtype=np.float32),  # leg_pos (no feedback)
            np.zeros(self.action_dim, dtype=np.float32),  # leg_vel (no feedback)
            self._last_action,
        ]).astype(np.float32)

        return self._stack_history(single_obs)

    def _stack_history(self, obs: np.ndarray) -> np.ndarray:
        """Push new obs into front of history buffer."""
        self._obs_history = np.roll(self._obs_history, obs.size)
        self._obs_history[: obs.size] = obs
        return self._obs_history.copy()

    @property
    def default_pose(self) -> np.ndarray:
        """Return the default standing pose for leg joints."""
        return self._default_pose.copy()

    @property
    def command(self) -> np.ndarray:
        """Current velocity command [vx, vy, vyaw]."""
        return self._command.copy()

    @property
    def is_loaded(self) -> bool:
        """Whether a checkpoint has been loaded."""
        return self._inference_fn is not None


def _default_checkpoint() -> Path:
    """Resolve the default walking checkpoint directory."""
    return checkpoint_path(DEFAULT_WALK_CHECKPOINT_NAME)
