"""Reaching and grasping environment for AiNex.

Robot stands and reaches for a small object on the ground, grasps it with
the right arm, and lifts it. Legs stabilize the body; arms perform the
manipulation. All 24 DOFs are controlled.

Requires ainex_grasp_scene.xml which extends ainex_primitives.xml with a
graspable object body (freejoint), contact pairs, and sensors.

MJX compatible: all reward/obs logic is pure JAX; no Python-side branching
on state values.

Usage:
    from eliza_robot.sim.mujoco.grasp import Grasp, default_config
    env = Grasp()
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
import mujoco
from mujoco import mjx

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import _resolve_mjcf, ainex_constants as consts


# Path to the extended scene XML with graspable object
_GRASP_SCENE_XML = _resolve_mjcf("ainex_grasp_scene.xml")


def default_config() -> config_dict.ConfigDict:
    """Default configuration for AiNex grasp environment."""
    return config_dict.create(
        ctrl_dt=0.02,           # 50 Hz control
        sim_dt=0.004,           # 250 Hz physics
        episode_length=500,
        Kp=200.0,
        Kd=5.0,
        early_termination=True,
        action_repeat=1,
        action_scale_arms=0.3,  # Arm actuators: larger range for reaching
        action_scale_legs=0.1,  # Leg actuators: small for stability only
        obs_noise=0.05,
        obs_history_size=3,
        # Object spawn range (metres, relative to robot)
        object_dist_min=0.2,
        object_dist_max=0.5,
        # Grasp success criteria
        grasp_lift_threshold=0.05,      # metres above ground
        grasp_hold_steps=10,            # consecutive steps holding
        reward_config=config_dict.create(
            scales=config_dict.create(
                # Manipulation rewards
                reach_distance=8.0,         # shaped: closer gripper = better
                grasp_contact=5.0,          # bonus for gripper-object contact
                grasp_hold=20.0,            # bonus for lifting object
                # Stability penalties
                orientation=-5.0,
                termination=-1.0,
                action_rate=-0.01,
                torques=-0.0001,
                energy=-0.00005,
            ),
        ),
    )


class Grasp(mjx_env.MjxEnv):
    """Reach for and grasp a small object on the ground.

    The robot starts standing (bent-knees keyframe). A small cube is placed
    0.2-0.5m in front on the ground. The policy controls all 24 DOFs with
    different action scales for legs (stability) and arms (manipulation).

    Episode succeeds when the object is lifted 0.05m above ground for 10
    consecutive steps.
    """

    def __init__(
        self,
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config, config_overrides)

        # Load grasp scene (extends primitives with object + contacts)
        self._mj_model = mujoco.MjModel.from_xml_path(str(_GRASP_SCENE_XML))
        self._mj_model.opt.timestep = config.sim_dt

        # PD gains: legs get config values, arms keep XML defaults
        n_leg = consts.NUM_LEG_ACTUATORS
        if getattr(config, "Kd", 0) > 0:
            self._mj_model.dof_damping[6:6 + n_leg] = config.Kd
        if getattr(config, "Kp", 0) > 0:
            self._mj_model.actuator_gainprm[:n_leg, 0] = config.Kp
            self._mj_model.actuator_biasprm[:n_leg, 1] = -config.Kp

        self._mj_model.vis.global_.offwidth = 1920
        self._mj_model.vis.global_.offheight = 1080
        self._mjx_model = mjx.put_model(self._mj_model)

        self._init_robot()

    def _init_robot(self) -> None:
        """Initialize robot and object body IDs, sensor addresses."""
        # Standing pose
        self._init_q = jp.array(self._mj_model.keyframe("stand_bent_knees").qpos)
        self._default_pose = self._mj_model.keyframe("stand_bent_knees").qpos[7:]

        # Actuator limits
        self._lowers = self._mj_model.actuator_ctrlrange[:, 0]
        self._uppers = self._mj_model.actuator_ctrlrange[:, 1]

        # Body IDs
        self._torso_body_id = self._mj_model.body(consts.ROOT_BODY).id
        self._object_body_id = self._mj_model.body("grasp_object").id

        # Gripper site/body for distance computation (right gripper)
        self._gripper_body_id = self._mj_model.body("r_gripper_link").id

        # Object joint address in qpos (freejoint = 7 DOFs)
        self._object_jnt_id = self._mj_model.joint("object_joint").id
        self._object_qpos_adr = self._mj_model.jnt_qposadr[self._object_jnt_id]

        # Gravity sensor
        self._gravity_sensor_adr = self._mj_model.sensor("upvector").id

        # Build action scale vector: legs get small scale, arms get larger
        n_leg = consts.NUM_LEG_ACTUATORS
        n_head = consts.NUM_HEAD_ACTUATORS
        n_arm = consts.NUM_ARM_ACTUATORS
        self._action_scale = jp.concatenate([
            jp.full((n_leg,), self._config.action_scale_legs),
            jp.full((n_head,), self._config.action_scale_legs),  # head: stability
            jp.full((n_arm,), self._config.action_scale_arms),   # arms: manipulation
        ])

    # ---- Sensor access ----

    def get_gravity(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GRAVITY_SENSOR)

    def get_gyro(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GYRO_SENSOR)

    def get_yaw(self, data: mjx.Data) -> jax.Array:
        qw, qx, qy, qz = data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]
        return jp.arctan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))

    # ---- Object / gripper state ----

    def _get_object_pos(self, data: mjx.Data) -> jax.Array:
        """Object world position (3,)."""
        return data.xpos[self._object_body_id]

    def _get_gripper_pos(self, data: mjx.Data) -> jax.Array:
        """Right gripper world position (3,)."""
        return data.xpos[self._gripper_body_id]

    def _get_gripper_state(self, data: mjx.Data) -> jax.Array:
        """Gripper joint angle (scalar) — 0=open, positive=closed."""
        # r_gripper is actuator index 18 (after 12 leg + 2 head + 4 arm joints)
        gripper_jnt_id = self._mj_model.joint("r_gripper").id
        gripper_qpos_adr = self._mj_model.jnt_qposadr[gripper_jnt_id]
        return data.qpos[gripper_qpos_adr]

    # ---- Termination ----

    def get_termination(self, data: mjx.Data) -> jax.Array:
        joint_angles = data.qpos[7:7 + consts.NUM_ACTUATORS]
        torso_z = data.xpos[self._torso_body_id, 2]
        fall = self.get_gravity(data)[-1] < 0.85
        fall |= torso_z < 0.12
        return jp.where(self._config.early_termination, fall, jp.bool_(False))

    # ---- Cost functions ----

    def cost_orientation(self, data: mjx.Data) -> jax.Array:
        gravity = self.get_gravity(data)
        return jp.sum(jp.square(gravity[:2]))

    def cost_torques(self, data: mjx.Data) -> jax.Array:
        torques = data.actuator_force
        return jp.sqrt(jp.sum(jp.square(torques))) + jp.sum(jp.abs(torques))

    def cost_energy(self, data: mjx.Data) -> jax.Array:
        qvel = data.qvel[6:]
        qfrc = data.actuator_force
        return jp.sum(jp.abs(qvel[:consts.NUM_ACTUATORS]) * jp.abs(qfrc))

    def cost_action_rate(
        self, act: jax.Array, last_act: jax.Array, last_last_act: jax.Array
    ) -> jax.Array:
        c1 = jp.sum(jp.square(act - last_act))
        c2 = jp.sum(jp.square(act - 2 * last_act + last_last_act))
        return c1 + c2

    def cost_termination(self, done: jax.Array, step: jax.Array) -> jax.Array:
        return done & (step < 500)

    # ---- Environment interface ----

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, obj_rng, noise_rng = jax.random.split(rng, 3)

        # Robot init
        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )

        # Randomize object position in front of robot
        rng1, rng2 = jax.random.split(obj_rng)
        obj_dist = jax.random.uniform(
            rng1,
            minval=self._config.object_dist_min,
            maxval=self._config.object_dist_max,
        )
        obj_angle = jax.random.uniform(rng2, minval=-0.5, maxval=0.5)  # radians

        robot_xy = data.qpos[:2]
        robot_yaw = jp.float32(0.0)  # Robot starts facing +x
        obj_x = robot_xy[0] + obj_dist * jp.cos(robot_yaw + obj_angle)
        obj_y = robot_xy[1] + obj_dist * jp.sin(robot_yaw + obj_angle)
        obj_z = jp.float32(0.03)  # Half-size of cube, resting on floor

        # Set object qpos (pos + quat)
        obj_adr = self._object_qpos_adr
        new_qpos = data.qpos.at[obj_adr:obj_adr + 3].set(
            jp.array([obj_x, obj_y, obj_z])
        )
        new_qpos = new_qpos.at[obj_adr + 3:obj_adr + 7].set(
            jp.array([1.0, 0.0, 0.0, 0.0])
        )
        data = data.replace(qpos=new_qpos)
        data = mjx.forward(self.mjx_model, data)

        info = {
            "rng": rng,
            "last_act": jp.zeros(consts.NUM_ACTUATORS),
            "last_last_act": jp.zeros(consts.NUM_ACTUATORS),
            "step": 0,
            "hold_counter": jp.int32(0),   # consecutive steps object is lifted
            "motor_targets": jp.zeros(self.mjx_model.nu),
        }

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())
        metrics["grasp_success"] = jp.zeros(())

        obs_history = jp.zeros(self._config.obs_history_size * self._single_obs_size)
        obs = self._get_obs(data, info, obs_history, noise_rng)
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        rng, noise_rng = jax.random.split(state.info["rng"], 2)

        # Apply scaled action
        motor_targets = self._default_pose + action * self._action_scale
        motor_targets = jp.clip(motor_targets, self._lowers, self._uppers)
        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        done = self.get_termination(data)

        # Object state
        obj_pos = self._get_object_pos(data)
        obj_z = obj_pos[2]
        is_lifted = obj_z > self._config.grasp_lift_threshold

        # Track consecutive hold steps
        hold_counter = jp.where(
            is_lifted,
            state.info["hold_counter"] + 1,
            jp.int32(0),
        )
        grasp_success = hold_counter >= self._config.grasp_hold_steps

        # Compute rewards
        gripper_pos = self._get_gripper_pos(data)
        gripper_obj_dist = jp.linalg.norm(gripper_pos - obj_pos)

        rewards = self._get_reward(data, action, state.info, done, gripper_obj_dist, obj_z)
        rewards = {
            k: v * self._config.reward_config.scales[k] for k, v in rewards.items()
        }
        reward = jp.clip(sum(rewards.values()) * self.dt, -10.0, 10000.0)

        # Bookkeeping
        state.info["rng"] = rng
        state.info["last_last_act"] = state.info["last_act"]
        state.info["last_act"] = action
        state.info["step"] = state.info["step"] + 1
        state.info["hold_counter"] = hold_counter
        state.info["motor_targets"] = motor_targets

        obs = self._get_obs(data, state.info, state.obs, noise_rng)

        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v
        state.metrics["grasp_success"] = jp.float32(grasp_success)

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # ---- Observation ----

    @property
    def _single_obs_size(self) -> int:
        """gyro(3) + gravity(3) + object_vec_body(3) + object_dist(1)
        + gripper_pos_body(3) + gripper_obj_dist(1) + gripper_state(1)
        + joint_pos(24) + last_act(24) = 63."""
        return 3 + 3 + 3 + 1 + 3 + 1 + 1 + consts.NUM_ACTUATORS + consts.NUM_ACTUATORS

    @property
    def observation_size(self) -> int:
        return self._single_obs_size * self._config.obs_history_size

    @property
    def action_size(self) -> int:
        return consts.NUM_ACTUATORS  # 24

    @property
    def xml_path(self) -> str:
        return str(_GRASP_SCENE_XML)

    @property
    def mj_model(self) -> mujoco.MjModel:
        return self._mj_model

    @property
    def mjx_model(self) -> mjx.Model:
        return self._mjx_model

    def _get_obs(
        self,
        data: mjx.Data,
        info: dict[str, Any],
        obs_history: jax.Array,
        rng: jax.Array,
    ) -> jax.Array:
        gyro = self.get_gyro(data)
        gravity = self.get_gravity(data)

        # Object position in body frame
        obj_pos = self._get_object_pos(data)
        robot_pos = data.qpos[:3]
        delta_obj = obj_pos - robot_pos
        yaw = self.get_yaw(data)
        cos_yaw = jp.cos(-yaw)
        sin_yaw = jp.sin(-yaw)
        obj_body = jp.array([
            delta_obj[0] * cos_yaw - delta_obj[1] * sin_yaw,
            delta_obj[0] * sin_yaw + delta_obj[1] * cos_yaw,
            delta_obj[2],
        ])
        obj_dist = jp.linalg.norm(delta_obj)

        # Gripper position in body frame
        gripper_pos = self._get_gripper_pos(data)
        delta_grip = gripper_pos - robot_pos
        grip_body = jp.array([
            delta_grip[0] * cos_yaw - delta_grip[1] * sin_yaw,
            delta_grip[0] * sin_yaw + delta_grip[1] * cos_yaw,
            delta_grip[2],
        ])
        grip_obj_dist = jp.linalg.norm(gripper_pos - obj_pos)
        gripper_state = self._get_gripper_state(data)

        obs = jp.concatenate([
            gyro,                                       # 3
            gravity,                                    # 3
            obj_body,                                   # 3
            jp.array([obj_dist]),                        # 1
            grip_body,                                  # 3
            jp.array([grip_obj_dist]),                   # 1
            jp.array([gripper_state]),                   # 1
            data.qpos[7:7 + consts.NUM_ACTUATORS] - self._default_pose,  # 24
            info["last_act"],                           # 24
        ])  # total = 63

        obs = self._apply_obs_noise(obs, rng)
        return self._stack_obs_history(obs, obs_history)

    def _apply_obs_noise(self, obs: jax.Array, rng: jax.Array) -> jax.Array:
        if self._config.obs_noise > 0.0:
            noise = self._config.obs_noise * jax.random.uniform(
                rng, obs.shape, minval=-1.0, maxval=1.0
            )
            obs = jp.clip(obs, -100.0, 100.0) + noise
        return obs

    def _stack_obs_history(self, obs: jax.Array, obs_history: jax.Array) -> jax.Array:
        return jp.roll(obs_history, obs.size).at[:obs.size].set(obs)

    # ---- Reward ----

    def _get_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
        done: jax.Array,
        gripper_obj_dist: jax.Array,
        obj_z: jax.Array,
    ) -> dict[str, jax.Array]:
        # Reach distance: shaped reward, exponential decay
        reach_distance = jp.exp(-10.0 * gripper_obj_dist)

        # Grasp contact: reward when gripper is close to object
        grasp_contact = jp.float32(gripper_obj_dist < 0.05)

        # Grasp hold: reward when object is lifted
        grasp_hold = jp.float32(obj_z > self._config.grasp_lift_threshold)

        return {
            "reach_distance": reach_distance,
            "grasp_contact": grasp_contact,
            "grasp_hold": grasp_hold,
            "orientation": self.cost_orientation(data),
            "termination": self.cost_termination(done, info["step"]),
            "action_rate": self.cost_action_rate(
                action, info["last_act"], info["last_last_act"]
            ),
            "torques": self.cost_torques(data),
            "energy": self.cost_energy(data),
        }
