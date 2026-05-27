"""Evaluate a trained (or untrained) text-conditioned policy on the
unified env and report mean episode reward per task.

Used to verify:
  - PPO is actually learning (compare against an untrained baseline).
  - The trained policy is checkpoint-loadable + emits sane actions.
  - Per-task generalization (some tasks easier than others).

Run::
    uv run python scripts/eval_text_policy.py --profile unitree-h1 \
        --episodes 10 --tasks walk_forward turn_left
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import list_profiles, load_profile  # noqa: E402
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)

DEFAULT_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)
TEXT_POLICY_EVAL_SCHEMA = "robot-text-policy-eval-v1"
CURRICULUM_EVAL_SCHEMA = "robot-policy-curriculum-eval-v1"
REQUIRED_CURRICULUM_EVAL_OUT = Path("evidence/curriculum_eval/eval_text_policy.json")
REQUIRED_CURRICULUM_REPORT_OUT = Path("evidence/curriculum_eval/report.json")


def _default_checkpoint(profile_id: str) -> Path:
    return PKG_ROOT / "checkpoints" / "alberta_text_conditioned"


def _load_policy(ckpt: Path) -> TextConditionedPolicy:
    manifest = ckpt / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing checkpoint manifest: {manifest}")
    return TextConditionedPolicy(ckpt, strict_manifest=True)


def _validate_policy_contract(policy: TextConditionedPolicy, profile_id: str) -> None:
    profile = load_profile(profile_id)
    if policy.manifest.profile_id != profile_id:
        raise ValueError(
            "checkpoint profile mismatch: "
            f"manifest profile_id={policy.manifest.profile_id!r}, "
            f"evaluation profile_id={profile_id!r}"
        )
    output_dim = int(policy.manifest.output_dim)
    expected = len(profile.kinematics.joints)
    if output_dim != expected:
        raise ValueError(
            "checkpoint output_dim mismatch: "
            f"manifest output_dim={output_dim}, profile {profile_id!r} has {expected} joints"
        )


def _fit_action(action: np.ndarray, dim: int) -> np.ndarray:
    action = np.asarray(action, dtype=np.float32).reshape(-1)
    if action.shape[0] == dim:
        return action
    if action.shape[0] > dim:
        return action[:dim]
    return np.concatenate([action, np.zeros(dim - action.shape[0], dtype=np.float32)])


def _optional_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(out):
        return None
    return out


def _float_stats(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"min": None, "max": None, "mean": None, "final": None}
    return {
        "min": float(np.min(values)),
        "max": float(np.max(values)),
        "mean": float(np.mean(values)),
        "final": float(values[-1]),
    }


def _rollout_failed(last_result: Any, *, terminated: bool, success: bool) -> bool:
    """Treat env termination as a programmatic failure unless success already held."""
    return bool(getattr(last_result, "failed", False) or (terminated and not success))


def _rollout_reason(last_result: Any, *, terminated: bool, success: bool) -> str:
    reason = str(getattr(last_result, "reason", "") or "")
    if reason:
        return reason
    if terminated and not success:
        return "env_terminated_before_goal_success"
    return ""


def _telemetry_sample_from_info(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_optional_float(info.get("root_x")),
        torso_y_m=_optional_float(info.get("root_y")),
        torso_z_m=_optional_float(info.get("torso_z")),
        yaw_rad=_optional_float(info.get("root_yaw")),
        imu_roll_rad=float(info.get("imu_roll", 0.0) or 0.0),
        imu_pitch_rad=float(info.get("imu_pitch", 0.0) or 0.0),
        extra={"stand_height_m": info.get("stand_height_m")},
    )


def _roll_one(env, policy, task_id: str, *, max_steps: int) -> dict:
    original_tasks = env.active_tasks
    task = next(t for t in original_tasks if t.id == task_id)
    env.active_tasks = [task]
    try:
        obs, _ = env.reset(seed=int(np.random.randint(2**31 - 1)))
    finally:
        env.active_tasks = original_tasks
    # Force the requested task by overriding the random pick.
    env._current_task = task  # noqa: SLF001
    env._current_embed = env.embeddings[task_id].reduced_embed.astype(np.float32)  # noqa: SLF001
    if hasattr(env, "_root_pose_summary"):
        pose = env._root_pose_summary()  # noqa: SLF001
        env._episode_start_x = pose["x"]  # noqa: SLF001
        env._episode_start_y = pose["y"]  # noqa: SLF001
        env._episode_start_yaw = pose["yaw"]  # noqa: SLF001
        env._episode_start_torso_z = pose["z"]  # noqa: SLF001
    obs = env._build_obs()  # noqa: SLF001
    checker = GoalChecker(task, episode_start_t_s=0.0)
    last_info = {
        "root_x": getattr(env, "_episode_start_x", 0.0),
        "root_y": getattr(env, "_episode_start_y", 0.0),
        "root_yaw": getattr(env, "_episode_start_yaw", 0.0),
        "torso_z": getattr(env, "_episode_start_torso_z", 0.0),
        "stand_height_m": getattr(env, "_stand_height_m", None),
    }
    last_result = checker.update(_telemetry_sample_from_info(0.0, last_info))
    total = 0.0
    steps = 0
    terminated = False
    truncated = False
    traces = {
        "delta_x": [],
        "torso_z": [],
        "delta_y": [],
        "delta_yaw": [],
    }
    for _ in range(max_steps):
        if policy is None:
            action = np.zeros(env.action_space.shape, dtype=np.float32)
        else:
            proprio_dim = int(policy.manifest.proprio_dim or (policy.manifest.obs_dim - policy.manifest.pca_dim))
            action, _ = policy.act(task_id, obs[:proprio_dim], deterministic=True)
            action = _fit_action(action, int(env.action_space.shape[0]))
        obs, r, term, trunc, info = env.step(action)
        total += float(r)
        steps += 1
        last_info = info
        for key in traces:
            value = _optional_float(info.get(key))
            if value is not None:
                traces[key].append(value)
        last_result = checker.update(
            _telemetry_sample_from_info(steps * env.config.control_dt_s, info)
        )
        terminated = bool(term)
        truncated = bool(trunc)
        if term or trunc:
            break
    success = bool(last_result.success)
    failed = _rollout_failed(last_result, terminated=terminated, success=success)
    return {
        "reward": total,
        "steps": steps,
        "terminated": terminated,
        "truncated": truncated,
        "success": success,
        "failed": failed,
        "reason": _rollout_reason(
            last_result,
            terminated=terminated,
            success=success,
        ),
        "final_delta_x": float(_optional_float(last_info.get("delta_x")) or 0.0),
        "final_delta_y": float(_optional_float(last_info.get("delta_y")) or 0.0),
        "final_delta_yaw": float(_optional_float(last_info.get("delta_yaw")) or 0.0),
        "final_torso_z": float(_optional_float(last_info.get("torso_z")) or 0.0),
        "min_torso_z": min(traces["torso_z"]) if traces["torso_z"] else None,
        "max_abs_lateral_drift": (
            max(abs(v) for v in traces["delta_y"]) if traces["delta_y"] else None
        ),
        "telemetry": {
            "delta_x_m": _float_stats(traces["delta_x"]),
            "delta_y_m": _float_stats(traces["delta_y"]),
            "delta_yaw_rad": _float_stats(traces["delta_yaw"]),
            "torso_z_m": _float_stats(traces["torso_z"]),
        },
    }


def _yaw_from_mujoco_quat(qw: float, qx: float, qy: float, qz: float) -> float:
    return float(
        np.arctan2(
            2.0 * (qw * qz + qx * qy),
            1.0 - 2.0 * (qy * qy + qz * qz),
        )
    )


def _telemetry_sample_from_mjx_state(state, t_s: float, *, stand_height_m: float | None):
    import jax

    qpos = np.asarray(jax.device_get(state.data.qpos), dtype=np.float64).reshape(-1)
    torso_x = float(qpos[0]) if qpos.shape[0] > 0 else None
    torso_y = float(qpos[1]) if qpos.shape[0] > 1 else None
    torso_z = float(qpos[2]) if qpos.shape[0] > 2 else None
    yaw = (
        _yaw_from_mujoco_quat(
            float(qpos[3]),
            float(qpos[4]),
            float(qpos[5]),
            float(qpos[6]),
        )
        if qpos.shape[0] > 6
        else None
    )
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=torso_x,
        torso_y_m=torso_y,
        torso_z_m=torso_z,
        yaw_rad=yaw,
        extra={"stand_height_m": stand_height_m},
    )


def _roll_one_asimov_mjx(
    env,
    policy,
    task_id: str,
    *,
    max_steps: int,
    seed: int,
    task_spec=None,
) -> dict:
    import jax
    import jax.numpy as jp

    state = env.reset(jax.random.PRNGKey(seed))
    task_idx = env.active_tasks.index(task_id)
    info = dict(state.info)
    info["task_idx"] = jp.asarray(task_idx, dtype=jp.int32)
    info["command"] = env._task_commands[task_idx]  # noqa: SLF001
    info["text_embed"] = env._task_embeddings[task_idx]  # noqa: SLF001
    obs = env._get_obs(state.data, info)  # noqa: SLF001
    state = state.replace(obs=obs, info=info)
    if task_spec is None:
        task_spec = next(task for task in load_curriculum().tasks if task.id == task_id)
    control_dt_s = float(getattr(env, "dt", 1.0 / 50.0))
    stand_height_m = float(  # noqa: SLF001
        getattr(env._config, "stand_height_target", 0.63)
    )
    checker = GoalChecker(task_spec, episode_start_t_s=0.0)
    last_result = checker.update(
        _telemetry_sample_from_mjx_state(state, 0.0, stand_height_m=stand_height_m)
    )
    start_sample = checker.samples[-1]
    last_sample = start_sample
    delta_x_trace = [0.0]
    delta_y_trace = [0.0]
    delta_yaw_trace = [0.0]
    torso_z_trace = [float(start_sample.torso_z_m or 0.0)]

    total = 0.0
    steps = 0
    terminated = False
    for _ in range(max_steps):
        if policy is None:
            action = np.zeros(env.action_size, dtype=np.float32)
        else:
            proprio_dim = int(
                policy.manifest.proprio_dim
                or (policy.manifest.obs_dim - policy.manifest.pca_dim)
            )
            actor_obs = state.obs["state"] if isinstance(state.obs, dict) else state.obs
            proprio = np.asarray(jax.device_get(actor_obs[:proprio_dim]), dtype=np.float32)
            action, _ = policy.act(task_id, proprio, deterministic=True)
            action = _fit_action(action, int(env.action_size))
        state = env.step(state, jp.asarray(action, dtype=jp.float32))
        total += float(jax.device_get(state.reward))
        steps += 1
        last_sample = _telemetry_sample_from_mjx_state(
            state,
            steps * control_dt_s,
            stand_height_m=stand_height_m,
        )
        delta_x_trace.append(float((last_sample.torso_x_m or 0.0) - (start_sample.torso_x_m or 0.0)))
        delta_y_trace.append(float((last_sample.torso_y_m or 0.0) - (start_sample.torso_y_m or 0.0)))
        delta_yaw_trace.append(float((last_sample.yaw_rad or 0.0) - (start_sample.yaw_rad or 0.0)))
        torso_z_trace.append(float(last_sample.torso_z_m or 0.0))
        last_result = checker.update(last_sample)
        terminated = bool(jax.device_get(state.done))
        if terminated or last_result.success or last_result.failed:
            break
    success = bool(last_result.success)
    failed = _rollout_failed(last_result, terminated=terminated, success=success)
    return {
        "reward": total,
        "steps": steps,
        "terminated": terminated,
        "truncated": steps >= max_steps and not terminated,
        "success": success,
        "failed": failed,
        "reason": _rollout_reason(
            last_result,
            terminated=terminated,
            success=success,
        ),
        "final_delta_x": float((last_sample.torso_x_m or 0.0) - (start_sample.torso_x_m or 0.0)),
        "final_delta_y": float((last_sample.torso_y_m or 0.0) - (start_sample.torso_y_m or 0.0)),
        "final_delta_yaw": float((last_sample.yaw_rad or 0.0) - (start_sample.yaw_rad or 0.0)),
        "final_torso_z": float(last_sample.torso_z_m or 0.0),
        "min_torso_z": float(np.min(torso_z_trace)) if torso_z_trace else None,
        "max_abs_lateral_drift": (
            float(np.max(np.abs(delta_y_trace))) if delta_y_trace else None
        ),
        "telemetry": {
            "delta_x_m": _float_stats(delta_x_trace),
            "delta_y_m": _float_stats(delta_y_trace),
            "delta_yaw_rad": _float_stats(delta_yaw_trace),
            "torso_z_m": _float_stats(torso_z_trace),
        },
    }


def _normalize_mjx_rollout(rollout) -> dict:
    if isinstance(rollout, dict):
        return rollout
    reward, steps = rollout
    return {
        "reward": float(reward),
        "steps": int(steps),
        "success": False,
        "failed": False,
        "terminated": False,
        "truncated": False,
        "reason": "",
        "final_delta_x": 0.0,
        "final_delta_y": 0.0,
        "final_delta_yaw": 0.0,
        "final_torso_z": 0.0,
        "min_torso_z": None,
        "max_abs_lateral_drift": None,
        "telemetry": {},
    }


def _movement_summary(rollouts: list[dict]) -> dict[str, Any]:
    def values(key: str) -> list[float]:
        out = []
        for rollout in rollouts:
            value = _optional_float(rollout.get(key))
            if value is not None:
                out.append(value)
        return out

    return {
        "final_delta_x_m": _float_stats(values("final_delta_x")),
        "final_delta_y_m": _float_stats(values("final_delta_y")),
        "final_delta_yaw_rad": _float_stats(values("final_delta_yaw")),
        "final_torso_z_m": _float_stats(values("final_torso_z")),
        "min_torso_z_m": _float_stats(values("min_torso_z")),
        "max_abs_lateral_drift_m": _float_stats(values("max_abs_lateral_drift")),
    }


def _evaluate_asimov_mjx(
    *,
    tasks: tuple[str, ...],
    episodes: int,
    max_steps: int,
    untrained: bool,
    ckpt: Path | None,
) -> dict:
    from eliza_robot.sim.mujoco.asimov_mjx_training import (
        DEFAULT_ACTIVE_TASKS,
        make_asimov_text_conditioned_mjx_env,
    )

    ckpt = ckpt or _default_checkpoint("asimov-1")
    policy = None if untrained else _load_policy(ckpt)
    if policy is not None:
        _validate_policy_contract(policy, "asimov-1")
    pca_dim = 32 if policy is None else int(policy.manifest.text_dim or policy.manifest.pca_dim)
    unknown = sorted(set(tasks) - set(DEFAULT_ACTIVE_TASKS))
    if unknown:
        raise ValueError(f"ASIMOV MJX evaluator has no task command for {unknown!r}")
    env = make_asimov_text_conditioned_mjx_env(
        active_tasks=tasks,
        pca_dim=pca_dim,
        episode_length=max_steps,
        domain_randomization={},
    )
    per_task: dict[str, dict] = {}
    task_specs = {task.id: task for task in load_curriculum().tasks}
    rng = np.random.default_rng(0)
    for task_id in tasks:
        rewards = []
        survivals = []
        successes = []
        failures = []
        delta_x = []
        delta_y = []
        delta_yaw = []
        torso_z = []
        rollouts = []
        for _ in range(episodes):
            seed = int(rng.integers(2**31 - 1))
            rollout = _normalize_mjx_rollout(
                _roll_one_asimov_mjx(
                    env,
                    policy,
                    task_id,
                    max_steps=max_steps,
                    seed=seed,
                    task_spec=task_specs[task_id],
                )
            )
            rewards.append(float(rollout["reward"]))
            survivals.append(int(rollout["steps"]))
            successes.append(bool(rollout["success"]))
            failures.append(bool(rollout["failed"]))
            delta_x.append(float(rollout["final_delta_x"]))
            delta_y.append(float(rollout["final_delta_y"]))
            delta_yaw.append(float(rollout["final_delta_yaw"]))
            torso_z.append(float(rollout["final_torso_z"]))
            rollouts.append(rollout)
        per_task[task_id] = {
            "mean_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "min_reward": float(np.min(rewards)),
            "max_reward": float(np.max(rewards)),
            "mean_steps_survived": float(np.mean(survivals)),
            "success_rate": float(np.mean(successes)),
            "failure_rate": float(np.mean(failures)),
            "mean_final_delta_x_m": float(np.mean(delta_x)),
            "mean_final_delta_y_m": float(np.mean(delta_y)),
            "mean_final_delta_yaw_rad": float(np.mean(delta_yaw)),
            "mean_final_torso_z_m": float(np.mean(torso_z)),
            "movement_summary": _movement_summary(rollouts),
            "rollouts": rollouts,
            "episodes": episodes,
        }
    return {
        "schema": TEXT_POLICY_EVAL_SCHEMA,
        "profile_id": "asimov-1",
        "env": "asimov_mjx",
        "checkpoint": str(ckpt),
        "policy": "untrained_zero" if untrained else policy.manifest.regime,
        "env_action_dim": int(env.action_size),
        "env_observation_dim": int(env.actor_observation_size),
        "env_critic_observation_dim": int(env.privileged_observation_size),
        "env_observation_keys": sorted(env.observation_size),
        "env_proprio_dim": int(env.proprio_dim),
        "env_text_dim": int(env.text_dim),
        "mujoco_actuators": int(env.mj_model.nu),
        "policy_action_dim": 0 if policy is None else int(policy.manifest.action_dim),
        "policy_output_dim": 0 if policy is None else int(policy.manifest.output_dim),
        "tasks": per_task,
        "mean_reward_overall": float(
            np.mean([per_task[t]["mean_reward"] for t in tasks])
        ),
        "mean_success_rate_overall": float(
            np.mean([per_task[t]["success_rate"] for t in tasks])
        ),
    }


def evaluate(
    profile_id: str,
    *,
    tasks: tuple[str, ...],
    episodes: int,
    max_steps: int,
    untrained: bool,
    ckpt: Path | None = None,
    backend: str = "auto",
) -> dict:
    if backend == "auto":
        backend = "mjx" if profile_id == "asimov-1" else "profile"
    if backend == "mjx":
        if profile_id != "asimov-1":
            raise ValueError("--backend mjx is currently implemented for --profile asimov-1")
        return _evaluate_asimov_mjx(
            tasks=tasks,
            episodes=episodes,
            max_steps=max_steps,
            untrained=untrained,
            ckpt=ckpt,
        )
    if backend != "profile":
        raise ValueError(f"unsupported evaluator backend: {backend!r}")

    ckpt = ckpt or _default_checkpoint(profile_id)
    policy = None if untrained else _load_policy(ckpt)
    if policy is not None:
        _validate_policy_contract(policy, profile_id)
    pca_dim = 32 if policy is None else int(policy.manifest.text_dim or policy.manifest.pca_dim)
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=tasks,
            exclude_tasks=(),
            episode_steps=max_steps,
            pca_dim=pca_dim,
        ),
    )
    per_task: dict[str, dict] = {}
    for task_id in tasks:
        rewards = []
        survivals = []
        successes = []
        failures = []
        delta_x = []
        delta_y = []
        delta_yaw = []
        torso_z = []
        rollouts = []
        for _ in range(episodes):
            rollout = _roll_one(env, policy, task_id, max_steps=max_steps)
            rewards.append(float(rollout["reward"]))
            survivals.append(int(rollout["steps"]))
            successes.append(bool(rollout["success"]))
            failures.append(bool(rollout["failed"]))
            delta_x.append(float(rollout["final_delta_x"]))
            delta_y.append(float(rollout["final_delta_y"]))
            delta_yaw.append(float(rollout["final_delta_yaw"]))
            torso_z.append(float(rollout["final_torso_z"]))
            rollouts.append(rollout)
        per_task[task_id] = {
            "mean_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "min_reward": float(np.min(rewards)),
            "max_reward": float(np.max(rewards)),
            "mean_steps_survived": float(np.mean(survivals)),
            "success_rate": float(np.mean(successes)),
            "failure_rate": float(np.mean(failures)),
            "mean_final_delta_x_m": float(np.mean(delta_x)),
            "mean_final_delta_y_m": float(np.mean(delta_y)),
            "mean_final_delta_yaw_rad": float(np.mean(delta_yaw)),
            "mean_final_torso_z_m": float(np.mean(torso_z)),
            "movement_summary": _movement_summary(rollouts),
            "rollouts": rollouts,
            "episodes": episodes,
        }
    return {
        "schema": TEXT_POLICY_EVAL_SCHEMA,
        "profile_id": profile_id,
        "env": "profile_mujoco",
        "checkpoint": str(ckpt),
        "policy": "untrained_zero" if untrained else policy.manifest.regime,
        "env_action_dim": int(env.action_space.shape[0]),
        "policy_action_dim": 0 if policy is None else int(policy.manifest.action_dim),
        "policy_output_dim": 0 if policy is None else int(policy.manifest.output_dim),
        "tasks": per_task,
        "mean_reward_overall": float(
            np.mean([per_task[t]["mean_reward"] for t in tasks])
        ),
        "mean_success_rate_overall": float(
            np.mean([per_task[t]["success_rate"] for t in tasks])
        ),
    }


def curriculum_report_from_eval(report: dict) -> dict:
    """Convert an eval report into the production curriculum-gate schema."""
    task_metrics = report.get("tasks") if isinstance(report.get("tasks"), dict) else {}
    rows = []
    for task_id, metrics in task_metrics.items():
        metrics = metrics if isinstance(metrics, dict) else {}
        success_rate = float(metrics.get("success_rate", 0.0) or 0.0)
        failure_rate = float(metrics.get("failure_rate", 0.0) or 0.0)
        rows.append(
            {
                "task_id": task_id,
                "success_programmatic": bool(success_rate >= 1.0),
                "success_rate": success_rate,
                "failure_rate": failure_rate,
                "episodes": int(metrics.get("episodes", 0) or 0),
                "mean_reward": float(metrics.get("mean_reward", 0.0) or 0.0),
                "mean_steps_survived": float(
                    metrics.get("mean_steps_survived", 0.0) or 0.0
                ),
                "mean_final_delta_x_m": float(
                    metrics.get("mean_final_delta_x_m", 0.0) or 0.0
                ),
                "mean_final_delta_y_m": float(
                    metrics.get("mean_final_delta_y_m", 0.0) or 0.0
                ),
                "mean_final_delta_yaw_rad": float(
                    metrics.get("mean_final_delta_yaw_rad", 0.0) or 0.0
                ),
                "mean_final_torso_z_m": float(
                    metrics.get("mean_final_torso_z_m", 0.0) or 0.0
                ),
                "movement_summary": metrics.get("movement_summary", {}),
                "error": None,
            }
        )
    n_tasks = len(rows)
    n_programmatic_pass = sum(1 for row in rows if row["success_programmatic"])
    return {
        "schema": CURRICULUM_EVAL_SCHEMA,
        "source": "eval_text_policy",
        "checkpoint": report.get("checkpoint"),
        "profile_id": report.get("profile_id"),
        "env": report.get("env"),
        "policy": report.get("policy"),
        "n_tasks": n_tasks,
        "n_programmatic_pass": n_programmatic_pass,
        "programmatic_pass_rate": n_programmatic_pass / max(n_tasks, 1),
        "mean_success_rate_overall": float(
            report.get("mean_success_rate_overall", 0.0) or 0.0
        ),
        "tasks": rows,
    }


def _normalized_relative(path: Path) -> Path:
    return Path(str(path).lstrip("./"))


def _validate_curriculum_output_paths(out: Path | None, curriculum_out: Path | None) -> None:
    if out is None and curriculum_out is None:
        return
    if out is None or curriculum_out is None:
        raise ValueError(
            "curriculum evidence generation requires both "
            f"--out {REQUIRED_CURRICULUM_EVAL_OUT} and "
            f"--curriculum-report-out {REQUIRED_CURRICULUM_REPORT_OUT}"
        )
    got_out = _normalized_relative(out)
    got_curriculum = _normalized_relative(curriculum_out)
    if (
        got_out != REQUIRED_CURRICULUM_EVAL_OUT
        or got_curriculum != REQUIRED_CURRICULUM_REPORT_OUT
    ):
        raise ValueError(
            "curriculum evidence output paths must be exact: "
            f"--out {REQUIRED_CURRICULUM_EVAL_OUT} and "
            f"--curriculum-report-out {REQUIRED_CURRICULUM_REPORT_OUT}; "
            f"got --out {got_out} and --curriculum-report-out {got_curriculum}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=list_profiles(), required=True)
    parser.add_argument(
        "--ckpt",
        type=Path,
        default=None,
        help=(
            "Checkpoint directory with manifest.json. Defaults to "
            "checkpoints/alberta_text_conditioned. Unless --untrained "
            "is set, the manifest is required and must match --profile."
        ),
    )
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument(
        "--backend",
        choices=("auto", "profile", "mjx"),
        default="auto",
        help="Evaluation backend. auto uses ASIMOV MJX for asimov-1 and profile MuJoCo otherwise.",
    )
    parser.add_argument(
        "--untrained",
        action="store_true",
        help="Ignore any saved checkpoint; benchmark the zero-action baseline.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Optional path to write the native evaluation JSON report.",
    )
    parser.add_argument(
        "--curriculum-report-out",
        type=Path,
        default=None,
        help=(
            "Optional path to write a checkpoint-bound curriculum gate report "
            "consumed by validate_nebius_full_training_run.py."
        ),
    )
    parser.add_argument(
        "--fail-under-success-rate",
        type=float,
        default=None,
        help="Exit 2 if the curriculum report pass rate is below this threshold.",
    )
    args = parser.parse_args(argv)
    if args.curriculum_report_out is not None or args.fail_under_success_rate is not None:
        _validate_curriculum_output_paths(args.out, args.curriculum_report_out)
    if args.profile == "asimov-1" and args.backend in {"auto", "mjx"}:
        # Keep local ASIMOV MJX evaluation off the CUDA plugin unless callers
        # explicitly select another backend. Developer machines often have CUDA
        # wheels without a GPU; forcing CPU before JAX imports avoids noisy
        # plugin probing and occasional shutdown hangs.
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
        os.environ.setdefault("JAX_PLATFORMS", "cpu")
        os.environ.setdefault("JAX_PLATFORM_NAME", "cpu")
    report = evaluate(
        args.profile,
        tasks=tuple(args.tasks),
        episodes=args.episodes,
        max_steps=args.max_steps,
        untrained=args.untrained,
        ckpt=args.ckpt,
        backend=args.backend,
    )
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    curriculum_report = None
    if args.curriculum_report_out is not None or args.fail_under_success_rate is not None:
        curriculum_report = curriculum_report_from_eval(report)
    if args.curriculum_report_out is not None and curriculum_report is not None:
        args.curriculum_report_out.parent.mkdir(parents=True, exist_ok=True)
        args.curriculum_report_out.write_text(
            json.dumps(curriculum_report, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, indent=2))
    exit_code = 0
    if (
        args.fail_under_success_rate is not None
        and curriculum_report is not None
        and float(curriculum_report["programmatic_pass_rate"])
        < float(args.fail_under_success_rate)
    ):
        exit_code = 2
    if args.profile == "asimov-1" and args.backend in {"auto", "mjx"}:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(exit_code)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
