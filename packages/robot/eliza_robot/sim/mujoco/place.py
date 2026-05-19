"""Precise placement environment for AiNex.

Given an already-grasped object (attached via weld constraint at episode
start), the robot must walk to a target zone and place the object precisely.
The weld is always active during simulation (MJX constraint); the policy
learns to lower the arm and release by opening the gripper.

Requires ainex_grasp_scene.xml which includes the object_weld equality
constraint and target_zone site.

MJX compatible: all reward/obs logic is pure JAX.

Usage:
    from eliza_robot.sim.mujoco.place import Place, default_config
    env = Place()
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
import mujoco
from mujoco import mjx
import numpy as np

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import _resolve_mjcf, ainex_constants as consts


_GRASP_SCENE_XML = _resolve_mjcf("ainex_grasp_scene.xml")


def default_config() -> config_dict.ConfigDict:
    """Default configuration for AiNex placement environment."""
    return config_dict.create(
        ctrl_dt=0.02,           # 50 Hz control
        sim_dt=0.004,           # 250 Hz physics
        episode_length=500,
        Kp=200.0,
        Kd=5.0,
        early_termination=True,
        action_repeat=1,
        action_scale_arms=0.3,
        action_scale_legs=0.3,
        obs_noise=0.05,
        obs_history_size=3,
        max_foot_height=0.05,
        # Target spawn range (metres from robot)
        target_dist_min=0.3,
        target_dist_max=1.0,
        # Placement thresholds
        placement_threshold=0.1,    # metres: object to target for success
        release_threshold=0.3,      # gripper angle: positive = open
        placement_height=0.05,      # metres: object z below which = placed
        reward_config=config_dict.create(
            scales=config_dict.create(
                # Approach target
                approach_target=8.0,
                # Lower object
                lower_object=5.0,
                # Release precision
                release_precision=15.0,
                # Placement success
                placement_success=50.0,
                # Stability penalties
                orientation=-3.0,
                termination=-1.0,
                action_rate=-0.01,
                torques=-0.0001,
                energy=-0.00005,
                lin_vel_z=-1.0,
                ang_vel_xy=-0.05,
            ),
        ),
    )


class Place(mjx_env.MjxEnv):
    """Place a held object at a precise target location.

    The robot starts standing with the object welded to the right gripper.
    A target zone is placed 0.3-1.0m away. The policy must walk to the
    target, lower the arm, and release the object precisely.

    The weld constraint keeps the object attached; the policy must command
    the gripper open. In a real deployment, the physical gripper opens and
    drops the object. In simulation, we detect placement by: object near
    target AND gripper angle above release_threshold.

    Episode succeeds when object is within 0.1m of target AND gripper
    is open.
    """

    def __init__(
        self,
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config, config_overrides)

        self._mj_model = mujoco.MjModel.from_xml_path(str(_GRASP_SCENE_XML))
        self._mj_model.opt.timestep = config.sim_dt

        # Activate the weld constraint so the object starts attached
        weld_id = mujoco.mj_name2id(
            self._mj_model, mujoco.mjtObj.mjOBJ_EQUALITY, "object_weld"
        )
        if weld_id >= 0:
            self._mj_model.eq_active[weld_id] = 1
        self._weld_eq_id = weld_id

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
        """Initialize robot, object, and foot sensor IDs."""
        self._init_q = jp.array(self._mj_model.keyframe("stand_bent_knees").qpos)
        self._default_pose = self._mj_model.keyframe("stand_bent_knees").qpos[7:]

        self._lowers = self._mj_model.actuator_ctrlrange[:, 0]
        self._uppers = self._mj_model.actuator_ctrlrange[:, 1]

        self._torso_body_id = self._mj_model.body(consts.ROOT_BODY).id
        self._object_body_id = self._mj_model.body("grasp_object").id
        self._gripper_body_id = self._mj_model.body("r_gripper_link").id

        self._object_jnt_id = self._mj_model.joint("object_joint").id
        self._object_qpos_adr = self._mj_model.jnt_qposadr[self._object_jnt_id]

        # Gripper joint for release detection
        self._gripper_jnt_id = self._mj_model.joint("r_gripper").id
        self._gripper_qpos_adr = self._mj_model.jnt_qposadr[self._gripper_jnt_id]

        # Foot sensors
        self._feet_site_id = np.array(
            [self._mj_model.site(name).id for name in consts.FEET_SITES]
        )

        # Action scale vector
        n_leg = consts.NUM_LEG_ACTUATORS
        n_head = consts.NUM_HEAD_ACTUATORS
        n_arm = consts.NUM_ARM_ACTUATORS
        self._action_scale = jp.concatenate([
            jp.full((n_leg,), self._config.action_scale_legs),
            jp.full((n_head,), self._config.action_scale_legs),
            jp.full((n_arm,), self._config.action_scale_arms),
        ])

    # ---- Sensor access ----

    def get_gravity(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GRAVITY_SENSOR)

    def get_gyro(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GYRO_SENSOR)

    def get_global_linvel(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GLOBAL_LINVEL_SENSOR)

    def get_global_angvel(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.GLOBAL_ANGVEL_SENSOR)

    def get_local_linvel(self, data: mjx.Data) -> jax.Array:
        return mjx_env.get_sensor_data(self.mj_model, data, consts.LOCAL_LINVEL_SENSOR)

    def get_yaw(self, data: mjx.Data) -> jax.Array:
        qw, qx, qy, qz = data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]
        return jp.arctan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))

    # ---- Object / gripper state ----

    def _get_object_pos(self, data: mjx.Data) -> jax.Array:
        return data.xpos[self._object_body_id]

    def _get_gripper_pos(self, data: mjx.Data) -> jax.Array:
        return data.xpos[self._gripper_body_id]

    def _get_gripper_angle(self, data: mjx.Data) -> jax.Array:
        """Gripper joint angle (scalar). Positive = open direction."""
        return data.qpos[self._gripper_qpos_adr]

    # ---- Termination ----

    def get_termination(self, data: mjx.Data) -> jax.Array:
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

    def cost_lin_vel_z(self, data: mjx.Data) -> jax.Array:
        return jp.square(self.get_global_linvel(data)[2])

    def cost_ang_vel_xy(self, data: mjx.Data) -> jax.Array:
        return jp.sum(jp.square(self.get_global_angvel(data)[:2]))

    # ---- Environment interface ----

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, target_rng, noise_rng = jax.random.split(rng, 3)

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )

        # Object starts at gripper (weld constraint handles positioning)
        # Place the object near the gripper in initial qpos so the weld
        # constraint doesn't create a large force spike
        gripper_body_pos = jp.array([0.0, -0.16, 0.26])  # approximate world pos from keyframe
        obj_adr = self._object_qpos_adr
        new_qpos = data.qpos.at[obj_adr:obj_adr + 3].set(gripper_body_pos)
        new_qpos = new_qpos.at[obj_adr + 3:obj_adr + 7].set(
            jp.array([1.0, 0.0, 0.0, 0.0])
        )
        data = data.replace(qpos=new_qpos)

        # Randomize target position
        rng1, rng2 = jax.random.split(target_rng)
        tgt_dist = jax.random.uniform(
            rng1,
            minval=self._config.target_dist_min,
            maxval=self._config.target_dist_max,
        )
        tgt_angle = jax.random.uniform(rng2, minval=-jp.pi * 0.5, maxval=jp.pi * 0.5)
        robot_xy = data.qpos[:2]
        target_pos = robot_xy + tgt_dist * jp.array([jp.cos(tgt_angle), jp.sin(tgt_angle)])

        data = mjx.forward(self.mjx_model, data)

        prev_target_dist = jp.linalg.norm(data.qpos[:2] - target_pos)

        info = {
            "rng": rng,
            "last_act": jp.zeros(consts.NUM_ACTUATORS),
            "last_last_act": jp.zeros(consts.NUM_ACTUATORS),
            "step": 0,
            "target_pos": target_pos,       # (2,) world frame
            "prev_target_dist": prev_target_dist,
            "motor_targets": jp.zeros(self.mjx_model.nu),
        }

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())
        metrics["placement_success"] = jp.zeros(())

        obs_history = jp.zeros(self._config.obs_history_size * self._single_obs_size)
        obs = self._get_obs(data, info, obs_history, noise_rng)
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        rng, noise_rng = jax.random.split(state.info["rng"], 2)

        motor_targets = self._default_pose + action * self._action_scale
        motor_targets = jp.clip(motor_targets, self._lowers, self._uppers)
        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        done = self.get_termination(data)

        # State
        obj_pos = self._get_object_pos(data)
        target_pos = state.info["target_pos"]
        obj_target_dist = jp.linalg.norm(obj_pos[:2] - target_pos)
        gripper_angle = self._get_gripper_angle(data)
        obj_z = obj_pos[2]

        # Robot distance to target
        robot_target_dist = jp.linalg.norm(data.qpos[:2] - target_pos)

        # Placement detection
        is_near_target = obj_target_dist < self._config.placement_threshold
        is_released = gripper_angle > self._config.release_threshold
        is_low = obj_z < self._config.placement_height
        placement_success = is_near_target & is_released

        # Rewards
        rewards = self._get_reward(
            data, action, state.info, done,
            robot_target_dist, obj_z, obj_target_dist,
            gripper_angle, placement_success,
        )
        rewards = {
            k: v * self._config.reward_config.scales[k] for k, v in rewards.items()
        }
        reward = jp.clip(sum(rewards.values()) * self.dt, -10.0, 10000.0)

        # Bookkeeping
        state.info["rng"] = rng
        state.info["last_last_act"] = state.info["last_act"]
        state.info["last_act"] = action
        state.info["step"] = state.info["step"] + 1
        state.info["prev_target_dist"] = robot_target_dist
        state.info["motor_targets"] = motor_targets

        obs = self._get_obs(data, state.info, state.obs, noise_rng)

        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v
        state.metrics["placement_success"] = jp.float32(placement_success)

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # ---- Observation ----

    @property
    def _single_obs_size(self) -> int:
        """gyro(3) + gravity(3) + object_pos_body(3) + object_z(1)
        + gripper_angle(1) + target_vec_body(2) + target_dist(1)
        + joint_pos(24) + last_act(24) = 62."""
        return 3 + 3 + 3 + 1 + 1 + 2 + 1 + consts.NUM_ACTUATORS + consts.NUM_ACTUATORS

    @property
    def observation_size(self) -> int:
        return self._single_obs_size * self._config.obs_history_size

    @property
    def action_size(self) -> int:
        return consts.NUM_ACTUATORS

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
        yaw = self.get_yaw(data)
        cos_yaw = jp.cos(-yaw)
        sin_yaw = jp.sin(-yaw)

        robot_pos = data.qpos[:3]

        # Object in body frame
        obj_pos = self._get_object_pos(data)
        delta_obj = obj_pos - robot_pos
        obj_body = jp.array([
            delta_obj[0] * cos_yaw - delta_obj[1] * sin_yaw,
            delta_obj[0] * sin_yaw + delta_obj[1] * cos_yaw,
            delta_obj[2],
        ])
        obj_z = obj_pos[2]

        # Gripper angle
        gripper_angle = self._get_gripper_angle(data)

        # Target in body frame
        target_pos = info["target_pos"]
        delta_target = target_pos - data.qpos[:2]
        target_body = jp.array([
            delta_target[0] * cos_yaw - delta_target[1] * sin_yaw,
            delta_target[0] * sin_yaw + delta_target[1] * cos_yaw,
        ])
        target_dist = jp.linalg.norm(delta_target)

        obs = jp.concatenate([
            gyro,                                       # 3
            gravity,                                    # 3
            obj_body,                                   # 3
            jp.array([obj_z]),                           # 1
            jp.array([gripper_angle]),                   # 1
            target_body,                                # 2
            jp.array([target_dist]),                     # 1
            data.qpos[7:7 + consts.NUM_ACTUATORS] - self._default_pose,  # 24
            info["last_act"],                           # 24
        ])  # total = 62

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
        robot_target_dist: jax.Array,
        obj_z: jax.Array,
        obj_target_dist: jax.Array,
        gripper_angle: jax.Array,
        placement_success: jax.Array,
    ) -> dict[str, jax.Array]:
        # Approach target: shaped reward for moving toward target
        approach_delta = info["prev_target_dist"] - robot_target_dist
        approach_target = approach_delta

        # Lower object: reward for bringing object close to ground near target
        # Only meaningful when close to target
        near_target = jp.float32(obj_target_dist < 0.3)
        lower_object = jp.exp(-5.0 * obj_z) * near_target

        # Release precision: reward proximity to target * gripper openness
        release_precision = jp.exp(-10.0 * obj_target_dist) * jp.clip(
            gripper_angle / self._config.release_threshold, 0.0, 1.0
        )

        # Placement success bonus
        placement_bonus = jp.float32(placement_success)

        return {
            "approach_target": approach_target,
            "lower_object": lower_object,
            "release_precision": release_precision,
            "placement_success": placement_bonus,
            "orientation": self.cost_orientation(data),
            "termination": self.cost_termination(done, info["step"]),
            "action_rate": self.cost_action_rate(
                action, info["last_act"], info["last_last_act"]
            ),
            "torques": self.cost_torques(data),
            "energy": self.cost_energy(data),
            "lin_vel_z": self.cost_lin_vel_z(data),
            "ang_vel_xy": self.cost_ang_vel_xy(data),
        }
