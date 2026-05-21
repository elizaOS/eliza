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

from eliza_robot.profiles.schema import list_profiles  # noqa: E402
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
    return PKG_ROOT / "checkpoints" / f"text_conditioned_{profile_id}_smoke"


def _load_policy(ckpt: Path):
    if not (ckpt / "manifest.json").is_file():
        return None
    return TextConditionedPolicy(ckpt)


def _fit_action(action: np.ndarray, dim: int) -> np.ndarray:
    action = np.asarray(action, dtype=np.float32).reshape(-1)
    if action.shape[0] == dim:
        return action
    if action.shape[0] > dim:
        return action[:dim]
    return np.concatenate([action, np.zeros(dim - action.shape[0], dtype=np.float32)])


def _roll_one(env, policy, task_id: str, *, max_steps: int) -> tuple[float, int]:
    obs, _ = env.reset(seed=int(np.random.randint(2**31 - 1)))
    # Force the requested task by overriding the random pick.
    env._current_task = next(t for t in env.active_tasks if t.id == task_id)  # noqa: SLF001
    env._current_embed = env.embeddings[task_id].reduced_embed.astype(np.float32)  # noqa: SLF001
    obs = env._build_obs()  # noqa: SLF001
    total = 0.0
    steps = 0
    for _ in range(max_steps):
        if policy is None:
            action = np.zeros(env.action_space.shape, dtype=np.float32)
        else:
            proprio_dim = int(policy.manifest.proprio_dim or (policy.manifest.obs_dim - policy.manifest.pca_dim))
            action, _ = policy.act(task_id, obs[:proprio_dim], deterministic=True)
            action = _fit_action(action, int(env.action_space.shape[0]))
        obs, r, term, trunc, _ = env.step(action)
        total += float(r)
        steps += 1
        if term or trunc:
            break
    return total, steps


def _roll_one_asimov_mjx(env, policy, task_id: str, *, max_steps: int, seed: int) -> tuple[float, int]:
    import jax
    import jax.numpy as jp

    state = env.reset(jax.random.PRNGKey(seed))
    task_idx = env.active_tasks.index(task_id)
    info = dict(state.info)
    info["task_idx"] = jp.asarray(task_idx, dtype=jp.int32)
    info["command"] = env._task_commands[task_idx]  # noqa: SLF001
    info["text_embed"] = env._task_embeddings[task_idx]  # noqa: SLF001
    obs = jp.concatenate([env._get_proprio(state.data, info), info["text_embed"]])  # noqa: SLF001
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
            proprio = np.asarray(jax.device_get(state.obs[:proprio_dim]), dtype=np.float32)
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
        "policy": "untrained_zero" if untrained else ("missing_checkpoint_zero" if policy is None else policy.manifest.regime),
        "env_action_dim": int(env.action_size),
        "env_observation_dim": int(env.observation_size),
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

    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=tasks, exclude_tasks=(), episode_steps=max_steps
        ),
    )
    ckpt = ckpt or _default_checkpoint(profile_id)
    policy = None if untrained else _load_policy(ckpt)
    per_task: dict[str, dict] = {}
    for task_id in tasks:
        rewards = []
        survivals = []
        for _ in range(episodes):
            r, s = _roll_one(env, policy, task_id, max_steps=max_steps)
            rewards.append(r)
            survivals.append(s)
        per_task[task_id] = {
            "mean_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "min_reward": float(np.min(rewards)),
            "max_reward": float(np.max(rewards)),
            "mean_steps_survived": float(np.mean(survivals)),
            "episodes": episodes,
        }
    return {
        "profile_id": profile_id,
        "env": "profile_mujoco",
        "checkpoint": str(ckpt),
        "policy": "untrained_zero" if untrained else ("missing_checkpoint_zero" if policy is None else policy.manifest.regime),
        "env_action_dim": int(env.action_space.shape[0]),
        "policy_action_dim": 0 if policy is None else int(policy.manifest.action_dim),
        "policy_output_dim": 0 if policy is None else int(policy.manifest.output_dim),
        "tasks": per_task,
        "mean_reward_overall": float(
            np.mean([per_task[t]["mean_reward"] for t in tasks])
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=list_profiles(), required=True)
    parser.add_argument(
        "--ckpt",
        type=Path,
        default=None,
        help="Checkpoint directory with manifest.json. Defaults to checkpoints/text_conditioned_<profile>_smoke.",
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
