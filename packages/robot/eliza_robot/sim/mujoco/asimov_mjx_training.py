"""ASIMOV-1 text-conditioned MJX/Brax training entrypoint."""

from __future__ import annotations

import functools
import json
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np
from mujoco_playground._src import mjx_env

from eliza_robot.asimov_1.constants import (
    ASIMOV1_ACTOR_OBSERVATION_DIM,
    ASIMOV1_CONTROL_HZ,
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_LEG_ACTION_DIM,
    ASIMOV1_LEG_JOINT_ORDER,
    ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS,
    ASIMOV1_PHYSICS_HZ,
    ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
)
from eliza_robot.asimov_1.mujoco_assets import generate_asimov1_mjcf
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.text_conditioned.encoder import (
    DEFAULT_PCA_DIM,
    build_task_embeddings,
)

DEFAULT_ACTIVE_TASKS: tuple[str, ...] = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)

_TASK_COMMANDS: dict[str, tuple[float, float, float]] = {
    "stand_up": (0.0, 0.0, 0.0),
    "walk_forward": (0.35, 0.0, 0.0),
    "walk_backward": (-0.25, 0.0, 0.0),
    "sidestep_left": (0.0, 0.20, 0.0),
    "sidestep_right": (0.0, -0.20, 0.0),
    "turn_left": (0.0, 0.0, 0.60),
    "turn_right": (0.0, 0.0, -0.60),
}


def default_config(
    *,
    active_tasks: Sequence[str] = DEFAULT_ACTIVE_TASKS,
    pca_dim: int = DEFAULT_PCA_DIM,
    domain_randomization: dict[str, Sequence[float]] | None = None,
    observation_delay_steps: dict[str, int] | None = None,
):
    from ml_collections import config_dict

    return config_dict.create(
        ctrl_dt=1.0 / ASIMOV1_CONTROL_HZ,
        sim_dt=1.0 / ASIMOV1_PHYSICS_HZ,
        episode_length=500,
        action_repeat=1,
        action_scale=0.35,
        stand_height_target=0.63,
        termination_height=0.20,
        reward_config=config_dict.create(
            scales=config_dict.create(
                tracking_lin_vel=4.0,
                tracking_ang_vel=2.0,
                upright=1.0,
                height=0.8,
                action_rate=-0.02,
                termination=-2.0,
            ),
            tracking_sigma=0.25,
        ),
        observation_delay_steps=config_dict.create(
            **dict(observation_delay_steps or {"left_leg": 1, "right_leg": 2}),
        ),
        text_conditioned=config_dict.create(
            active_tasks=tuple(active_tasks),
            pca_dim=int(pca_dim),
        ),
        domain_randomization=dict(domain_randomization or {}),
    )


def _fallback_task_embeddings(tasks: Sequence[str], dim: int) -> np.ndarray:
    """Deterministic local fallback when sentence-transformers is unavailable."""
    rows = []
    for task in tasks:
        seed = int.from_bytes(task.encode("utf-8")[:8].ljust(8, b"\0"), "little", signed=False)
        rng = np.random.default_rng(seed)
        row = rng.normal(0.0, 1.0, size=dim).astype(np.float32)
        row /= np.linalg.norm(row) + 1e-6
        rows.append(row)
    return np.stack(rows, axis=0)


def _task_embedding_matrix(tasks: Sequence[str], pca_dim: int) -> np.ndarray:
    try:
        curriculum = load_curriculum()
        embeddings = build_task_embeddings(curriculum=curriculum, pca_dim=pca_dim)
        missing = [task for task in tasks if task not in embeddings]
        if missing:
            raise KeyError(f"missing curriculum embeddings for {missing!r}")
        rows = [embeddings[task].reduced_embed.astype(np.float32) for task in tasks]
        return np.stack(rows, axis=0)
    except Exception:
        return _fallback_task_embeddings(tasks, pca_dim)


