"""Evaluate a text-conditioned checkpoint on a profile MuJoCo env."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)

from eliza_robot.profiles.schema import list_profiles  # noqa: E402
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy  # noqa: E402

DEFAULT_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _fit_action(action: np.ndarray, dim: int) -> np.ndarray:
    action = np.asarray(action, dtype=np.float32).reshape(-1)
    if action.shape[0] > dim:
        return action[:dim]
    if action.shape[0] < dim:
        return np.concatenate([action, np.zeros(dim - action.shape[0], dtype=np.float32)])
    return action


def evaluate(
    profile_id: str,
    *,
    tasks: tuple[str, ...],
    episodes: int,
    max_steps: int,
    untrained: bool,
    ckpt: Path | None = None,
) -> dict:
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(include_tasks=tasks, exclude_tasks=(), episode_steps=max_steps),
    )
    ckpt = ckpt or (PKG_ROOT / "checkpoints" / f"text_conditioned_{profile_id}_smoke")
    policy = None if untrained or not (ckpt / "manifest.json").is_file() else TextConditionedPolicy(ckpt)
    per_task = {}
    for task_id in tasks:
        rewards = []
        steps = []
        for _ in range(episodes):
            obs, _ = env.reset()
            env._current_task = next(t for t in env.active_tasks if t.id == task_id)  # noqa: SLF001
            env._current_embed = env.embeddings[task_id].reduced_embed.astype(np.float32)  # noqa: SLF001
            obs = env._build_obs()  # noqa: SLF001
            total = 0.0
            survived = 0
            for _ in range(max_steps):
                if policy is None:
                    action = np.zeros(env.action_space.shape, dtype=np.float32)
                else:
                    proprio_dim = int(policy.manifest.proprio_dim or (policy.manifest.obs_dim - policy.manifest.pca_dim))
                    action, _ = policy.act(task_id, obs[:proprio_dim], deterministic=True)
                    action = _fit_action(action, int(env.action_space.shape[0]))
                obs, reward, terminated, truncated, _ = env.step(action)
                total += float(reward)
                survived += 1
                if terminated or truncated:
                    break
            rewards.append(total)
            steps.append(survived)
        per_task[task_id] = {
            "mean_reward": float(np.mean(rewards)),
            "std_reward": float(np.std(rewards)),
            "min_reward": float(np.min(rewards)),
            "max_reward": float(np.max(rewards)),
            "mean_steps_survived": float(np.mean(steps)),
            "episodes": int(episodes),
        }
    return {
        "profile_id": profile_id,
        "checkpoint": str(ckpt),
        "policy": "untrained_zero" if untrained else ("missing_checkpoint_zero" if policy is None else policy.manifest.regime),
        "env_action_dim": int(env.action_space.shape[0]),
        "policy_action_dim": 0 if policy is None else int(policy.manifest.action_dim),
        "policy_output_dim": 0 if policy is None else int(policy.manifest.output_dim),
        "tasks": per_task,
        "mean_reward_overall": float(np.mean([row["mean_reward"] for row in per_task.values()])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=list_profiles(), required=True)
    parser.add_argument("--ckpt", type=Path, default=None)
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument("--untrained", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            evaluate(
                args.profile,
                tasks=tuple(args.tasks),
                episodes=args.episodes,
                max_steps=args.max_steps,
                untrained=args.untrained,
                ckpt=args.ckpt,
            ),
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
