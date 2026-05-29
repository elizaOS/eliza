"""Profile-driven text-conditioned env. One class, every supported robot.

`TextConditionedProfileEnv` reads `profile.kinematics.joints` to derive the
action vector, loads `profile.assets.mjcf_xml` for the simulator, builds
a uniform observation (proprio + task embedding), and applies a
task-conditional reward derived from `curriculum/tasks.yaml`.

It subsumes the older AiNex-specific `TextConditionedJoystickEnv` and the
Asimov-specific `TextConditionedAsimovEnv` so the unified training CLI in
`scripts/train_text_conditioned.py` and the inference loop in
`bridge/server.py:policy.start` can dispatch to any profile by id.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import gymnasium as gym
import numpy as np

from eliza_robot.curriculum.loader import Curriculum, TaskSpec, load_curriculum
from eliza_robot.profiles.schema import RobotProfile, load_profile
from eliza_robot.rl.text_conditioned.encoder import (
    TaskEmbedding,
    build_task_embeddings,
)

_LEG_GROUPS = ("LEG",)


@dataclass(frozen=True)
class ProfileEnvConfig:
    """Knobs that don't belong to the profile itself."""

    tier_subset: tuple[int, ...] = (1,)
    include_tasks: tuple[str, ...] = ()
    exclude_tasks: tuple[str, ...] = ("look_up", "look_down")
    pca_dim: int = 32
    episode_steps: int = 400
    control_dt_s: float = 0.02
    action_scale: float = 0.3
    locomotion_action_prior: str = "none"
    locomotion_prior_residual_scale: float = 1.0
    locomotion_prior_feedback_pitch: float = 0.0
    locomotion_prior_feedback_roll: float = 0.0
    locomotion_prior_feedback_yaw: float = 0.0
    text_obs_weight: float = 1.0
    action_groups: tuple[str, ...] = field(default_factory=lambda: _LEG_GROUPS)
    # Domain randomization, applied at every reset(). Modeled on
    # mujoco_playground's get_domain_randomizer envelope so policies
    # trained here can sim2sim to the playground env (and then sim2real).
    # Set domain_rand=False for deterministic eval / video recording.
    domain_rand: bool = False
    dr_friction_range: tuple[float, float] = (0.7, 1.3)
    dr_mass_scale_range: tuple[float, float] = (0.9, 1.1)
    dr_com_offset_m: float = 0.02
    dr_joint_damping_scale_range: tuple[float, float] = (0.8, 1.2)
    dr_imu_noise_std: float = 0.02
    dr_motor_gear_scale_range: tuple[float, float] = (0.9, 1.1)
    gait_cadence_hz: float = 1.5