class TextConditionedAsimovMJX(mjx_env.MjxEnv):
    """ASIMOV-1 MJX env with 45-D proprio + text embedding observations."""

    def __init__(
        self,
        config: Any | None = None,
        config_overrides: dict[str, Any] | None = None,
    ) -> None:
        import jax.numpy as jp
        import mujoco
        from mujoco import mjx

        if config is None:
            config = default_config()
        super().__init__(config, config_overrides)
        generate_asimov1_mjcf()

        model = mujoco.MjModel.from_xml_path(str(ASIMOV1_GENERATED_MJCF))
        model.opt.timestep = float(self._config.sim_dt)
        self._mj_model = model
        self._mjx_model = mjx.put_model(model)
        self._init_q = jp.asarray(model.qpos0, dtype=jp.float32)
        self._home_targets = jp.asarray(self._home_actuator_targets(model), dtype=jp.float32)
        self._lowers = jp.asarray(model.actuator_ctrlrange[:, 0], dtype=jp.float32)
        self._uppers = jp.asarray(model.actuator_ctrlrange[:, 1], dtype=jp.float32)

        actuator_names = [
            mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR, i) for i in range(model.nu)
        ]
        leg_ids = [actuator_names.index(name) for name in ASIMOV1_LEG_JOINT_ORDER]
        joint_qpos = []
        joint_dof = []
        for name in ASIMOV1_LEG_JOINT_ORDER:
            joint_id = model.joint(name).id
            joint_qpos.append(model.jnt_qposadr[joint_id])
            joint_dof.append(model.jnt_dofadr[joint_id])
        self._leg_actuator_ids = jp.asarray(leg_ids, dtype=jp.int32)
        self._leg_qpos_adrs = jp.asarray(joint_qpos, dtype=jp.int32)
        self._leg_dof_adrs = jp.asarray(joint_dof, dtype=jp.int32)
        self._observation_delay_steps = jp.asarray(
            self._observation_delay_steps_from_config(), dtype=jp.int32
        )
        self._history_len = int(np.max(np.asarray(self._observation_delay_steps))) + 1

        self._sensor_addr: dict[str, tuple[int, int]] = {}
        for sensor in ("imu_ang_vel", "imu_lin_vel", "imu_quat", "root_angmom"):
            sid = model.sensor(sensor).id
            self._sensor_addr[sensor] = (int(model.sensor_adr[sid]), int(model.sensor_dim[sid]))
        toe_geom_ids = []
        for geom_id in range(model.ngeom):
            name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or ""
            if "toe" in name.lower() and "collision" in name.lower():
                toe_geom_ids.append(geom_id)
        left_toe_geom_ids = [
            geom_id
            for geom_id in toe_geom_ids
            if "left_" in (mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or "")
        ]
        right_toe_geom_ids = [
            geom_id
            for geom_id in toe_geom_ids
            if "right_" in (mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or "")
        ]
        if not left_toe_geom_ids or not right_toe_geom_ids:
            raise ValueError("ASIMOV MJX privileged critic requires left/right toe collision geoms")
        self._left_toe_geom_ids = jp.asarray(left_toe_geom_ids, dtype=jp.int32)
        self._right_toe_geom_ids = jp.asarray(right_toe_geom_ids, dtype=jp.int32)

        self._active_tasks = tuple(self._config.text_conditioned.active_tasks)
        unknown = [task for task in self._active_tasks if task not in _TASK_COMMANDS]
        if unknown:
            raise ValueError(f"ASIMOV MJX has no command mapping for tasks {unknown!r}")
        self._text_dim = int(self._config.text_conditioned.pca_dim)
        self._task_embeddings = jp.asarray(
            _task_embedding_matrix(self._active_tasks, self._text_dim),
            dtype=jp.float32,
        )
        self._task_commands = jp.asarray(
            np.asarray([_TASK_COMMANDS[task] for task in self._active_tasks], dtype=np.float32)
        )
        self._stand_task_idx = (
            self._active_tasks.index("stand_up") if "stand_up" in self._active_tasks else -1
        )

    @staticmethod
    def _home_actuator_targets(model) -> np.ndarray:
        targets = []
        for actuator_id in range(model.nu):
            joint_id = int(model.actuator_trnid[actuator_id, 0])
            qpos_adr = int(model.jnt_qposadr[joint_id])
            targets.append(float(model.qpos0[qpos_adr]))
        return np.asarray(targets, dtype=np.float32)

    @property
    def xml_path(self) -> str:
        return str(ASIMOV1_GENERATED_MJCF)

    @property
    def action_size(self) -> int:
        return ASIMOV1_LEG_ACTION_DIM

    @property
    def observation_size(self) -> int:
        return {
            "state": self.actor_observation_size,
            "privileged_state": self.privileged_observation_size,
        }

    @property
    def actor_observation_size(self) -> int:
        return ASIMOV1_ACTOR_OBSERVATION_DIM + self._text_dim

    @property
    def privileged_observation_size(self) -> int:
        return self.actor_observation_size + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM

    @property
    def proprio_dim(self) -> int:
        return ASIMOV1_ACTOR_OBSERVATION_DIM

    @property
    def text_dim(self) -> int:
        return self._text_dim

    @property
    def active_tasks(self) -> tuple[str, ...]:
        return self._active_tasks

    @property
    def mj_model(self):
        return self._mj_model

    @property
    def mjx_model(self):
        return self._mjx_model

    @property
    def observation_delay_steps(self) -> tuple[int, ...]:
        return tuple(int(x) for x in np.asarray(self._observation_delay_steps))

    def _observation_delay_steps_from_config(self) -> np.ndarray:
        delays = np.zeros(ASIMOV1_LEG_ACTION_DIM, dtype=np.int32)
        configured = self._config.observation_delay_steps
        for group, indices in ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS.items():
            delay = int(getattr(configured, group, 0))
            if delay < 0:
                raise ValueError(f"ASIMOV observation delay for {group!r} must be >= 0")
            delays[list(indices)] = delay
        return delays

    def reset(self, rng):
        import jax
        import jax.numpy as jp
        from mujoco import mjx
        from mujoco_playground._src import mjx_env

        rng, task_rng, encoder_rng, gain_rng = jax.random.split(rng, 4)
        task_idx = jax.random.randint(task_rng, (), 0, len(self._active_tasks))
        command = self._task_commands[task_idx]
        text_embed = self._task_embeddings[task_idx]
        offset_range = tuple(
            self._config.domain_randomization.get("encoder_zero_offset_rad", (-0.0, 0.0))
        )
        gain_range = tuple(self._config.domain_randomization.get("pd_gain_scale", (1.0, 1.0)))
        encoder_offset = jax.random.uniform(
            encoder_rng,
            (ASIMOV1_LEG_ACTION_DIM,),
            minval=float(offset_range[0]),
            maxval=float(offset_range[1]),
        )
        pd_gain_scale = jax.random.uniform(
            gain_rng, (), minval=float(gain_range[0]), maxval=float(gain_range[1])
        )

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
            ctrl=self._home_targets,
        )
        data = mjx.forward(self.mjx_model, data)
        qpos, qvel = self._joint_measurements(data, encoder_offset)

        info = {
            "rng": rng,
            "task_idx": task_idx,
            "command": command,
            "text_embed": text_embed,
            "last_act": jp.zeros(ASIMOV1_LEG_ACTION_DIM),
            "encoder_offset": encoder_offset,
            "pd_gain_scale": pd_gain_scale,
            "motor_targets": self._home_targets,
            "qpos_history": jp.tile(qpos, (self._history_len, 1)),
            "qvel_history": jp.tile(qvel, (self._history_len, 1)),
            "step": jp.zeros((), dtype=jp.int32),
        }
        obs = self._get_obs(data, info)
        metrics = {f"reward/{name}": jp.zeros(()) for name in self._config.reward_config.scales}
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state, action):
        import jax
        import jax.numpy as jp
        from mujoco_playground._src import mjx_env

        action = jp.clip(action, -1.0, 1.0)
        scaled = action * float(self._config.action_scale) * state.info["pd_gain_scale"]
        leg_targets = self._home_targets[self._leg_actuator_ids] + scaled
        motor_targets = self._home_targets.at[self._leg_actuator_ids].set(leg_targets)
        motor_targets = jp.clip(motor_targets, self._lowers, self._uppers)
        data = mjx_env.step(self.mjx_model, state.data, motor_targets, self.n_substeps)
        qpos, qvel = self._joint_measurements(data, state.info["encoder_offset"])
        qpos_history = jp.concatenate([qpos[None, :], state.info["qpos_history"][:-1]], axis=0)
        qvel_history = jp.concatenate([qvel[None, :], state.info["qvel_history"][:-1]], axis=0)

        done = self._termination(data)
        rewards = self._rewards(data, state.info, action, done)
        scaled_rewards = {
            name: value * self._config.reward_config.scales[name] for name, value in rewards.items()
        }
        reward = jp.clip(sum(scaled_rewards.values()) * self.dt, -10000.0, 10000.0)

        info = dict(state.info)
        info["rng"], _ = jax.random.split(state.info["rng"])
        info["last_act"] = action
        info["motor_targets"] = motor_targets
        info["qpos_history"] = qpos_history
        info["qvel_history"] = qvel_history
        info["step"] = state.info["step"] + 1
        done = jp.where(info["step"] >= int(self._config.episode_length), 1.0, done)
        obs = self._get_obs(data, info)
        metrics = dict(state.metrics)
        for name, value in scaled_rewards.items():
            metrics[f"reward/{name}"] = value
        return state.replace(
            data=data,
            obs=obs,
            reward=reward,
            done=done.astype(jp.float32),
            metrics=metrics,
            info=info,
        )

    def _joint_measurements(self, data, encoder_offset):
        qpos = (
            data.qpos[self._leg_qpos_adrs]
            - self._home_targets[self._leg_actuator_ids]
            + encoder_offset
        )
        qvel = data.qvel[self._leg_dof_adrs] * 0.05
        return qpos, qvel

    def _get_obs(self, data, info):
        actor_obs = self._get_actor_obs(data, info)
        return {
            "state": actor_obs,
            "privileged_state": self._get_privileged_state(data, actor_obs),
        }

    def _get_actor_obs(self, data, info):
        import jax.numpy as jp

        return jp.concatenate([self._get_proprio(data, info), info["text_embed"]])

    def _get_privileged_state(self, data, actor_obs):
        import jax.numpy as jp

        lin_adr, lin_dim = self._sensor_addr["imu_lin_vel"]
        angmom_adr, angmom_dim = self._sensor_addr["root_angmom"]
        imu_lin_vel = data.sensordata[lin_adr : lin_adr + lin_dim]
        root_height = data.qpos[2:3]
        root_angmom = data.sensordata[angmom_adr : angmom_adr + angmom_dim]
        toe_contact_proxy = jp.asarray(
            [
                jp.min(data.geom_xpos[self._left_toe_geom_ids, 2]) < 0.03,
                jp.min(data.geom_xpos[self._right_toe_geom_ids, 2]) < 0.03,
            ],
            dtype=jp.float32,
        )
        return jp.concatenate([actor_obs, imu_lin_vel, root_height, root_angmom, toe_contact_proxy])

    def _get_proprio(self, data, info):
        import jax.numpy as jp

        gyro_adr, gyro_dim = self._sensor_addr["imu_ang_vel"]
        quat_adr, quat_dim = self._sensor_addr["imu_quat"]
        gyro = data.sensordata[gyro_adr : gyro_adr + gyro_dim]
        quat = data.sensordata[quat_adr : quat_adr + quat_dim]
        gravity = self._gravity_from_quat(quat)
        qpos = jp.take(info["qpos_history"], self._observation_delay_steps, axis=0).diagonal()
        qvel = jp.take(info["qvel_history"], self._observation_delay_steps, axis=0).diagonal()
        return jp.concatenate([gyro, gravity, info["command"], qpos, qvel, info["last_act"]])

    @staticmethod
    def _gravity_from_quat(quat):
        import jax.numpy as jp

        w, x, y, z = quat
        return jp.array(
            [
                2.0 * (x * z - w * y),
                2.0 * (w * x + y * z),
                1.0 - 2.0 * (x * x + y * y),
            ],
            dtype=jp.float32,
        )

    def _termination(self, data):
        import jax.numpy as jp

        return jp.float32(data.qpos[2] < float(self._config.termination_height))

    def _rewards(self, data, info, action, done):
        import jax.numpy as jp

        command = info["command"]
        lin_err = jp.sum(jp.square(command[:2] - data.qvel[:2]))
        yaw_err = jp.square(command[2] - data.qvel[5])
        sigma = float(self._config.reward_config.tracking_sigma)
        tracking_lin_vel = jp.exp(-lin_err / sigma)
        tracking_ang_vel = jp.exp(-yaw_err / sigma)
        upright = jp.clip(
            self._gravity_from_quat(
                data.sensordata[
                    self._sensor_addr["imu_quat"][0] : self._sensor_addr["imu_quat"][0] + 4
                ]
            )[2],
            0.0,
            1.0,
        )
        height_err = jp.abs(data.qpos[2] - float(self._config.stand_height_target))
        stand_gate = (
            jp.float32(info["task_idx"] == self._stand_task_idx)
            if self._stand_task_idx >= 0
            else jp.zeros(())
        )
        height = jp.exp(-height_err / 0.08) * stand_gate
        action_rate = jp.sum(jp.square(action - info["last_act"]))
        return {
            "tracking_lin_vel": tracking_lin_vel,
            "tracking_ang_vel": tracking_ang_vel,
            "upright": upright,
            "height": height,
            "action_rate": action_rate,
            "termination": done,
        }


