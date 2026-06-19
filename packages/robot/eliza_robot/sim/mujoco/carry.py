"""Carry-object-to-target environment for AiNex.

Combines grasping and locomotion: the robot must approach a graspable object,
pick it up, walk it to a target location, and place it. Tracks task phase
(approach -> grasp -> carry -> done) in the info dict.

Requires ainex_grasp_scene.xml which extends ainex_primitives.xml with a
graspable object body, target site, and contact pairs.

MJX compatible: all reward/obs logic is pure JAX.

Usage:
    from eliza_robot.sim.mujoco.carry import Carry, default_config
    env = Carry()
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
import mujoco
from mujoco import mjx

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import _resolve_mjcf, ainex_constants as consts


_GRASP_SCENE_XML = _resolve_mjcf("ainex_grasp_scene.xml")

# Phase encoding (one-hot indices)
PHASE_APPROACH = 0
PHASE_GRASP = 1
PHASE_CARRY = 2
PHASE_DONE = 3
NUM_PHASES = 4


def default_config() -> config_dict.ConfigDict:
    """Default configuration for AiNex carry environment."""
    return config_dict.create(
        ctrl_dt=0.02,           # 50 Hz control
        sim_dt=0.004,           # 250 Hz physics
        episode_length=1000,
        Kp=200.0,
        Kd=5.0,
        early_termination=True,
        action_repeat=1,
        action_scale_arms=0.3,
        action_scale_legs=0.3,  # Legs need full range for walking
        obs_noise=0.05,
        obs_history_size=3,
        max_foot_height=0.05,
        # Object spawn range
        object_dist_min=0.2,
        object_dist_max=0.4,
        # Target spawn range
        target_dist_min=0.5,
        target_dist_max=1.5,
        # Grasp thresholds
        grasp_proximity=0.05,           # metres: gripper-object for grasp
        grasp_lift_threshold=0.05,      # metres above ground
        # Delivery thresholds
        target_reached_threshold=0.15,  # metres: object to target
        reward_config=config_dict.create(
            scales=config_dict.create(
                # Approach / grasp rewards
                reach_distance=5.0,
                grasp_contact=3.0,
                grasp_hold=10.0,
                # Carry rewards
                target_distance=10.0,
                carry_stability=5.0,
                delivery=50.0,
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


class Carry(mjx_env.MjxEnv):
    """Pick up an object and carry it to a target location.

    Phases tracked in info["phase"] (int):
        0 = approach: walk toward the object
        1 = grasp: close gripper on object
        2 = carry: walk to target while holding object
        3 = done: object delivered

    Episode succeeds when the object is placed within 0.15m of the target.
    """

    def __init__(
        self,
        config: config_dict.ConfigDict = default_config(),
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ):
        super().__init__(config, config_overrides)

        self._mj_model = mujoco.MjModel.from_xml_path(str(_GRASP_SCENE_XML))
        self._mj_model.opt.timestep = config.sim_dt

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

        # Foot sensor addresses for slip penalty
        import numpy as np
        self._feet_site_id = np.array(
            [self._mj_model.site(name).id for name in consts.FEET_SITES]
        )
        foot_linvel_sensor_adr = []
        for site in consts.FEET_SITES:
            sensor_id = self._mj_model.sensor(f"{site}_global_linvel").id
            sensor_adr = self._mj_model.sensor_adr[sensor_id]
            sensor_dim = self._mj_model.sensor_dim[sensor_id]
            foot_linvel_sensor_adr.append(
                list(range(sensor_adr, sensor_adr + sensor_dim))
            )
        self._foot_linvel_sensor_adr = jp.array(foot_linvel_sensor_adr)

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

    def _get_gripper_state(self, data: mjx.Data) -> jax.Array:
        gripper_jnt_id = self._mj_model.joint("r_gripper").id
        gripper_qpos_adr = self._mj_model.jnt_qposadr[gripper_jnt_id]
        return data.qpos[gripper_qpos_adr]

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
        rng, obj_rng, target_rng, noise_rng = jax.random.split(rng, 4)

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )

        # Randomize object position
        rng1, rng2 = jax.random.split(obj_rng)
        obj_dist = jax.random.uniform(
            rng1,
            minval=self._config.object_dist_min,
            maxval=self._config.object_dist_max,
        )
        obj_angle = jax.random.uniform(rng2, minval=-0.4, maxval=0.4)
        robot_xy = data.qpos[:2]
        obj_x = robot_xy[0] + obj_dist * jp.cos(obj_angle)
        obj_y = robot_xy[1] + obj_dist * jp.sin(obj_angle)
        obj_z = jp.float32(0.03)

        obj_adr = self._object_qpos_adr
        new_qpos = data.qpos.at[obj_adr:obj_adr + 3].set(
            jp.array([obj_x, obj_y, obj_z])
        )
        new_qpos = new_qpos.at[obj_adr + 3:obj_adr + 7].set(
            jp.array([1.0, 0.0, 0.0, 0.0])
        )
        data = data.replace(qpos=new_qpos)

        # Randomize target position (further away than object)
        rng3, rng4 = jax.random.split(target_rng)
        tgt_dist = jax.random.uniform(
            rng3,
            minval=self._config.target_dist_min,
            maxval=self._config.target_dist_max,
        )
        tgt_angle = jax.random.uniform(rng4, minval=-jp.pi, maxval=jp.pi)
        target_pos = robot_xy + tgt_dist * jp.array([jp.cos(tgt_angle), jp.sin(tgt_angle)])

        data = mjx.forward(self.mjx_model, data)

        # Initial distances
        obj_pos_xy = jp.array([obj_x, obj_y])
        prev_gripper_obj_dist = jp.linalg.norm(
            self._get_gripper_pos(data)[:2] - obj_pos_xy
        )
        prev_obj_target_dist = jp.linalg.norm(obj_pos_xy - target_pos)

        info = {
            "rng": rng,
            "last_act": jp.zeros(consts.NUM_ACTUATORS),
            "last_last_act": jp.zeros(consts.NUM_ACTUATORS),
            "step": 0,
            "phase": jp.int32(PHASE_APPROACH),
            "target_pos": target_pos,                   # (2,)
            "prev_gripper_obj_dist": prev_gripper_obj_dist,
            "prev_obj_target_dist": prev_obj_target_dist,
            "motor_targets": jp.zeros(self.mjx_model.nu),
        }

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())
        metrics["phase"] = jp.zeros(())
        metrics["delivery_success"] = jp.zeros(())

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

        # Compute state
        obj_pos = self._get_object_pos(data)
        gripper_pos = self._get_gripper_pos(data)
        gripper_obj_dist = jp.linalg.norm(gripper_pos - obj_pos)
        obj_z = obj_pos[2]

        target_pos = state.info["target_pos"]
        obj_target_dist = jp.linalg.norm(obj_pos[:2] - target_pos)

        # Phase logic (pure JAX, no Python branching)
        old_phase = state.info["phase"]
        is_close = gripper_obj_dist < self._config.grasp_proximity
        is_lifted = obj_z > self._config.grasp_lift_threshold
        is_delivered = obj_target_dist < self._config.target_reached_threshold

        # Transition: approach -> grasp when close
        phase = jp.where(
            (old_phase == PHASE_APPROACH) & is_close,
            jp.int32(PHASE_GRASP),
            old_phase,
        )
        # Transition: grasp -> carry when lifted
        phase = jp.where(
            (phase == PHASE_GRASP) & is_lifted,
            jp.int32(PHASE_CARRY),
            phase,
        )
        # Transition: carry -> done when delivered
        phase = jp.where(
            (phase == PHASE_CARRY) & is_delivered,
            jp.int32(PHASE_DONE),
            phase,
        )

        # Rewards
        rewards = self._get_reward(
            data, action, state.info, done,
            gripper_obj_dist, obj_z, obj_target_dist, phase,
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
        state.info["phase"] = phase
        state.info["prev_gripper_obj_dist"] = gripper_obj_dist
        state.info["prev_obj_target_dist"] = obj_target_dist
        state.info["motor_targets"] = motor_targets

        obs = self._get_obs(data, state.info, state.obs, noise_rng)

        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v
        state.metrics["phase"] = jp.float32(phase)
        state.metrics["delivery_success"] = jp.float32(phase == PHASE_DONE)

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # ---- Observation ----

    @property
    def _single_obs_size(self) -> int:
        """gyro(3) + gravity(3) + object_vec_body(3) + object_dist(1)
        + gripper_pos_body(3) + gripper_obj_dist(1) + gripper_state(1)
        + target_vec(2) + target_dist(1) + phase_onehot(4)
        + joint_pos(24) + last_act(24) = 70."""
        return (3 + 3 + 3 + 1 + 3 + 1 + 1 + 2 + 1 + NUM_PHASES
                + consts.NUM_ACTUATORS + consts.NUM_ACTUATORS)

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
        obj_dist = jp.linalg.norm(delta_obj)

        # Gripper in body frame
        gripper_pos = self._get_gripper_pos(data)
        delta_grip = gripper_pos - robot_pos
        grip_body = jp.array([
            delta_grip[0] * cos_yaw - delta_grip[1] * sin_yaw,
            delta_grip[0] * sin_yaw + delta_grip[1] * cos_yaw,
            delta_grip[2],
        ])
        grip_obj_dist = jp.linalg.norm(gripper_pos - obj_pos)
        gripper_state = self._get_gripper_state(data)

        # Target in body frame
        target_pos = info["target_pos"]
        delta_target = target_pos - data.qpos[:2]
        target_body = jp.array([
            delta_target[0] * cos_yaw - delta_target[1] * sin_yaw,
            delta_target[0] * sin_yaw + delta_target[1] * cos_yaw,
        ])
        target_dist = jp.linalg.norm(delta_target)

        # Phase one-hot
        phase_onehot = jax.nn.one_hot(info["phase"], NUM_PHASES)

        obs = jp.concatenate([
            gyro,                                       # 3
            gravity,                                    # 3
            obj_body,                                   # 3
            jp.array([obj_dist]),                        # 1
            grip_body,                                  # 3
            jp.array([grip_obj_dist]),                   # 1
            jp.array([gripper_state]),                   # 1
            target_body,                                # 2
            jp.array([target_dist]),                     # 1
            phase_onehot,                               # 4
            data.qpos[7:7 + consts.NUM_ACTUATORS] - self._default_pose,  # 24
            info["last_act"],                           # 24
        ])  # total = 70

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
        obj_target_dist: jax.Array,
        phase: jax.Array,
    ) -> dict[str, jax.Array]:
        # Approach / grasp phase rewards (always active but weighted by phase)
        in_approach_or_grasp = jp.float32(phase <= PHASE_GRASP)

        # Reach distance: shaped approach reward
        reach_delta = info["prev_gripper_obj_dist"] - gripper_obj_dist
        reach_distance = reach_delta * in_approach_or_grasp

        # Grasp contact
        grasp_contact = jp.float32(gripper_obj_dist < self._config.grasp_proximity)

        # Grasp hold: object lifted
        grasp_hold = jp.float32(obj_z > self._config.grasp_lift_threshold)

        # Carry phase rewards (only active after grasp)
        in_carry = jp.float32(phase >= PHASE_CARRY)

        # Target distance: shaped carry reward
        target_delta = info["prev_obj_target_dist"] - obj_target_dist
        target_distance = target_delta * in_carry

        # Carry stability: penalize object dropping during carry
        carry_stability = jp.float32(obj_z > 0.03) * in_carry

        # Delivery bonus
        delivery = jp.float32(phase == PHASE_DONE)

        return {
            "reach_distance": reach_distance,
            "grasp_contact": grasp_contact,
            "grasp_hold": grasp_hold,
            "target_distance": target_distance,
            "carry_stability": carry_stability,
            "delivery": delivery,
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