class TextConditionedProfileEnv(gym.Env):
    """Profile-driven CPU env for text-conditioned PPO training.

    Observation layout::
        [gyro(3), gravity(3), velocity_cmd(3), root_linvel(3),
         foot_contact(2), foot_z(2), foot_slip_xy_speed(2), gait_phase(sin, cos),
         joint_qpos(action_dim),
         joint_qvel(action_dim),
         last_action(action_dim),
         text_embed(pca_dim)]
    Action layout::
        [-1, +1] joint deltas around the home pose for every joint whose
        ``group`` is in ``config.action_groups`` (defaults to ``LEG``).
    """

    metadata = {"render_modes": ["rgb_array"], "render_fps": 50}

    def __init__(
        self,
        profile_id: str,
        config: ProfileEnvConfig | None = None,
        *,
        curriculum: Curriculum | None = None,
        embeddings: dict[str, TaskEmbedding] | None = None,
    ) -> None:
        super().__init__()
        self.profile: RobotProfile = load_profile(profile_id)
        self.config = config or ProfileEnvConfig()
        self.curriculum = curriculum or load_curriculum()
        self.embeddings = embeddings or build_task_embeddings(
            curriculum=self.curriculum, pca_dim=self.config.pca_dim
        )

        active_groups = set(self.config.action_groups)
        action_joints = [
            j for j in self.profile.kinematics.joints if j.group in active_groups
        ]
        if not action_joints:
            raise ValueError(
                f"profile {profile_id!r} has no joints in groups "
                f"{sorted(active_groups)!r}"
            )
        self._action_joints = action_joints
        self._action_dim = len(action_joints)
        self._home_pose = np.array(
            [j.home_rad for j in action_joints], dtype=np.float32
        )
        self._lower = np.array([j.lower_rad for j in action_joints], dtype=np.float32)
        self._upper = np.array([j.upper_rad for j in action_joints], dtype=np.float32)

        candidates: list[TaskSpec] = []
        for task in self.curriculum.tasks:
            if self.config.tier_subset and task.tier not in self.config.tier_subset:
                continue
            if self.config.include_tasks and task.id not in self.config.include_tasks:
                continue
            if task.id in self.config.exclude_tasks:
                continue
            candidates.append(task)
        if not candidates:
            raise ValueError("config selected zero curriculum tasks")
        unsupported = [
            task.id
            for task in candidates
            if _task_requires_unsupported_profile_env_features(task)
        ]
        if unsupported:
            raise ValueError(
                "profile env cannot train unsupported task features for "
                f"{unsupported!r}; adjust include_tasks/exclude_tasks or add "
                "the required observation, reward, and action support first"
            )
        self.active_tasks = candidates
        self.task_ids = [task.id for task in candidates]

        # gyro + gravity + velocity command + measured root linvel
        # + foot/contact telemetry + (q, qv, last)
        proprio_dim = 3 + 3 + 3 + 3 + 8 + 3 * self._action_dim
        obs_dim = proprio_dim + self.config.pca_dim
        self.observation_space = gym.spaces.Box(
            low=-10.0, high=10.0, shape=(obs_dim,), dtype=np.float32
        )
        self.action_space = gym.spaces.Box(
            low=-1.0, high=1.0, shape=(self._action_dim,), dtype=np.float32
        )

        # Prefer scene_xml when present (it includes the bare MJCF plus a
        # ground plane, lights, and keyframes — without it the robot
        # starts floating in a black void and immediately falls).
        scene_path = self.profile.assets.scene_xml
        if scene_path is not None and scene_path.is_file():
            self._mjcf_path = Path(scene_path)
        else:
            self._mjcf_path = Path(self.profile.assets.mjcf_xml)
        self._model = None
        self._data = None
        self._joint_qpos_idx: list[int] = []
        self._joint_qvel_idx: list[int] = []
        self._joint_actuator_idx: list[int] = []
        self._profile_joint_qpos_idx: list[int] = []
        self._profile_joint_qvel_idx: list[int] = []
        self._profile_joint_actuator_idx: list[int] = []
        self._profile_joint_home: np.ndarray = np.zeros(0, dtype=np.float32)
        self._profile_joint_torque: np.ndarray = np.zeros(0, dtype=np.float32)
        self._root_qpos_idx = 0
        self._root_qvel_idx = 0
        self._current_task: TaskSpec | None = None
        self._current_embed = np.zeros(self.config.pca_dim, dtype=np.float32)
        self._previous_action = np.zeros(self._action_dim, dtype=np.float32)
        self._command_target = np.zeros(self._action_dim, dtype=np.float32)
        self._step_count = 0
        self._episode_start_x = 0.0
        self._episode_start_y = 0.0
        self._episode_start_yaw = 0.0
        self._episode_start_torso_z = 0.0
        self._episode_start_tracked_x = 0.0
        self._episode_start_tracked_y = 0.0
        self._episode_start_tracked_z = 0.0
        self._tracked_body_id = -1
        self._tracked_body_name = "root"
        # Per-profile fall envelope. The robot is "fallen" when the torso
        # drops below 60% of standing height OR pitches/rolls past 0.8 rad.
        # Standing height comes from the profile's gait spec — for AiNex
        # the torso starts low so we floor the threshold at 0.10 m.
        self._stand_height_m = max(
            0.05, float(self.profile.gait.default_height_m)
        )
        self._fall_z_threshold = max(0.10, 0.6 * self._stand_height_m)
        self._prev_action = np.zeros(self._action_dim, dtype=np.float32)
        self._foot_geom_ids: dict[str, np.ndarray] = {
            "left": np.zeros(0, dtype=np.int32),
            "right": np.zeros(0, dtype=np.int32),
        }
        self._floor_geom_ids = np.zeros(0, dtype=np.int32)
        self._prev_foot_xy = np.zeros((2, 2), dtype=np.float32)
        self._gait_phase = 0.0
        self._last_foot_telemetry = np.zeros(8, dtype=np.float32)
        self._last_reward_terms: dict[str, float] = {}
        self._last_single_foot_contact_state: str | None = None
        self._foot_contact_switch_count = 0
        self._max_swing_foot_clearance_m = 0.0
        self._max_foot_slip_m_s = 0.0

    # ------------------------------------------------------------------ mujoco

    def _ensure_model(self) -> None:
        if self._model is not None:
            return
        import mujoco

        self._model = mujoco.MjModel.from_xml_path(str(self._mjcf_path))
        self._data = mujoco.MjData(self._model)
        root_jid = mujoco.mj_name2id(
            self._model, mujoco.mjtObj.mjOBJ_JOINT, "root"
        )
        if root_jid < 0 or self._model.jnt_type[root_jid] != mujoco.mjtJoint.mjJNT_FREE:
            root_jid = next(
                (
                    jid
                    for jid in range(self._model.njnt)
                    if self._model.jnt_type[jid] == mujoco.mjtJoint.mjJNT_FREE
                ),
                -1,
            )
        if root_jid >= 0:
            self._root_qpos_idx = int(self._model.jnt_qposadr[root_jid])
            self._root_qvel_idx = int(self._model.jnt_dofadr[root_jid])
        for j in self.profile.kinematics.joints:
            jid = mujoco.mj_name2id(self._model, mujoco.mjtObj.mjOBJ_JOINT, j.name)
            if jid < 0:
                raise ValueError(
                    f"profile {self.profile.id!r}: joint {j.name!r} not in MJCF "
                    f"({self._mjcf_path}); regenerate the profile from the MJCF"
                )
            self._profile_joint_qpos_idx.append(int(self._model.jnt_qposadr[jid]))
            self._profile_joint_qvel_idx.append(int(self._model.jnt_dofadr[jid]))
            self._profile_joint_actuator_idx.append(
                _actuator_id_for_joint(self._model, jid, j.name)
            )
        self._profile_joint_home = np.array(
            [j.home_rad for j in self.profile.kinematics.joints], dtype=np.float32
        )
        self._profile_joint_torque = np.array(
            [max(1.0, float(j.actuator_torque_nm)) for j in self.profile.kinematics.joints],
            dtype=np.float32,
        )
        self._apply_profile_actuator_force_limits()
        action_names = {j.name for j in self._action_joints}
        for j, qpos_idx, qvel_idx, aid in zip(
            self.profile.kinematics.joints,
            self._profile_joint_qpos_idx,
            self._profile_joint_qvel_idx,
            self._profile_joint_actuator_idx,
            strict=True,
        ):
            if j.name in action_names:
                self._joint_qpos_idx.append(qpos_idx)
                self._joint_qvel_idx.append(qvel_idx)
                self._joint_actuator_idx.append(aid)
        # Build a per-actuator scratch vector. Position actuators consume
        # desired joint positions directly; torque motors consume PD torque
        # around the same target. Resolving actuators through joint bindings
        # matters for Unitree R1, whose actuators omit the joint-name suffix.
        self._default_ctrl = np.zeros(self._model.nu, dtype=np.float32)
        # Snapshot canonical dynamics params so domain randomization can
        # resample around the nominal value each reset.
        self._dr_canonical_body_mass = self._model.body_mass.copy()
        self._dr_canonical_body_ipos = self._model.body_ipos.copy()
        self._dr_canonical_geom_friction = self._model.geom_friction.copy()
        self._dr_canonical_dof_damping = self._model.dof_damping.copy()
        self._dr_canonical_actuator_gear = self._model.actuator_gear.copy()
        self._resolve_tracked_body()
        self._resolve_foot_contact_geoms()

    def _apply_profile_actuator_force_limits(self) -> None:
        """Apply profile torque contracts to position actuators.

        MuJoCo position actuators consume joint-angle targets in ``ctrl``.
        Without an explicit force limit they can apply unrealistically large
        servo forces while still looking like a bounded position command.  The
        profile already declares safe torque limits; enforce them in the CPU
        MuJoCo path as well as in MJX/realistic XMLs that carry forceranges.
        """
        if self._model is None:
            return
        safe_clip = max(1.0, float(self.profile.control.safe_torque_clip_nm))
        for aid, joint_torque in zip(
            self._profile_joint_actuator_idx,
            self._profile_joint_torque,
            strict=True,
        ):
            if aid < 0:
                continue
            if int(self._model.actuator_biastype[aid]) == 0:
                continue
            limit = max(1.0, min(safe_clip, float(joint_torque)))
            self._model.actuator_forcelimited[aid] = 1
            self._model.actuator_forcerange[aid, 0] = -limit
            self._model.actuator_forcerange[aid, 1] = limit

    # ------------------------------------------------------------------ gym API

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        self._ensure_model()
        import mujoco

        task = self.active_tasks[self.np_random.integers(len(self.active_tasks))]
        mujoco.mj_resetData(self._model, self._data)
        # Snap key 0 (typically "stand"/"home") if available.
        if self._model.nkey > 0:
            mujoco.mj_resetDataKeyframe(self._model, self._data, 0)
        self._apply_task_init_state(task)
        if self.config.domain_rand:
            self._apply_domain_randomization()
        self._place_task_init_state_on_floor(task)
        mujoco.mj_forward(self._model, self._data)
        self._validate_task_init_state(task)
        self._previous_action.fill(0.0)
        self._prev_action.fill(0.0)
        self._command_target = np.array(
            [self._data.qpos[qpos_idx] for qpos_idx in self._joint_qpos_idx],
            dtype=np.float32,
        )
        self._step_count = 0
        self._gait_phase = 0.0
        self._current_task = task
        self._current_embed = self.embeddings[task.id].reduced_embed.astype(np.float32)
        pose = self._root_pose_summary()
        tracked = self._tracked_pose_summary(pose)
        self._episode_start_x = pose["x"]
        self._episode_start_y = pose["y"]
        self._episode_start_yaw = pose["yaw"]
        self._episode_start_torso_z = pose["z"]
        self._episode_start_tracked_x = tracked["x"]
        self._episode_start_tracked_y = tracked["y"]
        self._episode_start_tracked_z = tracked["z"]
        self._prev_foot_xy = self._current_foot_xy()
        self._last_foot_telemetry = self._foot_telemetry()
        self._last_reward_terms = {}
        self._last_single_foot_contact_state = self._single_foot_contact_state(
            self._last_foot_telemetry
        )
        self._foot_contact_switch_count = 0
        self._max_swing_foot_clearance_m = self._current_swing_foot_clearance_m()
        self._max_foot_slip_m_s = 0.0
        pose = self._root_pose_summary()
        return self._build_obs(), {
            "task_id": task.id,
            "task_tier": task.tier,
            "init_state": task.init_state or "stand",
            "init_torso_z": pose["z"],
            "init_tracked_z": tracked["z"],
            "tracked_body_name": self._tracked_body_name,
            "init_upright_proj": pose["upright_proj"],
            "stand_height_m": self._stand_height_m,
        }

    def _apply_task_init_state(self, task: TaskSpec) -> None:
        """Apply light-weight curriculum reset states before mj_forward().

        These are intentionally simple and profile-generic. They are not a
        replacement for authored keyframes, but they make the training problem
        structurally honest: a sit-to-stand task starts low instead of already
        standing, and future prone tasks can fail loudly until their reset state
        is promoted from approximation to profile keyframe.
        """
        init_state = task.init_state
        if init_state in (None, "stand"):
            return
        root = self._root_qpos_idx
        if init_state in {"sit", "crouch"} and self._data.qpos.size > root + 2:
            extra = self._task_model_extra(task)
            if "init_torso_z_m" in extra:
                target_z = float(extra["init_torso_z_m"])
            else:
                target_z = self._stand_height_m * float(
                    extra.get("init_torso_height_ratio", 0.65)
                )
            self._data.qpos[root + 2] = target_z
            if self.profile.id == "hiwonder-ainex":
                self._set_hiwonder_crouch_joints(
                    hip_pitch=float(extra.get("init_hip_pitch_rad", -0.45)),
                    knee=float(extra.get("init_knee_rad", 0.85)),
                    ankle_pitch=float(extra.get("init_ankle_pitch_rad", -0.35)),
                )
            else:
                self._set_named_joint_if_present(
                    ("hip_pitch",),
                    float(extra.get("init_hip_pitch_rad", -0.45)),
                )
                self._set_named_joint_if_present(
                    ("knee",),
                    float(extra.get("init_knee_rad", 0.85)),
                )
                self._set_named_joint_if_present(
                    ("ank_pitch", "ankle_pitch"),
                    float(extra.get("init_ankle_pitch_rad", -0.35)),
                )
            return
        if init_state == "prone" and self._data.qpos.size > root + 6:
            extra = self._task_model_extra(task)
            if "init_torso_z_m" in extra:
                target_z = float(extra["init_torso_z_m"])
            else:
                target_z = self._stand_height_m * float(
                    extra.get("init_torso_height_ratio", 0.25)
                )
            self._data.qpos[root + 2] = target_z
            # MuJoCo free-joint quaternion [w, x, y, z], rotate 90deg about X.
            self._data.qpos[root + 3: root + 7] = np.array(
                [math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0],
                dtype=self._data.qpos.dtype,
            )
            return
        raise ValueError(
            f"task {task.id!r} requests unsupported init_state={init_state!r}"
        )

    def _task_model_extra(self, task: TaskSpec) -> dict:
        extra = dict(task.model_extra or {})
        profile_init = extra.pop("profile_init", None)
        if isinstance(profile_init, dict):
            override = profile_init.get(self.profile.id)
            if isinstance(override, dict):
                extra.update(override)
        return extra

    def _set_hiwonder_crouch_joints(
        self,
        *,
        hip_pitch: float,
        knee: float,
        ankle_pitch: float,
    ) -> None:
        hip_value = float(hip_pitch)
        knee_value = float(knee)
        ankle_value = float(ankle_pitch)
        for joint, qpos_idx in zip(
            self.profile.kinematics.joints,
            self._profile_joint_qpos_idx,
            strict=True,
        ):
            name = joint.name.lower()
            if "hip_pitch" in name:
                self._data.qpos[qpos_idx] = hip_value
            elif "knee" in name:
                self._data.qpos[qpos_idx] = knee_value
            elif "ank_pitch" in name or "ankle_pitch" in name:
                self._data.qpos[qpos_idx] = ankle_value

    def _place_task_init_state_on_floor(self, task: TaskSpec) -> None:
        if (
            task.id != "stand_up"
            or task.init_state not in {"sit", "crouch"}
            or self.profile.id != "hiwonder-ainex"
        ):
            return
        if self._data.qpos.size <= self._root_qpos_idx + 2:
            return
        import mujoco

        clearance_m = float(self._task_model_extra(task).get("init_foot_clearance_m", 0.002))
        for _ in range(4):
            mujoco.mj_forward(self._model, self._data)
            foot_z = self._current_foot_z()
            finite_foot_z = foot_z[np.isfinite(foot_z)]
            if finite_foot_z.size == 0:
                return
            correction = clearance_m - float(np.min(finite_foot_z))
            self._data.qpos[self._root_qpos_idx + 2] += correction
            if abs(correction) < 1e-4:
                break
        self._data.qvel[:] = 0.0

    def _validate_task_init_state(self, task: TaskSpec) -> None:
        if task.id != "stand_up" or task.init_state not in {"sit", "crouch"}:
            return
        pose = self._root_pose_summary()
        extra = self._task_model_extra(task)
        min_drop = max(
            float(extra.get("min_init_stand_height_drop_m", 0.03)),
            self._stand_height_m
            * float(extra.get("min_init_stand_height_drop_ratio", 0.0)),
        )
        actual_drop = self._stand_height_m - pose["z"]
        if actual_drop < min_drop:
            raise ValueError(
                f"profile {self.profile.id!r} cannot start stand_up from a "
                f"meaningful crouch: drop={actual_drop:.3f}m < {min_drop:.3f}m"
            )
        contacts = self._foot_contacts()
        if self._foot_geom_ids["left"].size and contacts[0] < 0.5:
            raise ValueError(
                f"profile {self.profile.id!r} stand_up crouch reset has no left "
                "foot-floor contact"
            )
        if self._foot_geom_ids["right"].size and contacts[1] < 0.5:
            raise ValueError(
                f"profile {self.profile.id!r} stand_up crouch reset has no right "
                "foot-floor contact"
            )
        if pose["upright_proj"] <= 0.0:
            raise ValueError(
                f"profile {self.profile.id!r} stand_up crouch reset is not upright"
            )

    def _set_named_joint_if_present(
        self,
        name_fragments: tuple[str, ...],
        value: float,
    ) -> None:
        for joint, qpos_idx in zip(
            self.profile.kinematics.joints,
            self._profile_joint_qpos_idx,
            strict=True,
        ):
            lowered = joint.name.lower()
            if any(fragment in lowered for fragment in name_fragments):
                self._data.qpos[qpos_idx] = float(np.clip(value, joint.lower_rad, joint.upper_rad))

    def _apply_domain_randomization(self) -> None:
        """Resample friction / mass / COM / damping / motor gear around the
        canonical values. Modeled on mujoco_playground's randomizer so
        policies trained here transfer to MJX-Brax training and onward to
        the real robot."""
        cfg = self.config
        rng = self.np_random
        m = self._model
        fl, fh = cfg.dr_friction_range
        ml, mh = cfg.dr_mass_scale_range
        dl, dh = cfg.dr_joint_damping_scale_range
        gl, gh = cfg.dr_motor_gear_scale_range

        friction_scale = float(rng.uniform(fl, fh))
        m.geom_friction[:] = self._dr_canonical_geom_friction * np.array(
            [friction_scale, 1.0, 1.0], dtype=m.geom_friction.dtype
        )

        mass_scale = rng.uniform(ml, mh, size=m.body_mass.shape).astype(
            m.body_mass.dtype
        )
        m.body_mass[:] = self._dr_canonical_body_mass * mass_scale

        com_offset = rng.uniform(
            -cfg.dr_com_offset_m, cfg.dr_com_offset_m, size=m.body_ipos.shape
        ).astype(m.body_ipos.dtype)
        m.body_ipos[:] = self._dr_canonical_body_ipos + com_offset

        damping_scale = rng.uniform(dl, dh, size=m.dof_damping.shape).astype(
            m.dof_damping.dtype
        )
        m.dof_damping[:] = self._dr_canonical_dof_damping * damping_scale

        gear_scale = rng.uniform(gl, gh, size=m.actuator_gear.shape).astype(
            m.actuator_gear.dtype
        )
        m.actuator_gear[:] = self._dr_canonical_actuator_gear * gear_scale

    def step(self, action: np.ndarray):
        assert self._current_task is not None
        self._ensure_model()
        import mujoco

        clipped = np.clip(np.asarray(action, dtype=np.float32), -1.0, 1.0)
        effective_action = self._apply_locomotion_action_prior(clipped)
        self._prev_action = self._previous_action.copy()
        self._previous_action = effective_action.copy()
        target = self._home_pose + effective_action * self.config.action_scale
        target = np.clip(target, self._lower, self._upper)
        target = self._apply_profile_command_filter(target)
        self._write_joint_targets(target)
        n_substeps = max(1, int(round(self.config.control_dt_s / self._model.opt.timestep)))
        for _ in range(n_substeps):
            mujoco.mj_step(self._model, self._data)
        self._step_count += 1
        self._gait_phase = _wrap_2pi(
            self._gait_phase
            + 2.0 * math.pi * self.config.gait_cadence_hz * self.config.control_dt_s
        )
        self._last_foot_telemetry = self._foot_telemetry()
        self._update_foot_contact_switch_count()
        self._max_swing_foot_clearance_m = max(
            self._max_swing_foot_clearance_m,
            self._current_swing_foot_clearance_m(),
        )
        self._max_foot_slip_m_s = max(
            self._max_foot_slip_m_s,
            float(np.max(self._last_foot_telemetry[4:6])),
        )
        obs = self._build_obs()
        pose = self._root_pose_summary()
        torso_z = pose["z"]
        upright_proj = pose["upright_proj"]
        roll = pose["roll"]
        pitch = pose["pitch"]
        fall_z_threshold = self._fall_z_threshold_for_current_task()
        fall_pitch = 0.6
        fall_roll = 0.6
        if self._current_task is not None:
            fall_pitch = float(self._current_task.success.get("fall_pitch_rad", fall_pitch))
            fall_roll = float(self._current_task.success.get("fall_roll_rad", fall_roll))
        prone_tilt_exempt = (
            self._current_task is not None
            and self._current_task.init_state == "prone"
            and self._current_task.id == "lie_down"
        )
        tilt_fall = (
            not prone_tilt_exempt
            and (abs(pitch) > fall_pitch or abs(roll) > fall_roll)
        )
        terminated = bool(torso_z < fall_z_threshold or upright_proj < 0.0 or tilt_fall)
        truncated = not terminated and self._step_count >= self.config.episode_steps
        reward = self._reward(clipped, pose=pose, fell=terminated)
        tracked = self._tracked_pose_summary(pose)
        elapsed_s = max(self._step_count * self.config.control_dt_s, 1e-6)
        dx = pose["x"] - self._episode_start_x
        dy = pose["y"] - self._episode_start_y
        dyaw = _wrap_pi(pose["yaw"] - self._episode_start_yaw)
        tracked_dx = tracked["x"] - self._episode_start_tracked_x
        tracked_dy = tracked["y"] - self._episode_start_tracked_y
        tracked_dz = tracked["z"] - self._episode_start_tracked_z
        success_bound_violation = self._success_bound_violation_score(dx, dy, dyaw)
        success_predicate_now = self._immediate_success_predicate_holds(pose)
        self_collision_count = self._self_collision_count()
        done_reason = None
        if terminated:
            done_reason = "fall"
        elif truncated:
            done_reason = "time_limit"
        return (
            obs,
            float(reward),
            terminated,
            truncated,
            {
                "task_id": self._current_task.id,
                "torso_z": torso_z,
                "upright_proj": upright_proj,
                "root_x": pose["x"],
                "root_y": pose["y"],
                "root_yaw": pose["yaw"],
                "tracked_body_name": self._tracked_body_name,
                "tracked_x": tracked["x"],
                "tracked_y": tracked["y"],
                "tracked_z": tracked["z"],
                "imu_roll": roll,
                "imu_pitch": pitch,
                "delta_x": dx,
                "delta_y": dy,
                "delta_yaw": dyaw,
                "tracked_delta_x": tracked_dx,
                "tracked_delta_y": tracked_dy,
                "tracked_delta_z": tracked_dz,
                "vx": dx / elapsed_s,
                "vy": dy / elapsed_s,
                "yaw_rate": dyaw / elapsed_s,
                "left_foot_contact": bool(self._last_foot_telemetry[0] > 0.5),
                "right_foot_contact": bool(self._last_foot_telemetry[1] > 0.5),
                "foot_contact_switch_count": int(self._foot_contact_switch_count),
                "left_foot_z": float(self._last_foot_telemetry[2]),
                "right_foot_z": float(self._last_foot_telemetry[3]),
                "left_foot_slip_m_s": float(self._last_foot_telemetry[4]),
                "right_foot_slip_m_s": float(self._last_foot_telemetry[5]),
                "max_swing_foot_clearance_m": float(self._max_swing_foot_clearance_m),
                "max_foot_slip_m_s": float(self._max_foot_slip_m_s),
                "gait_phase": self._gait_phase,
                "init_torso_z": self._episode_start_torso_z,
                "stand_height_m": self._stand_height_m,
                "fall_threshold": fall_z_threshold,
                "done_reason": done_reason,
                "success_predicate_now": success_predicate_now,
                "success_bounds_violated": success_bound_violation > 0.0,
                "success_bound_violation": success_bound_violation,
                "reward_terms": dict(self._last_reward_terms),
                "self_collision_count": self_collision_count,
                "raw_action_max_abs": float(np.max(np.abs(clipped))) if clipped.size else 0.0,
                "effective_action_max_abs": float(np.max(np.abs(effective_action)))
                if effective_action.size
                else 0.0,
                "locomotion_action_prior": self.config.locomotion_action_prior,
            },
        )

    def _apply_locomotion_action_prior(self, action: np.ndarray) -> np.ndarray:
        if (
            self.config.locomotion_action_prior == "none"
            or self._current_task is None
            or not _is_locomotion_reward(self._current_task.reward)
        ):
            return action
        if self.config.locomotion_action_prior == "gait":
            prior = self._locomotion_gait_prior_action()
        elif self.config.locomotion_action_prior == "hiwonder_sine":
            prior = self._locomotion_hiwonder_sine_prior_action()
        else:
            raise ValueError(
                "locomotion_action_prior must be one of: none, gait, hiwonder_sine"
            )
        prior = self._apply_locomotion_prior_balance_feedback(prior)
        residual_scale = float(self.config.locomotion_prior_residual_scale)
        return np.clip(prior + residual_scale * action, -1.0, 1.0).astype(np.float32)

    def _apply_locomotion_prior_balance_feedback(self, action: np.ndarray) -> np.ndarray:
        pitch_gain = float(self.config.locomotion_prior_feedback_pitch)
        roll_gain = float(self.config.locomotion_prior_feedback_roll)
        yaw_gain = float(self.config.locomotion_prior_feedback_yaw)
        if pitch_gain == 0.0 and roll_gain == 0.0 and yaw_gain == 0.0:
            return action
        pose = self._root_pose_summary()
        pitch = float(pose.get("pitch", 0.0))
        roll = float(pose.get("roll", 0.0))
        yaw = _wrap_pi(float(pose.get("yaw", 0.0)) - self._episode_start_yaw)
        corrected = action.copy()
        for idx, joint in enumerate(self._action_joints):
            name = joint.name.lower()
            side = 1.0 if name.startswith("l_") else -1.0
            if "hip_pitch" in name:
                corrected[idx] += side * pitch_gain * pitch
            elif "ank_pitch" in name:
                corrected[idx] -= side * pitch_gain * pitch
            elif "hip_roll" in name:
                corrected[idx] += side * roll_gain * roll
            elif "ank_roll" in name:
                corrected[idx] -= side * roll_gain * roll
            elif "hip_yaw" in name:
                corrected[idx] -= side * yaw_gain * yaw
        return np.clip(corrected, -1.0, 1.0).astype(np.float32)

    def _apply_profile_command_filter(self, target: np.ndarray) -> np.ndarray:
        """Apply profile-declared servo slew limits before writing controls."""
        target = np.asarray(target, dtype=np.float32)
        if self._command_target.shape != target.shape:
            self._command_target = target.copy()
            return target
        max_delta = float(self.profile.control.max_joint_delta_rad_per_step)
        if max_delta > 0.0:
            delta = np.clip(target - self._command_target, -max_delta, max_delta)
            target = self._command_target + delta
        smoothing = float(self.profile.control.command_smoothing)
        if smoothing > 0.0:
            smoothing = float(np.clip(smoothing, 0.0, 1.0))
            target = smoothing * self._command_target + (1.0 - smoothing) * target
        target = np.clip(target, self._lower, self._upper).astype(np.float32)
        self._command_target = target.copy()
        return target

    def _fall_z_threshold_for_current_task(self) -> float:
        if self._current_task is None:
            return self._fall_z_threshold
        if self._current_task.init_state in {"sit", "crouch", "prone"}:
            return min(self._fall_z_threshold, max(0.03, 0.75 * self._episode_start_torso_z))
        return self._fall_z_threshold

    def _write_joint_targets(self, action_targets: np.ndarray) -> None:
        """Write controls for all profiled joints.

        Some MJCFs use MuJoCo position actuators, where ``ctrl`` is a target
        angle. Unitree H1/R1 expose torque motors instead, where writing an
        angle into ``ctrl`` is just a tiny torque and the robot collapses.
        This method keeps the profile interface position-based while adapting
        each simulator actuator to the control mode it actually implements.
        """
        self._data.ctrl[:] = self._default_ctrl
        action_by_qpos = {
            qpos_idx: float(target)
            for qpos_idx, target in zip(self._joint_qpos_idx, action_targets, strict=True)
        }
        for qpos_idx, qvel_idx, aid, home, torque_limit in zip(
            self._profile_joint_qpos_idx,
            self._profile_joint_qvel_idx,
            self._profile_joint_actuator_idx,
            self._profile_joint_home,
            self._profile_joint_torque,
            strict=True,
        ):
            if aid < 0:
                continue
            target = action_by_qpos.get(qpos_idx, float(home))
            if int(self._model.actuator_biastype[aid]) != 0:
                self._data.ctrl[aid] = target
                continue
            q = float(self._data.qpos[qpos_idx])
            qv = float(self._data.qvel[qvel_idx])
            kp = min(220.0, max(35.0, 3.0 * float(torque_limit)))
            kd = min(12.0, max(1.5, 0.08 * kp))
            ctrl = kp * (target - q) - kd * qv
            lo, hi = (float(x) for x in self._model.actuator_ctrlrange[aid])
            if lo < hi:
                ctrl = float(np.clip(ctrl, lo, hi))
            self._data.ctrl[aid] = ctrl

    def _root_pose_summary(self) -> dict[str, float]:
        root = self._root_qpos_idx
        root_x = float(self._data.qpos[root]) if self._data.qpos.size > root else 0.0
        root_y = float(self._data.qpos[root + 1]) if self._data.qpos.size > root + 1 else 0.0
        torso_z = float(self._data.qpos[root + 2]) if self._data.qpos.size > root + 2 else 0.0
        # Body tilt: project gravity into the torso frame. xyaxes derived
        # from the free joint orientation; if quat is [w,x,y,z] then
        # gravity_local_z = 1 - 2*(x^2 + y^2). >0.7 means mostly upright.
        if self._data.qpos.size >= root + 7:
            qw, qx, qy, qz = (float(self._data.qpos[root + i]) for i in (3, 4, 5, 6))
            upright_proj = 1.0 - 2.0 * (qx * qx + qy * qy)
            sinr_cosp = 2.0 * (qw * qx + qy * qz)
            cosr_cosp = 1.0 - 2.0 * (qx * qx + qy * qy)
            roll = math.atan2(sinr_cosp, cosr_cosp)
            sinp = 2.0 * (qw * qy - qz * qx)
            pitch = math.asin(float(np.clip(sinp, -1.0, 1.0)))
            yaw = math.atan2(
                2.0 * (qw * qz + qx * qy),
                1.0 - 2.0 * (qy * qy + qz * qz),
            )
        else:
            upright_proj = 1.0
            roll = 0.0
            pitch = 0.0
            yaw = 0.0
        return {
            "x": root_x,
            "y": root_y,
            "z": torso_z,
            "yaw": yaw,
            "roll": roll,
            "pitch": pitch,
            "upright_proj": upright_proj,
        }

    def _resolve_tracked_body(self) -> None:
        import mujoco

        self._tracked_body_id = -1
        self._tracked_body_name = "root"
        tracking_body = self.profile.sensors.locomotion_tracking_body
        if not tracking_body:
            return
        for body_name in (str(tracking_body),):
            body_id = mujoco.mj_name2id(
                self._model,
                mujoco.mjtObj.mjOBJ_BODY,
                body_name,
            )
            if body_id >= 0:
                self._tracked_body_id = int(body_id)
                self._tracked_body_name = body_name
                return

    def _tracked_pose_summary(self, root_pose: dict[str, float]) -> dict[str, float]:
        if self._tracked_body_id >= 0:
            xpos = np.asarray(self._data.xpos[self._tracked_body_id], dtype=np.float64)
            return {"x": float(xpos[0]), "y": float(xpos[1]), "z": float(xpos[2])}
        return {
            "x": float(root_pose["x"]),
            "y": float(root_pose["y"]),
            "z": float(root_pose["z"]),
        }

    def _resolve_foot_contact_geoms(self) -> None:
        import mujoco

        declared = self.profile.contact
        if declared is not None:
            self._floor_geom_ids = _resolve_declared_geom_names(
                self._model,
                declared.floor_geom_names,
                label="floor",
            )
            self._foot_geom_ids = {
                "left": _resolve_declared_contact_geoms(
                    self._model,
                    geom_names=declared.left_foot_geom_names,
                    body_names=declared.left_foot_body_names,
                    label="left foot",
                ),
                "right": _resolve_declared_contact_geoms(
                    self._model,
                    geom_names=declared.right_foot_geom_names,
                    body_names=declared.right_foot_body_names,
                    label="right foot",
                ),
            }
            return

        foot_terms = ("foot", "toe", "sole")
        left_ids: list[int] = []
        right_ids: list[int] = []
        floor_ids: list[int] = []
        for geom_id in range(self._model.ngeom):
            geom_name = (
                mujoco.mj_id2name(self._model, mujoco.mjtObj.mjOBJ_GEOM, geom_id)
                or ""
            )
            body_id = int(self._model.geom_bodyid[geom_id])
            body_name = (
                mujoco.mj_id2name(self._model, mujoco.mjtObj.mjOBJ_BODY, body_id)
                or ""
            )
            lowered = f"{geom_name} {body_name}".lower()
            if (
                int(self._model.geom_type[geom_id])
                == int(mujoco.mjtGeom.mjGEOM_PLANE)
                or "floor" in lowered
                or "ground" in lowered
            ):
                floor_ids.append(geom_id)
            if not any(term in lowered for term in foot_terms):
                continue
            if _name_has_side(lowered, "left"):
                left_ids.append(geom_id)
            elif _name_has_side(lowered, "right"):
                right_ids.append(geom_id)

        self._foot_geom_ids = {
            "left": np.asarray(left_ids, dtype=np.int32),
            "right": np.asarray(right_ids, dtype=np.int32),
        }
        self._floor_geom_ids = np.asarray(floor_ids, dtype=np.int32)

    def render(self):
        return None

    # ------------------------------------------------------------------ helpers

    def _build_obs(self) -> np.ndarray:
        root_v = self._root_qvel_idx
        if self._data.qvel.size > root_v + 5:
            root_linvel = np.asarray(
                self._data.qvel[root_v: root_v + 3],
                dtype=np.float32,
            )
            gyro = np.asarray(
                self._data.qvel[root_v + 3: root_v + 6],
                dtype=np.float32,
            )
        else:
            root_linvel = np.zeros(3, dtype=np.float32)
            gyro = np.zeros(3, dtype=np.float32)
        if self.config.domain_rand and self.config.dr_imu_noise_std > 0:
            gyro = (
                gyro
                + self.np_random.normal(
                    0.0, self.config.dr_imu_noise_std, size=3
                ).astype(np.float32)
            )
        gravity = self._local_gravity_obs()
        velocity_command = np.zeros(3, dtype=np.float32)
        if self._current_task is not None:
            r = self._current_task.reward
            velocity_command[0] = float(r.get("target_velocity_x_m_s", 0.0))
            velocity_command[1] = float(r.get("target_velocity_y_m_s", 0.0))
            velocity_command[2] = float(r.get("target_yaw_rate_rad_s", 0.0))
        qpos = np.asarray(
            [self._data.qpos[i] for i in self._joint_qpos_idx], dtype=np.float32
        )
        qvel = np.asarray(
            [self._data.qvel[i] for i in self._joint_qvel_idx], dtype=np.float32
        )
        text = _pad_or_trim(self._current_embed, self.config.pca_dim) * self.config.text_obs_weight
        return np.concatenate(
            [
                gyro,
                gravity,
                velocity_command,
                root_linvel,
                self._last_foot_telemetry,
                qpos,
                qvel,
                self._previous_action,
                text,
            ]
        ).astype(np.float32)

    def _local_gravity_obs(self) -> np.ndarray:
        root = self._root_qpos_idx
        if self._data.qpos.size < root + 7:
            return np.array([0.0, 0.0, 1.0], dtype=np.float32)
        qw, qx, qy, qz = (float(self._data.qpos[root + i]) for i in (3, 4, 5, 6))
        # Rotate world-up into the body frame with q^-1 * [0, 0, 1] * q.
        return np.array(
            [
                2.0 * (qx * qz - qw * qy),
                2.0 * (qw * qx + qy * qz),
                1.0 - 2.0 * (qx * qx + qy * qy),
            ],
            dtype=np.float32,
        )

    def _foot_telemetry(self) -> np.ndarray:
        contacts = self._foot_contacts()
        foot_xy = self._current_foot_xy()
        if self._prev_foot_xy.shape != foot_xy.shape:
            self._prev_foot_xy = foot_xy.copy()
        slip = np.linalg.norm(foot_xy - self._prev_foot_xy, axis=1) / max(
            self.config.control_dt_s, 1e-6
        )
        slip = slip * contacts
        self._prev_foot_xy = foot_xy.copy()
        foot_z = self._current_foot_z()
        return np.array(
            [
                contacts[0],
                contacts[1],
                foot_z[0],
                foot_z[1],
                slip[0],
                slip[1],
                math.sin(self._gait_phase),
                math.cos(self._gait_phase),
            ],
            dtype=np.float32,
        )

    def _foot_contacts(self) -> np.ndarray:
        contacts = np.zeros(2, dtype=np.float32)
        if self._floor_geom_ids.size == 0:
            return contacts
        floor_ids = set(int(x) for x in self._floor_geom_ids)
        foot_sets = [
            set(int(x) for x in self._foot_geom_ids["left"]),
            set(int(x) for x in self._foot_geom_ids["right"]),
        ]
        if not foot_sets[0] and not foot_sets[1]:
            return contacts
        for idx in range(int(self._data.ncon)):
            contact = self._data.contact[idx]
            pair = {int(contact.geom1), int(contact.geom2)}
            if not pair & floor_ids:
                continue
            for side_idx, foot_ids in enumerate(foot_sets):
                if pair & foot_ids:
                    contacts[side_idx] = 1.0
        return contacts

    def _current_foot_xy(self) -> np.ndarray:
        xy = np.zeros((2, 2), dtype=np.float32)
        for side_idx, side in enumerate(("left", "right")):
            geom_ids = self._foot_geom_ids[side]
            if geom_ids.size:
                xy[side_idx] = np.mean(self._data.geom_xpos[geom_ids, :2], axis=0)
        return xy

    def _current_foot_z(self) -> np.ndarray:
        z = np.zeros(2, dtype=np.float32)
        for side_idx, side in enumerate(("left", "right")):
            geom_ids = self._foot_geom_ids[side]
            if geom_ids.size:
                z[side_idx] = float(np.min(self._data.geom_xpos[geom_ids, 2]))
        return z

    def _reward(
        self,
        action: np.ndarray,
        *,
        pose: dict[str, float],
        fell: bool,
    ) -> float:
        """Composite reward shaped to discourage the "fall-fast, collect
        upright_bonus" local optimum:

          - alive(1.0)              : per-step bonus, lost on termination
          - height_track(1.0)       : Gaussian on torso_z vs standing height
          - velocity_track          : Gaussian on vx/vy command error
          - yaw_track               : Gaussian on yaw-rate command error
          - upright_proj(0.5)       : torso-z axis projection on world up
          - action_rate_penalty     : 0.01 * ||a_t - a_{t-1}||^2
          - energy_penalty          : 0.001 * sum(a^2)
          - success_bonus           : only when declared predicates hold now
          - fall_penalty(-25)       : applied once at termination

        The alive + height_track terms make standing the dominant strategy
        from step 1, but velocity_track requires actual locomotion, so PPO
        has signal to climb past the trivial standstill. The success bonus is
        deliberately based on the same immediate task predicates as the
        validator, without satisfying hold_s by itself.
        """
        assert self._current_task is not None
        r = self._current_task.reward
        crit = self._current_task.success
        torso_z = pose["z"]
        upright_proj = pose["upright_proj"]
        vx_target = float(r.get("target_velocity_x_m_s", 0.0))
        vy_target = float(r.get("target_velocity_y_m_s", 0.0))
        yaw_target = float(r.get("target_yaw_rate_rad_s", 0.0))
        root_v = self._root_qvel_idx
        vx_world = float(self._data.qvel[root_v]) if self._data.qvel.size > root_v else 0.0
        vy_world = (
            float(self._data.qvel[root_v + 1])
            if self._data.qvel.size > root_v + 1
            else 0.0
        )
        cos_yaw = math.cos(pose["yaw"])
        sin_yaw = math.sin(pose["yaw"])
        vx_actual = cos_yaw * vx_world + sin_yaw * vy_world
        vy_actual = -sin_yaw * vx_world + cos_yaw * vy_world
        yaw_actual = float(self._data.qvel[root_v + 5]) if self._data.qvel.size > root_v + 5 else 0.0
        velocity_terms: list[float] = []
        if "target_velocity_x_m_s" in r:
            velocity_terms.append(_tracking_reward(vx_actual, vx_target, r))
        if "target_velocity_y_m_s" in r:
            velocity_terms.append(_tracking_reward(vy_actual, vy_target, r))
        velocity_track = float(np.mean(velocity_terms)) if velocity_terms else 0.0
        yaw_track = 0.0
        if "target_yaw_rate_rad_s" in r:
            yaw_track = _tracking_reward(yaw_actual, yaw_target, r, default_min_sigma=0.15)
        height_target = float(
            r.get(
                "torso_height_target_m",
                self._stand_height_m * float(r.get("torso_height_target_ratio", 1.0)),
            )
        )
        height_tol = float(
            r.get(
                "torso_height_tolerance_m",
                self._stand_height_m * float(r.get("torso_height_tolerance_ratio", 0.12)),
            )
        )
        height_tol = max(height_tol, 1e-3)
        height_track = float(
            np.exp(-((torso_z - height_target) ** 2) / (2.0 * height_tol * height_tol))
        )
        foot_telemetry = self._last_foot_telemetry
        contact_cadence = _contact_cadence_reward(
            foot_telemetry[:2], self._gait_phase
        )
        stance_contact = _stance_contact_reward(foot_telemetry[:2], self._gait_phase)
        foot_clearance = _foot_clearance_reward(
            foot_telemetry[2:4],
            foot_telemetry[:2],
            self._gait_phase,
            self.profile.gait.swing_height_m,
        )
        foot_slip = float(np.sum(foot_telemetry[4:6]))
        foot_spacing_penalty = self._foot_spacing_penalty()
        self_collision_count = self._self_collision_count()
        gait_prior_track = 0.0
        if "target_velocity_x_m_s" in r or "target_velocity_y_m_s" in r:
            gait_prior = self._locomotion_gait_prior_action()
            gait_prior_error = float(np.mean((action - gait_prior) ** 2))
            gait_prior_track = float(np.exp(-gait_prior_error / 0.08))
        upright_bonus = float(max(0.0, upright_proj))
        fall_pitch = float(crit.get("fall_pitch_rad", 0.6))
        fall_roll = float(crit.get("fall_roll_rad", 0.6))
        tilt_margin_penalty = 0.0
        locomotion_stability_scale = 1.0
        if bool(crit.get("no_fall", False)):
            pitch_ratio = abs(float(pose.get("pitch", 0.0))) / max(fall_pitch, 1e-6)
            roll_ratio = abs(float(pose.get("roll", 0.0))) / max(fall_roll, 1e-6)
            # Open-loop probes repeatedly reach the target displacement and then
            # fail just past the roll/pitch fall boundary. Penalize the margin
            # before termination so learning is not rewarded for unstable lunges.
            tilt_margin_penalty = max(0.0, pitch_ratio - 0.65) ** 2 + max(
                0.0,
                roll_ratio - 0.65,
            ) ** 2
            if _is_locomotion_reward(r):
                tilt_ratio = max(pitch_ratio, roll_ratio)
                height_ratio = torso_z / max(height_target, 1e-6)
                tilt_scale = float(np.clip((0.92 - tilt_ratio) / 0.27, 0.0, 1.0))
                height_scale = float(np.clip((height_ratio - 0.75) / 0.20, 0.0, 1.0))
                locomotion_stability_scale = min(tilt_scale, height_scale)
        action_rate = float(np.mean((action - self._prev_action) ** 2))
        energy = float(np.mean(action**2))
        dyaw = _wrap_pi(pose["yaw"] - self._episode_start_yaw)
        tracked = self._tracked_pose_summary(pose)
        tracked_dx = tracked["x"] - self._episode_start_tracked_x
        tracked_dy = tracked["y"] - self._episode_start_tracked_y
        if _is_locomotion_reward(r) and "max_abs_delta_yaw_rad" in crit:
            yaw_bound = max(float(crit["max_abs_delta_yaw_rad"]), 1e-6)
            yaw_ratio = abs(dyaw) / yaw_bound
            yaw_scale = float(np.clip((1.0 - yaw_ratio) / 0.5, 0.0, 1.0))
            locomotion_stability_scale = min(locomotion_stability_scale, yaw_scale)
        progress = 0.0
        directional_progress = 0.0
        if "delta_x_m_min" in crit:
            directional_progress = max(
                directional_progress,
                _clamped_ratio(tracked_dx, float(crit["delta_x_m_min"])),
            )
            progress += directional_progress
        if "delta_x_m_max" in crit:
            directional_progress = max(
                directional_progress,
                _clamped_ratio(-tracked_dx, abs(float(crit["delta_x_m_max"]))),
            )
            progress += directional_progress
        if "delta_y_m_min" in crit:
            directional_progress = max(
                directional_progress,
                _clamped_ratio(tracked_dy, float(crit["delta_y_m_min"])),
            )
            progress += directional_progress
        if "delta_y_m_max" in crit:
            directional_progress = max(
                directional_progress,
                _clamped_ratio(-tracked_dy, abs(float(crit["delta_y_m_max"]))),
            )
            progress += directional_progress
        if "delta_yaw_rad_min" in crit:
            progress += _clamped_ratio(dyaw, float(crit["delta_yaw_rad_min"]))
        if "delta_yaw_rad_max" in crit:
            progress += _clamped_ratio(-dyaw, abs(float(crit["delta_yaw_rad_max"])))
        if "abs_delta_yaw_rad_min" in crit:
            progress += _clamped_ratio(abs(dyaw), float(crit["abs_delta_yaw_rad_min"]))
        if "target_yaw_change_rad" in r:
            progress += _clamped_ratio(abs(dyaw), abs(float(r["target_yaw_change_rad"])))
        if "progress_weight" in r and self._episode_start_torso_z != 0.0:
            needed = max(height_target - self._episode_start_torso_z, 1e-3)
            progress += _clamped_ratio(torso_z - self._episode_start_torso_z, needed) * float(
                r["progress_weight"]
            )
        gait_prior_direction_scale = min(directional_progress, 1.0)
        drift_penalty = 0.0
        if "max_lateral_drift_m" in crit:
            excess = max(0.0, abs(tracked_dy) - float(crit["max_lateral_drift_m"]))
            drift_penalty += 40.0 * excess
        if "max_forward_drift_m" in crit:
            excess = max(0.0, abs(tracked_dx) - float(crit["max_forward_drift_m"]))
            drift_penalty += 40.0 * excess
        if "max_abs_delta_x_m" in crit:
            excess = max(0.0, abs(tracked_dx) - float(crit["max_abs_delta_x_m"]))
            drift_penalty += 40.0 * excess
        if "max_abs_delta_y_m" in crit:
            excess = max(0.0, abs(tracked_dy) - float(crit["max_abs_delta_y_m"]))
            drift_penalty += 40.0 * excess
        if "max_translation_drift_m" in crit:
            excess = max(
                0.0,
                math.hypot(tracked_dx, tracked_dy) - float(crit["max_translation_drift_m"]),
            )
            drift_penalty += 40.0 * excess
        if "max_abs_delta_yaw_rad" in crit:
            excess = max(0.0, abs(dyaw) - float(crit["max_abs_delta_yaw_rad"]))
            drift_penalty += 16.0 * excess
        yaw_drift_margin_penalty = 0.0
        if "max_abs_delta_yaw_rad" in crit:
            yaw_bound = max(float(crit["max_abs_delta_yaw_rad"]), 1e-6)
            yaw_drift_margin_penalty = min(4.0, (abs(dyaw) / yaw_bound) ** 2)
        success_now = self._immediate_success_predicate_holds(pose)
        bounds_violated = drift_penalty > 0.0
        tracking_scale = 0.15 if bounds_violated else 1.0
        alive = 1.0
        movement_progress_weight = float(
            r.get("movement_progress_weight", 4.0 if _is_locomotion_reward(r) else 1.0)
        )
        alternating_contact_progress = 0.0
        if "min_alternating_foot_contacts" in crit:
            alternating_contact_progress = _clamped_ratio(
                float(self._foot_contact_switch_count),
                float(crit["min_alternating_foot_contacts"]),
            )
        locomotion_task_progress = progress
        locomotion_reward_progress = progress
        if _is_locomotion_reward(r) and "min_alternating_foot_contacts" in crit:
            locomotion_task_progress = min(progress, alternating_contact_progress)
            locomotion_reward_progress = locomotion_task_progress
            gait_prior_direction_scale = min(
                gait_prior_direction_scale,
                alternating_contact_progress,
            )
        terms = {
            "alive": alive,
            "height_track": height_track,
            "velocity_track": tracking_scale
            * float(r.get("velocity_track_weight", 0.0))
            * velocity_track,
            "yaw_track": tracking_scale
            * float(r.get("yaw_track_weight", 0.0))
            * yaw_track,
            "contact_cadence": float(r.get("gait_phase_weight", 0.0))
            * contact_cadence,
            "stance_contact": float(
                r.get("stance_contact_weight", 0.4 if _is_locomotion_reward(r) else 0.0)
            )
            * stance_contact,
            "foot_clearance": float(
                r.get("foot_clearance_weight", 0.4 if _is_locomotion_reward(r) else 0.0)
            )
            * foot_clearance,
            "foot_slip": float(
                r.get("foot_slip_weight", -1.0 if _is_locomotion_reward(r) else 0.0)
            )
            * foot_slip,
            "foot_spacing": -float(
                r.get("foot_spacing_weight", 1.0 if _is_locomotion_reward(r) else 0.0)
            )
            * foot_spacing_penalty,
            "self_collision": -float(
                r.get(
                    "self_collision_weight",
                    2.0 if _is_locomotion_reward(r) else 0.0,
                )
            )
            * float(self_collision_count),
            "upright": float(r.get("upright_weight", 0.5)) * upright_bonus,
            "movement_progress": movement_progress_weight
            * locomotion_reward_progress
            * locomotion_stability_scale,
            "alternating_contact": float(
                r.get(
                    "alternating_contact_weight",
                    3.0 if _is_locomotion_reward(r) else 0.0,
                )
            )
            * alternating_contact_progress
            * locomotion_stability_scale,
            "no_progress": -float(
                r.get(
                    "locomotion_no_progress_penalty",
                    10.0 if _is_locomotion_reward(r) else 0.0,
                )
            )
            * (1.0 - locomotion_task_progress)
            * locomotion_stability_scale,
            "gait_prior": float(
                r.get(
                    "gait_prior_weight",
                    2.0 if _is_locomotion_reward(r) else 0.0,
                )
            )
            * gait_prior_track
            * gait_prior_direction_scale
            * locomotion_stability_scale,
            "action_rate": float(r.get("action_rate_weight", -0.01)) * action_rate,
            "energy": float(r.get("energy_weight", -0.001)) * energy,
            "tilt_margin": -float(
                r.get("tilt_margin_weight", 6.0 if _is_locomotion_reward(r) else 0.0)
            )
            * tilt_margin_penalty,
            "yaw_drift_margin": -float(
                r.get(
                    "yaw_drift_margin_weight",
                    1.5 if _is_locomotion_reward(r) else 0.0,
                )
            )
            * yaw_drift_margin_penalty,
            "drift": -drift_penalty,
        }
        reward = float(sum(terms.values()))
        if success_now:
            success_scale = locomotion_stability_scale if _is_locomotion_reward(r) else 1.0
            terms["success_bonus"] = float(r.get("success_bonus", 8.0)) * success_scale
            reward += terms["success_bonus"]
            if _is_locomotion_reward(r):
                body_speed = math.hypot(vx_actual, vy_actual)
                angular_speed = abs(yaw_actual)
                hold_stability = float(
                    np.exp(-12.0 * body_speed * body_speed - 4.0 * angular_speed * angular_speed)
                )
                terms["stable_hold_bonus"] = (
                    float(r.get("stable_hold_bonus", 5.0))
                    * hold_stability
                    * success_scale
                )
                reward += terms["stable_hold_bonus"]
        fall_z_threshold = self._fall_z_threshold_for_current_task()
        if torso_z < fall_z_threshold:
            terms["fall_height"] = -max(0.0, fall_z_threshold - torso_z) * 20.0
            reward += terms["fall_height"]
        if fell:
            terms["fall_penalty"] = -abs(
                float(r.get("fall_penalty", 100.0 if _is_locomotion_reward(r) else 25.0))
            )
            reward += terms["fall_penalty"]
            remaining_fraction = max(
                0.0,
                float(self.config.episode_steps - self._step_count)
                / max(float(self.config.episode_steps), 1.0),
            )
            terms["fall_remaining_horizon"] = -(
                abs(
                    float(
                        r.get(
                            "fall_remaining_horizon_penalty",
                            100.0 if _is_locomotion_reward(r) else 0.0,
                        )
                    )
                )
                * remaining_fraction
            )
            reward += terms["fall_remaining_horizon"]
        self._last_reward_terms = {key: float(value) for key, value in terms.items()}
        return float(reward)

    def _locomotion_gait_prior_action(self) -> np.ndarray:
        action = np.zeros(self.action_space.shape, dtype=np.float32)
        phase = float(self._gait_phase)
        for idx, joint in enumerate(self._action_joints):
            name = joint.name.lower()
            side = 1.0 if name.startswith("l_") else -1.0
            value = 0.0
            if "hip_pitch" in name:
                value = 0.24 + side * 0.26 * math.sin(phase)
            elif "knee" in name:
                value = 0.08 + side * 0.26 * math.sin(phase + 1.45)
            elif "ank_pitch" in name:
                value = 0.20 + side * 0.34 * math.sin(phase + 0.35)
            elif "hip_roll" in name:
                value = -0.16 * side + side * 0.30 * math.sin(phase + 0.10)
            elif "ank_roll" in name:
                value = 0.16 * side + side * 0.16 * math.sin(phase + 0.65)
            elif "hip_yaw" in name:
                value = 0.0
            action[idx] = float(np.clip(value, -1.0, 1.0))
        return action

    def _locomotion_hiwonder_sine_prior_action(self) -> np.ndarray:
        """Near-gait sine prior from local HiWonder open-loop evidence.

        The primitive is not a walking proof: it gets close on distance and
        contact switches but still fails stability/yaw gates. Residual learning
        can opt into this prior to test whether Alberta can stabilize and steer
        it instead of rediscovering foot alternation from scratch.
        """
        params = {
            "hz": 1.97679908948875,
            "phase0": -3.047751227680601,
            "hip_bias": 0.04517339437983134,
            "hip_amp": 0.3332225224101644,
            "knee_bias": 0.2780185838768406,
            "knee_amp": 0.3319420372926642,
            "knee_phase": 0.5456184512714919,
            "ank_bias": 0.4026948694712586,
            "ank_amp": 0.15068468548754732,
            "ank_phase": -2.5004630281887223,
            "roll_bias": -0.19734945930649309,
            "roll_amp": 0.3345777227494904,
            "ank_roll_amp": 0.07399822571650065,
            "roll_phase": 0.20360358556236147,
            "ank_roll_phase_delta": 1.3597217068050034,
            "yaw_amp": 0.05127450185597075,
            "yaw_phase": -3.0957997999352855,
        }
        t_s = self._step_count * self.config.control_dt_s
        phase = 2.0 * math.pi * params["hz"] * t_s + params["phase0"]
        direction = -1.0 if self._current_task and self._current_task.id == "walk_backward" else 1.0
        action = np.zeros(self.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(self._action_joints):
            name = joint.name.lower()
            side = 1.0 if name.startswith("l_") else -1.0
            value = 0.0
            if "hip_pitch" in name:
                value = direction * (
                    params["hip_bias"] + side * params["hip_amp"] * math.sin(phase)
                )
            elif "knee" in name:
                value = (
                    params["knee_bias"]
                    + side * params["knee_amp"] * math.sin(phase + params["knee_phase"])
                )
            elif "ank_pitch" in name:
                value = direction * (
                    params["ank_bias"]
                    + side * params["ank_amp"] * math.sin(phase + params["ank_phase"])
                )
            elif "hip_roll" in name:
                value = (
                    side * params["roll_bias"]
                    + side * params["roll_amp"] * math.sin(phase + params["roll_phase"])
                )
            elif "ank_roll" in name:
                value = (
                    -side * params["roll_bias"]
                    + side
                    * params["ank_roll_amp"]
                    * math.sin(
                        phase
                        + params["roll_phase"]
                        + params["ank_roll_phase_delta"]
                    )
                )
            elif "hip_yaw" in name:
                value = side * params["yaw_amp"] * math.sin(phase + params["yaw_phase"])
            action[idx] = float(np.clip(value, -1.0, 1.0))
        return action

    def _immediate_success_predicate_holds(self, pose: dict[str, float]) -> bool:
        """Return whether declared non-hold predicates hold on this frame.

        `GoalChecker` remains the source of truth for episode success,
        including hold windows and rolling oscillation counts. This helper is
        intentionally narrower: it mirrors the instantaneous predicates that
        are available from the profile env telemetry so the reward can favor
        complete task states instead of unrelated partial progress.
        """
        assert self._current_task is not None
        crit = self._current_task.success
        matched = False
        torso_z = pose["z"]
        tracked = self._tracked_pose_summary(pose)
        dx = tracked["x"] - self._episode_start_tracked_x
        dy = tracked["y"] - self._episode_start_tracked_y
        dyaw = _wrap_pi(pose["yaw"] - self._episode_start_yaw)
        elapsed = self._step_count * self.config.control_dt_s

        if bool(crit.get("no_fall", False)) and (
            torso_z < self._fall_z_threshold_for_current_task()
            or pose["upright_proj"] < 0.0
            or abs(pose.get("pitch", 0.0)) > float(crit.get("fall_pitch_rad", 0.6))
            or (
                self._current_task.id != "lie_down"
                and abs(pose.get("roll", 0.0)) > float(crit.get("fall_roll_rad", 0.6))
            )
        ):
            return False

        if "torso_z_min_m" in crit or "torso_z_min_ratio" in crit:
            matched = True
            min_z = float(crit.get("torso_z_min_m", -math.inf))
            if "torso_z_min_ratio" in crit:
                min_z = max(min_z, self._stand_height_m * float(crit["torso_z_min_ratio"]))
            if torso_z < min_z:
                return False
        if "torso_z_max_m" in crit or "torso_z_max_ratio" in crit:
            matched = True
            max_z = float(crit.get("torso_z_max_m", math.inf))
            if "torso_z_max_ratio" in crit:
                max_z = min(max_z, self._stand_height_m * float(crit["torso_z_max_ratio"]))
            if torso_z > max_z:
                return False
        if "torso_z_delta_min_m" in crit or "torso_z_delta_min_ratio" in crit:
            matched = True
            delta_min = float(crit.get("torso_z_delta_min_m", 0.0))
            if "torso_z_delta_min_ratio" in crit:
                delta_min = max(
                    delta_min,
                    self._stand_height_m * float(crit["torso_z_delta_min_ratio"]),
                )
            if torso_z - self._episode_start_torso_z < delta_min:
                return False

        window_s = float(crit.get("window_s", self._current_task.max_episode_s))
        inside_window = elapsed <= window_s + 0.5
        for key, value, predicate in (
            ("delta_x_m_min", dx, lambda actual, limit: actual >= limit),
            ("delta_x_m_max", dx, lambda actual, limit: actual <= limit),
            ("delta_y_m_min", dy, lambda actual, limit: actual >= limit),
            ("delta_y_m_max", dy, lambda actual, limit: actual <= limit),
            ("delta_yaw_rad_min", dyaw, lambda actual, limit: actual >= limit),
            ("delta_yaw_rad_max", dyaw, lambda actual, limit: actual <= limit),
        ):
            if key in crit:
                matched = True
                if not inside_window or not predicate(value, float(crit[key])):
                    return False
        if "abs_delta_yaw_rad_min" in crit:
            matched = True
            if not inside_window or abs(dyaw) < float(crit["abs_delta_yaw_rad_min"]):
                return False
        if "min_alternating_foot_contacts" in crit:
            matched = True
            if self._foot_contact_switch_count < int(crit["min_alternating_foot_contacts"]):
                return False
        if "min_swing_foot_clearance_m" in crit:
            matched = True
            if self._max_swing_foot_clearance_m < float(crit["min_swing_foot_clearance_m"]):
                return False
        if "max_foot_slip_m_s" in crit:
            matched = True
            if self._max_foot_slip_m_s > float(crit["max_foot_slip_m_s"]):
                return False
        if "max_self_collision_count" in crit:
            matched = True
            if self._self_collision_count() > int(crit["max_self_collision_count"]):
                return False

        for key, value in (
            ("max_abs_delta_x_m", abs(dx)),
            ("max_abs_delta_y_m", abs(dy)),
            ("max_lateral_drift_m", abs(dy)),
            ("max_forward_drift_m", abs(dx)),
            ("max_abs_delta_yaw_rad", abs(dyaw)),
        ):
            if key in crit:
                matched = True
                if value > float(crit[key]):
                    return False
        if "max_translation_drift_m" in crit:
            matched = True
            if math.hypot(dx, dy) > float(crit["max_translation_drift_m"]):
                return False

        return matched

    def _success_bound_violation_score(
        self,
        dx: float,
        dy: float,
        dyaw: float,
    ) -> float:
        if self._current_task is None:
            return 0.0
        crit = self._current_task.success
        score = 0.0
        for key, value in (
            ("max_abs_delta_x_m", abs(dx)),
            ("max_abs_delta_y_m", abs(dy)),
            ("max_lateral_drift_m", abs(dy)),
            ("max_forward_drift_m", abs(dx)),
            ("max_abs_delta_yaw_rad", abs(dyaw)),
        ):
            if key in crit:
                score += max(0.0, value - float(crit[key]))
        if "max_translation_drift_m" in crit:
            score += max(
                0.0,
                math.hypot(dx, dy) - float(crit["max_translation_drift_m"]),
            )
        return float(score)

    @staticmethod
    def _single_foot_contact_state(foot_telemetry: np.ndarray) -> str | None:
        left = bool(foot_telemetry[0] > 0.5)
        right = bool(foot_telemetry[1] > 0.5)
        if left == right:
            return None
        return "left" if left else "right"

    def _update_foot_contact_switch_count(self) -> None:
        state = self._single_foot_contact_state(self._last_foot_telemetry)
        if state is None:
            return
        if (
            self._last_single_foot_contact_state is not None
            and state != self._last_single_foot_contact_state
        ):
            self._foot_contact_switch_count += 1
        self._last_single_foot_contact_state = state

    def _current_swing_foot_clearance_m(self) -> float:
        swing_mask = self._last_foot_telemetry[:2] <= 0.5
        if not bool(np.any(swing_mask)):
            return 0.0
        return float(np.max(self._last_foot_telemetry[2:4][swing_mask]))

    def _foot_spacing_penalty(self) -> float:
        foot_xy = self._current_foot_xy()
        if foot_xy.shape != (2, 2):
            return 0.0
        left_y = float(foot_xy[0, 1])
        right_y = float(foot_xy[1, 1])
        lateral_sep = left_y - right_y
        min_sep = max(0.01, 0.45 * float(self.profile.gait.stance_width_m))
        penalty = max(0.0, min_sep - abs(lateral_sep))
        if lateral_sep < 0.0:
            penalty += min_sep + abs(lateral_sep)
        return float(penalty / min_sep)

    def _self_collision_count(self) -> int:
        if self._model is None or self._data is None:
            return 0
        floor_ids = set(int(x) for x in self._floor_geom_ids)
        count = 0
        for idx in range(int(self._data.ncon)):
            contact = self._data.contact[idx]
            geom1 = int(contact.geom1)
            geom2 = int(contact.geom2)
            if geom1 in floor_ids or geom2 in floor_ids:
                continue
            body1 = int(self._model.geom_bodyid[geom1])
            body2 = int(self._model.geom_bodyid[geom2])
            if body1 == body2:
                continue
            if (
                int(self._model.body_parentid[body1]) == body2
                or int(self._model.body_parentid[body2]) == body1
            ):
                continue
            count += 1
        return count


def _pad_or_trim(arr: np.ndarray, dim: int) -> np.ndarray:
    if arr.shape[0] == dim:
        return arr
    if arr.shape[0] > dim:
        return arr[:dim]
    return np.concatenate([arr, np.zeros(dim - arr.shape[0], dtype=arr.dtype)])


def _actuator_id_for_joint(model, joint_id: int, joint_name: str) -> int:
    import mujoco

    aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, joint_name)
    if aid >= 0:
        return int(aid)
    stripped = joint_name.removesuffix("_joint")
    if stripped != joint_name:
        aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, stripped)
        if aid >= 0:
            return int(aid)
    for candidate in range(model.nu):
        if (
            int(model.actuator_trntype[candidate])
            == int(mujoco.mjtTrn.mjTRN_JOINT)
            and int(model.actuator_trnid[candidate, 0]) == int(joint_id)
        ):
            return int(candidate)
    return -1


