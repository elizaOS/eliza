"""Base MjxEnv class for AiNex (following Playground OP3 pattern).

Shared logic for all AiNex task environments: model loading, sensor access,
robot initialization, termination, and stability cost functions.
"""

from typing import Any, Dict, Optional, Union

import jax
import jax.numpy as jp
from ml_collections import config_dict
import mujoco
from mujoco import mjx
import numpy as np

from mujoco_playground._src import mjx_env
from eliza_robot.sim.mujoco import ainex_constants as consts


class AiNexEnv(mjx_env.MjxEnv):
    """Base class for AiNex MuJoCo Playground environments.

    Handles model loading, PD gain configuration, sensor access,
    robot body/joint initialization, and shared reward/termination logic.
    Subclasses implement reset(), step(), _get_obs(), _get_reward().
    """

    def __init__(
        self,
        config: config_dict.ConfigDict,
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ) -> None:
        super().__init__(config, config_overrides)

        # Load pure primitives model (no meshes, fastest for GPU training)
        self._mj_model = mujoco.MjModel.from_xml_path(
            str(consts.SCENE_PRIMITIVES_XML)
        )
        self._mj_model.opt.timestep = config.sim_dt

        # Set PD gains on joints (skip first 6 DOFs = freejoint)
        # Only override leg actuators (0:12) with config values;
        # head/arm actuators keep their XML-defined kp values.
        n_leg = 12
        if getattr(config, "Kd", 0) > 0:
            self._mj_model.dof_damping[6:6 + n_leg] = config.Kd
        if getattr(config, "Kp", 0) > 0:
            self._mj_model.actuator_gainprm[:n_leg, 0] = config.Kp
            self._mj_model.actuator_biasprm[:n_leg, 1] = -config.Kp

        self._mj_model.vis.global_.offwidth = 1920
        self._mj_model.vis.global_.offheight = 1080

        self._mjx_model = mjx.put_model(self._mj_model)

    def _init_robot(self) -> None:
        """Initialize robot-specific state from the MJCF model.

        Call from subclass __init__ after super().__init__.
        Sets up standing pose, actuator limits, body/site/sensor IDs.
        """
        # Standing pose from keyframe (bent knees, matching OP3 pattern)
        self._init_q = jp.array(self._mj_model.keyframe("stand_bent_knees").qpos)
        self._default_pose = self._mj_model.keyframe("stand_bent_knees").qpos[7:]

        # Actuator limits
        self._lowers = self._mj_model.actuator_ctrlrange[:, 0]
        self._uppers = self._mj_model.actuator_ctrlrange[:, 1]

        # Body IDs
        self._torso_body_id = self._mj_model.body(consts.ROOT_BODY).id
        self._torso_mass = self._mj_model.body_subtreemass[self._torso_body_id]

        # Foot site IDs
        self._feet_site_id = np.array(
            [self._mj_model.site(name).id for name in consts.FEET_SITES]
        )

        # Foot velocity sensor addresses
        foot_linvel_sensor_adr = []
        for site in consts.FEET_SITES:
            sensor_id = self._mj_model.sensor(f"{site}_global_linvel").id
            sensor_adr = self._mj_model.sensor_adr[sensor_id]
            sensor_dim = self._mj_model.sensor_dim[sensor_id]
            foot_linvel_sensor_adr.append(
                list(range(sensor_adr, sensor_adr + sensor_dim))
            )
        self._foot_linvel_sensor_adr = jp.array(foot_linvel_sensor_adr)

        # Floor contact sensor IDs
        self._left_feet_floor_found_sensor = [
            self._mj_model.sensor(f + "_floor_found").id
            for f in consts.LEFT_FEET_GEOMS
        ]
        self._right_feet_floor_found_sensor = [
            self._mj_model.sensor(f + "_floor_found").id
            for f in consts.RIGHT_FEET_GEOMS
        ]

    # Maximum number of entities to randomize per episode
    _MAX_ENTITIES = 8

    # Entity type distribution for random sampling (type_id, probability)
    # PERSON=1, OBJECT=2, FURNITURE=4
    _ENTITY_TYPE_PROBS = jp.array([0.0, 0.3, 0.4, 0.0, 0.2, 0.1])  # 6 types

    # Size ranges per entity type: (min_w, max_w, min_h, max_h, min_d, max_d)
    _ENTITY_SIZE_RANGES = jp.array([
        [0.1, 0.5, 0.1, 0.5, 0.1, 0.5],   # UNKNOWN
        [0.3, 0.6, 1.2, 1.9, 0.2, 0.4],   # PERSON
        [0.05, 0.5, 0.05, 0.5, 0.05, 0.5], # OBJECT
        [0.1, 0.3, 0.1, 0.3, 0.1, 0.3],   # LANDMARK
        [0.3, 1.0, 0.4, 1.2, 0.3, 1.0],   # FURNITURE
        [0.7, 1.0, 1.8, 2.2, 0.1, 0.2],   # DOOR
    ])

    def _init_entities(self) -> None:
        """Initialize entity randomization for perception training.

        Call from subclass __init__ when enable_entity_slots is True.
        Entity positions, types, and sizes are randomized per-episode in
        sample_entity_scene() rather than read from fixed MJCF bodies.
        """
        # Keep body IDs for backward compat (used by get_entity_data fallback)
        self._entity_body_ids = np.array([
            self._mj_model.body(name).id
            for name in consts.ENTITY_BODY_NAMES
        ])
        self._entity_types = jp.array(consts.ENTITY_BODY_TYPES)
        self._entity_sizes = jp.array(consts.ENTITY_BODY_SIZES, dtype=jp.float32)

    def sample_entity_scene(self, rng: jax.Array, robot_xy: jax.Array) -> dict[str, jax.Array]:
        """Randomize entity positions, types, sizes, and count for one episode.

        Produces 1-MAX_ENTITIES entities scattered around the robot at
        random distances (0.5-4.0m) and angles. Unused slots are masked.

        Args:
            rng: JAX PRNG key.
            robot_xy: Robot (x, y) position for placing entities around.

        Returns:
            Dict with entity_positions (MAX_ENTITIES, 3),
            entity_types (MAX_ENTITIES,), entity_sizes (MAX_ENTITIES, 3),
            entity_mask (MAX_ENTITIES,) bool — True for active entities.
        """
        n_max = self._MAX_ENTITIES
        rng, count_rng, type_rng, angle_rng, dist_rng, z_rng, size_rng = (
            jax.random.split(rng, 7)
        )

        # Random entity count: 1-MAX_ENTITIES (uniform)
        n_entities = jax.random.randint(count_rng, (), 1, n_max + 1)
        entity_mask = jp.arange(n_max) < n_entities

        # Random entity types (categorical sample)
        type_logits = jp.log(self._ENTITY_TYPE_PROBS + 1e-8)
        entity_types = jax.random.categorical(type_rng, type_logits, shape=(n_max,))

        # Random positions: polar around robot
        angles = jax.random.uniform(angle_rng, (n_max,), minval=0.0, maxval=2.0 * jp.pi)
        distances = jax.random.uniform(dist_rng, (n_max,), minval=0.5, maxval=4.0)
        x = robot_xy[0] + distances * jp.cos(angles)
        y = robot_xy[1] + distances * jp.sin(angles)

        # Z height: sample per-type from size range (half of height)
        size_ranges = self._ENTITY_SIZE_RANGES[entity_types]  # (n_max, 6)
        size_rngs = jax.random.split(size_rng, n_max)
        def _sample_size(rng_i, ranges):
            w = jax.random.uniform(rng_i, (), minval=ranges[0], maxval=ranges[1])
            h = jax.random.uniform(rng_i, (), minval=ranges[2], maxval=ranges[3])
            d = jax.random.uniform(rng_i, (), minval=ranges[4], maxval=ranges[5])
            return jp.array([w, h, d])
        entity_sizes = jax.vmap(_sample_size)(size_rngs, size_ranges)  # (n_max, 3)

        z = jax.random.uniform(z_rng, (n_max,), minval=0.0, maxval=0.3) + entity_sizes[:, 1] * 0.5
        entity_positions = jp.stack([x, y, z], axis=1)  # (n_max, 3)

        # Zero out inactive entities
        entity_positions = jp.where(entity_mask[:, None], entity_positions, 0.0)
        entity_types = jp.where(entity_mask, entity_types, 0)
        entity_sizes = jp.where(entity_mask[:, None], entity_sizes, 0.0)

        return {
            "entity_positions": entity_positions,
            "entity_types": entity_types,
            "entity_sizes": entity_sizes,
            "entity_mask": entity_mask,
        }

    def get_entity_data(self, data: mjx.Data) -> tuple[jax.Array, jax.Array, jax.Array]:
        """Extract robot pos/yaw and fixed MJCF entity positions (fallback).

        Returns:
            (robot_pos, robot_yaw, entity_positions)
        """
        robot_pos = data.qpos[:3]
        robot_yaw = self.get_yaw(data)
        entity_positions = data.xpos[self._entity_body_ids]
        return robot_pos, robot_yaw, entity_positions

    # ---- Sensor readings ----

    def get_gravity(self, data: mjx.Data) -> jax.Array:
        """Gravity direction in body frame (upvector sensor)."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.GRAVITY_SENSOR
        )

    def get_global_linvel(self, data: mjx.Data) -> jax.Array:
        """Linear velocity in world frame (framelinvel sensor)."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.GLOBAL_LINVEL_SENSOR
        )

    def get_global_angvel(self, data: mjx.Data) -> jax.Array:
        """Angular velocity in world frame (frameangvel sensor)."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.GLOBAL_ANGVEL_SENSOR
        )

    def get_local_linvel(self, data: mjx.Data) -> jax.Array:
        """Linear velocity in body frame (velocimeter sensor)."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.LOCAL_LINVEL_SENSOR
        )

    def get_accelerometer(self, data: mjx.Data) -> jax.Array:
        """Accelerometer reading in body frame."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.ACCELEROMETER_SENSOR
        )

    def get_gyro(self, data: mjx.Data) -> jax.Array:
        """Gyroscope reading in body frame."""
        return mjx_env.get_sensor_data(
            self.mj_model, data, consts.GYRO_SENSOR
        )

    # ---- Termination ----

    def get_termination(self, data: mjx.Data) -> jax.Array:
        """Check if episode should terminate (fall or joint limit)."""
        joint_angles = data.qpos[7:]
        torso_z = data.xpos[self._torso_body_id, 2]

        joint_limit_exceed = jp.any(joint_angles < self._lowers)
        joint_limit_exceed |= jp.any(joint_angles > self._uppers)

        fall = self.get_gravity(data)[-1] < 0.85
        fall |= torso_z < 0.17

        return jp.where(
            self._config.early_termination,
            joint_limit_exceed | fall,
            joint_limit_exceed,
        )

    # ---- Shared cost functions ----

    def cost_lin_vel_z(self, data: mjx.Data) -> jax.Array:
        """Penalize vertical velocity (world frame)."""
        return jp.square(self.get_global_linvel(data)[2])

    def cost_ang_vel_xy(self, data: mjx.Data) -> jax.Array:
        """Penalize roll/pitch angular velocity (world frame)."""
        return jp.sum(jp.square(self.get_global_angvel(data)[:2]))

    def cost_orientation(self, data: mjx.Data) -> jax.Array:
        """Penalize non-upright torso orientation."""
        gravity = self.get_gravity(data)
        return jp.sum(jp.square(gravity[:2]))

    def cost_torques(self, data: mjx.Data) -> jax.Array:
        """Penalize actuator forces."""
        torques = data.actuator_force
        return jp.sqrt(jp.sum(jp.square(torques))) + jp.sum(jp.abs(torques))

    def cost_energy(self, data: mjx.Data) -> jax.Array:
        """Penalize mechanical power (velocity * force)."""
        qvel = data.qvel[6:]
        qfrc = data.actuator_force
        return jp.sum(jp.abs(qvel) * jp.abs(qfrc))

    def cost_asymmetry(self, data: mjx.Data) -> jax.Array:
        """Penalize asymmetric leg joint usage (kinetic energy imbalance).

        Compares total squared joint velocity between right and left legs.
        For a symmetric gait the two sides should expend equal energy
        over time, so penalizing the instantaneous imbalance encourages
        the policy to keep the legs balanced.
        """
        qvel = data.qvel[6:18]  # 12 leg joint velocities
        right_energy = jp.sum(jp.square(qvel[:6]))
        left_energy = jp.sum(jp.square(qvel[6:]))
        return jp.square(right_energy - left_energy)

    def cost_action_rate(
        self, act: jax.Array, last_act: jax.Array, last_last_act: jax.Array
    ) -> jax.Array:
        """Penalize action change rate (first + second derivative)."""
        c1 = jp.sum(jp.square(act - last_act))
        c2 = jp.sum(jp.square(act - 2 * last_act + last_last_act))
        return c1 + c2

    def cost_termination(self, done: jax.Array, step: jax.Array) -> jax.Array:
        """Penalize early termination."""
        return done & (step < 500)

    def cost_feet_slip(self, data: mjx.Data) -> jax.Array:
        """Penalize foot sliding while in contact with ground."""
        feet_vel = data.sensordata[self._foot_linvel_sensor_adr]
        vel_xy = feet_vel[..., :2]
        vel_xy_norm_sq = jp.sum(jp.square(vel_xy), axis=-1)

        left_contact = jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._left_feet_floor_found_sensor
        ])
        right_contact = jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._right_feet_floor_found_sensor
        ])
        feet_contact = jp.hstack([jp.any(left_contact), jp.any(right_contact)])
        return jp.sum(vel_xy_norm_sq * feet_contact)

    def cost_feet_orientation(self, data: mjx.Data) -> jax.Array:
        """Penalize non-flat feet during ground contact (stance phase).

        Uses the foot site rotation matrix to check if the foot's local
        z-axis is aligned with world z. Only applied when the foot is in
        contact with the floor (stance phase). During swing, feet are free
        to tilt naturally.
        """
        # Foot site rotation matrices: (2, 3, 3) in MJX
        foot_xmat = data.site_xmat[self._feet_site_id]
        # z-axis of foot in world frame = third column of rotation matrix
        foot_z_world = foot_xmat[:, :, 2]  # (2, 3)
        # For flat feet: foot_z_world ≈ [0, 0, 1]
        # Penalize x and y components (should be 0 for flat)
        tilt_error = jp.sum(jp.square(foot_z_world[:, :2]), axis=1)  # (2,)

        # Gate by ground contact — only penalize during stance
        left_contact = jp.any(jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._left_feet_floor_found_sensor
        ]))
        right_contact = jp.any(jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._right_feet_floor_found_sensor
        ]))
        contact = jp.array([left_contact, right_contact])

        return jp.sum(tilt_error * contact)

    def cost_feet_clearance(self, data: mjx.Data) -> jax.Array:
        """Penalize feet not reaching target clearance during swing."""
        feet_vel = data.sensordata[self._foot_linvel_sensor_adr]
        vel_xy = feet_vel[..., :2]
        vel_norm = jp.sqrt(jp.linalg.norm(vel_xy, axis=-1))
        foot_pos = data.site_xpos[self._feet_site_id]
        foot_z = foot_pos[..., -1]
        delta = (foot_z - self._config.max_foot_height) ** 2
        return jp.sum(delta * vel_norm)

    def reward_gait_phase(
        self, data: mjx.Data, phase: jax.Array
    ) -> jax.Array:
        """Reward alternating foot contacts matching a desired gait clock.

        Uses a sinusoidal gait clock: left foot should be in stance when
        sin(phase) > 0, right foot in stance when sin(phase) < 0.
        Rewards contact that matches the clock and penalizes mismatches.

        Args:
            data: MJX simulation data.
            phase: Current gait phase angle in radians [0, 2*pi).
        """
        # Desired contact schedule: 1.0 = should be in contact
        sin_phase = jp.sin(phase)
        left_desired = jp.clip(sin_phase, 0.0, 1.0)    # stance when sin > 0
        right_desired = jp.clip(-sin_phase, 0.0, 1.0)   # stance when sin < 0

        # Actual contacts
        left_contact = jp.any(jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._left_feet_floor_found_sensor
        ]))
        right_contact = jp.any(jp.array([
            data.sensordata[self._mj_model.sensor_adr[sid]] > 0
            for sid in self._right_feet_floor_found_sensor
        ]))

        # Reward = contact matches desired pattern
        left_reward = left_desired * left_contact + (1.0 - left_desired) * (1.0 - left_contact)
        right_reward = right_desired * right_contact + (1.0 - right_desired) * (1.0 - right_contact)
        return (left_reward + right_reward) / 2.0

    # ---- Observation utilities ----

    def get_yaw(self, data: mjx.Data) -> jax.Array:
        """Extract yaw angle from root quaternion (qpos[3:7] = w,x,y,z)."""
        qw, qx, qy, qz = data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]
        return jp.arctan2(
            2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz)
        )

    def stack_obs_history(
        self, obs: jax.Array, obs_history: jax.Array
    ) -> jax.Array:
        """Push new obs into front of history buffer, shifting old ones back."""
        return jp.roll(obs_history, obs.size).at[: obs.size].set(obs)

    def apply_obs_noise(
        self, obs: jax.Array, rng: jax.Array
    ) -> jax.Array:
        """Add uniform noise to observation if configured."""
        if self._config.obs_noise > 0.0:
            noise = self._config.obs_noise * jax.random.uniform(
                rng, obs.shape, minval=-1.0, maxval=1.0
            )
            obs = jp.clip(obs, -100.0, 100.0) + noise
        return obs

    # ---- Properties ----

    @property
    def xml_path(self) -> str:
        return str(consts.SCENE_PRIMITIVES_XML)

    @property
    def action_size(self) -> int:
        return self._mjx_model.nu

    @property
    def mj_model(self) -> mujoco.MjModel:
        return self._mj_model

    @property
    def mjx_model(self) -> mjx.Model:
        return self._mjx_model
