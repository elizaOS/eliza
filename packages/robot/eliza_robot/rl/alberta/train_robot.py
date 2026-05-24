"""Train a robot policy on the real MuJoCo env with the Alberta controller.

This is the productionization of the Alberta integration: the *same* streaming
continual controller proven on the fast JointReach benchmark, now driving the
profile-driven MuJoCo ``TextConditionedProfileEnv``. It trains either a single
task or a continual sequence of tasks (one phase each, weights preserved across
phases — the robot accumulates skills) and writes a checkpoint + a
``manifest.json`` with ``regime="alberta_streaming"`` so the existing
``TextConditionedPolicy`` inference path can load and run it.

Run::

    uv run python -m eliza_robot.rl.alberta.train_robot \
        --profile hiwonder-ainex --tasks stand_up walk_forward --steps-per-task 4000

Keep step budgets modest locally — the MuJoCo humanoid is far heavier than the
benchmark env. Heavy/long training offloads to the GPU recipes; this path proves
the train -> checkpoint -> load -> infer round trip works end to end on Alberta.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.loop import evaluate, train_online


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def steps_per_task_from_total(total_steps: int, task_count: int) -> int:
    """Convert a user-facing total env-step budget into a per-task phase budget."""
    if total_steps < 1:
        raise ValueError("total_steps must be >= 1")
    if task_count < 1:
        raise ValueError("task_count must be >= 1")
    return max(1, int(math.ceil(total_steps / task_count)))


def train_robot(
    profile_id: str,
    tasks: list[str],
    steps_per_task: int,
    out_dir: Path,
    *,
    pca_dim: int = 32,
    episode_steps: int = 200,
    eval_episodes: int = 3,
    seed: int = 0,
    requested_total_steps: int | None = None,
    domain_rand: bool = True,
) -> dict:
    """Train an Alberta controller on the MuJoCo env over a task sequence."""
    from eliza_robot.curriculum.loader import load_curriculum
    from eliza_robot.profiles.schema import load_profile
    from eliza_robot.rl.text_conditioned.profile_env import (
        ProfileEnvConfig,
        make_text_conditioned_env,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    curriculum = load_curriculum()
    # One env spanning all requested tasks (shared obs/action space); pin a
    # single task per phase so the controller learns them sequentially.
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            tier_subset=(),
            include_tasks=tuple(tasks),
            exclude_tasks=(),
            pca_dim=pca_dim,
            episode_steps=episode_steps,
            domain_rand=domain_rand,
        ),
    )
    obs_dim = int(env.observation_space.shape[0])
    action_dim = int(env.action_space.shape[0])

    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=pca_dim,
        n_prototypes=64,
        gate_hard=True,
        proprio_random_dim=32,
        seed=seed,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=obs_dim,
        action_dim=action_dim,
        gamma=0.5,
        actor_step_size=5e-3,
        critic_step_size=1e-2,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        features=feature_cfg,
        seed=seed,
    )
    controller = AlbertaContinualController(controller_cfg)

    # Snapshot the full active-task list once; pinning replaces env.active_tasks
    # per phase, so we must index into this stable snapshot, not the mutated list.
    all_active = {t.id: t for t in env.active_tasks}
    history = []
    for phase, task in enumerate(tasks):
        if task not in all_active:
            raise ValueError(f"task {task!r} not in env active tasks {list(all_active)}")
        env.active_tasks = [all_active[task]]
        stats = train_online(controller, env, steps_per_task, max_episode_steps=episode_steps, seed=seed + phase)
        ev = evaluate(controller, env, eval_episodes, max_episode_steps=episode_steps, seed=10_000 + phase)
        history.append(
            {
                "phase": phase,
                "task": task,
                "train_episodes": stats.episodes,
                "train_mean_return": stats.mean_episode_return,
                "eval_mean_return": ev.mean_return,
            }
        )
        print(
            f"[phase {phase}] task={task:14s} train_ep_ret={stats.mean_episode_return:8.2f} "
            f"eval_ret={ev.mean_return:8.2f}"
        )

    # Persist controller params + manifest in the TextConditionedPolicy layout.
    snap = controller.state_dict()
    np.savez(out_dir / "alberta_policy.npz", **snap)
    manifest = {
        "regime": "alberta_streaming",
        "curriculum_version": curriculum.version,
        "pca_dim": pca_dim,
        "active_tasks": list(tasks),
        "obs_dim": obs_dim,
        "action_dim": action_dim,
        "output_dim": len(profile.kinematics.joints),
        "profile_id": profile_id,
        "profile_version": profile.version,
        "proprio_dim": obs_dim - pca_dim,
        "text_dim": pca_dim,
        "ckpt": "alberta_policy.npz",
        "requested_total_steps": int(
            requested_total_steps
            if requested_total_steps is not None
            else steps_per_task * len(tasks)
        ),
        "steps_per_task": int(steps_per_task),
        "total_steps": int(steps_per_task * len(tasks)),
        "episode_steps": int(episode_steps),
        "eval_episodes": int(eval_episodes),
        "seed": int(seed),
        "domain_rand": bool(domain_rand),
        # Full controller config so TextConditionedPolicy can rebuild the exact
        # feature map + agent for inference.
        "controller": {
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "decouple_global_bias": controller_cfg.decouple_global_bias,
            "features": {
                "mode": feature_cfg.mode,
                "embed_dim": feature_cfg.embed_dim,
                "n_prototypes": feature_cfg.n_prototypes,
                "gate_hard": feature_cfg.gate_hard,
                "gate_temperature": feature_cfg.gate_temperature,
                "proprio_random_dim": feature_cfg.proprio_random_dim,
                "random_dim": feature_cfg.random_dim,
                "scale": feature_cfg.scale,
                "seed": feature_cfg.seed,
            },
        },
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "history": history,
    }
    if profile_id == "asimov-1":
        from eliza_robot.asimov_1.constants import (
            ASIMOV1_GENERATED_MANIFEST,
            ASIMOV1_GENERATED_MJCF,
        )

        manifest.update(
            {
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": _sha256_file(ASIMOV1_GENERATED_MJCF),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": _sha256_file(ASIMOV1_GENERATED_MANIFEST),
            }
        )
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote checkpoint + manifest to {out_dir}")
    return manifest


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Train a robot policy with the Alberta controller")
    p.add_argument("--profile", default="hiwonder-ainex")
    p.add_argument("--tasks", nargs="+", default=["stand_up", "walk_forward"])
    p.add_argument("--steps-per-task", type=int, default=4000)
    p.add_argument("--episode-steps", type=int, default=200)
    p.add_argument("--eval-episodes", type=int, default=3)
    p.add_argument("--pca-dim", type=int, default=32)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out-dir", default="checkpoints/alberta_text_conditioned")
    p.add_argument(
        "--no-domain-rand",
        action="store_true",
        help="disable MuJoCo domain randomization for deterministic debugging",
    )
    args = p.parse_args(argv)
    train_robot(
        args.profile,
        args.tasks,
        args.steps_per_task,
        Path(args.out_dir),
        pca_dim=args.pca_dim,
        episode_steps=args.episode_steps,
        eval_episodes=args.eval_episodes,
        seed=args.seed,
        domain_rand=not args.no_domain_rand,
    )


if __name__ == "__main__":
    main()
