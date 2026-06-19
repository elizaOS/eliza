"""Text-conditioned AiNex environment for PPO training.

Two flavours are exposed:

  - `TextConditionedJoystickEnv`: a CPU-friendly Gymnasium env that wraps
    DemoEnv (mujoco python bindings, no MJX dependency). Used for fast
    smoke training and unit tests on the dev machine. Action space is the
    24-D joint targets; observation = proprio + task embedding.

  - `TextConditionedMjxEnv`: a Brax-PPO compatible MJX env that forks
    `eliza_robot.sim.mujoco.joystick.Joystick` and replaces the 3-D
    velocity command with `[3-D vel cmd, N-D task embedding]`. Used for
    full training (local 5080 or Nebius).

The two envs share:
  - the same curriculum (loaded from tasks.yaml)
  - the same text encoder (sentence-transformers + PCA)
  - the same reward decomposition keyed off task.reward fields
  - the same success criteria (GoalChecker)
"""

from __future__ import annotations

from dataclasses import dataclass

import gymnasium as gym
import numpy as np

from eliza_robot.curriculum.loader import Curriculum, TaskSpec, load_curriculum
from eliza_robot.rl.text_conditioned.encoder import (
    TaskEmbedding,
    build_task_embeddings,
)


@dataclass
class TextEnvConfig:
    tier_subset: tuple[int, ...] = (1,)  # only tier-1 fundamentals by default
    include_tasks: tuple[str, ...] = ()   # if non-empty, restrict to these ids
    exclude_tasks: tuple[str, ...] = ("look_up", "look_down")  # 0 leg motion
    pca_dim: int = 32
    episode_steps: int = 400
    control_dt: float = 0.02              # 50 Hz outer loop
    text_obs_weight: float = 1.0          # multiplier on the text embedding
    action_scale: float = 0.3             # rad per step around the default pose


