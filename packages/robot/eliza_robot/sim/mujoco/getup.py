"""GetUp (fall recovery) environment for AiNex.

Recover from a fall and stand up. Follows the Go1 getup pattern from
mujoco_playground which trains successfully with PPO.

Observation space:
    - Gyroscope readings (3)
    - Gravity vector (3)
    - Joint angles relative to home (24)
    - Joint velocities (24)
    - Last action (24)

Action space: Joint position offsets (24) scaled by a factor and added
to the CURRENT joint angles (not the home pose). This gives the policy
a wider initial range of motion from any fallen configuration.

Reward function:
    - Orientation: torso should be upright (dense, always active)
    - Torso height: torso at desired standing height (dense, always active)
    - Posture: joints near home pose (gated on upright)
    - Stand still: zero actions once standing (gated on upright + at height)
    - Small penalties for torques, action rate, joint limits

Usage:
    from eliza_robot.sim.mujoco.getup import GetUp, default_config
    env = GetUp()
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
from mujoco import mjx
import numpy as np

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import base_env as ainex_base
from eliza_robot.sim.mujoco import ainex_constants as consts


def default_config() -> config_dict.ConfigDict:
    """Default configuration for AiNex getup training."""
    return config_dict.create(
        ctrl_dt=0.02,
        sim_dt=0.004,
        episode_length=150,         # Shorter — penalize slow recovery
        Kp=200.0,
        Kd=5.0,
        early_termination=False,
        action_repeat=1,
        action_scale=0.5,
        obs_noise=0.05,
        obs_history_size=1,
        max_foot_height=0.07,
        # GetUp-specific
        drop_from_height_prob=0.9,  # 90% fallen — force recovery, less free reward
        settle_time=0.5,
        soft_joint_pos_limit_factor=0.95,
        noise_config=config_dict.create(
            level=1.0,
            scales=config_dict.create(
                joint_pos=0.03,
                joint_vel=1.5,
                gyro=0.2,
                gravity=0.05,
            ),
        ),
        reward_config=config_dict.create(
            scales=config_dict.create(
                orientation=1.0,
                torso_height=5.0,
                height_bonus=3.0,       # Intermediate height thresholds
                posture_proximity=2.0,  # Ungated pose tracking (bridges the gap)
                posture=2.0,            # Gated on upright (increased)
                stand_still=2.0,        # Gated on upright+height (increased)
                action_rate=-0.001,
                dof_pos_limits=-0.1,
                torques=-1e-5,
                dof_acc=-2.5e-7,
                dof_vel=-0.1,
            ),
        ),
        enable_entity_slots=False,
    )


class GetUp(ainex_base.AiNexEnv):
    """Recover from a fall and stand up.

    All 24 DOFs are controlled by the RL policy — arms are essential for
    pushing off the ground during recovery. Actions are added to the
    CURRENT joint configuration (not the home pose) for wider exploration.
    """

    def __init__(
        self,
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config=config, config_overrides=config_overrides)
        self._init_robot()

        # Soft joint limits for reward penalty
        self._soft_lowers = np.array(self._mj_model.actuator_ctrlrange[:, 0])
        self._soft_uppers = np.array(self._mj_model.actuator_ctrlrange[:, 1])
        c = (self._soft_lowers + self._soft_uppers) / 2
        r = self._soft_uppers - self._soft_lowers
        self._soft_lowers = jp.array(
            c - 0.5 * r * self._config.soft_joint_pos_limit_factor
        )
        self._soft_uppers = jp.array(
            c + 0.5 * r * self._config.soft_joint_pos_limit_factor
        )

        # Settle steps: let robot physically fall and rest before policy takes over
        self._settle_steps = int(self._config.settle_time / self._config.sim_dt)

        # Standing height target (from stand_bent_knees keyframe z=0.196)
        self._z_des = 0.19

        # Upright direction: AiNex framezaxis returns [0,0,1] when upright
        self._up_vec = jp.array([0.0, 0.0, 1.0])

    @property
    def action_size(self) -> int:
        """All 24 DOFs controlled by policy."""
        return consts.NUM_ACTUATORS

    def _get_random_qpos(self, rng: jax.Array) -> jax.Array:
        """Generate random initial configuration: dropped from 0.5m
        with random orientation and random joint angles."""
        rng, orientation_rng, qpos_rng = jax.random.split(rng, 3)

        qpos = jp.zeros(self.mjx_model.nq)

        # Root position: 0.5m height
        qpos = qpos.at[2].set(0.5)

        # Random orientation (uniform on SO(3))
        quat = jax.random.normal(orientation_rng, (4,))
        quat = quat / (jp.linalg.norm(quat) + 1e-6)
        qpos = qpos.at[3:7].set(quat)

        # Random joint angles within actuator limits
        qpos = qpos.at[7:].set(
            jax.random.uniform(
                qpos_rng, (self.action_size,),
                minval=self._lowers, maxval=self._uppers,
            )
        )

        return qpos

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, key1, key2, key3 = jax.random.split(rng, 4)

        # 60% random drop, 40% home pose
        qpos = jp.where(
            jax.random.bernoulli(key1, self._config.drop_from_height_prob),
            self._get_random_qpos(key2),
            self._init_q,
        )

        # Random root velocity for diversity
        qvel = jp.zeros(self.mjx_model.nv)
        qvel = qvel.at[0:6].set(
            jax.random.uniform(key3, (6,), minval=-0.5, maxval=0.5)
        )

        data = mjx_env.make_data(
            self.mj_model,
            qpos=qpos,
            qvel=qvel,
        )
        data = mjx.forward(self.mjx_model, data)

        # Let robot settle — run uncontrolled physics so it comes to rest
        data = mjx_env.step(
            self.mjx_model, data, qpos[7:], self._settle_steps
        )

        info = {
            "rng": rng,
            "last_act": jp.zeros(self.action_size),
            "last_last_act": jp.zeros(self.action_size),
        }

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())

        obs = self._get_obs(data, info)
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        # Action added to CURRENT joint angles (not default pose)
        # This gives wider exploration from any fallen configuration
        motor_targets = state.data.qpos[7:] + action * self._config.action_scale
        motor_targets = jp.clip(motor_targets, self._lowers, self._uppers)

        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        obs = self._get_obs(data, state.info)
        done = jp.float32(0.0)  # No early termination for getup

        rewards = self._get_reward(data, action, state.info)
        rewards = {
            k: jp.nan_to_num(v * self._config.reward_config.scales[k], nan=0.0)
            for k, v in rewards.items()
        }
        reward = jp.clip(jp.nan_to_num(sum(rewards.values()) * self.dt, nan=0.0), 0.0, 10000.0)

        # Bookkeeping
        state.info["last_last_act"] = state.info["last_act"]
        state.info["last_act"] = action
        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v

        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # ---- Observation ----

    @property
    def _single_obs_size(self) -> int:
        """gyro(3) + gravity(3) + joint_pos(24) + joint_vel(24) + last_act(24) = 78"""
        return 3 + 3 + self.action_size * 3

    def _get_obs(
        self,
        data: mjx.Data,
        info: dict[str, Any],
    ) -> jax.Array:
        gyro = self.get_gyro(data)
        gravity = self.get_gravity(data)
        joint_angles = data.qpos[7:]
        joint_vel = data.qvel[6:]

        # Per-channel noise (matching Go1 pattern)
        info["rng"], rng1, rng2, rng3, rng4 = jax.random.split(info["rng"], 5)
        noise_level = self._config.noise_config.level

        noisy_gyro = gyro + (
            (2 * jax.random.uniform(rng1, shape=gyro.shape) - 1)
            * noise_level * self._config.noise_config.scales.gyro
        )
        noisy_gravity = gravity + (
            (2 * jax.random.uniform(rng2, shape=gravity.shape) - 1)
            * noise_level * self._config.noise_config.scales.gravity
        )
        noisy_joint_pos = (joint_angles - self._default_pose) + (
            (2 * jax.random.uniform(rng3, shape=joint_angles.shape) - 1)
            * noise_level * self._config.noise_config.scales.joint_pos
        )
        noisy_joint_vel = joint_vel + (
            (2 * jax.random.uniform(rng4, shape=joint_vel.shape) - 1)
            * noise_level * self._config.noise_config.scales.joint_vel
        )

        obs = jp.concatenate([
            noisy_gyro,          # 3
            noisy_gravity,       # 3
            noisy_joint_pos,     # 24
            noisy_joint_vel,     # 24 (raw, no 0.05 scaling)
            info["last_act"],    # 24
        ])  # total = 78
        return jp.nan_to_num(jp.clip(obs, -100.0, 100.0), nan=0.0)

    # ---- Reward ----

    def _get_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
    ) -> dict[str, jax.Array]:
        torso_z = data.xpos[self._torso_body_id, 2]
        joint_angles = data.qpos[7:]
        joint_torques = data.actuator_force
        gravity = self.get_gravity(data)

        is_upright = self._is_upright(gravity)
        is_at_desired_height = self._is_at_desired_height(torso_z)
        gate = is_upright * is_at_desired_height

        # Intermediate height bonuses — bridge the gap from crouch to standing
        height_bonus = (
            jp.float32(torso_z > 0.10) +
            jp.float32(torso_z > 0.13) +
            jp.float32(torso_z > 0.16)
        ) / 3.0

        # Ungated posture proximity — always gives some signal for
        # moving joints toward home pose, proportional to uprightness
        uprightness = jp.clip((gravity[2] + 1.0) * 0.5, 0.0, 1.0)  # [0,1]
        pose_error = jp.sum(jp.square(joint_angles - self._default_pose))
        posture_proximity = uprightness * jp.exp(-0.5 * pose_error)

        return {
            "orientation": self._reward_orientation(gravity),
            "torso_height": self._reward_height(torso_z),
            "height_bonus": height_bonus,
            "posture_proximity": posture_proximity,
            "posture": self._reward_posture(joint_angles, is_upright),
            "stand_still": self._reward_stand_still(action, gate),
            "action_rate": self._cost_action_rate(action, info),
            "dof_pos_limits": self._cost_joint_pos_limits(joint_angles),
            "torques": self._cost_torques(joint_torques),
            "dof_acc": self._cost_dof_acc(data.qacc[6:]),
            "dof_vel": self._cost_dof_vel(data.qvel[6:]),
        }

    def _is_upright(self, gravity: jax.Array, tol: float = 0.03) -> jax.Array:
        error = jp.sum(jp.square(self._up_vec - gravity))
        return jp.float32(error < tol)

    def _is_at_desired_height(self, torso_z: jax.Array, tol: float = 0.02) -> jax.Array:
        height = jp.minimum(torso_z, self._z_des)
        error = self._z_des - height
        return jp.float32(error < tol)

    def _reward_orientation(self, gravity: jax.Array) -> jax.Array:
        error = jp.sum(jp.square(self._up_vec - gravity))
        return jp.exp(-2.0 * error)

    def _reward_height(self, torso_z: jax.Array) -> jax.Array:
        # Linear: 0 at ground, 1 at z_des. Clear gradient to stand tall.
        # (exp(-5*err²) was too flat: 0.94 at z=0.08 vs 1.0 at z=0.19)
        return jp.clip(torso_z / self._z_des, 0.0, 1.0)

    def _reward_posture(self, joint_angles: jax.Array, gate: jax.Array) -> jax.Array:
        cost = jp.sum(jp.square(joint_angles - self._default_pose))
        return gate * jp.exp(-0.5 * cost)

    def _reward_stand_still(self, action: jax.Array, gate: jax.Array) -> jax.Array:
        cost = jp.sum(jp.square(action))
        return gate * jp.exp(-0.5 * cost)

    def _cost_action_rate(self, action: jax.Array, info: dict[str, Any]) -> jax.Array:
        c1 = jp.sum(jp.square(action - info["last_act"]))
        c2 = jp.sum(jp.square(action - 2 * info["last_act"] + info["last_last_act"]))
        return c1 + c2

    def _cost_joint_pos_limits(self, qpos: jax.Array) -> jax.Array:
        out_of_limits = -jp.clip(qpos - self._soft_lowers, None, 0.0)
        out_of_limits += jp.clip(qpos - self._soft_uppers, 0.0, None)
        return jp.sum(out_of_limits)

    def _cost_torques(self, torques: jax.Array) -> jax.Array:
        return jp.sqrt(jp.sum(jp.square(torques))) + jp.sum(jp.abs(torques))

    def _cost_dof_vel(self, qvel: jax.Array) -> jax.Array:
        max_velocity = 2.0 * jp.pi  # rad/s
        cost = jp.maximum(jp.abs(qvel) - max_velocity, 0.0)
        return jp.sum(jp.square(cost))

    def _cost_dof_acc(self, qacc: jax.Array) -> jax.Array:
        return jp.sum(jp.square(qacc))
