"""Text-conditioned MJX-Brax env for the AiNex curriculum.

Forks `Joystick`, replaces the random 3-D velocity command with a task
sampled uniformly from a small tier-1 subset, and concatenates the
pre-computed sentence-transformer embedding for that task into the
observation. Task-dependent velocity / yaw / height targets are encoded
on `state.info["command"]` (which the parent class's tracking rewards
already consume) plus task-specific bonuses (stand-up height).

The active task subset is a small, hand-picked set of tier-1 fundamentals
because the joystick reward shaping (velocity tracking + Bezier feet
phase) is only meaningful for locomotion-style tasks.

Active tasks:
    stand_up        -> cmd = (0, 0, 0), torso-height bonus, weaker
                       feet-phase, larger upright bonus
    walk_forward    -> cmd = (+0.10, 0, 0)
    walk_backward   -> cmd = (-0.08, 0, 0)
    turn_left       -> cmd = (0, 0, +0.60)
    turn_right      -> cmd = (0, 0, -0.60)

Observation = joystick(49 * obs_history) + reduced_text_embedding(pca_dim)
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Sequence, Union

import jax
import jax.numpy as jp
import numpy as np
from ml_collections import config_dict
from mujoco import mjx
from mujoco_playground._src import mjx_env

from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.text_conditioned.encoder import (
    DEFAULT_PCA_DIM,
    build_task_embeddings,
)
from eliza_robot.sim.mujoco.joystick import (
    Joystick,
    default_config as joystick_default_config,
)


# Task ordering is canonical for this env — task_idx in info["task_idx"]
# indexes into these arrays. Adding tasks here requires retraining.
DEFAULT_ACTIVE_TASKS: tuple[str, ...] = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "turn_left",
    "turn_right",
)

# Per-task joystick command (lin_vel_x, lin_vel_y, ang_vel_yaw).
# Values pulled from curriculum/tasks.yaml so this stays consistent
# with the CPU env and with the curriculum success criteria.
_TASK_COMMANDS = {
    "stand_up":      (0.00, 0.0,  0.00),
    "walk_forward":  (0.10, 0.0,  0.00),
    "walk_backward": (-0.08, 0.0, 0.00),
    "turn_left":     (0.00, 0.0,  0.60),
    "turn_right":    (0.00, 0.0, -0.60),
}

# Per-task scalar weights for task-specific bonus terms.
_STAND_TASK_IDX = 0  # index of "stand_up" in DEFAULT_ACTIVE_TASKS


def default_config(
    active_tasks: Sequence[str] = DEFAULT_ACTIVE_TASKS,
    pca_dim: int = DEFAULT_PCA_DIM,
) -> config_dict.ConfigDict:
    cfg = joystick_default_config()
    # Slightly shorter rollouts than the 1000-step joystick default so PPO
    # sees more task variety per batch. 500 ≈ 10s @ 50Hz, enough for
    # walk_forward to accumulate ~1m displacement.
    cfg.episode_length = 500
    # Standing should be rewarded even at zero command. The joystick
    # default `zero_cmd` actually *penalises* action when cmd is zero,
    # which makes stand_up impossible. Disable it for this env.
    cfg.reward_config.scales.zero_cmd = 0.0
    # Up-weight orientation so stand_up has signal, and add a torso
    # height bonus that only activates on stand_up.
    cfg.reward_config.scales.orientation = -3.0
    cfg.reward_config.scales.stand_torso_height = 4.0
    # Tame action-rate so the policy is willing to take real steps for
    # walk/turn tasks even early in training (CPU smoke plateau'd at 700
    # exactly because action_rate suppressed exploration).
    cfg.reward_config.scales.action_rate = -0.005
    cfg.text_conditioned = config_dict.create(
        active_tasks=tuple(active_tasks),
        pca_dim=int(pca_dim),
        stand_torso_height_target=0.27,
        stand_torso_height_tolerance=0.03,
    )
    return cfg


class TextConditionedJoystick(Joystick):
    """Joystick variant with per-episode task sampling + text-embedding obs.

    Only the leg DOFs are actuated by the policy (same as Joystick).
    Observation layout per step: gyro(3)+grav(3)+cmd(3)+phase(4)+
    legpos(12)+legvel(12)+lastact(12) = 49, stacked obs_history times,
    then the reduced text embedding (pca_dim) is appended *once* at the
    tail (not stacked — the text channel is constant over the episode).
    """

    def __init__(
        self,
        config: Optional[config_dict.ConfigDict] = None,
        config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
    ) -> None:
        if config is None:
            config = default_config()
        super().__init__(config=config, config_overrides=config_overrides)
        tc = self._config.text_conditioned
        active = tuple(tc.active_tasks)
        # Resolve and cache the task embeddings as a single (n_tasks, pca_dim)
        # jax array so we can index by task_idx without leaving the device.
        curriculum = load_curriculum()
        embeddings = build_task_embeddings(
            curriculum=curriculum, pca_dim=int(tc.pca_dim)
        )
        missing = [t for t in active if t not in embeddings]
        if missing:
            raise ValueError(
                f"text-conditioned env: tasks {missing!r} not present in "
                "the cached embeddings; rebuild encoder cache."
            )
        emb_matrix = np.stack(
            [embeddings[t].reduced_embed.astype(np.float32) for t in active],
            axis=0,
        )
        self._task_ids = active
        self._task_embeddings = jp.asarray(emb_matrix)  # (n_tasks, pca_dim)
        self._n_tasks = len(active)
        self._text_dim = int(emb_matrix.shape[1])

        # Per-task joystick command matrix (n_tasks, 3)
        cmd_rows = []
        for t in active:
            if t not in _TASK_COMMANDS:
                raise ValueError(
                    f"text-conditioned env: no command defined for task {t!r}"
                )
            cmd_rows.append(_TASK_COMMANDS[t])
        self._task_commands = jp.asarray(np.asarray(cmd_rows, dtype=np.float32))

        # Stand-up bonus parameters (only applied when task == stand_up).
        self._stand_target = float(tc.stand_torso_height_target)
        self._stand_tol = float(tc.stand_torso_height_tolerance)
        # Index of "stand_up" in active tasks (or -1 if not present).
        self._stand_task_idx = (
            active.index("stand_up") if "stand_up" in active else -1
        )

    # ------------------------------------------------------------------ obs

    @property
    def _stacked_proprio_size(self) -> int:
        return self._config.obs_history_size * self._single_obs_size

    def _episode_text_embed(self, task_idx: jax.Array) -> jax.Array:
        """Look up the (pca_dim,) text embedding for `task_idx`."""
        return self._task_embeddings[task_idx]

    def reset(self, rng: jax.Array) -> mjx_env.State:
        rng, task_rng, noise_rng, freq_rng = jax.random.split(rng, 4)
        task_idx = jax.random.randint(task_rng, (), 0, self._n_tasks)
        command = self._task_commands[task_idx]
        text_embed = self._episode_text_embed(task_idx)

        data = mjx_env.make_data(
            self.mj_model,
            qpos=self._init_q,
            qvel=jp.zeros(self.mjx_model.nv),
        )
        data = mjx.forward(self.mjx_model, data)

        gait_freq = jax.random.uniform(
            freq_rng, (1,),
            minval=self._config.gait_freq_range[0],
            maxval=self._config.gait_freq_range[1],
        )
        phase_dt = 2 * jp.pi * self.dt * gait_freq
        phase = jp.array([0.0, jp.pi])

        info = {
            "rng": rng,
            "last_act": jp.zeros(self.NUM_LEG_ACTUATORS),
            "last_last_act": jp.zeros(self.NUM_LEG_ACTUATORS),
            "last_vel": jp.zeros(self.mjx_model.nv - 6),
            "command": command,
            "step": 0,
            "motor_targets": jp.zeros(self.mjx_model.nu),
            "phase": phase,
            "phase_dt": phase_dt,
            "task_idx": task_idx,
            "text_embed": text_embed,
        }

        metrics = {}
        for k in self._config.reward_config.scales.keys():
            metrics[f"reward/{k}"] = jp.zeros(())

        obs_history = jp.zeros(self._stacked_proprio_size)
        proprio = self._get_obs(data, info, obs_history, noise_rng)
        obs = jp.concatenate([proprio, text_embed])
        reward, done = jp.zeros(2)
        return mjx_env.State(data, obs, reward, done, metrics, info)

    def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
        rng, noise_rng = jax.random.split(state.info["rng"], 2)

        leg_targets = (
            self._default_pose[: self.NUM_LEG_ACTUATORS]
            + action * self._config.action_scale
        )
        full_targets = jp.concatenate(
            [leg_targets, self._default_pose[self.NUM_LEG_ACTUATORS:]]
        )
        motor_targets = jp.clip(full_targets, self._lowers, self._uppers)
        data = mjx_env.step(
            self.mjx_model, state.data, motor_targets, self.n_substeps
        )

        proprio_history = state.obs[: self._stacked_proprio_size]
        proprio = self._get_obs(data, state.info, proprio_history, noise_rng)
        text_embed = state.info["text_embed"]
        obs = jp.concatenate([proprio, text_embed])

        done = self.get_termination(data)
        rewards = self._get_reward(data, action, state.info, done)
        rewards = {
            k: v * self._config.reward_config.scales[k]
            for k, v in rewards.items()
        }
        reward = jp.clip(sum(rewards.values()) * self.dt, 0.0, 10000.0)

        state.info["motor_targets"] = motor_targets
        state.info["last_last_act"] = state.info["last_act"]
        state.info["last_act"] = action
        state.info["last_vel"] = data.qvel[6:]
        state.info["step"] += 1
        state.info["rng"] = rng

        phase_tp1 = state.info["phase"] + state.info["phase_dt"]
        state.info["phase"] = jp.fmod(phase_tp1 + jp.pi, 2 * jp.pi) - jp.pi

        # Command stays constant for the whole episode (no mid-episode
        # task switching — that confuses PPO advantage estimates).
        state.info["step"] = jp.where(done, 0, state.info["step"])

        for k, v in rewards.items():
            state.metrics[f"reward/{k}"] = v

        done = jp.float32(done)
        state = state.replace(data=data, obs=obs, reward=reward, done=done)
        return state

    # --------------------------------------------------------------- reward

    def _stand_torso_height_bonus(
        self, data: mjx.Data, task_idx: jax.Array
    ) -> jax.Array:
        """Gaussian bonus on torso z — only active for stand_up."""
        if self._stand_task_idx < 0:
            return jp.zeros(())
        torso_z = data.xpos[self._torso_body_id, 2]
        err = jp.abs(torso_z - self._stand_target)
        bonus = jp.exp(-err / max(self._stand_tol, 1e-3))
        gate = jp.float32(task_idx == self._stand_task_idx)
        return bonus * gate

    def _get_reward(
        self,
        data: mjx.Data,
        action: jax.Array,
        info: dict[str, Any],
        done: jax.Array,
    ) -> dict[str, jax.Array]:
        rewards = super()._get_reward(data, action, info, done)
        rewards["stand_torso_height"] = self._stand_torso_height_bonus(
            data, info["task_idx"]
        )
        return rewards

    # --------------------------------------------------------------- intro

    @property
    def text_dim(self) -> int:
        return self._text_dim

    @property
    def active_tasks(self) -> tuple[str, ...]:
        return self._task_ids

    @property
    def proprio_dim(self) -> int:
        return self._stacked_proprio_size

    @property
    def observation_size(self) -> int:
        return self._stacked_proprio_size + self._text_dim