class TextConditionedJoystickEnv(gym.Env):
    """CPU-friendly text-conditioned env for AiNex smoke training.

    Observation:
      proprio (45-D) ⊕ task_embedding (pca_dim)
    Action:
      24-D joint deltas around the home pose, clipped to [-1, 1]
    Reward:
      task-conditional. Each task in the curriculum declares its reward
      weights in `tasks.yaml`; we read them off `task.reward`.
    """

    metadata = {"render_modes": ["rgb_array"], "render_fps": 50}

    def __init__(
        self,
        config: TextEnvConfig | None = None,
        *,
        curriculum: Curriculum | None = None,
        embeddings: dict[str, TaskEmbedding] | None = None,
    ) -> None:
        super().__init__()
        self.config = config or TextEnvConfig()
        self.curriculum = curriculum or load_curriculum()
        self.embeddings = embeddings or build_task_embeddings(
            curriculum=self.curriculum, pca_dim=self.config.pca_dim
        )
        # Select the active task set.
        cfg = self.config
        candidates: list[TaskSpec] = []
        for t in self.curriculum.tasks:
            if cfg.tier_subset and t.tier not in cfg.tier_subset:
                continue
            if cfg.include_tasks and t.id not in cfg.include_tasks:
                continue
            if t.id in cfg.exclude_tasks:
                continue
            candidates.append(t)
        if not candidates:
            raise ValueError("config selected zero curriculum tasks")
        self.active_tasks = candidates
        self.task_ids = [t.id for t in candidates]

        # Lazy-load DemoEnv on first reset so unit tests can instantiate
        # the env without MuJoCo present.
        self._demo_env = None
        self._current_task: TaskSpec | None = None
        self._current_embed: np.ndarray | None = None
        self._step_count: int = 0
        self._init_pose: np.ndarray | None = None
        self._init_torso_xy: np.ndarray | None = None
        self._init_yaw: float | None = None

        # Spaces — pick text dim from the actual cached embedding shape so
        # we don't lie about it when PCA falls back to the raw mean
        # (which happens when |tasks| < pca_dim).
        any_embed = next(iter(self.embeddings.values())).reduced_embed
        text_dim = int(any_embed.shape[0])
        proprio_dim = 45  # gyro(3)+gravity(3)+joint_pos(24)+joint_vel(15) approx
        self._proprio_dim = proprio_dim
        self._text_dim = text_dim
        self.observation_space = gym.spaces.Box(
            low=-10.0, high=10.0,
            shape=(proprio_dim + text_dim,),
            dtype=np.float32,
        )
        self.action_space = gym.spaces.Box(
            low=-1.0, high=1.0, shape=(24,), dtype=np.float32,
        )

    # ------------------------------------------------------------------
    def _ensure_env(self) -> None:
        if self._demo_env is None:
            from eliza_robot.sim.mujoco.demo_env import DemoEnv

            self._demo_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
            self._init_pose = self._demo_env.default_pose.copy()

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        self._ensure_env()
        env = self._demo_env
        env.reset()
        self._step_count = 0
        # Pick a task uniformly.
        task = self.active_tasks[self.np_random.integers(len(self.active_tasks))]
        self._current_task = task
        self._current_embed = self.embeddings[task.id].reduced_embed.astype(np.float32)
        self._init_torso_xy = env.get_robot_position()[:2].copy()
        self._init_yaw = float(env.get_robot_yaw())
        obs = self._build_obs()
        info = {"task_id": task.id, "task_tier": task.tier}
        return obs, info

    def step(self, action: np.ndarray):
        assert self._current_task is not None
        env = self._demo_env
        # Scale action and add to home pose.
        scale = self.config.action_scale
        delta = np.clip(action, -1.0, 1.0) * scale
        targets = (self._init_pose + delta).astype(np.float64)
        joint_targets = {
            name: float(targets[i])
            for i, name in enumerate(env.joint_names)
        }
        # Step ~10 substeps for stability (DemoEnv timestep is 2 ms; 10 → 20 ms).
        n_substeps = max(1, int(self.config.control_dt / env.model.opt.timestep))
        env.step_n(n=n_substeps, joint_targets=joint_targets)
        self._step_count += 1

        obs = self._build_obs()
        reward = self._compute_reward(action)
        # Termination on fall
        gravity = env.data.sensordata[env._gravity_adr].copy() if hasattr(env, "_gravity_adr") else None
        torso_z = env.get_robot_position()[2]
        terminated = bool(torso_z < 0.10)
        truncated = self._step_count >= self.config.episode_steps
        info = {"task_id": self._current_task.id}
        return obs, float(reward), bool(terminated), bool(truncated), info

    # ------------------------------------------------------------------
    def _build_obs(self) -> np.ndarray:
        env = self._demo_env
        telemetry = env._build_telemetry()
        joint_positions = np.array(
            [float(telemetry["joint_positions"][n]) for n in env.joint_names],
            dtype=np.float32,
        )
        gyro = np.asarray(env.data.sensordata[env._gyro_adr], dtype=np.float32)
        gravity = np.asarray(env.data.sensordata[env._gravity_adr], dtype=np.float32)
        joint_vel = np.asarray(env.data.qvel[:15], dtype=np.float32)
        proprio = np.concatenate([gyro, gravity, joint_positions, joint_vel])
        # Match the declared obs shape exactly.
        proprio = _pad_or_trim(proprio, self._proprio_dim)
        text = self._current_embed * self.config.text_obs_weight
        return np.concatenate([proprio, text]).astype(np.float32)

    # ------------------------------------------------------------------
    def _compute_reward(self, action: np.ndarray) -> float:
        env = self._demo_env
        task = self._current_task
        r = task.reward
        reward = 0.0
        pos = env.get_robot_position()
        yaw = float(env.get_robot_yaw())

        # Torso-height target (used by stand_up / sit_down / lie_down).
        if "torso_height_target_m" in r:
            target = float(r["torso_height_target_m"])
            tol = float(r.get("torso_height_tolerance_m", 0.05))
            err = abs(pos[2] - target)
            reward += float(np.exp(-err / max(tol, 1e-3))) * 1.0

        # Upright bonus (cos pitch * cos roll).
        gravity = env.data.sensordata[env._gravity_adr].copy()
        # When upright in z-up convention, gravity is [0,0,1].
        upright_dot = float(np.clip(gravity[2], -1.0, 1.0))
        reward += upright_dot * float(r.get("upright_weight", 0.0))

        # Velocity tracking.
        if "target_velocity_x_m_s" in r and self._init_torso_xy is not None:
            elapsed = self._step_count * self.config.control_dt + 1e-6
            vx_actual = (pos[0] - self._init_torso_xy[0]) / elapsed
            vx_target = float(r["target_velocity_x_m_s"])
            reward += float(np.exp(-((vx_actual - vx_target) ** 2) / 0.05)) * float(
                r.get("velocity_track_weight", 0.0)
            )
        if "target_velocity_y_m_s" in r and self._init_torso_xy is not None:
            elapsed = self._step_count * self.config.control_dt + 1e-6
            vy_actual = (pos[1] - self._init_torso_xy[1]) / elapsed
            vy_target = float(r["target_velocity_y_m_s"])
            reward += float(np.exp(-((vy_actual - vy_target) ** 2) / 0.05)) * float(
                r.get("velocity_track_weight", 0.0)
            )

        # Yaw-rate tracking.
        if "target_yaw_rate_rad_s" in r and self._init_yaw is not None:
            elapsed = self._step_count * self.config.control_dt + 1e-6
            yaw_rate = _wrap_pi(yaw - self._init_yaw) / elapsed
            yaw_target = float(r["target_yaw_rate_rad_s"])
            reward += float(np.exp(-((yaw_rate - yaw_target) ** 2) / 1.0)) * float(
                r.get("yaw_track_weight", 0.0)
            )

        # Head-tilt tracking.
        if "head_tilt_target_rad" in r:
            tilt = float(env.data.qpos[env._act_qpos_idx[env._act_name_to_idx.get("head_tilt", 13)]])
            tilt_target = float(r["head_tilt_target_rad"])
            reward += float(np.exp(-((tilt - tilt_target) ** 2) / 0.05)) * float(
                r.get("head_track_weight", 0.0)
            )

        # Action-rate penalty.
        if "action_rate_weight" in r:
            reward += float(r["action_rate_weight"]) * float(np.mean(action**2))

        return reward


def _pad_or_trim(arr: np.ndarray, dim: int) -> np.ndarray:
    if arr.shape[0] == dim:
        return arr
    if arr.shape[0] > dim:
        return arr[:dim]
    return np.concatenate([arr, np.zeros(dim - arr.shape[0], dtype=arr.dtype)])


def _wrap_pi(angle: float) -> float:
    import math

    return math.atan2(math.sin(angle), math.cos(angle))
