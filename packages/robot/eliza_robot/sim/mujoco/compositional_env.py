"""Compositional environment: frozen walking policy + trainable upper body.

Runs the trained walking policy (v13) inside the environment's step() to
control the 12 leg joints while training a separate policy for the 12
upper-body joints (10 arms + 2 head). The walking policy is frozen — no
gradients flow through it — ensuring the legs walk stably while the arms
learn new skills.

Architecture:
    PPO trains upper body policy:
        action (12-dim) → arms + head targets
    env.step() internally:
        1. Build walking obs from current state
        2. Run frozen walking policy → leg targets (12-dim)
        3. Combine: full_targets = concat(leg_targets, upper_targets)
        4. Step physics with 24-dim motor targets

Usage:
    from eliza_robot.sim.mujoco.compositional_env import CompositionalEnv
    env = CompositionalEnv(walking_checkpoint="checkpoints/mujoco_locomotion_v13_flat_feet")
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
from mujoco import mjx

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import ainex_constants as consts
from eliza_robot.sim.mujoco import base_env as ainex_base


# Walking policy obs layout (from joystick.py):
# gyro(3) + gravity(3) + command(3) + leg_pos(12) + leg_vel(12) + last_act(12) = 45
WALK_SINGLE_OBS_DIM = 45
WALK_OBS_HISTORY_SIZE = 3
WALK_TOTAL_OBS_DIM = WALK_SINGLE_OBS_DIM * WALK_OBS_HISTORY_SIZE  # 135
WALK_ACTION_SCALE = 0.3

NUM_LEG_JOINTS = consts.NUM_LEG_ACTUATORS  # 12
NUM_UPPER_JOINTS = consts.NUM_HEAD_ACTUATORS + consts.NUM_ARM_ACTUATORS  # 12


def default_config() -> config_dict.ConfigDict:
    """Default configuration for compositional environment."""
    return config_dict.create(
        ctrl_dt=0.02,       # 50 Hz control
        sim_dt=0.004,       # 250 Hz physics
        episode_length=1000,
        Kp=21.1,
        Kd=1.084,
        early_termination=True,
        action_repeat=1,
        action_scale=0.3,   # Upper body action scale (subclasses may increase)
        obs_noise=0.05,
        obs_history_size=3,
        max_foot_height=0.07,
        # Walking command (frozen policy receives this)
        walk_command=[0.3, 0.0, 0.0],  # [vx, vy, vyaw]
        # Reward config for upper body training
        reward_config=config_dict.create(
            scales=config_dict.create(
                # Walking stability (keep the robot balanced)
                alive=0.5,
                lin_vel_z=-2.0,
                ang_vel_xy=-0.05,
                orientation=-5.0,
                torques=-0.0001,
                action_rate=-0.01,
                termination=-1.0,
                feet_slip=-0.1,
                feet_orientation=-2.0,
                energy=-0.00005,
                # Upper body smoothness
                upper_action_rate=-0.05,
            ),
        ),
        velocity_kick=[1.0, 5.0],
        kick_durations=[0.05, 0.2],
        kick_wait_times=[1.0, 3.0],
        enable_entity_slots=False,
    )


class CompositionalEnv(ainex_base.AiNexEnv):
    """Environment with frozen walking policy for legs, trainable upper body.

    The PPO policy trained with this env only controls the upper body
    (10 arm + 2 head = 12 DOFs). The legs are driven by a frozen walking
    policy loaded from a checkpoint.

    Subclasses should override:
        - _single_upper_obs_size: property returning single-frame obs dim
        - _get_upper_obs(): build task-specific upper body observation
        - _get_upper_reward(): compute task-specific rewards (added to stability rewards)
    """

    def __init__(
        self,
        walking_checkpoint: str = "checkpoints/mujoco_locomotion_v13_flat_feet",
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config=config, config_overrides=config_overrides)
        self._init_robot()

        # Load frozen walking policy
        self._walking_policy_fn = None
        self._walking_checkpoint = walking_checkpoint
        self._load_walking_policy(walking_checkpoint)

        # Walking command
        self._walk_command = jp.array(config.walk_command, dtype=jp.float32)

    def _load_walking_policy(self, checkpoint: str) -> None:
        """Load the frozen walking policy as a JAX function."""
        from eliza_robot.sim.mujoco.inference import load_policy_jax
        policy_fn, walk_config, _ = load_policy_jax(checkpoint)
        self._walking_policy_fn = policy_fn

    @property
    def action_size(self) -> int:
        """Only upper body joints are controlled by the trainable policy."""
        return NUM_UPPER_JOINTS  # 12

    @property
    def _single_obs_size(self) -> int:
        """Single-frame observation size for upper body policy.

        Base: gyro(3) + gravity(3) + upper_pos(12) + upper_vel(12) + last_upper_act(12) = 42
        Subclasses add task-specific obs via _single_upper_obs_size.
        """
        return 3 + 3 + NUM_UPPER_JOINTS * 3 + self._single_task_obs_size

    @property
    def _single_task_obs_size(self) -> int:
        """Override in subclasses to add task-specific observations."""
        return 0

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, noise_rng = jax.random.split(rng)

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )
        data = mjx.forward(self.mjx_model, data)

        info = {
            "rng": rng,
            # Upper body tracking
            "last_upper_act": jp.zeros(NUM_UPPER_JOINTS),
            "last_last_upper_act": jp.zeros(NUM_UPPER_JOINTS),
            # Walking policy state
            "walk_obs_history": jp.zeros(WALK_TOTAL_OBS_DIM),
            "walk_last_act": jp.zeros(NUM_LEG_JOINTS),
            "walk_last_last_act": jp.zeros(NUM_LEG_JOINTS),
            "walk_command": self._walk_command,
            # Motor targets (full 24-dim)
            "motor_targets": jp.zeros(self.mjx_model.nu),
            "step": 0,
        }

        # Allow subclasses to add task-specific info
        info = self._reset_task_info(info, rng, data)

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())

        obs_history = jp.zeros(self._config.obs_history_size * self._single_obs_size)
        obs = self._get_obs(data, info, obs_history, noise_rng)
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        rng, walk_rng, noise_rng = jax.random.split(state.info["rng"], 3)

        # 1. Build walking obs from current state
        walk_obs = self._build_walk_obs(state.data, state.info)
        walk_obs_full = self.stack_obs_history(
            walk_obs, state.info["walk_obs_history"]
        )

        # 2. Run frozen walking policy → leg action
        # Add batch dim for brax network (expects [batch, obs_dim])
        walk_obs_batched = walk_obs_full[None, :]
        walk_action, _ = self._walking_policy_fn(walk_obs_batched, walk_rng)
        walk_action = walk_action.squeeze(0)
        walk_action = jp.clip(walk_action, -1.0, 1.0)

        # 3. Compute motor targets
        # Legs: from frozen walking policy
        leg_targets = (
            self._default_pose[:NUM_LEG_JOINTS]
            + walk_action[:NUM_LEG_JOINTS] * WALK_ACTION_SCALE
        )
        # Upper body: from trainable policy action
        upper_targets = (
            self._default_pose[NUM_LEG_JOINTS:]
            + action * self._config.action_scale
        )
        full_targets = jp.concatenate([leg_targets, upper_targets])
        motor_targets = jp.clip(full_targets, self._lowers, self._uppers)

        # 4. Step physics
        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        # Termination
        done = self.get_termination(data)

        # Rewards: stability + task-specific
        rewards = self._get_reward(data, action, state.info, done)
        rewards = {
            k: v * self._config.reward_config.scales[k] for k, v in rewards.items()
        }
        reward = jp.clip(sum(rewards.values()) * self.dt, -10.0, 10000.0)

        # Update info in-place (preserves AutoResetWrapper keys)
        state.info["rng"] = rng
        state.info["last_last_upper_act"] = state.info["last_upper_act"]
        state.info["last_upper_act"] = action
        state.info["walk_obs_history"] = walk_obs_full
        state.info["walk_last_last_act"] = state.info["walk_last_act"]
        state.info["walk_last_act"] = walk_action[:NUM_LEG_JOINTS]
        state.info["motor_targets"] = motor_targets
        state.info["step"] = state.info["step"] + 1
        self._step_task_info_inplace(state.info, data, action)

        # Build observation
        obs = self._get_obs(data, state.info, state.obs, noise_rng)

        # Update metrics in-place (preserves wrapper-added keys)
        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    def _build_walk_obs(self, data: mjx.Data, info: dict) -> jax.Array:
        """Build 45-dim walking obs matching joystick.py layout."""
        gyro = self.get_gyro(data)
        gravity = self.get_gravity(data)

        leg_pos = data.qpos[7:7 + NUM_LEG_JOINTS] - self._default_pose[:NUM_LEG_JOINTS]
        leg_vel = data.qvel[6:6 + NUM_LEG_JOINTS] * 0.05

        return jp.concatenate([
            gyro,                       # 3
            gravity,                    # 3
            info["walk_command"],       # 3
            leg_pos,                    # 12
            leg_vel,                    # 12
            info["walk_last_act"],      # 12
        ])  # total = 45

    def _get_obs(
        self,
        data: mjx.Data,
        info: dict[str, Any],
        obs_history: jax.Array,
        rng: jax.Array,
    ) -> jax.Array:
        """Build upper body observation (for trainable policy)."""
        gyro = self.get_gyro(data)
        gravity = self.get_gravity(data)

        # Upper body joint positions relative to default
        upper_pos = (
            data.qpos[7 + NUM_LEG_JOINTS:]
            - self._default_pose[NUM_LEG_JOINTS:]
        )
        # Upper body joint velocities
        upper_vel = data.qvel[6 + NUM_LEG_JOINTS:] * 0.05

        obs = jp.concatenate([
            gyro,                       # 3
            gravity,                    # 3
            upper_pos,                  # 12
            upper_vel,                  # 12
            info["last_upper_act"],     # 12
            self._get_task_obs(data, info),  # task-specific
        ])  # base = 42 + task

        obs = self.apply_obs_noise(obs, rng)
        return self.stack_obs_history(obs, obs_history)

    def _get_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
        done: jax.Array,
    ) -> dict[str, jax.Array]:
        """Stability rewards + task-specific rewards."""
        rewards = {
            # Walking stability (same as joystick)
            "alive": jp.float32(1.0 - done),
            "lin_vel_z": self.cost_lin_vel_z(data),
            "ang_vel_xy": self.cost_ang_vel_xy(data),
            "orientation": self.cost_orientation(data),
            "torques": self.cost_torques(data),
            "action_rate": self.cost_action_rate(
                info["walk_last_act"],
                info["walk_last_last_act"],
                jp.zeros(NUM_LEG_JOINTS),  # placeholder for 2-step-ago
            ),
            "termination": self.cost_termination(done, info["step"]),
            "feet_slip": self.cost_feet_slip(data),
            "feet_orientation": self.cost_feet_orientation(data),
            "energy": self.cost_energy(data),
            # Upper body smoothness
            "upper_action_rate": jp.sum(jp.square(
                action - info["last_upper_act"]
            )),
        }

        # Add task-specific rewards
        task_rewards = self._get_task_reward(data, action, info, done)
        rewards.update(task_rewards)
        return rewards

    # ---- Hooks for subclasses ----

    def _reset_task_info(
        self, info: dict, rng: jax.Array, data: mjx.Data
    ) -> dict:
        """Override to add task-specific info fields on reset."""
        return info

    def _step_task_info_inplace(
        self, info: dict, data: mjx.Data, action: jax.Array
    ) -> None:
        """Override to update task-specific info fields in-place on step."""
        pass

    def _get_task_obs(self, data: mjx.Data, info: dict) -> jax.Array:
        """Override to add task-specific observations. Return empty by default."""
        return jp.array([])

    def _get_task_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
        done: jax.Array,
    ) -> dict[str, jax.Array]:
        """Override to add task-specific rewards. Return empty by default."""
        return {}