def make_asimov_text_conditioned_mjx_env(
    *,
    active_tasks: Sequence[str] = DEFAULT_ACTIVE_TASKS,
    pca_dim: int = DEFAULT_PCA_DIM,
    episode_length: int = 500,
    domain_randomization: dict[str, Sequence[float]] | None = None,
    observation_delay_steps: dict[str, int] | None = None,
) -> TextConditionedAsimovMJX:
    config = default_config(
        active_tasks=active_tasks,
        pca_dim=pca_dim,
        domain_randomization=domain_randomization,
        observation_delay_steps=observation_delay_steps,
    )
    config.episode_length = int(episode_length)
    return TextConditionedAsimovMJX(config=config)


def _train_from_job_impl(
    job_dir: str | Path,
    *,
    ppo_train_fn: Callable[..., Any],
    save_params_fn: Callable[[str, Any], Any],
    tree_map_fn: Callable[[Callable[[Any], Any], Any], Any],
    make_networks_fn: Callable[..., Any],
    wrap_env_fn: Callable[..., Any],
    env_factory: Callable[..., TextConditionedAsimovMJX] = make_asimov_text_conditioned_mjx_env,
) -> dict[str, Any]:
    job_dir = Path(job_dir)
    job = json.loads((job_dir / "training_job.json").read_text(encoding="utf-8"))
    ppo = dict(job["ppo"])
    manifest = dict(job["manifest_template"])
    start = time.time()
    metrics: list[dict[str, Any]] = []

    env = env_factory(
        active_tasks=tuple(job.get("active_tasks") or manifest["active_tasks"]),
        pca_dim=int(manifest.get("pca_dim", DEFAULT_PCA_DIM)),
        episode_length=int(ppo.get("episode_length", job.get("episode_length", 500))),
        domain_randomization=job.get("domain_randomization", {}),
        observation_delay_steps=job.get("observation_delay_steps"),
    )

    def progress_fn(num_steps, train_metrics):
        reward = float(
            train_metrics.get("eval/episode_reward", train_metrics.get("episode_reward", 0.0))
        )
        row = {
            "steps": int(num_steps),
            "reward": reward,
            "elapsed_s": round(time.time() - start, 3),
        }
        metrics.append(row)
        (job_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    make_inference_fn, params, _ = ppo_train_fn(
        environment=env,
        num_timesteps=int(ppo["num_timesteps"]),
        episode_length=int(env._config.episode_length),
        num_evals=int(ppo.get("num_evals", 10)),
        reward_scaling=float(ppo.get("reward_scaling", 1.0)),
        normalize_observations=bool(ppo.get("normalize_observations", True)),
        action_repeat=int(ppo.get("action_repeat", 1)),
        unroll_length=int(ppo.get("unroll_length", 20)),
        num_minibatches=int(ppo.get("num_minibatches", 32)),
        num_updates_per_batch=int(ppo.get("num_updates_per_batch", 4)),
        discounting=float(ppo.get("discounting", 0.97)),
        learning_rate=float(ppo.get("learning_rate", 3e-4)),
        entropy_cost=float(ppo.get("entropy_cost", 1e-2)),
        num_envs=int(ppo.get("num_envs", 8192)),
        batch_size=int(ppo.get("batch_size", 256)),
        max_grad_norm=float(ppo.get("max_grad_norm", 1.0)),
        wrap_env=True,
        wrap_env_fn=functools.partial(wrap_env_fn),
        network_factory=lambda obs_size, action_size, preprocess_observations_fn: make_networks_fn(
            observation_size=obs_size,
            action_size=action_size,
            preprocess_observations_fn=preprocess_observations_fn,
            policy_hidden_layer_sizes=tuple(ppo.get("policy_hidden_layer_sizes", (512, 256, 128))),
            value_hidden_layer_sizes=tuple(ppo.get("value_hidden_layer_sizes", (512, 256, 128))),
            policy_obs_key=ppo.get("policy_obs_key", "state"),
            value_obs_key=ppo.get("value_obs_key", "privileged_state"),
        ),
        seed=int(ppo.get("seed", manifest.get("seed", 0))),
        progress_fn=progress_fn,
    )
    del make_inference_fn

    params = tree_map_fn(lambda x: np.asarray(x), params)
    policy_path = job_dir / "policy_brax.pkl"
    save_params_fn(str(policy_path), params)
    if not metrics:
        metrics.append({"steps": 0, "reward": 0.0, "elapsed_s": round(time.time() - start, 3)})
        (job_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    manifest.update(
        {
            "regime": "brax_ppo",
            "profile_id": "asimov-1",
            "ckpt": policy_path.name,
            "mjcf_xml": str(job.get("mjcf_xml", ASIMOV1_GENERATED_MJCF)),
            "mjcf_xml_sha256": job.get("mjcf_xml_sha256"),
            "asset_manifest": str(job.get("asset_manifest", "")),
            "asset_manifest_sha256": job.get("asset_manifest_sha256"),
            "obs_dim": getattr(env, "actor_observation_size", env.observation_size),
            "proprio_dim": env.proprio_dim,
            "text_dim": env.text_dim,
            "critic_obs_dim": getattr(env, "privileged_observation_size", env.observation_size),
            "policy_obs_key": ppo.get("policy_obs_key", "state"),
            "value_obs_key": ppo.get("value_obs_key", "privileged_state"),
            "action_dim": env.action_size,
            "output_dim": len(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "observation_delay_steps": dict(job.get("observation_delay_steps") or {"left_leg": 1, "right_leg": 2}),
            "wall_clock_s": round(time.time() - start, 3),
        }
    )
    (job_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (job_dir / "config.json").write_text(
        json.dumps(
            {
                "job": job["job"],
                "mjcf_xml": str(job.get("mjcf_xml", ASIMOV1_GENERATED_MJCF)),
                "mjcf_xml_sha256": job.get("mjcf_xml_sha256"),
                "asset_manifest": str(job.get("asset_manifest", "")),
                "asset_manifest_sha256": job.get("asset_manifest_sha256"),
                "active_tasks": list(env.active_tasks),
                "observation_delay_steps": dict(job.get("observation_delay_steps") or {"left_leg": 1, "right_leg": 2}),
                "ppo": ppo,
            },
            indent=2,
        )
        + "\n"
    )
    return {"ok": True, "job_dir": str(job_dir), "policy": str(policy_path)}


def train_from_job(job_dir: str | Path) -> dict[str, Any]:
    import jax
    from brax.io import model as brax_model
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.training.agents.ppo.train import train as ppo_train
    from mujoco_playground._src.wrapper import wrap_for_brax_training

    return _train_from_job_impl(
        job_dir,
        ppo_train_fn=ppo_train,
        save_params_fn=brax_model.save_params,
        tree_map_fn=jax.tree.map,
        make_networks_fn=ppo_networks.make_ppo_networks,
        wrap_env_fn=wrap_for_brax_training,
    )
