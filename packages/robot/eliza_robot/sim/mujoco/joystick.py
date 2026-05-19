"""Joystick locomotion environment for AiNex.

Tracks velocity commands (forward, lateral, yaw) for bipedal locomotion.
Uses 12 leg DOFs controlled by the RL policy; head and arm actuators
are held at the default pose.

Reward configuration aligned with MuJoCo Playground OP3 reference
(DeepMind, 2025) with Bezier foot-height gait phase tracking from
the Berkeley Humanoid / H1 implementations.

Usage:
    from eliza_robot.sim.mujoco.joystick import Joystick, default_config
    env = Joystick()
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
from mujoco import mjx

from mujoco_playground._src import gait as playground_gait
from mujoco_playground._src import mjx_env
from eliza_robot.perception.entity_slots.sim_provider import empty_entity_slots, sim_entity_slots_jax
from eliza_robot.perception.entity_slots.slot_noise import apply_entity_slot_noise
from eliza_robot.sim.mujoco import base_env as ainex_base
from eliza_robot.sim.mujoco import ainex_constants as consts


def default_config() -> config_dict.ConfigDict:
    """Default configuration for AiNex joystick locomotion.

    Reward scales follow the MuJoCo Playground OP3 reference:
      tracking_lin_vel=1.5, tracking_ang_vel=0.8, orientation=-5.0
    with Bezier foot-height gait phase from Berkeley Humanoid (feet_phase=1.0).
    Kp/Kd and action_scale matched to OP3 (small servo humanoid).
    """
    return config_dict.create(
        ctrl_dt=0.02,
        sim_dt=0.004,
        episode_length=1000,
        # PD gains: v23's proven values for AiNex actuator model
        Kp=200.0,
        Kd=5.0,
        early_termination=True,
        action_repeat=1,
        action_scale=0.6,           # v23 used 0.8, dial back slightly for stability
        obs_noise=0.05,
        obs_history_size=3,
        # Gait phase: Bezier foot height tracking (Berkeley Humanoid pattern)
        gait_freq_range=[1.25, 1.75],  # Hz, randomized per episode
        max_foot_height=0.07,          # Swing height for Bezier trajectory
        # Velocity command ranges
        lin_vel_x=[-0.3, 0.8],     # v23's proven range (conservative for AiNex size)
        lin_vel_y=[-0.3, 0.3],
        ang_vel_yaw=[-0.5, 0.5],
        reward_config=config_dict.create(
            scales=config_dict.create(
                # v23-level tracking (proven to produce forward motion)
                # + Bezier gait phase (from v26, proven to produce stepping)
                tracking_lin_vel=10.0,  # v23 used 15 — dial back for gait phase balance
                tracking_ang_vel=6.0,
                lin_vel_z=-2.0,
                ang_vel_xy=-0.05,
                orientation=-1.5,       # Slightly stronger than v23's -1.0
                torques=-0.0001,
                action_rate=-0.01,
                zero_cmd=-0.5,
                termination=-1.0,
                feet_slip=-0.1,
                energy=-0.00005,
                # Bezier foot height gait phase — gentle guide, not dominant
                feet_phase=0.5,         # v26 used 1.0, reduce to not compete with tracking
            ),
            tracking_sigma=0.25,
        ),
        velocity_kick=[1.0, 5.0],
        kick_durations=[0.05, 0.2],
        kick_wait_times=[1.0, 3.0],
        enable_entity_slots=False,
    )


class Joystick(ainex_base.AiNexEnv):
    """Track joystick velocity commands for bipedal locomotion.

    Only the 12 leg DOFs are controlled by the RL policy.
    Head (2) and arm (10) actuators are held at default pose.
    """

    NUM_LEG_ACTUATORS = consts.NUM_LEG_ACTUATORS  # 12

    def __init__(
        self,
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config=config, config_overrides=config_overrides)
        self._init_robot()
        if self._config.enable_entity_slots:
            self._init_entities()

    @property
    def action_size(self) -> int:
        """Only leg actuators are controlled by the policy."""
        return self.NUM_LEG_ACTUATORS

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, cmd_rng, noise_rng, entity_rng, freq_rng = jax.random.split(rng, 5)

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )
        data = mjx.forward(self.mjx_model, data)

        # Gait phase: bipedal = [0, pi] (left and right offset by half cycle)
        # Frequency randomized per episode (Berkeley Humanoid pattern)
        gait_freq = jax.random.uniform(
            freq_rng, (1,),
            minval=self._config.gait_freq_range[0],
            maxval=self._config.gait_freq_range[1],
        )
        phase_dt = 2 * jp.pi * self.dt * gait_freq
        phase = jp.array([0.0, jp.pi])  # Left foot, Right foot

        info = {
            "rng": rng,
            "last_act": jp.zeros(self.NUM_LEG_ACTUATORS),
            "last_last_act": jp.zeros(self.NUM_LEG_ACTUATORS),
            "last_vel": jp.zeros(self.mjx_model.nv - 6),
            "command": self.sample_command(cmd_rng),
            "step": 0,
            "motor_targets": jp.zeros(self.mjx_model.nu),
            "phase": phase,
            "phase_dt": phase_dt,
        }

        if self._config.enable_entity_slots:
            scene_rng, slot_rng = jax.random.split(entity_rng)
            scene = self.sample_entity_scene(scene_rng, data.qpos[:2])
            info["entity_positions"] = scene["entity_positions"]
            info["entity_types"] = scene["entity_types"]
            info["entity_sizes"] = scene["entity_sizes"]
            info["entity_mask"] = scene["entity_mask"]

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())

        obs_history = jp.zeros(self._config.obs_history_size * self._single_obs_size)
        obs = self._get_obs(data, info, obs_history, noise_rng)
        if self._config.enable_entity_slots:
            obs = jp.concatenate([obs, self._compute_entity_slots(data, info, slot_rng)])
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        rng, cmd_rng, noise_rng, entity_rng = jax.random.split(state.info["rng"], 4)

        # Only first 12 actuators (legs) are controlled by policy
        # Head/arm actuators held at default pose
        leg_targets = (
            self._default_pose[:self.NUM_LEG_ACTUATORS]
            + action * self._config.action_scale
        )
        full_targets = jp.concatenate([
            leg_targets, self._default_pose[self.NUM_LEG_ACTUATORS:]
        ])
        motor_targets = jp.clip(full_targets, self._lowers, self._uppers)
        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        obs_history = (
            state.obs[:self._config.obs_history_size * self._single_obs_size]
            if self._config.enable_entity_slots
            else state.obs
        )
        obs = self._get_obs(data, state.info, obs_history, noise_rng)
        if self._config.enable_entity_slots:
            obs = jp.concatenate([obs, self._compute_entity_slots(data, state.info, entity_rng)])
        done = self.get_termination(data)

        rewards = self._get_reward(data, action, state.info, done)
        rewards = {
            k: v * self._config.reward_config.scales[k] for k, v in rewards.items()
        }
        reward = jp.clip(sum(rewards.values()) * self.dt, 0.0, 10000.0)

        # Bookkeeping
        state.info["motor_targets"] = motor_targets
        state.info["last_last_act"] = state.info["last_act"]
        state.info["last_act"] = action
        state.info["last_vel"] = data.qvel[6:]
        state.info["step"] += 1
        state.info["rng"] = rng

        # Advance gait phase (Berkeley Humanoid pattern: fmod wrap to [-pi, pi])
        phase_tp1 = state.info["phase"] + state.info["phase_dt"]
        state.info["phase"] = jp.fmod(phase_tp1 + jp.pi, 2 * jp.pi) - jp.pi

        # Resample command every 500 steps
        state.info["command"] = jp.where(
            state.info["step"] > 500,
            self.sample_command(cmd_rng),
            state.info["command"],
        )
        state.info["step"] = jp.where(
            done | (state.info["step"] > 500),
            0,
            state.info["step"],
        )

        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # ---- Observation ----

    @property
    def _single_obs_size(self) -> int:
        """gyro(3) + gravity(3) + command(3) + phase(4) + leg_pos(12) + leg_vel(12) + last_act(12) = 49"""
        return 3 + 3 + 3 + 4 + self.NUM_LEG_ACTUATORS * 3

    def _compute_entity_slots(self, data: mjx.Data, info: dict[str, Any], rng: jax.Array) -> jax.Array:
        """Compute entity slots from randomized scene with DR noise."""
        robot_pos = data.qpos[:3]
        robot_yaw = self.get_yaw(data)
        slots = sim_entity_slots_jax(
            robot_pos, robot_yaw,
            info["entity_positions"],
            info["entity_types"],
            info["entity_sizes"],
            entity_mask=info["entity_mask"],
        )
        return apply_entity_slot_noise(slots, rng)

    def _get_obs(
        self,
        data: mjx.Data,
        info: dict[str, Any],
        obs_history: jax.Array,
        rng: jax.Array,
    ) -> jax.Array:
        n_legs = self.NUM_LEG_ACTUATORS
        phase = info["phase"]  # (2,) — left foot, right foot
        obs = jp.concatenate([
            self.get_gyro(data),                                    # 3
            self.get_gravity(data),                                 # 3
            info["command"],                                        # 3
            jp.cos(phase),                                          # 2 (phase cos for L, R)
            jp.sin(phase),                                          # 2 (phase sin for L, R)
            data.qpos[7:7+n_legs] - self._default_pose[:n_legs],   # 12
            data.qvel[6:6+n_legs] * 0.05,                          # 12 (scaled joint velocities)
            info["last_act"],                                       # 12
        ])  # total = 49

        obs = self.apply_obs_noise(obs, rng)
        return self.stack_obs_history(obs, obs_history)

    # ---- Reward ----

    def _get_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
        done: jax.Array,
    ) -> dict[str, jax.Array]:
        return {
            "tracking_lin_vel": self._reward_tracking_lin_vel(
                info["command"], self.get_local_linvel(data)
            ),
            "tracking_ang_vel": self._reward_tracking_ang_vel(
                info["command"], self.get_gyro(data)
            ),
            "lin_vel_z": self.cost_lin_vel_z(data),
            "ang_vel_xy": self.cost_ang_vel_xy(data),
            "orientation": self.cost_orientation(data),
            "torques": self.cost_torques(data),
            "action_rate": self.cost_action_rate(
                action, info["last_act"], info["last_last_act"]
            ),
            "zero_cmd": self._cost_zero_cmd(info["command"], action),
            "termination": self.cost_termination(done, info["step"]),
            "feet_slip": self.cost_feet_slip(data),
            "energy": self.cost_energy(data),
            "feet_phase": self._reward_feet_phase(
                data, info["phase"], info["command"]
            ),
        }

    def _reward_tracking_lin_vel(
        self, commands: jax.Array, local_vel: jax.Array
    ) -> jax.Array:
        lin_vel_error = jp.sum(jp.square(commands[:2] - local_vel[:2]))
        return jp.exp(-lin_vel_error / self._config.reward_config.tracking_sigma)

    def _reward_tracking_ang_vel(
        self, commands: jax.Array, ang_vel: jax.Array
    ) -> jax.Array:
        ang_vel_error = jp.square(commands[2] - ang_vel[2])
        return jp.exp(-ang_vel_error / self._config.reward_config.tracking_sigma)

    def _reward_feet_phase(
        self, data: mjx.Data, phase: jax.Array, commands: jax.Array
    ) -> jax.Array:
        """Bezier foot height tracking reward (Berkeley Humanoid pattern).

        Uses playground_gait.get_rz() to compute desired foot height from
        phase, then rewards matching actual foot z to desired trajectory.
        """
        foot_pos = data.site_xpos[self._feet_site_id]
        foot_z = foot_pos[..., -1]  # (2,) — left, right foot heights
        rz = playground_gait.get_rz(
            phase, swing_height=self._config.max_foot_height
        )  # (2,) — desired heights from Bezier curve
        error = jp.sum(jp.square(foot_z - rz))
        return jp.exp(-error / 0.01)

    def _cost_zero_cmd(
        self, commands: jax.Array, action: jax.Array
    ) -> jax.Array:
        cmd_norm = jp.linalg.norm(commands)
        penalty = jp.sum(jp.square(action))
        return penalty * (cmd_norm < 0.1)

    def sample_command(self, rng: jax.Array) -> jax.Array:
        """Sample random velocity command (10% chance of zero)."""
        _, rng1, rng2, rng3, rng4 = jax.random.split(rng, 5)

        lin_vel_x = jax.random.uniform(
            rng1, minval=self._config.lin_vel_x[0], maxval=self._config.lin_vel_x[1]
        )
        lin_vel_y = jax.random.uniform(
            rng2, minval=self._config.lin_vel_y[0], maxval=self._config.lin_vel_y[1]
        )
        ang_vel_yaw = jax.random.uniform(
            rng3, minval=self._config.ang_vel_yaw[0], maxval=self._config.ang_vel_yaw[1]
        )

        cmd = jp.hstack([lin_vel_x, lin_vel_y, ang_vel_yaw])
        return jp.where(jax.random.bernoulli(rng4, 0.1), jp.zeros(3), cmd)
