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

from dataclasses import dataclass, field
import math
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


class TextConditionedProfileEnv(gym.Env):
    """Profile-driven CPU env for text-conditioned PPO training.

    Observation layout::
        [gyro(3), gravity(3), velocity_cmd(3),
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
        self.active_tasks = candidates
        self.task_ids = [task.id for task in candidates]

        proprio_dim = 3 + 3 + 3 + 3 * self._action_dim  # gyro+grav+cmd+(q,qv,last)
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
        self._step_count = 0
        self._episode_start_x = 0.0
        self._episode_start_y = 0.0
        self._episode_start_yaw = 0.0
        self._episode_start_torso_z = 0.0
        # Per-profile fall envelope. The robot is "fallen" when the torso
        # drops below 60% of standing height OR pitches/rolls past 0.8 rad.
        # Standing height comes from the profile's gait spec — for AiNex
        # the torso starts low so we floor the threshold at 0.10 m.
        self._stand_height_m = max(
            0.05, float(self.profile.gait.default_height_m)
        )
        self._fall_z_threshold = max(0.10, 0.6 * self._stand_height_m)
        self._prev_action = np.zeros(self._action_dim, dtype=np.float32)

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
        mujoco.mj_forward(self._model, self._data)
        self._previous_action.fill(0.0)
        self._prev_action.fill(0.0)
        self._step_count = 0
        self._current_task = task
        self._current_embed = self.embeddings[task.id].reduced_embed.astype(np.float32)
        pose = self._root_pose_summary()
        self._episode_start_x = pose["x"]
        self._episode_start_y = pose["y"]
        self._episode_start_yaw = pose["yaw"]
        self._episode_start_torso_z = pose["z"]
        return self._build_obs(), {"task_id": task.id, "task_tier": task.tier}

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
            extra = task.model_extra or {}
            if "init_torso_z_m" in extra:
                target_z = float(extra["init_torso_z_m"])
            else:
                target_z = self._stand_height_m * float(
                    extra.get("init_torso_height_ratio", 0.65)
                )
            self._data.qpos[root + 2] = target_z
            self._set_named_joint_if_present(("hip_pitch",), -0.45)
            self._set_named_joint_if_present(("knee",), 0.85)
            self._set_named_joint_if_present(("ank_pitch", "ankle_pitch"), -0.35)
            return
        if init_state == "prone" and self._data.qpos.size > root + 6:
            extra = task.model_extra or {}
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
        self._prev_action = self._previous_action.copy()
        self._previous_action = clipped.copy()
        target = self._home_pose + clipped * self.config.action_scale
        target = np.clip(target, self._lower, self._upper)
        self._write_joint_targets(target)
        n_substeps = max(1, int(round(self.config.control_dt_s / self._model.opt.timestep)))
        for _ in range(n_substeps):
            mujoco.mj_step(self._model, self._data)
        self._step_count += 1
        obs = self._build_obs()
        pose = self._root_pose_summary()
        torso_z = pose["z"]
        upright_proj = pose["upright_proj"]
        fall_z_threshold = self._fall_z_threshold_for_current_task()
        terminated = bool(torso_z < fall_z_threshold or upright_proj < 0.0)
        truncated = self._step_count >= self.config.episode_steps
        reward = self._reward(clipped, pose=pose, fell=terminated)
        elapsed_s = max(self._step_count * self.config.control_dt_s, 1e-6)
        dx = pose["x"] - self._episode_start_x
        dy = pose["y"] - self._episode_start_y
        dyaw = _wrap_pi(pose["yaw"] - self._episode_start_yaw)
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
                "delta_x": dx,
                "delta_y": dy,
                "delta_yaw": dyaw,
                "vx": dx / elapsed_s,
                "vy": dy / elapsed_s,
                "yaw_rate": dyaw / elapsed_s,
                "init_torso_z": self._episode_start_torso_z,
                "stand_height_m": self._stand_height_m,
                "fall_threshold": fall_z_threshold,
            },
        )

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
            yaw = math.atan2(
                2.0 * (qw * qz + qx * qy),
                1.0 - 2.0 * (qy * qy + qz * qz),
            )
        else:
            upright_proj = 1.0
            yaw = 0.0
        return {
            "x": root_x,
            "y": root_y,
            "z": torso_z,
            "yaw": yaw,
            "upright_proj": upright_proj,
        }

    def render(self):
        return None

    # ------------------------------------------------------------------ helpers

    def _build_obs(self) -> np.ndarray:
        if self.config.domain_rand and self.config.dr_imu_noise_std > 0:
            gyro = self.np_random.normal(
                0.0, self.config.dr_imu_noise_std, size=3
            ).astype(np.float32)
        else:
            gyro = np.zeros(3, dtype=np.float32)
        gravity = np.array([0.0, 0.0, 1.0], dtype=np.float32)
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
            [gyro, gravity, velocity_command, qpos, qvel, self._previous_action, text]
        ).astype(np.float32)

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
          - velocity_track(1.0)     : Gaussian on (vx, vy, yaw) command error
          - upright_proj(0.5)       : torso-z axis projection on world up
          - action_rate_penalty     : 0.01 * ||a_t - a_{t-1}||^2
          - energy_penalty          : 0.001 * sum(a^2)
          - fall_penalty(-10)       : applied once at termination

        The alive + height_track terms make standing the dominant strategy
        from step 1, but velocity_track requires actual locomotion, so PPO
        has signal to climb past the trivial standstill.
        """
        assert self._current_task is not None
        r = self._current_task.reward
        crit = self._current_task.success
        torso_z = pose["z"]
        upright_proj = pose["upright_proj"]
        vx_target = float(r.get("target_velocity_x_m_s", 0.0))
        vy_target = float(r.get("target_velocity_y_m_s", 0.0))
        yaw_target = float(r.get("target_yaw_rate_rad_s", 0.0))
        # Body-frame velocity. The free-joint linvel is in world frame; for
        # this CPU smoke env we treat them as approximately torso-frame
        # while the robot stays mostly upright. Production MJX env should
        # project through the torso quat — see eliza_robot/sim/mujoco/joystick.py.
        root_v = self._root_qvel_idx
        vx_actual = float(self._data.qvel[root_v]) if self._data.qvel.size > root_v else 0.0
        vy_actual = float(self._data.qvel[root_v + 1]) if self._data.qvel.size > root_v + 1 else 0.0
        yaw_actual = float(self._data.qvel[root_v + 5]) if self._data.qvel.size > root_v + 5 else 0.0
        velocity_terms: list[float] = []
        if "target_velocity_x_m_s" in r:
            velocity_terms.append(float(np.exp(-2.0 * (vx_actual - vx_target) ** 2)))
        if "target_velocity_y_m_s" in r:
            velocity_terms.append(float(np.exp(-2.0 * (vy_actual - vy_target) ** 2)))
        if "target_yaw_rate_rad_s" in r:
            velocity_terms.append(float(np.exp(-2.0 * (yaw_actual - yaw_target) ** 2)))
        velocity_track = float(np.mean(velocity_terms)) if velocity_terms else 0.0
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
        upright_bonus = float(max(0.0, upright_proj))
        action_rate = float(np.mean((action - self._prev_action) ** 2))
        energy = float(np.mean(action**2))
        elapsed_s = max(self._step_count * self.config.control_dt_s, 1e-6)
        dx = pose["x"] - self._episode_start_x
        dy = pose["y"] - self._episode_start_y
        dyaw = _wrap_pi(pose["yaw"] - self._episode_start_yaw)
        progress = 0.0
        if "delta_x_m_min" in crit:
            progress += _clamped_ratio(dx, float(crit["delta_x_m_min"]))
        if "delta_x_m_max" in crit:
            progress += _clamped_ratio(-dx, abs(float(crit["delta_x_m_max"])))
        if "delta_y_m_min" in crit:
            progress += _clamped_ratio(dy, float(crit["delta_y_m_min"]))
        if "delta_y_m_max" in crit:
            progress += _clamped_ratio(-dy, abs(float(crit["delta_y_m_max"])))
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
        lateral_penalty = 0.0
        if "max_lateral_drift_m" in crit:
            excess = max(0.0, abs(dy) - float(crit["max_lateral_drift_m"]))
            lateral_penalty = 2.0 * excess
        alive = 1.0
        reward = (
            alive
            + 1.0 * height_track
            + float(r.get("velocity_track_weight", 0.0)) * velocity_track
            + float(r.get("upright_weight", 0.5)) * upright_bonus
            + progress
            + float(r.get("action_rate_weight", -0.01)) * action_rate
            + float(r.get("energy_weight", -0.001)) * energy
            - lateral_penalty
        )
        fall_z_threshold = self._fall_z_threshold_for_current_task()
        if torso_z < fall_z_threshold:
            reward -= max(0.0, fall_z_threshold - torso_z) * 20.0
        if fell:
            reward -= 10.0
        return float(reward)


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


def _wrap_pi(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _clamped_ratio(value: float, target: float) -> float:
    if target <= 0:
        return 0.0
    return float(np.clip(value / target, 0.0, 1.0))


def make_text_conditioned_env(
    profile_id: str, **kwargs
) -> TextConditionedProfileEnv:
    """Factory: returns a profile-driven env for the requested robot.

    Use this from the unified train CLI and the policy.start handler so a
    single code path covers every supported profile.
    """

    return TextConditionedProfileEnv(profile_id, **kwargs)