def _resolve_declared_geom_names(model, names: list[str], *, label: str) -> np.ndarray:
    import mujoco

    ids: list[int] = []
    missing: list[str] = []
    for name in names:
        geom_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, name)
        if geom_id < 0:
            missing.append(name)
        else:
            ids.append(int(geom_id))
    if missing:
        raise ValueError(f"profile declared missing {label} geoms: {missing}")
    if not ids:
        raise ValueError(f"profile declared zero {label} geoms")
    return np.asarray(ids, dtype=np.int32)


def _resolve_declared_contact_geoms(
    model,
    *,
    geom_names: list[str],
    body_names: list[str],
    label: str,
) -> np.ndarray:
    import mujoco

    ids = (
        set(
            int(x)
            for x in _resolve_declared_geom_names(model, geom_names, label=label)
        )
        if geom_names
        else set()
    )
    missing_bodies: list[str] = []
    for body_name in body_names:
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, body_name)
        if body_id < 0:
            missing_bodies.append(body_name)
            continue
        for geom_id in range(model.ngeom):
            if int(model.geom_bodyid[geom_id]) != int(body_id):
                continue
            if (
                int(model.geom_contype[geom_id]) == 0
                and int(model.geom_conaffinity[geom_id]) == 0
            ):
                continue
            ids.add(int(geom_id))
    if missing_bodies:
        raise ValueError(f"profile declared missing {label} bodies: {missing_bodies}")
    if not ids:
        raise ValueError(f"profile declared zero {label} contact geoms")
    return np.asarray(sorted(ids), dtype=np.int32)


