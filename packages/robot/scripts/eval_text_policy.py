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

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample  # noqa: E402
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


def _default_checkpoint(profile_id: str) -> Path:
    return PKG_ROOT / "checkpoints" / "alberta_text_conditioned"


def _load_policy(ckpt: Path) -> TextConditionedPolicy:
    manifest = ckpt / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing checkpoint manifest: {manifest}")
    return TextConditionedPolicy(ckpt)


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


def _telemetry_sample_from_info(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_optional_float(info.get("root_x")),
        torso_y_m=_optional_float(info.get("root_y")),
        torso_z_m=_optional_float(info.get("torso_z")),
        yaw_rad=_optional_float(info.get("root_yaw")),
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
        "torso_z": [],
        "delta_y": [],
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
    return {
        "reward": total,
        "steps": steps,
        "terminated": terminated,
        "truncated": truncated,
        "success": bool(last_result.success),
        "failed": bool(last_result.failed),
        "reason": last_result.reason,
        "final_delta_x": float(_optional_float(last_info.get("delta_x")) or 0.0),
        "final_delta_y": float(_optional_float(last_info.get("delta_y")) or 0.0),
        "final_delta_yaw": float(_optional_float(last_info.get("delta_yaw")) or 0.0),
        "final_torso_z": float(_optional_float(last_info.get("torso_z")) or 0.0),
        "min_torso_z": min(traces["torso_z"]) if traces["torso_z"] else None,
        "max_abs_lateral_drift": (
            max(abs(v) for v in traces["delta_y"]) if traces["delta_y"] else None
        ),
    }


def _roll_one_asimov_mjx(env, policy, task_id: str, *, max_steps: int, seed: int) -> tuple[float, int]:
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

    total = 0.0
    steps = 0
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
        if bool(jax.device_get(state.done)):
            break
    return total, steps


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
    rng = np.random.default_rng(0)
    for task_id in tasks:
        rewards = []
        survivals = []
        for _ in range(episodes):
            seed = int(rng.integers(2**31 - 1))
            reward, steps = _roll_one_asimov_mjx(
                env,
                policy,
                task_id,
                max_steps=max_steps,
                seed=seed,
            )
            rewards.append(reward)
            survivals.append(steps)
        per_task[task_id] = {
            "mean_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "min_reward": float(np.min(rewards)),
            "max_reward": float(np.max(rewards)),
            "mean_steps_survived": float(np.mean(survivals)),
            "episodes": episodes,
        }
    return {
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
            "episodes": episodes,
        }
    return {
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
    args = parser.parse_args(argv)
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
    print(json.dumps(report, indent=2))
    if args.profile == "asimov-1" and args.backend in {"auto", "mjx"}:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