def _wrap_pi(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _wrap_2pi(angle: float) -> float:
    return float(angle % (2.0 * math.pi))


def _name_has_side(name: str, side: str) -> bool:
    short = "l" if side == "left" else "r"
    return (
        name.startswith(f"{side}_")
        or name.startswith(f"{short}_")
        or f" {side}_" in name
        or f" {short}_" in name
        or f"{side} " in name
    )


def _is_locomotion_reward(reward_cfg: dict) -> bool:
    return any(
        key in reward_cfg
        for key in (
            "target_velocity_x_m_s",
            "target_velocity_y_m_s",
            "target_yaw_rate_rad_s",
        )
    )


def _task_requires_unsupported_profile_env_features(task: TaskSpec) -> bool:
    reward_keys = {
        "head_tilt_target_rad",
        "head_track_weight",
        "left_arm_oscillation_weight",
        "right_arm_oscillation_weight",
        "gripper_separation_target_m",
        "gripper_separation_weight",
        "distance_to_target_weight",
        "gripper_to_box_distance_weight",
        "grasp_contact_weight",
        "lift_height_weight",
        "box_to_b_distance_weight",
        "grasp_hold_weight",
        "tracking_consistency_weight",
    }
    success_keys = {
        "head_tilt_min_rad",
        "head_tilt_max_rad",
        "l_sho_pitch_oscillation",
        "r_sho_pitch_oscillation",
        "cycles_min",
        "gripper_separation_max_m",
        "distance_to_target_m_max",
        "box_z_min_m",
        "box_in_grippers",
        "box_at_target_xy_m_max",
        "box_released",
        "mean_distance_m_max",
    }
    return bool(set(task.reward) & reward_keys or set(task.success) & success_keys)


def _contact_cadence_reward(contacts: np.ndarray, phase: float) -> float:
    """Score alternating left/right stance against a simple biped gait clock."""
    contacts = np.asarray(contacts, dtype=np.float32)
    if contacts.shape[0] < 2:
        return 0.0
    clipped = np.clip(contacts[:2], 0.0, 1.0)
    if float(np.sum(clipped)) < 0.5:
        return 0.0
    desired = np.array(
        [1.0 if math.sin(phase) >= 0.0 else 0.0, 1.0 if math.sin(phase) < 0.0 else 0.0],
        dtype=np.float32,
    )
    return float(1.0 - np.mean(np.abs(clipped - desired)))


def _stance_contact_reward(contacts: np.ndarray, phase: float) -> float:
    """Reward the stance foot being in contact with the floor."""
    contacts = np.asarray(contacts, dtype=np.float32)
    if contacts.shape[0] < 2:
        return 0.0
    desired = np.array(
        [1.0 if math.sin(phase) >= 0.0 else 0.0, 1.0 if math.sin(phase) < 0.0 else 0.0],
        dtype=np.float32,
    )
    stance_mask = desired > 0.5
    if not bool(np.any(stance_mask)):
        return 0.0
    return float(np.mean(np.clip(contacts[:2], 0.0, 1.0)[stance_mask]))


def _foot_clearance_reward(
    foot_z: np.ndarray,
    contacts: np.ndarray,
    phase: float,
    swing_height_m: float,
) -> float:
    """Reward the swing foot lifting relative to the current stance foot."""
    foot_z = np.asarray(foot_z, dtype=np.float32)
    contacts = np.asarray(contacts, dtype=np.float32)
    if foot_z.shape[0] < 2 or contacts.shape[0] < 2:
        return 0.0
    desired = np.array(
        [1.0 if math.sin(phase) >= 0.0 else 0.0, 1.0 if math.sin(phase) < 0.0 else 0.0],
        dtype=np.float32,
    )
    swing_mask = desired < 0.5
    if not bool(np.any(swing_mask)):
        return 0.0
    stance_z = foot_z[:2][desired > 0.5]
    ground_z = float(np.min(stance_z)) if stance_z.size else float(np.min(foot_z[:2]))
    target = max(0.01, 0.45 * float(swing_height_m))
    clearance = np.maximum(0.0, foot_z[:2][swing_mask] - ground_z)
    airborne = 1.0 - np.clip(contacts[:2][swing_mask], 0.0, 1.0)
    return float(np.mean(np.clip(clearance / target, 0.0, 1.0) * airborne))


def _clamped_ratio(value: float, target: float) -> float:
    if target <= 0:
        return 0.0
    return float(np.clip(value / target, 0.0, 1.0))


def _tracking_reward(
    actual: float,
    target: float,
    reward_cfg: dict,
    *,
    default_min_sigma: float = 0.02,
) -> float:
    """Narrow Gaussian tracking so standstill is not near-optimal locomotion."""
    key = "yaw_track_sigma" if default_min_sigma >= 0.1 else "velocity_track_sigma"
    sigma = float(
        reward_cfg.get(
            key,
            max(default_min_sigma, 0.35 * abs(float(target))),
        )
    )
    sigma = max(sigma, 1e-3)
    return float(np.exp(-((actual - target) ** 2) / (2.0 * sigma * sigma)))


def make_text_conditioned_env(
    profile_id: str, **kwargs
) -> TextConditionedProfileEnv:
    """Factory: returns a profile-driven env for the requested robot.

    Use this from the unified train CLI and the policy.start handler so a
    single code path covers every supported profile.
    """

    return TextConditionedProfileEnv(profile_id, **kwargs)
